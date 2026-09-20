import { describe, expect, it } from "vitest"

import { bandIsEmpty, CONDITIONS, finishLabel, formatBand } from "@/features/estimate/bands"

describe("formatBand", () => {
  it("reads as two GBP figures with a word between them", () => {
    expect(formatBand({ low: 1200, high: 1500 })).toBe("£12.00 to £15.00")
  })

  it("shows one figure when both ends meet", () => {
    expect(formatBand({ low: 500, high: 500 })).toBe("£5.00")
  })

  it("puts the smaller figure first whichever way round it arrives", () => {
    expect(formatBand({ low: 1500, high: 1200 })).toBe("£12.00 to £15.00")
  })

  it("shows sub-pound amounts in pounds, never as pence", () => {
    expect(formatBand({ low: 5, high: 45 })).toBe("£0.05 to £0.45")
  })

  it("groups thousands the way the rest of the app does", () => {
    expect(formatBand({ low: 100_000, high: 123_456 })).toBe("£1,000.00 to £1,234.56")
  })
})

describe("bandIsEmpty", () => {
  it("is true when there is nothing to show", () => {
    expect(bandIsEmpty(null)).toBe(true)
    expect(bandIsEmpty({ low: 0, high: 0 })).toBe(true)
  })

  it("is false as soon as either end is worth something", () => {
    expect(bandIsEmpty({ low: 0, high: 25 })).toBe(false)
  })
})

describe("CONDITIONS", () => {
  it("runs best to worst, which is the order the chips sit in", () => {
    expect(CONDITIONS.map((entry) => entry.value)).toEqual([
      "NM",
      "LP",
      "MP",
      "HP",
      "DMG",
    ])
  })
})

describe("finishLabel", () => {
  it("names the finishes the catalogue uses", () => {
    expect(finishLabel("reverse")).toBe("Reverse holo")
    expect(finishLabel("holo")).toBe("Holo")
  })

  it("makes a readable label out of one it has never seen", () => {
    expect(finishLabel("double_rainbow")).toBe("double rainbow")
  })
})
