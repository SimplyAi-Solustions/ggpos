import { describe, expect, it } from "vitest"

import { lineageOf } from "../src/categories"
import {
  evaluateSalePoints,
  evaluateTradeInPoints,
  isGuildMember,
  lineMatchesRule,
  LOYALTY_CONDITION_KEYS,
  type EarnContext,
  type EarnLine,
  type LoyaltyProgramme,
  type LoyaltyRule,
  type LoyaltyTier,
} from "../src/loyalty"

/**
 * The launch's offers (docs/api-contract-launch.md, section 2): branches,
 * items and products as conditions, matched by lineage so a branch takes in
 * everything beneath it, the paid-plan switch, and the stacking rules left
 * exactly as they were.
 */

const programme: LoyaltyProgramme = {
  enabled: true,
  earnPerPoundSales: 10,
  earnPerPoundTradeInCredit: 5,
  pointsPerPoundRedemption: 100,
  minRedeemPoints: 500,
  maxPointsShareOfSale: 50,
  expiryMonthsInactive: 18,
  tierWindowMonths: 12,
  welcomeBonus: 100,
  referralBonusReferrer: 250,
  referralBonusReferee: 250,
}

// Trading cards > Pokémon > Singles, and Retro beside it.
const CARDS = lineageOf("", "tcg")
const POKEMON = lineageOf(CARDS, "pokemon")
const SINGLES = lineageOf(POKEMON, "singles")
const MTG = lineageOf(CARDS, "mtg")
const RETRO = lineageOf("", "retro")

const saturday = new Date("2026-09-19T14:00:00Z")
const tuesday = new Date("2026-09-22T14:00:00Z")

function rule(partial: Partial<LoyaltyRule>): LoyaltyRule {
  return {
    id: "r",
    name: "Offer",
    type: "multiplier",
    conditions: {},
    value: 2,
    active: true,
    priority: 10,
    startsAt: null,
    endsAt: null,
    ...partial,
  }
}

function line(partial: Partial<EarnLine>): EarnLine {
  return { game: null, kind: "other", total: 3000, ...partial }
}

function ctx(lines: EarnLine[], extra: Partial<EarnContext> = {}): EarnContext {
  return {
    lines,
    at: saturday,
    isFirstPurchase: false,
    isBirthdayMonth: false,
    tier: null,
    paidWithPoints: 0,
    ...extra,
  }
}

describe("an offer on a branch", () => {
  const onPokemon = rule({ conditions: { categories: ["pokemon"] } })

  it("matches a line filed in the branch itself", () => {
    expect(evaluateSalePoints(programme, [onPokemon], ctx([line({ lineage: POKEMON })])).total).toBe(600)
  })

  it("matches a line in a branch beneath it", () => {
    expect(evaluateSalePoints(programme, [onPokemon], ctx([line({ lineage: SINGLES })])).total).toBe(600)
  })

  it("leaves a line in a sibling branch, a branch above it and an unfiled line alone", () => {
    expect(evaluateSalePoints(programme, [onPokemon], ctx([line({ lineage: MTG })])).total).toBe(300)
    expect(evaluateSalePoints(programme, [onPokemon], ctx([line({ lineage: CARDS })])).total).toBe(300)
    expect(evaluateSalePoints(programme, [onPokemon], ctx([line({ lineage: "" })])).total).toBe(300)
    expect(evaluateSalePoints(programme, [onPokemon], ctx([line({})])).total).toBe(300)
  })

  it("only multiplies the matching lines of a mixed sale", () => {
    const r = evaluateSalePoints(
      programme,
      [onPokemon],
      ctx([line({ lineage: SINGLES, total: 1000 }), line({ lineage: RETRO, total: 1000 })])
    )
    // 100 doubled to 200, plus 100 untouched.
    expect(r.total).toBe(300)
    expect(r.ruleAdjustments).toHaveLength(1)
    expect(r.ruleAdjustments[0]?.delta).toBe(100)
  })

  it("is not fooled by an id that is only part of another", () => {
    const onPoke = rule({ conditions: { categories: ["poke"] } })
    expect(evaluateSalePoints(programme, [onPoke], ctx([line({ lineage: SINGLES })])).total).toBe(300)
  })
})

describe("an offer on items or products", () => {
  it("matches the stock item it names and no other", () => {
    const onItem = rule({ conditions: { items: ["item_1"] } })
    expect(evaluateSalePoints(programme, [onItem], ctx([line({ item: "item_1" })])).total).toBe(600)
    expect(evaluateSalePoints(programme, [onItem], ctx([line({ item: "item_2" })])).total).toBe(300)
  })

  it("matches the till product it names and no other", () => {
    const onProduct = rule({ type: "fixed_bonus", value: 150, conditions: { products: ["prod_1"] } })
    expect(evaluateSalePoints(programme, [onProduct], ctx([line({ product: "prod_1" })])).total).toBe(450)
    expect(evaluateSalePoints(programme, [onProduct], ctx([line({ product: "prod_2" })])).total).toBe(300)
  })

  it("treats branches, items and products as one list: any of them is in", () => {
    const mixed = { categories: ["retro"], items: ["item_1"], products: ["prod_1"] }
    expect(lineMatchesRule(line({ lineage: RETRO }), mixed)).toBe(true)
    expect(lineMatchesRule(line({ item: "item_1" }), mixed)).toBe(true)
    expect(lineMatchesRule(line({ product: "prod_1" }), mixed)).toBe(true)
    expect(lineMatchesRule(line({ lineage: POKEMON, item: "item_9" }), mixed)).toBe(false)
  })

  it("still needs the older game and kind conditions as well", () => {
    const both = { categories: ["tcg"], kinds: ["sealed"] }
    expect(lineMatchesRule(line({ lineage: SINGLES, kind: "sealed" }), both)).toBe(true)
    expect(lineMatchesRule(line({ lineage: SINGLES, kind: "single" }), both)).toBe(false)
  })

  it("adds a bonus once however many lines match", () => {
    const bonus = rule({ type: "fixed_bonus", value: 250, conditions: { categories: ["tcg"] } })
    const r = evaluateSalePoints(
      programme,
      [bonus],
      ctx([line({ lineage: SINGLES, total: 1000 }), line({ lineage: MTG, total: 1000 })])
    )
    expect(r.total).toBe(450)
  })
})

describe("an offer for paid-plan members", () => {
  const plusOnly = rule({ value: 3, conditions: { paidMembersOnly: true } })

  it("applies only when the customer holds a paid plan", () => {
    expect(evaluateSalePoints(programme, [plusOnly], ctx([line({})], { paidMember: true })).total).toBe(900)
    expect(evaluateSalePoints(programme, [plusOnly], ctx([line({})], { paidMember: false })).total).toBe(300)
    expect(evaluateSalePoints(programme, [plusOnly], ctx([line({})])).total).toBe(300)
  })

  it("keeps a paid-plan credit bonus for paid-plan members", () => {
    const creditBonus = rule({ type: "trade_in_credit_bonus", value: 50, conditions: { paidMembersOnly: true } })
    expect(evaluateTradeInPoints(programme, [creditBonus], 2000, saturday)).toBe(100)
    expect(evaluateTradeInPoints(programme, [creditBonus], 2000, saturday, true)).toBe(150)
  })
})

describe("stacking stays as it was", () => {
  const legend: LoyaltyTier = {
    id: "l",
    name: "Legend",
    thresholdPoints: 10000,
    sort: 2,
    perks: [{ type: "points_multiplier", value: 1.5 }],
    paidPlan: false,
  }

  it("multiplies multipliers on a line, adds bonuses once, then the tier", () => {
    const onBranch = rule({ id: "a", value: 2, conditions: { categories: ["pokemon"] } })
    const onDays = rule({ id: "b", type: "day_of_week", value: 1.5, conditions: { weekdays: [6] } })
    const onItem = rule({ id: "c", type: "fixed_bonus", value: 100, conditions: { items: ["item_1"] } })
    const first = rule({ id: "d", type: "first_purchase", value: 50, priority: 0 })
    const r = evaluateSalePoints(
      programme,
      [onBranch, onDays, onItem, first],
      ctx([line({ lineage: SINGLES, item: "item_1", total: 2000 })], { isFirstPurchase: true, tier: legend })
    )
    // 200 x 2 x 1.5 = 600, + 100 + 50 = 750, x 1.5 = 1125.
    expect(r.base).toBe(200)
    expect(r.total).toBe(1125)
  })

  it("leaves a day offer off on another day, and a dated offer off outside its dates", () => {
    const onDays = rule({ type: "day_of_week", value: 2, conditions: { weekdays: [6], categories: ["tcg"] } })
    expect(evaluateSalePoints(programme, [onDays], ctx([line({ lineage: SINGLES })])).total).toBe(600)
    expect(evaluateSalePoints(programme, [onDays], ctx([line({ lineage: SINGLES })], { at: tuesday })).total).toBe(300)
    const ended = rule({ conditions: { categories: ["tcg"] }, endsAt: "2026-09-01T00:00:00Z" })
    expect(evaluateSalePoints(programme, [ended], ctx([line({ lineage: SINGLES })])).total).toBe(300)
  })

  it("never earns on the part paid with points", () => {
    const onBranch = rule({ conditions: { categories: ["tcg"] } })
    expect(
      evaluateSalePoints(programme, [onBranch], ctx([line({ lineage: SINGLES })], { paidWithPoints: 1500 })).total
    ).toBe(300)
  })
})

describe("the Guild", () => {
  it("counts a customer with a joined date as a member", () => {
    expect(isGuildMember("2026-10-09 10:00:00.000Z")).toBe(true)
    expect(isGuildMember("")).toBe(false)
    expect(isGuildMember("  ")).toBe(false)
    expect(isGuildMember(null)).toBe(false)
    expect(isGuildMember(undefined)).toBe(false)
  })

  it("names every condition key the server accepts", () => {
    expect([...LOYALTY_CONDITION_KEYS].sort()).toEqual(
      ["categories", "games", "items", "kinds", "minSpend", "paidMembersOnly", "products", "weekdays"].sort()
    )
  })
})
