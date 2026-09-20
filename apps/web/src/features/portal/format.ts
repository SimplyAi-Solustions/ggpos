/**
 * The words and dates My Vault uses.
 *
 * Kept in one file so the card, the quotes, the want list and the profile
 * all say the same thing about the same state, and so the copy rules in
 * DESIGN.md are reviewable in one place rather than screen by screen.
 */
import type { IdStatus, QuoteDropOff, QuoteStatus } from "@/lib/api/types"

/**
 * The month names, written out rather than taken from `toLocaleDateString`.
 *
 * `{ month: "short" }` in en-GB gives "Sept" for September on current ICU,
 * which is four characters where every other month is three and is not the
 * house date. These are.
 */
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

/** 22 Sep, 14:00, for a hold that runs out this week. */
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

const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  submitted: "Sent",
  reviewing: "Being looked at",
  offered: "Offer made",
  accepted: "Accepted",
  declined: "Declined",
  received: "Items received",
  completed: "Paid",
  expired: "Expired",
}

/**
 * What to call a quote's state.
 *
 * A status the server adds later reads as "In progress" rather than as an
 * empty row: the portal is a read-only view of somebody else's state
 * machine, and it should never be a blank where a word belongs.
 */
export function quoteStatusLabel(status: QuoteStatus | string): string {
  return QUOTE_STATUS_LABELS[status as QuoteStatus] ?? "In progress"
}

export const DROP_OFF_LABEL: Record<QuoteDropOff, string> = {
  in_store: "Bring it in",
  post: "Post it",
}

export const ID_STATUS_SENTENCE: Record<IdStatus, string> = {
  none:
    "We have no photo ID on file for you. We only need it if we pay you in cash.",
  verified:
    "Your photo ID is on file and in date. We keep the photo for up to twelve months.",
  expired:
    "The ID we hold has run out. Bring a current one if you want to be paid in cash.",
  rejected:
    "The ID we hold was not accepted. Ask at the counter and we will sort it out.",
}

/** The twelve months, for the birthday select. */
export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const
