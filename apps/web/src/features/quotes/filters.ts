/**
 * The chips over the quote queue, and what they leave on screen.
 *
 * Pure, and in its own file, so the rule can be unit tested and so the
 * screen beside it exports nothing but a component. The same grammar as the
 * buy-in list's own filters: no chip pressed means everything, and several
 * are an "or", never an "and".
 */
import type { QuoteQueueRow, QuoteStatus } from "@/lib/api/types"

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

export function applyQuoteFilters(
  rows: QuoteQueueRow[],
  active: QuoteFilter[]
): QuoteQueueRow[] {
  if (active.length === 0) return rows
  const wanted = new Set<QuoteStatus>(active.flatMap(statusesFor))
  return rows.filter((row) => wanted.has(row.status))
}

/** True while an offer can still be made on this quote. */
export function canOffer(status: QuoteStatus): boolean {
  return status === "submitted" || status === "reviewing"
}

/** True while the quote can still be cancelled, as the route reads it. */
export function canCancel(status: QuoteStatus): boolean {
  return !["declined", "expired", "completed", "received"].includes(status)
}

/** True when an offer has run out, which the record says before the cron does. */
export function offerHasExpired(
  expiresAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!expiresAt) return false
  const at = new Date(expiresAt)
  if (Number.isNaN(at.getTime())) return false
  return at.getTime() <= now.getTime()
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
