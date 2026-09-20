import { describe, expect, it } from "vitest"

import { isZeroCostNote, problemRows, reviewRows } from "@/lib/api/imports"
import type { CsvImportRecord } from "@/lib/api/types"

/**
 * The importer writes two different review-kind entries. One is a row it
 * could not match at all and needs a hand; the other is a row it matched and
 * listed with nothing in stock behind it, so the item carries no cost. Only
 * the first belongs in the queue: the second is already written, and putting
 * it in a queue asks somebody to find a card that has already been found.
 */
const record: CsvImportRecord = {
  id: "csv_import_1",
  rows_total: 5,
  rows_ok: 3,
  errors: [
    { row: 4, kind: "review", message: "needs match", name: "Mystery holo", price: 450 },
    {
      row: 2,
      kind: "review",
      message: "Listed card was not in stock. Created with no cost - check it.",
      card: "card_sv151_199",
      sku: "CS-441820",
    },
    { row: 5, kind: "error", message: "The price on this row is not an amount." },
    { row: 3, kind: "already_sold", message: "already sold", custom_label: "CS-441821" },
    { kind: "truncated", message: "40 more not recorded" },
  ],
}

describe("which rows are waiting for a hand", () => {
  it("is the needs-match rows alone, in file order", () => {
    const rows = reviewRows(record)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ row: 4, name: "Mystery holo", price: 450 })
  })

  it("keeps the zero-cost note out of the queue and in what the import did", () => {
    expect(problemRows(record).map((entry) => entry.row)).toEqual([2, 5, 3, undefined])
    expect(problemRows(record).some((entry) => entry.message === "needs match")).toBe(
      false
    )
  })

  it("names the zero-cost note for what it is", () => {
    const note = problemRows(record)[0]
    expect(note && isZeroCostNote(note)).toBe(true)
    expect(isZeroCostNote({ row: 4, kind: "review", message: "needs match" })).toBe(false)
    expect(isZeroCostNote({ row: 5, kind: "error", message: "bad" })).toBe(false)
  })

  it("sorts the queue by line, whatever order the server listed them in", () => {
    const rows = reviewRows({
      id: "x",
      errors: [
        { row: 9, kind: "review", message: "needs match" },
        { row: 2, kind: "review", message: "needs match" },
      ],
    })
    expect(rows.map((entry) => entry.row)).toEqual([2, 9])
  })

  it("reads an import with nothing on it as nothing", () => {
    expect(reviewRows(null)).toEqual([])
    expect(problemRows(null)).toEqual([])
    expect(reviewRows({ id: "x" })).toEqual([])
  })
})
