import { describe, expect, it } from "vitest"

import { lineVat, rateFor, STANDARD_VAT_RATE, vatInside, vatSummary, vatTotal } from "../src/vat"

/**
 * VAT is worked out inside each line's gross and rounded half-up per line;
 * the receipt, the sale and the X and Z reports all read the same figures.
 */

describe("VAT inside a gross amount", () => {
  it("is a sixth of the gross at 20 percent", () => {
    expect(vatInside(1200, 20)).toBe(200)
    expect(vatInside(500, 20)).toBe(83)
    expect(vatInside(2400, STANDARD_VAT_RATE)).toBe(400)
  })

  it("rounds half-up, and a refund mirrors its sale", () => {
    // 3 x 20 / 120 = 0.5 exactly: half-up gives 1.
    expect(vatInside(3, 20)).toBe(1)
    expect(vatInside(-3, 20)).toBe(-1)
    // 2 x 20 / 120 = 0.333: down to 0.
    expect(vatInside(2, 20)).toBe(0)
    expect(vatInside(-500, 20)).toBe(-83)
  })

  it("works at fractional rates without a float reaching the penny", () => {
    expect(vatInside(1050, 5)).toBe(50)
    expect(vatInside(1125, 12.5)).toBe(125)
  })

  it("is nothing at a zero rate or on nothing", () => {
    expect(vatInside(1000, 0)).toBe(0)
    expect(vatInside(0, 20)).toBe(0)
  })
})

describe("which lines carry VAT", () => {
  it("only standard rated lines, and only while VAT registered", () => {
    expect(rateFor({ taxScheme: "standard", rate: 20, vatRegistered: true })).toBe(20)
    expect(rateFor({ taxScheme: "standard", rate: 20, vatRegistered: false })).toBe(0)
    expect(rateFor({ taxScheme: "margin", rate: 20, vatRegistered: true })).toBe(0)
    expect(rateFor({ taxScheme: "exempt", rate: 20, vatRegistered: true })).toBe(0)
    expect(lineVat({ gross: 600, taxScheme: "standard", rate: 20, vatRegistered: true })).toBe(100)
    expect(lineVat({ gross: 600, taxScheme: "margin", rate: 20, vatRegistered: true })).toBe(0)
  })
})

describe("the per-rate summary", () => {
  it("groups by rate, highest first, with net plus VAT equal to gross", () => {
    const lines = [
      { gross: 500, rate: 20, vat: 83 },
      { gross: 700, rate: 20, vat: 117 },
      { gross: 1050, rate: 5, vat: 50 },
      { gross: 2000, rate: 0, vat: 0 },
    ]
    expect(vatSummary(lines)).toEqual([
      { rate: 20, net: 1000, vat: 200, gross: 1200 },
      { rate: 5, net: 1000, vat: 50, gross: 1050 },
    ])
    expect(vatTotal(lines)).toBe(250)
  })

  it("is empty when nothing carried VAT", () => {
    expect(vatSummary([{ gross: 1000, rate: 0, vat: 0 }])).toEqual([])
  })
})
