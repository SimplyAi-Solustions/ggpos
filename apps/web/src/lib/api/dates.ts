/**
 * UTC day arithmetic, for the reporting package.
 *
 * Every date bound in Phase 4 is a UTC calendar day: `daily_stats` holds one
 * row per UTC day, and `GET /api/vault/reports/:key` ranges on the same
 * boundaries (docs/api-contract.md, "Phase 4: stats and reports"). The
 * screens work in the same unit, so a bucket on a chart is the bucket the
 * server built and nothing shifts by an hour over British Summer Time.
 *
 * Dates are passed about as plain `YYYY-MM-DD` strings. Nothing here builds
 * a `Date` from a bare string in local time, which is the one way this drifts
 * a day either side of midnight.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` for a Date, read in UTC. */
export function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** A `YYYY-MM-DD` string as a Date at midnight UTC. Invalid input throws. */
export function fromIsoDay(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new Error(`Not a date: ${iso}`)
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

/** True for a well-formed `YYYY-MM-DD` that is also a real calendar day. */
export function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && toIsoDay(parsed) === value
}

/** Today as a UTC day. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDay(now)
}

/** `iso` moved by `days`, still a UTC day. */
export function addDays(iso: string, days: number): string {
  return toIsoDay(new Date(fromIsoDay(iso).getTime() + days * DAY_MS))
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((fromIsoDay(to).getTime() - fromIsoDay(from).getTime()) / DAY_MS)
}

/** Days in the range counting both ends, which is what a period's length means. */
export function rangeLength(from: string, to: string): number {
  return daysBetween(from, to) + 1
}

/** Every UTC day from `from` to `to`, both ends included. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  const last = daysBetween(from, to)
  for (let offset = 0; offset <= last; offset += 1) days.push(addDays(from, offset))
  return days
}

/** The Monday of `iso`'s own week, which is how the routes label a week. */
export function mondayOf(iso: string): string {
  const date = fromIsoDay(iso)
  // getUTCDay is 0 on Sunday, so Sunday goes back six days rather than none.
  const weekday = date.getUTCDay()
  return addDays(iso, weekday === 0 ? -6 : 1 - weekday)
}

/** The first day of `iso`'s month. */
export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/** The first day of `iso`'s calendar quarter. */
export function quarterStart(iso: string): string {
  const date = fromIsoDay(iso)
  const month = Math.floor(date.getUTCMonth() / 3) * 3
  return toIsoDay(new Date(Date.UTC(date.getUTCFullYear(), month, 1)))
}

/** The first day of `iso`'s year. */
export function yearStart(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`
}

/** The bucket label a `group` puts a day in, matching the routes' own labels. */
export function bucketLabel(iso: string, group: "day" | "week" | "month"): string {
  if (group === "week") return mondayOf(iso)
  if (group === "month") return iso.slice(0, 7)
  return iso
}
