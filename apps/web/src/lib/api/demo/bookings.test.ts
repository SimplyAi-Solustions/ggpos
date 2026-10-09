import { ClientResponseError } from "pocketbase"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  demoAvailability,
  demoCancelBooking,
  demoCancelEvent,
  demoCheckIn,
  demoCheckOut,
  demoCreateBooking,
  demoCreateEvent,
  demoEventCheckIn,
  demoGetEvent,
  demoListBookings,
  demoListEvents,
  demoMoveBooking,
  demoMyBookings,
  demoNoShow,
  demoPlanBookingLine,
  demoPublicEvents,
  demoSaveResource,
  demoSaveShopHours,
  demoStations,
  demoWalkIn,
  resetDemoBookings,
} from "@/lib/api/demo/bookings"
import { DEMO_CUSTOMERS } from "@/lib/api/demo/customers"
import { completeSale, lookupSale, refundSale } from "@/lib/api/demo/sales"
import { setDemoPortalCustomer } from "@/lib/api/demo/portal-seed"
import type { EventInput, NewBookingInput } from "@/lib/api/bookings"

/**
 * The demo shop's bookings stand in for BK's routes (pb/pb_hooks/
 * bookings.pb.js and lib/bookings.js), so they refuse and charge as the
 * server does, in its sentences, through the same shared helpers. The clock
 * is held at noon on Friday 16 October 2026, British Summer Time, so
 * "today" is a day the shop is open till ten and the league is on.
 */

const NOON = new Date("2026-10-16T11:00:00.000Z")
const TODAY = "2026-10-16"
const SATURDAY = "2026-10-17"

function at(time: string, date = TODAY): string {
  // BST: shop time is UTC+1.
  const [h, m] = time.split(":").map(Number)
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), (h ?? 0) - 1, m ?? 0)
  ).toISOString()
}

/** The sentence a refusal carries, and its status. */
function refusedWith(run: () => unknown): { status: number; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof ClientResponseError) return { status: error.status, message: error.message }
    throw error
  }
  throw new Error("It was not refused.")
}

function table(input: Partial<NewBookingInput> = {}, actor: "staff" | "customer" = "staff") {
  return demoCreateBooking(
    { resource: "res_table_3", starts_at: at("14:00"), ends_at: at("15:00"), party_size: 2, name: "Lee", ...input },
    actor
  )
}

function event(over: Partial<EventInput> = {}) {
  return demoCreateEvent({
    name: "Lorcana draft",
    game: "game_lorcana",
    format: "Draft",
    starts_at: at("18:00", SATURDAY),
    ends_at: at("21:00", SATURDAY),
    capacity: 2,
    entry_fee: 1500,
    member_fee: null,
    online: true,
    repeat_weekly: false,
    resources: [],
    description: "",
    status: "published",
    ...over,
  })
}

function codeOf(id: string): string {
  return DEMO_CUSTOMERS.find((entry) => entry.customer.id === id)?.customer.code ?? ""
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOON)
  resetDemoBookings()
  setDemoPortalCustomer("cust_demo_1")
})

afterEach(() => {
  vi.useRealTimers()
})

describe("availability", () => {
  it("shows staff every table, station and the room, and My Vault only what books online", () => {
    const staff = demoAvailability(TODAY, { audience: "staff" })
    expect(staff.resources.map((row) => row.resource.name)).toEqual([
      "Table 1",
      "Table 2",
      "Table 3",
      "Table 4",
      "PC 1",
      "PC 2",
      "PC 3",
      "PC 4",
      "PC 5",
      "PC 6",
      "Party room",
    ])
    const online = demoAvailability(TODAY, { audience: "public" })
    expect(online.resources.some((row) => row.resource.name === "Party room")).toBe(false)
  })

  it("takes the league's tables out from six to eight, and past slots out for My Vault only", () => {
    const slot = (audience: "staff" | "public", time: string) =>
      demoAvailability(TODAY, { audience, kind: "table" })
        .resources.find((row) => row.resource.name === "Table 3")
        ?.slots.find((entry) => entry.starts_at === at(time))?.free
    expect(slot("public", "18:00")).toBe(false)
    expect(slot("public", "19:00")).toBe(false)
    expect(slot("public", "20:00")).toBe(true)
    expect(slot("public", "14:00")).toBe(true)
    expect(slot("public", "10:00")).toBe(false)
    expect(slot("staff", "10:00")).toBe(true)
  })

  it("leaves out a table too small for the party", () => {
    expect(demoAvailability(TODAY, { audience: "staff", kind: "table", party: 8 }).resources).toEqual([])
  })
})

describe("booking at the counter", () => {
  it("books a table and prices it, the Guild price for a member", () => {
    expect(table({ starts_at: at("14:00"), ends_at: at("16:00"), party_size: 4 })).toMatchObject({
      status: "confirmed",
      price: 1000,
      balance: 1000,
      name: "Lee",
      source: "till",
    })
    const member = table({ resource: "res_table_4", customer: "cust_demo_1", name: undefined })
    expect(member).toMatchObject({ price: 400, name: "Jasmine Okafor" })
    expect(member.customer?.member).toBe(true)
    const notJoined = table({
      resource: "res_table_4",
      customer: "cust_demo_2",
      starts_at: at("15:00"),
      ends_at: at("16:00"),
    })
    expect(notJoined.price).toBe(500)
  })

  it("holds a booking with a deposit to take", () => {
    const party = demoCreateBooking(
      {
        resource: "res_party_room",
        starts_at: at("16:00", SATURDAY),
        ends_at: at("18:00", SATURDAY),
        party_size: 10,
        name: "Reed party",
        source: "phone",
      },
      "staff"
    )
    expect(party).toMatchObject({ status: "held", price: 4000, deposit: 2000, source: "phone" })
  })

  it("refuses a clash in the shared sentence", () => {
    table({ starts_at: at("15:00"), ends_at: at("16:00"), name: "First" })
    expect(refusedWith(() => table({ starts_at: at("14:00"), ends_at: at("16:00"), name: "Second" }))).toEqual({
      status: 409,
      message: "Table 3 is booked from 15:00 to 16:00. Pick another time or another table.",
    })
    expect(
      refusedWith(() => table({ resource: "res_pc_3", party_size: 1, name: "Sam" })).message
    ).toBe("PC 3 is booked from 13:00 to 15:00. Pick another time or another PC.")
  })

  it("lets staff book a time that has started, but not My Vault", () => {
    expect(table({ resource: "res_table_4", starts_at: at("10:00"), ends_at: at("11:00") }).status).toBe("confirmed")
    expect(refusedWith(() => table({ starts_at: at("11:00"), ends_at: at("12:00") }, "customer"))).toEqual({
      status: 400,
      message: "That time has passed. Pick a later slot.",
    })
  })

  it("refuses a booking outside the hours, off the slot length, too big, or with nobody named", () => {
    const refused = (over: Partial<NewBookingInput>) => refusedWith(() => table(over)).message
    expect(refused({ starts_at: at("21:00"), ends_at: at("23:00") })).toBe(
      "Table 3 is not open then. Pick a time within its hours."
    )
    expect(refused({ ends_at: at("14:30") })).toBe("Table 3 books in 60-minute slots.")
    expect(refused({ party_size: 9 })).toBe("Table 3 takes up to 6. Pick a bigger one or split the party.")
    expect(refused({ party_size: 0 })).toBe("A booking is for 1 person or more.")
    expect(refused({ name: " " })).toBe("Add a name for the booking, or pick the customer.")
    expect(refused({ event: "event_demo_league" })).toBe("Book a table, station or room, or enter an event, not both.")
    expect(refused({ resource: undefined })).toBe("Pick a table, station or room, or an event.")
    expect(refused({ customer: "cust_nobody" })).toBe("That customer was not found. Search again.")
  })

  it("moves a booking, and refuses a move onto somebody else", () => {
    const made = table({ name: "Mover" })
    const moved = demoMoveBooking(made.id, { starts_at: at("16:00"), ends_at: at("17:00"), resource: "res_table_4" })
    expect(moved).toMatchObject({ starts_at: at("16:00"), price: 500 })
    expect(moved.resource?.name).toBe("Table 4")
    expect(refusedWith(() => demoMoveBooking(made.id, { starts_at: at("18:00"), ends_at: at("19:00") }))).toEqual({
      status: 409,
      message: "Table 4 is booked from 18:00 to 20:00. Pick another time or another table.",
    })
    expect(
      refusedWith(() => demoMoveBooking("entry_demo_sam", { starts_at: at("16:00"), ends_at: at("17:00") })).message
    ).toBe("An event entry moves with its event. Cancel it and enter another event instead.")
  })

  it("checks in, checks out, cancels and marks no-shows once each", () => {
    const made = table({ resource: "res_table_4", starts_at: at("12:00"), ends_at: at("13:00"), name: "Ava" })
    expect(demoCheckIn(made.id).status).toBe("checked_in")
    expect(refusedWith(() => demoCheckIn(made.id)).message).toBe("This booking is already checked in.")
    expect(refusedWith(() => demoNoShow(made.id)).message).toBe("This booking has checked in. Check it out first.")
    const out = demoCheckOut(made.id)
    expect(out.status).toBe("completed")
    expect(out.charge).toEqual({ minutes: 0, slots: 1, price: 500, balance: 500 })
    expect(refusedWith(() => demoCancelBooking(made.id, true, "staff"))).toEqual({
      status: 409,
      message: "This booking has finished.",
    })

    const later = table({ resource: "res_table_4", starts_at: at("20:00"), ends_at: at("21:00"), name: "Ben" })
    expect(refusedWith(() => demoNoShow(later.id)).message).toBe("This booking has not started yet. Cancel it instead.")
    const cancelled = demoCancelBooking(later.id, true, "staff")
    expect(cancelled).toMatchObject({ status: "cancelled", refunds: [], kept: 0 })
    expect(refusedWith(() => demoCancelBooking(later.id, true, "staff")).message).toBe("This booking is cancelled.")
    // A cancelled booking frees its time.
    expect(table({ resource: "res_table_4", starts_at: at("20:00"), ends_at: at("21:00"), name: "Cal" }).status).toBe(
      "confirmed"
    )
    // Once its time has started with nobody there, it can be a no-show.
    const dee = table({ resource: "res_table_1", starts_at: at("20:00"), ends_at: at("21:00"), name: "Dee" })
    vi.setSystemTime(new Date(Date.parse(at("20:15"))))
    expect(demoNoShow(dee.id).status).toBe("no_show")
  })

  it("checks a booking in on its own day only", () => {
    const tomorrow = table({ starts_at: at("14:00", SATURDAY), ends_at: at("15:00", SATURDAY) })
    expect(refusedWith(() => demoCheckIn(tomorrow.id)).message).toBe(
      "This booking is for Sat 17 Oct. Check it in on the day."
    )
  })

  it("lists the bookings that start on the days asked for, six weeks at most", () => {
    const names = demoListBookings(TODAY, TODAY).map((row) => row.name)
    expect(names).toContain("Harper family")
    expect(names).toContain("Sam Ward")
    expect(demoListBookings(SATURDAY, SATURDAY).map((row) => row.event?.name)).toEqual(["One Piece tournament"])
    expect(refusedWith(() => demoListBookings(TODAY, "2026-12-31")).message).toBe("Ask for six weeks at most.")
  })
})

describe("walk-in sessions", () => {
  it("runs the clock and charges by the slots used, a part slot after ten minutes", () => {
    const started = demoWalkIn({ resource: "res_pc_2" })
    expect(started).toMatchObject({ status: "checked_in", price: 0, name: "Walk-in" })
    expect(refusedWith(() => demoWalkIn({ resource: "res_pc_2" })).message).toBe(
      "PC 2 is booked from 12:00 to 13:00. Pick another time or another PC."
    )
    vi.setSystemTime(new Date(NOON.getTime() + 71 * 60_000))
    const out = demoCheckOut(started.id)
    expect(out.charge).toEqual({ minutes: 71, slots: 2, price: 800, balance: 800 })
    expect(out).toMatchObject({ status: "completed", price: 800 })
  })

  it("charges a Guild member the Guild price", () => {
    const started = demoWalkIn({ resource: "res_pc_1", customer: "cust_demo_1" })
    vi.setSystemTime(new Date(NOON.getTime() + 20 * 60_000))
    expect(demoCheckOut(started.id).charge.price).toBe(300)
  })

  it("will not start on a table, or on a station somebody has booked now", () => {
    expect(refusedWith(() => demoWalkIn({ resource: "res_table_1" })).message).toBe(
      "Walk-in sessions run on PC and console stations. Book a table or room instead."
    )
    vi.setSystemTime(new Date(Date.parse(at("13:30"))))
    expect(refusedWith(() => demoWalkIn({ resource: "res_pc_3" })).message).toBe(
      "PC 3 is booked from 13:00 to 15:00. Pick another time or another PC."
    )
  })

  it("shows each station's running session and its next booking today", () => {
    const stations = demoStations()
    expect(stations.map((row) => row.resource.name)).toEqual(["PC 1", "PC 2", "PC 3", "PC 4", "PC 5", "PC 6"])
    expect(stations.find((row) => row.resource.name === "PC 5")?.session?.name).toBe("Walk-in")
    expect(stations.find((row) => row.resource.name === "PC 3")?.next?.name).toBe("Tom Bradbury")
    expect(stations.find((row) => row.resource.name === "PC 1")).toMatchObject({ session: null, next: null })
  })
})

describe("events", () => {
  it("enters a member at the Guild fee for the whole party", () => {
    const entry = demoCreateBooking({ event: "event_demo_league", party_size: 2, customer: "cust_demo_4" }, "staff")
    expect(entry).toMatchObject({ kind: "event", status: "confirmed", price: 800, party_size: 2 })
    expect(entry.event?.name).toBe("Pokémon League")
    expect(demoGetEvent("event_demo_league").entries.map((row) => row.name)).toContain("T Bradbury")
  })

  it("refuses a second entry for the same customer", () => {
    expect(refusedWith(() => demoCreateBooking({ event: "event_demo_league", party_size: 1, customer: "cust_demo_1" }, "staff"))).toEqual({
      status: 409,
      message: "Jasmine Okafor is already entered in Pokémon League.",
    })
    expect(refusedWith(() => demoCreateBooking({ event: "event_demo_league", party_size: 1 }, "customer")).message).toBe(
      "You are already entered in Pokémon League."
    )
  })

  it("puts an entry past the places on the waitlist only when asked", () => {
    const draft = event()
    expect(draft.game?.name).toBe("Disney Lorcana")
    expect(demoCreateBooking({ event: draft.id, party_size: 2, name: "Pair" }, "staff").status).toBe("confirmed")
    expect(refusedWith(() => demoCreateBooking({ event: draft.id, party_size: 1, name: "Solo" }, "staff"))).toEqual({
      status: 409,
      message: "Lorcana draft is full. Add them to the waitlist instead.",
    })
    const waiting = demoCreateBooking({ event: draft.id, party_size: 1, name: "Solo", waitlist: true }, "staff")
    expect(waiting).toMatchObject({ status: "held", waitlist_position: 1 })
    const shown = demoPublicEvents(TODAY).find((row) => row.id === draft.id)
    expect(shown).toMatchObject({ places_left: 0, entered: 2, waitlist: 1 })
    expect(refusedWith(() => demoPlanBookingLine({ booking: waiting.id }, 0, [])).message).toBe(
      "Lorcana draft, Sat 17 Oct is on the waitlist. Take payment when a place frees."
    )
  })

  it("says how many places are left to a party too big for them", () => {
    const small = event({ capacity: 3 })
    demoCreateBooking({ event: small.id, party_size: 2, name: "Pair" }, "staff")
    expect(refusedWith(() => demoCreateBooking({ event: small.id, party_size: 2, name: "Two" }, "staff")).message).toBe(
      "Lorcana draft has 1 place left. Make the party smaller or add them to the waitlist."
    )
  })

  it("will not take entries for a draft, and hides it from My Vault", () => {
    const draft = event({ name: "Launch night", status: "draft", capacity: 0 })
    expect(refusedWith(() => demoCreateBooking({ event: draft.id, party_size: 1, name: "A" }, "staff")).message).toBe(
      "Launch night is not published yet. Publish it before taking entries."
    )
    expect(refusedWith(() => demoCreateBooking({ event: draft.id, party_size: 1 }, "customer"))).toEqual({
      status: 404,
      message: "That event was not found. Reload the events.",
    })
    expect(demoPublicEvents(TODAY).some((row) => row.id === draft.id)).toBe(false)
  })

  it("uses a free entry for a tier that has one", () => {
    const free = demoCreateBooking(
      { event: "event_demo_one_piece", party_size: 1, customer: "cust_demo_3", free_entry: true },
      "staff"
    )
    expect(free.price).toBe(0)
    expect(
      refusedWith(() =>
        demoCreateBooking({ event: "event_demo_league_1", party_size: 1, customer: "cust_demo_1", free_entry: true }, "staff")
      ).message
    ).toBe("Their tier has no free event entries. Take the fee instead.")
  })

  it("refuses an event that ends before it starts, or lands on a booked table", () => {
    expect(refusedWith(() => event({ starts_at: at("20:00"), ends_at: at("18:00") })).message).toBe(
      "The event has to end after it starts."
    )
    expect(
      refusedWith(() => event({ starts_at: at("13:00"), ends_at: at("15:00"), resources: ["res_table_1"] })).message
    ).toBe("Table 1 is booked from 12:00 to 14:00. Pick another time or another table.")
  })

  it("checks a player in by the QR on their Guild card, or their code", () => {
    const token = DEMO_CUSTOMERS.find((entry) => entry.customer.id === "cust_demo_1")?.customer.qr_token ?? ""
    expect(demoEventCheckIn("event_demo_league", `https://ggentertainment.co.uk/c/${token}`)).toMatchObject({
      name: "Jasmine Okafor",
      status: "checked_in",
    })
    expect(demoEventCheckIn("event_demo_league", codeOf("cust_demo_3")).status).toBe("checked_in")
    expect(refusedWith(() => demoEventCheckIn("event_demo_league", codeOf("cust_demo_2"))).message).toBe(
      "Tom Bradbury is not entered in Pokémon League. Add them as an entry first."
    )
    expect(refusedWith(() => demoEventCheckIn("event_demo_league", "nobody")).message).toBe(
      "That card was not found. Scan it again or type the code."
    )
  })

  it("cancels an event and every entry with it", () => {
    const result = demoCancelEvent("event_demo_one_piece")
    expect(result).toMatchObject({ cancelled: 1, refunds: [] })
    expect(result.event.status).toBe("cancelled")
    expect(demoGetEvent("event_demo_one_piece").entries.every((row) => row.status === "cancelled")).toBe(true)
    expect(refusedWith(() => demoCancelEvent("event_demo_one_piece")).message).toBe(
      "One Piece tournament is already cancelled."
    )
  })

  it("lists the league each week for four weeks", () => {
    const league = demoListEvents(TODAY).filter((row) => row.name === "Pokémon League")
    expect(league).toHaveLength(4)
    expect(league.slice(1).every((row) => row.repeat_of === "event_demo_league")).toBe(true)
  })
})

describe("My Vault", () => {
  it("books an online table for the signed-in customer, held at the Guild price", () => {
    const booking = table({ resource: "res_table_1", starts_at: at("18:00", SATURDAY), ends_at: at("19:00", SATURDAY), name: undefined }, "customer")
    expect(booking).toMatchObject({ status: "held", price: 400, source: "online", name: "Jasmine Okafor", notes: "" })
    expect(demoMyBookings().map((row) => row.id)).toContain(booking.id)
    expect(demoCancelBooking(booking.id, false, "customer").status).toBe("cancelled")
  })

  it("charges somebody who has not joined the Guild the full fee", () => {
    setDemoPortalCustomer("cust_demo_2")
    expect(demoCreateBooking({ event: "event_demo_league_1", party_size: 1 }, "customer")).toMatchObject({
      status: "held",
      price: 500,
    })
  })

  it("refuses the party room online, somebody else's booking, and a cancel with money paid", () => {
    expect(
      refusedWith(() =>
        demoCreateBooking(
          { resource: "res_party_room", starts_at: at("14:00", SATURDAY), ends_at: at("16:00", SATURDAY), party_size: 10 },
          "customer"
        )
      )
    ).toEqual({ status: 403, message: "Party room cannot be booked online. Ring the shop to book it." })
    expect(refusedWith(() => table({ customer: "cust_demo_2" }, "customer"))).toEqual({
      status: 403,
      message: "You can only book for yourself.",
    })
    expect(refusedWith(() => demoCancelBooking("booking_demo_harper", false, "customer"))).toEqual({
      status: 404,
      message: "That booking was not found.",
    })
    expect(refusedWith(() => demoCancelBooking("entry_demo_jasmine", false, "customer")).message).toBe(
      "This booking has £4.00 paid. Ring the shop to cancel it, so it can be refunded."
    )
  })
})

describe("paying at the till", () => {
  it("takes no more than is left to pay on a booking, the ticket's earlier lines counted", () => {
    expect(demoPlanBookingLine({ booking: "booking_demo_harper" }, 0, [])).toEqual({
      title: "Table 1, Fri 16 Oct 12:00",
      amount: 1000,
    })
    expect(refusedWith(() => demoPlanBookingLine({ booking: "booking_demo_harper", unit_price: 1500 }, 0, [])).message).toBe(
      "Table 1, Fri 16 Oct 12:00 has £10.00 left to pay. Change the amount."
    )
    expect(
      demoPlanBookingLine({ booking: "booking_demo_harper" }, 1, [{ booking: "booking_demo_harper", unit_price: 600 }]).amount
    ).toBe(400)
    expect(refusedWith(() => demoPlanBookingLine({ booking: "booking_demo_harper", qty: 2 }, 0, [])).message).toBe(
      "A booking goes on the ticket once. Key the amount instead."
    )
    expect(refusedWith(() => demoPlanBookingLine({ booking: "booking_demo_tom_pc" }, 0, [])).message).toBe(
      "PC 3, Fri 16 Oct 13:00 is paid in full. Take it off the ticket."
    )
  })

  const payDeposit = () =>
    completeSale({
      lines: [{ booking: "booking_demo_ellis", qty: 1, unit_price: 2000, discount: 0, title: "Party room, deposit" }],
      discount: 0,
      discount_source: null,
      reward_code: null,
      customer: null,
      tenders: [{ method: "cash", amount: 2000, tendered: 2000 }],
    })

  it("confirms a held booking once its deposit is paid, and keeps the deposit when asked", () => {
    payDeposit()
    const paid = demoListBookings(TODAY, TODAY).find((row) => row.id === "booking_demo_ellis")
    expect(paid).toMatchObject({ status: "confirmed", paid: 2000, balance: 2000 })
    expect(demoCancelBooking("booking_demo_ellis", true, "staff")).toMatchObject({ refunds: [], kept: 2000 })
  })

  it("lists the sale lines to refund when the deposit goes back, and moves no money itself", () => {
    const sold = payDeposit()
    const line = lookupSale(sold.sale.number).sale.lines[0]?.id ?? ""
    const back = demoCancelBooking("booking_demo_ellis", false, "staff")
    expect(back.kept).toBe(0)
    expect(back.refunds).toEqual([
      { sale: { id: sold.sale.id, number: sold.sale.number }, lines: [{ sale_line: line, qty: 1 }], amount: 2000 },
    ])
    expect(back.paid).toBe(2000)
  })

  it("takes a refunded booking line off what is paid", () => {
    const sold = completeSale({
      lines: [{ booking: "booking_demo_harper", qty: 1, unit_price: 1000, discount: 0, title: "Table 1" }],
      discount: 0,
      discount_source: null,
      reward_code: null,
      customer: null,
      tenders: [{ method: "cash", amount: 1000, tendered: 1000 }],
    })
    const line = lookupSale(sold.sale.number).sale.lines[0]?.id ?? ""
    refundSale(sold.sale.id, {
      lines: [{ sale_line: line, qty: 1, restock: false }],
      reason: "Booking cancelled",
      tenders: [{ method: "cash", amount: 1000 }],
    })
    expect(demoListBookings(TODAY, TODAY).find((row) => row.id === "booking_demo_harper")).toMatchObject({ paid: 0 })
  })
})

describe("Settings", () => {
  const resource = {
    kind: "table" as const,
    capacity: 4,
    slot_minutes: 60,
    price: 500,
    member_price: null,
    deposit: null,
    online: true,
    hours: null,
    active: true,
    sort: 9,
    note: "",
  }

  it("refuses a second resource with the same name, whatever the case", () => {
    expect(refusedWith(() => demoSaveResource(null, { ...resource, name: "table 1" })).message).toBe(
      "There is already one called Table 1. Use another name."
    )
  })

  it("adds a console that books in half hours, with no limit on how many it takes", () => {
    const saved = demoSaveResource(null, {
      ...resource,
      name: "Switch 1",
      kind: "console",
      capacity: 0,
      slot_minutes: 30,
      price: 250,
      member_price: 200,
      sort: 20,
    })
    expect(saved.capacity).toBe(0)
    const day = demoAvailability(SATURDAY, { audience: "staff", kind: "console", party: 12 })
    expect(day.resources[0]?.resource.id).toBe(saved.id)
    expect(day.resources[0]?.slots).toHaveLength(24)
  })

  it("refuses hours that close before they open, in the shared sentence", () => {
    expect(refusedWith(() => demoSaveShopHours({ mon: [["20:00", "10:00"]] })).message).toBe(
      "On Monday, 20:00 to 10:00 ends before it starts. Check the times."
    )
  })
})
