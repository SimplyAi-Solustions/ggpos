import { describe, expect, it } from "vitest"
import { buildReorderLines, reorderTotals, type ReorderReport, type StockRequestView } from "@gg/shared"

import { workbookFiles } from "@/features/reports/excel"
import { reorderBook, reorderFilename, supplierSlug } from "@/features/reorder/excel"

const REQUEST: StockRequestView = {
  id: "r1",
  supplierId: "gw",
  title: "Combat Patrol: Necrons",
  qty: 1,
  customerId: "c1",
  customerName: "Tom Bradbury",
  customerCode: "GGC-9QB3X",
  contactName: "",
  contactPhone: "07700 900456",
  notes: "",
  status: "asked",
  created: "2026-10-12T14:02:00Z",
  statusChangedAt: "2026-10-13T09:00:00Z",
  createdByName: "Jo",
}

function report(): ReorderReport {
  const lines = buildReorderLines(
    [
      {
        id: "a",
        sku: "GGX1",
        title: "Nuln Oil",
        ean: "5011921248056",
        supplierCode: "24-14",
        categoryPath: "Miniatures and paints / Paints",
        onHand: 3,
        shelfTarget: 8,
        price: 470,
        updated: "2026-10-14T10:00:00Z",
      },
      {
        id: "b",
        sku: "GGX2",
        title: "Core Book",
        ean: "",
        supplierCode: "40-01",
        categoryPath: "",
        onHand: 2,
        shelfTarget: null,
        price: 6000,
        updated: "2026-10-01T10:00:00Z",
      },
    ],
    [{ itemId: "a", qty: 6 }]
  )
  return {
    supplier: { id: "gw", name: "Games Workshop", accountNumber: "GW-48213", repName: "Dan", repEmail: "", repPhone: "" },
    from: "2026-10-09",
    to: "2026-10-15",
    lines,
    totals: reorderTotals(lines, [REQUEST]),
    requests: [REQUEST],
  }
}

describe("the supplier call's Excel file", () => {
  it("has To order, Rack and Requests after the cover", () => {
    const book = reorderBook(report(), new Date(2026, 9, 15, 17, 30))
    expect(book.title).toBe("Games Workshop call")
    expect(book.range).toEqual({ from: "2026-10-09", to: "2026-10-15" })
    expect(book.sheets.map((sheet) => sheet.name)).toEqual(["To order", "Rack", "Requests"])
  })

  it("puts only what is to be ordered on the To order sheet", () => {
    const [toOrder] = reorderBook(report()).sheets
    expect(toOrder?.header).toEqual(["Code", "Product", "To order", "In stock", "Keep on shelf", "Barcode"])
    expect(toOrder?.rows).toEqual([
      [
        { kind: "text", value: "24-14" },
        { kind: "text", value: "Nuln Oil" },
        { kind: "count", value: 5 },
        { kind: "count", value: 3 },
        { kind: "count", value: 8 },
        { kind: "text", value: "5011921248056" },
      ],
    ])
  })

  it("writes every product on the Rack with its status in words and its price as money", () => {
    const rack = reorderBook(report()).sheets[1]
    expect(rack?.rows).toHaveLength(2)
    const core = rack?.rows.find((row) => row[0]?.value === "Core Book")
    expect(core?.[5]).toEqual({ kind: "count", value: null })
    expect(core?.[8]).toEqual({ kind: "text", value: "No target" })
    expect(core?.[9]).toEqual({ kind: "money", value: 6000 })
  })

  it("lists the requests with who asked and the status in words", () => {
    const requests = reorderBook(report()).sheets[2]
    expect(requests?.rows[0]?.map((cell) => cell.value)).toEqual([
      "2026-10-12T14:02:00Z",
      "Combat Patrol: Necrons",
      1,
      "Tom Bradbury",
      "GGC-9QB3X",
      "07700 900456",
      "Asked the rep",
      "",
      "Jo",
    ])
  })

  it("builds a workbook Excel can open, money as pounds", () => {
    const files = workbookFiles(reorderBook(report()))
    expect(files["xl/workbook.xml"]).toContain('name="To order"')
    expect(files["xl/worksheets/sheet3.xml"]).toContain("<v>60.00</v>")
  })

  it("names the file after the supplier and the dates", () => {
    expect(supplierSlug("Games Workshop")).toBe("games-workshop")
    expect(supplierSlug("Fantasy Flight & Co.")).toBe("fantasy-flight-and-co")
    expect(supplierSlug("!!!")).toBe("supplier")
    expect(reorderFilename(report())).toBe("gg-vault-reorder-games-workshop-2026-10-09-2026-10-15.xlsx")
  })
})
