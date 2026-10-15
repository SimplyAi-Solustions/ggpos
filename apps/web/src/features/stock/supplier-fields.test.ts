import { describe, expect, it } from "vitest"

import {
  addStockSchema,
  shelfTargetValue,
  takesSupplier,
  valuesFromItem,
} from "@/features/stock/schema"
import { supplierFieldsOf, supplierPatchBody } from "@/lib/api/item-shape"
import type { StockItemRecord } from "@/lib/api/types"

/**
 * The supplier, Keep on shelf and supplier code on Add stock and the item
 * page (docs/api-contract-reorder.md, section 4.3), and Add more of this.
 */

const BOX: StockItemRecord = {
  id: "item_gw_cp_sm_2",
  sku: "GGX0000000",
  kind: "other",
  game: "game_warhammer",
  category: "cat_minis_warhammer40000",
  title: "Combat Patrol: Space Marines",
  ean: "5011921171484",
  qty: 1,
  cost: 5700,
  price: 123456,
  tax_scheme: "standard",
  vat_rate: 0,
  status: "in_stock",
  location: "loc_storeroom",
  supplier: "supplier_gw",
  shelf_target: 4,
  supplier_code: "48-75",
}

const sealed = {
  gameId: "game_warhammer",
  kind: "sealed" as const,
  title: "Combat Patrol: Necrons",
  qty: 2,
  cost: "57.00",
  price: "95.00",
}

describe("which kinds take a supplier", () => {
  it("is every kind but a card single and a graded card", () => {
    expect(takesSupplier("single")).toBe(false)
    expect(takesSupplier("graded")).toBe(false)
    for (const kind of ["retro", "sealed", "accessory", "other"]) expect(takesSupplier(kind)).toBe(true)
  })
})

describe("Add more of this", () => {
  it("fills the form from the row and leaves the quantity to count", () => {
    expect(valuesFromItem(BOX)).toEqual({
      kind: "other",
      gameId: "game_warhammer",
      categoryId: "cat_minis_warhammer40000",
      title: "Combat Patrol: Space Marines",
      ean: "5011921171484",
      price: "1234.56",
      cost: "57.00",
      taxScheme: "standard",
      locationId: "loc_storeroom",
      supplierId: "supplier_gw",
      shelfTarget: "4",
      supplierCode: "48-75",
      qty: "",
    })
  })

  it("keeps a one-per-row kind at one, and a card's supplier fields empty", () => {
    expect(valuesFromItem({ ...BOX, kind: "retro" }).qty).toBe(1)
    expect(valuesFromItem({ ...BOX, kind: "single" })).toMatchObject({
      supplierId: "",
      shelfTarget: "",
      supplierCode: "",
      qty: 1,
    })
  })

  it("carries the VAT treatment and no target as empty", () => {
    expect(valuesFromItem({ ...BOX, vat_rate: 5, shelf_target: 0 })).toMatchObject({
      taxScheme: "reduced",
      shelfTarget: "",
    })
  })
})

describe("the Add stock checks", () => {
  function errors(input: unknown): Record<string, string> {
    const result = addStockSchema.safeParse(input)
    if (result.success) return {}
    return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join("."), issue.message]))
  }

  it("takes a supplier, a whole-number target and a code", () => {
    expect(errors({ ...sealed, supplierId: "supplier_gw", shelfTarget: "6", supplierCode: "49-41" })).toEqual({})
    expect(errors({ ...sealed, shelfTarget: "" })).toEqual({})
  })

  it("refuses a target that is not a whole number, and an empty quantity", () => {
    expect(errors({ ...sealed, shelfTarget: "-1" }).shelfTarget).toBe("Keep on shelf is a whole number, 0 or more.")
    expect(errors({ ...sealed, shelfTarget: "2.5" }).shelfTarget).toBe("Keep on shelf is a whole number, 0 or more.")
    expect(errors({ ...sealed, qty: "" }).qty).toBe("Quantity is at least 1.")
  })

  it("reads the target as stored: a whole number, or none", () => {
    expect(shelfTargetValue("6")).toBe(6)
    expect(shelfTargetValue(" 0 ")).toBeNull()
    expect(shelfTargetValue("")).toBeNull()
    expect(shelfTargetValue(undefined)).toBeNull()
  })
})

describe("the item page's supplier fields", () => {
  it("reads them off the row, a 0 target as none", () => {
    expect(supplierFieldsOf(BOX, "Games Workshop")).toEqual({
      supplierId: "supplier_gw",
      supplierName: "Games Workshop",
      shelfTarget: 4,
      supplierCode: "48-75",
    })
    expect(supplierFieldsOf({ shelf_target: 0 }, "Games Workshop")).toEqual({
      supplierId: "",
      supplierName: "",
      shelfTarget: null,
      supplierCode: "",
    })
  })

  it("writes only what the patch names, clearing with null and 0", () => {
    expect(supplierPatchBody({})).toEqual({})
    expect(supplierPatchBody({ supplierId: "", shelfTarget: null, supplierCode: " 48-75 " })).toEqual({
      supplier: null,
      shelf_target: 0,
      supplier_code: "48-75",
    })
    expect(supplierPatchBody({ supplierId: "supplier_gw", shelfTarget: 6 })).toEqual({
      supplier: "supplier_gw",
      shelf_target: 6,
    })
  })
})
