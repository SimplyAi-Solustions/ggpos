import { describe, expect, it } from "vitest"

import {
  conditionLabel,
  DEFAULT_ONLINE_SETTINGS,
  isOnline,
  onlineProblem,
  ratioOf,
  readOnlineSettings,
} from "../src/online"

/**
 * The website shows an item only while it is marked, on the shelf, and at
 * or over the shop's floor (docs/api-contract-launch.md, section 6). The
 * feed and the item page read this one rule.
 */

const SHOWN = { show_online: true, status: "in_stock", qty: 1, price: 4500 }

describe("settings.online", () => {
  it("fills what is missing with the defaults", () => {
    expect(readOnlineSettings(null)).toEqual(DEFAULT_ONLINE_SETTINGS)
    expect(readOnlineSettings({})).toEqual({ enabled: true, min_price: 0, hide_qty: false })
  })

  it("keeps what is stored, and never a negative or fractional floor", () => {
    expect(readOnlineSettings({ enabled: false, min_price: 500, hide_qty: true })).toEqual({
      enabled: false,
      min_price: 500,
      hide_qty: true,
    })
    expect(readOnlineSettings({ min_price: -20 }).min_price).toBe(0)
    expect(readOnlineSettings({ min_price: "abc" }).min_price).toBe(0)
    expect(readOnlineSettings({ min_price: 499.6 }).min_price).toBe(500)
  })
})

describe("whether an item is online", () => {
  const settings = readOnlineSettings({ enabled: true, min_price: 500 })

  it("is when it is marked, in stock, on the shelf and over the floor", () => {
    expect(onlineProblem(SHOWN, settings)).toBeNull()
    expect(isOnline(SHOWN, settings)).toBe(true)
    // The floor itself is allowed.
    expect(isOnline({ ...SHOWN, price: 500 }, settings)).toBe(true)
  })

  it("says why it is not, in order", () => {
    expect(onlineProblem(SHOWN, { ...settings, enabled: false })).toBe(
      "The website feed is switched off in Settings, Website."
    )
    expect(onlineProblem({ ...SHOWN, show_online: false }, settings)).toBe("Not shown on the website.")
    expect(onlineProblem({ ...SHOWN, status: "sold" }, settings)).toBe("Sold, so it is off the website.")
    expect(onlineProblem({ ...SHOWN, status: "reserved" }, settings)).toBe(
      "Reserved, so it is off the website until the hold ends."
    )
    expect(onlineProblem({ ...SHOWN, status: "written_off" }, settings)).toBe(
      "Only stock on the shelf shows on the website."
    )
    expect(onlineProblem({ ...SHOWN, qty: 0 }, settings)).toBe(
      "None left on the shelf, so it is off the website."
    )
    expect(onlineProblem({ ...SHOWN, price: 499 }, settings)).toBe(
      "Under the website's minimum price of £5.00."
    )
  })

  it("treats a missing quantity as none on the shelf", () => {
    expect(isOnline({ ...SHOWN, qty: null }, settings)).toBe(false)
  })
})

describe("the condition in words", () => {
  it("spells out a card's grade", () => {
    expect(conditionLabel({ kind: "single", condition: "NM" })).toBe("Near mint")
    expect(conditionLabel({ kind: "single", condition: "DMG" })).toBe("Damaged")
    expect(conditionLabel({ kind: "single", condition: "" })).toBe("")
  })

  it("names a slab by its company and grade", () => {
    expect(conditionLabel({ kind: "graded", grade_company: "PSA", grade: "10" })).toBe("PSA 10")
    expect(conditionLabel({ kind: "graded" })).toBe("Graded")
  })

  it("gives retro its completeness and sealed product its seal", () => {
    expect(conditionLabel({ kind: "retro", completeness: "cib" })).toBe("Complete in box")
    expect(conditionLabel({ kind: "retro", completeness: "" })).toBe("")
    expect(conditionLabel({ kind: "sealed" })).toBe("Sealed")
  })
})

describe("a frame's ratio", () => {
  it("is width over height to four places", () => {
    expect(ratioOf(63, 88)).toBe(0.7159)
    expect(ratioOf(4, 3)).toBe(1.3333)
  })

  it("falls back to 3:4", () => {
    expect(ratioOf(0, 88)).toBe(0.75)
    expect(ratioOf(Number.NaN, 1)).toBe(0.75)
  })
})
