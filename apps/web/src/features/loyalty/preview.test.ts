import { describe, expect, it } from "vitest"
import { evaluateSalePoints } from "@gg/shared"
import type { LoyaltyProgramme, LoyaltyRule, LoyaltyTier } from "@gg/shared"

import {
  EMPTY_PREVIEW,
  previewContext,
  previewDate,
  previewRows,
  previewSentence,
  signedPoints,
  type PreviewInput,
} from "@/features/loyalty/preview"

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

const SATURDAY: LoyaltyRule = {
  id: "rule_saturday",
  name: "Saturday double points",
  type: "day_of_week",
  conditions: { weekdays: [6] },
  value: 2,
  active: true,
  priority: 20,
  startsAt: null,
  endsAt: null,
}

const SEALED_BONUS: LoyaltyRule = {
  id: "rule_sealed",
  name: "Sealed over £30",
  type: "fixed_bonus",
  conditions: { kinds: ["sealed"], minSpend: 3000 },
  value: 250,
  active: true,
  priority: 10,
  startsAt: null,
  endsAt: null,
}

const REGULAR: LoyaltyTier = {
  id: "tier_regular",
  name: "Regular",
  thresholdPoints: 2500,
  sort: 20,
  perks: [{ type: "points_multiplier", value: 1.25 }],
  paidPlan: false,
}

/** The same call the panel makes: the controls, the rules, the tiers. */
function run(input: PreviewInput, rules: LoyaltyRule[], tiers: LoyaltyTier[] = []) {
  const breakdown = evaluateSalePoints(
    PROGRAMME,
    rules,
    previewContext(input, tiers)
  )
  return { breakdown, rows: previewRows(breakdown, PROGRAMME, input) }
}

describe("previewDate", () => {
  it("lands on the chosen weekday of the week the shop is in", () => {
    // A Wednesday.
    const now = new Date("2026-09-16T09:15:00Z")
    expect(previewDate(6, now).getDay()).toBe(6)
    expect(previewDate(1, now).getDay()).toBe(1)
  })

  it("stays near today, so a dated rule is still live in the preview", () => {
    const now = new Date("2026-09-16T09:15:00Z")
    const at = previewDate(0, now)
    const days = Math.abs(at.getTime() - now.getTime()) / 86_400_000
    expect(days).toBeLessThan(8)
  })
})

describe("signedPoints", () => {
  it("signs and groups a figure", () => {
    expect(signedPoints(1250)).toBe("+1,250")
    expect(signedPoints(-40)).toBe("-40")
    expect(signedPoints(0)).toBe("+0")
  })
})

describe("previewRows", () => {
  it("opens with the base, worked out at the programme's rate", () => {
    const { rows } = run({ ...EMPTY_PREVIEW, weekday: 2 }, [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: "base",
      label: "Base",
      detail: "10 points per £1 on £30.00",
      points: "+300",
    })
  })

  it("adds one row per rule that changed anything, and none for the rest", () => {
    const { rows } = run({ ...EMPTY_PREVIEW, weekday: 6 }, [SATURDAY, SEALED_BONUS])
    expect(rows.map((row) => row.key)).toEqual([
      "base",
      "rule_saturday",
      "rule_sealed",
    ])
    // The multiplier's delta is what it added, not the multiplied total.
    expect(rows[1]).toMatchObject({
      label: "Saturday double points",
      detail: "Multiplies matching lines by 2",
      points: "+300",
    })
    expect(rows[2]).toMatchObject({ label: "Sealed over £30", points: "+250" })
  })

  it("leaves out a rule the sale does not match", () => {
    const { rows } = run({ ...EMPTY_PREVIEW, weekday: 3 }, [SATURDAY])
    expect(rows.map((row) => row.key)).toEqual(["base"])
  })

  it("leaves out a rule that is not live", () => {
    const { rows } = run({ ...EMPTY_PREVIEW, weekday: 6 }, [
      { ...SATURDAY, active: false },
    ])
    expect(rows.map((row) => row.key)).toEqual(["base"])
  })

  it("shows the tier multiplier last, and only when there is one", () => {
    const withTier = run(
      { ...EMPTY_PREVIEW, weekday: 2, tierId: "tier_regular" },
      [],
      [REGULAR]
    )
    expect(withTier.rows.at(-1)).toMatchObject({
      key: "tier",
      label: "Tier multiplier",
      points: "x 1.25",
    })

    const withoutTier = run({ ...EMPTY_PREVIEW, weekday: 2 }, [], [REGULAR])
    expect(withoutTier.rows.some((row) => row.key === "tier")).toBe(false)
  })

  it("adds up to the breakdown's own total", () => {
    const { breakdown } = run(
      { ...EMPTY_PREVIEW, weekday: 6, tierId: "tier_regular" },
      [SATURDAY, SEALED_BONUS],
      [REGULAR]
    )
    // £30 at 10 a pound is 300, doubled on a Saturday is 600, plus the 250
    // sealed bonus is 850, and a Regular's 1.25 makes 1,062.5, which the
    // evaluator rounds to a whole point.
    expect(breakdown.total).toBe(1063)
  })
})

describe("previewSentence", () => {
  it("names the amount, the game, the kind, the day and the tier", () => {
    const { breakdown } = run(
      { ...EMPTY_PREVIEW, weekday: 6, game: "game_pokemon", tierId: "tier_regular" },
      [SATURDAY],
      [REGULAR]
    )
    expect(
      previewSentence(
        { ...EMPTY_PREVIEW, weekday: 6, game: "game_pokemon", tierId: "tier_regular" },
        { gameName: "Pokemon", tierName: "Regular" },
        breakdown.total
      )
    ).toBe(
      "A £30.00 Pokemon sealed sale on a Saturday for a Regular earns 750 points."
    )
  })

  it("says so when the customer is on no tier", () => {
    expect(
      previewSentence({ ...EMPTY_PREVIEW, weekday: 1 }, { gameName: null, tierName: null }, 300)
    ).toBe(
      "A £30.00 sealed sale on a Monday for a customer with no tier earns 300 points."
    )
  })

  it("carries the first purchase and the birthday month", () => {
    expect(
      previewSentence(
        { ...EMPTY_PREVIEW, weekday: 5, firstPurchase: true, birthdayMonth: true },
        { gameName: null, tierName: "Member" },
        800
      )
    ).toBe(
      "A £30.00 sealed sale on a Friday for a Member, on their first purchase and in their birthday month, earns 800 points."
    )
  })
})
