import { describe, expect, it } from "vitest"

import {
  buildCsv,
  csvCell,
  csvFilename,
  csvRow,
  poundsCell,
} from "@/features/reports/csv"
import {
  REPORT_SPECS,
  countColumn,
  moneyColumn,
  percentColumn,
  textColumn,
} from "@/features/reports/specs"

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

describe("the column specs the table and the file share", () => {
  it("writes a money column as pounds and pence, never a float", () => {
    const column = moneyColumn("revenue", "Revenue")
    // 500 / 100 is 5 in JavaScript, and "5" is not money.
    expect(column.csv?.({ revenue: 500 })).toBe("5.00")
    expect(column.csv?.({ revenue: 1234 })).toBe("12.34")
    expect(column.csv?.({ revenue: -50 })).toBe("-0.50")
    expect(column.csv?.({ revenue: 0 })).toBe("0.00")
    // What it shows and what it exports are the same amount.
    expect(column.text({ revenue: 500 })).toBe("£5.00")
  })

  it("writes a count and a percent as plain numbers", () => {
    expect(countColumn("count", "Sales").csv?.({ count: 1200 })).toBe(1200)
    expect(countColumn("count", "Sales").text({ count: 1200 })).toBe("1,200")
    expect(percentColumn("rate", "Rate").csv?.({ rate: 44.2 })).toBe(44.2)
    expect(percentColumn("rate", "Rate").text({ rate: 44.2 })).toBe("44.2%")
  })

  it("reads a missing or unreadable figure as zero rather than NaN", () => {
    const column = moneyColumn("revenue", "Revenue")
    expect(column.csv?.({})).toBe("0.00")
    expect(column.text({ revenue: "nonsense" })).toBe("£0.00")
    expect(textColumn("label", "Name").text({})).toBe("")
  })

  it("sorts a money column on its pence and a name on its own text", () => {
    expect(moneyColumn("revenue", "Revenue").sortValue?.({ revenue: 1234 })).toBe(1234)
    expect(textColumn("label", "Name").sortValue?.({ label: "Pokemon" })).toBe("pokemon")
  })

  it("puts every column of a report through the same writer", () => {
    const rows = [{ label: "Pokemon", revenue: 500, count: 2 }]
    const text = buildCsv(
      REPORT_SPECS.sales.columns.map((column) => ({
        label: column.label,
        value: (row: typeof rows[number]) =>
          column.csv ? column.csv(row) : column.text(row),
      })),
      rows
    )
    expect(text).toBe("Name,Revenue,Sales\r\nPokemon,5.00,2\r\n")
  })
})
