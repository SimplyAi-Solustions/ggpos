import { describe, expect, it } from "vitest"

import {
  buildCsv,
  csvCell,
  csvFilename,
  csvRow,
  poundsCell,
} from "@/features/reports/csv"

describe("the report CSV's formula-injection guard", () => {
  it("quotes a cell that opens with a formula character", () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(
      `"'=HYPERLINK(""http://x"",""click"")"`
    )
    expect(csvCell("+44 7700 900000")).toBe("\"'+44 7700 900000\"")
    expect(csvCell("@everyone")).toBe("\"'@everyone\"")
    expect(csvCell("-lead dash")).toBe("\"'-lead dash\"")
    expect(csvCell("\tleading tab")).toBe('"\'\tleading tab"')
    expect(csvCell("\rleading return")).toBe('"\'\rleading return"')
  })

  it("leaves a plain number alone, negative figures included", () => {
    // The server exempts numbers for exactly this reason: a negative margin
    // has to stay a number in the money column, not become text.
    expect(csvCell("-12.34")).toBe("-12.34")
    expect(csvCell(-1234)).toBe("-1234")
    expect(csvCell("0")).toBe("0")
  })

  it("quotes commas, quotes and newlines the ordinary way", () => {
    expect(csvCell("Charizard ex, holo")).toBe('"Charizard ex, holo"')
    expect(csvCell('He said "hello"')).toBe('"He said ""hello"""')
    expect(csvCell("two\nlines")).toBe('"two\nlines"')
  })

  it("writes an empty cell for nothing at all", () => {
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
    expect(csvCell("")).toBe("")
  })
})

describe("money in a CSV", () => {
  it("is pounds and pence from integer pence, with no symbol", () => {
    expect(poundsCell(1234)).toBe("12.34")
    expect(poundsCell(45)).toBe("0.45")
    expect(poundsCell(0)).toBe("0.00")
    expect(poundsCell(100_000)).toBe("1000.00")
    expect(poundsCell(-1250)).toBe("-12.50")
    expect(poundsCell(-5)).toBe("-0.05")
  })
})

describe("building a file", () => {
  interface Row {
    label: string
    revenue: number
  }

  const columns = [
    { label: "Game", value: (row: Row) => row.label },
    { label: "Revenue", value: (row: Row) => poundsCell(row.revenue) },
  ]

  it("puts the column labels on the first line and CRLF between rows", () => {
    const text = buildCsv(columns, [
      { label: "Pokemon", revenue: 42_950 },
      { label: "=Magic", revenue: -500 },
    ])
    expect(text).toBe(
      "Game,Revenue\r\nPokemon,429.50\r\n\"'=Magic\",-5.00\r\n"
    )
  })

  it("writes a header row on its own when there is nothing to export", () => {
    expect(buildCsv(columns, [])).toBe("Game,Revenue\r\n")
  })

  it("joins a row with commas and one line ending", () => {
    expect(csvRow(["a", 1, null])).toBe("a,1,\r\n")
  })
})

describe("the file name", () => {
  it("carries the report and both ends of the range", () => {
    expect(csvFilename("sales", "2026-09-01", "2026-09-20")).toBe(
      "gg-vault-sales-2026-09-01-2026-09-20.csv"
    )
  })
})
