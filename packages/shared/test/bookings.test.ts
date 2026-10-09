import { describe, expect, it } from "vitest"

import {
  bookingPrice,
  bookingProblem,
  daySlots,
  entryFee,
  isBritishSummerTime,
  placesLeft,
  sessionCharge,
  shopClock,
  shopDateOf,
  shopTimeToUtc,
  weekdayOf,
  type OpeningHours,
} from "../src/bookings"

const SHOP: OpeningHours = { fri: [["10:00", "22:00"]], sat: [["10:00", "13:00"], ["14:00", "16:00"]], sun: [] }
const TABLE = {
  id: "t2",
  name: "Table 2",
  kind: "table" as const,
  hours: null,
  slot_minutes: 60,
  active: true,
  price: 500,
  member_price: 400,
  deposit: 200,
}

describe("shop time", () => {
  it("knows when British Summer Time is in force", () => {
    expect(isBritishSummerTime(new Date("2026-10-16T12:00:00Z"))).toBe(true)
    expect(isBritishSummerTime(new Date("2026-10-25T00:59:00Z"))).toBe(true)
    expect(isBritishSummerTime(new Date("2026-10-25T01:00:00Z"))).toBe(false)
    expect(isBritishSummerTime(new Date("2026-12-01T12:00:00Z"))).toBe(false)
    expect(isBritishSummerTime(new Date("2026-03-29T01:00:00Z"))).toBe(true)
  })

  it("turns a shop clock reading into the right instant either side of the change", () => {
    expect(shopTimeToUtc("2026-10-16", "18:00").toISOString()).toBe("2026-10-16T17:00:00.000Z")
    expect(shopTimeToUtc("2026-11-06", "18:00").toISOString()).toBe("2026-11-06T18:00:00.000Z")
    expect(shopClock("2026-10-16T17:00:00.000Z")).toBe("18:00")
    expect(shopDateOf(new Date("2026-10-16T23:30:00Z"))).toBe("2026-10-17")
  })

  it("names the weekday of a date", () => {
    expect(weekdayOf("2026-10-16")).toBe("fri")
    expect(weekdayOf("2026-10-18")).toBe("sun")
  })
})

describe("daySlots", () => {
  it("lays slots across every opening window, none on a closed day", () => {
    expect(daySlots(TABLE, SHOP, "2026-10-17", [])).toHaveLength(5)
    expect(daySlots(TABLE, SHOP, "2026-10-18", [])).toHaveLength(0)
  })

  it("marks a slot busy when anything overlaps it, and a past one when now is given", () => {
    const busy = [{ starts_at: "2026-10-16T17:00:00.000Z", ends_at: "2026-10-16T18:00:00.000Z" }]
    const slots = daySlots(TABLE, SHOP, "2026-10-16", busy, new Date("2026-10-16T10:30:00Z"))
    const at = (clock: string) => slots.find((slot) => shopClock(slot.starts_at) === clock)
    expect(at("18:00")?.free).toBe(false)
    expect(at("17:00")?.free).toBe(true)
    expect(at("19:00")?.free).toBe(true)
    expect(at("11:00")?.free).toBe(false)
    expect(at("12:00")?.free).toBe(true)
  })

  it("uses a resource's own hours over the shop's", () => {
    const pc = { ...TABLE, hours: { sun: [["12:00", "14:00"]] as [string, string][] } }
    expect(daySlots(pc, SHOP, "2026-10-18", [])).toHaveLength(2)
  })
})

describe("bookingProblem", () => {
  const window = { starts_at: "2026-10-16T17:00:00.000Z", ends_at: "2026-10-16T19:00:00.000Z" }

  it("takes a clear booking of whole slots inside the hours", () => {
    expect(bookingProblem(TABLE, SHOP, window, [])).toBeNull()
  })

  it("names the clash in shop time", () => {
    const busy = [{ starts_at: "2026-10-16T18:00:00.000Z", ends_at: "2026-10-16T19:00:00.000Z" }]
    expect(bookingProblem(TABLE, SHOP, window, busy)).toBe(
      "Table 2 is booked from 19:00 to 20:00. Pick another time or another table."
    )
  })

  it("refuses part slots, closed times and a switched-off resource", () => {
    expect(bookingProblem(TABLE, SHOP, { ...window, ends_at: "2026-10-16T18:30:00.000Z" }, [])).toMatch(/60-minute slots/)
    expect(
      bookingProblem(TABLE, SHOP, { starts_at: "2026-10-16T21:00:00.000Z", ends_at: "2026-10-16T22:00:00.000Z" }, [])
    ).toMatch(/not open then/)
    expect(bookingProblem({ ...TABLE, active: false }, SHOP, window, [])).toMatch(/switched off/)
  })
})

describe("prices", () => {
  it("prices a booking by the slot, members at the member price, the deposit capped at the price", () => {
    const window = { starts_at: "2026-10-16T17:00:00.000Z", ends_at: "2026-10-16T19:00:00.000Z" }
    expect(bookingPrice(TABLE, window, false)).toEqual({ slots: 2, price: 1000, deposit: 200 })
    expect(bookingPrice(TABLE, window, true)).toEqual({ slots: 2, price: 800, deposit: 200 })
    expect(bookingPrice({ ...TABLE, price: 100, member_price: null, deposit: 500 }, window, true).deposit).toBe(200)
  })

  it("charges a walk-in session by whole slots after the grace minutes, one slot at least", () => {
    const at = "2026-10-16T17:00:00.000Z"
    expect(sessionCharge(TABLE, at, "2026-10-16T17:05:00.000Z", false)).toEqual({ minutes: 5, slots: 1, price: 500 })
    expect(sessionCharge(TABLE, at, "2026-10-16T18:10:00.000Z", false).slots).toBe(1)
    expect(sessionCharge(TABLE, at, "2026-10-16T18:11:00.000Z", false).slots).toBe(2)
    expect(sessionCharge(TABLE, at, "2026-10-16T19:00:00.000Z", true).price).toBe(800)
  })

  it("charges an event's member fee to members", () => {
    expect(entryFee({ entry_fee: 1000, member_fee: 700 }, true)).toBe(700)
    expect(entryFee({ entry_fee: 1000, member_fee: null }, true)).toBe(1000)
    expect(entryFee({ entry_fee: 1000, member_fee: 700 }, false)).toBe(1000)
  })

  it("counts the places left by party size, ignoring cancelled entries", () => {
    expect(
      placesLeft(8, [
        { party_size: 2, status: "confirmed" },
        { party_size: 3, status: "held" },
        { party_size: 4, status: "cancelled" },
      ])
    ).toBe(3)
    expect(placesLeft(0, [])).toBe(Number.POSITIVE_INFINITY)
  })
})
