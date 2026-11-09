import { describe, expect, it } from "vitest"

import {
  MAX_COPIES,
  printableRows,
  printLabelText,
  remainingAfter,
  startingCopies,
  totalLabels,
  type PriceLabelItem,
} from "./plan"

const item = (id: string, price: number, copies = 1): PriceLabelItem => ({
  id,
  sku: `GGX${id}`,
  title: `Item ${id}`,
  price,
  copies,
})

describe("price label counts", () => {
  it("starts on one label per unit, at least one and no more than a roll", () => {
    expect(startingCopies(6)).toBe(6)
    expect(startingCopies(0)).toBe(1)
    expect(startingCopies(undefined)).toBe(1)
    expect(startingCopies(2.7)).toBe(2)
    expect(startingCopies(999)).toBe(MAX_COPIES)
  })

  it("prints the priced rows only, at the counts on the sheet", () => {
    const items = [item("a", 1500, 2), item("b", 0, 3), item("c", 499, 1)]
    const rows = printableRows(items, { a: 4, c: 1 })
    expect(rows.map((row) => [row.item.id, row.copies])).toEqual([
      ["a", 4],
      ["c", 1],
    ])
    expect(totalLabels(rows)).toBe(5)
  })

  it("leaves out a row whose count was cleared, and keeps any count under a roll", () => {
    const items = [item("a", 1500, 2), item("c", 499, 1)]
    expect(printableRows(items, { a: "", c: 500 }).map((row) => row.copies)).toEqual([MAX_COPIES])
  })

  it("falls back to the caller's count for a row the sheet has not touched", () => {
    expect(printableRows([item("a", 100, 3)], {}).map((row) => row.copies)).toEqual([3])
  })

  it("works out what is left after the printer stops part way", () => {
    const rows = [
      { item: { id: "a" }, copies: 2 },
      { item: { id: "b" }, copies: 3 },
      { item: { id: "c" }, copies: 1 },
    ]
    expect(remainingAfter(rows, 2)).toEqual({ a: "", b: 3, c: 1 })
    expect(remainingAfter(rows, 5)).toEqual({ a: "", b: "", c: 1 })
    expect(remainingAfter(rows, 0)).toEqual({ a: 2, b: 3, c: 1 })
  })

  it("says how many the button prints", () => {
    expect(printLabelText(1)).toBe("Print 1 label")
    expect(printLabelText(12)).toBe("Print 12 labels")
  })
})
