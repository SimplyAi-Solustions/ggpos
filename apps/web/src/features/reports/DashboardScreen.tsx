/**
 * The reports dashboard (docs/api-contract-launch.md, section 3), the first
 * thing under Reports: sales and profit over a range against the period
 * before it, sales, cost and profit by day, by top-level branch with a drill
 * into the Sales report, the top items, the payment mix, buy-in spend and
 * stock value. Excel and CSV downloads of the same figures.
 *
 * Every figure is the route's own (`GET /api/vault/reports/dashboard`); the
 * screen adds nothing up beyond a payment's share of the whole. It is built
 * from the reports' own parts: the range control, the hairline tables, the
 * chart in the five chart tokens, so it reads like every report under it.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ClientResponseError } from "pocketbase"
import { displayCode, encodeCode, formatGBP, type Dashboard } from "@gg/shared"
import { ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { SkeletonText } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useCounterDock } from "@/app/counter-dock"
import { getDashboard } from "@/lib/api/dashboard"
import { refusalOrFallback } from "@/lib/api/refusal"
import { formatPercent } from "@/lib/format"
import { useToday } from "@/lib/use-today"
import type { ReportRow } from "@/lib/api/types"
import { SeriesChart, type ChartDatum } from "@/features/reports/charts"
import { buildCsv, csvFilename, downloadCsv, poundsCell } from "@/features/reports/csv"
import { DateRangeControl } from "@/features/reports/DateRangeControl"
import { downloadXlsx, sheet, xlsxFilename, type ExcelBook, type ExcelKind } from "@/features/reports/excel"
import { excelColumns } from "@/features/reports/excel-report"
import { ReportTable } from "@/features/reports/ReportTable"
import {
  bucketTick,
  bucketTitle,
  compareLabel,
  crossesYear,
  formatDelta,
  formatRange,
  formatWhen,
  previousPeriod,
  rangeError,
  resolvePreset,
  type DateRange,
} from "@/features/reports/range"
import {
  countColumn,
  moneyColumn,
  percentColumn,
  str,
  textColumn,
  type ColumnSpec,
} from "@/features/reports/specs"

/** The same treatment every other screen gives a blocked block button. */
const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

type FigureKind = "money" | "count" | "percent"

interface Figure {
  key: string
  label: string
  kind: FigureKind
  /** The one Anton figure on the row. */
  headline?: boolean
  value: (board: Pick<Dashboard, "sales" | "cost" | "profit" | "margin_pct">) => number
}

/** The headline figures, each with its change against the period before. */
const FIGURES: Figure[] = [
  { key: "net", label: "Net sales", kind: "money", headline: true, value: (b) => b.sales.net },
  { key: "profit", label: "Profit", kind: "money", value: (b) => b.profit },
  { key: "margin_pct", label: "Margin", kind: "percent", value: (b) => b.margin_pct },
  { key: "cost", label: "Cost of stock sold", kind: "money", value: (b) => b.cost },
  { key: "vat", label: "VAT", kind: "money", value: (b) => b.sales.vat },
  { key: "count", label: "Sales", kind: "count", value: (b) => b.sales.count },
  { key: "average", label: "Average sale", kind: "money", value: (b) => b.sales.average },
  { key: "discounts", label: "Discounts", kind: "money", value: (b) => b.sales.discounts },
  { key: "refunds", label: "Refunds", kind: "money", value: (b) => b.sales.refunds },
]

function say(value: number, kind: FigureKind): string {
  if (kind === "money") return formatGBP(value)
  if (kind === "percent") return formatPercent(value)
  return value.toLocaleString("en-GB")
}

/** The percent change in points for a margin, the amount for everything else. */
function change(current: number, before: number, kind: FigureKind): string {
  if (kind === "percent") {
    const points = Math.round((current - before) * 10) / 10
    if (points === 0) return "No change"
    return `${points > 0 ? "+" : "-"}${formatPercent(Math.abs(points)).replace("%", "")} points`
  }
  return formatDelta(current, before, (amount) => say(amount, kind))
}

function Figures({ board }: { board: Dashboard }) {
  const before = board.compare ?? null
  return (
    <dl data-testid="dashboard-kpis" className="mt-12 grid grid-cols-2 gap-x-10 gap-y-10 min-[900px]:grid-cols-3">
      {FIGURES.map((figure) => {
        const value = figure.value(board)
        return (
          <div key={figure.key} className="flex flex-col gap-2">
            <dt>
              <MicroLabel>{figure.label}</MicroLabel>
            </dt>
            <dd className="m-0">
              <span
                data-testid={`dashboard-${figure.key}`}
                className={
                  figure.headline
                    ? "tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
                    : "tnum text-[20px] leading-none font-medium text-foreground"
                }
              >
                {say(value, figure.kind)}
              </span>
              {before ? (
                <span className="tnum mt-2 block text-[13px] text-muted-foreground-2">
                  {change(value, figure.value(before), figure.kind)}
                </span>
              ) : null}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** A row of smaller figures with no comparison: buy-ins and what is on the shelf. */
function Holdings({ board }: { board: Dashboard }) {
  const rows: { key: string; label: string; text: string }[] = [
    { key: "buyin-spend", label: "Buy-in spend", text: formatGBP(board.buy_ins.spend) },
    { key: "buyin-count", label: "Buy-ins", text: board.buy_ins.count.toLocaleString("en-GB") },
    { key: "stock-cost", label: "Stock at cost", text: formatGBP(board.stock.cost) },
    { key: "stock-retail", label: "Stock at sell price", text: formatGBP(board.stock.retail) },
    { key: "stock-items", label: "Units held", text: board.stock.items.toLocaleString("en-GB") },
  ]
  return (
    <dl data-testid="dashboard-holdings" className="grid grid-cols-2 gap-x-10 gap-y-10 min-[900px]:grid-cols-3">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-2">
          <dt>
            <MicroLabel>{row.label}</MicroLabel>
          </dt>
          <dd className="m-0">
            <span data-testid={`dashboard-${row.key}`} className="tnum text-[20px] leading-none font-medium text-foreground">
              {row.text}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A branch that opens the Sales report by category, drilled into it. */
function branchColumn(): ColumnSpec {
  return {
    key: "label",
    label: "Branch",
    summary: "title",
    text: (row) => str(row, "label"),
    sortValue: (row) => str(row, "label").toLowerCase(),
    cell: (row) =>
      str(row, "id") ? (
        <Link
          to="/counter/reports/$key"
          params={{ key: "sales" }}
          search={{ by: "category", branch: str(row, "id") }}
          data-testid="dashboard-drill"
          className="inline-flex max-w-full items-center gap-1.5 text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          <span className="truncate">{str(row, "label")}</span>
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 stroke-[1.25]" />
        </Link>
      ) : (
        str(row, "label")
      ),
  }
}

const CATEGORY_COLUMNS: ColumnSpec[] = [
  branchColumn(),
  moneyColumn("net", "Net sales", "figure"),
  moneyColumn("cost", "Cost"),
  moneyColumn("profit", "Profit", "detail"),
  percentColumn("margin_pct", "Margin"),
]

const ITEM_COLUMNS: ColumnSpec[] = [
  textColumn("title", "Item", "title"),
  {
    key: "sku",
    label: "SKU",
    summary: "detail",
    text: (row) => (str(row, "sku") ? displayCode(str(row, "sku")) : "Till product"),
    sortValue: (row) => str(row, "sku"),
    cell: (row) =>
      str(row, "sku") ? (
        <Link
          to="/counter/stock/$sku"
          params={{ sku: encodeCode(str(row, "sku")) }}
          className="tnum font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {displayCode(str(row, "sku"))}
        </Link>
      ) : (
        <span className="text-muted-foreground-2">Till product</span>
      ),
  },
  countColumn("count", "Units"),
  moneyColumn("net", "Net sales", "figure"),
  moneyColumn("profit", "Profit"),
]

const PAYMENT_COLUMNS: ColumnSpec[] = [
  textColumn("label", "Paid by", "title"),
  moneyColumn("net", "Net", "figure"),
  percentColumn("share", "Share", "detail"),
]

function asRows<T extends object>(rows: readonly T[]): ReportRow[] {
  return rows.map((row) => ({ ...row }) as unknown as ReportRow)
}

/** The whole dashboard as one Excel file: a sheet per table and a cover. */
function dashboardBook(board: Dashboard, range: DateRange, paymentRows: ReportRow[]): ExcelBook {
  const before = board.compare ?? null
  const figures = sheet(
    "Figures",
    [
      { label: "Figure", kind: "text", value: (figure: Figure) => figure.label },
      { label: "This period", kind: (figure: Figure): ExcelKind => figure.kind, value: (figure: Figure) => figure.value(board) },
      ...(before
        ? [
            {
              label: "Period before",
              kind: (figure: Figure): ExcelKind => figure.kind,
              value: (figure: Figure) => figure.value(before),
            },
          ]
        : []),
    ],
    FIGURES
  )
  const holdings = sheet(
    "Buy-ins and stock",
    [
      { label: "Figure", kind: "text", value: (row: { label: string; kind: ExcelKind; value: number }) => row.label },
      { label: "Value", kind: (row: { kind: ExcelKind }) => row.kind, value: (row: { value: number }) => row.value },
    ],
    [
      { label: "Buy-in spend", kind: "money" as ExcelKind, value: board.buy_ins.spend },
      { label: "Buy-ins", kind: "count" as ExcelKind, value: board.buy_ins.count },
      { label: "Stock at cost", kind: "money" as ExcelKind, value: board.stock.cost },
      { label: "Stock at sell price", kind: "money" as ExcelKind, value: board.stock.retail },
      { label: "Units held", kind: "count" as ExcelKind, value: board.stock.items },
    ]
  )
  const days = sheet(
    "By day",
    [
      { label: "Day", kind: "date", value: (day: Dashboard["series"][number]) => day.date },
      { label: "Net sales", kind: "money", value: (day: Dashboard["series"][number]) => day.net },
      { label: "Cost", kind: "money", value: (day: Dashboard["series"][number]) => day.cost },
      { label: "Profit", kind: "money", value: (day: Dashboard["series"][number]) => day.profit },
    ],
    board.series
  )
  return {
    title: "Sales and profit dashboard",
    range,
    made: new Date(),
    sheets: [
      figures,
      days,
      sheet("By category", excelColumns(CATEGORY_COLUMNS), asRows(board.by_category)),
      sheet("Top items", excelColumns(ITEM_COLUMNS), asRows(board.top_items)),
      sheet("Payments", excelColumns(PAYMENT_COLUMNS), paymentRows),
      holdings,
    ],
    notes: [
      "Net sales are after discounts and refunds. Profit is net sales less VAT less what the stock sold cost; a till product has no cost.",
    ],
  }
}

export function DashboardSection() {
  const dock = useCounterDock()
  const today = useToday()
  const [range, setRange] = React.useState<DateRange>(() => resolvePreset("last30", today))
  const [compareOn, setCompareOn] = React.useState(true)
  const invalid = rangeError(range)
  const previous = React.useMemo(() => previousPeriod(range), [range])

  const query = useQuery({
    queryKey: ["dashboard", range.from, range.to, compareOn],
    queryFn: () => getDashboard({ from: range.from, to: range.to, compare: compareOn }),
    enabled: invalid === null,
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ClientResponseError && error.status === 403) && count < 2,
  })
  const board = query.data ?? null
  const refused = query.error instanceof ClientResponseError && query.error.status === 403

  const paymentRows = React.useMemo(() => {
    if (!board) return []
    const total = board.payments.reduce((sum, row) => sum + row.net, 0)
    return board.payments.map((row) => ({
      method: row.method,
      label: row.label,
      net: row.net,
      share: total > 0 ? Math.round((row.net * 1000) / total) / 10 : 0,
    })) as ReportRow[]
  }, [board])

  const chartData: ChartDatum[] = React.useMemo(
    () => (board ? board.series.map((day) => ({ label: day.date, net: day.net, cost: day.cost, profit: day.profit })) : []),
    [board]
  )
  const hasSales = Boolean(board && board.series.some((day) => day.net !== 0 || day.cost !== 0))
  const summary = board
    ? `Net sales ${formatWhen(range)}, ${formatGBP(board.sales.net)}, with ${formatGBP(board.profit)} profit after VAT and the cost of the stock sold.`
    : ""

  function exportExcel() {
    if (!board) return
    downloadXlsx(xlsxFilename("dashboard", range.from, range.to), dashboardBook(board, range, paymentRows))
  }

  function exportCsv() {
    if (!board) return
    const text = buildCsv(
      [
        { label: "Day", value: (day: Dashboard["series"][number]) => day.date },
        { label: "Net sales", value: (day: Dashboard["series"][number]) => poundsCell(day.net) },
        { label: "Cost", value: (day: Dashboard["series"][number]) => poundsCell(day.cost) },
        { label: "Profit", value: (day: Dashboard["series"][number]) => poundsCell(day.profit) },
      ],
      board.series
    )
    downloadCsv(csvFilename("dashboard", range.from, range.to), text)
  }

  const primary = (
    <Button className={`w-full min-[900px]:w-auto ${BLOCKED}`} trailingArrow disabled={!board} onClick={exportExcel}>
      Export Excel
    </Button>
  )

  return (
    <div data-testid="dashboard">
      <DateRangeControl
        range={range}
        onRangeChange={setRange}
        today={today}
        group="day"
        onGroupChange={() => undefined}
        dimensions={[]}
        by=""
        onByChange={() => undefined}
        showGroup={false}
        error={invalid}
      />

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <p data-testid="dashboard-range" className="text-[15px] text-muted-foreground">
          {formatRange(range)}
          {compareOn ? `, ${compareLabel(range, previous)}` : ""}
        </p>
        <span className="flex items-center gap-3">
          <Switch
            id="dashboard-compare"
            checked={compareOn}
            onCheckedChange={(checked: boolean) => setCompareOn(checked)}
            aria-label="Compare with the period before"
          />
          <label htmlFor="dashboard-compare" className="text-[13px] text-muted-foreground-2">
            Compare
          </label>
        </span>
      </div>

      {refused ? (
        <p className="mt-12 max-w-[56ch] text-[15px] text-muted-foreground">
          Sales and profit are for managers and admins. Every report below is still open to you.
        </p>
      ) : query.error ? (
        <p role="alert" className="mt-12 text-[15px] text-destructive">
          {refusalOrFallback(query.error, "The dashboard would not load. Check the connection and try again.")}
        </p>
      ) : !board ? (
        invalid ? (
          <p className="mt-12 text-[15px] text-muted-foreground-2">Pick a range to see the figures.</p>
        ) : (
          <SkeletonText lines={4} className="mt-12 max-w-[40rem]" />
        )
      ) : (
        <>
          <Figures board={board} />

          <section className="mt-16" aria-label="Sales and profit by day">
            <SectionHeading>Sales and profit</SectionHeading>
            {hasSales ? (
              <SeriesChart
                kind="line"
                data={chartData}
                series={[
                  { key: "net", label: "Net sales", tone: 1 },
                  { key: "cost", label: "Cost", tone: 3 },
                  { key: "profit", label: "Profit", tone: 5 },
                ]}
                money
                summary={summary}
                tickFormatter={(label) => bucketTick(label, "day", crossesYear(range))}
                labelFormatter={(label) => bucketTitle(label, "day")}
              />
            ) : (
              <p data-testid="dashboard-empty" className="text-[15px] text-muted-foreground-2">
                No sales {formatWhen(range)}. Widen the range.
              </p>
            )}
          </section>

          <section className="mt-16">
            <SectionHeading>By category</SectionHeading>
            <ReportTable
              testId="dashboard-category"
              columns={CATEGORY_COLUMNS}
              rows={asRows(board.by_category)}
              empty={`Nothing sold ${formatWhen(range)}.`}
            />
            <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              Each top-level branch opens in the Sales report, one level down.
            </p>
          </section>

          <section className="mt-16">
            <SectionHeading>Top items</SectionHeading>
            <ReportTable
              testId="dashboard-top-items"
              columns={ITEM_COLUMNS}
              rows={asRows(board.top_items)}
              empty={`Nothing sold ${formatWhen(range)}.`}
            />
          </section>

          <section className="mt-16">
            <SectionHeading>How it was paid</SectionHeading>
            <ReportTable
              testId="dashboard-payments"
              columns={PAYMENT_COLUMNS}
              rows={paymentRows}
              empty={`Nothing was paid ${formatWhen(range)}.`}
            />
          </section>

          <section className="mt-16">
            <SectionHeading>Buy-ins and stock</SectionHeading>
            <Holdings board={board} />
            <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              Buy-ins are for the range. Stock is what is on the shelf now, at cost and at its sell price.
            </p>
          </section>
        </>
      )}

      <div className="mt-16 flex flex-wrap items-center gap-8">
        <div className="hidden min-[900px]:block">{primary}</div>
        <Button variant="text" disabled={!board} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">{primary}</div>,
            dock
          )
        : null}
    </div>
  )
}
