import * as React from "react"
import { formatGBP } from "@gg/shared/money"

import { Segmented } from "@/ui"

import { chartPath, pointsInRange, RANGES, type ChartPoint, type ChartRange } from "./chart-data"
import { shortDate } from "./format"

const W = 600
const H = 160

/** NM market over time, from the card's price snapshots. Drawn only when there is history. */
export function PriceChart({ points, sourceLabel }: { points: readonly ChartPoint[]; sourceLabel: string }) {
  const [range, setRange] = React.useState<ChartRange>("6M")
  const shown = React.useMemo(() => pointsInRange(points, range), [points, range])
  const path = chartPath(shown, W, H)
  const gradientId = React.useId()

  return (
    <section aria-labelledby="chart-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="chart-heading" className="label-mono text-fg-2">
            Price history
          </h2>
          <p className="text-xs text-fg-3">{sourceLabel}, in GBP</p>
        </div>
        <Segmented
          label="Chart range"
          options={RANGES.map((r) => ({ value: r, label: r }))}
          value={range}
          onChange={setRange}
          size="sm"
        />
      </div>
      {path ? (
        <figure className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full overflow-visible text-fg" role="img" aria-label={`NM price from ${formatGBP(path.min)} to ${formatGBP(path.max)} over ${range}`}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <path d={path.area} fill={`url(#${gradientId})`} />
            <path d={path.line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <span
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-pop"
            style={{ left: `${(path.last.x / W) * 100}%`, top: `${(path.last.y / H) * 100}%` }}
            aria-hidden
          />
          <figcaption className="mt-2 flex justify-between font-mono text-[11px] text-fg-3 tnum">
            <span>{shortDate(shown[0]!.at)}</span>
            <span>
              Low {formatGBP(path.min)} · High {formatGBP(path.max)}
            </span>
            <span>{shortDate(shown[shown.length - 1]!.at)}</span>
          </figcaption>
        </figure>
      ) : (
        <p className="rounded-md border border-dashed border-line-2 px-4 py-6 text-center text-sm text-fg-3">
          Not enough price history in this range.
        </p>
      )}
    </section>
  )
}
