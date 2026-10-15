import { describe, expect, it } from "vitest"
import type { ReorderLine } from "@gg/shared"

import {
  noStockLine,
  orderText,
  rackEmptyLine,
  rackLines,
  repLine,
  requestWho,
  shelfTargetFromText,
  units,
} from "@/features/reorder/rack"

function line(partial: Partial<ReorderLine> & Pick<ReorderLine, "title">): ReorderLine {
  return {
    key: `title:${partial.title.toLowerCase()}`,
    supplierCode: "",
    ean: "",
    categoryPath: "",
    inStock: 0,
    shelfTarget: 0,
    sold: 0,
    toOrder: 0,
    status: "untracked",
    price: 0,
    itemIds: [],
    sku: "",
    ...partial,
  }
}

/** Already in the shared order: most to order first. */
const LINES: ReorderLine[] = [
  line({ title: "Black Templar", supplierCode: "29-38", ean: "5011921257065", toOrder: 6, status: "out", sold: 4, shelfTarget: 6 }),
  line({ title: "Nuln Oil", supplierCode: "24-14", toOrder: 5, status: "low", sold: 6, inStock: 3, shelfTarget: 8 }),
  line({ title: "Starter Set", ean: "5011921205011", toOrder: 2, status: "out", shelfTarget: 2 }),
  line({ title: "Loose brush", toOrder: 1, status: "low", inStock: 1, shelfTarget: 2 }),
  line({ title: "Core Book", status: "ok", sold: 1, inStock: 2, shelfTarget: 2 }),
  line({ title: "Kill Team", status: "untracked", inStock: 1 }),
]

describe("rackLines", () => {
  it("keeps the shared order for To order, Out of stock and Everything", () => {
    expect(rackLines(LINES, "to_order").map((row) => row.title)).toEqual([
      "Black Templar",
      "Nuln Oil",
      "Starter Set",
      "Loose brush",
    ])
    expect(rackLines(LINES, "out").map((row) => row.title)).toEqual(["Black Templar", "Starter Set"])
    expect(rackLines(LINES, "all")).toHaveLength(6)
  })

  it("leads Sold with what sold most, then by title", () => {
    expect(rackLines(LINES, "sold").map((row) => [row.title, row.sold])).toEqual([
      ["Nuln Oil", 6],
      ["Black Templar", 4],
      ["Core Book", 1],
    ])
  })

  it("never reorders the list it was given", () => {
    const before = LINES.map((row) => row.title)
    rackLines(LINES, "sold")
    expect(LINES.map((row) => row.title)).toEqual(before)
  })
})

describe("orderText", () => {
  it("writes code, title and quantity a line each, falling back to the barcode and then the title", () => {
    expect(orderText(LINES)).toBe(
      ["29-38, Black Templar, 6", "24-14, Nuln Oil, 5", "5011921205011, Starter Set, 2", "Loose brush, 1"].join("\n")
    )
  })

  it("is empty when nothing is to be ordered", () => {
    expect(orderText(LINES.filter((row) => row.toOrder === 0))).toBe("")
  })
})

describe("repLine", () => {
  const full = { repName: "Dan", repPhone: "07700 900321", repEmail: "dan@example.co.uk", accountNumber: "GW-48213" }

  it("says the rep and the account", () => {
    expect(repLine(full)).toBe("Rep: Dan, 07700 900321, dan@example.co.uk. Account GW-48213")
  })

  it("says only what is set", () => {
    expect(repLine({ ...full, repPhone: "", repEmail: "" })).toBe("Rep: Dan. Account GW-48213")
    expect(repLine({ ...full, accountNumber: " " })).toBe("Rep: Dan, 07700 900321, dan@example.co.uk")
    expect(repLine({ repName: "", repPhone: "", repEmail: "", accountNumber: "GW-1" })).toBe("Account GW-1")
    expect(repLine({ repName: "", repPhone: "", repEmail: "", accountNumber: "" })).toBe("")
  })
})

describe("shelfTargetFromText", () => {
  it("reads a whole number, and empty or 0 as no target", () => {
    expect(shelfTargetFromText("4")).toEqual({ ok: true, value: 4 })
    expect(shelfTargetFromText(" 12 ")).toEqual({ ok: true, value: 12 })
    expect(shelfTargetFromText("")).toEqual({ ok: true, value: null })
    expect(shelfTargetFromText("0")).toEqual({ ok: true, value: null })
  })

  it("refuses anything else in the item guard's words", () => {
    for (const text of ["-1", "1.5", "two", "3a"]) {
      expect(shelfTargetFromText(text)).toEqual({
        ok: false,
        message: "Keep on shelf is a whole number, 0 or more.",
      })
    }
  })
})

describe("the empty lines", () => {
  it("say what is empty and what to do", () => {
    expect(noStockLine("Games Workshop")).toBe(
      "No Games Workshop stock yet. Set the supplier and Keep on shelf on an item to put it on this list."
    )
    expect(rackEmptyLine("to_order", "Games Workshop", "")).toBe(
      "Nothing to order. Every product with a target is at or above it."
    )
    expect(rackEmptyLine("sold", "Games Workshop", "between 9 and 15 Oct 2026")).toBe(
      "Nothing sold between 9 and 15 Oct 2026."
    )
    expect(rackEmptyLine("all", "Games Workshop", "")).toBe(noStockLine("Games Workshop"))
  })
})

describe("requestWho and units", () => {
  it("names the member with their code, or the contact", () => {
    expect(requestWho({ customerName: "Tom Bradbury", customerCode: "GGC-9QB3X", contactName: "Tom" })).toEqual({
      name: "Tom Bradbury",
      code: "GGC-9QB3X",
    })
    expect(requestWho({ customerName: "", customerCode: "", contactName: "Sam Whitlock" })).toEqual({
      name: "Sam Whitlock",
      code: "",
    })
  })

  it("says unit or units", () => {
    expect(units(1)).toBe("1 unit")
    expect(units(24)).toBe("24 units")
    expect(units(1200)).toBe("1,200 units")
  })
})
