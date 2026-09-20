/**
 * The want list: cards a customer is after, and the holds the shop puts on
 * an item when one comes in.
 *
 * All three calls are the Phase 5 routes. `GET /api/vault/want-list` sends
 * each row with its card already expanded and, on a matched row, the hold
 * as `{ until, price, title }`, so the screen never has to expand
 * `matched_item` itself or guess what is being held.
 *
 * The counter's own reads of the holds themselves are in their own section
 * at the foot of this file.
 */
import { pb as pbStaff } from "@/lib/pb"
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { escapeFilter } from "@/lib/api/filter"
import {
  demoAddWant,
  demoCloseWant,
  demoHoldsEndingToday,
  demoListWants,
} from "@/lib/api/demo/portal"
import type {
  NewWantInput,
  WantHold,
  WantListRow,
  WantListStatus,
} from "@/lib/api/types"

/** One row as the route sends it. */
interface WantRowWire {
  id: string
  card?: { id: string; name: string; set: string; number: string } | null
  free_text?: string
  max_price?: number
  status?: WantListStatus
  hold?: { until: string; price: number; title: string } | null
  matched_item?: string
  notified_at?: string
  created?: string
  image?: string
}

function toHold(wire: WantRowWire["hold"]): WantHold | null {
  if (!wire || !wire.until) return null
  return { until: wire.until, price: wire.price ?? 0, title: wire.title ?? "" }
}

export function toWantRow(wire: WantRowWire): WantListRow {
  const card = wire.card ?? null
  return {
    id: wire.id,
    title: card?.name ?? wire.free_text ?? "Card",
    subtitle: card
      ? [card.set, card.number].filter(Boolean).join(" - ")
      : "Typed in by you",
    image: wire.image,
    maxPrice: wire.max_price ? wire.max_price : null,
    status: wire.status ?? "open",
    hold: toHold(wire.hold),
    created: wire.created ?? "",
  }
}

/**
 * Both the list and the two writes are read through this: the routes send
 * `{ rows }`, `{ row }` and (in an earlier draft) `{ want }`, so the reader
 * takes whichever is there rather than breaking on a wrapper name.
 */
function rowsFrom(result: unknown): WantRowWire[] {
  if (Array.isArray(result)) return result as WantRowWire[]
  const body = (result ?? {}) as Record<string, unknown>
  for (const key of ["rows", "items", "want_list", "wants"]) {
    const value = body[key]
    if (Array.isArray(value)) return value as WantRowWire[]
  }
  return []
}

function rowFrom(result: unknown): WantRowWire | null {
  const body = (result ?? {}) as Record<string, unknown>
  for (const key of ["row", "want", "want_list"]) {
    const value = body[key]
    if (value && typeof value === "object") return value as WantRowWire
  }
  // A bare record, with no wrapper at all.
  return typeof body.id === "string" ? (body as unknown as WantRowWire) : null
}

export async function listMyWants(): Promise<WantListRow[]> {
  if (isDemo()) return demoListWants()
  const result = await pbCustomer.send("/api/vault/want-list", { method: "GET" })
  return rowsFrom(result)
    .filter((row) => row.status !== "closed")
    .map(toWantRow)
}

export async function addWant(
  input: NewWantInput,
  display: { title: string; subtitle: string }
): Promise<WantListRow> {
  if (isDemo()) return demoAddWant(input, display.title, display.subtitle)

  const body: Record<string, unknown> = {}
  if (input.cardId) body.card = input.cardId
  if (input.freeText) body.free_text = input.freeText
  if (input.maxPrice !== null) body.max_price = input.maxPrice

  const result = await pbCustomer.send("/api/vault/want-list", {
    method: "POST",
    body,
  })
  const wire = rowFrom(result)
  if (!wire) throw new Error("That row could not be read back. Reload and check the list.")
  const row = toWantRow(wire)
  // The route expands the card, so its own title wins; the screen's is only
  // a fallback for a free-text row it already knows the words for.
  return {
    ...row,
    title: row.title || display.title,
    subtitle: row.subtitle || display.subtitle,
  }
}

export async function closeWant(id: string): Promise<void> {
  if (isDemo()) {
    demoCloseWant(id)
    return
  }
  await pbCustomer.send(`/api/vault/want-list/${id}/close`, { method: "POST" })
}

// ---------------------------------------------------------------------------
// The counter's own calls
//
// A hold is an `items` row, not a want-list row: the match hook reserves the
// item, and `holds_release` puts it back. So the counter reads the items,
// which covers a hold a staff member put on by hand as well as one a want
// list made, and goes through `pb`, the counter's own client.
// ---------------------------------------------------------------------------

/**
 * A moment as PocketBase writes its own timestamps.
 *
 * `items.reserved_until` is stored as "2026-09-20 17:00:00.000Z", with a
 * space where an ISO string has its T. Comparing an ISO string against it
 * only ever compares the date half, so a filter written that way silently
 * ignores the time of day. `lib/api/sales.ts` has said this for a while;
 * this is the same rule in the same words.
 */
function pbMoment(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19)
}

/** Midnight this morning and a minute to midnight tonight, local time. */
export function dayBounds(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)
  return { from, to }
}

/**
 * The filter behind "holds ending today", exported so the string itself can
 * be read in a test rather than only through a server.
 *
 * Bounded at both ends: without the lower bound a hold that lapsed last
 * week still counts as ending today, and the release cron only runs every
 * fifteen minutes, so there are always a few of those about. `!= ""` is not
 * needed beside them, since an empty value is below any timestamp.
 */
export function holdsFilter(now: Date = new Date()): string {
  const { from, to } = dayBounds(now)
  return [
    'status = "reserved"',
    `reserved_until >= "${escapeFilter(pbMoment(from))}"`,
    `reserved_until <= "${escapeFilter(pbMoment(to))}"`,
  ].join(" && ")
}

/** The count alone, for Home's waiting line. */
export async function countHoldsEndingToday(
  now: Date = new Date()
): Promise<number> {
  if (isDemo()) return demoHoldsEndingToday(now).length
  const page = await pbStaff.collection("items").getList(1, 1, {
    filter: holdsFilter(now),
    fields: "id",
  })
  return page.totalItems
}
