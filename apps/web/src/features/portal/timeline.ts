import type { QuoteRecord, QuoteStatus } from "@/lib/api/types"

/**
 * A quote's status, drawn as a timeline rather than a badge.
 *
 * The customer wants to know two things: how far along this is, and whether
 * anything is waiting on them. One pure function answers both, so the detail
 * screen, the list row and the unit tests all agree, and so a status the
 * server invents later shows as an unknown step rather than an empty screen.
 */

export type StepState = "done" | "current" | "upcoming" | "stopped"

export interface TimelineStep {
  key: string
  label: string
  state: StepState
  /** One sentence under the current step, or null. */
  detail: string | null
}

/** The happy path, in order. */
const PATH: { key: QuoteStatus; label: string }[] = [
  { key: "submitted", label: "Sent" },
  { key: "reviewing", label: "Being looked at" },
  { key: "offered", label: "Offer made" },
  { key: "accepted", label: "Accepted" },
  { key: "received", label: "Items received" },
  { key: "completed", label: "Paid" },
]

/** Statuses that stop the path instead of continuing it. */
const STOPPED: Partial<Record<QuoteStatus, { label: string }>> = {
  declined: { label: "Closed" },
  expired: { label: "Expired" },
}

function indexOf(status: QuoteStatus): number {
  return PATH.findIndex((step) => step.key === status)
}

/**
 * How far the quote actually got before it stopped.
 *
 * A quote can be declined by the customer from an offer, or closed by the
 * shop from `submitted` with a note and never priced at all. Assuming the
 * offer step in both cases draws a history that did not happen, so the
 * furthest point is read off the record: an `offer_total` (or an expiry) is
 * the only proof an offer was ever made, and without one the path stops at
 * "Being looked at".
 */
function reachedBefore(
  quote: Pick<QuoteRecord, "offer_total" | "offer_expires_at">
): number {
  const offered = Boolean(quote.offer_total) || Boolean(quote.offer_expires_at)
  return indexOf(offered ? "offered" : "reviewing")
}

export interface TimelineOptions {
  /** 22 Sep 2026: injected so the sentences can be asserted exactly. */
  formatDate?: (iso: string) => string
}

/**
 * The steps to draw for a quote, and the one sentence that says what is
 * happening now.
 */
export function quoteTimeline(
  quote: Pick<QuoteRecord, "status" | "offer_total" | "offer_expires_at">,
  options: TimelineOptions = {}
): TimelineStep[] {
  const formatDate = options.formatDate ?? ((iso: string) => iso.slice(0, 10))
  const stopped = STOPPED[quote.status]
  const reached = stopped ? reachedBefore(quote) : indexOf(quote.status)

  const steps: TimelineStep[] = PATH.map((step, index) => {
    if (stopped) {
      // Everything up to and including the offer happened; nothing after it
      // ever will, so it is not drawn as "upcoming".
      return {
        key: step.key,
        label: step.label,
        state: index <= reached ? "done" : "upcoming",
        detail: null,
      }
    }
    if (index < reached) return { ...step, state: "done" as const, detail: null }
    if (index === reached) {
      return { ...step, state: "current" as const, detail: currentDetail(quote, formatDate) }
    }
    return { ...step, state: "upcoming" as const, detail: null }
  })

  if (stopped) {
    // The stop replaces the rest of the path rather than sitting beside it.
    const kept = steps.slice(0, reached + 1)
    return [
      ...kept,
      {
        key: quote.status,
        label: stopped.label,
        state: "stopped",
        detail: stoppedDetail(quote, formatDate),
      },
    ]
  }

  // An unrecognised status: show the path with nothing marked rather than
  // pretending the quote is at the start.
  if (reached === -1) {
    return PATH.map((step) => ({
      key: step.key,
      label: step.label,
      state: "upcoming" as const,
      detail: null,
    }))
  }

  return steps
}

function currentDetail(
  quote: Pick<QuoteRecord, "status" | "offer_total" | "offer_expires_at">,
  formatDate: (iso: string) => string
): string | null {
  switch (quote.status) {
    case "submitted":
      return "We have your photos. Someone will look at them shortly."
    case "reviewing":
      return "A member of staff is pricing your items now."
    case "offered":
      return quote.offer_expires_at
        ? `This offer holds until ${formatDate(quote.offer_expires_at)}.`
        : "Accept or decline below."
    case "accepted":
      return "Bring the items in, or post them, and we will check them over."
    case "received":
      return "We have your items. Payment follows once they are checked."
    case "completed":
      return "Paid. Thanks for selling to us."
    default:
      return null
  }
}

function stoppedDetail(
  quote: Pick<QuoteRecord, "status" | "offer_total" | "offer_expires_at">,
  formatDate: (iso: string) => string
): string {
  if (quote.status === "expired") {
    return quote.offer_expires_at
      ? `This offer expired on ${formatDate(quote.offer_expires_at)}. Ask for a new one.`
      : "This offer has run out. Ask for a new one."
  }
  // `declined` is written by the customer's own decline and by the shop's
  // cancel route alike, and a customer reading "You turned this down" about
  // a quote the shop closed has been told something that is not true. So it
  // is worded for either: what happened, and what they can do next.
  return "This quote was closed. Send new photos any time."
}

/** True when the customer still has to answer an offer. */
export function needsAnswer(
  quote: Pick<QuoteRecord, "status" | "offer_expires_at">,
  now: Date = new Date()
): boolean {
  if (quote.status !== "offered") return false
  if (!quote.offer_expires_at) return true
  const expires = new Date(quote.offer_expires_at)
  if (Number.isNaN(expires.getTime())) return true
  return expires.getTime() > now.getTime()
}
