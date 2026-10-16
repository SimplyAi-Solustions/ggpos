/**
 * The reports dashboard (docs/api-contract-launch.md, section 3,
 * `GET /api/vault/reports/dashboard`): sales, cost and profit over a range,
 * added up from one entry per sale line.
 *
 * Pure and shared: the route gathers the lines (through the margin report's
 * own line walk, so the two agree to the penny) and the demo builds its own,
 * and both add them up here.
 *
 * - **gross** is what the lines came to before any discount, **discounts**
 *   the line and ticket discounts, **refunds** what has gone back on the
 *   range's sales whenever it was given, and **net** what is left: the
 *   margin report's revenue.
 * - **vat** is the VAT due on what was kept: standard and reduced lines at
 *   the rate they were charged, and the margin scheme's VAT on each margin
 *   line inside the registration.
 * - **cost** is what the stock kept cost (`items.cost` times the quantity
 *   kept); a till product has none.
 * - **profit** is net less VAT less cost, and **margin_pct** is profit as a
 *   percentage of net less VAT: of what the shop actually earned on its
 *   sales once the VAT is paid over.
 */
import { roundHalfUp } from "./money"

/** One sale line in the range, as kept after its refunds. Money in pence. */
export interface DashboardLine {
  /** The sale's day, UTC, YYYY-MM-DD, as every report counts a day. */
  date: string
  /** unit_price times qty, before any discount. */
  gross: number
  /** The line's own discount plus its share of the ticket discount. */
  discount: number
  /** What has gone back on it. */
  refunded: number
  /** The VAT due on what was kept. */
  vat: number
  /** What the stock kept cost. */
  cost: number
  /** Units kept. */
  qty: number
  /** The line's top-level branch: its id ("" for none) and name. */
  branch: { id: string; label: string }
  /** What the line was: "item:<id>" or "product:<id>". */
  key: string
  title: string
  sku: string
}

/** What a sale was paid with, net of what went back the same way. */
export interface DashboardPayment {
  method: string
  label: string
  amount: number
}

export interface DashboardSales {
  gross: number
  discounts: number
  refunds: number
  net: number
  vat: number
  /** Sales in the range. */
  count: number
  /** net over count, half-up. */
  average: number
}

/** The figures a comparison period carries. */
export interface DashboardHeadline {
  sales: DashboardSales
  cost: number
  profit: number
  margin_pct: number
  buy_ins: { spend: number; count: number }
}

export interface DashboardDay {
  date: string
  net: number
  cost: number
  profit: number
}

export interface DashboardCategory {
  id: string
  label: string
  net: number
  cost: number
  profit: number
  margin_pct: number
}

export interface DashboardItem {
  title: string
  sku: string
  net: number
  profit: number
  /** Units kept. */
  count: number
}

export interface DashboardStock {
  /** Held stock at cost. */
  cost: number
  /** Held stock at its sell price. */
  retail: number
  /** Units held. */
  items: number
}

export interface Dashboard extends DashboardHeadline {
  from: string
  to: string
  stock: DashboardStock
  series: DashboardDay[]
  by_category: DashboardCategory[]
  top_items: DashboardItem[]
  payments: { method: string; label: string; net: number }[]
  compare?: DashboardHeadline & { from: string; to: string }
}

export interface DashboardInput {
  from: string
  to: string
  /** Sales in the range, refunded or not. */
  saleCount: number
  lines: readonly DashboardLine[]
  payments: readonly DashboardPayment[]
  buyIns: { spend: number; count: number }
  stock: DashboardStock
}

/** How many items the top items list carries. */
export const DASHBOARD_TOP_ITEMS = 10

/** Every day from `from` to `to`, both included, YYYY-MM-DD. */
export function daysFromTo(from: string, to: string): string[] {
  const out: string[] = []
  const at = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  if (Number.isNaN(at.getTime()) || Number.isNaN(end.getTime())) return out
  while (at.getTime() <= end.getTime() && out.length < 1000) {
    out.push(at.toISOString().slice(0, 10))
    at.setUTCDate(at.getUTCDate() + 1)
  }
  return out
}

/**
 * Profit as a percentage of a base, to one place, half-up: 0 when the base
 * is nothing. The figure itself is a ratio, not money, so the one division
 * here never reaches a penny.
 */
export function profitPct(profit: number, base: number): number {
  if (!(base > 0)) return 0
  return roundHalfUp((profit * 1000) / base) / 10
}

/** Net, VAT and cost into profit and its margin. */
function earned(net: number, vat: number, cost: number): { profit: number; margin_pct: number } {
  const profit = net - vat - cost
  return { profit, margin_pct: profitPct(profit, net - vat) }
}

/** The headline figures alone, for the comparison period. */
export function dashboardHeadline(input: Omit<DashboardInput, "payments" | "stock">): DashboardHeadline {
  let gross = 0
  let discounts = 0
  let refunds = 0
  let vat = 0
  let cost = 0
  for (const line of input.lines) {
    gross += line.gross
    discounts += line.discount
    refunds += line.refunded
    vat += line.vat
    cost += line.cost
  }
  const net = gross - discounts - refunds
  const count = Math.max(0, input.saleCount)
  return {
    sales: {
      gross,
      discounts,
      refunds,
      net,
      vat,
      count,
      average: count > 0 ? roundHalfUp(net / count) : 0,
    },
    cost,
    ...earned(net, vat, cost),
    buy_ins: { spend: input.buyIns.spend, count: input.buyIns.count },
  }
}

/** The whole dashboard for one range (the route adds `compare`). */
export function summariseDashboard(input: DashboardInput): Dashboard {
  const headline = dashboardHeadline(input)

  const days = new Map<string, { net: number; vat: number; cost: number }>()
  for (const day of daysFromTo(input.from, input.to)) days.set(day, { net: 0, vat: 0, cost: 0 })

  const branches = new Map<string, { id: string; label: string; net: number; vat: number; cost: number }>()
  const items = new Map<string, { title: string; sku: string; net: number; vat: number; cost: number; count: number }>()

  for (const line of input.lines) {
    const net = line.gross - line.discount - line.refunded
    const day = days.get(line.date)
    if (day) {
      day.net += net
      day.vat += line.vat
      day.cost += line.cost
    }

    const branch = branches.get(line.branch.id) ?? { id: line.branch.id, label: line.branch.label, net: 0, vat: 0, cost: 0 }
    branch.net += net
    branch.vat += line.vat
    branch.cost += line.cost
    branches.set(line.branch.id, branch)

    // A line refunded in full sold nothing, so it is no top item.
    if (line.qty > 0) {
      const item = items.get(line.key) ?? { title: line.title, sku: line.sku, net: 0, vat: 0, cost: 0, count: 0 }
      item.net += net
      item.vat += line.vat
      item.cost += line.cost
      item.count += line.qty
      items.set(line.key, item)
    }
  }

  const byNet = <T extends { net: number }>(label: (row: T) => string) => (a: T, b: T) =>
    b.net - a.net || (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0)

  const payments = new Map<string, { method: string; label: string; net: number }>()
  for (const payment of input.payments) {
    const row = payments.get(payment.method) ?? { method: payment.method, label: payment.label, net: 0 }
    row.net += payment.amount
    payments.set(payment.method, row)
  }

  return {
    from: input.from,
    to: input.to,
    ...headline,
    stock: { ...input.stock },
    series: [...days.entries()].map(([date, day]) => ({
      date,
      net: day.net,
      cost: day.cost,
      profit: day.net - day.vat - day.cost,
    })),
    by_category: [...branches.values()]
      .map((row) => ({ id: row.id, label: row.label, net: row.net, cost: row.cost, ...earned(row.net, row.vat, row.cost) }))
      .sort(byNet((row) => row.label)),
    top_items: [...items.values()]
      .map((row) => ({ title: row.title, sku: row.sku, net: row.net, profit: row.net - row.vat - row.cost, count: row.count }))
      .sort(byNet((row) => row.title))
      .slice(0, DASHBOARD_TOP_ITEMS),
    payments: [...payments.values()].filter((row) => row.net !== 0).sort(byNet((row) => row.label)),
  }
}
