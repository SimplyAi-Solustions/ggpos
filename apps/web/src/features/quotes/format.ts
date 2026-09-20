/**
 * The words and dates the quote queue uses.
 *
 * Kept apart from the screens so the queue, the quote page and the counter's
 * own messages all say the same thing about the same quote, and so the copy
 * rules in DESIGN.md are reviewable in one place.
 *
 * The month names are written out rather than taken from
 * `toLocaleDateString`: en-GB's short month for September is "Sept" on
 * current ICU, which is four characters where every other month is three.
 * `features/portal/format.ts` does the same for My Vault, for the same
 * reason; the counter's own words live here.
 */
import type { QuoteStatus } from "@/lib/api/types"

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 19 Sep 2026, the house short date. */
export function formatDate(iso: string | null | undefined): string {
  const date = parse(iso)
  if (!date) return ""
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** 22 Sep, 14:00, for a hold or an offer that runs out this week. */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parse(iso)
  if (!date) return ""
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}, ${time}`
}

/**
 * How long a quote has been sitting there, as a counter would say it.
 *
 * Rounded down, because "2 days" reads as an age rather than a countdown,
 * and anything under an hour is "just now" rather than a minute count
 * nobody acts on differently.
 */
export function formatAge(iso: string | null | undefined, now: Date = new Date()): string {
  const date = parse(iso)
  if (!date) return ""
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
