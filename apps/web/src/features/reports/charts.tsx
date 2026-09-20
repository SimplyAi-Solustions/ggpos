/**
 * The report charts: one series chart, one heatmap, both drawn in the five
 * chart tokens and nothing else.
 *
 * DESIGN.md's rules, made literal here: bars and lines in ink, the
 * comparison period in `--chart-4`, one highlight series in volt
 * (`--chart-5`); hairline axes, no filled areas, no gradients, no rounded bar
 * caps; ticks in Space Mono at the micro-label size; money through
 * `formatGBP`; and no animation at all when the reader has asked for less
 * motion.
 *
 * Every chart is a `<figure>` whose caption is a hidden sentence carrying the
 * headline figures, and the chart itself is hidden from the reading order:
 * the table under it is the same data in a form a screen reader can walk.
 *
 * This module and the route files that import it are the only places
 * Recharts appears, so it never reaches the entry chunk.
 */
import * as React from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"
import { formatGBP } from "@gg/shared"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { useReducedMotionGuard } from "@/design/motion"

/** Which of the five tokens a series is drawn in. */
export type ChartTone = 1 | 2 | 3 | 4 | 5

export interface ChartSeries {
  key: string
  label: string
  tone: ChartTone
}

export type ChartDatum = { label: string } & Record<string, string | number>

export interface SeriesChartProps {
  kind: "bar" | "line"
  data: ChartDatum[]
  series: ChartSeries[]
  /** Money is formatted through `formatGBP`; counts are printed as they are. */
  money?: boolean
  /** The hidden sentence a screen reader gets instead of the drawing. */
  summary: string
  /** The short text under a tick. */
  tickFormatter?: (label: string) => string
  /** The fuller text at the top of a tooltip. */
  labelFormatter?: (label: string) => string
  height?: number
  className?: string
}

function toneVar(tone: ChartTone): string {
  return `var(--chart-${tone})`
}

export function SeriesChart({
  kind,
  data,
  series,
  money = false,
  summary,
  tickFormatter,
  labelFormatter,
  height = 260,
  className,
}: SeriesChartProps) {
  const still = useReducedMotionGuard()
  const config: ChartConfig = Object.fromEntries(
    series.map((entry) => [entry.key, { label: entry.label, color: toneVar(entry.tone) }])
  )
  const formatValue = React.useCallback(
    (value: number) => (money ? formatGBP(value) : String(value)),
    [money]
  )

  const axis = (
    <>
      <CartesianGrid vertical={false} stroke="var(--hairline-faint)" />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={{ stroke: "var(--hairline)" }}
        tickMargin={10}
        // Thinned by the width actually available rather than by a count:
        // eight ticks fit at 1440px and collide at 390px.
        minTickGap={36}
        interval="preserveStartEnd"
        tickFormatter={tickFormatter}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={money ? 68 : 40}
        tickCount={4}
        tickFormatter={formatValue}
      />
      <ChartTooltip
        cursor={{ stroke: "var(--hairline)" }}
        content={
          <ChartTooltipContent
            labelFormatter={labelFormatter}
            format={(value) => formatValue(value)}
          />
        }
      />
      {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
    </>
  )

  return (
    <figure className={className} data-slot="report-chart">
      <div aria-hidden="true" style={{ height }}>
        <ChartContainer config={config} className="h-full">
          {kind === "bar" ? (
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              {axis}
              {series.map((entry) => (
                <Bar
                  key={entry.key}
                  dataKey={entry.key}
                  fill={toneVar(entry.tone)}
                  radius={0}
                  maxBarSize={48}
                  isAnimationActive={!still}
                />
              ))}
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              {axis}
              {series.map((entry) => (
                <Line
                  key={entry.key}
                  dataKey={entry.key}
                  type="linear"
                  stroke={toneVar(entry.tone)}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={!still}
                />
              ))}
            </LineChart>
          )}
        </ChartContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// The sales heatmap: hour of day by weekday, for staffing
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** Ink at stepped opacities, never a colour ramp. */
const STEPS = [0, 0.08, 0.2, 0.36, 0.56, 0.82]

function stepFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const band = Math.ceil((value / max) * (STEPS.length - 1))
  return STEPS[Math.min(band, STEPS.length - 1)] ?? 0
}

export interface HeatmapProps {
  /** Seven rows of twenty-four counts. Index 0 is Monday, in shop time. */
  rows: number[][]
  summary: string
  className?: string
}

export function Heatmap({ rows, summary, className }: HeatmapProps) {
  const max = Math.max(0, ...rows.flat())

  return (
    <figure className={className} data-slot="report-heatmap">
      <div aria-hidden="true" className="flex flex-col gap-1">
        {rows.map((hours, day) => (
          <div key={WEEKDAYS[day]} className="flex items-center gap-2">
            <span className="w-8 shrink-0 font-mono text-[11px] leading-none font-bold tracking-[0.08em] text-muted-foreground-2 uppercase">
              {WEEKDAYS[day]}
            </span>
            <div className="flex min-w-0 flex-1 gap-px">
              {hours.map((count, hour) => (
                <span
                  key={hour}
                  title={`${WEEKDAYS[day]} ${String(hour).padStart(2, "0")}:00, ${count} sales`}
                  className="h-5 flex-1 border border-hairline-faint bg-foreground"
                  style={{ opacity: stepFor(count, max) || 0.04 }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0" />
          <div className="flex min-w-0 flex-1 gap-px">
            {Array.from({ length: 24 }, (_, hour) => (
              <span
                key={hour}
                className="flex-1 text-center font-mono text-[11px] leading-none text-muted-foreground-2"
              >
                {hour % 4 === 0 ? String(hour).padStart(2, "0") : " "}
              </span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  )
}
