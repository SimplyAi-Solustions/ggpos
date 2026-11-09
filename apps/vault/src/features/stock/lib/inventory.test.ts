import { describe, expect, it } from "vitest"

import { filterItems, DEFAULT_FILTERS, marginPct, summarise, tabOf } from "./inventory"
import { makeItem } from "./fixtures"

describe("inventory", () => {
  it("works out margin as a whole percent of the sticker", () => {
    expect(marginPct(1000, 800)).toBe(20)
    expect(marginPct(999, 700)).toBe(30)
    expect(marginPct(0, 500)).toBeNull()
    expect(marginPct(500, 0)).toBeNull()
    expect(marginPct(500, 600)).toBe(-20)
  })

  it("puts items in the right tab", () => {
    expect(tabOf(makeItem({ kind: "single" }))).toBe("cards")
    expect(tabOf(makeItem({ kind: "other", title: "Amazing Spider-Man #300 (comic)" }))).toBe("comics")
    expect(tabOf(makeItem({ kind: "accessory" }))).toBe("other")
  })

  it("sums units, market, sticker and cost by quantity", () => {
    const s = summarise([
      makeItem({ qty: 2, price: 500, cost: 300, market: 450 }),
      makeItem({ qty: 1, price: 1000, cost: 0, market: null }),
    ])
    expect(s).toEqual({ units: 3, rows: 2, market: 900, sticker: 2000, cost: 600, unpriced: 1 })
  })

  it("searches by SKU and title words", () => {
    const rows = [makeItem({ sku: "GGS6YYAEX", title: "Mew ex" }), makeItem({ sku: "GGS1", title: "Pikachu" })]
    expect(filterItems(rows, { ...DEFAULT_FILTERS, q: "ggs-6yy" })).toHaveLength(1)
    expect(filterItems(rows, { ...DEFAULT_FILTERS, q: "pika" })[0]?.title).toBe("Pikachu")
  })
})
