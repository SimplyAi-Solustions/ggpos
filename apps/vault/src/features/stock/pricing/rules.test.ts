import { describe, expect, it } from "vitest"

import { makeItem } from "../lib/fixtures"
import { applyRounding, charm99, evaluate, matches, NEW_RULE, preview, roundUpTo, rulePrice, splitForApply, type SellRule } from "./rules"

const rule = (over: Partial<SellRule> = {}): SellRule => ({ ...NEW_RULE, ...over })

describe("rounding", () => {
  it("charms to the nearest .99", () => {
    expect(charm99(1040)).toBe(999)
    expect(charm99(1060)).toBe(1099)
    expect(charm99(1000)).toBe(999)
    expect(charm99(20)).toBe(99)
  })

  it("rounds to .49 or .99 upwards, and to a step", () => {
    expect(applyRounding(1020, { rounding: "charm_49_99", round_step: 0 })).toBe(1049)
    expect(applyRounding(1060, { rounding: "charm_49_99", round_step: 0 })).toBe(1099)
    expect(applyRounding(1037, { rounding: "round_to", round_step: 25 })).toBe(1025)
    expect(applyRounding(1038, { rounding: "round_to", round_step: 25 })).toBe(1050)
    expect(applyRounding(1050, { rounding: "round_to", round_step: 100 })).toBe(1100)
    expect(applyRounding(1037, { rounding: "none", round_step: 0 })).toBe(1037)
  })

  it("rounds up to the first allowed price at or above a floor", () => {
    expect(roundUpTo(1001, { rounding: "charm_99", round_step: 0 })).toBe(1099)
    expect(roundUpTo(1099, { rounding: "charm_99", round_step: 0 })).toBe(1099)
    expect(roundUpTo(1001, { rounding: "round_to", round_step: 50 })).toBe(1050)
    expect(roundUpTo(1001, { rounding: "none", round_step: 0 })).toBe(1001)
  })
})

describe("start points", () => {
  it("takes a percent of market, then the adjustment", () => {
    expect(rulePrice(rule({ start_value: 90, adjust_pct: 0, rounding: "none" }), { market: 2000, cost: 0 })).toEqual({ price: 1800 })
    expect(rulePrice(rule({ start_value: 100, adjust_pct: 10, rounding: "none" }), { market: 1999, cost: 0 })).toEqual({ price: 2199 })
  })

  it("marks up cost", () => {
    expect(rulePrice(rule({ start: "cost_markup", start_value: 50, rounding: "none" }), { market: null, cost: 1000 })).toEqual({ price: 1500 })
    expect(rulePrice(rule({ start: "cost_markup", start_value: 50 }), { market: null, cost: 0 })).toEqual({ missing: "No cost" })
  })

  it("uses a fixed price", () => {
    expect(rulePrice(rule({ start: "fixed", start_value: 100, rounding: "none" }), { market: null, cost: 0 })).toEqual({ price: 100 })
  })

  it("leaves an item with no market alone", () => {
    expect(rulePrice(rule(), { market: null, cost: 100 })).toEqual({ missing: "No market price" })
  })
})

describe("safety checks", () => {
  it("never prices below cost, and says so", () => {
    const result = evaluate(rule({ start_value: 80, max_change_pct: 0 }), makeItem({ market: 1000, cost: 950, price: 1200 }))
    expect(result).toMatchObject({ outcome: "limited", proposed: 999 })
  })

  it("can be told to go below cost", () => {
    const result = evaluate(rule({ start_value: 80, never_below_cost: false, max_change_pct: 0 }), makeItem({ market: 1000, cost: 950, price: 1200 }))
    expect(result).toMatchObject({ outcome: "update", proposed: 799 })
  })

  it("protects hand-stickered items", () => {
    expect(evaluate(rule(), makeItem({ hand_priced: true })).outcome).toBe("skip")
    expect(evaluate(rule({ protect_hand: false }), makeItem({ hand_priced: true, market: 2000, price: 1999 })).outcome).toBe("skip")
    expect(evaluate(rule({ protect_hand: false }), makeItem({ hand_priced: true, market: 2000, price: 1800 })).outcome).toBe("update")
  })

  it("sends a change over the maximum to approval", () => {
    const big = evaluate(rule({ max_change_pct: 20 }), makeItem({ market: 2000, price: 1000, cost: 0 }))
    expect(big).toMatchObject({ outcome: "approval", proposed: 1999 })
    const small = evaluate(rule({ max_change_pct: 20 }), makeItem({ market: 1100, price: 1000, cost: 0 }))
    expect(small).toMatchObject({ outcome: "update", proposed: 1099 })
  })

  it("prices an unstickered item without the change limit", () => {
    expect(evaluate(rule({ max_change_pct: 5 }), makeItem({ market: 2000, price: 0, cost: 0 }))).toMatchObject({
      outcome: "update",
      proposed: 1999,
      reason: "New sticker",
    })
  })

  it("leaves an item already at the price", () => {
    expect(evaluate(rule(), makeItem({ market: 2000, price: 1999 })).reason).toBe("Already at this price")
  })
})

describe("matching and preview", () => {
  const ctx = { categoryPaths: { cat1: "Trading cards / Pokémon" } }

  it("matches a category branch and everything beneath it", () => {
    const r = rule({ match: "category", match_category: "cat1" })
    expect(matches(r, makeItem({ category: "cat1" }), ctx)).toBe(true)
    expect(matches(r, makeItem({ category: "x", category_path: "Trading cards / Pokémon / Singles" }), ctx)).toBe(true)
    expect(matches(r, makeItem({ category: "y", category_path: "Trading cards / Pokémon Japan" }), ctx)).toBe(false)
  })

  it("counts outcomes and the total change by quantity", () => {
    const items = [
      makeItem({ market: 1100, price: 1000, cost: 0, qty: 2 }),
      makeItem({ market: 5000, price: 1000, cost: 0 }),
      makeItem({ market: null }),
      makeItem({ market: 1000, price: 999, kind: "sealed" }),
    ]
    const p = preview(rule(), items, ctx)
    expect(p.counts).toEqual({ update: 1, limited: 0, approval: 1, skip: 2 })
    expect(p.totalChange).toBe(99 * 2 + 3999)
    expect(p.matched).toBe(4)
    expect(preview(rule({ match: "kind", match_kind: "sealed" }), items, ctx).matched).toBe(1)
  })

  it("queues everything for an ask rule, only the over-limit ones for auto", () => {
    const p = preview(rule(), [makeItem({ market: 1100, price: 1000, cost: 0 }), makeItem({ market: 5000, price: 1000, cost: 0 })], ctx)
    expect(splitForApply({ approval: "ask" }, p.results)).toMatchObject({ apply: [], queue: [{}, {}] })
    const auto = splitForApply({ approval: "auto" }, p.results)
    expect(auto.apply).toHaveLength(1)
    expect(auto.queue).toHaveLength(1)
  })
})
