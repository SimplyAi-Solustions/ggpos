import { computeOffer, suggestSellPrice, roundToRetailEnding } from "@gg/shared"
import { describe, expect, it } from "vitest"

import {
  bandLabel,
  formToMarkupBands,
  formToMultipliers,
  formToOfferSettings,
  formToPatch,
  formToPricingRule,
  formToRuleWrite,
  HAIRCUT_KEY,
  penceToPounds,
  percentToMultiplier,
  poundsToPence,
  recordToForm,
  ruleChanged,
  RULE_CONDITIONS,
  ruleRowToForm,
  validateRules,
  validateSettings,
  wildcardLabel,
} from "@/features/settings/mapping"
import { DEMO_RULE_ROWS, DEMO_SETTINGS_RECORD } from "@/lib/api/demo/settings"

const form = () => recordToForm(DEMO_SETTINGS_RECORD)
const rules = () => DEMO_RULE_ROWS.map((row, index) => ruleRowToForm(row, index))

describe("pounds and pence", () => {
  it("shows pence as pounds", () => {
    expect(penceToPounds(800000)).toBe("8000.00")
    expect(penceToPounds(45)).toBe("0.45")
    expect(penceToPounds(0)).toBe("0.00")
    expect(penceToPounds(undefined)).toBe("")
  })

  it("takes pounds back to pence", () => {
    expect(poundsToPence("8000")).toBe(800000)
    expect(poundsToPence("£1,234.56")).toBe(123456)
    expect(poundsToPence("0.45")).toBe(45)
    expect(poundsToPence("")).toBeNull()
    expect(poundsToPence("12.345")).toBeNull()
  })

  it("keeps a cash cap of zero, which is how cash is switched off", () => {
    const patch = formToPatch({ ...form(), cashCap: "0.00" })
    expect(patch.cash_cap).toBe(0)
  })
})

describe("percentages", () => {
  it("stores a condition percent as the multiplier the evaluator applies", () => {
    expect(percentToMultiplier(85)).toBeCloseTo(0.85, 10)
    const patch = formToPatch(form())
    expect(patch.condition_multipliers).toEqual({
      NM: 1,
      LP: 0.85,
      MP: 0.7,
      HP: 0.5,
      DMG: 0.3,
    })
  })

  it("round-trips the seeded multipliers without moving them", () => {
    expect(form().conditionPct).toEqual({ LP: "85", MP: "70", HP: "50", DMG: "30" })
  })

  it("stores a markup percent as the multiplier the sell price uses", () => {
    const patch = formToPatch(form())
    expect(patch.markup_bands).toEqual([
      { from: 0, multiplier: 1.1 },
      { from: 500, multiplier: 1.05 },
      { from: 5000, multiplier: 1 },
    ])
    expect(form().markupBands.map((band) => band.markupPct)).toEqual(["10", "5", "0"])
  })
})

describe("the settings patch", () => {
  it("writes the minimum offer under both names so the two cannot drift", () => {
    const patch = formToPatch({ ...form(), minimumOffer: "0.25" })
    expect(patch.min_single_offer).toBe(25)
    expect(patch.offer?.minimumOffer).toBe(25)
  })

  it("keeps the eBay haircut inside the offer bucket", () => {
    const patch = formToPatch({ ...form(), haircutPct: "20" })
    expect((patch.offer as Record<string, number>)[HAIRCUT_KEY]).toBe(20)
    expect(recordToForm({ ...DEMO_SETTINGS_RECORD, ...patch }).haircutPct).toBe("20")
  })

  it("carries no key, secret or mail setting", () => {
    const patch = formToPatch(form())
    const names = Object.keys(patch).join(" ")
    expect(names).not.toMatch(/key|secret|email_provider|push/)
  })

  it("round-trips the record it was built from", () => {
    const patch = formToPatch(form())
    const again = recordToForm({ ...DEMO_SETTINGS_RECORD, ...patch })
    expect(again).toEqual(form())
  })

  it("falls back to the plan's order when the stored one is empty", () => {
    const empty = recordToForm({ ...DEMO_SETTINGS_RECORD, source_priority: [] })
    expect(empty.sourcePriority).toEqual([
      "uk_sold_manual",
      "ebay_uk_asking",
      "cardmarket",
      "tcgplayer",
    ])
  })
})

describe("the pricing rules matrix", () => {
  it("prints an unset field as Any", () => {
    expect(wildcardLabel("")).toBe("Any")
    expect(wildcardLabel(null)).toBe("Any")
    expect(wildcardLabel("single")).toBe("single")
  })

  it("prints an open-ended band as and up", () => {
    expect(bandLabel(5000, null)).toBe("£50.00 and up")
    expect(bandLabel(5000, 0)).toBe("£50.00 and up")
    expect(bandLabel(0, 500)).toBe("£0.00 to £5.00")
  })

  it("reads an open-ended band off a row that stores it as zero", () => {
    const top = ruleRowToForm(DEMO_RULE_ROWS[2]!)
    expect(top.bandMax).toBe("")
    expect(formToPricingRule(top).bandMax).toBeNull()
    expect(formToRuleWrite(top).band_max).toBe(0)
  })

  it("keeps a wildcard as an empty string, not the word Any", () => {
    const write = formToRuleWrite(ruleRowToForm(DEMO_RULE_ROWS[0]!))
    expect(write.condition).toBe("")
    expect(write.game).toBe("")
    expect(write.kind).toBe("single")
  })

  it("sends an id for a saved row and none for a new one", () => {
    expect(formToRuleWrite(ruleRowToForm(DEMO_RULE_ROWS[0]!)).id).toBe("rule_single_low")
    const fresh = { ...ruleRowToForm(DEMO_RULE_ROWS[0]!), id: "" }
    expect(formToRuleWrite(fresh).id).toBeUndefined()
  })

  it("notices a changed row and leaves an untouched one alone", () => {
    const [first] = rules()
    expect(ruleChanged(first!, first)).toBe(false)
    expect(ruleChanged({ ...first!, cashPct: "45" }, first)).toBe(true)
    expect(ruleChanged(first!, undefined)).toBe(true)
  })
})

describe("the preview computes what the counter will offer", () => {
  it("prices a £100 near-mint single off the unsaved rules", () => {
    const current = form()
    const offer = computeOffer(
      10000,
      { game: "pokemon", kind: "single", condition: "NM", finish: "" },
      rules().map(formToPricingRule),
      formToOfferSettings(current),
      formToMultipliers(current)
    )

    expect(offer.rule?.id).toBe("rule_single_high")
    expect(offer.cash).toBe(6000)
    expect(offer.credit).toBe(7500)
  })

  it("follows a percentage typed into the form before it is saved", () => {
    const edited = rules().map((rule) =>
      rule.id === "rule_single_high" ? { ...rule, cashPct: "70" } : rule
    )
    const offer = computeOffer(
      10000,
      { game: "pokemon", kind: "single", condition: "NM", finish: "" },
      edited.map(formToPricingRule),
      formToOfferSettings(form()),
      formToMultipliers(form())
    )

    expect(offer.cash).toBe(7000)
  })

  it("matches a game-scoped rule on the game's record id", () => {
    const current = form()
    // What the matrix writes when an admin picks Pokemon: the relation's id.
    const pokemonOnly = [
      ...rules().map(formToPricingRule),
      {
        ...formToPricingRule(rules()[2]!),
        id: "rule_pokemon_high",
        game: "game_pokemon",
        cashPct: 80,
        creditPct: 90,
        priority: 99,
      },
    ]

    const pokemon = computeOffer(
      10000,
      { game: "game_pokemon", kind: "single", condition: "NM", finish: "" },
      pokemonOnly,
      formToOfferSettings(current),
      formToMultipliers(current)
    )
    const mtg = computeOffer(
      10000,
      { game: "game_mtg", kind: "single", condition: "NM", finish: "" },
      pokemonOnly,
      formToOfferSettings(current),
      formToMultipliers(current)
    )

    expect(pokemon.rule?.id).toBe("rule_pokemon_high")
    expect(pokemon.cash).toBe(8000)
    // The key is not the id, so a preview passing "pokemon" would match
    // nothing here and quietly fall back to the wildcard band.
    expect(mtg.rule?.id).toBe("rule_single_high")
    expect(mtg.cash).toBe(6000)
  })

  it("applies the condition multiplier before it picks a band", () => {
    const current = form()
    const offer = computeOffer(
      10000,
      { game: "pokemon", kind: "single", condition: "MP", finish: "" },
      rules().map(formToPricingRule),
      formToOfferSettings(current),
      formToMultipliers(current)
    )

    expect(offer.adjustedMarket).toBe(7000)
    expect(offer.cash).toBe(4200)
  })

  it("suggests a sell price off the form's markup bands", () => {
    const bands = formToMarkupBands(form())
    expect(suggestSellPrice(300, bands, roundToRetailEnding)).toBe(349)
    expect(suggestSellPrice(1200, bands, roundToRetailEnding)).toBe(1299)
    expect(suggestSellPrice(12000, bands, roundToRetailEnding)).toBe(12049)
  })
})

describe("what a rule can key on", () => {
  it("offers retro completeness beside the card conditions", () => {
    expect([...RULE_CONDITIONS]).toEqual([
      "NM",
      "LP",
      "MP",
      "HP",
      "DMG",
      "loose",
      "boxed",
      "cib",
    ])
  })

  it("prices a boxed retro line off a completeness rule", () => {
    const current = form()
    const withBoxed = [
      ...rules().map(formToPricingRule),
      {
        ...formToPricingRule(rules()[3]!),
        id: "rule_retro_boxed",
        condition: "boxed",
        cashPct: 70,
        priority: 99,
      },
    ]

    const boxed = computeOffer(
      4000,
      { game: "", kind: "retro", condition: "boxed", finish: "" },
      withBoxed,
      formToOfferSettings(current),
      formToMultipliers(current)
    )

    expect(boxed.rule?.id).toBe("rule_retro_boxed")
    expect(boxed.cash).toBe(2800)
  })
})

describe("validation", () => {
  it("passes the seeded settings", () => {
    expect(validateSettings(form())).toEqual({})
    expect(validateRules(rules())).toEqual({})
  })

  it("says what to do about an amount that is not money", () => {
    const errors = validateSettings({ ...form(), cashCap: "eight thousand" })
    expect(errors.cashCap).toBe("Enter an amount in pounds and pence, for example 12.50.")
  })

  it("refuses an amount with a minus sign in front of it", () => {
    expect(validateSettings({ ...form(), cashCap: "-10.00" }).cashCap).toBe(
      "Enter an amount in pounds and pence, for example 12.50."
    )
    expect(validateSettings({ ...form(), minimumOffer: "-0.25" }).minimumOffer).toBe(
      "Enter an amount in pounds and pence, for example 12.50."
    )

    const [first] = rules()
    const errors = validateRules([{ ...first!, bandMin: "-5.00" }])
    expect(errors[`rules.${first!.key}.bandMin`]).toBe(
      "Enter an amount in pounds and pence, for example 12.50."
    )
  })

  it("refuses a percent over a hundred", () => {
    const errors = validateSettings({
      ...form(),
      conditionPct: { ...form().conditionPct, LP: "120" },
    })
    expect(errors["conditionPct.LP"]).toBe("Enter a whole percent between 0 and 100.")
  })

  it("refuses a band whose top is under its bottom", () => {
    const [first] = rules()
    const errors = validateRules([{ ...first!, bandMin: "50.00", bandMax: "5.00" }])
    expect(errors[`rules.${first!.key}.bandMax`]).toContain("above the bottom")
  })

  it("asks for a shop name, which prints on every receipt", () => {
    expect(validateSettings({ ...form(), shopName: "  " }).shopName).toContain("needs a name")
  })
})
