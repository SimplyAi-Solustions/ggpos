/**
 * One report: the range, the figures, one chart, one table and the lists
 * under it.
 *
 * Every key runs through this screen and its spec
 * (`features/reports/specs.tsx`), so the nine reports are one page rather
 * than nine, and a column can never mean one thing on screen and another in
 * the exported file.
 *
 * The comparison figures come from the route's own `compare.totals`, which is
 * the server's arithmetic rather than ours. The comparison line on the chart
 * needs the previous period's own series, which the envelope does not carry,
 * so it is a second read of the same route over the earlier range; it is
 * only asked for while the comparison is switched on, and the chart simply
 * leaves the line off if it fails.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Switch } from "@/components/ui/switch"
import { useCounterDock } from "@/app/counter-dock"
import { useStaff } from "@/lib/auth"
import { refusalOrFallback } from "@/lib/api/refusal"
import { getReport, listSavedReports } from "@/lib/api/reports"
import { todayIso } from "@/lib/api/dates"
import type {
  ReportEnvelope,
  ReportGroup,
  ReportKey,
  ReportPoint,
  ReportRow,
  SavedReportRecord,
} from "@/lib/api/types"
import { Heatmap, SeriesChart, type ChartDatum } from "@/features/reports/charts"
import { buildCsv, csvFilename, downloadCsv } from "@/features/reports/csv"
import { DateRangeControl } from "@/features/reports/DateRangeControl"
import { ReportTable } from "@/features/reports/ReportTable"
import { SaveViewSheet, SavedViewsRow } from "@/features/reports/SavedViews"
import {
  bucketTick,
  bucketTitle,
  compareLabel,
  formatRange,
  formatWhen,
  formatDelta,
  previousPeriod,
  rangeError,
  resolvePreset,
  type DateRange,
} from "@/features/reports/range"
import {
  REPORT_SPECS,
  figureText,
  type ColumnSpec,
  type ReportSpec,
} from "@/features/reports/specs"

/** The same treatment every other screen gives a blocked block button. */
const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

/** Which reports carry a thumbnail column, because their rows are items. */
const ITEM_TABLES: Partial<Record<ReportKey, string>> = { stock: "tcg_card" }

function totalOf(totals: Record<string, unknown> | undefined, key: string): number {
  const value = totals?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function rowsOf(totals: Record<string, unknown> | undefined, key: string): ReportRow[] {
  const value = totals?.[key]
  return Array.isArray(value) ? (value as ReportRow[]) : []
}

/** True once anything in the envelope has a figure worth drawing. */
function hasData(envelope: ReportEnvelope): boolean {
  if (envelope.table.length > 0) return true
  return envelope.series.some((point) =>
    Object.values(point.values).some((value) => value !== 0)
  )
}

function Kpis({
  spec,
  totals,
  compare,
}: {
  spec: ReportSpec
  totals: Record<string, unknown>
  compare: Record<string, unknown> | null
}) {
  return (
    <dl
      data-testid="report-kpis"
      className="mt-12 grid grid-cols-2 gap-x-10 gap-y-10 min-[900px]:grid-cols-3"
    >
      {spec.kpis.map((kpi) => {
        const value = totalOf(totals, kpi.key)
        // A delta only where the previous period has that figure at all:
        // stock is read as it stands now, so most of it cannot be compared.
        const comparable = compare !== null && kpi.key in compare
        return (
          <div key={kpi.key} className="flex flex-col gap-2">
            <dt>
              <MicroLabel>{kpi.label}</MicroLabel>
            </dt>
            <dd className="m-0">
              <span
                data-testid={`kpi-${kpi.key}`}
                className={
                  kpi.headline
                    ? "tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
                    : "tnum text-[20px] leading-none font-medium text-foreground"
                }
              >
                {figureText(value, kpi.figure)}
              </span>
              {comparable ? (
                <span className="tnum mt-2 block text-[13px] text-muted-foreground-2">
                  {formatDelta(value, totalOf(compare, kpi.key), (amount) =>
                    figureText(amount, kpi.figure)
                  )}
                </span>
              ) : null}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function Panel({
  heading,
  rows,
  columns,
  empty,
}: {
  heading: string
  rows: ReportRow[]
  columns: ColumnSpec[]
  empty: string
}) {
  return (
    <section className="mt-16">
      <SectionHeading>{heading}</SectionHeading>
      <ReportTable columns={columns} rows={rows} empty={empty} />
    </section>
  )
}

export function ReportScreen({ reportKey }: { reportKey: ReportKey }) {
  const spec = REPORT_SPECS[reportKey]
  const dock = useCounterDock()
  const staff = useStaff()
  const admin = staff?.role === "admin"
  const today = React.useMemo(() => todayIso(), [])

  const [range, setRange] = React.useState<DateRange>(() => resolvePreset("last30", today))
  const [group, setGroup] = React.useState<ReportGroup>("day")
  const [by, setBy] = React.useState<string>(spec.dimensions[0]?.key ?? "")
  const [compare, setCompare] = React.useState(true)
  const [saveOpen, setSaveOpen] = React.useState(false)

  const invalid = rangeError(range)
  const previous = React.useMemo(() => previousPeriod(range), [range])

  const query = useQuery({
    queryKey: ["report", reportKey, range.from, range.to, group, by, compare],
    queryFn: () =>
      getReport(reportKey, {
        from: range.from,
        to: range.to,
        group,
        by: by || undefined,
        compare: compare ? "previous" : "none",
      }),
    enabled: invalid === null,
    staleTime: 60_000,
  })

  const before = useQuery({
    queryKey: ["report", reportKey, previous.from, previous.to, group, by, false],
    queryFn: () =>
      getReport(reportKey, {
        from: previous.from,
        to: previous.to,
        group,
        by: by || undefined,
        compare: "none",
      }),
    enabled: invalid === null && compare && spec.chart !== null,
    staleTime: 60_000,
  })

  const views = useQuery({
    queryKey: ["saved-reports", reportKey],
    queryFn: () => listSavedReports(reportKey),
    staleTime: 60_000,
  })

  function loadView(view: SavedReportRecord) {
    if (view.filters?.group) setGroup(view.filters.group)
    if (view.filters?.by) setBy(view.filters.by)
  }

  const envelope = query.data ?? null

  const chartData: ChartDatum[] = React.useMemo(() => {
    if (!envelope || !spec.chart) return []
    const earlier = before.data?.series ?? []
    return envelope.series.map((point: ReportPoint, index: number) => {
      const row: ChartDatum = { label: point.label }
      for (const [key, value] of Object.entries(point.values)) row[key] = value
      const other = earlier[index]
      if (other && spec.chart) {
        row.compare = other.values[spec.chart.summaryKey] ?? 0
      }
      return row
    })
  }, [envelope, before.data, spec.chart])

  const chartSeries = React.useMemo(() => {
    if (!spec.chart) return []
    const base = spec.chart.series
    const overlay = compare && (before.data?.series.length ?? 0) > 0
    return overlay
      ? [...base, { key: "compare", label: "Period before", tone: 4 as const }]
      : base
  }, [spec.chart, compare, before.data])

  const chartSummary = React.useMemo(() => {
    if (!envelope || !spec.chart) return ""
    const key = spec.chart.summaryKey
    const money = spec.chart.money
    let peakLabel = ""
    let peak = 0
    let total = 0
    for (const point of envelope.series) {
      const value = point.values[key] ?? 0
      total += value
      if (value > peak) {
        peak = value
        peakLabel = point.label
      }
    }
    const say = (value: number) => (money ? formatGBP(value) : value.toLocaleString("en-GB"))
    const headline = spec.chart.series[0]?.label ?? key
    return peakLabel
      ? `${headline} ${formatWhen(range)}, ${say(total)} in total. The highest was ${say(peak)}, ${bucketTitle(peakLabel, group)}.`
      : `${headline} ${formatWhen(range)}: nothing to show.`
  }, [envelope, spec.chart, range, group])

  function exportCsv() {
    if (!envelope) return
    const text = buildCsv(
      spec.columns.map((column) => ({
        label: column.label,
        value: (row: ReportRow) => (column.csv ? column.csv(row) : column.text(row)),
      })),
      envelope.table
    )
    downloadCsv(csvFilename(reportKey, range.from, range.to), text)
  }

  const primary = (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      disabled={!envelope || envelope.table.length === 0}
      onClick={exportCsv}
    >
      Export CSV
    </Button>
  )

  if (spec.admin && !admin) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>{spec.title}</PageTitle>
        <Lede>
          The buy-in register is for admins. Ask Richard if you need a seller
          looking up.
        </Lede>
        <div className="mt-12">
          <Button variant="text" render={<Link to="/counter/reports" />}>
            All reports
          </Button>
        </div>
      </section>
    )
  }

  const heatmap = reportKey === "sales" ? (envelope?.totals?.heatmap as number[][]) : undefined
  const empty = spec.emptyLine.replace("{when}", formatWhen(range))

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>{spec.title}</PageTitle>
      <Lede>{spec.lede}</Lede>

      <SavedViewsRow views={views.data ?? []} onLoad={loadView} />

      <DateRangeControl
        range={range}
        onRangeChange={setRange}
        today={today}
        group={group}
        onGroupChange={setGroup}
        dimensions={spec.dimensions}
        by={by}
        onByChange={setBy}
        showGroup={spec.chart !== null}
        error={invalid}
      />

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <p data-testid="range-line" className="text-[15px] text-muted-foreground">
          {formatRange(range)}
          {compare ? `, ${compareLabel(range, previous)}` : ""}
        </p>
        <span className="flex items-center gap-3">
          <Switch
            id="compare-toggle"
            checked={compare}
            onCheckedChange={(checked: boolean) => setCompare(checked)}
            aria-label="Compare with the period before"
          />
          <label htmlFor="compare-toggle" className="text-[13px] text-muted-foreground-2">
            Compare
          </label>
        </span>
      </div>

      {query.error ? (
        <p role="alert" className="mt-12 text-[15px] text-destructive">
          {refusalOrFallback(
            query.error,
            "That report would not load. Check the connection and try again."
          )}
        </p>
      ) : null}

      {!envelope && !query.error ? (
        <p className="mt-12 text-[15px] text-muted-foreground-2">
          {invalid ? "Pick a range to see the figures." : "Working the figures out."}
        </p>
      ) : null}

      {envelope ? (
        <>
          <Kpis spec={spec} totals={envelope.totals} compare={envelope.compare?.totals ?? null} />

          {!hasData(envelope) ? (
            <p data-testid="report-empty" className="mt-16 text-[15px] text-muted-foreground-2">
              {empty}
            </p>
          ) : (
            <>
              {spec.chart && envelope.series.length > 0 ? (
                <div className="mt-16">
                  <SectionHeading>Over the period</SectionHeading>
                  <SeriesChart
                    kind={spec.chart.kind}
                    data={chartData}
                    series={chartSeries}
                    money={spec.chart.money}
                    summary={chartSummary}
                    tickFormatter={(label) => bucketTick(label, group)}
                    labelFormatter={(label) => bucketTitle(label, group)}
                  />
                </div>
              ) : null}

              <div className="mt-16">
                <SectionHeading>{spec.tableHeading}</SectionHeading>
                <ReportTable
                  testId="report-table"
                  columns={spec.columns}
                  rows={envelope.table}
                  empty={empty}
                  imagePlatform={ITEM_TABLES[reportKey]}
                />
                {spec.note ? (
                  <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                    {spec.note}
                  </p>
                ) : null}
              </div>

              {heatmap && heatmap.length > 0 ? (
                <section className="mt-16">
                  <SectionHeading>When the shop is busy</SectionHeading>
                  <Heatmap
                    rows={heatmap}
                    summary={`Sales by hour and weekday ${formatWhen(range)}, darkest where most sales were rung up.`}
                  />
                  <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                    Sales by hour of the day, in shop time, for working out
                    when to put somebody on.
                  </p>
                </section>
              ) : null}

              {spec.panels.map((panel) => (
                <Panel
                  key={panel.totalsKey}
                  heading={panel.heading}
                  columns={panel.columns}
                  rows={rowsOf(envelope.totals, panel.totalsKey)}
                  empty={panel.empty}
                />
              ))}
            </>
          )}
        </>
      ) : null}

      <div className="mt-24 flex flex-wrap items-center gap-8">
        <div className="hidden min-[900px]:block">{primary}</div>
        <Button variant="text" onClick={() => setSaveOpen(true)}>
          Save view
        </Button>
        <Button variant="text" render={<Link to="/counter/reports" />}>
          All reports
        </Button>
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}

      <SaveViewSheet
        open={saveOpen}
        onOpenChange={setSaveOpen}
        reportKey={reportKey}
        filters={{ by: by || undefined, group }}
        views={views.data ?? []}
        admin={admin}
      />
    </section>
  )
}
