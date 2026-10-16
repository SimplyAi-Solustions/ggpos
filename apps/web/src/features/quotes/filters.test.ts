import { describe, expect, it } from "vitest"

import {
  canCancel,
  canOffer,
  offerHasExpired,
  showsQuoteMessage,
  statusesFor,
  statusesForFilters,
} from "@/features/quotes/filters"
import type { QuoteStatus } from "@/lib/api/types"

describe("statusesForFilters", () => {
  it("asks for everything when no chip is pressed", () => {
    expect(statusesForFilters([])).toEqual([])
  })

  it("puts the two statuses waiting on us under one chip", () => {
    expect(statusesForFilters(["waiting"])).toEqual(["submitted", "reviewing"])
  })

  it("treats several chips as an or", () => {
    expect(statusesForFilters(["offered", "accepted"])).toEqual([
      "offered",
      "accepted",
    ])
  })

  it("counts a received quote as closed, because it is on a buy-in now", () => {
    expect(statusesFor("closed")).toContain("received")
    expect(statusesForFilters(["closed"])).toHaveLength(4)
  })

  it("never asks for the same status twice", () => {
    const statuses = statusesForFilters(["waiting", "waiting", "offered"])
    expect(statuses).toEqual([...new Set(statuses)])
  })
})

describe("canOffer", () => {
  it("is true only while the quote is still ours to price", () => {
    expect(canOffer("submitted")).toBe(true)
    expect(canOffer("reviewing")).toBe(true)
    for (const status of [
      "offered",
      "accepted",
      "received",
      "completed",
      "declined",
      "expired",
    ] as QuoteStatus[]) {
      expect(canOffer(status)).toBe(false)
    }
  })
})

describe("canCancel", () => {
  it("refuses the four the route refuses", () => {
    for (const status of ["declined", "expired", "completed", "received"] as QuoteStatus[]) {
      expect(canCancel(status)).toBe(false)
    }
    for (const status of ["submitted", "reviewing", "offered", "accepted"] as QuoteStatus[]) {
      expect(canCancel(status)).toBe(true)
    }
  })
})

describe("offerHasExpired", () => {
  const now = new Date("2026-09-20T14:00:00Z")

  it("is false without an expiry", () => {
    expect(offerHasExpired(null, now)).toBe(false)
    expect(offerHasExpired("not a date", now)).toBe(false)
  })

  it("is true the moment the expiry has passed", () => {
    expect(offerHasExpired("2026-09-20T13:59:00Z", now)).toBe(true)
    expect(offerHasExpired("2026-09-27T09:00:00Z", now)).toBe(false)
  })
})

describe("showsQuoteMessage", () => {
  it("shows the message when the thread is empty", () => {
    expect(showsQuoteMessage("Four holos", [])).toBe(true)
  })

  it("holds it back when the thread already opens with it", () => {
    expect(
      showsQuoteMessage("Four holos", [{ author: "customer", body: " Four holos " }])
    ).toBe(false)
  })

  it("shows it when the thread opens with something else", () => {
    expect(
      showsQuoteMessage("Four holos", [{ author: "staff", body: "Four holos" }])
    ).toBe(true)
    expect(
      showsQuoteMessage("Four holos", [{ author: "customer", body: "And a slab" }])
    ).toBe(true)
  })

  it("is false when there is no message at all", () => {
    expect(showsQuoteMessage(undefined, [])).toBe(false)
    expect(showsQuoteMessage("   ", [])).toBe(false)
  })
})
