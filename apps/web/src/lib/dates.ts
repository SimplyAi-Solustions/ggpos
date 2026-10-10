/**
 * The two date shapes the whole app writes, in one place.
 *
 * "19 Sep 2026" and "22 Sep, 14:00". Both are written out here rather than
 * left to `toLocaleDateString`, whose en-GB short month for September is
 * "Sept" on current ICU and plain "Sep" on older ones: a date that changes
 * shape with the browser's own data is not worth the saving, and the
 * counter and the customer's email have to read identically.
 *
 * `lib/api/dates.ts` is the other date module and is a different job: UTC
 * calendar-day arithmetic for the reporting routes. This one is only ever
 * about what a person reads.
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

/** 19 Sep 2026, the house short date. Empty for anything that is not one. */
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
 * Midnight this morning and a minute to midnight tonight, local time.
 *
 * "Today" on the counter is the shop's own day, not a UTC one: a hold that
 * runs out at half past eleven tonight ends today wherever the server
 * thinks it is.
 */
export function dayBounds(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)
  return { from, to }
}
