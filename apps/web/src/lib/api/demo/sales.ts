/**
 * Sale completion, the sale lookup, refunds, the step-up and today's
 * numbers, answered from memory. The order of the checks and the writes
 * mirrors the transaction in docs/api-contract-epos.md, section 4, so the
 * demo refuses a sale for the same reasons the server does and Home counts
 * the same things.
 *
 * A ticket can carry a part-exchange or a return (section 7): the draft
 * trade-in is completed inside the sale, its items going on the demo shelf
 * and its surplus paid out, and the returned lines are refunded off the
 * original sale with the exchange set against the new one. The arithmetic
 * and the refusals are the contract's.
 *
 * Every sale and refund needs the demo till open (`demoTill.session`), the
 * same as a till sale on the server needs an open session on its register.
 * The cash part goes on that session as a `cash_sale` movement.
 */
import { ClientResponseError } from "pocketbase"
import {
  TENDER_LABELS,
  breakdown,
  buildCode,
  categoryForKind,
  checkPointsRedemption,
  evaluateSalePoints,
  formatGBP,
  penceToPoints,
  pointsCum,
  refundAmount,
  remainingQty,
  spread,
  type SaleLineForPoints,
  type SaleLookup,
  type SaleTradeIn,
  type Tender,
  type TenderInput,
  type TenderMethod,
} from "@gg/shared"
import { evaluateTradeInPoints } from "@gg/shared/loyalty"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import { addMovement } from "@/lib/api/demo/cash"
import {
  demoAddPoints,
  demoPostCredit,
  demoRecordVisit,
  demoVerifyId,
  findDemoCustomer,
} from "@/lib/api/demo/customers"
import { DEMO_OFFER_LIMITS, demoIdDocuments, demoTradeIns } from "@/lib/api/demo/tradeins"
import {
  demoTill,
  DEMO_REGISTER,
  noteDemoTillRefund,
  noteDemoTillSale,
  noteDemoTillTradeIn,
} from "@/lib/api/demo/till-session"
import { demoProduct, demoRecordVoids } from "@/lib/api/demo/till"
import {
  DEMO_PROGRAMME,
  DEMO_RULES,
  DEMO_SALE_CUSTOMERS,
  DEMO_SETTINGS,
  DEMO_TIERS,
  DEMO_VOUCHERS,
  demoBuyIns,
  demoCashMovements,
  demoId,
  demoSales,
  ensureSeeded,
  itemStore,
  nextSaleNumber,
  usedVoucherIds,
  type DemoSale,
} from "@/lib/api/demo/store"
import type {
  IdCheckPayload,
  ItemKind,
  LoyaltySetup,
  PaymentMethod,
  RecentActivity,
  RewardVoucher,
  SaleCustomer,
  SaleDetail,
  SaleLineDetail,
  SaleSummary,
  StockItemRecord,
  TodayStats,
  TradeInLineRecord,
} from "@/lib/api/types"
import type {
  TillRefundPayload,
  TillRefundResult,
  TillSalePayload,
  TillSaleResult,
} from "@/lib/api/sales"
import type { TillTicketPayload, TillTicketResult } from "@/lib/api/till"

export const DEMO_STEP_UP_PASSWORD = DEMO_STAFF.password

/** A demo sale with what the till adds to it: its tenders, its refunds and its trade-in. */
interface TillDemoSale extends DemoSale {
  register?: string
  tenders?: Tender[]
  refund_count?: number
  refunds?: { ref: string; amount: number; reason: string; tenders: Tender[] }[]
  /** The part-exchange completed with it. */
  trade_in?: string
}

/** A demo sale line, which may be a till product rather than an item. */
type TillDemoLine = SaleLineDetail & { product?: string; note?: string }

export function loyaltySetup(): LoyaltySetup {
  return { programme: DEMO_PROGRAMME, rules: DEMO_RULES, tiers: DEMO_TIERS }
}

export function findCustomers(query: string): SaleCustomer[] {
  ensureSeeded()
  const needle = query.trim().toLowerCase()
  if (!needle) return DEMO_SALE_CUSTOMERS.slice(0, 5)
  return DEMO_SALE_CUSTOMERS.filter((customer) =>
    `${customer.name} ${customer.code}`.toLowerCase().includes(needle)
  )
}

export function customerByCode(code: string): SaleCustomer | null {
  ensureSeeded()
  return DEMO_SALE_CUSTOMERS.find((customer) => customer.code === code) ?? null
}

export function voucherByCode(code: string): RewardVoucher | null {
  ensureSeeded()
  const voucher = DEMO_VOUCHERS.find((row) => row.code === code)
  if (!voucher || usedVoucherIds.has(voucher.id)) return null
  return voucher
}

function customerName(id?: string | null): string | null {
  if (!id) return null
  return DEMO_SALE_CUSTOMERS.find((customer) => customer.id === id)?.name ?? null
}

function toSummary(sale: DemoSale): SaleSummary {
  return {
    id: sale.id,
    number: sale.number,
    total: sale.total ?? 0,
    payment: sale.payment ?? "cash",
    status: sale.status ?? "complete",
    customerName: sale.customerName,
    at: sale.created ?? new Date().toISOString(),
    lineCount: sale.lines.length,
  }
}

export function listSales(limit = 20): SaleSummary[] {
  ensureSeeded()
  return [...demoSales]
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
    .slice(0, limit)
    .map(toSummary)
}

export function getSale(id: string): SaleDetail | null {
  ensureSeeded()
  const sale = demoSales.find((row) => row.id === id)
  return sale ? { ...sale } : null
}

/** The item a line points at, or undefined when it has been purged. */
function itemFor(id: string): StockItemRecord | undefined {
  return itemStore().find((row) => row.id === id)
}

/** A refusal in the shape the routes send, so `refusalMessage` reads it. */
function refusal(status: number, message: string): ClientResponseError {
  return new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

/**
 * The demo's stand-in for a race the till cannot see coming: an item sold on
 * the other counter a moment before this sale went through. It fires once
 * and takes itself off. Set `gg-demo-sale` to "race" to arm it.
 */
function armedRaceRefusal(): string | null {
  try {
    if (localStorage.getItem("gg-demo-sale") !== "race") return null
    localStorage.removeItem("gg-demo-sale")
    return "That item was sold on the other till a moment ago. Take it out of the ticket."
  } catch {
    return null
  }
}

/** What the drawer should hold on the demo till's session now. */
export function demoDrawerExpected(): number {
  const session = demoTill.session
  if (!session) return 0
  return demoCashMovements
    .filter((movement) => movement.session === session.id)
    .reduce((sum, movement) => sum + (movement.amount ?? 0), session.float)
}

function tenderRow(
  method: TenderMethod,
  amount: number,
  extra: Partial<Pick<Tender, "tendered" | "change" | "card_last4" | "reference">> = {}
): Tender {
  return {
    method,
    label: TENDER_LABELS[method],
    amount,
    tendered: extra.tendered ?? 0,
    change: extra.change ?? 0,
    card_last4: extra.card_last4 ?? "",
    reference: extra.reference ?? "",
  }
}

/** Sales already rung up, by the till's client id: a replay gets the same answer. */
const completedByClientId = new Map<string, TillTicketResult>()

interface PlannedLine {
  item: StockItemRecord | null
  productId: string | null
  title: string
  qty: number
  unitPrice: number
  discount: number
  total: number
  taxScheme: "margin" | "standard" | "exempt"
  note: string
  kind: string
  game: string | null
}

function planLines(payload: TillSalePayload): PlannedLine[] {
  return payload.lines.map((line, index) => {
    const qty = Math.max(1, Math.floor(line.qty || 1))
    const discount = Math.max(0, Math.round(line.discount ?? 0))
    if ("item" in line) {
      const item = itemFor(line.item)
      if (!item) throw refusal(404, `Item ${index + 1} is not in stock any more. Scan it again.`)
      const reservedForThem =
        item.status === "reserved" && item.reserved_for && item.reserved_for === payload.customer
      if (item.status !== "in_stock" && !reservedForThem) {
        throw refusal(409, `${item.title ?? "That item"} is no longer for sale. Take it off the ticket.`)
      }
      const available = item.qty ?? 1
      if (qty > available) {
        throw refusal(409, `Only ${available} of ${item.title ?? "that item"} left in stock. Lower the quantity.`)
      }
      const unitPrice = line.unit_price ?? item.price ?? 0
      const total = unitPrice * qty - discount
      if (total < 0) {
        throw refusal(400, `The discount on ${item.title ?? "that line"} is more than the line is worth.`)
      }
      return {
        item,
        productId: null,
        title: item.title ?? "",
        qty,
        unitPrice,
        discount,
        total,
        taxScheme: item.tax_scheme ?? "margin",
        note: line.note ?? "",
        kind: item.kind,
        game: item.game ?? null,
      }
    }

    const product = demoProduct(line.product)
    if (!product || !product.active) {
      throw refusal(409, "That till product is not on sale any more. Take it off the ticket.")
    }
    if (product.kind === "membership" && !payload.customer) {
      throw refusal(400, "Attach the customer to sell a Guild Membership.")
    }
    const open = product.open_price
    if (open && !(Number.isInteger(line.unit_price) && line.unit_price > 0)) {
      throw refusal(400, `Key a price for ${product.name}.`)
    }
    const unitPrice = open ? line.unit_price : product.price
    const total = unitPrice * qty - discount
    if (total < 0) {
      throw refusal(400, `The discount on ${product.name} is more than the line is worth.`)
    }
    return {
      item: null,
      productId: product.id,
      title: (open && line.title?.trim()) || product.name,
      qty,
      unitPrice,
      discount,
      total,
      taxScheme: product.tax_scheme,
      note: line.note ?? "",
      kind: "other",
      game: null,
    }
  })
}

/** The tender rules, in the contract's words (section 4, "Rules"). */
function checkTenders(
  tenders: TenderInput[],
  /** What the tenders have to cover: the sale, less any trade-in or return set against it. */
  left: number,
  /** The whole sale, which points can pay a share of. */
  sale: number,
  customer: SaleCustomer | undefined,
  /** The refusal when they do not add up, in the sale's own words. */
  mismatch: (covered: number) => string
): PaidTenders {
  let cash = 0
  let credit = 0
  let points = 0
  let change = 0
  let cashTenders = 0
  const rows: Tender[] = []

  for (const tender of tenders) {
    const amount = Math.round(tender.amount)
    if (!Number.isInteger(amount) || amount <= 0) {
      throw refusal(400, "A payment has to be more than £0.00. Check the payments.")
    }
    switch (tender.method) {
      case "cash": {
        cashTenders += 1
        const tendered = tender.tendered ?? amount
        if (tendered < amount) {
          throw refusal(400, "The cash handed over is less than the cash part. Check the cash.")
        }
        cash += amount
        change += tendered - amount
        rows.push(tenderRow("cash", amount, { tendered, change: tendered - amount }))
        break
      }
      case "card_tide": {
        const last4 = tender.card_last4?.trim() ?? ""
        if (!/^\d{4}$/.test(last4)) throw refusal(400, "Key the last four digits of the card.")
        rows.push(tenderRow("card_tide", amount, { card_last4: last4, reference: tender.reference }))
        break
      }
      case "store_credit":
        credit += amount
        rows.push(tenderRow("store_credit", amount))
        break
      case "points":
        points += amount
        rows.push(tenderRow("points", amount))
        break
      default:
        // The trade-in's part is the server's to write, from the trade-in
        // itself (section 7); the till sends only the other payments.
        throw refusal(400, "Send the trade-in on the ticket, not as a payment.")
    }
  }

  if (cashTenders > 1) throw refusal(400, "Take cash once on a sale. Put the cash together.")
  const sum = rows.reduce((total, row) => total + row.amount, 0)
  if (sum !== left) throw refusal(400, mismatch(sum))
  if (cash > 0) {
    if (DEMO_SETTINGS.cash_cap <= 0) throw refusal(422, "Cash sales are switched off in settings.")
    if (cash > DEMO_SETTINGS.cash_cap) {
      throw refusal(422, `Cash is capped at ${formatGBP(DEMO_SETTINGS.cash_cap)} a sale. Take the rest by card.`)
    }
  }
  if ((credit > 0 || points > 0) && !customer) {
    throw refusal(422, "Add the customer before using store credit or points.")
  }
  if (customer && credit > customer.creditBalance) {
    throw refusal(422, `This customer has ${formatGBP(customer.creditBalance)} in store credit. Lower the amount.`)
  }
  if (customer && points > 0) {
    const spent = penceToPoints(points, DEMO_PROGRAMME)
    const check = checkPointsRedemption(DEMO_PROGRAMME, customer.pointsBalance, spent, sale)
    if (!check.ok) {
      throw refusal(
        422,
        check.reason === "insufficient"
          ? `This customer has ${customer.pointsBalance} points. Lower the amount.`
          : check.reason === "below_minimum"
            ? `Points start at ${DEMO_PROGRAMME.minRedeemPoints} points. Take this one another way.`
            : "Those points cannot be used on this sale."
      )
    }
  }
  return { cash, credit, points, change, rows }
}

interface PaidTenders {
  cash: number
  credit: number
  points: number
  change: number
  rows: Tender[]
}

// ---------------------------------------------------------------------------
// Part-exchange (section 7): the draft trade-in completed inside the sale
// ---------------------------------------------------------------------------

type DemoTradeInEntry = (typeof demoTradeIns)[number]

interface PlannedTrade {
  entry: DemoTradeInEntry
  accepted: TradeInLineRecord[]
  /** V: the accepted lines at their (credit) offer prices. */
  value: number
  /** A: what the trade pays towards the sale. */
  applied: number
  /** U: what is left over for the customer. */
  surplus: number
  /** The surplus paid in cash, and as store credit. One of them is zero. */
  cash: number
  credit: number
  idCheck: IdCheckPayload | null
  signature: string | null
}

const OPEN_TRADE_STATUSES = new Set(["draft", "offered", "accepted"])

/** Whole years between a date of birth and today; null when it cannot be read. */
function ageFrom(dob: string): number | null {
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - born.getFullYear()
  const months = today.getMonth() - born.getMonth()
  if (months < 0 || (months === 0 && today.getDate() < born.getDate())) age -= 1
  return age
}

/**
 * The buy-in's cash gate, in the buy-in's own sentences (the completion
 * route's, as `demo/tradeins.ts` has them): the cap, the customer's flags,
 * the address, a verified and unexpired ID (or one checked in this call)
 * with its photo on file, and 18 or over.
 */
function cashGateRefusal(customerId: string, cash: number, idCheck: IdCheckPayload | null): string | null {
  if (DEMO_OFFER_LIMITS.cashCap <= 0) return "Cash payouts are switched off in settings."
  if (cash > DEMO_OFFER_LIMITS.cashCap) {
    return `Cash payouts are capped at ${formatGBP(DEMO_OFFER_LIMITS.cashCap)}. Pay the rest as store credit.`
  }
  const priv = findDemoCustomer(customerId)?.private
  const flags = priv?.flags ?? []
  if (flags.includes("no_cash")) return "This customer is marked no cash. Pay as store credit."
  if (flags.includes("under_18")) {
    return "This customer is recorded as under 18, so we cannot buy for cash."
  }
  const address = idCheck?.address || priv?.address || ""
  if (address.trim().length === 0) return "Add the seller's address before paying cash."
  const now = Date.now()
  const inDate = (value: string | undefined) =>
    Boolean(value) && new Date(value as string).getTime() > now
  const verified = priv?.id_status === "verified" && inDate(priv?.id_expiry)
  if (!verified && !idCheck) {
    return "Take an ID check before paying cash. Photograph the seller's ID on the ID step."
  }
  if (idCheck && !inDate(idCheck.id_expiry)) {
    return "That ID has expired. Ask for one that is still in date."
  }
  if (!idCheck?.id_document && !demoIdDocuments.has(customerId)) {
    return "Take a photo of the customer's ID before paying cash."
  }
  const dob = idCheck?.dob || priv?.dob || ""
  const age = dob ? ageFrom(dob) : null
  if (age !== null && age < 18) return "We cannot buy for cash from anyone under 18."
  return null
}

/** Section 7, step 1 and 3: the trade-in, its value, and how its surplus is paid. */
function planTrade(payload: TillTicketPayload, sale: number): PlannedTrade {
  if (!payload.customer) throw refusal(400, "Add the customer before taking a trade-in.")
  const entry = demoTradeIns.find((row) => row.record.id === payload.trade_in)
  if (!entry) {
    throw refusal(404, "That trade-in was not found. Start the trade-in again.")
  }
  if (entry.record.status === "completed") {
    throw refusal(409, "That trade-in has already been completed.")
  }
  if (!OPEN_TRADE_STATUSES.has(entry.record.status ?? "draft")) {
    throw refusal(409, "That trade-in is cancelled. Start a new one.")
  }
  if (entry.record.customer !== payload.customer) {
    throw refusal(
      400,
      "That trade-in is for a different customer. Start it again with the customer on the ticket."
    )
  }
  const accepted = entry.lines.filter((line) => line.accepted)
  if (accepted.length === 0) {
    throw refusal(400, "Accept at least one line before completing this trade-in.")
  }

  const value = accepted.reduce(
    (sum, line) => sum + (line.offer_price ?? 0) * Math.max(1, line.qty ?? 1),
    0
  )
  const applied = Math.min(value, sale)
  const surplus = value - applied

  const settlement = payload.trade_settlement
  if (!settlement?.terms_accepted) {
    throw refusal(400, "Ask the customer to accept the terms before completing.")
  }
  if (surplus > 0 && !settlement.surplus) throw refusal(400, "Pay the surplus as credit or cash.")

  let cash = 0
  let credit = 0
  const idCheck = settlement.id_check
    ? { ...settlement.id_check, id_document: settlement.id_check.id_document ?? null }
    : null
  if (surplus > 0 && settlement.surplus === "cash") {
    cash = Math.round(settlement.surplus_cash ?? 0)
    if (!Number.isInteger(cash) || cash < 1 || cash > surplus) {
      throw refusal(
        400,
        `Pay between £0.01 and ${formatGBP(surplus)} in cash, or pay the surplus as credit.`
      )
    }
    // Any of the surplus not paid in cash stays with the shop, by
    // agreement: the till showed both figures before Complete.
    const gate = cashGateRefusal(entry.record.customer, cash, idCheck)
    if (gate) throw refusal(422, gate)
  } else if (surplus > 0) {
    credit = surplus
  }

  return {
    entry,
    accepted,
    value,
    applied,
    surplus,
    cash,
    credit,
    idCheck: cash > 0 ? idCheck : null,
    signature: settlement.signature ?? null,
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function randomBody(): string {
  return Array.from({ length: 5 }, () => CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)]).join("")
}

/**
 * The next buy-in number. Read off the numbers the demo already holds,
 * Home's seeded buy-ins included, so a part-exchange follows on from
 * GG-BI-000122 rather than reusing one.
 */
function nextTradeInNumber(): string {
  const numbers = [
    ...demoTradeIns.map((entry) => entry.record.number),
    ...demoBuyIns.map((buyIn) => buyIn.number),
  ]
  const highest = numbers.reduce((max, number) => {
    const digits = /^GG-BI-(\d+)$/.exec(number ?? "")?.[1]
    return digits ? Math.max(max, Number(digits)) : max
  }, 0)
  return `GG-BI-${String(highest + 1).padStart(6, "0")}`
}

/**
 * Section 7, step 4: the trade-in completed as the buy-in route completes
 * one, with `part_exchange_value` and the sale linked. The items go on the
 * demo shelf at `cost = offer_price`, so Stock and the till see them.
 */
function completeDemoTrade(
  trade: PlannedTrade,
  context: { saleId: string | null; sessionId: string; at: string }
): SaleTradeIn {
  const record = trade.entry.record
  const customerId = record.customer
  const number = nextTradeInNumber()
  const items = itemStore()
  let itemCount = 0

  for (const line of trade.accepted) {
    const kind = (line.kind ?? "other") as ItemKind
    // Singles, graded cards and retro are one row per unit; sealed and
    // accessories are one row carrying the quantity.
    const perLine = kind === "sealed" || kind === "accessory"
    const copies = perLine ? 1 : Math.max(1, line.qty ?? 1)
    for (let index = 0; index < copies; index += 1) {
      itemCount += 1
      items.push({
        id: demoId("item"),
        sku: buildCode(kind, randomBody()).encoded,
        kind,
        game: line.game ?? "",
        card: line.card,
        retro_title: line.retro_title,
        title: line.free_text_title || "Item",
        finish: line.finish,
        condition: line.condition ?? "",
        completeness: line.completeness ?? "",
        qty: perLine ? Math.max(1, line.qty ?? 1) : 1,
        cost: line.offer_price ?? 0,
        market_at_intake: line.market_price ?? 0,
        price: line.market_price ?? 0,
        tax_scheme: "margin",
        status: "in_stock",
        source: "trade_in",
        trade_in: record.id,
        trade_in_line: line.id,
        acquired_at: context.at,
        created: context.at,
      })
    }
  }

  const customer = findDemoCustomer(customerId)
  if (trade.idCheck) {
    demoVerifyId(customerId, trade.idCheck)
    if (trade.idCheck.id_document) demoIdDocuments.set(customerId, trade.idCheck.id_document)
  }

  Object.assign(record as unknown as Record<string, unknown>, {
    number,
    status: "completed",
    // With nothing over, the whole trade went on the sale.
    payout_type: trade.surplus === 0 ? "part_exchange" : trade.cash > 0 ? "cash" : "credit",
    payout_cash: trade.cash,
    payout_credit: trade.credit,
    part_exchange_value: trade.applied,
    sale: context.saleId ?? "",
    completed_at: context.at,
    id_checked: Boolean(trade.idCheck || customer?.private.id_status === "verified"),
    seller_name: customer?.customer.name ?? "",
    seller_address: trade.idCheck?.address || customer?.private.address || "",
  })
  trade.entry.signature = trade.signature

  // The surplus is paid out like a buy-in's: the cash from the drawer, the
  // credit to the customer's ledger. Points once (EPOS-PLAN decision 5):
  // only a credit surplus earns trade-in points, never the part that paid
  // for the sale.
  if (trade.cash > 0) addMovement(context.sessionId, "payout", -trade.cash, number)
  const saleCustomer = DEMO_SALE_CUSTOMERS.find((row) => row.id === customerId)
  if (trade.credit > 0) {
    demoPostCredit(customerId, trade.credit, number)
    if (saleCustomer) saleCustomer.creditBalance += trade.credit
  }
  const points = evaluateTradeInPoints(DEMO_PROGRAMME, [], trade.credit, new Date(context.at))
  if (points > 0) {
    demoAddPoints(customerId, points)
    if (saleCustomer) saleCustomer.pointsBalance += points
  }
  demoRecordVisit(customerId, context.at)
  noteDemoTillTradeIn({
    cash_paid: trade.cash,
    credit_issued: trade.credit,
    part_exchange_value: trade.applied,
  })
  demoBuyIns.push({
    id: record.id,
    number,
    customerName: customer?.customer.name ?? "",
    payoutCash: trade.cash,
    payoutCredit: trade.credit,
    itemCount,
    at: context.at,
  })

  return {
    id: record.id,
    number,
    value: trade.value,
    applied: trade.applied,
    payout_cash: trade.cash,
    payout_credit: trade.credit,
  }
}

// ---------------------------------------------------------------------------
// Refunds: the refund route's, and a return in the ticket (section 7)
// ---------------------------------------------------------------------------

interface PlannedRefundLine {
  line: SaleLineDetail
  row: ReturnType<typeof asSold>["byId"][string]
  qty: number
  restock: boolean
}

/**
 * The lines coming back and what they are worth. `qty` and `discount` on a
 * line are never rewritten: a refund counts up `refunded_qty`, and what each
 * unit is worth comes from the shared sale-line helper, so the figure on the
 * till is the figure the drawer moves by.
 */
function planRefund(
  sale: TillDemoSale,
  requests: { sale_line: string; qty: number; restock?: boolean }[]
): { planned: PlannedRefundLine[]; amount: number } {
  const sold = asSold(sale)
  const planned = requests.flatMap((request): PlannedRefundLine[] => {
    const line = sale.lines.find((row) => row.id === request.sale_line)
    const row = line ? sold.byId[request.sale_line] : undefined
    if (!line || !row) return []
    const qty = Math.min(Math.max(0, Math.floor(request.qty)), remainingQty(row))
    if (qty <= 0) return []
    return [{ line, row, qty, restock: request.restock !== false }]
  })
  const amount = planned.reduce((sum, entry) => sum + refundAmount(entry.row, entry.qty), 0)
  if (amount <= 0) throw refusal(409, "Nothing on that sale is left to refund.")
  return { planned, amount }
}

/** The money going back, checked: it adds up, it can go where it is sent, the drawer covers the cash. */
function checkRefundTenders(
  sale: TillDemoSale,
  tenders: { method: string; amount: number; card_last4?: string }[],
  amount: number,
  /** Cash a trade-in's surplus takes out of the drawer in the same ticket. */
  paidOut = 0
): { cash: number; credit: number; rows: Tender[] } {
  const given = tenders.reduce((sum, tender) => sum + Math.round(tender.amount), 0)
  if (given !== amount) {
    throw refusal(
      400,
      `The refund is ${formatGBP(amount)} but the payments come to ${formatGBP(given)}. Make them match.`
    )
  }
  if (tenders.some((tender) => !["cash", "card_tide", "store_credit"].includes(tender.method))) {
    throw refusal(400, "A refund goes back as cash, to the card or as store credit.")
  }
  const sumOf = (method: string) =>
    tenders.filter((tender) => tender.method === method).reduce((sum, tender) => sum + tender.amount, 0)
  const cash = sumOf("cash")
  const credit = sumOf("store_credit")
  if (credit > 0 && !sale.customer) {
    throw refusal(400, "Store credit needs the customer on the sale. Refund it another way.")
  }
  const drawer = demoDrawerExpected() - paidOut
  if (cash > drawer) {
    throw refusal(
      409,
      `The drawer should only hold ${formatGBP(drawer)}. Refund the rest to card or store credit.`
    )
  }
  return {
    cash,
    credit,
    rows: tenders.map((tender) =>
      tenderRow(tender.method as TenderMethod, -Math.round(tender.amount), {
        card_last4: tender.card_last4,
      })
    ),
  }
}

/**
 * The refund's writes: the lines counted back, stock put back where asked,
 * the sale's refunded total and status, the `-Rn` reference, the customer's
 * credit and points, the cash out of the drawer, and the demo X and Z.
 * `rows` are the refund's tender rows, negative, an exchange's included.
 */
function applyRefund(
  sale: TillDemoSale,
  plan: { planned: PlannedRefundLine[]; amount: number },
  money: { cash: number; credit: number; rows: Tender[] },
  reason: string,
  sessionId: string
): string {
  for (const { line, qty, restock } of plan.planned) {
    line.refunded_qty = (line.refunded_qty ?? 0) + qty
    if (line.refunded_qty >= (line.qty ?? 1)) line.status = "refunded"
    if (!restock || !line.item) continue
    const item = itemFor(line.item)
    if (item) {
      item.qty = (item.qty ?? 0) + qty
      item.status = "in_stock"
      item.updated = new Date().toISOString()
    }
  }

  sale.refunded_total = (sale.refunded_total ?? 0) + plan.amount
  const allRefunded = sale.lines.every((line) => (line.refunded_qty ?? 0) >= (line.qty ?? 1))
  sale.status = allRefunded ? "refunded" : "part_refunded"
  sale.refund_count = (sale.refund_count ?? 0) + 1
  const ref = `${sale.number}-R${sale.refund_count}`

  const customer = DEMO_SALE_CUSTOMERS.find((row) => row.id === sale.customer)
  if (customer) {
    customer.creditBalance += money.credit
    // Cumulative, so a run of partial refunds reverses the sale's points
    // once and no more.
    const before = pointsCum(sale.points_earned ?? 0, sale.total ?? 0, (sale.refunded_total ?? 0) - plan.amount)
    const after = pointsCum(sale.points_earned ?? 0, sale.total ?? 0, sale.refunded_total ?? 0)
    customer.pointsBalance -= after - before
  }
  if (money.cash > 0) addMovement(sessionId, "refund", -money.cash, ref)

  sale.refunds = [...(sale.refunds ?? []), { ref, amount: plan.amount, reason, tenders: money.rows }]
  noteDemoTillRefund({
    ref,
    tenders: money.rows.map((row) => ({ method: row.method, amount: Math.abs(row.amount) })),
  })
  return ref
}

// ---------------------------------------------------------------------------
// Completing a ticket
// ---------------------------------------------------------------------------

/**
 * A ticket, with or without a trade-in or a return on it
 * (docs/api-contract-epos.md, sections 4 and 7). The checks come first and
 * every write after them, as one transaction would: nothing is written for
 * a ticket that is refused.
 */
export function completeTicket(payload: TillTicketPayload): TillTicketResult {
  ensureSeeded()

  const replay = payload.client_id ? completedByClientId.get(payload.client_id) : undefined
  if (replay) return replay

  const raced = armedRaceRefusal()
  if (raced) throw refusal(409, raced)

  const session = demoTill.session
  if (!session) throw refusal(409, "Open the till first.")

  if (payload.reward_code) {
    const voucher = DEMO_VOUCHERS.find((row) => row.code === payload.reward_code)
    if (!voucher || usedVoucherIds.has(voucher.id)) {
      throw refusal(422, "That voucher has been used or has run out. Check the code.")
    }
    if (!payload.customer || payload.customer !== voucher.customer) {
      throw refusal(422, "A reward needs the customer it was issued to on the sale.")
    }
    if (payload.discount_source !== "reward" || payload.discount !== voucher.value) {
      throw refusal(422, "A reward is the whole discount on a sale. Clear the other one.")
    }
  }

  const lines = planLines(payload)
  // A ticket of returns and nothing new is simply a refund; anything else
  // has to sell something, and a trade-in has to have something to pay for.
  if (lines.length === 0 && payload.trade_in) {
    throw refusal(
      400,
      "There is nothing on the ticket for the trade-in to pay for. Add an item, or complete it as a buy-in."
    )
  }
  if (lines.length === 0 && !payload.returns) {
    throw refusal(400, "Scan an item or tap a tile before taking payment.")
  }

  const subtotal = lines.reduce((sum, line) => sum + line.total, 0)
  const discount = Math.max(0, Math.round(payload.discount ?? 0))
  if (discount > subtotal) {
    throw refusal(400, `The discount has to be between £0.00 and ${formatGBP(subtotal)}.`)
  }
  const total = subtotal - discount

  const customer = payload.customer
    ? DEMO_SALE_CUSTOMERS.find((row) => row.id === payload.customer)
    : undefined

  // ---- Section 7: what the trade-in and the return put towards the sale ----
  // The trade applies first, A = min(V, S); then the return against what
  // it left, E = min(R, S - A). The customer keeps the trade's surplus and
  // gets the rest of the refund, R - E, back through the return's tenders.
  const trade = payload.trade_in ? planTrade(payload, total) : null
  const applied = trade?.applied ?? 0

  let returned: { sale: TillDemoSale; plan: ReturnType<typeof planRefund> } | null = null
  if (payload.returns) {
    const original = demoSales.find((row) => row.id === payload.returns?.sale) as TillDemoSale | undefined
    if (!original) throw refusal(404, "That sale was not found. Look it up again.")
    if (!payload.returns.reason?.trim()) throw refusal(400, "Say why it is coming back.")
    returned = { sale: original, plan: planRefund(original, payload.returns.lines) }
  }
  const refundValue = returned?.plan.amount ?? 0
  const exchange = returned ? Math.min(refundValue, total - applied) : 0
  const left = total - applied - exchange

  // The till sends only the other payments. A part-exchange or exchange
  // row is taken as well when it says what the server worked out itself.
  for (const tender of payload.tenders) {
    const method = tender.method as string
    const amount = Math.round(tender.amount)
    if (method === "part_exchange" && !trade) {
      throw refusal(400, "Take part-exchange through Trade in on the ticket.")
    }
    if (method === "exchange" && !returned) {
      throw refusal(400, "Take an exchange through Returns on the till.")
    }
    if (method === "part_exchange" && amount !== applied) {
      throw refusal(
        400,
        `The trade-in pays ${formatGBP(applied)} towards this sale, not ${formatGBP(amount)}. Reload the ticket and try again.`
      )
    }
    if (method === "exchange" && amount !== exchange) {
      throw refusal(
        400,
        `The return pays ${formatGBP(exchange)} towards this sale, not ${formatGBP(amount)}. Reload the ticket and try again.`
      )
    }
  }
  const others = payload.tenders.filter(
    (tender) => (tender.method as string) !== "part_exchange" && (tender.method as string) !== "exchange"
  )
  const after =
    trade && returned ? "the trade-in and the exchange" : trade ? "the trade-in" : returned ? "the exchange" : null
  const paid = checkTenders(others, left, total, customer, (covered) =>
    after
      ? `The payments come to ${formatGBP(covered)} but ${formatGBP(left)} is left after ${after}.`
      : `The payments come to ${formatGBP(covered)} but the total is ${formatGBP(total)}.`
  )

  // R - E goes back through the return's own tenders; the exchange part
  // is written on the refund as a negative `exchange` tender, so nothing
  // moves in the drawer for it. Cash going back is checked against the
  // drawer less any cash surplus the trade pays out in the same ticket.
  const refundMoney = returned
    ? checkRefundTenders(
        returned.sale,
        payload.returns?.tenders ?? [],
        refundValue - exchange,
        trade?.cash ?? 0
      )
    : null

  // ---- Every check has passed: the writes ----------------------------------
  const now = new Date().toISOString()
  const rows: Tender[] = [
    ...(trade && trade.applied > 0 ? [tenderRow("part_exchange", trade.applied)] : []),
    ...(exchange > 0 ? [tenderRow("exchange", exchange)] : []),
    ...paid.rows,
  ]

  let saleRecord: TillTicketResult["sale"] = null
  let earned = 0
  if (lines.length > 0) {
    const number = nextSaleNumber()
    const saleId = demoId("sale")

    // The same pro rata spread the server uses, with the last line absorbing
    // the remainder, so the evaluator sees exactly what was charged. The
    // sale earns on its whole value, whatever paid for it.
    const nets = spread(
      lines.map((line) => line.total),
      discount
    )
    const pointsLines: SaleLineForPoints[] = lines.map((line, index) => ({
      game: line.game,
      kind: line.kind,
      total: nets[index] ?? 0,
    }))
    earned = customer
      ? evaluateSalePoints(DEMO_PROGRAMME, DEMO_RULES, {
          lines: pointsLines,
          at: new Date(),
          isFirstPurchase: false,
          isBirthdayMonth: false,
          tier: DEMO_TIERS.find((tier) => tier.id === customer.tierId) ?? null,
          paidWithPoints: paid.points,
        }).total
      : 0

    const methods = [...new Set(rows.map((row) => row.method))]
    // Old reports read `payment` and `payment_split`; the tenders are the
    // record now, mirrored there as the server does for new sales.
    const payment = (methods.length === 1 ? methods[0] : methods.length === 0 ? "cash" : "mixed") as PaymentMethod
    const split: Record<string, number> = {}
    for (const row of rows) split[row.method] = (split[row.method] ?? 0) + row.amount

    const sale: TillDemoSale = {
      id: saleId,
      number,
      staff: DEMO_STAFF.id,
      customer: payload.customer ?? undefined,
      customerName: customerName(payload.customer),
      subtotal,
      discount,
      discount_source: payload.discount_source ?? "",
      total,
      payment,
      payment_split: split as DemoSale["payment_split"],
      cash_session: session.id,
      register: payload.register ?? DEMO_REGISTER.id,
      points_earned: earned,
      status: "complete",
      created: now,
      tenders: rows,
      refund_count: 0,
      refunds: [],
      ...(trade ? { trade_in: trade.entry.record.id } : {}),
      lines: lines.map((line): TillDemoLine => ({
        id: demoId("sale_line"),
        sale: saleId,
        item: line.item?.id ?? "",
        ...(line.productId ? { product: line.productId } : {}),
        qty: line.qty,
        unit_price: line.unitPrice,
        discount: line.discount,
        tax_scheme: line.taxScheme === "exempt" ? "margin" : line.taxScheme,
        status: "sold",
        sku: line.item?.sku ?? "",
        title: line.title,
        condition: line.item?.condition ?? "",
        ...(line.note ? { note: line.note } : {}),
      })),
    }

    for (const line of lines) {
      const item = line.item
      if (!item) continue
      item.qty = Math.max(0, (item.qty ?? 1) - line.qty)
      if (item.qty === 0) item.status = "sold"
      item.reserved_for = undefined
      item.reserved_until = undefined
      item.updated = now
    }

    if (customer) {
      customer.creditBalance -= paid.credit
      customer.pointsBalance += earned - (paid.points > 0 ? penceToPoints(paid.points, DEMO_PROGRAMME) : 0)
    }
    if (payload.reward_code) {
      const voucher = DEMO_VOUCHERS.find((row) => row.code === payload.reward_code)
      if (voucher) usedVoucherIds.add(voucher.id)
    }
    if (paid.cash > 0) addMovement(session.id, "cash_sale", paid.cash, number)
    if (payload.voided?.length) demoRecordVoids("void_line", payload.voided, saleId)

    demoSales.unshift(sale)
    // The demo X and Z read their own book of the session's sales: the
    // part-exchange and exchange tenders go on it with the rest.
    noteDemoTillSale({
      number,
      staff: { id: DEMO_STAFF.id, name: DEMO_STAFF.name },
      category: categoryForKind(lines[0]?.kind),
      gross: subtotal,
      discount,
      tenders: rows.map((row) => ({ method: row.method, amount: row.amount })),
    })
    saleRecord = { id: sale.id, number, total, status: "complete" }
  }

  const tradeIn = trade
    ? completeDemoTrade(trade, { saleId: saleRecord?.id ?? null, sessionId: session.id, at: now })
    : null

  let refund: TillTicketResult["refund"] = null
  if (returned && refundMoney && payload.returns) {
    const refundRows = [...(exchange > 0 ? [tenderRow("exchange", -exchange)] : []), ...refundMoney.rows]
    const ref = applyRefund(
      returned.sale,
      returned.plan,
      { cash: refundMoney.cash, credit: refundMoney.credit, rows: refundRows },
      payload.returns.reason.trim(),
      session.id
    )
    refund = {
      ref,
      amount: refundValue,
      exchange,
      sale: { id: returned.sale.id, number: returned.sale.number },
      tenders: refundRows,
    }
  }

  // A ticket of returns alone answers with the refund route's own body,
  // with the exchange at nothing.
  const result: TillTicketResult =
    !saleRecord && returned && refund
      ? {
          sale: { id: returned.sale.id, status: returned.sale.status ?? "refunded" },
          refund: { ref: refund.ref, amount: refund.amount, tenders: refund.tenders, exchange: 0 },
        }
      : {
          sale: saleRecord,
          tenders: rows,
          change: paid.change,
          vat_total: 0,
          receipt: { number: saleRecord?.number ?? "" },
          points_earned: earned,
          credit_balance: customer?.creditBalance ?? 0,
          points_balance: customer?.pointsBalance ?? 0,
          trade_in: tradeIn,
          refund,
        }
  if (payload.client_id) completedByClientId.set(payload.client_id, result)
  return result
}

/**
 * The sale route as the plain till and the offline queue call it. A ticket
 * of returns alone makes no sale, so it only ever goes through
 * `completeTicket`, which answers for it.
 */
export function completeSale(payload: TillSalePayload): TillSaleResult {
  const ticket = payload as TillTicketPayload
  if (ticket.returns && payload.lines.length === 0) {
    throw refusal(400, "A ticket of returns alone is a refund. Take it from the till.")
  }
  return completeTicket(payload) as TillSaleResult
}

// ---------------------------------------------------------------------------
// The lookup and refunds
// ---------------------------------------------------------------------------

/** "GG-S-000456" from either form a receipt prints. */
function saleNumberFrom(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/-R\d+$/, "").replace(/R\d+$/, "")
  const digits = /^GG-?S-?(\d+)$/.exec(compact)?.[1]
  return digits ? `GG-S-${digits}` : compact
}

function asSold(sale: TillDemoSale) {
  return breakdown(
    sale.lines.map((line) => ({
      id: line.id,
      qty: line.qty ?? 1,
      unitPrice: line.unit_price ?? 0,
      discount: line.discount ?? 0,
      refundedQty: line.refunded_qty ?? 0,
    })),
    sale.discount ?? 0
  )
}

/** The tenders a sale was paid with, the seeded sales' from their split. */
function tendersOf(sale: TillDemoSale): Tender[] {
  if (sale.tenders) return sale.tenders
  return Object.entries(sale.payment_split ?? {}).flatMap(([method, amount]) =>
    amount && method in TENDER_LABELS ? [tenderRow(method as TenderMethod, amount)] : []
  )
}

export function lookupSale(raw: string): { sale: SaleLookup } {
  ensureSeeded()
  const number = saleNumberFrom(raw)
  const sale = demoSales.find((row) => row.number === number) as TillDemoSale | undefined
  if (!sale) throw refusal(404, `No sale has the number ${number}.`)

  const sold = asSold(sale)
  const lines = sale.lines.map((line) => {
    const row = sold.byId[line.id]
    const remaining = row ? remainingQty(row) : 0
    return {
      id: line.id,
      title: line.title || "Item",
      detail: line.condition ?? "",
      sku: line.sku,
      qty: line.qty ?? 1,
      refunded_qty: line.refunded_qty ?? 0,
      unit_price: line.unit_price ?? 0,
      discount: line.discount ?? 0,
      net: row?.net ?? 0,
      refundable_qty: remaining,
      refundable_amount: row ? refundAmount(row, remaining) : 0,
      tax_scheme: (line.tax_scheme ?? "margin") as "margin" | "standard" | "exempt",
    }
  })

  const customer = sale.customer
    ? DEMO_SALE_CUSTOMERS.find((row) => row.id === sale.customer) ?? null
    : null

  return {
    sale: {
      id: sale.id,
      number: sale.number,
      occurred_at: sale.created ?? "",
      total: sale.total ?? 0,
      status: sale.status ?? "complete",
      customer: customer ? { id: customer.id, name: customer.name, code: customer.code } : null,
      register_name: DEMO_REGISTER.name,
      staff_name: DEMO_STAFF.name,
      lines,
      tenders: [
        ...tendersOf(sale),
        ...(sale.refunds ?? []).flatMap((refund) => refund.tenders),
      ],
    },
  }
}

export function refundSale(id: string, payload: TillRefundPayload): TillRefundResult {
  ensureSeeded()
  const sale = demoSales.find((row) => row.id === id) as TillDemoSale | undefined
  if (!sale) throw refusal(404, "That sale was not found. Look it up again.")
  const session = demoTill.session
  if (!session) throw refusal(409, "Open the till first.")
  if (!payload.reason?.trim()) throw refusal(400, "Say why it is coming back.")

  const plan = planRefund(sale, payload.lines)
  const money = checkRefundTenders(sale, payload.tenders, plan.amount)
  const ref = applyRefund(sale, plan, money, payload.reason.trim(), session.id)

  return {
    sale: { id: sale.id, status: sale.status ?? "complete" },
    refund: { ref, amount: plan.amount, tenders: money.rows },
  }
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function isToday(iso?: string): boolean {
  if (!iso) return false
  const then = new Date(iso)
  const now = new Date()
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  )
}

export function todayStats(): TodayStats {
  ensureSeeded()
  const sales = demoSales.filter((sale) => isToday(sale.created))
  const buyIns = demoBuyIns.filter((buyIn) => isToday(buyIn.at))

  const salesByPayment: TodayStats["salesByPayment"] = {}
  let salesTotal = 0
  let itemsOut = 0
  for (const sale of sales) {
    if (sale.status === "refunded") continue
    salesTotal += (sale.total ?? 0) - (sale.refunded_total ?? 0)
    itemsOut += sale.lines.reduce(
      (count, line) => count + ((line.qty ?? 0) - (line.refunded_qty ?? 0)),
      0
    )
    for (const [method, amount] of Object.entries(sale.payment_split ?? {})) {
      const key = method as keyof TodayStats["salesByPayment"]
      salesByPayment[key] = (salesByPayment[key] ?? 0) + (amount ?? 0)
    }
  }

  const cashOut = demoCashMovements
    .filter(
      (movement) =>
        isToday(movement.created) &&
        (movement.type === "payout" ||
          movement.type === "bank_drop" ||
          movement.type === "refund")
    )
    .reduce((total, movement) => total + Math.abs(movement.amount ?? 0), 0)

  const recent: RecentActivity[] = [
    ...sales.map((sale) => ({
      id: sale.id,
      kind: "sale" as const,
      number: sale.number,
      total: sale.total ?? 0,
      detail: sale.customerName ?? `${sale.lines.length} item${sale.lines.length === 1 ? "" : "s"}`,
      at: sale.created ?? "",
    })),
    ...buyIns.map((buyIn) => ({
      id: buyIn.id,
      kind: "buy_in" as const,
      number: buyIn.number,
      total: buyIn.payoutCash + buyIn.payoutCredit,
      detail: buyIn.customerName,
      at: buyIn.at,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10)

  return {
    salesCount: sales.filter((sale) => sale.status !== "refunded").length,
    salesTotal,
    salesByPayment,
    buyInCount: buyIns.length,
    buyInTotal: buyIns.reduce(
      (total, buyIn) => total + buyIn.payoutCash + buyIn.payoutCredit,
      0
    ),
    cashOut: cashOut + buyIns.reduce((total, buyIn) => total + buyIn.payoutCash, 0),
    creditIssued: buyIns.reduce((total, buyIn) => total + buyIn.payoutCredit, 0),
    itemsIn: buyIns.reduce((total, buyIn) => total + buyIn.itemCount, 0),
    itemsOut,
    recent,
  }
}
