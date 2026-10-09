/**
 * The demo shop's bookings, answered from memory for the tab like every
 * other demo store, the way BK's routes answer them (pb/pb_hooks/
 * bookings.pb.js and lib/bookings.js; docs/api-contract-launch.md, section 4).
 *
 * Four tables, six PCs and a party room, a few bookings today, a PC on the
 * clock, a weekly Pokémon league and a One Piece tournament. Every slot,
 * clash, price, session charge, place count and waitlist comes from
 * `packages/shared/src/bookings.ts`, the same functions the server runs, and
 * every refusal is the server's own sentence and status, so what the demo
 * refuses and charges is what the shop's counter would. The seed is laid the
 * first time anything asks, against the shop's clock at that moment, so
 * "today" is always today.
 */
import { ClientResponseError } from "pocketbase"
import {
  BOOKING_ACTIVE_STATUSES,
  addDays,
  bookingPrice,
  bookingProblem,
  clashProblem,
  daySlots,
  entryFee,
  formatGBP,
  hoursOn,
  hoursProblem,
  liveWindow,
  placesLeft,
  sessionCharge,
  shopClock,
  shopDateOf,
  shopDayBounds,
  shopTimeToUtc,
  waitlistOf,
  type Availability,
  type BookingCancelled,
  type BookingCheckedOut,
  type BookingStatus,
  type BookingView,
  type BusyWindow,
  type EventView,
  type OpeningHours,
  type ResourceKind,
  type StationView,
} from "@gg/shared"

import { DEMO_CUSTOMERS } from "@/lib/api/demo/customers"
import { demoPortalCustomerId } from "@/lib/api/demo/portal-seed"
import { DEMO_GAMES } from "@/lib/api/fixtures"
import type {
  EventCancelled,
  EventInput,
  MoveInput,
  NewBookingInput,
  Resource,
  ResourceInput,
} from "@/lib/api/bookings"

/** A refusal in the shape the routes send, so `refusalMessage` reads it. */
function refusal(status: number, message: string): ClientResponseError {
  return new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}_demo_${Date.now().toString(36)}${counter}`
}

const MINUTE = 60_000
const DAY = 86_400_000
const STATIONS: readonly ResourceKind[] = ["pc", "console"]
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** The migration's placeholder hours, which the shop edits in Settings. */
const SEED_HOURS: OpeningHours = {
  mon: [["10:00", "20:00"]],
  tue: [["10:00", "20:00"]],
  wed: [["10:00", "20:00"]],
  thu: [["10:00", "20:00"]],
  fri: [["10:00", "22:00"]],
  sat: [["10:00", "22:00"]],
  sun: [["11:00", "17:00"]],
}

/**
 * Who is in the Guild, for a demo customer with no `guild_joined_at` field.
 * Every customer carded before the Guild existed is a member (section 1);
 * T Bradbury, the portal duplicate, has not joined, so the member price has
 * somebody to be different for.
 */
const NOT_JOINED = new Set(["cust_demo_4"])

/** A sale line that paid towards a booking, as BK's `payments` reads them. */
interface DemoPayment {
  sale: { id: string; number: string }
  sale_line: string
  amount: number
  units: number
}

/** A `bookings` row as the demo keeps it: ids, not the view's names. */
interface DemoBooking {
  id: string
  kind: "resource" | "event"
  resource: string
  event: string
  customer: string
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
  source: "till" | "online" | "phone"
  checked_in_at: string
  checked_out_at: string
  notes: string
  created: string
  payments: DemoPayment[]
}

/** A `booking_events` row. A member fee or a capacity of 0 means none. */
interface DemoEvent {
  id: string
  name: string
  game: string
  format: string
  starts_at: string
  ends_at: string
  capacity: number
  entry_fee: number
  member_fee: number
  online: boolean
  status: EventView["status"]
  repeat_weekly: boolean
  repeat_of: string
  resources: string[]
  description: string
  created: string
}

interface DemoState {
  hours: OpeningHours
  resources: Resource[]
  events: DemoEvent[]
  bookings: DemoBooking[]
}

let state: DemoState | null = null

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

function resource(id: string, name: string, kind: ResourceKind, sort: number, extra: Partial<Resource>): Resource {
  return {
    id,
    name,
    kind,
    capacity: 1,
    slot_minutes: 60,
    price: 0,
    member_price: null,
    deposit: null,
    online: true,
    hours: null,
    active: true,
    sort,
    image: "",
    note: "",
    ...extra,
  }
}

function seedResources(): Resource[] {
  const tables = [1, 2, 3, 4].map((n) =>
    resource(`res_table_${n}`, `Table ${n}`, "table", n, { capacity: 6, price: 500, member_price: 400 })
  )
  const pcs = [1, 2, 3, 4, 5, 6].map((n) =>
    resource(`res_pc_${n}`, `PC ${n}`, "pc", 10 + n, { capacity: 1, price: 400, member_price: 300 })
  )
  const room = resource("res_party_room", "Party room", "room", 30, {
    capacity: 20,
    slot_minutes: 120,
    price: 4000,
    member_price: 3500,
    deposit: 2000,
    online: false,
    note: "Parties and private hire. Booked at the counter or on the phone.",
  })
  return [...tables, ...pcs, room]
}

function isoAt(date: string, time: string): string {
  return shopTimeToUtc(date, time).toISOString()
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function row(partial: Partial<DemoBooking> & Pick<DemoBooking, "id" | "starts_at" | "ends_at">): DemoBooking {
  return {
    kind: "resource",
    resource: "",
    event: "",
    customer: "",
    name: "",
    phone: "",
    email: "",
    party_size: 1,
    status: "confirmed",
    price: 0,
    deposit: 0,
    paid: 0,
    source: "till",
    checked_in_at: "",
    checked_out_at: "",
    notes: "",
    created: new Date().toISOString(),
    payments: [],
    ...partial,
  }
}

/** The first day from `date` on whose hours run to `close` or later. */
function nextDayOpenTill(date: string, close: string, hours: OpeningHours): string {
  for (let offset = 0; offset < 7; offset++) {
    const day = addDays(date, offset)
    if (hoursOn({ hours: null }, hours, day).some(([, shut]) => minutesOf(shut) >= minutesOf(close))) return day
  }
  return date
}

/** The next Saturday strictly after `date`. */
function nextSaturday(date: string): string {
  for (let offset = 1; offset <= 7; offset++) {
    const day = addDays(date, offset)
    const [y, m, d] = day.split("-").map(Number)
    if (new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay() === 6) return day
  }
  return addDays(date, 1)
}

function seed(): DemoState {
  const now = new Date()
  const today = shopDateOf(now)
  const hours = structuredClone(SEED_HOURS)
  const resources = seedResources()
  const open = minutesOf(hoursOn({ hours: null }, hours, today)[0]?.[0] ?? "10:00")
  const at = (offset: number) => isoAt(today, clock(open + offset))
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString()

  const bookings: DemoBooking[] = [
    row({
      id: "booking_demo_harper",
      resource: "res_table_1",
      name: "Harper family",
      phone: "07700 900321",
      starts_at: at(120),
      ends_at: at(240),
      party_size: 5,
      price: 1000,
      source: "phone",
      created: ago(4000),
    }),
    // A staff booking with a deposit due is held until it is paid.
    row({
      id: "booking_demo_ellis",
      resource: "res_party_room",
      name: "Ellis, 9th birthday",
      phone: "07700 900654",
      starts_at: at(120),
      ends_at: at(240),
      party_size: 12,
      status: "held",
      price: 4000,
      deposit: 2000,
      source: "phone",
      notes: "Cake at 2pm. Two adults staying.",
      created: ago(9000),
    }),
    row({
      id: "booking_demo_tom_pc",
      resource: "res_pc_3",
      customer: "cust_demo_2",
      starts_at: at(180),
      ends_at: at(300),
      price: 800,
      paid: 800,
      created: ago(3000),
    }),
    // An online booking with something to pay is held for the till.
    row({
      id: "booking_demo_jasmine_table",
      resource: "res_table_2",
      customer: "cust_demo_1",
      starts_at: at(300),
      ends_at: at(360),
      party_size: 2,
      price: 400,
      source: "online",
      status: "held",
      created: ago(2000),
    }),
    // A walk-in on PC 5, on the clock for the last 40 minutes.
    row({
      id: "booking_demo_walkin_pc5",
      resource: "res_pc_5",
      name: "Walk-in",
      starts_at: ago(40),
      ends_at: new Date(now.getTime() + 20 * MINUTE).toISOString(),
      status: "checked_in",
      checked_in_at: ago(40),
      created: ago(40),
    }),
  ]

  // The weekly Pokémon league: today if the shop is open till eight, and
  // the next three weeks made ahead, as the cron makes them.
  const leagueDay = nextDayOpenTill(today, "20:00", hours)
  const league = (week: number): DemoEvent => {
    const day = addDays(leagueDay, week * 7)
    return {
      id: week === 0 ? "event_demo_league" : `event_demo_league_${week}`,
      name: "Pokémon League",
      game: "game_pokemon",
      format: "Standard, best of three",
      starts_at: isoAt(day, "18:00"),
      ends_at: isoAt(day, "20:00"),
      capacity: 16,
      entry_fee: 500,
      member_fee: 400,
      online: true,
      status: "published",
      repeat_weekly: true,
      repeat_of: week === 0 ? "" : "event_demo_league",
      resources: ["res_table_3", "res_table_4"],
      description: "Weekly league night. Bring a deck; promos for the top four.",
      created: ago((30 - week) * 1440),
    }
  }
  const tournamentDay = nextSaturday(today)
  const events: DemoEvent[] = [
    league(0),
    league(1),
    league(2),
    league(3),
    {
      id: "event_demo_one_piece",
      name: "One Piece tournament",
      game: "game_onepiece",
      format: "Swiss, then top eight",
      starts_at: isoAt(tournamentDay, "12:00"),
      ends_at: isoAt(tournamentDay, "17:00"),
      capacity: 24,
      entry_fee: 1000,
      member_fee: 800,
      online: true,
      status: "published",
      repeat_weekly: false,
      repeat_of: "",
      resources: ["res_table_1", "res_table_2"],
      description: "Store tournament. Prize support from Bandai.",
      created: ago(12 * 1440),
    },
  ]

  const leagueEvent = events[0]
  if (leagueEvent) {
    const entry = (id: string, partial: Partial<DemoBooking>, minutesAgo: number) =>
      row({
        id,
        kind: "event",
        event: leagueEvent.id,
        starts_at: leagueEvent.starts_at,
        ends_at: leagueEvent.ends_at,
        created: ago(minutesAgo),
        ...partial,
      })
    bookings.push(
      entry("entry_demo_jasmine", { customer: "cust_demo_1", price: 400, paid: 400, source: "online" }, 3000),
      entry("entry_demo_callum", { customer: "cust_demo_3", party_size: 2, price: 800, status: "held", source: "online" }, 2000),
      entry("entry_demo_sam", { name: "Sam Ward", phone: "07700 900111", price: 500 }, 900)
    )
  }
  const tournament = events[4]
  if (tournament) {
    bookings.push(
      row({
        id: "entry_demo_op_tom",
        kind: "event",
        event: tournament.id,
        customer: "cust_demo_2",
        starts_at: tournament.starts_at,
        ends_at: tournament.ends_at,
        price: 1000,
        created: ago(1500),
      })
    )
  }

  return { hours, resources, events, bookings }
}

function store(): DemoState {
  if (!state) state = seed()
  return state
}

/** Tests start each case from a fresh shop morning. */
export function resetDemoBookings(): void {
  state = null
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

function customerRecord(id: string) {
  return DEMO_CUSTOMERS.find((entry) => entry.customer.id === id)?.customer ?? null
}

export function demoIsMember(customerId: string | null | undefined): boolean {
  if (!customerId) return false
  const customer = customerRecord(customerId)
  if (!customer) return false
  // GO's join writes `guild_joined_at`; when the demo customer carries it,
  // that is the answer.
  const joined = (customer as { guild_joined_at?: string | null }).guild_joined_at
  if (joined !== undefined) return Boolean(joined)
  return !NOT_JOINED.has(customerId)
}

export function demoPortalCustomer(): string {
  return demoPortalCustomerId()
}

// ---------------------------------------------------------------------------
// The views (BK's `views` and `eventViews`)
// ---------------------------------------------------------------------------

function copy<T>(value: T): T {
  return structuredClone(value)
}

/** "Fri 16 Oct", shop time. */
function dayLabel(iso: string): string {
  const [y, m, d] = shopDateOf(new Date(iso)).split("-").map(Number)
  const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1))
  return `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`
}

function findResource(id: string): Resource | undefined {
  return store().resources.find((entry) => entry.id === id)
}

function findEvent(id: string): DemoEvent | undefined {
  return store().events.find((entry) => entry.id === id)
}

function findBooking(id: string): DemoBooking | undefined {
  return store().bookings.find((entry) => entry.id === id)
}

function isOpen(booking: DemoBooking): boolean {
  return booking.status === "held" || booking.status === "confirmed"
}

function eventEntries(eventId: string): DemoBooking[] {
  return store().bookings.filter(
    (entry) =>
      entry.kind === "event" &&
      entry.event === eventId &&
      (BOOKING_ACTIVE_STATUSES.includes(entry.status) || entry.status === "completed")
  )
}

function waitlistFor(event: DemoEvent): string[] {
  return waitlistOf(event.capacity, eventEntries(event.id))
}

function placesFor(event: DemoEvent): number | null {
  const left = placesLeft(event.capacity, eventEntries(event.id))
  return Number.isFinite(left) ? left : null
}

function fees(event: DemoEvent): { entry_fee: number; member_fee: number | null } {
  return { entry_fee: event.entry_fee, member_fee: event.member_fee > 0 ? event.member_fee : null }
}

function view(booking: DemoBooking, options: { forCustomer?: boolean } = {}): BookingView {
  const res = findResource(booking.resource)
  const event = findEvent(booking.event)
  const customer = booking.customer ? customerRecord(booking.customer) : null
  const waiting = event ? waitlistFor(event) : []
  const position = waiting.indexOf(booking.id)
  return {
    id: booking.id,
    kind: booking.kind,
    resource: res ? { id: res.id, name: res.name, kind: res.kind } : null,
    event: event ? { id: event.id, name: event.name } : null,
    customer: customer
      ? { id: customer.id, name: customer.name, code: customer.code, member: demoIsMember(customer.id) }
      : null,
    name: customer ? customer.name : booking.name,
    phone: booking.phone || customer?.phone || "",
    email: booking.email || customer?.email || "",
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    party_size: Math.max(1, booking.party_size),
    status: booking.status,
    price: booking.price,
    deposit: booking.deposit,
    paid: booking.paid,
    balance: Math.max(0, booking.price - booking.paid),
    source: booking.source,
    checked_in_at: booking.checked_in_at || null,
    checked_out_at: booking.checked_out_at || null,
    waitlist_position: position >= 0 ? position + 1 : null,
    notes: options.forCustomer ? "" : booking.notes,
    created: booking.created,
  }
}

function eventView(event: DemoEvent): EventView {
  const entries = eventEntries(event.id)
  const waiting = new Set(waitlistOf(event.capacity, entries))
  const left = placesLeft(event.capacity, entries)
  const game = DEMO_GAMES.find((entry) => entry.id === event.game)
  return {
    id: event.id,
    name: event.name,
    game: game ? { id: game.id, name: event.game === "game_pokemon" ? "Pokémon" : game.name } : null,
    format: event.format,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    capacity: event.capacity,
    places_left: Number.isFinite(left) ? left : null,
    entry_fee: event.entry_fee,
    member_fee: event.member_fee > 0 ? event.member_fee : null,
    online: event.online,
    status: event.status,
    repeat_weekly: event.repeat_weekly,
    repeat_of: event.repeat_of || null,
    resources: event.resources.flatMap((id) => {
      const res = findResource(id)
      return res ? [{ id: res.id, name: res.name, kind: res.kind }] : []
    }),
    description: event.description,
    entered: entries.filter((entry) => !waiting.has(entry.id)).reduce((sum, entry) => sum + Math.max(1, entry.party_size), 0),
    waitlist: waiting.size,
  }
}

/** "Table 2, Fri 16 Oct 18:00" or "Pokémon League, Fri 16 Oct", as BK's `label`. */
function label(booking: DemoBooking): string {
  if (booking.kind === "event") return `${findEvent(booking.event)?.name ?? "Event entry"}, ${dayLabel(booking.starts_at)}`
  return `${findResource(booking.resource)?.name ?? "Booking"}, ${dayLabel(booking.starts_at)} ${shopClock(booking.starts_at)}`
}

// ---------------------------------------------------------------------------
// What is busy
// ---------------------------------------------------------------------------

/** A resource's live bookings (a running session to the end of the slot it is in) and the published events taking it. */
function busyFor(res: Resource, now: Date, exceptBooking = "", exceptEvent = ""): BusyWindow[] {
  const { bookings, events } = store()
  const fromBookings = bookings
    .filter((entry) => entry.kind === "resource" && entry.resource === res.id && entry.id !== exceptBooking)
    .flatMap((entry) => {
      const window = liveWindow(
        {
          status: entry.status,
          starts_at: entry.starts_at,
          ends_at: entry.ends_at,
          checked_in_at: entry.checked_in_at || null,
          checked_out_at: entry.checked_out_at || null,
        },
        res.slot_minutes,
        now
      )
      return window ? [window] : []
    })
  const fromEvents = events
    .filter((event) => event.status === "published" && event.id !== exceptEvent && event.resources.includes(res.id))
    .map((event) => ({ starts_at: event.starts_at, ends_at: event.ends_at }))
  return [...fromBookings, ...fromEvents]
}

/** BK's `placeProblem`: the hours and slot refusals as 400 (409 switched off), a clash as 409. */
function placeProblem(res: Resource, window: BusyWindow, now: Date, exceptBooking = ""): ClientResponseError | null {
  const basic = bookingProblem(res, store().hours, window, [])
  if (basic) return refusal(res.active ? 400 : 409, basic)
  const clash = bookingProblem(res, store().hours, window, busyFor(res, now, exceptBooking))
  return clash ? refusal(409, clash) : null
}

function statusRefusal(status: BookingStatus): ClientResponseError {
  if (status === "cancelled") return refusal(409, "This booking is cancelled.")
  if (status === "no_show") return refusal(409, "This booking was a no-show.")
  if (status === "completed") return refusal(409, "This booking has finished.")
  if (status === "checked_in") return refusal(409, "This booking has checked in. Check it out first.")
  return refusal(409, "This booking cannot be changed now.")
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function demoResources(): Resource[] {
  return copy(store().resources).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}

export function demoAvailability(
  date: string,
  options: { kind?: ResourceKind; party?: number; audience: "staff" | "public" }
): Availability {
  const { resources, hours } = store()
  const now = new Date()
  const publicOnly = options.audience === "public"
  const chosen = resources
    .filter((res) => res.active && (!publicOnly || res.online))
    .filter((res) => !options.kind || res.kind === options.kind)
    .filter((res) => !(options.party && res.capacity > 0 && options.party > res.capacity))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  return {
    date,
    resources: chosen.map((res) => ({
      resource: {
        id: res.id,
        name: res.name,
        kind: res.kind,
        capacity: res.capacity,
        slot_minutes: res.slot_minutes,
        price: res.price,
        member_price: res.member_price,
        deposit: res.deposit,
      },
      // The public answer also marks a slot that has started as not free.
      slots: daySlots(res, hours, date, busyFor(res, now), publicOnly ? now : undefined),
    })),
  }
}

/** `GET /api/vault/bookings?from=&to=`: bookings starting on those shop days. */
export function demoListBookings(from: string, to: string): BookingView[] {
  if (to < from) throw refusal(400, "The last day comes before the first. Swap them round.")
  if (addDays(from, 41) < to) throw refusal(400, "Ask for six weeks at most.")
  const start = Date.parse(shopDayBounds(from).starts_at)
  const end = Date.parse(shopDayBounds(to).ends_at)
  return store()
    .bookings.filter((entry) => Date.parse(entry.starts_at) >= start && Date.parse(entry.starts_at) < end)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || Date.parse(a.created) - Date.parse(b.created))
    .map((entry) => view(entry))
}

/** `GET /api/vault/bookings/stations`. */
export function demoStations(): StationView[] {
  const now = new Date()
  const end = Date.parse(shopDayBounds(shopDateOf(now)).ends_at)
  return store()
    .resources.filter((res) => res.active && STATIONS.includes(res.kind))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((res) => {
      const mine = store().bookings.filter((entry) => entry.kind === "resource" && entry.resource === res.id)
      const session = mine
        .filter((entry) => entry.status === "checked_in" && !entry.checked_out_at)
        .sort((a, b) => Date.parse(b.checked_in_at) - Date.parse(a.checked_in_at))[0]
      const next = mine
        .filter((entry) => isOpen(entry) && Date.parse(entry.starts_at) >= now.getTime() && Date.parse(entry.starts_at) < end)
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0]
      return {
        resource: {
          id: res.id,
          name: res.name,
          kind: res.kind,
          slot_minutes: res.slot_minutes,
          price: res.price,
          member_price: res.member_price,
        },
        session: session ? view(session) : null,
        next: next ? view(next) : null,
      }
    })
}

export function demoListEvents(from: string, to?: string): EventView[] {
  const last = to ?? addDays(from, 60)
  const start = Date.parse(shopDayBounds(from).starts_at)
  const end = Date.parse(shopDayBounds(last).ends_at)
  return store()
    .events.filter((event) => Date.parse(event.ends_at) > start && Date.parse(event.starts_at) < end)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .map(eventView)
}

export function demoGetEvent(id: string): { event: EventView; entries: BookingView[] } {
  const event = findEvent(id)
  if (!event) throw refusal(404, "That event was not found. Reload the events.")
  const entries = store()
    .bookings.filter((entry) => entry.kind === "event" && entry.event === id)
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || (a.id < b.id ? -1 : 1))
  return { event: eventView(event), entries: entries.map((entry) => view(entry)) }
}

export function demoPublicEvents(from: string): EventView[] {
  const now = Date.now()
  const start = Math.max(Date.parse(shopDayBounds(from).starts_at), now)
  const end = Date.parse(shopDayBounds(addDays(from, 60)).ends_at)
  return store()
    .events.filter((event) => event.status === "published" && event.online)
    .filter((event) => Date.parse(event.starts_at) >= start && Date.parse(event.starts_at) < end)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .map(eventView)
}

/** `GET /api/vault/me/bookings`: the signed-in customer's own, from thirty days ago. */
export function demoMyBookings(): BookingView[] {
  const me = demoPortalCustomerId()
  const since = Date.now() - 30 * DAY
  return store()
    .bookings.filter((entry) => entry.customer === me && Date.parse(entry.starts_at) >= since)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .map((entry) => view(entry, { forCustomer: true }))
}

// ---------------------------------------------------------------------------
// Book (BK's `prepareCreate` and `writeCreate`)
// ---------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function entryProblem(event: DemoEvent, now: Date, byCustomer: boolean): ClientResponseError | null {
  const name = event.name
  if (event.status === "draft") return refusal(409, `${name} is not published yet. Publish it before taking entries.`)
  if (event.status === "cancelled") return refusal(409, `${name} is cancelled.`)
  if (event.status === "finished") return refusal(409, `${name} has finished.`)
  if (byCustomer && !event.online) return refusal(403, `${name} takes entries at the counter. Ring the shop to enter.`)
  if (byCustomer && Date.parse(event.starts_at) <= now.getTime()) return refusal(409, `${name} has already started.`)
  if (Date.parse(event.ends_at) <= now.getTime()) return refusal(409, `${name} has finished.`)
  return null
}

function fullRefusal(eventName: string, left: number, byCustomer: boolean): ClientResponseError {
  const wait = byCustomer ? "join the waitlist" : "add them to the waitlist"
  if (left <= 0) return refusal(409, `${eventName} is full. ${byCustomer ? "Join" : "Add them to"} the waitlist instead.`)
  return refusal(409, `${eventName} has ${left} ${left === 1 ? "place" : "places"} left. Make the party smaller or ${wait}.`)
}

/** Demo tiers that carry a free event entry a month (the seed's paid plan). */
function hasFreeEntry(customerId: string): boolean {
  const entry = DEMO_CUSTOMERS.find((row2) => row2.customer.id === customerId)
  return entry?.private.tier === "tier_pass" || entry?.private.tier === "tier_legend"
}

export function demoCreateBooking(input: NewBookingInput, actor: "staff" | "customer"): BookingView {
  const now = new Date()
  const byCustomer = actor === "customer"
  const party = Math.floor(Number(input.party_size ?? 1))
  if (!(party >= 1)) throw refusal(400, "A booking is for 1 person or more.")

  let customerId = ""
  if (byCustomer) {
    const me = demoPortalCustomerId()
    if (input.customer && input.customer !== me) throw refusal(403, "You can only book for yourself.")
    customerId = me
  } else if (input.customer) {
    if (!customerRecord(input.customer)) throw refusal(404, "That customer was not found. Search again.")
    customerId = input.customer
  }

  let name = ""
  let phone = ""
  let email = ""
  if (!customerId) {
    name = (input.name ?? "").trim().slice(0, 200)
    phone = (input.phone ?? "").trim()
    email = (input.email ?? "").trim().toLowerCase()
    if (!name) throw refusal(400, "Add a name for the booking, or pick the customer.")
    if (phone.length > 32) throw refusal(400, "That phone number is too long. Check it and try again.")
    if (email && !EMAIL.test(email)) throw refusal(400, "That email address does not look right. Check it and try again.")
  }
  const member = demoIsMember(customerId)
  const source = byCustomer ? "online" : input.source === "phone" ? "phone" : "till"
  const notes = byCustomer ? "" : (input.notes ?? "").trim().slice(0, 2000)

  if (input.resource && input.event) throw refusal(400, "Book a table, station or room, or enter an event, not both.")
  if (!input.resource && !input.event) throw refusal(400, "Pick a table, station or room, or an event.")

  const base = { customer: customerId, name, phone, email, party_size: party, source, notes, created: now.toISOString() } as const

  if (input.resource) {
    const res = findResource(input.resource)
    if (!res) throw refusal(404, "That table, station or room was not found. Reload the bookings.")
    if (byCustomer && (!res.online || !res.active)) throw refusal(403, `${res.name} cannot be booked online. Ring the shop to book it.`)
    const start = Date.parse(input.starts_at ?? "")
    const end = Date.parse(input.ends_at ?? "")
    if (Number.isNaN(start) || Number.isNaN(end)) throw refusal(400, "Send the start and end of the booking.")
    const window = { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() }
    if (byCustomer && start <= now.getTime()) throw refusal(400, "That time has passed. Pick a later slot.")
    if (res.capacity > 0 && party > res.capacity) {
      throw refusal(400, `${res.name} takes up to ${res.capacity}. Pick a bigger one or split the party.`)
    }
    const problem = placeProblem(res, window, now)
    if (problem) throw problem
    const priced = bookingPrice(res, window, member)
    const status: BookingStatus = byCustomer
      ? priced.price > 0
        ? "held"
        : "confirmed"
      : priced.deposit > 0
        ? "held"
        : "confirmed"
    const booking = row({
      id: nextId("booking"),
      ...base,
      kind: "resource",
      resource: res.id,
      ...window,
      status,
      price: priced.price,
      deposit: priced.deposit,
    })
    store().bookings.push(booking)
    return view(booking, { forCustomer: byCustomer })
  }

  const event = findEvent(input.event ?? "")
  if (!event || (byCustomer && event.status === "draft")) throw refusal(404, "That event was not found. Reload the events.")
  const problem = entryProblem(event, now, byCustomer)
  if (problem) throw problem
  if (customerId && eventEntries(event.id).some((entry) => entry.customer === customerId)) {
    const who = customerRecord(customerId)?.name ?? "They"
    throw refusal(409, byCustomer ? `You are already entered in ${event.name}.` : `${who} is already entered in ${event.name}.`)
  }
  let waiting = false
  const left = placesFor(event)
  if (left !== null && party > left) {
    if (!input.waitlist) throw fullRefusal(event.name, left, byCustomer)
    waiting = true
  }
  const fee = entryFee(fees(event), member)
  let price = fee * party
  if (!byCustomer && input.free_entry) {
    if (!customerId) throw refusal(400, "Pick the customer to use their free entry.")
    if (waiting) throw refusal(409, "Use a free entry once they have a place, not on the waitlist.")
    if (!hasFreeEntry(customerId)) throw refusal(409, "Their tier has no free event entries. Take the fee instead.")
    price = Math.max(0, price - fee)
  }
  const booking = row({
    id: nextId("entry"),
    ...base,
    kind: "event",
    event: event.id,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    status: waiting ? "held" : byCustomer && price > 0 ? "held" : "confirmed",
    price,
  })
  store().bookings.push(booking)
  return view(booking, { forCustomer: byCustomer })
}

// ---------------------------------------------------------------------------
// Move, cancel, no-show, check-in, check-out
// ---------------------------------------------------------------------------

function mustFind(id: string): DemoBooking {
  const booking = findBooking(id)
  if (!booking) throw refusal(404, "That booking was not found. Reload the bookings.")
  return booking
}

export function demoMoveBooking(id: string, input: MoveInput): BookingView {
  const booking = mustFind(id)
  if (booking.kind === "event") {
    throw refusal(400, "An event entry moves with its event. Cancel it and enter another event instead.")
  }
  if (!isOpen(booking)) throw statusRefusal(booking.status)
  const res = findResource(input.resource || booking.resource)
  if (!res) throw refusal(404, "That table, station or room was not found. Reload the bookings.")
  const start = Date.parse(input.starts_at)
  const end = Date.parse(input.ends_at)
  if (Number.isNaN(start) || Number.isNaN(end)) throw refusal(400, "Send the new start and end of the booking.")
  const window = { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() }
  if (res.capacity > 0 && booking.party_size > res.capacity) {
    throw refusal(400, `${res.name} takes up to ${res.capacity}. Pick a bigger one or split the party.`)
  }
  const problem = placeProblem(res, window, new Date(), booking.id)
  if (problem) throw problem
  const priced = bookingPrice(res, window, demoIsMember(booking.customer))
  if (priced.price < booking.paid) {
    throw refusal(
      409,
      `This booking has ${formatGBP(booking.paid)} paid, more than its new price of ${formatGBP(priced.price)}. Keep it as long, or refund it first.`
    )
  }
  booking.resource = res.id
  booking.starts_at = window.starts_at
  booking.ends_at = window.ends_at
  booking.price = priced.price
  booking.deposit = priced.deposit
  return view(booking)
}

/** BK's `refundsFor`: whole lines, newest first, back to the deposit when it is kept. */
function refundsFor(booking: DemoBooking, keepDeposit: boolean): { refunds: BookingCancelled["refunds"]; kept: number } {
  let due = keepDeposit ? Math.max(0, booking.paid - Math.min(booking.deposit, booking.paid)) : booking.paid
  const chosen: DemoPayment[] = []
  for (let i = booking.payments.length - 1; i >= 0 && due > 0; i--) {
    const payment = booking.payments[i]
    if (payment && payment.amount <= due) {
      chosen.unshift(payment)
      due -= payment.amount
    }
  }
  const bySale = new Map<string, BookingCancelled["refunds"][number]>()
  let back = 0
  for (const payment of chosen) {
    const entry = bySale.get(payment.sale.id) ?? { sale: payment.sale, lines: [], amount: 0 }
    entry.lines.push({ sale_line: payment.sale_line, qty: payment.units })
    entry.amount += payment.amount
    bySale.set(payment.sale.id, entry)
    back += payment.amount
  }
  return { refunds: [...bySale.values()], kept: Math.max(0, booking.paid - back) }
}

export function demoCancelBooking(id: string, keepDeposit: boolean, actor: "staff" | "customer"): BookingCancelled {
  const booking = findBooking(id)
  if (!booking || (actor === "customer" && booking.customer !== demoPortalCustomerId())) {
    throw refusal(404, "That booking was not found.")
  }
  if (!isOpen(booking)) throw statusRefusal(booking.status)
  let planned: { refunds: BookingCancelled["refunds"]; kept: number } = { refunds: [], kept: 0 }
  if (actor === "customer") {
    if (Date.parse(booking.starts_at) <= Date.now()) throw refusal(409, "This booking has started. Ring the shop to change it.")
    if (booking.paid > 0) {
      throw refusal(409, `This booking has ${formatGBP(booking.paid)} paid. Ring the shop to cancel it, so it can be refunded.`)
    }
  } else {
    planned = refundsFor(booking, keepDeposit)
  }
  booking.status = "cancelled"
  return { ...view(booking, { forCustomer: actor === "customer" }), refunds: planned.refunds, kept: planned.kept }
}

export function demoNoShow(id: string): BookingView {
  const booking = mustFind(id)
  if (!isOpen(booking)) throw statusRefusal(booking.status)
  if (Date.parse(booking.starts_at) > Date.now()) throw refusal(409, "This booking has not started yet. Cancel it instead.")
  booking.status = "no_show"
  return view(booking)
}

function checkInProblem(booking: DemoBooking, now: Date): ClientResponseError | null {
  if (booking.status === "checked_in") return refusal(409, "This booking is already checked in.")
  if (!isOpen(booking)) return statusRefusal(booking.status)
  if (shopDateOf(new Date(booking.starts_at)) > shopDateOf(now)) {
    return refusal(409, `This booking is for ${dayLabel(booking.starts_at)}. Check it in on the day.`)
  }
  if (booking.kind === "event") {
    const event = findEvent(booking.event)
    if (event && waitlistFor(event).includes(booking.id)) {
      return refusal(409, "That entry is on the waitlist. Check them in when a place frees.")
    }
  }
  return null
}

export function demoCheckIn(id: string): BookingView {
  const booking = mustFind(id)
  const now = new Date()
  const problem = checkInProblem(booking, now)
  if (problem) throw problem
  booking.status = "checked_in"
  booking.checked_in_at = now.toISOString()
  return view(booking)
}

/**
 * Check-out (BK's `checkOut`): a PC or console runs on the clock, the shared
 * `sessionCharge` from check-in to now, never less than it was booked for,
 * its end moved out to now when it ran over. Anything else keeps its price.
 */
export function demoCheckOut(id: string): BookingCheckedOut {
  const booking = mustFind(id)
  if (booking.status === "completed") throw refusal(409, "This booking has already checked out.")
  if (booking.status !== "checked_in") throw refusal(409, "This booking has not checked in.")
  const now = new Date()
  const checkedIn = booking.checked_in_at || booking.starts_at
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(checkedIn)) / MINUTE))
  let price = booking.price
  let slots = 0
  if (booking.kind === "resource") {
    const res = findResource(booking.resource)
    if (res && STATIONS.includes(res.kind)) {
      const charge = sessionCharge(res, checkedIn, now.toISOString(), demoIsMember(booking.customer))
      slots = charge.slots
      price = Math.max(price, charge.price)
      if (Date.parse(booking.ends_at) < now.getTime()) booking.ends_at = now.toISOString()
    } else if (res) {
      slots = bookingPrice(res, booking, false).slots
    }
  }
  booking.status = "completed"
  booking.checked_out_at = now.toISOString()
  booking.price = price
  const balance = Math.max(0, price - booking.paid)
  return { ...view(booking), charge: { minutes, slots, price, balance } }
}

/** `POST /api/vault/bookings/walk-in` (BK's `prepareWalkIn` and `writeWalkIn`). */
export function demoWalkIn(input: { resource: string; customer?: string; name?: string; party_size?: number }): BookingView {
  const now = new Date()
  const res = findResource(input.resource)
  if (!res) throw refusal(404, "That station was not found. Reload the bookings.")
  if (!STATIONS.includes(res.kind)) {
    throw refusal(400, "Walk-in sessions run on PC and console stations. Book a table or room instead.")
  }
  if (!res.active) throw refusal(409, `${res.name} is switched off. Pick another.`)
  if (input.customer && !customerRecord(input.customer)) throw refusal(404, "That customer was not found. Search again.")
  const party = Math.floor(Number(input.party_size ?? 1))
  if (!(party >= 1)) throw refusal(400, "A booking is for 1 person or more.")
  if (res.capacity > 0 && party > res.capacity) {
    throw refusal(400, `${res.name} takes up to ${res.capacity}. Pick a bigger one or split the party.`)
  }
  const window = {
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + res.slot_minutes * MINUTE).toISOString(),
  }
  const clash = clashProblem(res, window, busyFor(res, now))
  if (clash) throw refusal(409, clash)
  const booking = row({
    id: nextId("session"),
    resource: res.id,
    customer: input.customer ?? "",
    name: input.customer ? "" : (input.name ?? "").trim().slice(0, 200) || "Walk-in",
    ...window,
    party_size: party,
    status: "checked_in",
    checked_in_at: window.starts_at,
    created: now.toISOString(),
  })
  store().bookings.push(booking)
  return view(booking)
}

// ---------------------------------------------------------------------------
// Events: check-in by card, cancelling, and writes through the collection
// ---------------------------------------------------------------------------

/** BK's `customerFromScan`: the QR's portal link, the bare token, or the code as printed. */
function customerFromScan(raw: string) {
  const value = raw.trim()
  if (!value) return null
  const at = value.lastIndexOf("/c/")
  const token = at >= 0 ? (value.slice(at + 3).split(/[?#/]/)[0] ?? "") : value
  const byToken = DEMO_CUSTOMERS.find((entry) => entry.customer.qr_token === token)
  if (byToken) return byToken.customer
  const code = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
  if (!code) return null
  return DEMO_CUSTOMERS.find((entry) => entry.customer.code.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === code)?.customer ?? null
}

export function demoEventCheckIn(eventId: string, scanned: string): BookingView {
  const event = findEvent(eventId)
  if (!event) throw refusal(404, "That event was not found. Reload the events.")
  if (!scanned.trim()) throw refusal(400, "Scan the customer's Guild card or type their code.")
  const customer = customerFromScan(scanned)
  if (!customer) throw refusal(404, "That card was not found. Scan it again or type the code.")
  const entry = store()
    .bookings.filter(
      (row2) =>
        row2.kind === "event" &&
        row2.event === event.id &&
        row2.customer === customer.id &&
        (row2.status === "held" || row2.status === "confirmed" || row2.status === "checked_in")
    )
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))[0]
  if (!entry) throw refusal(404, `${customer.name} is not entered in ${event.name}. Add them as an entry first.`)
  const now = new Date()
  const problem = checkInProblem(entry, now)
  if (problem) throw problem
  entry.status = "checked_in"
  entry.checked_in_at = now.toISOString()
  return view(entry)
}

export function demoCancelEvent(id: string): EventCancelled {
  const event = findEvent(id)
  if (!event) throw refusal(404, "That event was not found. Reload the events.")
  if (event.status === "cancelled") throw refusal(409, `${event.name} is already cancelled.`)
  if (event.status === "finished") throw refusal(409, `${event.name} has finished.`)
  event.status = "cancelled"
  const entries = store().bookings.filter(
    (entry) => entry.kind === "event" && entry.event === id && BOOKING_ACTIVE_STATUSES.includes(entry.status)
  )
  let refunds: BookingCancelled["refunds"] = []
  for (const entry of entries) {
    refunds = refunds.concat(refundsFor(entry, false).refunds)
    entry.status = "cancelled"
  }
  return { event: eventView(event), cancelled: entries.length, refunds }
}

/** BK's `eventWriteProblem`: it ends after it starts, it is cancelled by its route, and published it lands on no booked table. */
function eventWriteProblem(event: DemoEvent, before: EventView["status"] | null): ClientResponseError | null {
  if (!(Date.parse(event.ends_at) > Date.parse(event.starts_at))) return refusal(400, "The event has to end after it starts.")
  if (event.status === "cancelled" && before !== "cancelled") {
    return refusal(400, "Cancel an event from Bookings, so its entries are cancelled and told.")
  }
  if (event.status !== "published") return null
  const now = new Date()
  for (const id of event.resources) {
    const res = findResource(id)
    if (!res) continue
    const clash = clashProblem(res, event, busyFor(res, now, "", event.id))
    if (clash) return refusal(409, clash)
  }
  return null
}

export function demoCreateEvent(input: EventInput): EventView {
  if (!input.name.trim()) throw refusal(400, "Give the event a name.")
  const event: DemoEvent = {
    id: nextId("event"),
    name: input.name.trim(),
    game: input.game,
    format: input.format.trim(),
    starts_at: new Date(Date.parse(input.starts_at)).toISOString(),
    ends_at: new Date(Date.parse(input.ends_at)).toISOString(),
    capacity: Math.max(0, Math.round(input.capacity)),
    entry_fee: Math.max(0, Math.round(input.entry_fee)),
    member_fee: Math.max(0, Math.round(input.member_fee ?? 0)),
    online: input.online,
    status: input.status,
    repeat_weekly: input.repeat_weekly,
    repeat_of: "",
    resources: [...input.resources],
    description: input.description.trim(),
    created: new Date().toISOString(),
  }
  const problem = eventWriteProblem(event, null)
  if (problem) throw problem
  store().events.push(event)
  return eventView(event)
}

export function demoUpdateEvent(id: string, patch: Partial<EventInput>): EventView {
  const event = findEvent(id)
  if (!event) throw refusal(404, "That event was not found. Reload the events.")
  const next: DemoEvent = {
    ...event,
    ...patch,
    member_fee: patch.member_fee === undefined ? event.member_fee : Math.max(0, patch.member_fee ?? 0),
    resources: patch.resources ? [...patch.resources] : event.resources,
  }
  const problem = eventWriteProblem(next, event.status)
  if (problem) throw problem
  const moved = next.starts_at !== event.starts_at || next.ends_at !== event.ends_at
  Object.assign(event, next)
  // Its live entries keep its times (BK's `followEvent`).
  if (moved) {
    for (const entry of store().bookings) {
      if (entry.kind === "event" && entry.event === id && isOpen(entry)) {
        entry.starts_at = event.starts_at
        entry.ends_at = event.ends_at
      }
    }
  }
  return eventView(event)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function demoSaveResource(id: string | null, input: ResourceInput): Resource {
  const { resources } = store()
  const name = input.name.trim()
  if (!name) throw refusal(400, "Give it a name, such as Table 5.")
  const taken = resources.find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.id !== id)
  if (taken) throw refusal(400, `There is already one called ${taken.name}. Use another name.`)
  const problem = hoursProblem(input.hours)
  if (problem) throw refusal(400, problem)
  const existing = id ? resources.find((entry) => entry.id === id) : undefined
  if (id && !existing) throw refusal(404, "That resource is not there any more. Reload the list.")
  const slot = Math.round(input.slot_minutes)
  const next: Resource = {
    id: existing?.id ?? nextId("res"),
    name,
    kind: input.kind,
    capacity: Math.max(0, Math.round(input.capacity)),
    slot_minutes: slot >= 5 ? slot : 60,
    price: Math.max(0, Math.round(input.price)),
    member_price: input.member_price && input.member_price > 0 ? input.member_price : null,
    deposit: input.deposit && input.deposit > 0 ? input.deposit : null,
    online: input.online,
    hours: input.hours && Object.keys(input.hours).length > 0 ? input.hours : null,
    active: input.active,
    sort: input.sort,
    image: input.image === null ? "" : input.image ? URL.createObjectURL(input.image) : (existing?.image ?? ""),
    note: input.note.trim(),
  }
  if (existing) Object.assign(existing, next)
  else resources.push(next)
  return copy(next)
}

export function demoShopHours(): { id: string; hours: OpeningHours } {
  return { id: "settings_demo", hours: copy(store().hours) }
}

export function demoSaveShopHours(hours: OpeningHours): OpeningHours {
  const problem = hoursProblem(hours)
  if (problem) throw refusal(400, problem)
  store().hours = copy(hours)
  return copy(hours)
}

// ---------------------------------------------------------------------------
// The till: a booking line on a sale (BK's `saleLine` and `settle`)
// ---------------------------------------------------------------------------

export interface DemoBookingLineInput {
  booking: string
  qty?: number
  unit_price?: number
  title?: string
}

/**
 * A booking line before anything is written: the booking is there, live and
 * not waiting for a place, and the amount (the price sent, else what is
 * left) is no more than is left once the ticket's earlier lines for the same
 * booking are counted. One unit.
 */
export function demoPlanBookingLine(
  line: DemoBookingLineInput,
  index: number,
  earlier: readonly DemoBookingLineInput[]
): { title: string; amount: number } {
  const n = index + 1
  const booking = findBooking(line.booking)
  if (!booking) throw refusal(404, `Line ${n} is a booking that was not found. Reload the bookings.`)
  const name = label(booking)
  if (booking.status === "cancelled") throw refusal(409, `${name} is cancelled. Take it off the ticket.`)
  if (booking.status === "no_show") throw refusal(409, `${name} was a no-show. Take it off the ticket.`)
  if (booking.kind === "event" && booking.status === "held") {
    const event = findEvent(booking.event)
    if (event && waitlistFor(event).includes(booking.id)) {
      throw refusal(409, `${name} is on the waitlist. Take payment when a place frees.`)
    }
  }
  if ((line.qty ?? 1) > 1) throw refusal(400, "A booking goes on the ticket once. Key the amount instead.")
  const onTicket = earlier
    .filter((other) => other.booking === booking.id)
    .reduce((sum, other) => sum + (other.unit_price ?? 0), 0)
  const left = Math.max(0, booking.price - booking.paid - onTicket)
  if (left <= 0) throw refusal(409, `${name} is paid in full. Take it off the ticket.`)
  const amount = line.unit_price === undefined ? left : Math.round(line.unit_price)
  if (amount < 1) throw refusal(400, `Key an amount for ${name}.`)
  if (amount > left) throw refusal(409, `${name} has ${formatGBP(left)} left to pay. Change the amount.`)
  return { title: (line.title?.trim() || name).slice(0, 300), amount }
}

/** Inside the sale: `paid` moves by the line, a held booking is confirmed, and the line is remembered for a refund. */
export function demoSettleBookingLine(
  bookingId: string,
  amount: number,
  paidBy: { sale: { id: string; number: string }; saleLine: string }
): void {
  const booking = findBooking(bookingId)
  if (!booking) return
  booking.paid += amount
  booking.payments.push({ sale: paidBy.sale, sale_line: paidBy.saleLine, amount, units: 1 })
  if (booking.status === "held") booking.status = "confirmed"
}

/** A refunded booking line comes off `paid` again (BK's `unpay`). */
export function demoUnpayBookingLine(bookingId: string, saleLine: string): void {
  const booking = findBooking(bookingId)
  if (!booking) return
  const payment = booking.payments.find((entry) => entry.sale_line === saleLine)
  if (!payment) return
  booking.paid = Math.max(0, booking.paid - payment.amount)
  booking.payments = booking.payments.filter((entry) => entry !== payment)
}
