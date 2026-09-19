import { describe, expect, it } from "vitest"
import {
  checkPointsRedemption,
  evaluateSalePoints,
  evaluateTradeInPoints,
  penceToPoints,
  pointsToNextTier,
  pointsToPence,
  tierForPoints,
  type LoyaltyProgramme,
  type LoyaltyRule,
  type LoyaltyTier,
} from "../src/loyalty"

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

const weekendDouble: LoyaltyRule = {
  id: "weekend",
  name: "Double points on sealed at weekends",
  type: "multiplier",
  conditions: { kinds: ["sealed"], weekdays: [6, 0] },
  value: 2,
  active: true,
  priority: 10,
  startsAt: null,
  endsAt: null,
}

const firstPurchase: LoyaltyRule = {
  id: "first",
  name: "First purchase",
  type: "first_purchase",
  conditions: {},
  value: 150,
  active: true,
  priority: 0,
  startsAt: null,
  endsAt: null,
}

const tiers: LoyaltyTier[] = [
  { id: "m", name: "Member", thresholdPoints: 0, sort: 0, perks: [], paidPlan: false },
  { id: "r", name: "Regular", thresholdPoints: 2500, sort: 1, perks: [{ type: "percent_off", value: 10, scope: ["accessory"] }], paidPlan: false },
  { id: "l", name: "Legend", thresholdPoints: 10000, sort: 2, perks: [{ type: "points_multiplier", value: 1.5 }], paidPlan: false },
  { id: "pass", name: "Guild Pass", thresholdPoints: 0, sort: 3, perks: [], paidPlan: true },
]

const saturday = new Date("2026-09-19T14:00:00Z") // a Saturday

describe("evaluateSalePoints", () => {
  it("earns base points per pound", () => {
    const r = evaluateSalePoints(programme, [], {
      lines: [{ game: "pokemon", kind: "single", total: 2550 }],
      at: saturday,
      isFirstPurchase: false,
      isBirthdayMonth: false,
      tier: null,
      paidWithPoints: 0,
    })
    expect(r.total).toBe(255)
  })
  it("worked example from the guide: £30 sealed Pokémon on a Saturday with 2x earns 600", () => {
    const r = evaluateSalePoints(programme, [weekendDouble], {
      lines: [{ game: "pokemon", kind: "sealed", total: 3000 }],
      at: saturday,
      isFirstPurchase: false,
      isBirthdayMonth: false,
      tier: null,
      paidWithPoints: 0,
    })
    expect(r.base).toBe(300)
    expect(r.total).toBe(600)
    expect(r.ruleAdjustments[0]?.delta).toBe(300)
  })
  it("multipliers only touch matching lines, bonuses add once, tier multiplier applies last", () => {
    const r = evaluateSalePoints(programme, [weekendDouble, firstPurchase], {
      lines: [
        { game: "pokemon", kind: "sealed", total: 1000 },
        { game: "mtg", kind: "single", total: 1000 },
      ],
      at: saturday,
      isFirstPurchase: true,
      isBirthdayMonth: false,
      tier: tiers[2] ?? null,
      paidWithPoints: 0,
    })
    // sealed 100 -> 200, single 100, first purchase +150 => 450 * 1.5 = 675
    expect(r.total).toBe(675)
  })
  it("does not earn on the part paid with points, and nothing when disabled", () => {
    const r = evaluateSalePoints(programme, [], {
      lines: [{ game: null, kind: "accessory", total: 2000 }],
      at: saturday,
      isFirstPurchase: false,
      isBirthdayMonth: false,
      tier: null,
      paidWithPoints: 1000,
    })
    expect(r.total).toBe(100)
    expect(evaluateSalePoints({ ...programme, enabled: false }, [], { lines: [], at: saturday, isFirstPurchase: false, isBirthdayMonth: false, tier: null, paidWithPoints: 0 }).total).toBe(0)
  })
  it("respects rule date windows and weekday conditions", () => {
    const monday = new Date("2026-09-21T14:00:00Z")
    const r = evaluateSalePoints(programme, [weekendDouble], {
      lines: [{ game: "pokemon", kind: "sealed", total: 3000 }],
      at: monday,
      isFirstPurchase: false,
      isBirthdayMonth: false,
      tier: null,
      paidWithPoints: 0,
    })
    expect(r.total).toBe(300)
    const expired = { ...weekendDouble, endsAt: "2026-01-01T00:00:00Z" }
    expect(evaluateSalePoints(programme, [expired], { lines: [{ game: "pokemon", kind: "sealed", total: 3000 }], at: saturday, isFirstPurchase: false, isBirthdayMonth: false, tier: null, paidWithPoints: 0 }).total).toBe(300)
  })
})

describe("trade-in credit points", () => {
  it("earns per pound of credit taken", () => {
    expect(evaluateTradeInPoints(programme, [], 4000, saturday)).toBe(200)
    expect(evaluateTradeInPoints(programme, [], 0, saturday)).toBe(0)
  })
})

describe("redemption", () => {
  it("converts both ways", () => {
    expect(pointsToPence(1250, programme)).toBe(1250)
    expect(penceToPoints(1234, programme)).toBe(1234)
    expect(penceToPoints(1, programme)).toBe(1)
  })
  it("enforces minimum, balance and share of sale", () => {
    expect(checkPointsRedemption(programme, 2000, 400, 5000).reason).toBe("below_minimum")
    expect(checkPointsRedemption(programme, 600, 1000, 5000).reason).toBe("insufficient")
    expect(checkPointsRedemption(programme, 5000, 3000, 5000).reason).toBe("over_share")
    expect(checkPointsRedemption(programme, 5000, 2500, 5000).ok).toBe(true)
  })
})

describe("tiers", () => {
  it("resolves tier and progress from window points, ignoring paid plans", () => {
    expect(tierForPoints(tiers, 0)?.name).toBe("Member")
    expect(tierForPoints(tiers, 2600)?.name).toBe("Regular")
    expect(tierForPoints(tiers, 20000)?.name).toBe("Legend")
    expect(pointsToNextTier(tiers, 2000)).toEqual({ tier: tiers[1], points: 500 })
    expect(pointsToNextTier(tiers, 20000)).toBeNull()
  })
})
