import { describe, expect, it } from "vitest"

import {
  addDays,
  bookingPrice,
  bookingProblem,
  clashProblem,
  daySlots,
  entryFee,
  hoursProblem,
  isBritishSummerTime,
  liveWindow,
  placesLeft,
  repeatWindows,
  sessionCharge,
  shopClock,
  shopDateOf,
  shopDayBounds,
  shopTimeToUtc,
  waitlistOf,
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

describe("the booking routes' own rules", () => {
  it("moves a date by days and bounds a shop day, 25 hours on the October change", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(shopDayBounds("2026-10-16")).toEqual({
      starts_at: "2026-10-15T23:00:00.000Z",
      ends_at: "2026-10-16T23:00:00.000Z",
    })
    const change = shopDayBounds("2026-10-25")
    expect(change.starts_at).toBe("2026-10-24T23:00:00.000Z")
    expect(change.ends_at).toBe("2026-10-26T00:00:00.000Z")
  })

  it("words a walk-in's clash the way bookingProblem does", () => {
    const busy = [{ starts_at: "2026-10-16T17:00:00.000Z", ends_at: "2026-10-16T18:00:00.000Z" }]
    const pc = { name: "PC 3", kind: "pc" as const }
    expect(clashProblem(pc, { starts_at: "2026-10-16T16:30:00.000Z", ends_at: "2026-10-16T17:30:00.000Z" }, busy)).toBe(
      "PC 3 is booked from 18:00 to 19:00. Pick another time or another PC."
    )
    expect(clashProblem(pc, { starts_at: "2026-10-16T16:00:00.000Z", ends_at: "2026-10-16T17:00:00.000Z" }, busy)).toBeNull()
  })

  it("takes a booking's own window, nothing for a finished one, and a running session to the end of its slot", () => {
    const booked = {
      status: "confirmed" as const,
      starts_at: "2026-10-16T17:00:00.000Z",
      ends_at: "2026-10-16T18:00:00.000Z",
    }
    const now = new Date("2026-10-16T17:30:00.000Z")
    expect(liveWindow(booked, 60, now)).toEqual({ starts_at: booked.starts_at, ends_at: booked.ends_at })
    expect(liveWindow({ ...booked, status: "cancelled" }, 60, now)).toBeNull()
    expect(liveWindow({ ...booked, status: "completed" }, 60, now)).toBeNull()

    const session = {
      status: "checked_in" as const,
      starts_at: "2026-10-16T15:00:00.000Z",
      ends_at: "2026-10-16T16:00:00.000Z",
      checked_in_at: "2026-10-16T15:00:00.000Z",
    }
    // Two and a half hours in: busy to the end of the third hour.
    expect(liveWindow(session, 60, now)?.ends_at).toBe("2026-10-16T18:00:00.000Z")
    // Exactly on a slot's end it has started the next one.
    expect(liveWindow(session, 60, new Date("2026-10-16T16:00:00.000Z"))?.ends_at).toBe("2026-10-16T17:00:00.000Z")
    // A booked session checked in early is busy from check-in.
    expect(
      liveWindow({ ...booked, status: "checked_in", checked_in_at: "2026-10-16T16:50:00.000Z" }, 60, now)?.starts_at
    ).toBe("2026-10-16T16:50:00.000Z")
  })

  it("keeps an event's waitlist first come first served by party size", () => {
    const entries = [
      { id: "a", party_size: 2, status: "confirmed" as const, created: "2026-10-01T10:00:00.000Z" },
      { id: "b", party_size: 3, status: "held" as const, created: "2026-10-01T11:00:00.000Z" },
      { id: "c", party_size: 3, status: "held" as const, created: "2026-10-01T12:00:00.000Z" },
      { id: "d", party_size: 1, status: "held" as const, created: "2026-10-01T13:00:00.000Z" },
      { id: "e", party_size: 4, status: "cancelled" as const, created: "2026-10-01T09:00:00.000Z" },
    ]
    // 2 firm and 3 held make 5 of 6; c (3) does not fit, and d waits behind it.
    expect(waitlistOf(6, entries)).toEqual(["c", "d"])
    // A place frees when b cancels: c moves up, and d still fits after it.
    const freed = entries.map((x) => (x.id === "b" ? { ...x, status: "cancelled" as const } : x))
    expect(waitlistOf(6, freed)).toEqual([])
    expect(waitlistOf(0, entries)).toEqual([])
    // A firm entry made later still counts first.
    const squeezed = [
      ...entries,
      { id: "f", party_size: 2, status: "checked_in" as const, created: "2026-10-02T10:00:00.000Z" },
    ]
    expect(waitlistOf(4, squeezed)).toEqual(["b", "c", "d"])
  })

  it("repeats an event weekly at the same shop clock time across the clock change", () => {
    const first = { starts_at: "2026-10-09T17:00:00.000Z", ends_at: "2026-10-09T20:00:00.000Z" }
    const repeats = repeatWindows(first, new Date("2026-10-09T12:00:00.000Z"))
    expect(repeats.map((w) => w.starts_at)).toEqual([
      "2026-10-16T17:00:00.000Z",
      "2026-10-23T17:00:00.000Z",
      // 18:00 GMT from here on.
      "2026-10-30T18:00:00.000Z",
    ])
    expect(repeats[2]?.ends_at).toBe("2026-10-30T21:00:00.000Z")
    // From a first event long ago, only the weeks ahead.
    const later = repeatWindows(first, new Date("2027-06-01T12:00:00.000Z"), 14)
    expect(later.map((w) => shopClock(w.starts_at))).toEqual(["18:00", "18:00"])
    expect(later[0]?.starts_at).toBe("2027-06-04T17:00:00.000Z")
    expect(repeatWindows({ ...first, ends_at: first.starts_at }, new Date("2026-10-09T12:00:00.000Z"))).toEqual([])
  })

  it("checks opening hours before they are saved", () => {
    expect(hoursProblem(null)).toBeNull()
    expect(hoursProblem({})).toBeNull()
    expect(
      hoursProblem({
        mon: [
          ["10:00", "13:00"],
          ["14:00", "24:00"],
        ],
        sun: [],
      })
    ).toBeNull()
    expect(hoursProblem([])).toBe("Set the opening hours as times for each day.")
    expect(hoursProblem({ monday: [] })).toBe("There is no day called monday. Use mon, tue, wed, thu, fri, sat or sun.")
    expect(hoursProblem({ tue: "10:00-20:00" })).toBe("Set Tuesday's opening times as a list, or leave it out for closed.")
    expect(hoursProblem({ wed: [["10", "20:00"]] })).toBe(
      "Each opening time on Wednesday needs a start and an end, like 10:00 and 20:00."
    )
    expect(hoursProblem({ thu: [["20:00", "10:00"]] })).toBe(
      "On Thursday, 20:00 to 10:00 ends before it starts. Check the times."
    )
    expect(
      hoursProblem({
        fri: [
          ["10:00", "14:00"],
          ["13:00", "18:00"],
        ],
      })
    ).toBe("Two of Friday's opening times overlap. Make them one.")
  })
})
