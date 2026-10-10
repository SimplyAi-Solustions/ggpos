/**
 * Bookings (docs/api-contract-launch.md, section 4): tables, PC and console
 * stations, rooms, events and their entries, and the walk-in sessions on the
 * stations, for the counter, the till, My Vault and Settings.
 *
 * Every booking read and write goes through BK's routes (pb/pb_hooks/
 * bookings.pb.js), which answer the shared `BookingView`, `EventView` and
 * `StationView` (packages/shared/src/bookings.ts):
 *
 *   GET  /api/vault/bookings/availability?date=&kind=&party=   (staff)
 *   GET  /api/vault/bookings?from=&to=&event=                  (staff)
 *   POST /api/vault/bookings                                    (staff, or a customer)
 *   GET  /api/vault/bookings/stations                           (staff)
 *   POST /api/vault/bookings/walk-in                            (staff)
 *   POST /api/vault/bookings/{id}/move | cancel | no-show | check-in | check-out
 *   GET  /api/vault/events?from=&to=, /events/{id}              (staff)
 *   POST /api/vault/events/{id}/check-in | cancel               (staff)
 *   GET  /api/vault/me/bookings                                 (customer)
 *   GET  /api/public/availability, /api/public/events           (anyone)
 *
 * Resources, events and the shop's hours are written straight to their
 * collections, as a manager or an admin may; BK's record hooks check them.
 * A staff write goes through `withOverride`, so a role without
 * `bookings_manage` asks a manager there and then. Demo mode answers every
 * one of these from memory (`lib/api/demo/bookings.ts`).
 *
 * Not re-exported from `lib/api/index.ts`: that barrel travels in the entry
 * chunk, and this belongs to the bookings, till and portal routes.
 */
import type {
  Availability,
  BookableResource,
  BookingCancelled,
  BookingCheckedOut,
  BookingView,
  EventView,
  OpeningHours,
  ResourceKind,
  StationView,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { withOverride } from "@/features/lock/override"
import * as demo from "@/lib/api/demo/bookings"

export type { BookingCancelled, BookingCheckedOut, EventView, StationView }

/** One booking or event entry, as the booking routes answer it. */
export type Booking = BookingView

/** A resource as Settings and the day view hold it. A capacity of 0 has no limit. */
export interface Resource extends BookableResource {
  /** The picture's address, or "". */
  image: string
  note: string
}

/** `POST /api/vault/bookings`: a resource by the slot, or an entry to an event. */
export interface NewBookingInput {
  resource?: string
  event?: string
  starts_at?: string
  ends_at?: string
  party_size: number
  customer?: string | null
  name?: string
  phone?: string
  email?: string
  source?: "till" | "phone"
  notes?: string
  /** An event entry past the places left waits for one. */
  waitlist?: boolean
  /** Staff: one of the customer's tier's free event entries. */
  free_entry?: boolean
}

export interface MoveInput {
  starts_at: string
  ends_at: string
  resource?: string
}

export interface ResourceInput {
  name: string
  kind: ResourceKind
  /** 0 for no limit. */
  capacity: number
  slot_minutes: number
  price: number
  member_price: number | null
  deposit: number | null
  online: boolean
  hours: OpeningHours | null
  active: boolean
  sort: number
  note: string
  /** A new picture, null to take it off, undefined to leave it. */
  image?: File | null
}

export interface EventInput {
  name: string
  game: string
  format: string
  starts_at: string
  ends_at: string
  /** 0 for no limit. */
  capacity: number
  entry_fee: number
  member_fee: number | null
  online: boolean
  repeat_weekly: boolean
  resources: string[]
  description: string
  status: EventView["status"]
}

/** `POST /api/vault/events/{id}/cancel`. */
export interface EventCancelled {
  event: EventView
  cancelled: number
  refunds: BookingCancelled["refunds"]
}

// ---------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------

/** PocketBase writes "2026-10-16 17:00:00.000Z"; everything here reads ISO. */
function isoFrom(value: string | null | undefined): string {
  if (!value) return ""
  const parsed = Date.parse(value.replace(" ", "T"))
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString()
}

function int(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback
}

/** A number PocketBase has never been given reads 0: none, for a member price, a deposit or a fee. */
function maybe(value: unknown): number | null {
  const n = int(value)
  return n > 0 ? n : null
}

interface ResourceRecord {
  id: string
  name: string
  kind: ResourceKind
  capacity?: number
  slot_minutes?: number
  price?: number
  member_price?: number
  deposit?: number
  online?: boolean
  hours?: unknown
  active?: boolean
  sort?: number
  image?: string
  note?: string
  collectionId?: string
  collectionName?: string
}

function hoursFrom(value: unknown): OpeningHours | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return Object.keys(value).length > 0 ? (value as OpeningHours) : null
}

/** The same reading as BK's `resourceShape`: 0 is none, a slot under 5 minutes the default hour. */
function toResource(row: ResourceRecord): Resource {
  const slot = int(row.slot_minutes)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    capacity: Math.max(0, int(row.capacity)),
    slot_minutes: slot >= 5 ? slot : 60,
    price: Math.max(0, int(row.price)),
    member_price: maybe(row.member_price),
    deposit: maybe(row.deposit),
    online: Boolean(row.online),
    hours: hoursFrom(row.hours),
    active: Boolean(row.active),
    sort: int(row.sort),
    image: row.image ? pb.files.getURL(row as never, row.image) : "",
    note: row.note ?? "",
  }
}

interface EventRecord {
  id: string
  name: string
  format?: string
  starts_at: string
  ends_at: string
  capacity?: number
  entry_fee?: number
  member_fee?: number
  online?: boolean
  status?: string
  repeat_weekly?: boolean
  repeat_of?: string
  description?: string
  expand?: {
    game?: { id: string; name?: string }
    resources?: { id: string; name?: string; kind?: ResourceKind }[]
  }
}

/**
 * An event written through the collection API, in `EventView`'s shape. It is
 * new, so nobody has entered it yet; the next read of the events route says
 * the rest.
 */
function eventFromRecord(row: EventRecord): EventView {
  const capacity = Math.max(0, int(row.capacity))
  return {
    id: row.id,
    name: row.name,
    game: row.expand?.game ? { id: row.expand.game.id, name: row.expand.game.name ?? "" } : null,
    format: row.format ?? "",
    starts_at: isoFrom(row.starts_at),
    ends_at: isoFrom(row.ends_at),
    capacity,
    places_left: capacity > 0 ? capacity : null,
    entry_fee: Math.max(0, int(row.entry_fee)),
    member_fee: maybe(row.member_fee),
    online: Boolean(row.online),
    status: (row.status as EventView["status"]) || "draft",
    repeat_weekly: Boolean(row.repeat_weekly),
    repeat_of: row.repeat_of || null,
    resources: (row.expand?.resources ?? []).map((res) => ({ id: res.id, name: res.name ?? "", kind: res.kind ?? "table" })),
    description: row.description ?? "",
    entered: 0,
    waitlist: 0,
  }
}

/** A staff write: through a manager's approval when the role lacks `bookings_manage`. */
function staffPost<T>(path: string, body: unknown, describe: string): Promise<T> {
  return withOverride(
    (headers) => pb.send<T>(path, { method: "POST", body: body ?? {}, headers }),
    { describe: () => describe }
  )
}

function bookingPath(id: string, action: string): string {
  return `/api/vault/bookings/${encodeURIComponent(id)}/${action}`
}

function eventPath(id: string, action?: string): string {
  return `/api/vault/events/${encodeURIComponent(id)}${action ? `/${action}` : ""}`
}

// ---------------------------------------------------------------------------
// The counter: resources, availability, bookings and stations
// ---------------------------------------------------------------------------

/** Every resource, switched off ones too, in the order the day view shows them. */
export async function listResources(): Promise<Resource[]> {
  if (isDemo()) return demo.demoResources()
  const rows = await pb.collection("resources").getFullList<ResourceRecord>({ sort: "sort,name" })
  return rows.map(toResource)
}

/** Free and taken slots per resource on a shop-time date ("2026-10-16"). Staff see the whole day. */
export async function getAvailability(
  date: string,
  options: { kind?: ResourceKind; party?: number } = {}
): Promise<Availability> {
  if (isDemo()) return demo.demoAvailability(date, { ...options, audience: "staff" })
  return pb.send<Availability>("/api/vault/bookings/availability", {
    method: "GET",
    query: {
      date,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.party ? { party: options.party } : {}),
    },
  })
}

/** Bookings and entries starting on the shop days `from` to `to` (six weeks at most), cancelled ones included. */
export async function listBookings(from: string, to: string = from): Promise<Booking[]> {
  if (isDemo()) return demo.demoListBookings(from, to)
  const result = await pb.send<{ bookings?: Booking[] }>("/api/vault/bookings", {
    method: "GET",
    query: { from, to },
  })
  return result.bookings ?? []
}

/** Every PC and console, its running session and its next booking today. */
export async function listStations(): Promise<StationView[]> {
  if (isDemo()) return demo.demoStations()
  const result = await pb.send<{ stations?: StationView[] }>("/api/vault/bookings/stations", { method: "GET" })
  return result.stations ?? []
}

/** Whether a customer is in the Guild, for the member price. */
export async function customerIsMember(customerId: string): Promise<boolean> {
  if (isDemo()) return demo.demoIsMember(customerId)
  const row = await pb
    .collection("customers")
    .getOne<{ guild_joined_at?: string }>(customerId, { fields: "id,guild_joined_at" })
  return Boolean(row.guild_joined_at)
}

export async function createBooking(input: NewBookingInput): Promise<Booking> {
  if (isDemo()) return demo.demoCreateBooking(input, "staff")
  return staffPost<Booking>("/api/vault/bookings", input, "Make a booking")
}

export async function moveBooking(id: string, input: MoveInput): Promise<Booking> {
  if (isDemo()) return demo.demoMoveBooking(id, input)
  return staffPost<Booking>(bookingPath(id, "move"), input, "Move a booking")
}

/** Cancels; answers the sale lines to refund through the till's refund flow and what is kept. */
export async function cancelBooking(id: string, keepDeposit: boolean): Promise<BookingCancelled> {
  if (isDemo()) return demo.demoCancelBooking(id, keepDeposit, "staff")
  return staffPost<BookingCancelled>(bookingPath(id, "cancel"), { keep_deposit: keepDeposit }, "Cancel a booking")
}

export async function markNoShow(id: string): Promise<Booking> {
  if (isDemo()) return demo.demoNoShow(id)
  return staffPost<Booking>(bookingPath(id, "no-show"), {}, "Mark a no-show")
}

export async function checkIn(id: string): Promise<Booking> {
  if (isDemo()) return demo.demoCheckIn(id)
  return staffPost<Booking>(bookingPath(id, "check-in"), {}, "Check a booking in")
}

/** Checks out; `charge.balance` is what the till takes as a booking line. */
export async function checkOut(id: string): Promise<BookingCheckedOut> {
  if (isDemo()) return demo.demoCheckOut(id)
  return staffPost<BookingCheckedOut>(bookingPath(id, "check-out"), {}, "Check a booking out")
}

/** A walk-in session on a PC or console: the clock starts now. */
export async function startSession(
  resource: string,
  who: { customer?: string | null; name?: string } = {}
): Promise<Booking> {
  const body = {
    resource,
    ...(who.customer ? { customer: who.customer } : {}),
    ...(who.name?.trim() ? { name: who.name.trim() } : {}),
  }
  if (isDemo()) return demo.demoWalkIn(body)
  return staffPost<Booking>("/api/vault/bookings/walk-in", body, "Start a session")
}

// ---------------------------------------------------------------------------
// Events and their entries
// ---------------------------------------------------------------------------

/** Events on the shop days `from` to `to` (sixty days on when `to` is left out), soonest first. */
export async function listEvents(from: string, to?: string): Promise<EventView[]> {
  if (isDemo()) return demo.demoListEvents(from, to)
  const result = await pb.send<{ events?: EventView[] }>("/api/vault/events", {
    method: "GET",
    query: { from, ...(to ? { to } : {}) },
  })
  return result.events ?? []
}

/** One event and every entry it has had, first come first. */
export async function getEvent(id: string): Promise<{ event: EventView; entries: Booking[] }> {
  if (isDemo()) return demo.demoGetEvent(id)
  return pb.send<{ event: EventView; entries: Booking[] }>(eventPath(id), { method: "GET" })
}

/** Checks in the entry of the customer whose Guild card was scanned (its QR, link, token or code). */
export async function checkInByCard(eventId: string, scanned: string): Promise<Booking> {
  if (isDemo()) return demo.demoEventCheckIn(eventId, scanned)
  return staffPost<Booking>(eventPath(eventId, "check-in"), { qr: scanned.trim() }, "Check an entry in")
}

/** Cancels an event and every live entry; a manager or an admin. */
export async function cancelEvent(id: string): Promise<EventCancelled> {
  if (isDemo()) return demo.demoCancelEvent(id)
  return pb.send<EventCancelled>(eventPath(id, "cancel"), { method: "POST", body: {} })
}

function eventBody(input: Partial<EventInput>) {
  const body: Record<string, unknown> = { ...input }
  if (input.name !== undefined) body.name = input.name.trim()
  if (input.format !== undefined) body.format = input.format.trim()
  if (input.description !== undefined) body.description = input.description.trim()
  // A fee or a limit of 0 means none: that is how an empty one is stored.
  if (input.member_fee !== undefined) body.member_fee = input.member_fee ?? 0
  return body
}

export async function createEvent(input: EventInput): Promise<EventView> {
  if (isDemo()) return demo.demoCreateEvent(input)
  const row = await pb
    .collection("booking_events")
    .create<EventRecord>(eventBody(input), { expand: "game,resources" })
  return eventFromRecord(row)
}

export async function updateEvent(id: string, patch: Partial<EventInput>): Promise<EventView> {
  if (isDemo()) return demo.demoUpdateEvent(id, patch)
  const row = await pb
    .collection("booking_events")
    .update<EventRecord>(id, eventBody(patch), { expand: "game,resources" })
  return eventFromRecord(row)
}

// ---------------------------------------------------------------------------
// Settings: resources and the shop's hours
// ---------------------------------------------------------------------------

export async function saveResource(id: string | null, input: ResourceInput): Promise<Resource> {
  if (isDemo()) return demo.demoSaveResource(id, input)
  const body = new FormData()
  body.set("name", input.name.trim())
  body.set("kind", input.kind)
  body.set("capacity", String(input.capacity))
  body.set("slot_minutes", String(input.slot_minutes))
  body.set("price", String(input.price))
  // 0 is none for a member price and a deposit (BK's `resourceShape`).
  body.set("member_price", String(input.member_price ?? 0))
  body.set("deposit", String(input.deposit ?? 0))
  body.set("online", String(input.online))
  body.set("hours", input.hours ? JSON.stringify(input.hours) : "null")
  body.set("active", String(input.active))
  body.set("sort", String(input.sort))
  body.set("note", input.note.trim())
  if (input.image) body.set("image", input.image)
  else if (input.image === null) body.set("image", "")
  const row = id
    ? await pb.collection("resources").update<ResourceRecord>(id, body)
    : await pb.collection("resources").create<ResourceRecord>(body)
  return toResource(row)
}

/** The shop's own opening hours (`settings.opening_hours`). Admin only. */
export async function getShopHours(): Promise<{ id: string; hours: OpeningHours }> {
  if (isDemo()) return demo.demoShopHours()
  const row = await pb
    .collection("settings")
    .getFirstListItem<{ id: string; opening_hours?: unknown }>("", { fields: "id,opening_hours" })
  return { id: row.id, hours: hoursFrom(row.opening_hours) ?? {} }
}

export async function saveShopHours(id: string, hours: OpeningHours): Promise<OpeningHours> {
  if (isDemo()) return demo.demoSaveShopHours(hours)
  const row = await pb
    .collection("settings")
    .update<{ opening_hours?: unknown }>(id, { opening_hours: hours }, { fields: "id,opening_hours" })
  return hoursFrom(row.opening_hours) ?? {}
}

// ---------------------------------------------------------------------------
// My Vault
// ---------------------------------------------------------------------------

/** Free slots on the online resources, for anybody; a slot that has started is not free. */
export async function getPublicAvailability(
  date: string,
  options: { kind?: ResourceKind; party?: number } = {}
): Promise<Availability> {
  if (isDemo()) return demo.demoAvailability(date, { ...options, audience: "public" })
  return pbCustomer.send<Availability>("/api/public/availability", {
    method: "GET",
    // The public routes say a minute of caching for the website; My Vault
    // reads this again straight after a booking and must see it taken.
    cache: "no-store",
    query: {
      date,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.party ? { party: options.party } : {}),
    },
  })
}

/** The published events My Vault can enter, from the shop day `from` for sixty days. */
export async function listPublicEvents(from: string): Promise<EventView[]> {
  if (isDemo()) return demo.demoPublicEvents(from)
  const result = await pbCustomer.send<{ events?: EventView[] }>("/api/public/events", {
    method: "GET",
    // Places left must be current straight after an entry (see above).
    cache: "no-store",
    query: { from },
  })
  return result.events ?? []
}

/** A slot or an event entry, booked by the signed-in customer for themselves, held for the till. */
export async function bookOnline(input: NewBookingInput): Promise<Booking> {
  if (isDemo()) return demo.demoCreateBooking(input, "customer")
  return pbCustomer.send<Booking>("/api/vault/bookings", { method: "POST", body: input })
}

/** The signed-in customer's own bookings and entries, from thirty days ago on. */
export async function listMyBookings(): Promise<Booking[]> {
  if (isDemo()) return demo.demoMyBookings()
  const result = await pbCustomer.send<{ bookings?: Booking[] }>("/api/vault/me/bookings", { method: "GET" })
  return result.bookings ?? []
}

/** Their own booking that has not started and has nothing paid. */
export async function cancelMyBooking(id: string): Promise<BookingCancelled> {
  if (isDemo()) return demo.demoCancelBooking(id, true, "customer")
  return pbCustomer.send<BookingCancelled>(bookingPath(id, "cancel"), { method: "POST", body: {} })
}

/**
 * Whether the signed-in customer is in the Guild, for the prices My Vault
 * shows before anything is booked. Read from `/me` when the server says so
 * there (`customer.guild_joined_at`, section 2's join); a booking comes back
 * priced by the server either way.
 */
export function memberFromMe(me: { customer: object } | undefined): boolean {
  if (isDemo()) return demo.demoIsMember(demo.demoPortalCustomer())
  const joined = (me?.customer as { guild_joined_at?: string | null } | undefined)?.guild_joined_at
  return Boolean(joined)
}
