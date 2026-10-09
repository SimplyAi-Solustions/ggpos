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
