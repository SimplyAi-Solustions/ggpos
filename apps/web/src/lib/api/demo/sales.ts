/**
 * Sale completion, the sale lookup, refunds, the step-up and today's
 * numbers, answered from memory. The order of the checks and the writes
 * mirrors the transaction in docs/api-contract-epos.md, section 4, so the
 * demo refuses a sale for the same reasons the server does and Home counts
 * the same things.
 *
 * Every sale and refund needs the demo till open (`demoTill.session`), the
 * same as a till sale on the server needs an open session on its register.
 * The cash part goes on that session as a `cash_sale` movement.
 */
import { ClientResponseError } from "pocketbase"
import {
  TENDER_LABELS,
  breakdown,
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
  type Tender,
  type TenderMethod,
} from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import { addMovement } from "@/lib/api/demo/cash"
import {
  demoTill,
  DEMO_REGISTER,
  noteDemoTillRefund,
  noteDemoTillSale,
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
} from "@/lib/api/types"
import type {
  TillRefundPayload,
  TillRefundResult,
  TillSalePayload,
  TillSaleResult,
} from "@/lib/api/sales"

export const DEMO_STEP_UP_PASSWORD = DEMO_STAFF.password

/** A demo sale with what the till adds to it: its tenders and its refunds. */
interface TillDemoSale extends DemoSale {
  register?: string
  tenders?: Tender[]
  refund_count?: number
  refunds?: { ref: string; amount: number; reason: string; tenders: Tender[] }[]
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
const completedByClientId = new Map<string, TillSaleResult>()

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
  payload: TillSalePayload,
  total: number,
  customer: SaleCustomer | undefined
): { cash: number; credit: number; points: number; change: number; rows: Tender[] } {
  let cash = 0
  let credit = 0
  let points = 0
  let change = 0
  let cashTenders = 0
  const rows: Tender[] = []

  for (const tender of payload.tenders) {
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
        throw refusal(400, "Part-exchange is not available yet.")
    }
  }

  if (cashTenders > 1) throw refusal(400, "Take cash once on a sale. Put the cash together.")
  const sum = rows.reduce((total, row) => total + row.amount, 0)
  if (sum !== total) {
    throw refusal(400, `The payments come to ${formatGBP(sum)} but the total is ${formatGBP(total)}.`)
  }
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
    const check = checkPointsRedemption(DEMO_PROGRAMME, customer.pointsBalance, spent, total)
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

export function completeSale(payload: TillSalePayload): TillSaleResult {
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
  if (lines.length === 0) throw refusal(400, "Scan an item or tap a tile before taking payment.")

  const subtotal = lines.reduce((sum, line) => sum + line.total, 0)
  const discount = Math.max(0, Math.round(payload.discount ?? 0))
  if (discount > subtotal) {
    throw refusal(400, `The discount has to be between £0.00 and ${formatGBP(subtotal)}.`)
  }
  const total = subtotal - discount

  const customer = payload.customer
    ? DEMO_SALE_CUSTOMERS.find((row) => row.id === payload.customer)
    : undefined
  const paid = checkTenders(payload, total, customer)

  const number = nextSaleNumber()
  const saleId = demoId("sale")
  const now = new Date().toISOString()

  // The same pro rata spread the server uses, with the last line absorbing
  // the remainder, so the evaluator sees exactly what was charged.
  const nets = spread(
    lines.map((line) => line.total),
    discount
  )
  const pointsLines: SaleLineForPoints[] = lines.map((line, index) => ({
    game: line.game,
    kind: line.kind,
    total: nets[index] ?? 0,
  }))
  const earned = customer
    ? evaluateSalePoints(DEMO_PROGRAMME, DEMO_RULES, {
        lines: pointsLines,
        at: new Date(),
        isFirstPurchase: false,
        isBirthdayMonth: false,
        tier: DEMO_TIERS.find((tier) => tier.id === customer.tierId) ?? null,
        paidWithPoints: paid.points,
      }).total
    : 0

  const methods = [...new Set(paid.rows.map((row) => row.method))]
  // Old reports read `payment` and `payment_split`; the tenders are the
  // record now, mirrored there as the server does for new sales.
  const payment = (methods.length === 1 ? methods[0] : "mixed") as PaymentMethod
  const split: Record<string, number> = {}
  for (const row of paid.rows) split[row.method] = (split[row.method] ?? 0) + row.amount

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
    tenders: paid.rows,
    refund_count: 0,
    refunds: [],
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
  // The demo X and Z read their own book of the session's sales.
  noteDemoTillSale({
    number,
    staff: { id: DEMO_STAFF.id, name: DEMO_STAFF.name },
    category: categoryForKind(lines[0]?.kind),
    gross: subtotal,
    discount,
    tenders: paid.rows.map((row) => ({ method: row.method, amount: row.amount })),
  })

  const result: TillSaleResult = {
    sale: { id: sale.id, number, total, status: "complete" },
    tenders: paid.rows,
    change: paid.change,
    vat_total: 0,
    receipt: { number },
    points_earned: earned,
    credit_balance: customer?.creditBalance ?? 0,
    points_balance: customer?.pointsBalance ?? 0,
  }
  if (payload.client_id) completedByClientId.set(payload.client_id, result)
  return result
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

  // `qty` and `discount` on a line are never rewritten: a refund counts up
  // `refunded_qty` and only marks the line refunded once it reaches `qty`.
  // What each unit is worth comes from the shared sale-line helper, so the
  // figure in the returns sheet is the figure the drawer moves by.
  const sold = asSold(sale)
  const planned = payload.lines.flatMap((request) => {
    const line = sale.lines.find((row) => row.id === request.sale_line)
    const row = line ? sold.byId[request.sale_line] : undefined
    if (!line || !row) return []
    const qty = Math.min(Math.max(0, Math.floor(request.qty)), remainingQty(row))
    if (qty <= 0) return []
    return [{ line, row, qty, restock: request.restock !== false }]
  })
  const amount = planned.reduce((sum, entry) => sum + refundAmount(entry.row, entry.qty), 0)
  if (amount <= 0) throw refusal(409, "Nothing on that sale is left to refund.")

  const given = payload.tenders.reduce((sum, tender) => sum + Math.round(tender.amount), 0)
  if (given !== amount) {
    throw refusal(
      400,
      `The refund is ${formatGBP(amount)} but the payments come to ${formatGBP(given)}. Make them match.`
    )
  }
  const cash = payload.tenders
    .filter((tender) => tender.method === "cash")
    .reduce((sum, tender) => sum + tender.amount, 0)
  const credit = payload.tenders
    .filter((tender) => tender.method === "store_credit")
    .reduce((sum, tender) => sum + tender.amount, 0)
  if (credit > 0 && !sale.customer) {
    throw refusal(400, "Store credit needs the customer on the sale. Refund it another way.")
  }
  const drawer = demoDrawerExpected()
  if (cash > drawer) {
    throw refusal(
      409,
      `The drawer should only hold ${formatGBP(drawer)}. Refund the rest to card or store credit.`
    )
  }

  for (const { line, qty, restock } of planned) {
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

  sale.refunded_total = (sale.refunded_total ?? 0) + amount
  const allRefunded = sale.lines.every((line) => (line.refunded_qty ?? 0) >= (line.qty ?? 1))
  sale.status = allRefunded ? "refunded" : "part_refunded"
  sale.refund_count = (sale.refund_count ?? 0) + 1
  const ref = `${sale.number}-R${sale.refund_count}`

  const customer = DEMO_SALE_CUSTOMERS.find((row) => row.id === sale.customer)
  if (customer) {
    customer.creditBalance += credit
    // Cumulative, so a run of partial refunds reverses the sale's points
    // once and no more.
    const before = pointsCum(sale.points_earned ?? 0, sale.total ?? 0, (sale.refunded_total ?? 0) - amount)
    const after = pointsCum(sale.points_earned ?? 0, sale.total ?? 0, sale.refunded_total ?? 0)
    customer.pointsBalance -= after - before
  }
  if (cash > 0) addMovement(session.id, "refund", -cash, ref)

  const tenders = payload.tenders.map((tender) =>
    tenderRow(tender.method, -Math.round(tender.amount), { card_last4: tender.card_last4 })
  )
  sale.refunds = [...(sale.refunds ?? []), { ref, amount, reason: payload.reason.trim(), tenders }]
  noteDemoTillRefund({
    ref,
    tenders: tenders.map((row) => ({ method: row.method, amount: Math.abs(row.amount) })),
  })

  return { sale: { id: sale.id, status: sale.status }, refund: { ref, amount, tenders } }
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
