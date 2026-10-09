/**
 * The demo dashboard (docs/api-contract-launch.md, section 3): built from the
 * demo shop's own day figures (`dayStat` in ./reports), so it reads the same
 * net as the demo Sales report and the same cost share as the demo Margin
 * report, and added up by the shared `summariseDashboard`, exactly as the
 * route adds up the real thing.
 *
 * Each day's sales are split across the top-level branches the way the demo
 * Sales report's category table splits them. VAT follows the demo settings:
 * nothing while the shop is not registered or before its registration date,
 * then a third of each day standard rated and the rest margin scheme.
 */
import {
  dashboardHeadline,
  marginVat,
  standardRateOf,
  summariseDashboard,
  vatApplies,
  vatInside,
  type Dashboard,
  type DashboardInput,
  type DashboardLine,
  type DashboardPayment,
} from "@gg/shared"

import { addDays, eachDay, rangeLength } from "@/lib/api/dates"
import { dayStat, demoTopBranchShares, split } from "@/lib/api/demo/reports"
import { demoSettings } from "@/lib/api/demo/settings"
import { ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type { DashboardQuery } from "@/lib/api/dashboard"

const PAYMENT_LABELS: Record<string, string> = {
  card_tide: "Card",
  sumup_card: "Card (SumUp)",
  cash: "Cash",
  store_credit: "Store credit",
  mixed: "Mixed",
  points: "Points",
  none: "(none)",
}

/** The share of the shop's takings each of the ten best sellers had. */
const TOP_WEIGHTS = [18, 14, 11, 9, 8, 7, 6, 5, 4, 3]

function inputFor(from: string, to: string): DashboardInput {
  const settings = demoSettings()
  const registration = { registered: settings.vat_registered === true, from: settings.vat_registered_from }
  const rate = standardRateOf(settings.vat_standard_rate)
  const branches = demoTopBranchShares(from)
  const weights = branches.map((branch) => branch.weight)

  const lines: DashboardLine[] = []
  const payments: DashboardPayment[] = []
  let saleCount = 0
  let spend = 0
  let buyIns = 0

  for (const date of eachDay(from, to)) {
    const day = dayStat(date)
    const taken = Object.values(day.sales_total_by_payment ?? {}).reduce((sum, amount) => sum + amount, 0)
    const refunds = day.sales_refunded ?? 0
    // What the till took is after its discounts; the list price was a little more.
    const discounts = Math.round(taken * 0.04)
    const net = taken - refunds
    const cost = Math.round(net * 0.56)
    const inScope = vatApplies(registration, new Date(`${date}T12:00:00.000Z`))

    const grosses = split(taken + discounts, weights)
    const cuts = split(discounts, weights)
    const backs = split(refunds, weights)
    const costs = split(cost, weights)
    branches.forEach((branch, index) => {
      const lineNet = (grosses[index] ?? 0) - (cuts[index] ?? 0) - (backs[index] ?? 0)
      const lineCost = costs[index] ?? 0
      const standard = Math.round(lineNet / 3)
      const vat = inScope
        ? vatInside(standard, rate) + marginVat(lineNet - standard - Math.round(lineCost * 0.75), rate)
        : 0
      lines.push({
        date,
        gross: grosses[index] ?? 0,
        discount: cuts[index] ?? 0,
        refunded: backs[index] ?? 0,
        vat,
        cost: lineCost,
        // Not an item: the top items are the demo shelf's own, below.
        qty: 0,
        branch: { id: branch.id, label: branch.label },
        key: `branch:${branch.id}`,
        title: branch.label,
        sku: "",
      })
    })

    for (const [method, amount] of Object.entries(day.sales_total_by_payment ?? {})) {
      payments.push({ method, label: PAYMENT_LABELS[method] ?? method, amount })
    }
    // A refund goes back on the card reader in the demo shop.
    if (refunds) payments.push({ method: "card_tide", label: "Card", amount: -refunds })

    saleCount += day.sales_count ?? 0
    const payout = day.buy_in_total_by_payout ?? {}
    spend += (payout.cash ?? 0) + (payout.credit ?? 0) + (payout.part_exchange ?? 0)
    buyIns += day.buy_in_count ?? 0
  }

  const latest = dayStat(to)
  return {
    from,
    to,
    saleCount,
    lines,
    payments,
    buyIns: { spend, count: buyIns },
    stock: {
      cost: latest.stock_value_cost ?? 0,
      retail: Math.round((latest.stock_value_cost ?? 0) * 1.65),
      items: Math.round((latest.stock_value_cost ?? 0) / 1450),
    },
  }
}

/** The demo shelf's ten best sellers over the range, from a third of what was taken. */
function topItems(board: Dashboard): Dashboard["top_items"] {
  ensureSeeded()
  const shelf = itemStore()
    .filter((item) => (item.price ?? 0) > 0)
    .slice(0, TOP_WEIGHTS.length)
  const nets = split(Math.max(0, Math.round(board.sales.net / 3)), TOP_WEIGHTS.slice(0, shelf.length))
  return shelf
    .map((item, index) => {
      const net = nets[index] ?? 0
      return {
        title: item.title ?? item.sku,
        sku: item.sku,
        net,
        profit: Math.round(net * 0.32),
        count: Math.max(1, Math.round(net / Math.max(1, item.price ?? 1))),
      }
    })
    .filter((row) => row.net > 0)
}

export function demoDashboard(query: DashboardQuery): Dashboard {
  const board = summariseDashboard(inputFor(query.from, query.to))
  board.top_items = topItems(board)
  if (query.compare) {
    const days = rangeLength(query.from, query.to)
    const to = addDays(query.from, -1)
    const from = addDays(to, -(days - 1))
    const before = dashboardHeadline(inputFor(from, to))
    board.compare = { from, to, ...before }
  }
  return board
}
