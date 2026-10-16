import { describe, expect, it } from "vitest"

import { formatPercent } from "@/lib/format"
import { percentColumn } from "@/features/reports/specs"

describe("formatPercent", () => {
  it("writes a whole number with no decimal and no space", () => {
    expect(formatPercent(10)).toBe("10%")
    expect(formatPercent(0)).toBe("0%")
    expect(formatPercent(100)).toBe("100%")
  })

  it("keeps one decimal place where the figure has one", () => {
    expect(formatPercent(32.6)).toBe("32.6%")
    expect(formatPercent(44.25)).toBe("44.3%")
  })

  it("drops a trailing zero rather than printing 10.0%", () => {
    expect(formatPercent(10.04)).toBe("10%")
    expect(formatPercent(3.0)).toBe("3%")
  })

  it("rounds a negative half away from zero, the way roundHalfUp does", () => {
    // Math.round would give -15.4%, -2.2% and 0%, disagreeing with every
    // other figure in the app.
    expect(formatPercent(-15.45)).toBe("-15.5%")
    expect(formatPercent(-2.25)).toBe("-2.3%")
    expect(formatPercent(-0.05)).toBe("-0.1%")
    expect(formatPercent(-15.4)).toBe("-15.4%")
  })

  it("has nothing to show for a figure that is not a figure", () => {
    expect(formatPercent(Number.NaN)).toBe("")
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("")
    expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe("")
    expect(formatPercent(undefined)).toBe("")
    expect(formatPercent(null)).toBe("")
  })

  it("formats a fraction of a percent rather than a fraction of one", () => {
    // 0.4 is four tenths of a percent, not forty percent: the caller passes
    // percentages, never ratios.
    expect(formatPercent(0.4)).toBe("0.4%")
    expect(formatPercent(0.04)).toBe("0%")
  })
})

describe("the call sites", () => {
  it("prints a report's percent column through the one format", () => {
    const column = percentColumn("rate", "Rate")
    expect(column.text({ rate: 44.2 })).toBe("44.2%")
    expect(column.text({ rate: 52 })).toBe("52%")
    // A missing figure is a zero in a report, not a blank: `num` reads it as
    // one before the format is asked for a percentage at all.
    expect(column.text({})).toBe("0%")
  })
})
