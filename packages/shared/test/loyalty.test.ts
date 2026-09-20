import { describe, expect, it } from "vitest"
import {
  checkPointsRedemption,
  evaluateSalePoints,
  evaluateTradeInPoints,
  parseTierPerk,
  perkAllowance,
  penceToPoints,
  pointsToNextTier,
  pointsToPence,
  resolveTier,
  tierForPoints,
  tierWindowPoints,
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

describe("parseTierPerk", () => {
  it("parses one of each seeded-style perk shape", () => {
    expect(parseTierPerk({ type: "percent_off", value: 10, scope: ["accessory"] })).toEqual({
      type: "percent_off",
      value: 10,
      scope: ["accessory"],
    })
    expect(parseTierPerk({ type: "points_multiplier", value: 1.5 })).toEqual({
      type: "points_multiplier",
      value: 1.5,
    })
    expect(parseTierPerk({ type: "free_event_entries", value: 2, perMonth: true })).toEqual({
      type: "free_event_entries",
      value: 2,
      perMonth: true,
    })
    expect(parseTierPerk({ type: "lounge_hours", value: 12, perMonth: true })).toEqual({
      type: "lounge_hours",
      value: 12,
      perMonth: true,
    })
    expect(parseTierPerk({ type: "priority_release_booking" })).toEqual({ type: "priority_release_booking" })
    expect(parseTierPerk({ type: "member_event_pricing" })).toEqual({ type: "member_event_pricing" })
  })
  it("parses every Legend tier perk from the fixed seed shape", () => {
    const legendPerks = [
      { type: "percent_off", value: 10, scope: ["single", "graded", "retro", "sealed", "accessory", "other"] },
      { type: "points_multiplier", value: 1.5 },
      { type: "free_event_entries", value: 2, perMonth: true },
      { type: "lounge_hours", value: 12, perMonth: true },
      { type: "priority_release_booking" },
    ]
    for (const perk of legendPerks) {
      expect(parseTierPerk(perk)).not.toBeNull()
    }
  })
  it("rejects the pre-fix seed shapes instead of silently misreading them", () => {
    // snake_case per_month, not camelCase perMonth
    expect(parseTierPerk({ type: "free_event_entries", value: 2, per_month: true })).toBeNull()
    // scope as a bare string, not a string array
    expect(parseTierPerk({ type: "percent_off", value: 10, scope: "all" })).toBeNull()
  })
  it("drops a stray field on a perk that carries none of its own", () => {
    expect(parseTierPerk({ type: "priority_release_booking", value: true })).toEqual({
      type: "priority_release_booking",
    })
  })
  it("rejects unknown shapes", () => {
    expect(parseTierPerk(null)).toBeNull()
    expect(parseTierPerk({})).toBeNull()
    expect(parseTierPerk({ type: "not_a_real_perk" })).toBeNull()
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

describe("tierWindowPoints", () => {
  const now = new Date("2026-09-20T12:00:00Z")
  const row = (delta: number, reason: string, created: string) => ({ delta, reason, created })

  it("counts only rows inside the window, at a calendar-month boundary", () => {
    // 12 calendar months back from 20 Sep 2026 is 20 Sep 2025: that instant
    // counts, a second before it does not.
    const rows = [
      row(100, "earn_sale", "2025-09-20T12:00:00Z"),
      row(50, "earn_sale", "2025-09-20T11:59:59Z"),
    ]
    expect(tierWindowPoints(rows, now, 12)).toBe(100)
  })
  it("reads PocketBase's own stored date form as well as ISO", () => {
    expect(tierWindowPoints([row(100, "earn_sale", "2026-09-19 08:00:00.000Z")], now, 12)).toBe(100)
    expect(tierWindowPoints([row(100, "earn_sale", "2024-01-05 09:00:00.000Z")], now, 12)).toBe(0)
  })
  it("excludes redeem and expire, counts a negative adjust and a refund reversal", () => {
    const rows = [
      row(3000, "earn_sale", "2026-09-01T10:00:00Z"),
      row(-1000, "redeem", "2026-09-02T10:00:00Z"),
      row(-500, "expire", "2026-09-03T10:00:00Z"),
      row(-200, "adjust", "2026-09-04T10:00:00Z"),
      row(-300, "refund_reverse", "2026-09-05T10:00:00Z"),
    ]
    expect(tierWindowPoints(rows, now, 12)).toBe(2500)
  })
  it("counts everything when the window is 0 (all time)", () => {
    const rows = [
      row(100, "earn_sale", "2019-01-01T00:00:00Z"),
      row(-40, "redeem", "2019-01-02T00:00:00Z"),
    ]
    expect(tierWindowPoints(rows, now, 0)).toBe(100)
  })
  it("skips a row with an unreadable date rather than counting it", () => {
    expect(tierWindowPoints([row(100, "earn_sale", "not a date")], now, 12)).toBe(0)
    expect(tierWindowPoints([], now, 12)).toBe(0)
  })
})

describe("perkAllowance", () => {
  it("reads the tier's own monthly allowance, 0 when it has none", () => {
    const legend: LoyaltyTier = {
      id: "l",
      name: "Legend",
      thresholdPoints: 10000,
      sort: 2,
      perks: [
        { type: "free_event_entries", value: 2, perMonth: true },
        { type: "lounge_hours", value: 12, perMonth: true },
      ],
      paidPlan: false,
    }
    expect(perkAllowance(legend, "free_event_entries")).toBe(2)
    expect(perkAllowance(legend, "lounge_hours")).toBe(12)
    expect(perkAllowance(tiers[0] ?? null, "free_event_entries")).toBe(0)
    expect(perkAllowance(null, "lounge_hours")).toBe(0)
  })
})

describe("resolveTier", () => {
  it("pins the membership's tier over the earned one, both ways", () => {
    expect(resolveTier(tiers, 0, "pass")?.name).toBe("Guild Pass")
    expect(resolveTier(tiers, 20000, "pass")?.name).toBe("Guild Pass")
    expect(resolveTier(tiers, 20000, null)?.name).toBe("Legend")
    expect(resolveTier(tiers, 2600, null)?.name).toBe("Regular")
  })
  it("falls back to the earned tier when the pinned one no longer exists", () => {
    expect(resolveTier(tiers, 2600, "deleted-tier-id")?.name).toBe("Regular")
  })
})
