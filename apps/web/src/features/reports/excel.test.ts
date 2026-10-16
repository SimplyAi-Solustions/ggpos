import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  buildXlsx,
  cellXml,
  columnName,
  dateSerial,
  dateTimeSerial,
  inferKind,
  poundsText,
  sheet,
  sheetFromCsv,
  sheetName,
  workbookFiles,
  xlsxFilename,
  xmlText,
  type ExcelBook,
} from "@/features/reports/excel"

/**
 * The Excel builder: money as numbers formatted £#,##0.00, dates as dates,
 * one sheet per table and a cover sheet, read back out of the zip it makes.
 */

const MADE = new Date(2026, 9, 9, 20, 48)

function book(): ExcelBook {
  return {
    title: "Sales report",
    range: { from: "2026-10-01", to: "2026-10-09" },
    made: MADE,
    sheets: [
      sheet(
        "Breakdown",
        [
          { label: "Name", kind: "text", value: (row: { name: string; net: number; count: number }) => row.name },
          { label: "Revenue", kind: "money", value: (row) => row.net },
          { label: "Sales", kind: "count", value: (row) => row.count },
        ],
        [
          { name: "Pokémon", net: 123456, count: 3 },
          { name: '=HYPERLINK("x")', net: -5, count: 0 },
        ]
      ),
    ],
  }
}

describe("cells", () => {
  it("writes money as exact pounds from pence, in the £ format", () => {
    expect(poundsText(123456)).toBe("1234.56")
    expect(poundsText(5)).toBe("0.05")
    expect(poundsText(-5)).toBe("-0.05")
    expect(cellXml("B2", { kind: "money", value: 123456 })).toBe('<c r="B2" s="2"><v>1234.56</v></c>')
  })

  it("writes a date as an Excel date, and a moment with its time", () => {
    // 1 January 2026 is day 46023 to Excel, so 9 October is 46304.
    expect(dateSerial("2026-01-01")).toBe(46023)
    expect(dateSerial("2026-10-09")).toBe(46304)
    expect(dateSerial("2026-10-09 14:00:00.000Z")).toBe(46304)
    expect(dateSerial("not a date")).toBeNull()
    expect(dateTimeSerial("2026-10-09 12:00:00.000Z")).toBe(46304.5)
    expect(dateTimeSerial(new Date(2026, 9, 9, 18, 0))).toBe(46304.75)
    expect(cellXml("A2", { kind: "date", value: "2026-10-09" })).toBe('<c r="A2" s="3"><v>46304</v></c>')
  })

  it("writes a percent as its fraction, counts as numbers", () => {
    expect(cellXml("C2", { kind: "percent", value: 33.8 })).toBe('<c r="C2" s="6"><v>0.338</v></c>')
    expect(cellXml("D2", { kind: "count", value: 12 })).toBe('<c r="D2" s="5"><v>12</v></c>')
  })

  it("writes text as text, never a formula, with what XML cannot carry taken out", () => {
    expect(cellXml("A3", { kind: "text", value: '=HYPERLINK("x")' })).toBe(
      '<c r="A3" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t></is></c>'
    )
    expect(xmlText("Tom & Jerry <3\u0007")).toBe("Tom &amp; Jerry &lt;3")
  })

  it("leaves an empty cell out", () => {
    expect(cellXml("A1", { kind: "money", value: null })).toBe("")
    expect(cellXml("A1", { kind: "text", value: "" })).toBe("")
  })

  it("names columns A to Z and on to AA", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"])
  })
})

describe("sheet names", () => {
  it("are at most 31 characters, without the characters Excel refuses, and never twice", () => {
    const used = new Set<string>()
    expect(sheetName("Sales: by day [UTC]", used)).toBe("Sales by day UTC")
    // Cut at 31 characters, and the space the cut left on the end with it.
    expect(sheetName("A very long table heading that goes on and on", used)).toBe("A very long table heading that")
    expect(sheetName("Breakdown", used)).toBe("Breakdown")
    expect(sheetName("breakdown", used)).toBe("breakdown 2")
    expect(sheetName("''", used)).toBe("Sheet")
  })
})

describe("the workbook", () => {
  it("is a zip of a cover sheet and one sheet per table", () => {
    const files = unzipSync(buildXlsx(book()))
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ])
    const workbook = strFromU8(files["xl/workbook.xml"]!)
    expect(workbook).toContain('<sheet name="Cover" sheetId="1" r:id="rId1"/>')
    expect(workbook).toContain('<sheet name="Breakdown" sheetId="2" r:id="rId2"/>')
  })

  it("puts what the file is, its range and when it was made on the cover", () => {
    const cover = workbookFiles(book())["xl/worksheets/sheet1.xml"]!
    expect(cover).toContain(">GG Entertainment<")
    expect(cover).toContain(">Sales report<")
    expect(cover).toContain('<c r="B4" s="3"><v>46296</v></c>')
    expect(cover).toContain('<c r="B5" s="3"><v>46304</v></c>')
    expect(cover).toContain(">9 October 2026 at 20:48<")
    expect(cover).toContain(">Breakdown<")
  })

  it("heads each table in bold, keeps the heading in view, and types every cell", () => {
    const table = workbookFiles(book())["xl/worksheets/sheet2.xml"]!
    expect(table).toContain('state="frozen"')
    expect(table).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Name</t></is></c>')
    expect(table).toContain('<c r="B2" s="2"><v>1234.56</v></c>')
    expect(table).toContain('<c r="C2" s="5"><v>3</v></c>')
    expect(table).toContain('<c r="B3" s="2"><v>-0.05</v></c>')
    expect(table).toContain(">Pokémon<")
  })

  it("formats money as £#,##0.00 and dates as dd/mm/yyyy", () => {
    const styles = workbookFiles(book())["xl/styles.xml"]!
    expect(styles).toContain('formatCode="&quot;£&quot;#,##0.00"')
    expect(styles).toContain('formatCode="dd/mm/yyyy"')
  })

  it("is named beside the CSV", () => {
    expect(xlsxFilename("sales", "2026-10-01", "2026-10-09")).toBe("gg-vault-sales-2026-10-01-2026-10-09.xlsx")
    expect(xlsxFilename("inventory")).toBe("gg-vault-inventory.xlsx")
  })
})

describe("an export's CSV as a sheet", () => {
  it("types money, dates and counts from what is in each column, and leaves codes as text", () => {
    expect(inferKind("Cost", ["12.34", "", "-1.00"])).toBe("money")
    expect(inferKind("Sold", ["2026-10-09", "2026-10-08"])).toBe("date")
    expect(inferKind("Created", ["2026-10-09 14:00:00.000Z"])).toBe("datetime")
    expect(inferKind("Qty", ["1", "12"])).toBe("count")
    expect(inferKind("EAN", ["5012345678900"])).toBe("text")
    expect(inferKind("Phone", ["07700900123"])).toBe("text")
    expect(inferKind("Notes", [])).toBe("text")
  })

  it("reads a file the server sent, money back to pence and the formula guard off", () => {
    const csv = '\ufeffSKU,Title,Qty,Cost,Sold\r\nGG-1,"\'=SUM(A1)",2,12.34,2026-10-09\r\n007,Card,1,0.50,\r\n'
    const read = sheetFromCsv("Inventory", csv)
    expect(read.header).toEqual(["SKU", "Title", "Qty", "Cost", "Sold"])
    expect(read.rows[0]).toEqual([
      { kind: "text", value: "GG-1" },
      { kind: "text", value: "=SUM(A1)" },
      { kind: "count", value: 2 },
      { kind: "money", value: 1234 },
      { kind: "date", value: "2026-10-09" },
    ])
    expect(read.rows[1]?.[0]).toEqual({ kind: "text", value: "007" })
    expect(read.rows[1]?.[4]).toEqual({ kind: "date", value: null })
  })
})
