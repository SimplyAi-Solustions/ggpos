/** Range filtering and scaling for the card page's price chart. */

export const RANGES = ["1M", "3M", "6M", "1Y", "All"] as const
export type ChartRange = (typeof RANGES)[number]

const DAYS: Record<ChartRange, number | null> = { "1M": 30, "3M": 91, "6M": 182, "1Y": 365, All: null }

export interface ChartPoint {
  at: string
  pence: number
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

/** SVG path coordinates for the points in a width x height box, with a little headroom. */
export function chartPath(points: readonly ChartPoint[], width: number, height: number) {
  if (points.length < 2) return null
  const values = points.map((p) => p.pence)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min || max || 1) * 0.12
  const lo = Math.max(0, min - pad)
  const hi = max + pad
  const t0 = new Date(points[0]!.at).getTime()
  const t1 = new Date(points[points.length - 1]!.at).getTime()
  const xs = points.map((p) => (t1 === t0 ? 0 : ((new Date(p.at).getTime() - t0) / (t1 - t0)) * width))
  const ys = points.map((p) => height - ((p.pence - lo) / (hi - lo)) * height)
  const line = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)} ${ys[i]!.toFixed(1)}`).join(" ")
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, min, max, last: { x: xs[xs.length - 1]!, y: ys[ys.length - 1]! } }
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
