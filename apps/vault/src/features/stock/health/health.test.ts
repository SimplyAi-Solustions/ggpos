import { describe, expect, it } from "vitest"

import { makeItem } from "../lib/fixtures"
import { alertsFor, checkHealth } from "./health"

const keys = (over: Parameters<typeof makeItem>[0]) => alertsFor(makeItem(over)).map((rule) => rule.key)

describe("stock health", () => {
  it("is quiet for a well priced item", () => {
    expect(keys({ price: 1000, cost: 500, market: 900 })).toEqual([])
  })

  it("flags a sticker below cost, and not as a thin margin", () => {
    expect(keys({ price: 400, cost: 500, market: 300 })).toEqual(["below_cost"])
  })

  it("flags margins under 10% and 20% on the sticker", () => {
    expect(keys({ price: 1000, cost: 950, market: 1000 })).toEqual(["margin_10", "margin_20"])
    expect(keys({ price: 1000, cost: 850, market: 1000 })).toEqual(["margin_20"])
    // Exactly 20% is fine; exactly 10% is under 20 only.
    expect(keys({ price: 1000, cost: 800, market: 1000 })).toEqual([])
    expect(keys({ price: 1000, cost: 900, market: 1000 })).toEqual(["margin_20"])
  })

  it("ignores margin when there is no cost", () => {
    expect(keys({ price: 1000, cost: 0, market: 1000 })).toEqual([])
  })

  it("flags no sticker and no market", () => {
    expect(keys({ price: 0, cost: 0, market: null })).toEqual(["no_sticker", "no_market"])
  })

  it("flags a sticker under the market", () => {
    expect(keys({ price: 900, cost: 100, market: 1000 })).toEqual(["below_market"])
  })

  it("groups items under every rule, in order", () => {
    const results = checkHealth([makeItem({ price: 0, market: null }), makeItem({ price: 400, cost: 500 })])
    const counts = Object.fromEntries(results.map((r) => [r.rule.key, r.items.length]))
    expect(counts).toEqual({
      below_cost: 1,
      margin_10: 0,
      margin_20: 0,
      below_market: 1,
      no_sticker: 1,
      no_market: 1,
    })
  })
})
