import { describe, expect, it } from "vitest"

import { canOverlay, overlayRows } from "@/features/reports/overlay"
import type { ReportPoint } from "@/lib/api/types"

function point(label: string, revenue: number): ReportPoint {
  return { label, values: { revenue, count: 1 } }
}

describe("lining a period up with the one before it", () => {
  const series = [point("2026-09-18", 100), point("2026-09-19", 200), point("2026-09-20", 300)]

  it("pairs bucket for bucket when the two are the same length", () => {
    const earlier = [point("2026-09-15", 10), point("2026-09-16", 20), point("2026-09-17", 30)]
    expect(canOverlay(series, earlier)).toBe(true)
    expect(overlayRows(series, earlier, "revenue")).toEqual([
      { label: "2026-09-18", revenue: 100, count: 1, compare: 10 },
      { label: "2026-09-19", revenue: 200, count: 1, compare: 20 },
      { label: "2026-09-20", revenue: 300, count: 1, compare: 30 },
    ])
  })

  it("draws no comparison at all when the bucket counts differ", () => {
    // A weekly grouping can leave the earlier period one bucket short; a
    // bucket paired with the wrong one is worse than none.
    const earlier = [point("2026-09-14", 10), point("2026-09-07", 20)]
    expect(canOverlay(series, earlier)).toBe(false)
    expect(overlayRows(series, earlier, "revenue")).toEqual([
      { label: "2026-09-18", revenue: 100, count: 1 },
      { label: "2026-09-19", revenue: 200, count: 1 },
      { label: "2026-09-20", revenue: 300, count: 1 },
    ])
  })

  it("draws none when there is no earlier period yet", () => {
    expect(canOverlay(series, [])).toBe(false)
    expect(overlayRows(series, [], "revenue").every((row) => !("compare" in row))).toBe(
      true
    )
  })

  it("is empty for an empty series, whatever came before it", () => {
    expect(canOverlay([], [point("2026-09-15", 10)])).toBe(false)
    expect(overlayRows([], [point("2026-09-15", 10)], "revenue")).toEqual([])
  })

  it("carries every value of a bucket, not only the headline", () => {
    const row = overlayRows([point("2026-09-20", 300)], [point("2026-09-19", 30)], "revenue")[0]
    expect(row).toMatchObject({ label: "2026-09-20", revenue: 300, count: 1, compare: 30 })
  })

  it("reads a missing headline on the earlier bucket as nothing, not NaN", () => {
    const earlier: ReportPoint[] = [{ label: "2026-09-19", values: { count: 4 } }]
    expect(overlayRows([point("2026-09-20", 300)], earlier, "revenue")[0]?.compare).toBe(0)
  })
})
