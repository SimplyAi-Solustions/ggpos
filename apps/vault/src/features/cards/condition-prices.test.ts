import { describe, expect, it } from "vitest"

import { averageOfLast, conditionPrices, eraFor, type SoldComp } from "./condition-prices"

const NOW = new Date("2026-11-09T12:00:00Z")
const comp = (pence: number, condition: string, sold_at: string): SoldComp => ({ pence, condition, sold_at })

describe("eraFor", () => {
  it("puts WOTC-era sets in vintage and everything later or undated in modern", () => {
    expect(eraFor("1999-01-09")).toBe("vintage")
    expect(eraFor("2003-06-30")).toBe("vintage")
    expect(eraFor("2003-07-01")).toBe("modern")
    expect(eraFor("")).toBe("modern")
  })
})

describe("conditionPrices", () => {
  it("estimates every condition from NM with the modern multipliers when there are no comps", () => {
    const rows = conditionPrices(10_000, [], "modern", NOW)
    expect(rows.map((r) => [r.condition, r.pence, r.estimated])).toEqual([
      ["NM", 10_000, false],
      ["LP", 8_700, true],
      ["MP", 7_300, true],
      ["HP", 5_700, true],
      ["DMG", 3_500, true],
    ])
  })

  it("uses the steeper vintage curve for WOTC cards", () => {
    const rows = conditionPrices(51_795, [], "vintage", NOW)
    expect(rows.find((r) => r.condition === "LP")!.pence).toBe(28_487) // 51,795 x 0.55 = 28,487.25
    expect(rows.find((r) => r.condition === "HP")!.pence).toBe(13_985) // x 0.27 = 13,984.65, half up
    expect(rows.find((r) => r.condition === "DMG")!.pence).toBe(7_769) // x 0.15 = 7,769.25
  })

  it("prices a condition from its own sales once there are enough, and says so", () => {
    const comps = [
      comp(9_000, "LP", "2026-11-01"),
      comp(8_000, "LP", "2026-10-20"),
      comp(8_500, "lp", "2026-10-25"),
      comp(6_000, "MP", "2026-11-02"),
    ]
    const rows = conditionPrices(10_000, comps, "modern", NOW)
    const lp = rows.find((r) => r.condition === "LP")!
    expect(lp).toEqual({ condition: "LP", pence: 8_500, estimated: false, sales: 3, lastSold: "2026-11-01" })
    // One MP sale is too thin: estimated, but the sale still counts and dates.
    const mp = rows.find((r) => r.condition === "MP")!
    expect(mp).toEqual({ condition: "MP", pence: 7_300, estimated: true, sales: 1, lastSold: "2026-11-02" })
  })

  it("bases estimates on NM's own sales over the market figure when NM has comps", () => {
    const comps = [comp(12_000, "NM", "2026-11-05"), comp(11_000, "NM", "2026-11-01")]
    const rows = conditionPrices(10_000, comps, "modern", NOW)
    expect(rows[0]!.pence).toBe(11_500)
    expect(rows.find((r) => r.condition === "LP")!.pence).toBe(10_005) // 11,500 x 0.87
  })

  it("ignores sales older than the window and conditions it does not know", () => {
    const comps = [comp(1, "LP", "2026-01-01"), comp(1, "LP", "2026-01-02"), comp(5, "EX", "2026-11-01")]
    const lp = conditionPrices(1_000, comps, "modern", NOW).find((r) => r.condition === "LP")!
    expect(lp.estimated).toBe(true)
    expect(lp.sales).toBe(0)
  })

  it("leaves everything blank with no NM figure and no comps", () => {
    const rows = conditionPrices(null, [], "modern", NOW)
    expect(rows.every((r) => r.pence === null && !r.estimated)).toBe(true)
  })
})

describe("averageOfLast", () => {
  it("averages the five most recent sales, half up", () => {
    const comps = [
      comp(100, "NM", "2026-11-01"),
      comp(200, "LP", "2026-11-02"),
      comp(301, "NM", "2026-11-03"),
      comp(400, "NM", "2026-11-04"),
      comp(500, "NM", "2026-11-05"),
      comp(9_999, "NM", "2026-01-01"),
    ]
    expect(averageOfLast(comps)).toBe(300) // 1,501 / 5 = 300.2
    expect(averageOfLast([])).toBeNull()
  })
})
