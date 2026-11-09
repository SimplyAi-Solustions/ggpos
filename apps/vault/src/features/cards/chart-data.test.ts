import { describe, expect, it } from "vitest"

import { buildSeries, changeOver, chartPath, pathOnScale, pickSeries, pointsInRange, scaleFor, type HistoryPoint } from "./chart-data"

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
    expect(pointsInRange(pts, "3M", NOW)).toHaveLength(2)
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

describe("scaleFor and pathOnScale", () => {
  it("puts two series on one scale so a slab line sits above the raw line", () => {
    const raw = [{ at: "2026-10-01", pence: 100 }, { at: "2026-11-01", pence: 120 }]
    const slab = [{ at: "2026-10-15", pence: 500 }, { at: "2026-11-01", pence: 520 }]
    const scale = scaleFor([raw, slab])!
    expect(scale.min).toBe(100)
    expect(scale.max).toBe(520)
    expect(scale.t0).toBe(new Date("2026-10-01").getTime())
    const rawPath = pathOnScale(raw, scale, 100, 50)!
    const slabPath = pathOnScale(slab, scale, 100, 50)!
    expect(rawPath.last.y).toBeGreaterThan(slabPath.last.y)
    expect(slabPath.first.x).toBeGreaterThan(0)
    expect(rawPath.area.endsWith("Z")).toBe(true)
  })

  it("has no scale under two points and no path for a one-point series", () => {
    expect(scaleFor([[{ at: "2026-10-01", pence: 1 }]])).toBeNull()
    const scale = scaleFor([[{ at: "2026-10-01", pence: 1 }, { at: "2026-10-02", pence: 2 }]])!
    expect(pathOnScale([{ at: "2026-10-01", pence: 1 }], scale, 10, 10)).toBeNull()
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
    expect(pickSeries(h, "cardmarket", 3).source).toBe("cardmarket")
    expect(pickSeries([], "cardmarket").points).toEqual([])
  })
})

describe("buildSeries", () => {
  const history: HistoryPoint[] = [
    { at: "2026-10-25", pence: 900, source: "cardmarket", basis: "avg30" },
    { at: "2026-11-05", pence: 950, source: "cardmarket", basis: "avg7" },
    { at: "2026-11-08", pence: 980, source: "cardmarket", basis: "avg1" },
    { at: "2026-11-09", pence: 1000, source: "cardmarket" },
    { at: "2026-11-09", pence: 1100, source: "tcgplayer" },
    { at: "2026-11-01", pence: 5000, source: "ebay_uk_asking", grader: "PSA", grade: "10" },
    { at: "2026-11-03", pence: 4800, source: "uk_sold_manual", grader: "PSA", grade: "10" },
    { at: "2026-11-04", pence: 4900, source: "uk_sold_manual", grader: "PSA", grade: "10" },
    { at: "2026-11-04", pence: 2000, source: "ebay_uk_asking", grader: "ACE", grade: "10" },
  ]

  it("draws raw NM from one source, counting the seeded averages and never a slab", () => {
    const raw = buildSeries(history, "raw", "cardmarket")
    expect(raw.source).toBe("cardmarket")
    expect(raw.points).toHaveLength(4)
    expect(raw.seeded).toBe(true)
    expect(raw.points.every((p) => !p.grade)).toBe(true)
  })

  it("draws a slab from its own points, UK sold comps first", () => {
    const psa10 = buildSeries(history, "PSA 10", "cardmarket")
    expect(psa10.source).toBe("uk_sold_manual")
    expect(psa10.points.map((p) => p.pence)).toEqual([4800, 4900])
    const ace = buildSeries(history, "ACE 10", "cardmarket")
    expect(ace.source).toBe("ebay_uk_asking")
    expect(ace.points).toHaveLength(1)
    expect(buildSeries(history, "PSA 9", "cardmarket").points).toEqual([])
  })
})

describe("changeOver", () => {
  it("is the signed fraction from first to last, null when it cannot be", () => {
    expect(changeOver([{ at: "a", pence: 100 }, { at: "b", pence: 125 }])).toBe(0.25)
    expect(changeOver([{ at: "a", pence: 100 }, { at: "b", pence: 50 }])).toBe(-0.5)
    expect(changeOver([{ at: "a", pence: 100 }])).toBeNull()
    expect(changeOver([{ at: "a", pence: 0 }, { at: "b", pence: 5 }])).toBeNull()
  })
})
