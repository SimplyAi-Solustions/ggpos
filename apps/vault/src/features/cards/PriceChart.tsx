import * as React from "react"
import { Activity, SearchCheck } from "lucide-react"
import { formatGBP } from "@gg/shared/money"

import { Badge, Button, Chip, Money, Segmented } from "@/ui"
import { cn } from "@/lib/cn"

import type { CardComp, OpenRequest } from "./api"
import { buildSeries, changeOver, pathOnScale, pointsInRange, RANGES, scaleFor, SERIES_KEYS, SERIES_LABELS, type ChartPoint, type ChartRange, type HistoryPoint, type SeriesKey } from "./chart-data"
import { shortDate } from "./format"
import { sourceLabel } from "./links"

const W = 600
const H = 170

export interface PriceChartProps {
  history: readonly HistoryPoint[]
  /** The source the NM market figure came from, so the raw line follows it. */
  preferredSource: string | null | undefined
  /** UK sold comps, for the LP overlay. */
  comps: readonly CardComp[]
  openRequests: readonly OpenRequest[]
  onRequestGraded: (grader: string, grade: string) => void
  requesting?: boolean
}

/**
 * Price history from the card's snapshots: one series at a time (Raw NM,
 * PSA 10, PSA 9 or ACE 10), five ranges, and an LP overlay from real LP
 * sales. Every series is one source, every point a stored figure; a series
 * with nothing recorded says so and offers a check, it never draws a line.
 */
export function PriceChart({ history, preferredSource, comps, openRequests, onRequestGraded, requesting }: PriceChartProps) {
  const [range, setRange] = React.useState<ChartRange>("3M")
  const [key, setKey] = React.useState<SeriesKey>("raw")
  const [overlay, setOverlay] = React.useState(false)
  const gradientId = React.useId()

  const series = React.useMemo(() => buildSeries(history, key, preferredSource), [history, key, preferredSource])
  const shown = React.useMemo(() => pointsInRange(series.points, range), [series, range])
  const seededDays = React.useMemo(() => new Set(series.points.filter((p) => p.basis).map((p) => p.at.slice(0, 10))), [series])
  const lpAll = React.useMemo<ChartPoint[]>(
    () => comps.filter((c) => c.condition.toUpperCase() === "LP").map((c) => ({ at: c.sold_at, pence: c.pence })),
    [comps]
  )
  const lp = React.useMemo(() => (overlay && key === "raw" ? pointsInRange(lpAll, range) : []), [lpAll, overlay, key, range])

  const scale = scaleFor(lp.length >= 2 ? [shown, lp] : [shown])
  const main = scale ? pathOnScale(shown, scale, W, H) : null
  const lpPath = scale && lp.length >= 2 ? pathOnScale(lp, scale, W, H) : null
  const change = changeOver(shown)
  const last = shown[shown.length - 1]

  const slabLabel = key === "raw" ? "Raw NM" : key
  const [grader, grade] = key === "raw" ? ["", ""] : key.split(" ")
  const liveRequest = openRequests.find((r) => r.grader === grader && r.grade === grade)

  return (
    <section aria-labelledby="chart-heading" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="chart-heading" className="label-mono text-fg-2">
            Price history
          </h2>
          <p className="truncate text-xs text-fg-3">
            {series.source ? `${sourceLabel(series.source)}, in GBP` : "In GBP"}
            {series.seeded ? " · includes Cardmarket 1, 7 and 30-day averages" : ""}
          </p>
        </div>
        <Segmented label="Chart range" options={RANGES.map((r) => ({ value: r, label: r }))} value={range} onChange={setRange} size="sm" />
      </div>

      <div role="group" aria-label="Series" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        {SERIES_KEYS.map((k) => (
          <Chip key={k} selected={key === k} onClick={() => setKey(k)}>
            {SERIES_LABELS[k]}
          </Chip>
        ))}
        <span aria-hidden className="my-1 w-px shrink-0 bg-line-2" />
        <Chip selected={overlay} onClick={() => setOverlay((v) => !v)} disabled={key !== "raw"} aria-label="Overlay LP sales" className="disabled:opacity-40">
          <span aria-hidden className="h-0 w-4 border-t-2 border-dashed border-current" />
          LP
        </Chip>
      </div>

      {main && scale && last ? (
        <figure className="relative rounded-lg border border-line bg-panel p-3.5 shadow-panel">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div className="flex flex-col">
              <span className="label-mono text-[10px] text-fg-3">
                {slabLabel} · {shortDate(last.at)}
              </span>
              <Money pence={last.pence} size="lg" tween />
            </div>
            {change != null && (
              <Badge tone={change > 0 ? "ok" : change < 0 ? "pop" : "neutral"} dot>
                {change > 0 ? "+" : ""}
                {(change * 100).toFixed(1)}% over {range === "All" ? "all time" : range}
              </Badge>
            )}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-44 w-full overflow-visible text-fg" role="img" aria-label={`${slabLabel} from ${formatGBP(scale.min)} to ${formatGBP(scale.max)} over ${range}`}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.14" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <path d={main.area} fill={`url(#${gradientId})`} />
            {lpPath && <path d={lpPath.line} fill="none" stroke="var(--fg-3)" strokeWidth={1.5} strokeDasharray="5 5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
            <path d={main.line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* Seeded averages sit as hollow marks, so a reader sees which points are averages. */}
          {shown
            .filter((p) => seededDays.has(p.at))
            .map((p) => {
              const x = scale.t1 === scale.t0 ? 0 : ((new Date(p.at).getTime() - scale.t0) / (scale.t1 - scale.t0)) * 100
              const y = (1 - (p.pence - scale.lo) / (scale.hi - scale.lo)) * 100
              return <span key={p.at} aria-hidden className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-fg bg-panel" style={{ left: `calc(0.875rem + (100% - 1.75rem) * ${x / 100})`, top: `calc(3.75rem + 11rem * ${y / 100})` }} />
            })}
          <span
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-pop dark:[box-shadow:var(--glow-pop)]"
            style={{ left: `calc(0.875rem + (100% - 1.75rem) * ${main.last.x / W})`, top: `calc(3.75rem + 11rem * ${main.last.y / H})` }}
            aria-hidden
          />
          <figcaption className="mt-2 flex justify-between font-mono text-[11px] text-fg-3 tnum">
            <span>{shortDate(shown[0]!.at)}</span>
            <span>
              Low {formatGBP(scale.min)} · High {formatGBP(scale.max)}
              {lpPath ? " · LP dashed" : ""}
            </span>
            <span>{shortDate(last.at)}</span>
          </figcaption>
        </figure>
      ) : series.points.length === 0 ? (
        <div className={cn("flex flex-col items-center gap-3 rounded-lg border border-dashed border-line-2 px-5 py-8 text-center")}>
          <span className="flex size-11 items-center justify-center rounded-full bg-panel-2 text-fg-2">
            <Activity className="size-5" aria-hidden />
          </span>
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-fg">{key === "raw" ? "No price history yet" : `No ${key} sales recorded yet`}</p>
            <p className="max-w-[36ch] text-sm text-fg-3">
              {key === "raw" ? "History builds from the daily snapshot, starting today." : `A graded check asks for UK sold ${key} slabs of this card. The line draws once two are recorded.`}
            </p>
          </div>
          {key !== "raw" && (
            <Button variant="secondary" size="sm" icon={<SearchCheck className="size-4" aria-hidden />} loading={requesting} disabled={Boolean(liveRequest)} onClick={() => onRequestGraded(grader!, grade!)}>
              {liveRequest ? (liveRequest.status === "claimed" ? "Graded check in progress" : "Graded check requested") : "Request graded check"}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-2 px-5 py-6 text-center">
          <p className="text-sm text-fg-2">
            {shown.length === 1 ? `One ${slabLabel} point in ${range}` : `No ${slabLabel} points in ${range}`}
            {series.points.length === 1 ? ", and one recorded in all. The line draws from two." : "."}
          </p>
          {series.points.length >= 2 && range !== "All" && (
            <Button variant="ghost" size="sm" onClick={() => setRange("All")}>
              Show all time
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
