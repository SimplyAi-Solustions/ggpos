import { describe, expect, it } from "vitest"

import {
  buildReorderLines,
  defaultReorderPeriod,
  isOpenRequest,
  productKey,
  reorderStatus,
  reorderTotals,
  unitsToOrder,
  type ReorderItem,
} from "../src/reorder"

/**
 * The supplier reorder report's adding up (docs/api-contract-reorder.md),
 * against the same rack the backend check stocks
 * (pb/scripts/checks/38-reorder.sh).
 */

function row(partial: Partial<ReorderItem> & Pick<ReorderItem, "id" | "title">): ReorderItem {
  return {
    sku: `GGP-${partial.id.toUpperCase()}`,
    ean: "",
    supplierCode: "",
    categoryPath: "Miniatures and paints / Warhammer 40,000",
    onHand: 0,
    shelfTarget: null,
    price: 0,
    updated: "2026-10-01T10:00:00Z",
    ...partial,
  }
}

describe("productKey", () => {
  it("joins restocks by supplier code, then barcode, then title", () => {
    expect(productKey({ supplierCode: " 99120101234 ", ean: "5011921", title: "Box" })).toBe("code:99120101234")
    expect(productKey({ supplierCode: "", ean: "5011921", title: "Box" })).toBe("ean:5011921")
    expect(productKey({ supplierCode: "", ean: "", title: "  Combat  Patrol " })).toBe("title:combat patrol")
  })
})

describe("reorderStatus and unitsToOrder", () => {
  it("say out of stock at nothing on hand, whatever the target", () => {
    expect(reorderStatus(0, 3)).toBe("out")
    expect(reorderStatus(0, 0)).toBe("out")
  })

  it("compare what is on hand with the target", () => {
    expect(reorderStatus(1, 3)).toBe("low")
    expect(reorderStatus(3, 3)).toBe("ok")
    expect(reorderStatus(5, 3)).toBe("ok")
    expect(reorderStatus(2, 0)).toBe("untracked")
  })

  it("top the shelf back up, and order nothing without a target", () => {
    expect(unitsToOrder(0, 3)).toBe(3)
    expect(unitsToOrder(1, 3)).toBe(2)
    expect(unitsToOrder(4, 3)).toBe(0)
    expect(unitsToOrder(0, 0)).toBe(0)
  })
})

describe("buildReorderLines", () => {
  const items: ReorderItem[] = [
    // Sold out last month and restocked this week: two rows, one product.
    row({ id: "a1", title: "Combat Patrol: Space Marines", supplierCode: "99120101", onHand: 0, shelfTarget: 3, price: 9500, updated: "2026-09-01T10:00:00Z" }),
    row({ id: "a2", title: "Combat Patrol: Space Marines", supplierCode: "99120101", onHand: 1, shelfTarget: 3, price: 9900, updated: "2026-10-10T10:00:00Z", sku: "GGP-A2NEW" }),
    // Stocked to target.
    row({ id: "b1", title: "Citadel Contrast: Black Templar", ean: "5011921", onHand: 6, shelfTarget: 6, price: 525 }),
    // Out, with a target.
    row({ id: "c1", title: "Warhammer 40,000 Starter Set", onHand: 0, shelfTarget: 2, price: 6000 }),
    // No target, still in stock.
    row({ id: "d1", title: "Kill Team: Hivestorm", onHand: 1, shelfTarget: null, price: 13000 }),
  ]
  const sold = [
    { itemId: "a1", qty: 2 },
    { itemId: "a2", qty: 1 },
    { itemId: "b1", qty: 4 },
    { itemId: "zz", qty: 9 },
  ]
  const lines = buildReorderLines(items, sold)

  const byTitle = (title: string) => lines.find((line) => line.title === title)

  it("is one line per product, the most to order first and sold out before low", () => {
    expect(lines.map((line) => line.title)).toEqual([
      "Warhammer 40,000 Starter Set",
      "Combat Patrol: Space Marines",
      "Citadel Contrast: Black Templar",
      "Kill Team: Hivestorm",
    ])
  })

  it("adds up the rows of one product and names it from the newest", () => {
    const patrol = byTitle("Combat Patrol: Space Marines")
    expect(patrol).toMatchObject({
      key: "code:99120101",
      inStock: 1,
      shelfTarget: 3,
      sold: 3,
      toOrder: 2,
      status: "low",
      price: 9900,
      sku: "GGP-A2NEW",
    })
    expect(patrol?.itemIds.sort()).toEqual(["a1", "a2"])
  })

  it("orders an out-of-stock product back up to its target", () => {
    expect(byTitle("Warhammer 40,000 Starter Set")).toMatchObject({ inStock: 0, shelfTarget: 2, toOrder: 2, status: "out", sold: 0 })
  })

  it("orders nothing for a product kept to no target", () => {
    expect(byTitle("Kill Team: Hivestorm")).toMatchObject({ status: "untracked", toOrder: 0, shelfTarget: 0 })
  })

  it("adds up the figures for the top of the report", () => {
    const totals = reorderTotals(lines, [{ status: "waiting" }, { status: "arrived" }, { status: "collected" }])
    expect(totals).toEqual({
      products: 4,
      onTarget: 3,
      inStock: 8,
      sold: 7,
      outOfStock: 1,
      belowTarget: 1,
      toOrder: 4,
      openRequests: 2,
    })
  })
})

describe("requests and the period", () => {
  it("keeps a request open until it is collected or cancelled", () => {
    expect(isOpenRequest("waiting")).toBe(true)
    expect(isOpenRequest("arrived")).toBe(true)
    expect(isOpenRequest("collected")).toBe(false)
    expect(isOpenRequest("cancelled")).toBe(false)
  })

  it("defaults to the last seven days, both ends counted", () => {
    expect(defaultReorderPeriod("2026-10-15")).toEqual({ from: "2026-10-09", to: "2026-10-15" })
    expect(defaultReorderPeriod("2026-03-03")).toEqual({ from: "2026-02-25", to: "2026-03-03" })
  })
})
