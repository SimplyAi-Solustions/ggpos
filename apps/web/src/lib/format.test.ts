import { describe, expect, it } from "vitest"

import { formatPercent } from "@/lib/format"

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

  it("handles a negative change and a figure that is not a number", () => {
    expect(formatPercent(-15.4)).toBe("-15.4%")
    expect(formatPercent(Number.NaN)).toBe("0%")
  })
})
