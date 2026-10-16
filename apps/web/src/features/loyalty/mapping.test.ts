import { describe, expect, it } from "vitest"

import {
  endOfDayLondon,
  formToReward,
  formToRule,
  emptyReward,
  emptyRule,
  ruleToForm,
  validateReward,
  validateTier,
  emptyTier,
} from "@/features/loyalty/mapping"

describe("endOfDayLondon", () => {
  it("is the last instant of that day, not its first", () => {
    // Winter: London is UTC, so the day ends at 23:59:59.999Z.
    expect(endOfDayLondon("2026-01-15")).toBe("2026-01-15T23:59:59.999Z")
    // Summer: London is an hour ahead, so it ends at 22:59:59.999Z.
    expect(endOfDayLondon("2026-07-15")).toBe("2026-07-15T22:59:59.999Z")
    // The day the clocks go back is still a whole day.
    expect(endOfDayLondon("2026-10-25")).toBe("2026-10-25T23:59:59.999Z")
  })

  it("is nothing at all for an empty or unreadable date", () => {
    expect(endOfDayLondon("")).toBe("")
    expect(endOfDayLondon("not a date")).toBe("")
  })

  it("leaves a rule live for the whole of the day it ends on", () => {
    const rule = formToRule({ ...emptyRule("k"), name: "Half term", endsAt: "2026-10-31" })
    const ends = new Date(rule.ends_at)
    // Five to midnight on the 31st, in the shop: still live.
    expect(new Date("2026-10-31T23:55:00Z").getTime()).toBeLessThan(ends.getTime())
    // A minute after midnight on the 1st: over.
    expect(new Date("2026-11-01T00:01:00Z").getTime()).toBeGreaterThan(ends.getTime())
  })

  it("reads back into the date field as the day that was typed", () => {
    const written = formToRule({ ...emptyRule("k"), name: "Summer", endsAt: "2026-07-15" })
    const form = ruleToForm({
      id: "rule_1",
      name: written.name,
      type: written.type,
      conditions: written.conditions,
      value: written.value,
      active: written.active,
      priority: written.priority,
      starts_at: written.starts_at,
      ends_at: written.ends_at,
    })
    expect(form.endsAt).toBe("2026-07-15")
  })

  it("does the same for a reward", () => {
    const reward = formToReward({
      ...emptyReward("k"),
      name: "Half term booster",
      costPoints: "450",
      endsAt: "2026-10-31",
    })
    expect(reward.ends_at).toBe("2026-10-31T23:59:59.999Z")
  })
})

describe("the field limits and what they refuse", () => {
  it("names the limit a points field actually has", () => {
    const refusal = validateReward({
      ...emptyReward("k"),
      name: "Too dear",
      costPoints: "1234567",
    }).costPoints
    expect(refusal).toBe("A cost is a whole number of points, up to 999,999.")

    const tier = validateTier(
      { ...emptyTier("k", 10), name: "Legend", thresholdPoints: "1234567" },
      []
    ).thresholdPoints
    expect(tier).toBe("A threshold is a whole number of points, up to 999,999.")
  })

  it("takes the largest figure the field can hold", () => {
    expect(
      validateReward({ ...emptyReward("k"), name: "Dear", costPoints: "999999" })
        .costPoints
    ).toBeUndefined()
  })
})
