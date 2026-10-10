/**
 * Bookings: tables, PC and console stations, rooms, and events
 * (docs/api-contract-launch.md, section 4; docs/EPOS-PLAN.md, decision 12).
 *
 * Pure and shared by the booking routes and the web (the day view, My Vault
 * and demo mode), so a slot the screen offers is a slot the server takes and
 * a price the till shows is the price the server charges. Times are stored
 * in UTC; opening hours are the shop's own clock, Europe/London, worked out
 * here by hand because the hooks' JavaScript has no time zone database.
 */

export const RESOURCE_KINDS = ["table", "pc", "console", "room"] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

export const BOOKING_STATUSES = ["held", "confirmed", "checked_in", "completed", "cancelled", "no_show"] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/** A booking in one of these takes its time up. */
export const BOOKING_ACTIVE_STATUSES: readonly BookingStatus[] = ["held", "confirmed", "checked_in"]

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number]

/** Opening windows per weekday, shop time: { mon: [["10:00", "20:00"]] }. A missing day is closed. */
export type OpeningHours = Partial<Record<WeekdayKey, [string, string][]>>

/** A part slot longer than this many minutes counts as a whole one at check-out. */
export const SESSION_GRACE_MINUTES = 10

export interface BookableResource {
  id: string
  name: string
  kind: ResourceKind
  capacity: number
  slot_minutes: number
  /** Pence a slot. */
  price: number
  /** Pence a slot for a Guild member, or null for the same price. */
  member_price: number | null
  /** Pence a booking, or null for none. */
  deposit: number | null
  online: boolean
  /** Its own hours, or null for the shop's. */
  hours: OpeningHours | null
  active: boolean
  sort: number
}

/** Something that takes a resource's time: a live booking, or an event using it. */
export interface BusyWindow {
  starts_at: string
  ends_at: string
}

export interface Slot {
  starts_at: string
  ends_at: string
  free: boolean
}

// ---------------------------------------------------------------------------
// Shop time
// ---------------------------------------------------------------------------

/** The last Sunday of a month (0-based), as a UTC day of the month. */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0))
  return last.getUTCDate() - last.getUTCDay()
}

/**
 * Whether British Summer Time is in force at this instant: from 01:00 UTC on
 * the last Sunday of March to 01:00 UTC on the last Sunday of October.
 */
export function isBritishSummerTime(at: Date): boolean {
  const year = at.getUTCFullYear()
  const start = Date.UTC(year, 2, lastSunday(year, 2), 1)
  const end = Date.UTC(year, 9, lastSunday(year, 9), 1)
  const t = at.getTime()
  return t >= start && t < end
}

/** The UTC instant of a shop-time date ("2026-10-16") and clock time ("18:30"). */
export function shopTimeToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  const [hh, mm] = time.split(":").map(Number)
  const guess = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0))
  // Shop time is UTC+1 in summer: the instant is an hour earlier than the
  // same clock reading in UTC. Checked at the guess, which is right except
  // inside the changeover hour, when the shop is closed anyway.
  return isBritishSummerTime(guess) ? new Date(guess.getTime() - 3_600_000) : guess
}

/** The shop-time date ("YYYY-MM-DD") an instant falls on. */
export function shopDateOf(at: Date): string {
  const local = new Date(at.getTime() + (isBritishSummerTime(at) ? 3_600_000 : 0))
  return local.toISOString().slice(0, 10)
}

/** The weekday of a shop-time date. */
export function weekdayOf(date: string): WeekdayKey {
  const [y, m, d] = date.split("-").map(Number)
  return WEEKDAY_KEYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? "sun"
}

/** The windows a resource is open on a date: its own hours, else the shop's. */
export function hoursOn(resource: Pick<BookableResource, "hours">, shopHours: OpeningHours, date: string): [string, string][] {
  const hours = resource.hours && Object.keys(resource.hours).length > 0 ? resource.hours : shopHours
  return hours[weekdayOf(date)] ?? []
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** Whether two time windows overlap (touching ends do not). */
export function overlaps(a: BusyWindow, b: BusyWindow): boolean {
  return Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at)
}

/**
 * Every slot of a resource on a shop-time date, within its opening windows,
 * `slot_minutes` apart, each marked free when nothing busy overlaps it and,
 * when `now` is given, it has not started yet.
 */
export function daySlots(
  resource: Pick<BookableResource, "hours" | "slot_minutes">,
  shopHours: OpeningHours,
  date: string,
  busy: readonly BusyWindow[],
  now?: Date
): Slot[] {
  const step = Math.max(5, resource.slot_minutes || 60) * 60_000
  const out: Slot[] = []
  for (const [open, close] of hoursOn(resource, shopHours, date)) {
    const end = shopTimeToUtc(date, close).getTime()
    for (let t = shopTimeToUtc(date, open).getTime(); t + step <= end; t += step) {
      const slot = { starts_at: new Date(t).toISOString(), ends_at: new Date(t + step).toISOString() }
      const taken = busy.some((window) => overlaps(slot, window))
      const past = now ? t < now.getTime() : false
      out.push({ ...slot, free: !taken && !past })
    }
  }
  return out
}

/**
 * Why a booking of a resource from `starts_at` to `ends_at` cannot be made,
 * or null: inside its hours on that day, a whole number of slots, and clear
 * of everything busy.
 */
export function bookingProblem(
  resource: Pick<BookableResource, "name" | "hours" | "slot_minutes" | "active"> & { kind?: ResourceKind },
  shopHours: OpeningHours,
  window: BusyWindow,
  busy: readonly BusyWindow[]
): string | null {
  if (!resource.active) return `${resource.name} is switched off. Pick another.`
  const start = Date.parse(window.starts_at)
  const end = Date.parse(window.ends_at)
  if (!(end > start)) return "The booking has to end after it starts."
  const step = Math.max(5, resource.slot_minutes || 60) * 60_000
  if ((end - start) % step !== 0) return `${resource.name} books in ${resource.slot_minutes}-minute slots.`
  const date = shopDateOf(new Date(start))
  const inside = hoursOn(resource, shopHours, date).some(([open, close]) => {
    return start >= shopTimeToUtc(date, open).getTime() && end <= shopTimeToUtc(date, close).getTime()
  })
  if (!inside) return `${resource.name} is not open then. Pick a time within its hours.`
  const clash = busy.find((other) => overlaps(window, other))
  if (clash) {
    return `${resource.name} is booked from ${shopClock(clash.starts_at)} to ${shopClock(clash.ends_at)}. Pick another time or another ${kindWord(resource)}.`
  }
  return null
}

function kindWord(resource: { kind?: ResourceKind }): string {
  const kind = resource.kind
  return kind === "pc" ? "PC" : kind === "console" ? "console" : kind === "room" ? "room" : "table"
}

/** "18:00", shop time. */
export function shopClock(iso: string): string {
  const at = new Date(iso)
  const local = new Date(at.getTime() + (isBritishSummerTime(at) ? 3_600_000 : 0))
  return local.toISOString().slice(11, 16)
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** The slot price for this customer: the member price for a Guild member when there is one. */
export function slotPrice(resource: Pick<BookableResource, "price" | "member_price">, member: boolean): number {
  return member && resource.member_price !== null && resource.member_price !== undefined
    ? resource.member_price
    : resource.price
}

/** A booking's price and deposit for a window. */
export function bookingPrice(
  resource: Pick<BookableResource, "price" | "member_price" | "deposit" | "slot_minutes">,
  window: BusyWindow,
  member: boolean
): { slots: number; price: number; deposit: number } {
  const step = Math.max(5, resource.slot_minutes || 60) * 60_000
  const slots = Math.max(0, Math.round((Date.parse(window.ends_at) - Date.parse(window.starts_at)) / step))
  const price = slots * slotPrice(resource, member)
  return { slots, price, deposit: Math.min(price, resource.deposit ?? 0) }
}

/**
 * A walk-in session's charge at check-out: whole slots from check-in, a part
 * slot counting as a whole one once it runs past the grace minutes, and
 * never less than one slot.
 */
export function sessionCharge(
  resource: Pick<BookableResource, "price" | "member_price" | "slot_minutes">,
  checkedInAt: string,
  checkedOutAt: string,
  member: boolean,
  graceMinutes: number = SESSION_GRACE_MINUTES
): { minutes: number; slots: number; price: number } {
  const minutes = Math.max(0, Math.floor((Date.parse(checkedOutAt) - Date.parse(checkedInAt)) / 60_000))
  const step = Math.max(5, resource.slot_minutes || 60)
  const whole = Math.floor(minutes / step)
  const part = minutes - whole * step
  const slots = Math.max(1, whole + (part > graceMinutes ? 1 : 0))
  return { minutes, slots, price: slots * slotPrice(resource, member) }
}

/** An event's entry fee for this customer. */
export function entryFee(event: { entry_fee: number; member_fee: number | null }, member: boolean): number {
  return member && event.member_fee !== null && event.member_fee !== undefined ? event.member_fee : event.entry_fee
}

/** Places left at an event, counting the party sizes of its live entries. */
export function placesLeft(capacity: number, entries: readonly { party_size: number; status: BookingStatus }[]): number {
  if (!(capacity > 0)) return Number.POSITIVE_INFINITY
  const taken = entries
    .filter((entry) => BOOKING_ACTIVE_STATUSES.includes(entry.status) || entry.status === "completed")
    .reduce((sum, entry) => sum + Math.max(1, entry.party_size), 0)
  return Math.max(0, capacity - taken)
}

// ---------------------------------------------------------------------------
// What the routes answer
// ---------------------------------------------------------------------------

/** `GET /api/vault/bookings/availability` and `GET /api/public/availability`. */
export interface Availability {
  date: string
  resources: {
    resource: Pick<BookableResource, "id" | "name" | "kind" | "capacity" | "slot_minutes" | "price" | "member_price" | "deposit">
    slots: Slot[]
  }[]
}

// ---------------------------------------------------------------------------
// The booking routes' own rules (BK), here so the web's demo mode agrees
// ---------------------------------------------------------------------------

/** A shop-time date ("2026-10-16") moved by whole days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10)
}

/** The UTC instants a shop-time date runs between: 23 hours in March, 25 in October. */
export function shopDayBounds(date: string): BusyWindow {
  return {
    starts_at: shopTimeToUtc(date, "00:00").toISOString(),
    ends_at: shopTimeToUtc(addDays(date, 1), "00:00").toISOString(),
  }
}

/**
 * The clash sentence for a window against what is busy, or null: the same
 * words as `bookingProblem`'s, for a walk-in session, which starts now
 * whatever the hours and the slot grid say.
 */
export function clashProblem(
  resource: Pick<BookableResource, "name"> & { kind?: ResourceKind },
  window: BusyWindow,
  busy: readonly BusyWindow[]
): string | null {
  const clash = busy.find((other) => overlaps(window, other))
  if (!clash) return null
  return `${resource.name} is booked from ${shopClock(clash.starts_at)} to ${shopClock(clash.ends_at)}. Pick another time or another ${kindWord(resource)}.`
}

/** What a booking needs for `liveWindow`. */
export interface BookingTimes {
  status: BookingStatus
  starts_at: string
  ends_at: string
  checked_in_at?: string | null
  checked_out_at?: string | null
}

/**
 * The time a booking takes up, or null when it takes none. A held or
 * confirmed booking takes its own window. A checked-in one that has not
 * checked out is a session still running, and nobody knows when it will
 * stop, so it takes at least to the end of the slot it is in now, counting
 * whole slots from check-in.
 */
export function liveWindow(booking: BookingTimes, slotMinutes: number, now: Date): BusyWindow | null {
  if (!BOOKING_ACTIVE_STATUSES.includes(booking.status)) return null
  if (booking.status !== "checked_in" || booking.checked_out_at) {
    return { starts_at: booking.starts_at, ends_at: booking.ends_at }
  }
  const step = Math.max(5, slotMinutes || 60) * 60_000
  const checkedIn = Date.parse(booking.checked_in_at || booking.starts_at)
  const start = Math.min(Date.parse(booking.starts_at), checkedIn)
  const slotsSoFar = Math.max(1, Math.floor((now.getTime() - checkedIn) / step) + 1)
  const end = Math.max(Date.parse(booking.ends_at), checkedIn + slotsSoFar * step)
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() }
}

/** An event entry, as the waitlist reads it. */
export interface EventEntry {
  id: string
  party_size: number
  status: BookingStatus
  /** When it was made: the order the waitlist keeps. */
  created: string
}

const FIRM_ENTRY: readonly BookingStatus[] = ["confirmed", "checked_in", "completed"]

/**
 * An event's waitlist, first in line first. Places go by party size to the
 * firm entries (confirmed, checked in or completed) and then to the held
 * ones in the order they were made. Once a held entry does not fit, it and
 * every held entry after it wait, so a smaller party never jumps the queue.
 * A capacity of 0 has no limit and no waitlist.
 */
export function waitlistOf(capacity: number, entries: readonly EventEntry[]): string[] {
  if (!(capacity > 0)) return []
  let taken = entries
    .filter((entry) => FIRM_ENTRY.includes(entry.status))
    .reduce((sum, entry) => sum + Math.max(1, entry.party_size), 0)
  const held = entries
    .filter((entry) => entry.status === "held")
    .slice()
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const waiting: string[] = []
  for (const entry of held) {
    const size = Math.max(1, entry.party_size)
    if (waiting.length === 0 && taken + size <= capacity) {
      taken += size
    } else {
      waiting.push(entry.id)
    }
  }
  return waiting
}

/**
 * The weekly repeats of an event after its first: the same shop clock time
 * each week (so 18:00 stays 18:00 across the clock change), for every one
 * that starts after `now` and no more than `days` from it.
 */
export function repeatWindows(first: BusyWindow, now: Date, days: number = 28): BusyWindow[] {
  const startMs = Date.parse(first.starts_at)
  const length = Date.parse(first.ends_at) - startMs
  if (!(length > 0)) return []
  const date = shopDateOf(new Date(startMs))
  const clock = shopClock(first.starts_at)
  const until = now.getTime() + days * 86_400_000
  const week = 7 * 86_400_000
  const out: BusyWindow[] = []
  // Start a week or so before now rather than walking from a first event
  // years back.
  for (let k = Math.max(1, Math.floor((now.getTime() - startMs) / week)); k < 10_000; k++) {
    const start = shopTimeToUtc(addDays(date, 7 * k), clock).getTime()
    if (start > until) break
    if (start > now.getTime()) {
      out.push({ starts_at: new Date(start).toISOString(), ends_at: new Date(start + length).toISOString() })
    }
  }
  return out
}

const DAY_NAMES: Record<WeekdayKey, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
}

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/

/**
 * Why a set of opening hours cannot be saved, or null. Empty (or nothing)
 * is fine: a resource with no hours of its own keeps the shop's. Each day is
 * a list of windows of two "HH:MM" times, the first before the second, and
 * a day's windows do not overlap.
 */
export function hoursProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "object" || Array.isArray(value)) return "Set the opening hours as times for each day."
  for (const [key, windows] of Object.entries(value as Record<string, unknown>)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) {
      return `There is no day called ${key}. Use mon, tue, wed, thu, fri, sat or sun.`
    }
    const day = DAY_NAMES[key as WeekdayKey]
    if (!Array.isArray(windows)) return `Set ${day}'s opening times as a list, or leave it out for closed.`
    const seen: [string, string][] = []
    for (const window of windows) {
      if (
        !Array.isArray(window) ||
        window.length !== 2 ||
        typeof window[0] !== "string" ||
        typeof window[1] !== "string" ||
        !CLOCK.test(window[0]) ||
        !CLOCK.test(window[1])
      ) {
        return `Each opening time on ${day} needs a start and an end, like 10:00 and 20:00.`
      }
      const [open, close] = window as [string, string]
      if (open >= close) return `On ${day}, ${open} to ${close} ends before it starts. Check the times.`
      if (seen.some(([o, c]) => open < c && o < close)) return `Two of ${day}'s opening times overlap. Make them one.`
      seen.push([open, close])
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// What the booking routes answer (BK)
// ---------------------------------------------------------------------------

/** A sale line that paid towards a booking. */
export interface BookingPayment {
  sale: { id: string; number: string }
  sale_line: string
  /** Pence of the booking's price this line settles while it is not refunded. */
  amount: number
}

/** One booking as the booking routes answer it. */
export interface BookingView {
  id: string
  kind: "resource" | "event"
  resource: { id: string; name: string; kind: ResourceKind } | null
  event: { id: string; name: string } | null
  /** `member` is whether they are in the Guild (members' prices). */
  customer: { id: string; name: string; code: string; member: boolean } | null
  /** The customer's name, or the name given for a booking with no customer record. */
  name: string
  phone: string
  email: string
  starts_at: string
  ends_at: string
  party_size: number
  status: BookingStatus
  price: number
  deposit: number
  paid: number
  /** What is left to pay: price less paid, never below 0. */
  balance: number
  source: "till" | "online" | "phone" | ""
  checked_in_at: string | null
  checked_out_at: string | null
  /** 1 for the first in line on an event's waitlist; null when not waiting. */
  waitlist_position: number | null
  /** Staff only; empty in a customer's own answer. */
  notes: string
  created: string
  /** On the single booking (`GET /api/vault/bookings/{id}`, staff) only. */
  payments?: BookingPayment[]
}

/** The lines of one sale the till refunds through its refund flow. */
export interface BookingRefund {
  sale: { id: string; number: string }
  lines: { sale_line: string; qty: number }[]
  /** Pence of the booking's price these lines settled. */
  amount: number
}

/** `POST /api/vault/bookings/{id}/cancel`. */
export interface BookingCancelled extends BookingView {
  refunds: BookingRefund[]
  /** Pence paid that stays with the shop (the deposit kept). */
  kept: number
}

/** `POST /api/vault/bookings/{id}/check-out`. */
export interface BookingCheckedOut extends BookingView {
  charge: { minutes: number; slots: number; price: number; balance: number }
}

/** An event as the booking routes answer it. */
export interface EventView {
  id: string
  name: string
  game: { id: string; name: string } | null
  format: string
  starts_at: string
  ends_at: string
  /** 0 for no limit. */
  capacity: number
  /** null when there is no limit. */
  places_left: number | null
  entry_fee: number
  member_fee: number | null
  online: boolean
  status: "draft" | "published" | "cancelled" | "finished"
  repeat_weekly: boolean
  repeat_of: string | null
  resources: { id: string; name: string; kind: ResourceKind }[]
  description: string
  /** Players entered (party sizes), the waitlist left out. */
  entered: number
  /** Entries on the waitlist. */
  waitlist: number
}

/** A station on the stations strip: its running session, and its next booking today. */
export interface StationView {
  resource: Pick<BookableResource, "id" | "name" | "kind" | "slot_minutes" | "price" | "member_price">
  session: BookingView | null
  next: BookingView | null
}
