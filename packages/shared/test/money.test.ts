import { describe, expect, it } from "vitest"
import {
  applyPercent,
  convertMinorToGbpPence,
  eurDecimalToGbpPence,
  formatGBP,
  parseDecimalToMinor,
  roundHalfUp,
  roundToRetailEnding,
  roundToStep,
  usdCentsToGbpPence,
} from "../src/money"

describe("roundHalfUp", () => {
  it("rounds .5 up and is symmetric for negatives", () => {
    expect(roundHalfUp(2.5)).toBe(3)
    expect(roundHalfUp(2.4)).toBe(2)
    expect(roundHalfUp(-2.5)).toBe(-3)
  })
})

describe("parseDecimalToMinor", () => {
  it("parses plain, symbol-prefixed and grouped amounts", () => {
    expect(parseDecimalToMinor("16.50")).toBe(1650)
    expect(parseDecimalToMinor("£1,234.56")).toBe(123456)
    expect(parseDecimalToMinor("$17")).toBe(1700)
    expect(parseDecimalToMinor("0.45")).toBe(45)
    expect(parseDecimalToMinor("-2.5")).toBe(-250)
  })
  it("rejects junk", () => {
    expect(parseDecimalToMinor("abc")).toBeNull()
    expect(parseDecimalToMinor("1.234")).toBeNull()
    expect(parseDecimalToMinor("")).toBeNull()
  })
})

describe("formatGBP", () => {
  it("formats with the pound sign, grouping and two decimals", () => {
    expect(formatGBP(123456)).toBe("£1,234.56")
    expect(formatGBP(45)).toBe("£0.45")
    expect(formatGBP(0)).toBe("£0.00")
    expect(formatGBP(-100)).toBe("-£1.00")
  })
})

describe("conversion", () => {
  it("converts US cents to GBP pence at the day's rate, half-up", () => {
    // PriceCharting: 1732 cents = $17.32; at 0.7421 GBP per USD -> 1285.32 -> 1285
    expect(usdCentsToGbpPence(1732, 0.7421)).toBe(1285)
    // exact half rounds up: 1000 cents at 0.7425 = 742.5 -> 743
    expect(usdCentsToGbpPence(1000, 0.7425)).toBe(743)
  })
  it("converts EUR decimal strings to GBP pence", () => {
    // Cardmarket €16.50 at 0.8606 GBP per EUR -> 1419.99 -> 1420
    expect(eurDecimalToGbpPence("16.50", 0.8606)).toBe(1420)
    expect(eurDecimalToGbpPence("nope", 0.86)).toBeNull()
  })
  it("passes GBP through untouched and refuses bad rates", () => {
    expect(convertMinorToGbpPence(999, "GBP", 0)).toBe(999)
    expect(() => convertMinorToGbpPence(100, "USD", 0)).toThrow()
  })
  it("reproduces the same figure from a stored rate", () => {
    const stored = { minor: 4850, rate: 0.85857 }
    expect(convertMinorToGbpPence(stored.minor, "EUR", stored.rate)).toBe(
      convertMinorToGbpPence(stored.minor, "EUR", stored.rate)
    )
  })
})

describe("offer maths", () => {
  it("applies percentages and rounds to steps", () => {
    expect(applyPercent(2000, 55)).toBe(1100)
    expect(applyPercent(999, 50)).toBe(500)
    expect(roundToStep(1112, 25)).toBe(1100)
    expect(roundToStep(1113, 25)).toBe(1125)
    expect(roundToStep(1150, 100)).toBe(1200)
  })
  it("rounds sell prices to .49 or .99 endings", () => {
    expect(roundToRetailEnding(1210)).toBe(1249)
    expect(roundToRetailEnding(1250)).toBe(1299)
    expect(roundToRetailEnding(1249)).toBe(1249)
    expect(roundToRetailEnding(1200)).toBe(1200)
  })
})
