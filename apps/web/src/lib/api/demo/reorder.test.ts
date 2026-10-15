import { beforeEach, describe, expect, it } from "vitest"
import { ClientResponseError } from "pocketbase"
import { defaultReorderPeriod } from "@gg/shared"

import { todayIso } from "@/lib/api/dates"
import { DEMO_GAMES } from "@/lib/api/fixtures"
import { cardSearchGames, isLookupGame, LOOKUP_GAMES } from "@/lib/api/lookup"
import { demoCategoryId, demoCategoryTree, demoFileKey, reorderDefaultGame } from "@/lib/api/demo/categories"
import { getItem, updateItem } from "@/lib/api/demo/items"
import {
  demoCreateRequest,
  demoListRequests,
  demoReorderReport,
  demoSetShelfTarget,
  demoUpdateRequest,
  resetDemoRequests,
} from "@/lib/api/demo/reorder"
import { demoSales, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import { DEMO_SUPPLIER_STOCK } from "@/lib/api/demo/supplier-stock"
import { DEMO_ASMODEE_ID, DEMO_GW_ID, demoSaveSupplier, demoSuppliers } from "@/lib/api/demo/suppliers"

/**
 * The supplier call in demo mode (docs/api-contract-reorder.md, section
 * 4.1), which the e2e suite and every screenshot rest on: the Games
 * Workshop rack adds up to the hand-worked figures in
 * `demo/supplier-stock.ts`, through the shared adding up, and requests and
 * targets refuse in the hooks' own words.
 */

function refusal(run: () => unknown): { status: number; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof ClientResponseError) return { status: error.status, message: error.message }
    throw error
  }
  throw new Error("expected a refusal")
}

const week = () => defaultReorderPeriod(todayIso())
const report = () => demoReorderReport({ supplierId: DEMO_GW_ID, ...week() })

/** The rack's seeded targets, so a test that changes one leaves it as it was. */
function restoreTargets() {
  for (const seed of DEMO_SUPPLIER_STOCK) {
    const row = itemStore().find((item) => item.id === seed.id)
    if (row) row.shelf_target = seed.shelf_target
  }
}

beforeEach(() => {
  ensureSeeded()
  resetDemoRequests()
  restoreTargets()
})

describe("the Games Workshop call over the last seven days", () => {
  it("adds up to the hand-worked figures", () => {
    expect(report().totals).toEqual({
      products: 12,
      onTarget: 10,
      inStock: 20,
      sold: 25,
      outOfStock: 3,
      belowTarget: 4,
      toOrder: 24,
      openRequests: 3,
    })
  })

  it("puts the most to order first, then out of stock, below target, stocked and untargeted", () => {
    expect(report().lines.map((line) => [line.title, line.toOrder, line.status])).toEqual([
      ["Citadel Contrast: Black Templar", 6, "out"],
      ["Citadel Shade: Nuln Oil", 5, "low"],
      ["Citadel Base: Abaddon Black", 4, "low"],
      ["Combat Patrol: Necrons", 3, "out"],
      ["Combat Patrol: Space Marines", 3, "low"],
      ["Citadel Large Base Brush", 2, "out"],
      ["Spearhead: Stormcast Eternals", 1, "low"],
      ["Citadel Spray: Chaos Black", 0, "ok"],
      ["Citadel Tools: Plastic Glue", 0, "ok"],
      ["Warhammer 40,000 Core Book", 0, "ok"],
      ["Kill Team: Starter Set", 0, "untracked"],
      ["Stormcast Eternals: Vindictors", 0, "untracked"],
    ])
  })

  it("counts the restocked product once, opens its row with stock, and keeps the refund off", () => {
    const lines = report().lines
    const marines = lines.find((line) => line.title === "Combat Patrol: Space Marines")
    expect(marines).toMatchObject({
      supplierCode: "48-75",
      inStock: 1,
      shelfTarget: 4,
      sold: 3,
      itemIds: ["item_gw_cp_sm_1", "item_gw_cp_sm_2"],
      categoryPath: "Miniatures and paints / Warhammer 40,000",
    })
    expect(marines?.sku).toBe(itemStore().find((item) => item.id === "item_gw_cp_sm_2")?.sku)
    // Two sold, one refunded, then one more: two kept.
    expect(lines.find((line) => line.title === "Combat Patrol: Necrons")?.sold).toBe(2)
  })

  it("counts a sale rung up on the demo till since, by its day", () => {
    const before = report().totals.sold
    demoSales.push({
      id: "sale_test_gw",
      number: "GG-S-999999",
      customerName: null,
      status: "complete",
      created: new Date().toISOString(),
      lines: [
        {
          id: "line_test_gw",
          sale: "sale_test_gw",
          item: "item_gw_vindictors",
          qty: 2,
          refunded_qty: 1,
          unit_price: 3500,
          sku: "",
          title: "Stormcast Eternals: Vindictors",
        },
      ],
    })
    try {
      expect(report().totals.sold).toBe(before + 1)
    } finally {
      demoSales.splice(demoSales.findIndex((sale) => sale.id === "sale_test_gw"), 1)
    }
  })

  it("leaves out the sale ten days ago, and finds it over a longer range", () => {
    const today = todayIso()
    const month = demoReorderReport({
      supplierId: DEMO_GW_ID,
      from: new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10),
      to: today,
    })
    expect(month.totals.sold).toBe(26)
  })

  it("says who to ring and lists only the open requests, oldest first", () => {
    const answer = report()
    expect(answer.supplier).toEqual({
      id: DEMO_GW_ID,
      name: "Games Workshop",
      accountNumber: "GW-48213",
      repName: "Dan",
      repEmail: "dan@example.co.uk",
      repPhone: "07700 900321",
    })
    expect(answer.requests.map((request) => [request.title, request.status])).toEqual([
      ["Combat Patrol: Necrons", "waiting"],
      ["Citadel Contrast: Ultramarines Blue", "asked"],
      ["Kill Team: Hivestorm", "ordered"],
    ])
    expect(answer.requests[0]).toMatchObject({ customerName: "Tom Bradbury", customerCode: expect.stringMatching(/^GGC-/) })
  })

  it("is empty for a supplier with nothing on the shelf", () => {
    const empty = demoReorderReport({ supplierId: DEMO_ASMODEE_ID, ...week() })
    expect(empty.lines).toEqual([])
    expect(empty.totals.toOrder).toBe(0)
  })

  it("refuses in the route's own words", () => {
    expect(refusal(() => demoReorderReport({ supplierId: "", ...week() }))).toEqual({
      status: 400,
      message: "Choose a supplier.",
    })
    expect(refusal(() => demoReorderReport({ supplierId: "nope", ...week() }))).toEqual({
      status: 404,
      message: "That supplier was not found.",
    })
    const bad = { status: 400, message: "The dates do not make sense. Check the from and to dates." }
    expect(refusal(() => demoReorderReport({ supplierId: DEMO_GW_ID, from: "2026-10-15", to: "2026-10-01" }))).toEqual(bad)
    expect(refusal(() => demoReorderReport({ supplierId: DEMO_GW_ID, from: "2025-01-01", to: "2026-10-01" }))).toEqual(bad)
    expect(refusal(() => demoReorderReport({ supplierId: DEMO_GW_ID, from: "15/10/2026", to: "2026-10-15" }))).toEqual(bad)
  })
})

describe("Keep on shelf", () => {
  it("sets every row of the product and moves the line", () => {
    const marines = report().lines.find((line) => line.title === "Combat Patrol: Space Marines")!
    demoSetShelfTarget(marines.itemIds, 9)
    for (const id of marines.itemIds) {
      expect(itemStore().find((item) => item.id === id)?.shelf_target).toBe(9)
    }
    const after = report()
    expect(after.lines[0]).toMatchObject({ title: "Combat Patrol: Space Marines", toOrder: 8 })
    expect(after.totals.toOrder).toBe(29)
  })

  it("puts an untargeted product on the to-order list, and clears a target with null", () => {
    const kill = report().lines.find((line) => line.title === "Kill Team: Starter Set")!
    demoSetShelfTarget(kill.itemIds, 3)
    expect(report().lines.find((line) => line.title === "Kill Team: Starter Set")).toMatchObject({
      toOrder: 2,
      status: "low",
    })
    demoSetShelfTarget(kill.itemIds, null)
    expect(report().lines.find((line) => line.title === "Kill Team: Starter Set")).toMatchObject({
      toOrder: 0,
      status: "untracked",
      shelfTarget: 0,
    })
  })

  it("refuses a negative or a part number", () => {
    const message = { status: 400, message: "Keep on shelf is a whole number, 0 or more." }
    expect(refusal(() => demoSetShelfTarget(["item_gw_abaddon"], -1))).toEqual(message)
    expect(refusal(() => demoSetShelfTarget(["item_gw_abaddon"], 1.5))).toEqual(message)
  })
})

describe("the item page's supplier fields", () => {
  it("reads and saves the supplier, the target and the code", () => {
    const sku = itemStore().find((item) => item.id === "item_gw_core_book")!.sku
    expect(getItem(sku)).toMatchObject({
      supplierId: DEMO_GW_ID,
      supplierName: "Games Workshop",
      shelfTarget: 2,
      supplierCode: "40-01",
    })
    const saved = updateItem("item_gw_core_book", { shelfTarget: null, supplierCode: " 40-02 " })
    expect(saved).toMatchObject({ shelfTarget: null, supplierCode: "40-02" })
    const cleared = updateItem("item_gw_core_book", { supplierId: "" })
    expect(cleared).toMatchObject({ supplierId: "", supplierName: "" })
    updateItem("item_gw_core_book", { supplierId: DEMO_GW_ID, shelfTarget: 2, supplierCode: "40-01" })
  })

  it("refuses a target that is not a whole number", () => {
    expect(refusal(() => updateItem("item_gw_core_book", { shelfTarget: -2 }))).toEqual({
      status: 400,
      message: "Keep on shelf is a whole number, 0 or more.",
    })
  })
})

describe("customer requests", () => {
  it("logs a request as Waiting and moves it on", () => {
    const made = demoCreateRequest({
      supplierId: DEMO_GW_ID,
      title: "  Leviathan  ",
      qty: 1,
      contactName: "Ellie Shaw",
      contactPhone: "07700 900111",
    })
    expect(made).toMatchObject({ title: "Leviathan", status: "waiting", contactName: "Ellie Shaw", createdByName: "Demo Counter" })
    expect(demoListRequests({ supplierId: DEMO_GW_ID, open: true }).at(-1)?.id).toBe(made.id)

    const moved = demoUpdateRequest(made.id, { status: "asked" })
    expect(moved.status).toBe("asked")
    expect(moved.statusChangedAt >= made.statusChangedAt).toBe(true)

    demoUpdateRequest(made.id, { status: "collected" })
    expect(demoListRequests({ supplierId: DEMO_GW_ID, open: true }).some((row) => row.id === made.id)).toBe(false)
    expect(demoListRequests({ supplierId: DEMO_GW_ID }).some((row) => row.id === made.id)).toBe(true)
  })

  it("names a Guild member from the customer", () => {
    const made = demoCreateRequest({ supplierId: DEMO_GW_ID, title: "Paint set", qty: 2, customerId: "cust_demo_1" })
    expect(made).toMatchObject({ customerName: "Jasmine Okafor", qty: 2 })
  })

  it("refuses in the hook's own words", () => {
    const base = { supplierId: DEMO_GW_ID, title: "Leviathan", qty: 1, contactName: "Ellie" }
    expect(refusal(() => demoCreateRequest({ ...base, title: " " }))).toEqual({
      status: 400,
      message: "Say what the customer is after.",
    })
    expect(refusal(() => demoCreateRequest({ ...base, qty: 0 }))).toEqual({
      status: 400,
      message: "The quantity is a whole number, 1 or more.",
    })
    expect(refusal(() => demoCreateRequest({ ...base, contactName: "" }))).toEqual({
      status: 400,
      message: "Add the customer, or a name to contact, so they can be told when it comes in.",
    })
  })
})

describe("suppliers", () => {
  it("lists Games Workshop first and refuses a blank or a duplicate name", () => {
    expect(demoSuppliers(true).map((row) => row.name)).toEqual(["Games Workshop", "Asmodee UK"])
    const input = { name: "", accountNumber: "", repName: "", repEmail: "", repPhone: "", notes: "", active: true }
    expect(refusal(() => demoSaveSupplier(input))).toEqual({ status: 400, message: "Give the supplier a name." })
    expect(refusal(() => demoSaveSupplier({ ...input, name: " games workshop " }))).toEqual({
      status: 400,
      message: "There is already a supplier called games workshop.",
    })
  })

  it("adds one at the end and saves one in place", () => {
    const input = { name: "Mantic", accountNumber: "M-1", repName: "", repEmail: "", repPhone: "", notes: "", active: false }
    const made = demoSaveSupplier(input)
    expect(demoSuppliers().at(-1)?.id).toBe(made.id)
    expect(demoSuppliers(true).some((row) => row.id === made.id)).toBe(false)
    const saved = demoSaveSupplier({ ...input, id: made.id, name: "Mantic Games", active: true })
    expect(saved).toMatchObject({ id: made.id, name: "Mantic Games", active: true })
  })
})

describe("games with no adapter", () => {
  it("are in the Game select but never offered a card search", () => {
    expect(DEMO_GAMES.map((game) => game.key)).toEqual(expect.arrayContaining(["warhammer", "other"]))
    expect(LOOKUP_GAMES.map((game) => game.key)).not.toContain("warhammer")
    expect(isLookupGame("warhammer")).toBe(false)
    expect(isLookupGame("other")).toBe(false)
  })

  it("default the minis branches to Warhammer and the rest to Other, only where no game is set", () => {
    expect(reorderDefaultGame("minis")).toBe("warhammer")
    expect(reorderDefaultGame("minis.paints")).toBe("warhammer")
    expect(reorderDefaultGame("minis.otherminiatures")).toBe("other")
    expect(reorderDefaultGame("boardgames.family")).toBe("other")
    expect(reorderDefaultGame("services")).toBe("other")
    expect(reorderDefaultGame("tcg.pokemon")).toBe("")
    const minis = demoCategoryTree().branches.find((row) => row.id === demoCategoryId("minis.warhammer40000"))
    expect(minis?.defaults.game).toBe("game_warhammer")
  })

  it("file a Warhammer row under Miniatures whatever its kind, and an Other row by its kind", () => {
    expect(demoFileKey("other", "warhammer")).toBe("minis")
    expect(demoFileKey("accessory", "warhammer")).toBe("minis")
    expect(demoFileKey("sealed", "warhammer")).toBe("minis")
    expect(demoFileKey("accessory", "other")).toBe("accessories")
    expect(demoFileKey("single", "pokemon")).toBe("tcg.pokemon.singles")
  })

  it("leave them out of the card search chips by their adapter", () => {
    expect(cardSearchGames(DEMO_GAMES).map((game) => game.key)).toEqual([
      "pokemon",
      "mtg",
      "yugioh",
      "onepiece",
      "lorcana",
    ])
    const noLorcana = DEMO_GAMES.map((game) => (game.key === "lorcana" ? { ...game, adapter: "" } : game))
    expect(cardSearchGames(noLorcana).map((game) => game.key)).not.toContain("lorcana")
    // A catalogue from before the migration names no adapter at all: all five stay.
    expect(cardSearchGames(DEMO_GAMES.map((game) => ({ ...game, adapter: "" })))).toHaveLength(5)
    expect(cardSearchGames(undefined)).toBe(LOOKUP_GAMES)
  })
})
