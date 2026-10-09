import { describe, expect, it } from "vitest"

import {
  keptLine,
  lineVat,
  marginVat,
  rateFor,
  registeredFromDay,
  resolveVat,
  STANDARD_VAT_RATE,
  standardRateOf,
  treatmentFields,
  treatmentLabel,
  treatmentOf,
  VAT_TREATMENTS,
  vatApplies,
  vatInside,
  vatSummary,
  vatTotal,
} from "../src/vat"

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

describe("the five treatments", () => {
  it("are stored as a scheme and a rate, and read back as themselves", () => {
    expect(treatmentFields("margin")).toEqual({ tax_scheme: "margin", vat_rate: 0 })
    expect(treatmentFields("standard")).toEqual({ tax_scheme: "standard", vat_rate: 0 })
    expect(treatmentFields("reduced")).toEqual({ tax_scheme: "standard", vat_rate: 5 })
    expect(treatmentFields("zero")).toEqual({ tax_scheme: "zero", vat_rate: 0 })
    expect(treatmentFields("exempt")).toEqual({ tax_scheme: "exempt", vat_rate: 0 })
    for (const treatment of VAT_TREATMENTS) {
      const stored = treatmentFields(treatment)
      expect(treatmentOf(stored.tax_scheme, stored.vat_rate)).toBe(treatment)
    }
  })

  it("reads a seeded till product's explicit 20 as standard, and nothing as nothing", () => {
    expect(treatmentOf("standard", 20)).toBe("standard")
    expect(treatmentOf("", 0)).toBeNull()
    expect(treatmentOf(undefined)).toBeNull()
    expect(treatmentOf("vat", 5)).toBeNull()
  })

  it("says each one in words", () => {
    expect(treatmentLabel("standard")).toBe("Standard 20%")
    expect(treatmentLabel("standard", 17.5)).toBe("Standard 17.5%")
    expect(treatmentLabel("reduced")).toBe("Reduced 5%")
    expect(treatmentLabel("zero")).toBe("Zero 0%")
    expect(treatmentLabel("exempt")).toBe("Exempt")
    expect(treatmentLabel("margin")).toBe("Margin scheme")
  })

  it("takes the shop's standard rate from settings, 20 when unset", () => {
    expect(standardRateOf(20)).toBe(20)
    expect(standardRateOf(17.5)).toBe(17.5)
    expect(standardRateOf(0)).toBe(STANDARD_VAT_RATE)
    expect(standardRateOf(undefined)).toBe(STANDARD_VAT_RATE)
    expect(standardRateOf("abc")).toBe(STANDARD_VAT_RATE)
  })
})

describe("the rate a line is charged at", () => {
  const branch5 = { scheme: "standard", rate: 5 }

  it("is the item's or product's own treatment first", () => {
    expect(resolveVat({ own: { scheme: "standard", rate: 0 }, branch: branch5, fallback: "margin", standardRate: 20 })).toEqual({
      scheme: "standard",
      rate: 20,
    })
    expect(resolveVat({ own: { scheme: "zero", rate: 0 }, branch: branch5, fallback: "margin", standardRate: 20 })).toEqual({
      scheme: "zero",
      rate: 0,
    })
    expect(resolveVat({ own: { scheme: "margin", rate: 20 }, branch: null, fallback: "standard", standardRate: 20 })).toEqual({
      scheme: "margin",
      rate: 0,
    })
  })

  it("is the branch's default when the line's own record says nothing", () => {
    expect(resolveVat({ own: { scheme: "", rate: 0 }, branch: branch5, fallback: "margin", standardRate: 20 })).toEqual({
      scheme: "standard",
      rate: 5,
    })
    expect(resolveVat({ own: null, branch: { scheme: "exempt" }, fallback: "standard", standardRate: 20 })).toEqual({
      scheme: "exempt",
      rate: 0,
    })
  })

  it("falls back to margin for stock and standard for a till product", () => {
    expect(resolveVat({ own: { scheme: "" }, branch: { scheme: "" }, fallback: "margin", standardRate: 20 })).toEqual({
      scheme: "margin",
      rate: 0,
    })
    expect(resolveVat({ own: null, branch: null, fallback: "standard", standardRate: 17.5 })).toEqual({
      scheme: "standard",
      rate: 17.5,
    })
  })

  it("keeps a seeded product's explicit rate", () => {
    expect(resolveVat({ own: { scheme: "standard", rate: 20 }, branch: null, fallback: "standard", standardRate: 17.5 })).toEqual({
      scheme: "standard",
      rate: 20,
    })
  })

  it("is charged only on a standard line while registered", () => {
    expect(rateFor({ taxScheme: "zero", rate: 0, vatRegistered: true })).toBe(0)
    expect(lineVat({ gross: 1050, taxScheme: "standard", rate: 5, vatRegistered: true })).toBe(50)
    expect(lineVat({ gross: 1050, taxScheme: "zero", rate: 5, vatRegistered: true })).toBe(0)
  })
})

describe("the registration date", () => {
  it("is a shop-time day, from a bare date or PocketBase's form", () => {
    expect(registeredFromDay("2026-11-01")).toBe("2026-11-01")
    expect(registeredFromDay("2026-11-01 00:00:00.000Z")).toBe("2026-11-01")
    expect(registeredFromDay("")).toBe("")
    expect(registeredFromDay(null)).toBe("")
  })

  it("charges nothing while VAT is off, or before the date", () => {
    const at = new Date("2026-10-20T12:00:00.000Z")
    expect(vatApplies({ registered: false, from: "2026-10-01" }, at)).toBe(false)
    expect(vatApplies({ registered: true, from: "2026-10-21" }, at)).toBe(false)
    expect(vatApplies({ registered: true, from: "2026-10-20" }, at)).toBe(true)
    expect(vatApplies({ registered: true, from: "" }, at)).toBe(true)
  })

  it("reads the date in shop time: half past midnight BST is already the next day", () => {
    // 23:30 UTC on 8 October is 00:30 on 9 October in Bolsover.
    const at = new Date("2026-10-08T23:30:00.000Z")
    expect(vatApplies({ registered: true, from: "2026-10-09" }, at)).toBe(true)
    // In winter shop time is UTC.
    expect(vatApplies({ registered: true, from: "2026-12-09" }, new Date("2026-12-08T23:30:00.000Z"))).toBe(false)
  })
})

describe("margin scheme VAT", () => {
  it("is the rate's fraction of the margin, one sixth at 20 percent, half-up", () => {
    // 230.00 / 6 = 38.333: 38.33.
    expect(marginVat(23000, 20)).toBe(3833)
    // 5.00 / 6 = 0.8333: 0.83.
    expect(marginVat(500, 20)).toBe(83)
    // 0.03 / 6 = 0.005: half-up to 0.01.
    expect(marginVat(3, 20)).toBe(1)
  })

  it("is nothing on a sale at a loss or at cost", () => {
    expect(marginVat(-1200, 20)).toBe(0)
    expect(marginVat(0, 20)).toBe(0)
  })
})

describe("a line as kept after its refunds", () => {
  const options = { inScope: true, standardRate: 20 }

  it("takes the standard VAT inside what was kept, at the rate charged", () => {
    // Two sleeves at 12.00, 4.00 VAT; one goes back: 12.00 kept, 2.00 VAT.
    const sleeves = { net: 2400, qty: 2, unitCost: 600, scheme: "standard", rate: 20 }
    expect(keptLine(sleeves, 0, options)).toEqual({ gross: 2400, cost: 1200, vat: 400, exVat: 2000 })
    expect(keptLine(sleeves, 1, options)).toEqual({ gross: 1200, cost: 600, vat: 200, exVat: 1000 })
    expect(keptLine(sleeves, 2, options)).toEqual({ gross: 0, cost: 0, vat: 0, exVat: 0 })
  })

  it("works a margin line's VAT on what was kept less its cost, inside the registration only", () => {
    // A card sold for 50.00 that cost 45.00: 5.00 margin, 0.83 VAT.
    const card = { net: 5000, qty: 1, unitCost: 4500, scheme: "margin", rate: 0 }
    expect(keptLine(card, 0, options)).toEqual({ gross: 5000, cost: 4500, vat: 83, exVat: 4917 })
    expect(keptLine(card, 1, options)).toEqual({ gross: 0, cost: 0, vat: 0, exVat: 0 })
    expect(keptLine(card, 0, { inScope: false, standardRate: 20 }).vat).toBe(0)
  })

  it("carries nothing on a zero-rated or exempt line", () => {
    expect(keptLine({ net: 270, qty: 1, unitCost: 100, scheme: "zero", rate: 0 }, 0, options).vat).toBe(0)
    expect(keptLine({ net: 720, qty: 1, unitCost: 0, scheme: "exempt", rate: 0 }, 0, options).vat).toBe(0)
  })

  it("adds up across partial refunds to what the whole line came to", () => {
    // Three at 10.01 with a penny of rounding to place: 30.03 in all.
    const line = { net: 3003, qty: 3, unitCost: 0, scheme: "standard", rate: 20 }
    const steps = [0, 1, 2, 3].map((back) => keptLine(line, back, options))
    const vatBack = steps[0]!.vat - steps[3]!.vat
    expect(vatBack).toBe(vatInside(3003, 20))
    expect(steps.map((step) => step.gross)).toEqual([3003, 2002, 1001, 0])
  })
})
