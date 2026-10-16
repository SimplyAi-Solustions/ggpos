import { describe, expect, it } from "vitest"
import type { LoyaltyProgramme } from "@gg/shared"

import {
  OFFER_TEMPLATES,
  datesWords,
  daysWords,
  emptyOffer,
  offerExample,
  offerFromRule,
  offerSentence,
  offerToRule,
  rateExample,
  rateSentence,
  validateOffer,
  type OfferNames,
} from "@/features/loyalty/offers"

const PROGRAMME: LoyaltyProgramme = {
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

const NAMES: OfferNames = {
  branches: {
    pokemon: { name: "Pokémon", path: "Trading cards / Pokémon", lineage: "|tcg|pokemon|" },
    retro: { name: "Retro", path: "Retro", lineage: "|retro|" },
  },
  items: { item_1: { title: "Charizard ex", price: 32499 } },
  products: { table: { name: "Table time, 1 hour", price: 500 } },
  games: { game_pokemon: "Pokémon" },
  paidTier: "Guild+",
}

// A Tuesday, so a Saturday offer's example has to move forward to one.
const NOW = new Date("2026-10-13T10:00:00")

describe("an offer's sentence", () => {
  it("reads the brief's own example", () => {
    const form = {
      ...emptyOffer("times_things", "k"),
      categories: ["pokemon"],
      weekdays: [6],
      endsAt: "2026-10-31",
    }
    expect(offerSentence(form, NAMES)).toBe("2 times points on Trading cards / Pokémon, Saturdays, until 31 October")
  })

  it("says each template in plain words", () => {
    expect(offerSentence({ ...emptyOffer("times_days", "k"), weekdays: [6, 0] }, NAMES)).toBe(
      "2 times points on Saturdays and Sundays"
    )
    expect(offerSentence({ ...emptyOffer("bonus_things", "k"), value: "250", items: ["item_1"] }, NAMES)).toBe(
      "250 bonus points when they buy Charizard ex"
    )
    expect(offerSentence({ ...emptyOffer("first_purchase", "k"), value: "500" }, NAMES)).toBe(
      "500 bonus points on their first purchase"
    )
    expect(offerSentence({ ...emptyOffer("birthday", "k"), value: "1000" }, NAMES)).toBe(
      "1,000 bonus points in their birthday month"
    )
    expect(
      offerSentence({ ...emptyOffer("times_things", "k"), value: "1.5", products: ["table"], paidMembersOnly: true }, NAMES)
    ).toBe("1.5 times points on Table time, 1 hour, Guild+ members only")
  })

  it("names several things and says the dates either way round", () => {
    const form = { ...emptyOffer("times_things", "k"), categories: ["pokemon", "retro"], items: ["item_1"] }
    expect(offerSentence(form, NAMES)).toBe("2 times points on Trading cards / Pokémon, Retro and Charizard ex")
    expect(datesWords("2026-10-01", "2026-10-31")).toBe("1 to 31 October")
    expect(datesWords("2026-10-25", "2026-11-02")).toBe("25 October to 2 November")
    expect(datesWords("2026-11-01", "")).toBe("from 1 November")
    expect(daysWords([0, 1, 2, 3, 4, 5, 6])).toBe("every day")
  })

  it("keeps a condition from before the launch in the sentence", () => {
    const form = offerFromRule({
      id: "rule_sealed_bonus",
      name: "Sealed over £30",
      type: "fixed_bonus",
      conditions: { kinds: ["sealed"], minSpend: 3000 },
      value: 250,
      active: true,
      priority: 10,
    })
    expect(offerSentence(form, NAMES)).toBe("250 bonus points when they buy anything, sealed only, on £30.00 or more")
    expect(offerToRule(form, NAMES).conditions).toEqual({ kinds: ["sealed"], minSpend: 3000 })
  })

  it("says the programme's rate", () => {
    expect(rateSentence(10)).toBe("Earn 10 points for every £1")
    expect(rateSentence(1)).toBe("Earn 1 point for every £1")
    expect(rateExample(PROGRAMME).sentence).toBe("A £30.00 sale earns 300 points.")
  })
})

describe("an offer's live example", () => {
  it("prices a branch offer on its first day", () => {
    const form = { ...emptyOffer("times_things", "k"), categories: ["pokemon"], weekdays: [6] }
    const example = offerExample(form, PROGRAMME, NAMES, NOW)
    expect(example.points).toBe(600)
    expect(example.sentence).toBe("A £30.00 Pokémon sale on a Saturday earns 600 points.")
  })

  it("prices an item at its own price and a bonus once", () => {
    const form = { ...emptyOffer("bonus_things", "k"), value: "250", items: ["item_1"] }
    const example = offerExample(form, PROGRAMME, NAMES, NOW)
    expect(example.points).toBe(3250 + 250)
    expect(example.sentence).toBe("Charizard ex at £324.99 earns 3,500 points.")
  })

  it("prices a paid-plan offer for a paid-plan member, and the first-purchase bonus", () => {
    const plus = { ...emptyOffer("times_things", "k"), products: ["table"], paidMembersOnly: true }
    expect(offerExample(plus, PROGRAMME, NAMES, NOW).sentence).toBe(
      "Table time, 1 hour at £5.00 for a Guild+ member earns 100 points."
    )
    const first = { ...emptyOffer("first_purchase", "k"), value: "500" }
    expect(offerExample(first, PROGRAMME, NAMES, NOW).sentence).toBe("A £30.00 first purchase earns 800 points.")
  })

  it("answers for an offer that is switched off, as it would pay once on", () => {
    const off = { ...emptyOffer("times_days", "k"), weekdays: [2], active: false }
    expect(offerExample(off, PROGRAMME, NAMES, NOW).points).toBe(600)
  })
})

describe("saving an offer", () => {
  it("writes the conditions the evaluator reads and the sentence as its name", () => {
    const form = {
      ...emptyOffer("times_things", "k"),
      categories: ["pokemon"],
      items: ["item_1"],
      products: ["table"],
      weekdays: [0, 6],
      paidMembersOnly: true,
      startsAt: "2026-10-01",
      endsAt: "2026-10-31",
    }
    const write = offerToRule(form, NAMES)
    expect(write.type).toBe("multiplier")
    expect(write.value).toBe(2)
    expect(write.name).toBe("2 times points on Trading cards / Pokémon, Charizard ex and Table time, 1 hour")
    expect(write.conditions).toEqual({
      categories: ["pokemon"],
      items: ["item_1"],
      products: ["table"],
      weekdays: [0, 6],
      paidMembersOnly: true,
    })
    expect(write.starts_at).toBe("2026-10-01")
    // The whole of the 31st, London time: 22:59:59.999 UTC in BST.
    expect(write.ends_at).toBe("2026-10-31T23:59:59.999Z")
  })

  it("reads back what it wrote", () => {
    const form = { ...emptyOffer("bonus_things", "k"), value: "150", products: ["table"], weekdays: [5] }
    const back = offerFromRule({ ...offerToRule(form, NAMES), id: "r1" })
    expect(back.products).toEqual(["table"])
    expect(back.weekdays).toEqual([5])
    expect(back.value).toBe("150")
  })

  it("refuses what the server would", () => {
    expect(validateOffer({ ...emptyOffer("times_things", "k") }).things).toBe("Pick at least one branch, item or product.")
    expect(validateOffer({ ...emptyOffer("times_days", "k") }).weekdays).toBe("Pick at least one day.")
    expect(validateOffer({ ...emptyOffer("times_days", "k"), weekdays: [6], value: "11" }).value).toBe(
      "More than 10 times points is refused. Check the figure."
    )
    expect(validateOffer({ ...emptyOffer("first_purchase", "k"), value: "1.5" }).value).toBe(
      "Bonus points are a whole number above 0."
    )
    expect(
      validateOffer({ ...emptyOffer("birthday", "k"), startsAt: "2026-11-01", endsAt: "2026-10-01" }).endsAt
    ).toBe("The end date is before the start. Swap them over.")
    expect(validateOffer({ ...emptyOffer("bonus_things", "k") })).toEqual({})
  })

  it("offers the contract's five templates after the rate", () => {
    expect(OFFER_TEMPLATES.map((entry) => entry.sentence)).toEqual([
      "N times points on branches, items or products",
      "N bonus points when they buy branches, items or products",
      "N times points on days",
      "N bonus points on their first purchase",
      "N bonus points in their birthday month",
    ])
  })
})
