import { describe, expect, it } from "vitest"

import {
  descriptionParagraphs,
  formatMultiplier,
  formatPoints,
  listWords,
  perkCountLine,
  perkLine,
  pointsDelta,
  pointsNote,
  pointsWord,
  referralProgressSentence,
  referralSentence,
  rewardReasonSentence,
  rewardWorth,
  scopeWords,
  tierProgressSentence,
  tierRail,
  voucherIsLive,
  voucherRunOut,
  voucherStatusWord,
} from "@/features/portal/guild"
import type { PortalReward, PortalVoucher } from "@/lib/api/guild"

describe("points", () => {
  it("groups a figure the way a UK reader expects", () => {
    expect(formatPoints(2580)).toBe("2,580")
    expect(formatPoints(0)).toBe("0")
    expect(formatPoints(10_000)).toBe("10,000")
  })

  it("counts one point as a point", () => {
    expect(pointsWord(1)).toBe("1 point")
    expect(pointsWord(250)).toBe("250 points")
    expect(pointsWord(0)).toBe("0 points")
  })

  it("carries the sign on a movement", () => {
    expect(pointsDelta(320)).toBe("+320")
    expect(pointsDelta(-500)).toBe("-500")
    expect(pointsDelta(-1200)).toBe("-1,200")
    expect(pointsDelta(0)).toBe("0")
  })

  it("says the server's own sentence when there is one", () => {
    expect(pointsNote({ reason: "earn_sale", note: "Earned on a £42.00 sale" })).toBe(
      "Earned on a £42.00 sale"
    )
  })

  it("falls back to a sentence per reason, and never to a blank", () => {
    expect(pointsNote({ reason: "welcome" })).toBe("Welcome bonus")
    expect(pointsNote({ reason: "referral", note: "  " })).toBe("Referral bonus")
    expect(pointsNote({ reason: "refund_reverse" })).toBe("Taken back after a refund")
    expect(pointsNote({ reason: "something_new" })).toBe("Points change")
  })
})

describe("tierRail", () => {
  it("places the marker by the share of the next threshold reached", () => {
    const rail = tierRail({
      window_points: 4080,
      next: { name: "Legend", points_needed: 5920 },
    })
    expect(rail.target).toBe(10_000)
    expect(rail.targetName).toBe("Legend")
    expect(rail.position).toBeCloseTo(0.408, 5)
    expect(rail.atTop).toBe(false)
  })

  it("fills the rail at the top tier, with nothing to aim at", () => {
    const rail = tierRail({ window_points: 12_000, next: null })
    expect(rail).toEqual({
      position: 1,
      target: null,
      targetName: null,
      atTop: true,
    })
  })

  it("starts at nothing for a new member", () => {
    const rail = tierRail({
      window_points: 0,
      next: { name: "Regular", points_needed: 2500 },
    })
    expect(rail.position).toBe(0)
    expect(rail.target).toBe(2500)
  })

  it("never runs past either end", () => {
    // A refund reversal can take the window negative, and a threshold can be
    // reached before the nightly recompute moves the tier.
    expect(
      tierRail({ window_points: -200, next: { name: "Regular", points_needed: 2700 } })
        .position
    ).toBe(0)
    expect(
      tierRail({ window_points: 2500, next: { name: "Regular", points_needed: 0 } })
        .position
    ).toBe(1)
  })
})

describe("tierProgressSentence", () => {
  it("says how far it is to the next tier", () => {
    expect(
      tierProgressSentence({ next: { name: "Regular", points_needed: 1240 } })
    ).toBe("1,240 points to Regular")
    expect(tierProgressSentence({ next: { name: "Legend", points_needed: 1 } })).toBe(
      "1 point to Legend"
    )
  })

  it("says so at the top", () => {
    expect(tierProgressSentence({ next: null })).toBe("You are at the top")
  })
})

describe("perks", () => {
  it("counts what has been used this month", () => {
    expect(
      perkLine({ type: "free_event_entries", value: 2, allowed: 2, used: 1 })
    ).toEqual({
      title: "Free event entries",
      detail: "1 of 2 used this month",
    })
    expect(perkLine({ type: "lounge_hours", allowed: 12, used: 3 }).detail).toBe(
      "3 of 12 used this month"
    )
  })

  it("never counts more used than allowed, or an allowance of none", () => {
    expect(perkCountLine({ type: "lounge_hours", allowed: 2, used: 5 })).toBe(
      "2 of 2 used this month"
    )
    expect(perkCountLine({ type: "free_event_entries", allowed: 0, used: 0 })).toBe(
      "None this month"
    )
  })

  it("says the informational perks in words", () => {
    expect(perkLine({ type: "percent_off", value: 5, scope: ["sealed"] }).title).toBe(
      "5% off sealed product"
    )
    expect(perkLine({ type: "points_multiplier", value: 1.25 }).title).toBe(
      "1.25x points"
    )
    expect(perkLine({ type: "priority_release_booking" }).title).toBe(
      "Priority booking on new releases"
    )
    expect(perkLine({ type: "member_event_pricing" }).title).toBe(
      "Member prices at events"
    )
  })

  it("calls a scope of every kind everything", () => {
    expect(
      scopeWords(["single", "graded", "retro", "sealed", "accessory", "other"])
    ).toBe("everything")
    expect(scopeWords([])).toBe("everything")
    expect(scopeWords(undefined)).toBe("everything")
    expect(scopeWords(["single", "retro"])).toBe("singles and retro games")
    // A kind this build has never heard of is still said, not dropped.
    expect(scopeWords(["plush"])).toBe("plush")
  })

  it("joins words the way a sentence does", () => {
    expect(listWords([])).toBe("")
    expect(listWords(["singles"])).toBe("singles")
    expect(listWords(["singles", "sealed product"])).toBe("singles and sealed product")
    expect(listWords(["a", "b", "c"])).toBe("a, b and c")
  })

  it("drops a trailing zero from a multiplier", () => {
    expect(formatMultiplier(1.5)).toBe("1.5")
    expect(formatMultiplier(2)).toBe("2")
    expect(formatMultiplier(1.25)).toBe("1.25")
  })
})

describe("referrals", () => {
  it("promises both sides the same when the bonuses match", () => {
    expect(referralSentence({ bonus_referrer: 250, bonus_referee: 250 })).toBe(
      "Give a friend this code when they join at the counter. You both get 250 points after their first buy-in or purchase."
    )
  })

  it("says each side's own figure when they differ", () => {
    expect(referralSentence({ bonus_referrer: 250, bonus_referee: 100 })).toBe(
      "Give a friend this code when they join at the counter. They get 100 points and you get 250 points after their first buy-in or purchase."
    )
  })

  it("promises nothing when the programme pays nothing", () => {
    expect(referralSentence({ bonus_referrer: 0, bonus_referee: 0 })).toBe(
      "Give a friend this code when they join at the counter."
    )
  })

  it("counts who has earned and who is still to come in", () => {
    expect(referralProgressSentence(0, 0)).toBe("Nobody has used your code yet.")
    expect(referralProgressSentence(2, 1)).toBe(
      "2 friends have earned you points, and 1 is still to make their first visit."
    )
    expect(referralProgressSentence(1, 0)).toBe("1 friend has earned you points.")
    expect(referralProgressSentence(0, 1)).toBe(
      "1 friend has joined and is still to make their first visit."
    )
    expect(referralProgressSentence(0, 2)).toBe(
      "2 friends have joined and are still to make their first visit."
    )
  })
})

function reward(over: Partial<PortalReward> = {}): PortalReward {
  return {
    id: "reward_1",
    name: "Free booster pack",
    description_html: "<p>Any current booster.</p>",
    cost_points: 500,
    type: "free_item",
    value: 0,
    image_url: "",
    remaining: null,
    per_customer_remaining: null,
    can_redeem: true,
    reason: "ok",
    ...over,
  }
}

describe("rewardReasonSentence", () => {
  it("says nothing at all when it can be redeemed", () => {
    expect(rewardReasonSentence(reward(), 900)).toBeNull()
  })

  it("says what is short, and what they have", () => {
    expect(
      rewardReasonSentence(
        reward({ can_redeem: false, reason: "insufficient", cost_points: 500 }),
        320
      )
    ).toBe("You need 500 points and have 320.")
  })

  it("drops the balance clause while the balance is unknown", () => {
    // `/me` still in flight: what it costs is known, what they hold is not,
    // and "and have 0" would be a claim about somebody's own points.
    expect(
      rewardReasonSentence(
        reward({ can_redeem: false, reason: "insufficient", cost_points: 500 }),
        null
      )
    ).toBe("You need 500 points for this.")
    expect(
      rewardReasonSentence(reward({ can_redeem: false, reason: "sold_out" }), null)
    ).toBe("None left at the moment.")
    expect(rewardReasonSentence(reward(), null)).toBeNull()
  })

  it("says why in words for every other refusal", () => {
    expect(
      rewardReasonSentence(reward({ can_redeem: false, reason: "sold_out" }), 900)
    ).toBe("None left at the moment.")
    expect(
      rewardReasonSentence(reward({ can_redeem: false, reason: "limit_reached" }), 900)
    ).toBe("You have had this one already.")
    expect(
      rewardReasonSentence(reward({ can_redeem: false, reason: "not_yet" }), 900)
    ).toBe("This one is not open yet.")
    expect(
      rewardReasonSentence(
        reward({ can_redeem: false, reason: "something" as PortalReward["reason"] }),
        900
      )
    ).toBe("Not available just now.")
  })
})

describe("rewardWorth", () => {
  it("says money as money and the rest in words", () => {
    expect(rewardWorth("money_off", 1000)).toBe("£10.00 off a purchase")
    expect(rewardWorth("store_credit", 500)).toBe("£5.00 of store credit")
    expect(rewardWorth("free_item", 0)).toBe("One free item")
    expect(rewardWorth("event_entry", 0)).toBe("One event entry")
    expect(rewardWorth("custom", 0)).toBe("")
  })
})

describe("descriptionParagraphs", () => {
  it("keeps the words and the paragraph breaks", () => {
    expect(
      descriptionParagraphs("<p>Any current booster.</p><p>One per voucher.</p>")
    ).toEqual(["Any current booster.", "One per voucher."])
  })

  it("takes a line break as a break", () => {
    expect(descriptionParagraphs("One line<br>Another line")).toEqual([
      "One line Another line",
    ])
  })

  it("decodes the entities an editor writes", () => {
    expect(descriptionParagraphs("<p>Tea &amp; biscuits, &pound;5</p>")).toEqual([
      "Tea & biscuits, £5",
    ])
  })

  it("never hands a browser markup: a script is dropped whole", () => {
    const out = descriptionParagraphs(
      "<p>Safe</p><script>alert('x')</script><p>Also safe</p>"
    )
    expect(out).toEqual(["Safe", "Also safe"])
    expect(out.join(" ")).not.toContain("alert")
  })

  it("answers nothing for nothing", () => {
    expect(descriptionParagraphs(undefined)).toEqual([])
    expect(descriptionParagraphs("   ")).toEqual([])
    expect(descriptionParagraphs("<p></p>")).toEqual([])
  })
})

function voucher(over: Partial<PortalVoucher> = {}): PortalVoucher {
  return {
    id: "vch_1",
    number: "GG-V-000007",
    code: "GGV7QB2MX",
    reward: { name: "Free booster pack", type: "free_item", value: 0 },
    status: "issued",
    expires_at: "2026-12-20T12:00:00Z",
    created: "2026-09-11T12:00:00Z",
    ...over,
  }
}

describe("vouchers", () => {
  const now = new Date("2026-09-20T12:00:00Z")

  it("is live while it is issued and in date", () => {
    expect(voucherIsLive(voucher(), now)).toBe(true)
    expect(voucherStatusWord(voucher(), now)).toBe("Ready to use")
  })

  it("reads as expired the moment the date passes, cron or no cron", () => {
    const past = voucher({ expires_at: "2026-08-01T12:00:00Z" })
    expect(voucherRunOut(past, now)).toBe(true)
    expect(voucherIsLive(past, now)).toBe(false)
    expect(voucherStatusWord(past, now)).toBe("Expired")
  })

  it("says the other states in words", () => {
    expect(voucherStatusWord(voucher({ status: "used" }), now)).toBe("Used")
    expect(voucherStatusWord(voucher({ status: "cancelled" }), now)).toBe("Cancelled")
    expect(voucherStatusWord(voucher({ status: "expired" }), now)).toBe("Expired")
  })

  it("treats a voucher with no expiry as one that does not run out", () => {
    const forever = voucher({ expires_at: null })
    expect(voucherRunOut(forever, now)).toBe(false)
    expect(voucherIsLive(forever, now)).toBe(true)
  })
})
