/**
 * The busiest slot on a sales heatmap.
 *
 * Its own module because `charts.tsx` exports components and nothing else:
 * a helper beside them stops fast refresh working on the whole file.
 */

/** Monday first, matching the heatmap the sales report is served. */
export const HEATMAP_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export interface HeatmapSlot {
  day: string
  /** 0 to 23, in shop time. */
  hour: number
  count: number
}

/** The slot with the most sales in it, or null when there were none. */
export function busiestSlot(rows: number[][]): HeatmapSlot | null {
  let best: HeatmapSlot | null = null
  rows.forEach((hours, day) => {
    hours.forEach((count, hour) => {
      if (count > 0 && (best === null || count > best.count)) {
        best = { day: HEATMAP_WEEKDAYS[day] ?? "", hour, count }
      }
    })
  })
  return best
}
