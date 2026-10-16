/**
 * What a booking is, in the counter's words and figures: its state, what is
 * left to pay and how it can be paid, an event's entries and waitlist, a
 * station's clock, and the shop-time dates the screens move between.
 *
 * Pure, so the sentences and the sums are unit tested on their own. Money
 * is integer pence; every amount is formatted with `formatGBP`. The rules
 * themselves (prices, charges, places, the waitlist) are the shared ones in
 * packages/shared/src/bookings.ts that BK's routes run.
 */
import {
  BOOKING_ACTIVE_STATUSES,
  addDays,
  formatGBP,
  sessionCharge,
  shopClock,
  shopDateOf,
  slotPrice,
  type BookableResource,
  type BookingCancelled,
  type BookingStatus,
  type BookingView,
  type ResourceKind,
  type Slot,
  type WeekdayKey,
} from "@gg/shared"

// ---------------------------------------------------------------------------
// Dates, in shop time
// ---------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

function utcDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1))
}

/** Today on the shop's clock, "2026-10-16". */
export function shopToday(now: Date = new Date()): string {
  return shopDateOf(now)
}

/** "Fri 16 Oct". */
export function dayLabel(date: string): string {
  const at = utcDate(date)
  return `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`
}

/** "Today", "Tomorrow", or "Fri 16 Oct". */
export function relativeDay(date: string, today: string): string {
  if (date === today) return "Today"
  if (date === addDays(today, 1)) return "Tomorrow"
  if (date === addDays(today, -1)) return "Yesterday"
  return dayLabel(date)
}

/** The Monday to Sunday a date falls in. */
export function weekOf(date: string): string[] {
  const day = utcDate(date).getUTCDay()
  const monday = addDays(date, day === 0 ? -6 : 1 - day)
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

/** "18:00 to 19:30". */
export function timeRange(window: { starts_at: string; ends_at: string }): string {
  return `${shopClock(window.starts_at)} to ${shopClock(window.ends_at)}`
}

/** The shop-time date an instant falls on. */
export function dateOf(iso: string): string {
  return shopDateOf(new Date(iso))
}

// ---------------------------------------------------------------------------
// Opening hours, as the editor shows them
// ---------------------------------------------------------------------------

/** Monday first, the way a week reads in the shop. */
export const WEEK: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

export const DAY_NAMES: Record<WeekdayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
}

// ---------------------------------------------------------------------------
// State, in words
// ---------------------------------------------------------------------------

const STATUS_WORDS: Record<BookingStatus, string> = {
  held: "Held",
  confirmed: "Booked",
  checked_in: "Checked in",
  completed: "Done",
  cancelled: "Cancelled",
  no_show: "No-show",
}

export function statusWord(status: BookingStatus): string {
  return STATUS_WORDS[status] ?? status
}

/** Held, confirmed or checked in: it takes its time up. */
export function isLive(booking: Pick<BookingView, "status">): boolean {
  return BOOKING_ACTIVE_STATUSES.includes(booking.status)
}

/** Held or confirmed: it has not started, so it can still move, be cancelled or be a no-show. */
export function isOpen(booking: Pick<BookingView, "status">): boolean {
  return booking.status === "held" || booking.status === "confirmed"
}

/** What is still to pay on a booking, never below nothing. */
export function owed(booking: Pick<BookingView, "price" | "paid">): number {
  return Math.max(0, booking.price - booking.paid)
}

/** A walk-in on the clock: a station session with no price until it stops. */
export function isWalkIn(booking: Pick<BookingView, "kind" | "status" | "price">): boolean {
  return booking.kind === "resource" && booking.status === "checked_in" && booking.price === 0
}

/** Whether it has been paid, in words: "Paid", "Deposit paid, £6.00 to pay", "£8.00 to pay". */
export function paidState(booking: Pick<BookingView, "kind" | "status" | "price" | "paid" | "deposit">): string {
  if (isWalkIn(booking)) return "On the clock"
  if (booking.price <= 0) return "Free"
  const left = owed(booking)
  if (left === 0) return "Paid"
  if (booking.deposit > 0 && booking.paid >= booking.deposit) return `Deposit paid, ${formatGBP(left)} to pay`
  return `${formatGBP(left)} to pay`
}

/** "4 players", "1 player". */
export function partyWords(size: number): string {
  return `${size} ${size === 1 ? "player" : "players"}`
}

/** "Up to 6", "No limit": a capacity of 0 has none. */
export function capacityWords(capacity: number): string {
  return capacity > 0 ? `Up to ${capacity}` : "No limit"
}

/** "PC", "table", for a kind in a sentence. */
export function kindWord(kind: ResourceKind, plural = false): string {
  const word = kind === "pc" ? "PC" : kind === "console" ? "console" : kind === "room" ? "room" : "table"
  return plural ? `${word}s` : word
}

/** A kind as a chip says it: "Tables", "PCs", "Consoles", "Rooms". */
export function kindLabel(kind: ResourceKind): string {
  const word = kindWord(kind, true)
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** "1 hour", "1 hour 30", "45 minutes". */
export function lengthWords(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const head = `${hours} ${hours === 1 ? "hour" : "hours"}`
  return rest ? `${head} ${rest}` : head
}

/**
 * The lengths a booking from this slot can run to: this slot and up to
 * three more straight after it, stopping at a gap in the hours. Taken
 * slots count, so the server says what clashes in its own words.
 */
export function lengthChoices(slots: readonly Slot[], startsAt: string, most = 4): Slot[][] {
  const index = slots.findIndex((slot) => slot.starts_at === startsAt)
  if (index < 0) return []
  const runs: Slot[][] = []
  let run: Slot[] = []
  for (let at = index; at < slots.length && run.length < most; at++) {
    const slot = slots[at]
    if (!slot) break
    const last = run[run.length - 1]
    if (last && last.ends_at !== slot.starts_at) break
    run = [...run, slot]
    runs.push(run)
  }
  return runs
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

export interface PaymentChoice {
  key: "deposit" | "balance" | "full"
  label: string
  amount: number
}

/**
 * How a booking can be paid at the till: the deposit while it is owed and
 * the booking costs more, and what is left (the balance once anything is
 * paid, otherwise the whole price). Nothing for an entry still waiting for
 * a place: the sale route refuses it until one frees.
 */
export function paymentChoices(
  booking: Pick<BookingView, "price" | "paid" | "deposit"> & { waitlist_position?: number | null }
): PaymentChoice[] {
  if (booking.waitlist_position) return []
  const left = owed(booking)
  if (left <= 0) return []
  const choices: PaymentChoice[] = []
  const depositLeft = booking.deposit - booking.paid
  if (depositLeft > 0 && depositLeft < left) {
    choices.push({ key: "deposit", label: "Deposit", amount: depositLeft })
  }
  choices.push(
    booking.paid > 0
      ? { key: "balance", label: "Balance", amount: left }
      : { key: "full", label: "In full", amount: left }
  )
  return choices
}

/**
 * What the till's line says: "Table 2, Fri 16 Oct 18:00, deposit" or
 * "Pokémon League, Fri 16 Oct, entry", BK's own `label` with the part paid.
 */
export function lineTitle(
  booking: Pick<BookingView, "kind" | "starts_at">,
  what: string,
  choice: PaymentChoice["key"] | "session" | "entry"
): string {
  const day = dayLabel(dateOf(booking.starts_at))
  const when = booking.kind === "event" ? day : `${day} ${shopClock(booking.starts_at)}`
  const part =
    choice === "deposit"
      ? ", deposit"
      : choice === "balance"
        ? ", balance"
        : choice === "session"
          ? ", session"
          : booking.kind === "event"
            ? ", entry"
            : ""
  return `${what}, ${when}${part}`
}

/**
 * What a cancellation leaves the till to do, in one sentence: BK lists the
 * sale lines to refund through the refund route and what the shop keeps; it
 * never moves money itself.
 */
export function refundWords(result: Pick<BookingCancelled, "refunds" | "kept">): string {
  const back = result.refunds.reduce((sum, refund) => sum + refund.amount, 0)
  const sales = result.refunds.map((refund) => refund.sale.number).join(" and ")
  const parts = [
    back > 0 ? `Refund ${formatGBP(back)} at the till through Returns, on ${sales}.` : "",
    result.kept > 0 ? `${formatGBP(result.kept)} is kept.` : "",
  ]
  return parts.filter(Boolean).join(" ")
}

/** What a booking is of: its resource's name, or its event's. */
export function whatOf(booking: Pick<BookingView, "kind" | "resource" | "event">): string {
  return booking.kind === "event" ? (booking.event?.name ?? "Event entry") : (booking.resource?.name ?? "Booking")
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/** "£4.00 an hour", "£2.50 for 30 minutes". */
export function rateWords(price: number, slotMinutes: number): string {
  return slotMinutes === 60
    ? `${formatGBP(price)} an hour`
    : `${formatGBP(price)} for ${lengthWords(slotMinutes)}`
}

/** "0:42", "1:05": hours and minutes on the clock since it started. */
export function clockSince(fromIso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000))
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
}

/**
 * What a station's session comes to if it stopped now, as BK's check-out
 * charges it: the slots used from check-in (a part slot once it runs past
 * the grace minutes, the Guild price for a member), never less than the
 * price it was booked for.
 */
export function runningCharge(
  booking: Pick<BookingView, "price" | "checked_in_at" | "starts_at" | "customer">,
  resource: Pick<BookableResource, "price" | "member_price" | "slot_minutes">,
  now: number
): number {
  const clock = sessionCharge(
    resource,
    booking.checked_in_at || booking.starts_at,
    new Date(now).toISOString(),
    booking.customer?.member ?? false
  ).price
  return Math.max(booking.price, clock)
}

/** A slot's price for this customer, and whether it is the Guild price. */
export function priceFor(
  resource: Pick<BookableResource, "price" | "member_price">,
  member: boolean
): { price: number; memberPrice: boolean } {
  const price = slotPrice(resource, member)
  return { price, memberPrice: member && price !== resource.price }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EntrySplit<T> {
  /** Entries holding a place, first come first. */
  entered: T[]
  /** Waiting for a place, first in line first (BK's `waitlist_position`). */
  waitlist: T[]
  /** Cancelled and no-shows. */
  closed: T[]
}

/** An event's entries as the counter lists them, by what the server says of each. */
export function splitEntries<T extends Pick<BookingView, "status" | "created" | "waitlist_position">>(
  entries: readonly T[]
): EntrySplit<T> {
  const ordered = [...entries].sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
  return {
    entered: ordered.filter((entry) => entry.status !== "cancelled" && entry.status !== "no_show" && !entry.waitlist_position),
    waitlist: ordered
      .filter((entry) => Boolean(entry.waitlist_position))
      .sort((a, b) => (a.waitlist_position ?? 0) - (b.waitlist_position ?? 0)),
    closed: ordered.filter((entry) => entry.status === "cancelled" || entry.status === "no_show"),
  }
}

/** "4 of 16 places left", "Full, 16 places taken", "No limit, 12 entered". */
export function placesWords(event: { capacity: number; places_left: number | null; entered: number }): string {
  if (event.capacity <= 0 || event.places_left === null) return `No limit, ${event.entered} entered`
  return event.places_left === 0
    ? `Full, ${event.capacity} places taken`
    : `${event.places_left} of ${event.capacity} places left`
}

/** "£5.00, Guild £4.00", or "Free". */
export function feeWords(event: { entry_fee: number; member_fee: number | null }): string {
  if (event.entry_fee <= 0 && !event.member_fee) return "Free"
  const fee = formatGBP(event.entry_fee)
  return event.member_fee !== null && event.member_fee !== event.entry_fee
    ? `${fee}, Guild ${formatGBP(event.member_fee)}`
    : fee
}
