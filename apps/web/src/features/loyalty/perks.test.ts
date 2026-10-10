import { describe, expect, it } from "vitest"
import type { TierPerk } from "@gg/shared"

import {
  currentPeriod,
  isCountedPerk,
  nextPeriodDate,
  perkCountLine,
  perkRefusal,
  perkValueLine,
  remaining,
  walletFromPerks,
} from "@/features/loyalty/perks"
import { perkAllowance } from "@/features/loyalty/window"
import type { PerkWalletEntry } from "@/lib/api/types"

const PERKS: TierPerk[] = [
  { type: "percent_off", value: 10, scope: ["single", "sealed"] },
  { type: "points_multiplier", value: 1.5 },
  { type: "free_event_entries", value: 2, perMonth: true },
  { type: "lounge_hours", value: 12, perMonth: true },
  { type: "priority_release_booking" },
  { type: "member_event_pricing" },
]

describe("currentPeriod", () => {
  it("is the calendar month in the shop's own timezone", () => {
    expect(currentPeriod(new Date("2026-09-20T12:00:00Z"))).toBe("2026-09")
    // Half past midnight on 1 October in London is still 1 October in UTC+1.
    expect(currentPeriod(new Date("2026-09-30T23:30:00Z"))).toBe("2026-10")
    // And a winter date, when London is UTC.
    expect(currentPeriod(new Date("2026-01-31T23:30:00Z"))).toBe("2026-01")
  })
})

describe("nextPeriodDate", () => {
  it("is the first of the month after this one", () => {
    expect(nextPeriodDate(new Date("2026-09-20T12:00:00Z"))).toBe("1 Oct")
    expect(nextPeriodDate(new Date("2026-12-02T12:00:00Z"))).toBe("1 Jan")
  })
})

describe("walletFromPerks", () => {
  it("gives the counted perks an allowance, a use count and a period", () => {
    const wallet = walletFromPerks(PERKS, { free_event_entries: 1 }, "2026-09")
    const entries = wallet.find((entry) => entry.type === "free_event_entries")
    const hours = wallet.find((entry) => entry.type === "lounge_hours")

    expect(entries).toEqual({
      type: "free_event_entries",
      value: 2,
      allowed: 2,
      used: 1,
      period: "2026-09",
    })
    // Nothing used is nothing used, not a missing figure.
    expect(hours).toEqual({
      type: "lounge_hours",
      value: 12,
      allowed: 12,
      used: 0,
      period: "2026-09",
    })
  })

  it("carries the informational perks without an allowance", () => {
    const wallet = walletFromPerks(PERKS, {}, "2026-09")
    expect(wallet.find((entry) => entry.type === "percent_off")).toEqual({
      type: "percent_off",
      value: 10,
      scope: ["single", "sealed"],
    })
    expect(wallet.find((entry) => entry.type === "points_multiplier")).toEqual({
      type: "points_multiplier",
      value: 1.5,
    })
    expect(wallet.find((entry) => entry.type === "member_event_pricing")).toEqual({
      type: "member_event_pricing",
    })
  })

  it("keeps the tier's own order", () => {
    expect(walletFromPerks(PERKS, {}, "2026-09").map((entry) => entry.type)).toEqual(
      PERKS.map((perk) => perk.type)
    )
  })
})

describe("remaining and perkCountLine", () => {
  const entry = (used: number): PerkWalletEntry => ({
    type: "free_event_entries",
    value: 2,
    allowed: 2,
    used,
    period: "2026-09",
  })

  it("counts down and stops at nothing left", () => {
    expect(remaining(entry(0))).toBe(2)
    expect(remaining(entry(2))).toBe(0)
    // An allowance cut after somebody used theirs never reads as a negative.
    expect(remaining({ ...entry(3), allowed: 2 })).toBe(0)
  })

  it("says what is left of what", () => {
    expect(perkCountLine(entry(1))).toBe("1 of 2 left this month")
    expect(perkCountLine({ ...entry(0), allowed: 1200, value: 1200 })).toBe(
      "1,200 of 1,200 left this month"
    )
  })
})

describe("perkValueLine", () => {
  it("says what each informational perk is worth", () => {
    expect(
      perkValueLine({ type: "percent_off", value: 10, scope: ["single", "sealed"] })
    ).toBe("10% off single, sealed")
    expect(perkValueLine({ type: "percent_off", value: 5, scope: [] })).toBe(
      "5% off everything"
    )
    expect(perkValueLine({ type: "points_multiplier", value: 1.5 })).toBe(
      "1.5 times the points on a sale"
    )
    expect(perkValueLine({ type: "priority_release_booking" })).toBe(
      "Books a release before general sale"
    )
    expect(perkValueLine({ type: "member_event_pricing" })).toBe(
      "Member price at ticketed events"
    )
  })
})

describe("perkAllowance", () => {
  const tier = {
    id: "tier_pass",
    name: "Guild Pass",
    thresholdPoints: 0,
    sort: 40,
    perks: PERKS,
    paidPlan: true,
  }

  it("is the tier's monthly figure, or nothing at all", () => {
    expect(perkAllowance(tier, "free_event_entries")).toBe(2)
    expect(perkAllowance(tier, "lounge_hours")).toBe(12)
    expect(perkAllowance({ ...tier, perks: [] }, "lounge_hours")).toBe(0)
    expect(perkAllowance(null, "free_event_entries")).toBe(0)
  })
})

describe("perkRefusal", () => {
  const now = new Date("2026-09-20T12:00:00Z")

  it("says when the next ones come", () => {
    expect(perkRefusal("free_event_entries", 2, now)).toBe(
      "Both free entries this month are used. The next two come on 1 Oct."
    )
    expect(perkRefusal("free_event_entries", 1, now)).toBe(
      "The free entry this month is used. The next one comes on 1 Oct."
    )
    expect(perkRefusal("free_event_entries", 4, now)).toBe(
      "All 4 free entries this month are used. The next 4 come on 1 Oct."
    )
    expect(perkRefusal("lounge_hours", 12, now)).toBe(
      "All 12 lounge hours this month are used. The next 12 come on 1 Oct."
    )
  })

  it("says what to change when the tier has no such perk", () => {
    expect(perkRefusal("lounge_hours", 0, now)).toBe(
      "This tier has no lounge hours. Change the tier's perks to add some."
    )
    expect(perkRefusal("free_event_entries", 0, now)).toBe(
      "This tier has no free event entries. Change the tier's perks to add some."
    )
  })
})

describe("isCountedPerk", () => {
  it("knows the two that have an allowance", () => {
    expect(isCountedPerk("free_event_entries")).toBe(true)
    expect(isCountedPerk("lounge_hours")).toBe(true)
    expect(isCountedPerk("percent_off")).toBe(false)
    expect(isCountedPerk("anything else")).toBe(false)
  })
})
