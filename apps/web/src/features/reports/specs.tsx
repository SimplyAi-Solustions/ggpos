/**
 * What each of the nine reports shows: its figures, its chart, its table and
 * the smaller lists under it.
 *
 * One spec per key, in the column names `docs/api-contract.md` gives for that
 * key and no others. The screen, the CSV export and the small-screen summary
 * all read the same spec, so a column can never mean one thing on a table and
 * another in a downloaded file.
 */
import { Link } from "@tanstack/react-router"
import { displayCode, encodeCode, formatGBP } from "@gg/shared"

import { poundsCell } from "@/features/reports/csv"
import type { ReportKey, ReportRow } from "@/lib/api/types"
import { formatDay } from "@/features/reports/range"
import type { ChartTone } from "@/features/reports/charts"

// ---------------------------------------------------------------------------
// Reading a row
// ---------------------------------------------------------------------------

export function num(row: ReportRow, key: string): number {
  const value = row[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function str(row: ReportRow, key: string): string {
  const value = row[key]
  return value === null || value === undefined ? "" : String(value)
}

export type Figure = "money" | "count" | "percent" | "ratio" | "points"

/** On screen. Money always goes through `formatGBP`, never `toLocaleString`. */
export function figureText(value: number, figure: Figure): string {
  if (figure === "money") return formatGBP(value)
  if (figure === "percent") return `${value}%`
  if (figure === "ratio") return String(value)
  return value.toLocaleString("en-GB")
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface ColumnSpec {
  key: string
  label: string
  numeric?: boolean
  /** What the cell draws. Defaults to `text`. */
  cell?: (row: ReportRow) => React.ReactNode
  /** The plain string: the CSV cell and the small-screen summary read this. */
  text: (row: ReportRow) => string
  /** What a CSV cell holds, when it is not the same as `text` (money). */
  csv?: (row: ReportRow) => string | number
  sortValue?: (row: ReportRow) => number | string
  /** Where the column lands in the summary a phone shows instead of a table. */
  summary?: "title" | "detail" | "figure"
}

export function textColumn(
  key: string,
  label: string,
  summary?: ColumnSpec["summary"]
): ColumnSpec {
  return {
    key,
    label,
    text: (row) => str(row, key),
    sortValue: (row) => str(row, key).toLowerCase(),
    summary,
  }
}

export function moneyColumn(
  key: string,
  label: string,
  summary?: ColumnSpec["summary"]
): ColumnSpec {
  return {
    key,
    label,
    numeric: true,
    text: (row) => formatGBP(num(row, key)),
    // Pounds and pence from integer pence, with no symbol, and never a
    // float: 500 / 100 is 5 and writes "5", not "5.00". The shared writer
    // is the same one the server's own exports go through.
    csv: (row) => poundsCell(num(row, key)),
    sortValue: (row) => num(row, key),
    summary,
  }
}

export function countColumn(
  key: string,
  label: string,
  summary?: ColumnSpec["summary"]
): ColumnSpec {
  return {
    key,
    label,
    numeric: true,
    text: (row) => num(row, key).toLocaleString("en-GB"),
    csv: (row) => num(row, key),
    sortValue: (row) => num(row, key),
    summary,
  }
}

export function percentColumn(
  key: string,
  label: string,
  summary?: ColumnSpec["summary"]
): ColumnSpec {
  return {
    key,
    label,
    numeric: true,
    // The routes round a percentage to one place already, so this prints it.
    text: (row) => `${num(row, key)}%`,
    csv: (row) => num(row, key),
    sortValue: (row) => num(row, key),
    summary,
  }
}

/** A column whose stored value is an enum, shown in the words staff use. */
function mappedColumn(
  key: string,
  label: string,
  words: Record<string, string>,
  summary?: ColumnSpec["summary"]
): ColumnSpec {
  const say = (row: ReportRow) => {
    const raw = str(row, key)
    return words[raw] ?? raw
  }
  return { key, label, text: say, sortValue: (row) => say(row).toLowerCase(), summary }
}

const ID_TYPES: Record<string, string> = {
  passport: "Passport",
  driving_licence: "Driving licence",
  other: "Other",
}

const AGEING_BUCKETS: Record<string, string> = {
  "0-30": "0 to 30",
  "31-90": "31 to 90",
  "91-180": "91 to 180",
  "180+": "Over 180",
  unknown: "Date not known",
}

const PERK_TYPES: Record<string, string> = {
  percent_off: "Percent off",
  points_multiplier: "Points multiplier",
  free_event_entries: "Free event entries",
  free_sleeve: "Free sleeve",
}

function dateColumn(key: string, label: string, summary?: ColumnSpec["summary"]): ColumnSpec {
  return {
    key,
    label,
    text: (row) => {
      const raw = str(row, key)
      return raw ? formatDay(raw.slice(0, 10)) : ""
    },
    sortValue: (row) => str(row, key),
    summary,
  }
}

/** A SKU cell that opens the item, so a price mover is one tap from a reprice. */
function skuColumn(label = "SKU"): ColumnSpec {
  return {
    key: "sku",
    label,
    text: (row) => displayCode(str(row, "sku")),
    sortValue: (row) => str(row, "sku"),
    summary: "detail",
    cell: (row) => {
      const raw = str(row, "sku")
      if (!raw) return null
      return (
        <Link
          to="/counter/stock/$sku"
          params={{ sku: encodeCode(raw) }}
          className="tnum font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {displayCode(raw)}
        </Link>
      )
    },
  }
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export interface KpiSpec {
  key: string
  label: string
  figure: Figure
  /** The one Anton figure on the page's KPI row. */
  headline?: boolean
  /** A sentence under the figure when it needs one. */
  note?: string
}

export interface ChartSpec {
  kind: "bar" | "line"
  series: { key: string; label: string; tone: ChartTone }[]
  money: boolean
  /** Which series the hidden summary quotes as the headline. */
  summaryKey: string
}

/** A small list under the main table, built from one key of `totals`. */
export interface PanelSpec {
  totalsKey: string
  heading: string
  empty: string
  columns: ColumnSpec[]
  /** When the rows are items, the frame their thumbnail is drawn in. */
  imagePlatform?: string
}

export interface ReportSpec {
  key: ReportKey
  title: string
  lede: string
  admin?: boolean
  /**
   * False where nothing on the report means anything over a past period.
   * Stock is read as it stands now, so the route sends no comparable totals
   * for it and the screen offers no comparison to turn on.
   */
  comparable?: boolean
  /** The `by` dimensions this report takes; the first is the route's default. */
  dimensions: { key: string; label: string }[]
  kpis: KpiSpec[]
  chart: ChartSpec | null
  tableHeading: string
  columns: ColumnSpec[]
  panels: PanelSpec[]
  /** Said in place of a blank chart and an empty table. */
  emptyLine: string
  /** A caveat printed under the table, where a figure is a proxy. */
  note?: string
}

const INK: ChartTone = 1
const GREY: ChartTone = 3
const VOLT: ChartTone = 5

export const REPORT_SPECS: Record<ReportKey, ReportSpec> = {
  sales: {
    key: "sales",
    title: "Sales",
    lede: "What the shop took, by period and by what was sold.",
    dimensions: [
      { key: "game", label: "Game" },
      { key: "kind", label: "Kind" },
      { key: "staff", label: "Staff" },
      { key: "payment", label: "Payment" },
    ],
    kpis: [
      { key: "revenue", label: "Revenue", figure: "money", headline: true },
      { key: "count", label: "Sales", figure: "count" },
      { key: "avg_basket", label: "Average basket", figure: "money" },
    ],
    chart: {
      kind: "bar",
      money: true,
      summaryKey: "revenue",
      series: [{ key: "revenue", label: "Revenue", tone: INK }],
    },
    tableHeading: "Breakdown",
    columns: [
      textColumn("label", "Name", "title"),
      moneyColumn("revenue", "Revenue", "figure"),
      countColumn("count", "Sales", "detail"),
    ],
    panels: [],
    emptyLine: "No sales {when}. Widen the range.",
    note: "Revenue is net of every refund on file. A payment breakdown is the gross split, since a refund is not paid back through the method it came in on.",
  },

  buyins: {
    key: "buyins",
    title: "Buy-ins",
    lede: "What the shop paid for stock, and how it paid for it.",
    dimensions: [
      { key: "game", label: "Game" },
      { key: "staff", label: "Staff" },
    ],
    kpis: [
      { key: "spend", label: "Spend", figure: "money", headline: true },
      { key: "count", label: "Buy-ins", figure: "count" },
      { key: "cash", label: "Paid in cash", figure: "money" },
      { key: "credit", label: "Paid in credit", figure: "money" },
      { key: "avg_offer_pct", label: "Average offer", figure: "percent" },
      { key: "sell_through_ratio", label: "Sold per bought", figure: "ratio" },
    ],
    chart: {
      kind: "bar",
      money: true,
      summaryKey: "spend",
      series: [{ key: "spend", label: "Spend", tone: INK }],
    },
    tableHeading: "Breakdown",
    columns: [
      textColumn("label", "Name", "title"),
      moneyColumn("spend", "Spend", "figure"),
      countColumn("count", "Lines", "detail"),
      percentColumn("avg_offer_pct", "Offer"),
    ],
    panels: [
      {
        totalsKey: "top_sellers",
        heading: "Who sold to us most",
        empty: "Nobody sold to the shop in this range.",
        columns: [
          textColumn("name", "Seller", "title"),
          countColumn("count", "Buy-ins", "detail"),
          moneyColumn("spend", "Paid", "figure"),
        ],
      },
    ],
    emptyLine: "No buy-ins {when}. Widen the range.",
    note: "Average offer is the offer as a percent of market, over every accepted line priced against a market value. It reads zero on a staff breakdown, where offer percent is not a line-level figure.",
  },

  margin: {
    key: "margin",
    title: "Margin",
    lede: "What was made on what sold, before overheads.",
    dimensions: [
      { key: "game", label: "Game" },
      { key: "kind", label: "Kind" },
      { key: "staff", label: "Staff" },
    ],
    kpis: [
      { key: "margin", label: "Margin", figure: "money", headline: true },
      { key: "revenue", label: "Revenue", figure: "money" },
      { key: "cost", label: "Cost", figure: "money" },
      { key: "margin_pct", label: "Margin percent", figure: "percent" },
      { key: "vat_estimate", label: "Margin scheme VAT", figure: "money" },
      { key: "markdown_value", label: "Marked down", figure: "money" },
    ],
    chart: {
      kind: "line",
      money: true,
      summaryKey: "margin",
      series: [
        { key: "revenue", label: "Revenue", tone: INK },
        { key: "cost", label: "Cost", tone: GREY },
        { key: "margin", label: "Margin", tone: VOLT },
      ],
    },
    tableHeading: "Breakdown",
    columns: [
      textColumn("label", "Name", "title"),
      moneyColumn("revenue", "Revenue"),
      moneyColumn("cost", "Cost", "detail"),
      moneyColumn("margin", "Margin", "figure"),
      percentColumn("margin_pct", "Percent"),
    ],
    panels: [],
    emptyLine: "Nothing sold {when}, so there is no margin to show.",
    note: "The VAT figure is a margin scheme estimate, one sixth of the positive margin on margin scheme lines, and reads zero while the shop is not VAT registered. Marked down counts stock priced under its value at intake, which is a proxy for a markdown rather than a log of every price change.",
  },

  stock: {
    key: "stock",
    title: "Stock",
    lede: "What the shop holds, what it cost and how long it has sat.",
    comparable: false,
    dimensions: [
      { key: "game", label: "Game" },
      { key: "set", label: "Set" },
    ],
    kpis: [
      { key: "value_market", label: "Value at market", figure: "money", headline: true },
      { key: "value_cost", label: "Value at cost", figure: "money" },
      { key: "unrealised_gain", label: "Unrealised gain", figure: "money" },
      { key: "price_movers_count", label: "Price movers", figure: "count" },
    ],
    chart: null,
    tableHeading: "Price movers",
    columns: [
      skuColumn(),
      textColumn("title", "Item", "title"),
      moneyColumn("market_at_intake", "At intake"),
      moneyColumn("latest_market", "Now", "figure"),
      percentColumn("pct_change", "Change", "detail"),
    ],
    panels: [
      {
        totalsKey: "ageing_buckets",
        heading: "How long it is held",
        empty: "Nothing is in stock.",
        columns: [
          mappedColumn("bucket", "Days held", AGEING_BUCKETS, "title"),
          countColumn("count", "Items", "detail"),
          moneyColumn("value_cost", "At cost"),
          moneyColumn("value_market", "At market", "figure"),
        ],
      },
      {
        totalsKey: "sell_through",
        heading: "Sell-through",
        empty: "Nothing has been taken in yet.",
        columns: [
          textColumn("label", "Name", "title"),
          countColumn("acquired", "Taken in", "detail"),
          countColumn("sold", "Sold"),
          { ...percentColumn("rate", "Rate", "figure"), text: (row) => String(num(row, "rate")) },
        ],
      },
      {
        totalsKey: "dead_stock",
        heading: "Held over 180 days",
        empty: "Nothing has been on the shelf over 180 days.",
        imagePlatform: "tcg_card",
        columns: [
          skuColumn(),
          textColumn("title", "Item", "title"),
          countColumn("days_held", "Days", "detail"),
          moneyColumn("cost", "Cost"),
          moneyColumn("market", "Market", "figure"),
        ],
      },
    ],
    emptyLine: "Nothing has moved more than 15 percent since it came in.",
    note: "Every figure here except sell-through is stock as it stands now, not a reconstruction of a past day. Sell-through counts stock rows rather than units, so a multi-quantity line only counts as sold once it has sold out.",
  },

  channels: {
    key: "channels",
    title: "Channels",
    lede: "In store against eBay, and how long listings have been up.",
    dimensions: [{ key: "channel", label: "Channel" }],
    kpis: [
      { key: "revenue", label: "Revenue", figure: "money", headline: true },
      { key: "count", label: "Sales", figure: "count" },
      { key: "items_ended", label: "Listings ended", figure: "count" },
    ],
    chart: null,
    tableHeading: "By channel",
    columns: [
      textColumn("label", "Channel", "title"),
      moneyColumn("revenue", "Revenue", "figure"),
      countColumn("count", "Sales", "detail"),
    ],
    panels: [
      {
        totalsKey: "listing_ages",
        heading: "Listed on eBay now",
        empty: "Nothing is listed on eBay.",
        imagePlatform: "tcg_card",
        columns: [
          skuColumn(),
          textColumn("title", "Item", "title"),
          countColumn("days_listed", "Days listed", "figure"),
        ],
      },
    ],
    emptyLine: "No sales {when}. Widen the range.",
    note: "A channel is the sale's own channel, never an item's eBay fields. Listings ended counts items that were on eBay and no longer are, which is a proxy: there is no ended status of its own.",
  },

  customers: {
    key: "customers",
    title: "Customers",
    lede: "Who came back, who spends, and what they are after.",
    dimensions: [{ key: "spend", label: "Spend" }],
    kpis: [
      { key: "returning", label: "Returning", figure: "count", headline: true },
      { key: "new", label: "New", figure: "count" },
      { key: "credit_liability", label: "Credit owed", figure: "money" },
    ],
    chart: {
      kind: "bar",
      money: false,
      summaryKey: "returning",
      series: [
        { key: "returning", label: "Returning", tone: INK },
        { key: "new", label: "New", tone: GREY },
      ],
    },
    tableHeading: "Top by spend",
    columns: [
      textColumn("label", "Customer", "title"),
      moneyColumn("amount", "Spend", "figure"),
    ],
    panels: [
      {
        totalsKey: "top_by_trade_in",
        heading: "Top by trade-in",
        empty: "Nobody sold to the shop in this range.",
        columns: [
          textColumn("name", "Customer", "title"),
          moneyColumn("amount", "Paid", "figure"),
        ],
      },
      {
        totalsKey: "want_list_demand",
        heading: "Most wanted",
        empty: "No open want lists.",
        columns: [
          textColumn("label", "Card", "title"),
          countColumn("count", "Wanted by", "figure"),
          {
            key: "in_stock",
            label: "Held",
            text: (row) => (row.in_stock === true ? "In stock" : "Not in stock"),
            sortValue: (row) => (row.in_stock === true ? 1 : 0),
            summary: "detail",
          },
        ],
      },
    ],
    emptyLine: "Nobody bought or sold {when}. Widen the range.",
    note: "Credit owed is every credit ledger row up to the end of the range, recomputed rather than read off a cached balance.",
  },

  loyalty: {
    key: "loyalty",
    title: "Loyalty",
    lede: "Points in and out, the tiers, and what the Guild costs.",
    dimensions: [{ key: "tier", label: "Tier" }],
    kpis: [
      { key: "points_earned", label: "Points issued", figure: "points", headline: true },
      { key: "points_redeemed", label: "Points redeemed", figure: "points" },
      { key: "programme_cost_pct", label: "Cost of the programme", figure: "percent" },
    ],
    chart: {
      kind: "bar",
      money: false,
      summaryKey: "points_earned",
      series: [
        { key: "points_earned", label: "Issued", tone: INK },
        { key: "points_redeemed", label: "Redeemed", tone: GREY },
      ],
    },
    tableHeading: "Tiers",
    columns: [
      textColumn("label", "Tier", "title"),
      countColumn("count", "Customers", "figure"),
    ],
    panels: [
      {
        totalsKey: "reward_take_up",
        heading: "Rewards taken",
        empty: "No rewards were redeemed in this range.",
        columns: [
          textColumn("label", "Reward", "title"),
          countColumn("count", "Redeemed", "figure"),
          countColumn("points_spent", "Points", "detail"),
        ],
      },
      {
        totalsKey: "perk_usage",
        heading: "Perks used",
        empty: "No perks were applied in this range.",
        columns: [
          mappedColumn("perk_type", "Perk", PERK_TYPES, "title"),
          countColumn("used_count", "Times used", "figure"),
        ],
      },
    ],
    emptyLine: "No points issued {when} yet.",
    note: "The cost of the programme is the points redeemed in the range valued at the redemption rate, as a percent of the same range's revenue.",
  },

  cash: {
    key: "cash",
    title: "Cash",
    lede: "Sessions, what they were out by, and what moved through the drawer.",
    dimensions: [{ key: "day", label: "Day" }],
    kpis: [
      { key: "variance_total", label: "Variance", figure: "money", headline: true },
      { key: "session_count", label: "Sessions", figure: "count" },
      { key: "cash_in", label: "Cash in", figure: "money" },
      { key: "cash_out", label: "Cash out", figure: "money" },
    ],
    chart: {
      kind: "bar",
      money: true,
      summaryKey: "variance",
      series: [{ key: "variance", label: "Variance", tone: INK }],
    },
    tableHeading: "Sessions closed",
    columns: [
      dateColumn("closed_at", "Closed", "title"),
      moneyColumn("expected", "Expected"),
      moneyColumn("counted", "Counted", "detail"),
      moneyColumn("variance", "Variance", "figure"),
    ],
    panels: [
      {
        totalsKey: "by_day",
        heading: "In and out per day",
        empty: "Nothing moved through the drawer in this range.",
        columns: [
          dateColumn("date", "Day", "title"),
          moneyColumn("in", "In", "detail"),
          moneyColumn("out", "Out", "figure"),
        ],
      },
    ],
    emptyLine: "No session was closed {when}. Widen the range.",
  },

  compliance: {
    key: "compliance",
    title: "Compliance",
    lede: "The buy-in register, with the seller on every line.",
    admin: true,
    dimensions: [],
    kpis: [{ key: "count", label: "Buy-ins", figure: "count", headline: true }],
    chart: null,
    tableHeading: "Buy-in register",
    columns: [
      textColumn("number", "Number", "title"),
      dateColumn("completed_at", "Completed", "detail"),
      textColumn("seller_name", "Seller"),
      textColumn("seller_address", "Address"),
      mappedColumn("id_type", "ID", ID_TYPES),
      countColumn("items", "Items"),
      moneyColumn("total_offer", "Paid", "figure"),
    ],
    panels: [],
    emptyLine: "No buy-in was completed {when}.",
    note: "The seller snapshot on every cash buy-in is the record local dealer rules ask for, and is kept for six years.",
  },
}

/** The index, in the order docs/PLAN.md lists them. */
export const REPORT_ORDER: ReportKey[] = [
  "sales",
  "buyins",
  "margin",
  "stock",
  "channels",
  "customers",
  "loyalty",
  "cash",
  "compliance",
]
