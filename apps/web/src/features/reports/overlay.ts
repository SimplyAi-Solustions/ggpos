/**
 * Lining a report's series up with the same period before it.
 *
 * The envelope carries `compare.totals` but no `compare.series`, so the line
 * a chart draws for the earlier period is a second read of the same route
 * over the earlier range. Two ranges of the same length in days can still
 * come back with a different number of buckets once they are grouped by week
 * or month (a range that starts mid-week has a short first bucket), and a
 * bucket paired with the wrong one is worse than no comparison at all: the
 * overlay is left off entirely unless the two line up exactly.
 *
 * Pure, and its own module, so the rule can be checked without a chart.
 */
import type { ReportPoint } from "@/lib/api/types"

export type ChartRow = { label: string } & Record<string, string | number>

/** True when the two series can be drawn against each other bucket for bucket. */
export function canOverlay(series: ReportPoint[], earlier: ReportPoint[]): boolean {
  return series.length > 0 && earlier.length === series.length
}

/**
 * One row per bucket: the period's own figures, plus `compare` carrying the
 * earlier period's headline figure for the bucket in the same position.
 *
 * Positions are counted from the end, so the most recent bucket is paired
 * with the most recent one before it. With equal lengths that is the same as
 * counting from the start; it is written this way because "the latest
 * against the latest" is the comparison anybody reading it means.
 */
export function overlayRows(
  series: ReportPoint[],
  earlier: ReportPoint[],
  headline: string
): ChartRow[] {
  const paired = canOverlay(series, earlier)
  const offset = earlier.length - series.length

  return series.map((point, index) => {
    const row: ChartRow = { label: point.label }
    for (const [key, value] of Object.entries(point.values)) row[key] = value
    if (paired) {
      const other = earlier[index + offset]
      if (other) row.compare = other.values[headline] ?? 0
    }
    return row
  })
}
