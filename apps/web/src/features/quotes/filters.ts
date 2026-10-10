/**
 * The chips over the quote queue, and what they leave on screen.
 *
 * Pure, and in its own file, so the rule can be unit tested and so the
 * screen beside it exports nothing but a component. The same grammar as the
 * buy-in list's own filters: no chip pressed means everything, and several
 * are an "or", never an "and".
 */
import type { QuoteStatus } from "@/lib/api/types"

export type QuoteFilter = "waiting" | "offered" | "accepted" | "closed"

export const QUOTE_FILTERS: { value: QuoteFilter; label: string }[] = [
  { value: "waiting", label: "Waiting" },
  { value: "offered", label: "Offered" },
  { value: "accepted", label: "Accepted" },
  { value: "closed", label: "Closed" },
]

/**
 * Which statuses each chip covers.
 *
 * "Waiting" is the pair that is waiting on us to do something, which is the
 * same rule the nav count and Home's waiting line use (`QUOTES_WAITING` in
 * lib/api/quotes.ts). A received quote is on a draft buy-in now, so it sits
 * under "Closed" with the rest of the ones that need nothing from the queue.
 */
const STATUSES: Record<QuoteFilter, QuoteStatus[]> = {
  waiting: ["submitted", "reviewing"],
  offered: ["offered"],
  accepted: ["accepted"],
  closed: ["declined", "expired", "received", "completed"],
}

export function statusesFor(filter: QuoteFilter): QuoteStatus[] {
  return STATUSES[filter]
}

/**
 * The statuses the pressed chips stand for, as one list for the server.
 *
 * No chip pressed is an empty list, which the queue reads as "everything".
 * Several chips are an or, never an and, the same grammar the buy-in list's
 * own filters use.
 */
export function statusesForFilters(active: QuoteFilter[]): QuoteStatus[] {
  const wanted = new Set<QuoteStatus>(active.flatMap(statusesFor))
  return [...wanted]
}

/** True while an offer can still be made on this quote. */
export function canOffer(status: QuoteStatus): boolean {
  return status === "submitted" || status === "reviewing"
}

/** True while the quote can still be cancelled, as the route reads it. */
export function canCancel(status: QuoteStatus): boolean {
  return !["declined", "expired", "completed", "received"].includes(status)
}

/**
 * True once an ISO time has gone by.
 *
 * Read at the call site rather than in a component, so a screen never calls
 * `Date.now()` while it renders: both crons here (the hourly one that
 * expires an offer and the quarter-hourly one that releases a hold) can be
 * up to their own interval behind, so the screen works it out itself and
 * says so in words.
 */
export function hasPassed(
  iso: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!iso) return false
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return false
  return at.getTime() <= now.getTime()
}

/** True when an offer has run out, which the record says before the cron does. */
export function offerHasExpired(
  expiresAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  return hasPassed(expiresAt, now)
}

/** True when a hold has run out, whatever the item's status still says. */
export function holdHasEnded(
  reservedUntil: string | null | undefined,
  now: Date = new Date()
): boolean {
  return hasPassed(reservedUntil, now)
}

/**
 * Whether the message the quote came with still needs showing.
 *
 * `POST /api/vault/quotes` stores it on the record and does not put it in
 * the thread, so the counter shows it above the thread. A client that also
 * opened the thread with it (the demo shop does) would otherwise say the
 * same thing twice.
 */
export function showsQuoteMessage(
  message: string | undefined,
  messages: { author: "customer" | "staff"; body: string }[]
): boolean {
  const clean = message?.trim()
  if (!clean) return false
  const opening = messages[0]
  if (!opening || opening.author !== "customer") return true
  return opening.body.trim() !== clean
}
