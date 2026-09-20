/**
 * Sale completion, refunds, the step-up and today's numbers, answered from
 * memory. The order of the checks and the writes mirrors the transaction in
 * docs/api-contract.md, so the demo refuses a sale for the same reasons the
 * server does and Home counts the same things.
 */
import { evaluateSalePoints, penceToPoints, type SaleLineForPoints } from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import { addMovement, openSession } from "@/lib/api/demo/cash"
import {
  DEMO_PROGRAMME,
  DEMO_RULES,
  DEMO_SALE_CUSTOMERS,
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
  CompleteSalePayload,
  CompleteSaleResult,
  LoyaltySetup,
  RecentActivity,
  RefundSalePayload,
  RefundSaleResult,
  RewardVoucher,
  SaleCustomer,
  SaleDetail,
  SaleSummary,
  StockItemRecord,
  TodayStats,
} from "@/lib/api/types"

export const DEMO_STEP_UP_PASSWORD = DEMO_STAFF.password

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

export function completeSale(payload: CompleteSalePayload): CompleteSaleResult {
  ensureSeeded()

  const lines = payload.lines.map((line) => {
    const item = itemFor(line.item)
    if (!item) throw new Error("That item is no longer in stock.")
    const available = item.qty ?? 1
    if (item.status === "sold" || item.status === "written_off") {
      throw new Error(`${item.title ?? "That item"} is no longer for sale.`)
    }
    if (
      item.status === "reserved" &&
      item.reserved_for &&
      item.reserved_for !== payload.customer
    ) {
      throw new Error(`${item.title ?? "That item"} is reserved for another customer.`)
    }
    if (line.qty > available) {
      throw new Error(`Only ${available} of ${item.title ?? "that item"} left in stock.`)
    }
    return { line, item }
  })

  const subtotal = payload.lines.reduce(
    (total, line) => total + line.unit_price * line.qty,
    0
  )
  const total = Math.max(0, subtotal - payload.discount)

  const split = payload.payment_split
  const cashPart = split.cash ?? 0
  const session = openSession()
  if (cashPart > 0 && !session) {
    throw new Error("Open a cash session before taking cash.")
  }

  const customer = payload.customer
    ? DEMO_SALE_CUSTOMERS.find((row) => row.id === payload.customer)
    : undefined
  const creditPart = split.store_credit ?? 0
  if (creditPart > 0 && (customer?.creditBalance ?? 0) < creditPart) {
    throw new Error("That is more store credit than this customer has.")
  }
  const pointsPart = split.points ?? 0
  const pointsSpent = pointsPart > 0 ? penceToPoints(pointsPart, DEMO_PROGRAMME) : 0
  if (pointsSpent > (customer?.pointsBalance ?? 0)) {
    throw new Error("That is more points than this customer has.")
  }

  const number = nextSaleNumber()
  const saleId = demoId("sale")
  const now = new Date().toISOString()

  const pointsLines: SaleLineForPoints[] = lines.map(({ line, item }) => ({
    game: item.game ?? null,
    kind: item.kind,
    total:
      subtotal > 0
        ? Math.round(
            (line.unit_price * line.qty) -
              (payload.discount * (line.unit_price * line.qty)) / subtotal
          )
        : 0,
  }))
  const earned = customer
    ? evaluateSalePoints(DEMO_PROGRAMME, DEMO_RULES, {
        lines: pointsLines,
        at: new Date(),
        isFirstPurchase: false,
        isBirthdayMonth: false,
        tier: DEMO_TIERS.find((tier) => tier.id === customer.tierId) ?? null,
        paidWithPoints: pointsPart,
      }).total
    : 0

  const sale: DemoSale = {
    id: saleId,
    number,
    staff: DEMO_STAFF.id,
    customer: payload.customer ?? undefined,
    customerName: customerName(payload.customer),
    subtotal,
    discount: payload.discount,
    discount_source: payload.discount_source ?? "",
    total,
    payment: payload.payment,
    payment_split: split,
    sumup_ref: payload.sumup_ref,
    cash_session: session?.id,
    points_earned: earned,
    status: "complete",
    created: now,
    lines: lines.map(({ line, item }) => ({
      id: demoId("sale_line"),
      sale: saleId,
      item: item.id,
      qty: line.qty,
      unit_price: line.unit_price,
      discount: line.discount,
      tax_scheme: item.tax_scheme ?? "margin",
      status: "sold",
      sku: item.sku,
      title: item.title ?? "",
      condition: item.condition ?? "",
    })),
  }

  for (const { line, item } of lines) {
    const remaining = (item.qty ?? 1) - line.qty
    item.qty = Math.max(0, remaining)
    if (item.qty === 0) item.status = "sold"
    item.reserved_for = undefined
    item.reserved_until = undefined
    item.updated = now
  }

  if (customer) {
    customer.creditBalance -= creditPart
    customer.pointsBalance += earned - pointsSpent
  }
  if (payload.reward_code) {
    const voucher = DEMO_VOUCHERS.find((row) => row.code === payload.reward_code)
    if (voucher) usedVoucherIds.add(voucher.id)
  }
  if (cashPart > 0 && session) {
    addMovement(session.id, "cash_sale", cashPart, number)
  }

  demoSales.unshift(sale)

  return {
    sale: { id: sale.id, number, total, status: "complete" },
    sumup_amount: split.sumup_card ?? 0,
    points_earned: earned,
    credit_balance: customer?.creditBalance ?? 0,
    points_balance: customer?.pointsBalance ?? 0,
  }
}

export function refundSale(
  id: string,
  payload: RefundSalePayload
): RefundSaleResult {
  ensureSeeded()
  const sale = demoSales.find((row) => row.id === id)
  if (!sale) throw new Error("That sale is not on today's list.")

  let refunded = 0
  for (const request of payload.lines) {
    const line = sale.lines.find((row) => row.id === request.sale_line)
    if (!line || line.status === "refunded") continue
    refunded += (line.unit_price ?? 0) * request.qty - (line.discount ?? 0)
    line.status = "refunded"
    const item = itemFor(line.item)
    if (item) {
      item.qty = (item.qty ?? 0) + request.qty
      item.status = "in_stock"
      item.updated = new Date().toISOString()
    }
  }

  const allRefunded = sale.lines.every((line) => line.status === "refunded")
  sale.status = allRefunded ? "refunded" : "part_refunded"

  const customer = DEMO_SALE_CUSTOMERS.find((row) => row.id === sale.customer)
  if (customer) {
    if (payload.refund_method === "store_credit") customer.creditBalance += refunded
    if (allRefunded) customer.pointsBalance -= sale.points_earned ?? 0
  }

  const session = openSession()
  if (payload.refund_method === "cash" && session) {
    addMovement(session.id, "refund", -refunded, sale.number)
  }

  return { sale: { id: sale.id, status: sale.status }, refunded }
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
    salesTotal += sale.total ?? 0
    itemsOut += sale.lines
      .filter((line) => line.status !== "refunded")
      .reduce((count, line) => count + (line.qty ?? 0), 0)
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
