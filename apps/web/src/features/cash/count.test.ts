import { describe, expect, it } from "vitest"

import {
  badCountFields,
  countsFromFields,
  countsTotal,
  denominationLabel,
  hasCount,
  parseCountField,
  rowTotal,
  varianceWords,
} from "@/features/cash/count"

/**
 * Counting a drawer. Every figure is integer pence, and a count is a whole
 * number of notes or coins, never money.
 */

describe("denominations", () => {
  it("names notes in pounds and coins under a pound in pence", () => {
    expect(denominationLabel(5000)).toBe("£50")
    expect(denominationLabel(200)).toBe("£2")
    expect(denominationLabel(100)).toBe("£1")
    expect(denominationLabel(50)).toBe("50p")
    expect(denominationLabel(1)).toBe("1p")
  })

  it("multiplies a row out in pence", () => {
    expect(rowTotal(2000, 3)).toBe(6000)
    expect(rowTotal(5, 7)).toBe(35)
  })
})

describe("count fields", () => {
  it("reads an empty field as none, and a whole number as itself", () => {
    expect(parseCountField("")).toBe(0)
    expect(parseCountField("  ")).toBe(0)
    expect(parseCountField(undefined)).toBe(0)
    expect(parseCountField("12")).toBe(12)
  })

  it("refuses anything that is not a whole count", () => {
    expect(parseCountField("1.5")).toBeNull()
    expect(parseCountField("-2")).toBeNull()
    expect(parseCountField("ten")).toBeNull()
    expect(parseCountField("123456")).toBeNull()
  })

  it("names the fields that are wrong", () => {
    expect(badCountFields({ "2000": "3", "50": "x", "1": "1.5" })).toEqual([50, 1])
    expect(badCountFields({ "2000": "3" })).toEqual([])
  })

  it("leaves out every denomination there is none of", () => {
    expect(countsFromFields({ "2000": "3", "1000": "", "500": "0", "20": "8" })).toEqual({
      "2000": 3,
      "20": 8,
    })
  })
})

describe("the total", () => {
  it("adds a drawer up in pence, with no float arithmetic", () => {
    // £60 + £20 + £20 + £6 + £1.50 + £1.60 + 50p = £109.60
    const counts = countsFromFields({
      "2000": "3",
      "1000": "2",
      "500": "4",
      "100": "6",
      "50": "3",
      "20": "8",
      "10": "5",
    })
    expect(countsTotal(counts)).toBe(10960)
    expect(hasCount(counts)).toBe(true)
  })

  it("counts pennies exactly", () => {
    // Three 10p and three 20p: the sum a float would get wrong.
    expect(countsTotal({ "10": 3, "20": 3 })).toBe(90)
    expect(countsTotal({ "1": 1, "2": 1, "5": 1 })).toBe(8)
  })

  it("ignores what is not a count, and an empty drawer is nothing", () => {
    expect(countsTotal(null)).toBe(0)
    expect(countsTotal({})).toBe(0)
    expect(countsTotal({ "2000": -1, "1000": 1.5 } as never)).toBe(0)
    expect(hasCount({})).toBe(false)
  })
})

describe("the variance in words", () => {
  it("says over, short or exact, never a bare sign", () => {
    expect(varianceWords(240)).toBe("£2.40 over")
    expect(varianceWords(-110)).toBe("£1.10 short")
    expect(varianceWords(0)).toBe("Exact")
    expect(varianceWords(-5)).toBe("£0.05 short")
    expect(varianceWords(123456)).toBe("£1,234.56 over")
  })

  it("says nothing when there is no variance to speak of", () => {
    expect(varianceWords(null)).toBe("")
    expect(varianceWords(undefined)).toBe("")
  })
})
