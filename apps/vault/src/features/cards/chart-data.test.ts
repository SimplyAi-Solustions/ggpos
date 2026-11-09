import { describe, expect, it } from "vitest"

import { chartPath, pickSeries, pointsInRange } from "./chart-data"

const NOW = new Date("2026-11-09T00:00:00Z")

describe("pointsInRange", () => {
  it("keeps the range and the latest figure per day, oldest first", () => {
    const pts = [
      { at: "2026-11-01", pence: 120 },
      { at: "2026-05-01", pence: 90 },
      { at: "2026-10-20", pence: 100 },
      { at: "2026-11-01", pence: 130 },
    ]
    expect(pointsInRange(pts, "1M", NOW)).toEqual([
      { at: "2026-10-20", pence: 100 },
      { at: "2026-11-01", pence: 130 },
    ])
    expect(pointsInRange(pts, "All", NOW)).toHaveLength(3)
  })
})

describe("chartPath", () => {
  it("needs two points and reports the range", () => {
    expect(chartPath([{ at: "2026-11-01", pence: 1 }], 100, 50)).toBeNull()
    const path = chartPath([{ at: "2026-11-01", pence: 100 }, { at: "2026-11-02", pence: 200 }], 100, 50)!
    expect(path.min).toBe(100)
    expect(path.max).toBe(200)
    expect(path.line.startsWith("M0.0")).toBe(true)
    expect(path.last.x).toBe(100)
  })
})

describe("pickSeries", () => {
  it("keeps to one source, preferring the market's own when it has history", () => {
    const h = [
      { at: "2026-10-01", pence: 1, source: "cardmarket" },
      { at: "2026-10-02", pence: 2, source: "cardmarket" },
      { at: "2026-10-03", pence: 3, source: "cardmarket" },
      { at: "2026-10-04", pence: 9, source: "uk_sold_manual" },
    ]
    expect(pickSeries(h, "uk_sold_manual").source).toBe("cardmarket")
    expect(pickSeries(h, "cardmarket", 2).points).toHaveLength(3)
  })
})
