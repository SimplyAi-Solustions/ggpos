import { describe, expect, it } from "vitest"

import {
  capacityWords,
  clockSince,
  dateOf,
  dayLabel,
  feeWords,
  isOpen,
  isWalkIn,
  lengthChoices,
  lengthWords,
  lineTitle,
  owed,
  paidState,
  paymentChoices,
  placesWords,
  rateWords,
  relativeDay,
  runningCharge,
  refundWords,
  splitEntries,
  timeRange,
  weekOf,
  whatOf,
} from "@/features/bookings/model"

describe("dates on the shop's clock", () => {
  it("names a day the way the counter says it", () => {
    expect(dayLabel("2026-10-16")).toBe("Fri 16 Oct")
    expect(relativeDay("2026-10-16", "2026-10-16")).toBe("Today")
    expect(relativeDay("2026-10-17", "2026-10-16")).toBe("Tomorrow")
    expect(relativeDay("2026-10-20", "2026-10-16")).toBe("Tue 20 Oct")
  })

  it("says yesterday, and steps over the end of a month", () => {
    expect(relativeDay("2026-10-31", "2026-11-01")).toBe("Yesterday")
    expect(relativeDay("2026-11-01", "2026-10-31")).toBe("Tomorrow")
  })

  it("runs a week from Monday to Sunday", () => {
    expect(weekOf("2026-10-16")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ])
    expect(weekOf("2026-10-18")[0]).toBe("2026-10-12")
  })

  it("puts a late summer evening on the shop's day, not UTC's", () => {
    // 23:30 UTC in October is 00:30 the next day in the shop.
    expect(dateOf("2026-10-15T23:30:00.000Z")).toBe("2026-10-16")
    // In winter the shop's clock is UTC.
    expect(dateOf("2026-11-02T23:30:00.000Z")).toBe("2026-11-02")
  })

  it("writes a window in shop time", () => {
    expect(timeRange({ starts_at: "2026-10-16T17:00:00.000Z", ends_at: "2026-10-16T18:30:00.000Z" })).toBe(
      "18:00 to 19:30"
    )
  })
})

describe("paying", () => {
  const booking = { price: 1000, paid: 0, deposit: 400, kind: "resource" as const, status: "confirmed" as const }

  it("offers the deposit and the whole price while nothing is paid", () => {
    expect(paymentChoices(booking)).toEqual([
      { key: "deposit", label: "Deposit", amount: 400 },
      { key: "full", label: "In full", amount: 1000 },
    ])
  })

  it("offers the balance once the deposit is in", () => {
    expect(paymentChoices({ ...booking, paid: 400 })).toEqual([{ key: "balance", label: "Balance", amount: 600 }])
  })

  it("offers nothing on a booking that is paid", () => {
    expect(paymentChoices({ ...booking, paid: 1000 })).toEqual([])
    expect(owed({ price: 500, paid: 700 })).toBe(0)
  })

  it("offers nothing on an entry still waiting for a place", () => {
    expect(paymentChoices({ ...booking, waitlist_position: 2 })).toEqual([])
  })

  it("leaves the deposit out when it is the whole price", () => {
    expect(paymentChoices({ price: 400, paid: 0, deposit: 400 })).toEqual([
      { key: "full", label: "In full", amount: 400 },
    ])
  })

  it("says how it is paid, in words", () => {
    expect(paidState(booking)).toBe("£10.00 to pay")
    expect(paidState({ ...booking, paid: 400 })).toBe("Deposit paid, £6.00 to pay")
    expect(paidState({ ...booking, paid: 1000 })).toBe("Paid")
    expect(paidState({ ...booking, price: 0 })).toBe("Free")
    expect(paidState({ ...booking, price: 0, status: "checked_in" })).toBe("On the clock")
  })

  it("names the till's line by what, when and which part", () => {
    const at = { kind: "resource" as const, starts_at: "2026-10-16T17:00:00.000Z" }
    expect(lineTitle(at, "Table 2", "deposit")).toBe("Table 2, Fri 16 Oct 18:00, deposit")
    expect(lineTitle(at, "Table 2", "full")).toBe("Table 2, Fri 16 Oct 18:00")
    expect(lineTitle(at, "PC 3", "session")).toBe("PC 3, Fri 16 Oct 18:00, session")
    expect(lineTitle({ ...at, kind: "event" }, "Pokémon League", "full")).toBe("Pokémon League, Fri 16 Oct, entry")
  })

  it("says what a cancellation leaves the till to refund, and what is kept", () => {
    const sale = { id: "s1", number: "GG-S-000123" }
    expect(refundWords({ refunds: [{ sale, lines: [{ sale_line: "l1", qty: 1 }], amount: 2000 }], kept: 0 })).toBe(
      "Refund £20.00 at the till through Returns, on GG-S-000123."
    )
    expect(refundWords({ refunds: [], kept: 2000 })).toBe("£20.00 is kept.")
    expect(refundWords({ refunds: [], kept: 0 })).toBe("")
  })
})

describe("stations", () => {
  const pc = { price: 400, member_price: 300, slot_minutes: 60 }
  const session = {
    kind: "resource" as const,
    status: "checked_in" as const,
    price: 0,
    checked_in_at: "2026-10-16T10:00:00.000Z",
    starts_at: "2026-10-16T10:00:00.000Z",
    customer: null,
  }

  it("knows a walk-in on the clock from a booked session", () => {
    expect(isWalkIn(session)).toBe(true)
    expect(isWalkIn({ ...session, price: 800 })).toBe(false)
    expect(isWalkIn({ ...session, status: "completed" })).toBe(false)
  })

  it("charges a walk-in by the slots used so far, a part slot after ten minutes", () => {
    const at = (minutes: number) => Date.parse(session.checked_in_at) + minutes * 60_000
    expect(runningCharge(session, pc, at(5))).toBe(400)
    expect(runningCharge(session, pc, at(70))).toBe(400)
    expect(runningCharge(session, pc, at(71))).toBe(800)
    expect(
      runningCharge(
        { ...session, customer: { id: "c", name: "J", code: "GGC", member: true } },
        pc,
        at(71)
      )
    ).toBe(600)
  })

  it("charges a booked session its own price, or the time used once it runs over", () => {
    const after = (hours: number) => Date.parse(session.checked_in_at) + hours * 3_600_000
    expect(runningCharge({ ...session, price: 800 }, pc, after(1))).toBe(800)
    expect(runningCharge({ ...session, price: 800 }, pc, after(3))).toBe(1200)
  })

  it("shows the clock in hours and minutes", () => {
    expect(clockSince("2026-10-16T10:00:00.000Z", Date.parse("2026-10-16T10:42:30.000Z"))).toBe("0:42")
    expect(clockSince("2026-10-16T10:00:00.000Z", Date.parse("2026-10-16T11:05:00.000Z"))).toBe("1:05")
  })

  it("says what takes how many, a capacity of 0 being no limit", () => {
    expect(capacityWords(6)).toBe("Up to 6")
    expect(capacityWords(0)).toBe("No limit")
  })

  it("says a rate by the hour, or by its own slot", () => {
    expect(rateWords(400, 60)).toBe("£4.00 an hour")
    expect(rateWords(250, 30)).toBe("£2.50 for 30 minutes")
  })
})

describe("lengths", () => {
  const slots = [
    { starts_at: "10", ends_at: "11", free: true },
    { starts_at: "11", ends_at: "12", free: false },
    { starts_at: "12", ends_at: "13", free: true },
    { starts_at: "14", ends_at: "15", free: true },
  ]

  it("runs on from the chosen slot until a gap, taken slots included", () => {
    expect(lengthChoices(slots, "10").map((run) => run.length)).toEqual([1, 2, 3])
    expect(lengthChoices(slots, "14").map((run) => run.length)).toEqual([1])
    expect(lengthChoices(slots, "9")).toEqual([])
  })

  it("stops at four slots", () => {
    const long = Array.from({ length: 8 }, (_, index) => ({
      starts_at: String(index),
      ends_at: String(index + 1),
      free: true,
    }))
    expect(lengthChoices(long, "0")).toHaveLength(4)
  })

  it("says a length in hours and minutes", () => {
    expect(lengthWords(60)).toBe("1 hour")
    expect(lengthWords(90)).toBe("1 hour 30")
    expect(lengthWords(120)).toBe("2 hours")
    expect(lengthWords(45)).toBe("45 minutes")
  })
})

describe("events", () => {
  const entry = (
    id: string,
    status: "held" | "confirmed" | "checked_in" | "cancelled" | "no_show",
    minute: number,
    waitlist_position: number | null = null
  ) => ({
    id,
    status,
    waitlist_position,
    created: new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString(),
  })

  it("lists entries in the order they came, the waitlist by its place in line", () => {
    const split = splitEntries([
      entry("w2", "held", 6, 2),
      entry("c", "held", 3),
      entry("a", "confirmed", 1),
      entry("x", "cancelled", 2),
      entry("w1", "held", 5, 1),
      entry("b", "checked_in", 2),
      entry("n", "no_show", 4),
    ])
    expect(split.entered.map((row) => row.id)).toEqual(["a", "b", "c"])
    expect(split.waitlist.map((row) => row.id)).toEqual(["w1", "w2"])
    expect(split.closed.map((row) => row.id)).toEqual(["x", "n"])
  })

  it("says how many places are left", () => {
    expect(placesWords({ capacity: 16, places_left: 4, entered: 12 })).toBe("4 of 16 places left")
    expect(placesWords({ capacity: 16, places_left: 0, entered: 16 })).toBe("Full, 16 places taken")
    expect(placesWords({ capacity: 0, places_left: null, entered: 9 })).toBe("No limit, 9 entered")
  })

  it("says the fee and the Guild fee", () => {
    expect(feeWords({ entry_fee: 500, member_fee: 400 })).toBe("£5.00, Guild £4.00")
    expect(feeWords({ entry_fee: 500, member_fee: null })).toBe("£5.00")
    expect(feeWords({ entry_fee: 0, member_fee: null })).toBe("Free")
  })
})

describe("what a booking is of", () => {
  const booking = {
    kind: "resource" as const,
    resource: { id: "r1", name: "Table 2", kind: "table" as const },
    event: null,
    status: "held" as const,
  }

  it("names its table or its event", () => {
    expect(whatOf(booking)).toBe("Table 2")
    expect(whatOf({ ...booking, kind: "event", resource: null, event: { id: "e1", name: "Pokémon League" } })).toBe(
      "Pokémon League"
    )
  })

  it("can still move or be cancelled while held or booked, not once it has started", () => {
    expect(isOpen(booking)).toBe(true)
    expect(isOpen({ status: "confirmed" })).toBe(true)
    expect(isOpen({ status: "checked_in" })).toBe(false)
    expect(isOpen({ status: "cancelled" })).toBe(false)
  })
})
