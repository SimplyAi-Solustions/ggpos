/**
 * The words the quote queue uses, and the one date rule it does not share.
 *
 * The two house date shapes live in `lib/dates.ts`, so the counter, the
 * customer's email and My Vault cannot drift on how a date reads; they are
 * re-exported here because every screen in this area already asks this
 * module for its words. What is local is the counter's own vocabulary: the
 * status labels, what each status is waiting for, and how old a quote is.
 */
import { formatDate, formatDateTime } from "@/lib/dates"
import type { QuoteStatus } from "@/lib/api/types"

export { formatDate, formatDateTime }

/**
 * How long a quote has been sitting there, as a counter would say it.
 *
 * Rounded down, because "2 days" reads as an age rather than a countdown,
 * and anything under an hour is "just now" rather than a minute count
 * nobody acts on differently.
 */
export function formatAge(iso: string | null | undefined, now: Date = new Date()): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return ""
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000)
  if (minutes < 60) return "Just now"
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
  const days = Math.floor(hours / 24)
  if (days < 31) return `${days} ${days === 1 ? "day" : "days"} ago`
  return formatDate(iso)
}

/** The status as the counter says it. Short: these are uppercase on screen. */
export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  submitted: "New",
  reviewing: "Reviewing",
  offered: "Offered",
  accepted: "Accepted",
  declined: "Declined",
  received: "Received",
  completed: "Completed",
  expired: "Expired",
}

/** One line under the status chip: what this quote is waiting for. */
export const QUOTE_STATUS_NOTE: Record<QuoteStatus, string> = {
  submitted: "Nobody has picked this up yet.",
  reviewing: "Being priced at the counter.",
  offered: "Waiting for the customer to answer.",
  accepted: "The customer has said yes. Mark it received when the items arrive.",
  declined: "Closed. The customer can send new photos any time.",
  received: "The items are here, on a draft buy-in.",
  completed: "Bought in and paid.",
  expired: "The offer ran out before it was answered.",
}

/** How the items are getting to the shop. Set as a tracked micro-label. */
export const DROP_OFF_LABEL: Record<"in_store" | "post", string> = {
  in_store: "In store",
  post: "By post",
}

/** "4 photos", "1 photo", "No photos". */
export function photoCount(count: number): string {
  if (count <= 0) return "No photos"
  return `${count} ${count === 1 ? "photo" : "photos"}`
}
