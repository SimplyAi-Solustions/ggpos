import { describe, expect, it } from "vitest"

import { todayForInput, validateComp } from "@/features/pricing/comp-form"

const NOW = new Date("2026-09-20T12:00:00.000Z")

const good = {
  price: "45.00",
  url: "https://www.ebay.co.uk/itm/226119440823",
  soldAt: "2026-09-12",
}

describe("validateComp", () => {
  it("turns a good comp into the route's own body, in pence", () => {
    const result = validateComp(good, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toEqual({
      price: 4500,
      url: "https://www.ebay.co.uk/itm/226119440823",
      sold_at: "2026-09-12",
    })
  })

  it("takes an ebay.co.uk link with or without the www", () => {
    expect(validateComp({ ...good, url: "https://ebay.co.uk/itm/1" }, NOW).ok).toBe(true)
  })

  it("refuses anything that is not an ebay.co.uk item link", () => {
    for (const url of [
      "https://www.ebay.com/itm/1",
      "http://www.ebay.co.uk/itm/1",
      "https://www.ebay.co.uk/sch/i.html?_nkw=charizard",
      "",
    ]) {
      const result = validateComp({ ...good, url }, NOW)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors.url).toBe(
        "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...)."
      )
    }
  })

  it("refuses a price it cannot read, or nothing at all", () => {
    for (const price of ["", "lots", "-5.00", "0"]) {
      const result = validateComp({ ...good, price }, NOW)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors.price).toBe(
        "Enter the price it sold for, in pounds and pence, like 45.00."
      )
    }
  })

  it("refuses a sale date in the future", () => {
    const result = validateComp({ ...good, soldAt: "2026-09-21" }, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.soldAt).toBe("That sale date is in the future.")
  })

  it("refuses a sale more than 30 days old, in the server's words", () => {
    const result = validateComp({ ...good, soldAt: "2026-08-01" }, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.soldAt).toBe(
      "That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days."
    )
  })

  it("counts whole days, so a sale exactly 30 days old still counts", () => {
    // Whole calendar days from midnight today, exactly as the route counts
    // them (pb_hooks/adapters/pricing_policy.js). Measuring from "now",
    // which carries the time of day, refused a comp sold 30 days ago for
    // the afternoon shift and took it for the morning one.
    expect(validateComp({ ...good, soldAt: "2026-08-21" }, NOW).ok).toBe(true)
    expect(validateComp({ ...good, soldAt: "2026-08-20" }, NOW).ok).toBe(false)
  })

  it("agrees with itself whatever time of day it is asked", () => {
    const morning = new Date("2026-09-20T07:00:00.000Z")
    const evening = new Date("2026-09-20T19:30:00.000Z")
    const thirtyDaysAgo = { ...good, soldAt: "2026-08-21" }
    expect(validateComp(thirtyDaysAgo, morning).ok).toBe(true)
    expect(validateComp(thirtyDaysAgo, evening).ok).toBe(true)
  })

  it("takes a sale from today, and refuses tomorrow's", () => {
    expect(validateComp({ ...good, soldAt: "2026-09-20" }, NOW).ok).toBe(true)
    const future = validateComp({ ...good, soldAt: "2026-09-21" }, NOW)
    expect(future.ok).toBe(false)
    if (future.ok) return
    expect(future.errors.soldAt).toBe("That sale date is in the future.")
  })

  it("refuses a price that is pounds where pence were asked for", () => {
    // £50,000.01 in pence, one penny over the route's own ceiling.
    const result = validateComp({ ...good, price: "50000.01" }, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.price).toBe(
      "That price looks too high. Check it is in pence, not pounds, and try again."
    )
    expect(validateComp({ ...good, price: "50000.00" }, NOW).ok).toBe(true)
  })

  it("refuses a date it cannot read", () => {
    const result = validateComp({ ...good, soldAt: "12/09/2026" }, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.soldAt).toBe("Enter the date it sold, as YYYY-MM-DD.")
  })

  it("reports every problem at once, so nothing is fixed twice", () => {
    const result = validateComp({ price: "", url: "nope", soldAt: "" }, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(["price", "soldAt", "url"])
  })
})

describe("todayForInput", () => {
  it("defaults the date field to today", () => {
    expect(todayForInput(NOW)).toBe("2026-09-20")
  })
})
