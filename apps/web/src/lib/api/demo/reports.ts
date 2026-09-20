/**
 * The demo shop's reporting data.
 *
 * Every figure is generated from the date it belongs to, through a small
 * integer hash rather than `Math.random`, so a chart, a table, a screenshot
 * and an end-to-end assertion all see the same numbers on the same day. No
 * array of days is stored: `dayStat` answers for any date it is asked about,
 * which is what lets every preset from Today to This year show something.
 *
 * Shapes follow docs/api-contract.md, "Phase 4: stats and reports", field
 * for field, so the screens are written against the contract and not against
 * these fixtures.
 */
import {
  addDays,
  bucketLabel,
  daysBetween,
  eachDay,
  fromIsoDay,
  rangeLength,
  todayIso,
} from "@/lib/api/dates"
import type {
  DailyStatRow,
  ReportEnvelope,
  ReportGroup,
  ReportKey,
  ReportPoint,
  ReportQuery,
  ReportRow,
  SavedReportInput,
  SavedReportRecord,
  SparklineSeries,
} from "@/lib/api/types"

// ---------------------------------------------------------------------------
// A deterministic number for a given day and figure
// ---------------------------------------------------------------------------

/** FNV-1a over a string, as an unsigned 32-bit integer. */
function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/** A stable number in [0, 1) for one day and one named figure. */
function unit(iso: string, field: string): number {
  return (hash(`${iso}:${field}`) % 100_000) / 100_000
}

/** A stable integer in [min, max], both ends included. */
function pick(iso: string, field: string, min: number, max: number): number {
  return min + Math.floor(unit(iso, field) * (max - min + 1))
}

/** Monday is index 0, which is how the sales heatmap is indexed too. */
function weekdayIndex(iso: string): number {
  const day = fromIsoDay(iso).getUTCDay()
  return day === 0 ? 6 : day - 1
}

/** Saturday is the shop's busiest day, Tuesday its quietest. */
const WEEKDAY_WEIGHT = [0.82, 0.74, 0.88, 0.96, 1.18, 1.5, 1.24]

/**
 * Split a total across weights so the parts are integers that add back up to
 * exactly the total. The remainder goes on the heaviest rows first, so a
 * table never shows a rounding penny nobody can account for.
 */
export function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((carry, weight) => carry + weight, 0)
  if (sum <= 0 || total === 0) return weights.map(() => 0)
  const parts = weights.map((weight) => Math.floor((total * weight) / sum))
  let used = parts.reduce((carry, part) => carry + part, 0)
  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((a, b) => b.weight - a.weight)
  let at = 0
  while (used < total && order.length > 0) {
    const slot = order[at % order.length]
    if (slot) parts[slot.index] = (parts[slot.index] ?? 0) + 1
    used += 1
    at += 1
  }
  return parts
}

// ---------------------------------------------------------------------------
// The dimensions the demo splits its figures across
// ---------------------------------------------------------------------------

const GAMES = [
  { key: "pokemon", label: "Pokemon", weight: 44 },
  { key: "mtg", label: "Magic", weight: 20 },
  { key: "yugioh", label: "Yu-Gi-Oh!", weight: 12 },
  { key: "onepiece", label: "One Piece", weight: 8 },
  { key: "lorcana", label: "Lorcana", weight: 6 },
  { key: "retro", label: "Retro games", weight: 10 },
]

const KINDS = [
  { key: "single", label: "Singles", weight: 38 },
  { key: "sealed", label: "Sealed", weight: 32 },
  { key: "retro", label: "Retro", weight: 18 },
  { key: "graded", label: "Graded", weight: 7 },
  { key: "accessory", label: "Accessories", weight: 5 },
]

const STAFF = [
  { key: "staff_demo", label: "Demo Counter", weight: 62 },
  { key: "staff_richard", label: "Richard", weight: 38 },
]

const PAYMENTS = [
  { key: "sumup_card", label: "SumUp card", weight: 58 },
  { key: "cash", label: "Cash", weight: 24 },
  { key: "store_credit", label: "Store credit", weight: 9 },
  { key: "mixed", label: "Mixed", weight: 5 },
  { key: "points", label: "Points", weight: 2 },
  { key: "", label: "(none)", weight: 2 },
]

const SETS = [
  { key: "sv151", label: "Scarlet & Violet 151", weight: 30 },
  { key: "sv8", label: "Surging Sparks", weight: 24 },
  { key: "fdn", label: "Foundations", weight: 18 },
  { key: "op07", label: "500 Years in the Future", weight: 16 },
  { key: "ur", label: "Ursula's Return", weight: 12 },
]

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

const ZERO_DAY: Omit<DailyStatRow, "date"> = {
  sales_count: 0,
  sales_total_by_payment: {},
  buy_in_count: 0,
  buy_in_total_by_payout: { cash: 0, credit: 0 },
  items_in: 0,
  items_out: 0,
  stock_value_cost: 0,
  stock_value_market: 0,
  credit_issued: 0,
  credit_redeemed: 0,
  points_earned: 0,
  points_redeemed: 0,
  cash_variance: 0,
  new_customers: 0,
  returning_customers: 0,
}

/** One `daily_stats` row for a UTC day. Days after today hold nothing yet. */
export function dayStat(iso: string, now: Date = new Date()): DailyStatRow {
  if (iso > todayIso(now)) return { date: iso, ...ZERO_DAY }

  const weight = WEEKDAY_WEIGHT[weekdayIndex(iso)] ?? 1
  const salesTotal = Math.round(28_000 * weight * (0.72 + unit(iso, "sales") * 0.7))
  const salesCount = Math.max(3, Math.round(6 * weight + unit(iso, "count") * 14))
  const payments = split(
    salesTotal,
    PAYMENTS.map((entry) => entry.weight * (0.6 + unit(iso, `pay-${entry.key}`) * 0.8))
  )
  const buyInCount = pick(iso, "buyins", 0, 5)
  const buyInTotal = buyInCount === 0 ? 0 : Math.round(3_200 * buyInCount * (0.6 + unit(iso, "spend") * 1.1))
  const [buyInCash = 0, buyInCredit = 0] = split(buyInTotal, [
    62 + unit(iso, "cashshare") * 20,
    38,
  ])
  // Stock value drifts slowly rather than jumping about day to day: the
  // figure is a point in time, so a sawtooth would read as a bug.
  const drift = daysBetween("2026-01-01", iso)
  const stockCost = 1_820_000 + drift * 900 + Math.round(unit(iso, "stock") * 40_000)

  return {
    date: iso,
    sales_count: salesCount,
    sales_total_by_payment: Object.fromEntries(
      PAYMENTS.map((entry, index) => [entry.key || "none", payments[index] ?? 0])
    ),
    buy_in_count: buyInCount,
    buy_in_total_by_payout: { cash: buyInCash, credit: buyInCredit },
    items_in: pick(iso, "itemsin", 0, 26),
    items_out: Math.max(1, Math.round(salesCount * (1.1 + unit(iso, "itemsout") * 0.9))),
    stock_value_cost: stockCost,
    stock_value_market: Math.round(stockCost * (1.32 + unit(iso, "market") * 0.06)),
    credit_issued: buyInCredit,
    credit_redeemed: Math.round((payments[2] ?? 0) * 0.92),
    points_earned: Math.round(salesTotal / 10),
    points_redeemed: pick(iso, "pointsout", 0, 900),
    cash_variance: pick(iso, "variance", -220, 180),
    new_customers: pick(iso, "new", 0, 4),
    returning_customers: pick(iso, "returning", 1, 9),
  }
}

/** Every day in a range, oldest first. */
function daysIn(from: string, to: string, now?: Date): DailyStatRow[] {
  return eachDay(from, to).map((iso) => dayStat(iso, now))
}

function salesTotalOf(row: DailyStatRow): number {
  return Object.values(row.sales_total_by_payment ?? {}).reduce(
    (carry, amount) => carry + amount,
    0
  )
}

function buyInTotalOf(row: DailyStatRow): number {
  const payout = row.buy_in_total_by_payout ?? {}
  return (payout.cash ?? 0) + (payout.credit ?? 0)
}

function sum(values: number[]): number {
  return values.reduce((carry, value) => carry + value, 0)
}

/** Bucket a range's days by the group the report asked for. */
function buckets(
  rows: DailyStatRow[],
  group: ReportGroup
): { label: string; rows: DailyStatRow[] }[] {
  const order: string[] = []
  const byLabel = new Map<string, DailyStatRow[]>()
  for (const row of rows) {
    const label = bucketLabel(row.date, group)
    if (!byLabel.has(label)) {
      byLabel.set(label, [])
      order.push(label)
    }
    byLabel.get(label)?.push(row)
  }
  return order.map((label) => ({ label, rows: byLabel.get(label) ?? [] }))
}

function series(
  rows: DailyStatRow[],
  group: ReportGroup,
  values: (days: DailyStatRow[]) => Record<string, number>
): ReportPoint[] {
  return buckets(rows, group).map((bucket) => ({
    label: bucket.label,
    values: values(bucket.rows),
  }))
}

// ---------------------------------------------------------------------------
// Dimension tables
// ---------------------------------------------------------------------------

type Dimension = { key: string; label: string; weight: number }

function dimensionFor(key: ReportKey, by: string): Dimension[] {
  if (by === "kind") return KINDS
  if (by === "staff") return STAFF
  if (by === "payment") return PAYMENTS
  if (by === "set") return SETS
  void key
  return GAMES
}

/** The seed a dimension row's own jitter comes from, stable for a range. */
function skew(from: string, dimension: Dimension[], field: string): number[] {
  return dimension.map((entry) => entry.weight * (0.7 + unit(from, `${field}-${entry.key}`) * 0.6))
}

// ---------------------------------------------------------------------------
// The nine reports
// ---------------------------------------------------------------------------

function salesReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const revenue = sum(rows.map(salesTotalOf))
  const count = sum(rows.map((row) => row.sales_count ?? 0))
  const dimension = dimensionFor("sales", query.by)
  const weights = skew(query.from, dimension, "sales")
  const revenues = split(revenue, weights)
  const counts = split(count, weights)

  // Seven rows of twenty-four, Monday first, hours in UTC.
  const heatmap = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      if (hour < 9 || hour > 17) return 0
      const busy = WEEKDAY_WEIGHT[day] ?? 1
      return Math.round(busy * (1 + unit(`${query.from}-${day}`, `hour-${hour}`) * 5))
    })
  )

  return {
    series: series(rows, query.group, (days) => {
      const bucketRevenue = sum(days.map(salesTotalOf))
      const bucketCount = sum(days.map((row) => row.sales_count ?? 0))
      return {
        revenue: bucketRevenue,
        count: bucketCount,
        avg_basket: bucketCount === 0 ? 0 : Math.round(bucketRevenue / bucketCount),
      }
    }),
    table: dimension.map((entry, index) => ({
      key: entry.key,
      label: entry.label,
      revenue: revenues[index] ?? 0,
      count: counts[index] ?? 0,
    })),
    totals: {
      revenue,
      count,
      avg_basket: count === 0 ? 0 : Math.round(revenue / count),
      heatmap,
    },
  }
}

function buyinsReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const spend = sum(rows.map(buyInTotalOf))
  const count = sum(rows.map((row) => row.buy_in_count ?? 0))
  const cash = sum(rows.map((row) => row.buy_in_total_by_payout?.cash ?? 0))
  const credit = sum(rows.map((row) => row.buy_in_total_by_payout?.credit ?? 0))
  const dimension = dimensionFor("buyins", query.by === "staff" ? "staff" : "game")
  const weights = skew(query.from, dimension, "buyins")
  const spends = split(spend, weights)
  const counts = split(count, weights)
  const itemsBought = sum(rows.map((row) => row.items_in ?? 0))
  const itemsSold = sum(rows.map((row) => row.items_out ?? 0))

  const sellers = [
    { customer: "cust_demo_2", name: "Brock Harrison", weight: 34 },
    { customer: "cust_demo_1", name: "Ash Ketchum", weight: 26 },
    { customer: "cust_demo_3", name: "Misty Waterflower", weight: 22 },
    { customer: "cust_demo_4", name: "Gary Oaks", weight: 18 },
  ]
  const sellerSpend = split(spend, sellers.map((entry) => entry.weight))
  const sellerCounts = split(count, sellers.map((entry) => entry.weight))

  return {
    series: series(rows, query.group, (days) => ({
      spend: sum(days.map(buyInTotalOf)),
      count: sum(days.map((row) => row.buy_in_count ?? 0)),
    })),
    table: dimension.map((entry, index) => ({
      key: entry.key,
      label: entry.label,
      spend: spends[index] ?? 0,
      count: counts[index] ?? 0,
      avg_offer_pct:
        query.by === "staff"
          ? 0
          : Math.round((48 + unit(query.from, `offer-${entry.key}`) * 18) * 10) / 10,
    })),
    totals: {
      spend,
      count,
      avg_offer_pct: Math.round((52 + unit(query.from, "offerpct") * 10) * 10) / 10,
      cash,
      credit,
      items_bought: itemsBought,
      items_sold: itemsSold,
      sell_through_ratio:
        itemsBought === 0 ? 0 : Math.round((itemsSold / itemsBought) * 100) / 100,
      top_sellers: sellers.map((entry, index) => ({
        customer: entry.customer,
        name: entry.name,
        count: sellerCounts[index] ?? 0,
        spend: sellerSpend[index] ?? 0,
      })),
    },
  }
}

function marginReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const revenue = sum(rows.map(salesTotalOf))
  const cost = Math.round(revenue * 0.56)
  const margin = revenue - cost
  const dimension = dimensionFor("margin", query.by)
  const weights = skew(query.from, dimension, "margin")
  const revenues = split(revenue, weights)
  const costs = revenues.map((amount, index) =>
    Math.round(amount * (0.48 + unit(query.from, `cost-${dimension[index]?.key ?? index}`) * 0.2))
  )

  return {
    series: series(rows, query.group, (days) => {
      const bucketRevenue = sum(days.map(salesTotalOf))
      const bucketCost = Math.round(bucketRevenue * 0.56)
      return { revenue: bucketRevenue, cost: bucketCost, margin: bucketRevenue - bucketCost }
    }),
    table: dimension.map((entry, index) => {
      const rowRevenue = revenues[index] ?? 0
      const rowCost = costs[index] ?? 0
      return {
        key: entry.key,
        label: entry.label,
        revenue: rowRevenue,
        cost: rowCost,
        margin: rowRevenue - rowCost,
        margin_pct:
          rowRevenue === 0
            ? 0
            : Math.round(((rowRevenue - rowCost) / rowRevenue) * 1000) / 10,
      }
    }),
    totals: {
      revenue,
      cost,
      margin,
      margin_pct: revenue === 0 ? 0 : Math.round((margin / revenue) * 1000) / 10,
      // The demo shop is not VAT registered, exactly like the seeded
      // settings record, so the margin scheme estimate is zero and the
      // screen says why rather than inventing a figure.
      vat_estimate: 0,
      markdown_count: pick(query.from, "markdowns", 6, 24),
      markdown_value: Math.round(margin * 0.06),
    },
  }
}

function stockReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const latest = rows[rows.length - 1] ?? dayStat(query.to)
  const valueCost = latest.stock_value_cost ?? 0
  const valueMarket = latest.stock_value_market ?? 0
  const movers = [
    { item_id: "item_demo_1", sku: "GGS-7F3K2Q", title: "Charizard ex 199/165", at: 24_000 },
    { item_id: "item_demo_2", sku: "GGP-5N2W8K", title: "Surging Sparks Elite Trainer Box", at: 4_500 },
    { item_id: "item_demo_3", sku: "GGS-W8Q4RJ", title: "Llanowar Elves, foil", at: 240 },
    { item_id: "item_demo_4", sku: "GGR-2K9T4M", title: "Super Mario World, boxed", at: 3_800 },
    { item_id: "item_demo_5", sku: "GGS-B4H7NX", title: "Blue-Eyes White Dragon LOB-001", at: 12_500 },
  ].map((entry) => {
    const change = Math.round((unit(query.from, `mover-${entry.sku}`) * 90 - 35) * 10) / 10
    const pct = Math.abs(change) < 15.1 ? change + (change < 0 ? -15.4 : 15.4) : change
    return {
      item_id: entry.item_id,
      sku: entry.sku,
      title: entry.title,
      market_at_intake: entry.at,
      latest_market: Math.round(entry.at * (1 + pct / 100)),
      pct_change: Math.round(pct * 10) / 10,
    }
  })

  const ageing = [
    { bucket: "0-30", min: 0, max: 30, weight: 38 },
    { bucket: "31-90", min: 31, max: 90, weight: 31 },
    { bucket: "91-180", min: 91, max: 180, weight: 19 },
    { bucket: "180+", min: 181, max: null, weight: 12 },
  ]
  const ageingCost = split(valueCost, ageing.map((entry) => entry.weight))
  const ageingMarket = split(valueMarket, ageing.map((entry) => entry.weight))
  const ageingCounts = split(1_240, ageing.map((entry) => entry.weight))

  const sellDimension = dimensionFor("stock", query.by === "set" ? "set" : "game")
  const acquired = split(860, skew(query.from, sellDimension, "acq"))
  const sold = acquired.map((value, index) =>
    Math.round(value * (0.3 + unit(query.from, `sold-${sellDimension[index]?.key ?? index}`) * 0.45))
  )

  const dead = [
    { item_id: "item_demo_9", sku: "GGR-6P3L2Q", title: "Actua Soccer, loose", days: 412, cost: 300 },
    { item_id: "item_demo_10", sku: "GGS-T4K8WN", title: "Bulbasaur 001/165", days: 264, cost: 120 },
    { item_id: "item_demo_11", sku: "GGA-9M2X7B", title: "Dragon Shield sleeves, matte", days: 203, cost: 650 },
  ].map((entry) => ({
    item_id: entry.item_id,
    sku: entry.sku,
    title: entry.title,
    days_held: entry.days,
    cost: entry.cost,
    market: Math.round(entry.cost * 1.4),
  }))

  return {
    series: series(rows, query.group, (days) => {
      const last = days[days.length - 1]
      return {
        value_cost: last?.stock_value_cost ?? 0,
        value_market: last?.stock_value_market ?? 0,
      }
    }),
    table: movers.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change)),
    totals: {
      value_cost: valueCost,
      value_market: valueMarket,
      unrealised_gain: valueMarket - valueCost,
      ageing_buckets: ageing.map((entry, index) => ({
        bucket: entry.bucket,
        min: entry.min,
        max: entry.max,
        count: ageingCounts[index] ?? 0,
        value_cost: ageingCost[index] ?? 0,
        value_market: ageingMarket[index] ?? 0,
      })),
      sell_through: sellDimension.map((entry, index) => ({
        key: entry.key,
        label: entry.label,
        acquired: acquired[index] ?? 0,
        sold: sold[index] ?? 0,
        rate:
          (acquired[index] ?? 0) === 0
            ? 0
            : Math.round(((sold[index] ?? 0) / (acquired[index] ?? 1)) * 100) / 100,
      })),
      dead_stock: dead,
      price_movers_count: movers.length,
    },
  }
}

function channelsReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const revenue = sum(rows.map(salesTotalOf))
  const count = sum(rows.map((row) => row.sales_count ?? 0))
  const channels = [
    { key: "counter", label: "In store", weight: 78 },
    { key: "ebay", label: "eBay", weight: 22 },
  ]
  const revenues = split(revenue, skew(query.from, channels, "channel"))
  const counts = split(count, channels.map((entry) => entry.weight))
  const table = channels.map((entry, index) => ({
    key: entry.key,
    label: entry.label,
    revenue: revenues[index] ?? 0,
    count: counts[index] ?? 0,
  }))

  return {
    series: series(rows, query.group, (days) => {
      const bucketRevenue = sum(days.map(salesTotalOf))
      const ebay = Math.round(bucketRevenue * 0.22)
      return { counter: bucketRevenue - ebay, ebay }
    }),
    table,
    totals: {
      revenue,
      count,
      by_channel: table,
      listing_ages: [
        { item_id: "item_demo_12", sku: "GGS-3R7K2V", title: "Pikachu VMAX 044/185", days_listed: 58 },
        { item_id: "item_demo_13", sku: "GGS-8W2M4P", title: "Rayquaza VMAX 218/203", days_listed: 34 },
        { item_id: "item_demo_14", sku: "GGS-Q5N9T7", title: "Mox Diamond, Stronghold", days_listed: 12 },
      ],
      items_ended: pick(query.from, "ended", 2, 18),
    },
  }
}

function customersReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const fresh = sum(rows.map((row) => row.new_customers ?? 0))
  const returning = sum(rows.map((row) => row.returning_customers ?? 0))
  const revenue = sum(rows.map(salesTotalOf))
  const people = [
    { customer: "cust_demo_1", name: "Ash Ketchum", weight: 32 },
    { customer: "cust_demo_2", name: "Brock Harrison", weight: 26 },
    { customer: "cust_demo_3", name: "Misty Waterflower", weight: 24 },
    { customer: "cust_demo_4", name: "Gary Oaks", weight: 18 },
  ]
  const spends = split(Math.round(revenue * 0.42), skew(query.from, people, "spender"))
  const trades = split(
    Math.round(sum(rows.map(buyInTotalOf)) * 0.6),
    people.map((entry) => entry.weight)
  )

  return {
    series: series(rows, query.group, (days) => ({
      new: sum(days.map((row) => row.new_customers ?? 0)),
      returning: sum(days.map((row) => row.returning_customers ?? 0)),
    })),
    table: people.map((entry, index) => ({
      customer: entry.customer,
      label: entry.name,
      amount: spends[index] ?? 0,
    })),
    totals: {
      new: fresh,
      returning,
      top_by_spend: people.map((entry, index) => ({
        customer: entry.customer,
        name: entry.name,
        amount: spends[index] ?? 0,
      })),
      top_by_trade_in: people.map((entry, index) => ({
        customer: entry.customer,
        name: entry.name,
        amount: trades[index] ?? 0,
      })),
      credit_liability: 41_250 + Math.round(unit(query.to, "liability") * 12_000),
      want_list_demand: [
        { key: "card_sv151_199", card_id: "card_sv151_199", label: "Charizard ex 199/165", count: 6, in_stock: true },
        { key: "card_fdn_179", card_id: "card_fdn_179", label: "Llanowar Elves, foil", count: 4, in_stock: false },
        { key: "text:moonbreon", card_id: "", label: "Umbreon VMAX alt art", count: 3, in_stock: false },
      ],
    },
  }
}

function loyaltyReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const earned = sum(rows.map((row) => row.points_earned ?? 0))
  const redeemed = sum(rows.map((row) => row.points_redeemed ?? 0))
  const revenue = sum(rows.map(salesTotalOf))
  const tiers = [
    { tier: "tier_member", label: "Member", weight: 62 },
    { tier: "tier_regular", label: "Regular", weight: 28 },
    { tier: "tier_legend", label: "Legend", weight: 8 },
    { tier: "", label: "No tier", weight: 2 },
  ]
  const counts = split(184, tiers.map((entry) => entry.weight))
  const table = tiers.map((entry, index) => ({
    tier: entry.tier,
    label: entry.label,
    count: counts[index] ?? 0,
  }))

  return {
    series: series(rows, query.group, (days) => ({
      points_earned: sum(days.map((row) => row.points_earned ?? 0)),
      points_redeemed: sum(days.map((row) => row.points_redeemed ?? 0)),
    })),
    table,
    totals: {
      points_earned: earned,
      points_redeemed: redeemed,
      tier_distribution: table,
      perk_usage: [
        { perk_type: "percent_off", used_count: pick(query.from, "perk1", 4, 40) },
        { perk_type: "points_multiplier", used_count: pick(query.from, "perk2", 2, 28) },
        { perk_type: "free_event_entries", used_count: pick(query.from, "perk3", 0, 9) },
      ],
      reward_take_up: [
        {
          reward: "reward_five_off",
          label: "£5 off a single",
          count: pick(query.from, "reward1", 1, 12),
          points_spent: 500 * pick(query.from, "reward1", 1, 12),
        },
        {
          reward: "reward_sleeve_pack",
          label: "Sleeve pack",
          count: pick(query.from, "reward2", 0, 6),
          points_spent: 800 * pick(query.from, "reward2", 0, 6),
        },
      ],
      referrals: { total: pick(query.from, "ref", 0, 9), earned: pick(query.from, "refearn", 0, 6) },
      programme_cost_pct:
        revenue === 0 ? 0 : Math.round(((redeemed / 100) * 100 * 100) / revenue) / 100,
    },
  }
}

function cashReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const closed = rows.filter((row) => (row.cash_variance ?? 0) !== 0 || weekdayIndex(row.date) < 6)
  const sessions = closed.map((row) => {
    const expected = 10_000 + salesTotalOf(row) - (row.buy_in_total_by_payout?.cash ?? 0)
    const variance = row.cash_variance ?? 0
    return {
      session_id: `cash_session_${row.date}`,
      opened_at: `${row.date}T08:45:00Z`,
      closed_at: `${row.date}T17:30:00Z`,
      expected,
      counted: expected + variance,
      variance,
    }
  })
  const byDay = rows.map((row) => ({
    date: row.date,
    in: Math.round(salesTotalOf(row) * 0.26),
    out: row.buy_in_total_by_payout?.cash ?? 0,
  }))

  return {
    series: series(rows, query.group, (days) => ({
      variance: sum(days.map((row) => row.cash_variance ?? 0)),
    })),
    table: sessions,
    totals: {
      variance_total: sum(sessions.map((row) => row.variance)),
      session_count: sessions.length,
      cash_in: sum(byDay.map((row) => row.in)),
      cash_out: sum(byDay.map((row) => row.out)),
      by_day: byDay,
    },
  }
}

function complianceReport(query: Required<ReportQuery>, rows: DailyStatRow[]): Partial<ReportEnvelope> {
  const sellers = [
    { name: "Brock Harrison", address: "14 Castle Street, Bolsover, S44 6PP", id: "driving_licence" },
    { name: "Misty Waterflower", address: "2 Cavendish Road, Chesterfield, S41 7AA", id: "passport" },
    { name: "Gary Oaks", address: "9 Oxcroft Lane, Bolsover, S44 6DG", id: "passport" },
  ]
  let number = 120
  const table: ReportRow[] = []
  for (const row of rows) {
    const count = row.buy_in_count ?? 0
    for (let index = 0; index < count; index += 1) {
      const seller = sellers[(number + index) % sellers.length]
      if (!seller) continue
      number += 1
      table.push({
        id: `trade_${row.date}_${index}`,
        number: `GG-BI-${String(number).padStart(6, "0")}`,
        completed_at: `${row.date}T14:12:00Z`,
        seller_name: seller.name,
        seller_address: seller.address,
        id_type: seller.id,
        items: pick(`${row.date}-${index}`, "items", 1, 12),
        total_offer: Math.round(buyInTotalOf(row) / Math.max(1, count)),
      })
    }
  }

  return {
    series: series(rows, query.group, (days) => ({
      count: sum(days.map((row) => row.buy_in_count ?? 0)),
    })),
    table,
    totals: {
      count: table.length,
      stock_book_url: `/api/vault/exports/stock-book?from=${query.from}&to=${query.to}`,
    },
  }
}

const BUILDERS: Record<
  ReportKey,
  (query: Required<ReportQuery>, rows: DailyStatRow[]) => Partial<ReportEnvelope>
> = {
  sales: salesReport,
  buyins: buyinsReport,
  margin: marginReport,
  stock: stockReport,
  channels: channelsReport,
  customers: customersReport,
  loyalty: loyaltyReport,
  cash: cashReport,
  compliance: complianceReport,
}

/** The period of the same length immediately before this one. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const length = rangeLength(from, to)
  return { from: addDays(from, -length), to: addDays(from, -1) }
}

/** One report, the same envelope the route answers with. */
export function demoReport(key: ReportKey, query: ReportQuery, now?: Date): ReportEnvelope {
  const filled: Required<ReportQuery> = {
    from: query.from,
    to: query.to,
    group: query.group ?? "day",
    by: query.by ?? "",
    compare: query.compare ?? "none",
  }
  const built = BUILDERS[key](filled, daysIn(filled.from, filled.to, now))

  let compare: ReportEnvelope["compare"] = null
  if (filled.compare === "previous") {
    const range = previousRange(filled.from, filled.to)
    const before = BUILDERS[key](
      { ...filled, ...range, compare: "none" },
      daysIn(range.from, range.to, now)
    )
    compare = { totals: before.totals ?? {}, from: range.from, to: range.to }
  }

  return {
    key,
    from: filled.from,
    to: filled.to,
    group: filled.group,
    series: built.series ?? [],
    table: built.table ?? [],
    totals: built.totals ?? {},
    compare,
  }
}

/** The `daily_stats` rows a range covers, as the collection would serve them. */
export function demoDailyStats(from: string, to: string, now?: Date): DailyStatRow[] {
  return daysIn(from, to, now).map((row) => ({ ...row, id: `daily_${row.date}` }))
}

/** The four Home tiles over the last `days` UTC days, oldest first. */
export function demoSparklines(days: number, now: Date = new Date()): SparklineSeries {
  const to = todayIso(now)
  const from = addDays(to, -(days - 1))
  const rows = daysIn(from, to, now)
  return {
    dates: rows.map((row) => row.date),
    sales: rows.map(salesTotalOf),
    buyIns: rows.map(buyInTotalOf),
    cashOut: rows.map((row) => row.buy_in_total_by_payout?.cash ?? 0),
    creditIssued: rows.map((row) => row.credit_issued ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Saved views, in memory for the tab like every other demo store
// ---------------------------------------------------------------------------

const saved: SavedReportRecord[] = [
  {
    id: "saved_demo_1",
    owner: "staff_demo",
    report_key: "sales",
    name: "Sales by game, weekly",
    filters: { by: "game", group: "week" },
    schedule: "weekly",
    recipients: ["richard@ggentertainment.co.uk"],
    created: "2026-08-03T08:00:00Z",
  },
  {
    id: "saved_demo_2",
    owner: "staff_demo",
    report_key: "margin",
    name: "Margin by kind",
    filters: { by: "kind", group: "month" },
    schedule: "none",
    recipients: [],
    created: "2026-08-19T08:00:00Z",
  },
]

let savedSequence = 2

export function demoSavedReports(key?: ReportKey): SavedReportRecord[] {
  return key ? saved.filter((row) => row.report_key === key) : [...saved]
}

export function demoSaveReport(input: SavedReportInput): SavedReportRecord {
  const existing = input.id ? saved.find((row) => row.id === input.id) : undefined
  if (existing) {
    existing.name = input.name
    existing.filters = input.filters
    existing.schedule = input.schedule
    existing.recipients = input.recipients
    return existing
  }
  savedSequence += 1
  const record: SavedReportRecord = {
    id: `saved_demo_${savedSequence}`,
    owner: "staff_demo",
    report_key: input.report_key,
    name: input.name,
    filters: input.filters,
    schedule: input.schedule,
    recipients: input.recipients,
    created: new Date().toISOString(),
  }
  saved.push(record)
  return record
}

export function demoDeleteReport(id: string): void {
  const at = saved.findIndex((row) => row.id === id)
  if (at >= 0) saved.splice(at, 1)
}
