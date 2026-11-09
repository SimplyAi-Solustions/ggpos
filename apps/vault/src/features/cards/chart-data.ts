/** Range filtering, series building and scaling for the card page's price chart. */

export const RANGES = ["1M", "3M", "6M", "1Y", "All"] as const
export type ChartRange = (typeof RANGES)[number]

const DAYS: Record<ChartRange, number | null> = { "1M": 30, "3M": 91, "6M": 182, "1Y": 365, All: null }

export interface ChartPoint {
  at: string
  pence: number
}

/** One price_snapshots row as the card route returns it. */
export interface HistoryPoint extends ChartPoint {
  source: string
  grader?: string
  grade?: string
  /** "" for a spot price; "avg1", "avg7" or "avg30" for a dated Cardmarket average. */
  basis?: string
}

/** Points inside the range, oldest first, one per day (the latest of that day wins). */
export function pointsInRange(points: readonly ChartPoint[], range: ChartRange, now: Date = new Date()): ChartPoint[] {
  const days = DAYS[range]
  const cutoff = days == null ? "" : new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const byDay = new Map<string, number>()
  for (const p of [...points].sort((a, b) => a.at.localeCompare(b.at))) {
    if (p.at.slice(0, 10) >= cutoff && p.pence >= 0) byDay.set(p.at.slice(0, 10), p.pence)
  }
  return [...byDay.entries()].map(([at, pence]) => ({ at, pence }))
}

export interface ChartScale {
  lo: number
  hi: number
  min: number
  max: number
  t0: number
  t1: number
}

/** One scale for every series drawn together, with a little headroom and the full time span. */
export function scaleFor(series: readonly (readonly ChartPoint[])[]): ChartScale | null {
  const all = series.flat()
  if (all.length < 2) return null
  const values = all.map((p) => p.pence)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min || max || 1) * 0.12
  const times = all.map((p) => new Date(p.at).getTime())
  return { lo: Math.max(0, min - pad), hi: max + pad, min, max, t0: Math.min(...times), t1: Math.max(...times) }
}

export interface SeriesPath {
  line: string
  area: string
  last: { x: number; y: number }
  first: { x: number; y: number }
}

/** SVG path coordinates for one series on a shared scale. Null under two points. */
export function pathOnScale(points: readonly ChartPoint[], scale: ChartScale, width: number, height: number): SeriesPath | null {
  if (points.length < 2) return null
  const xs = points.map((p) => (scale.t1 === scale.t0 ? 0 : ((new Date(p.at).getTime() - scale.t0) / (scale.t1 - scale.t0)) * width))
  const ys = points.map((p) => height - ((p.pence - scale.lo) / (scale.hi - scale.lo)) * height)
  const line = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)} ${ys[i]!.toFixed(1)}`).join(" ")
  const x0 = xs[0]!
  const x1 = xs[xs.length - 1]!
  return {
    line,
    area: `${line} L${x1.toFixed(1)} ${height} L${x0.toFixed(1)} ${height} Z`,
    first: { x: x0, y: ys[0]! },
    last: { x: x1, y: ys[ys.length - 1]! },
  }
}

/** SVG path coordinates for the points in a width x height box, with a little headroom. */
export function chartPath(points: readonly ChartPoint[], width: number, height: number) {
  const scale = scaleFor([points])
  if (!scale) return null
  const path = pathOnScale(points, scale, width, height)!
  return { line: path.line, area: path.area, min: scale.min, max: scale.max, last: path.last }
}

/**
 * One price series for the chart, so sources are never mixed on one line:
 * the source the market figure came from when it has enough history,
 * otherwise the source with the most points.
 */
export function pickSeries<T extends ChartPoint & { source: string }>(history: readonly T[], preferred: string | null | undefined, minPoints = 4): { source: string; points: T[] } {
  const bySource = new Map<string, T[]>()
  for (const p of history) {
    const list = bySource.get(p.source) ?? []
    list.push(p)
    bySource.set(p.source, list)
  }
  const preferredPoints = preferred ? bySource.get(preferred) : undefined
  if (preferred && preferredPoints && preferredPoints.length >= minPoints) return { source: preferred, points: preferredPoints }
  let best: { source: string; points: T[] } = { source: "", points: [] }
  for (const [source, points] of bySource) if (points.length > best.points.length) best = { source, points }
  return best
}

export const SERIES_KEYS = ["raw", "PSA 10", "PSA 9", "ACE 10"] as const
export type SeriesKey = (typeof SERIES_KEYS)[number]

export const SERIES_LABELS: Record<SeriesKey, string> = {
  raw: "Raw NM",
  "PSA 10": "PSA 10",
  "PSA 9": "PSA 9",
  "ACE 10": "ACE 10",
}

export interface Series {
  key: SeriesKey
  /** The one source drawn, "" when there is nothing. */
  source: string
  points: HistoryPoint[]
  /** True when dated Cardmarket averages are part of the line. */
  seeded: boolean
}

/**
 * The points behind one series toggle. Raw NM is every ungraded point of
 * one source (the market's own when it has history), with that source's
 * dated averages included and flagged. A slab series is every point with
 * that grader and grade, UK sold comps preferred over listing reads, so one
 * line never mixes a sale with an asking price.
 */
export function buildSeries(history: readonly HistoryPoint[], key: SeriesKey, preferredSource: string | null | undefined): Series {
  if (key === "raw") {
    const raw = history.filter((p) => !p.grade)
    const picked = pickSeries(raw, preferredSource)
    return { key, source: picked.source, points: picked.points, seeded: picked.points.some((p) => Boolean(p.basis)) }
  }
  const [grader, grade] = key.split(" ")
  const slab = history.filter((p) => p.grader === grader && p.grade === grade)
  const picked = pickSeries(slab, "uk_sold_manual", 2)
  return { key, source: picked.source, points: picked.points, seeded: false }
}

/** Up or down over the shown points as a signed fraction, null under two points or from zero. */
export function changeOver(points: readonly ChartPoint[]): number | null {
  if (points.length < 2) return null
  const first = points[0]!.pence
  const last = points[points.length - 1]!.pence
  if (first <= 0) return null
  return (last - first) / first
}
