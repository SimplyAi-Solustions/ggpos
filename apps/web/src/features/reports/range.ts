/**
 * The date range every report page runs on, and the period it is compared
 * against.
 *
 * Ranges are UTC days, the same unit `daily_stats` and the report routes work
 * in (docs/api-contract.md, "Phase 4: stats and reports"), so a bar on a
 * chart is the bucket the server built. Everything here is pure: the screen
 * passes today in, which is what makes the arithmetic testable and the
 * screenshots stable.
 */
import {
  addDays,
  daysBetween,
  fromIsoDay,
  isIsoDay,
  monthStart,
  mondayOf,
  quarterStart,
  rangeLength,
  todayIso,
  yearStart,
} from "@/lib/api/dates"
import type { ReportGroup } from "@/lib/api/types"

export interface DateRange {
  from: string
  to: string
}

export type PresetKey =
  | "today"
  | "week"
  | "month"
  | "last30"
  | "quarter"
  | "year"
  | "custom"

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last30", label: "Last 30 days" },
  { key: "quarter", label: "This quarter" },
  { key: "year", label: "This year" },
  { key: "custom", label: "Custom" },
]

/** The longest range the routes will answer, shared with `stats/rebuild`. */
export const MAX_RANGE_DAYS = 400

/** A preset as a range ending today. `custom` keeps whatever is on screen. */
export function resolvePreset(key: PresetKey, today: string = todayIso()): DateRange {
  switch (key) {
    case "today":
      return { from: today, to: today }
    case "week":
      return { from: mondayOf(today), to: today }
    case "month":
      return { from: monthStart(today), to: today }
    case "last30":
      return { from: addDays(today, -29), to: today }
    case "quarter":
      return { from: quarterStart(today), to: today }
    case "year":
      return { from: yearStart(today), to: today }
    default:
      return { from: today, to: today }
  }
}

/** Which preset a range is, so the chips show what is actually on screen. */
export function presetFor(range: DateRange, today: string = todayIso()): PresetKey {
  for (const preset of PRESETS) {
    if (preset.key === "custom") continue
    const resolved = resolvePreset(preset.key, today)
    if (resolved.from === range.from && resolved.to === range.to) return preset.key
  }
  return "custom"
}

/**
 * The period of the same length immediately before this one, which is what
 * `compare=previous` means on every report route: 7 days back 7 days, a
 * calendar month back its own number of days, never "the same month last
 * year".
 */
export function previousPeriod(range: DateRange): DateRange {
  const length = rangeLength(range.from, range.to)
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) }
}

/**
 * The same refusals the routes make, said before a request is sent so a
 * typed-in range is answered on the spot. The wording matches the server's,
 * word for word, so staff never see two sentences for one mistake.
 */
export function rangeError(range: DateRange): string | null {
  if (!isIsoDay(range.from) || !isIsoDay(range.to)) {
    return "Pick a date range. Both from and to are needed, as YYYY-MM-DD."
  }
  if (daysBetween(range.from, range.to) < 0) {
    return "The from date is after the to date. Swap them over."
  }
  if (rangeLength(range.from, range.to) > MAX_RANGE_DAYS) {
    return `Pick a range of up to ${MAX_RANGE_DAYS} days.`
  }
  return null
}

/**
 * The month names are written out rather than taken from `toLocaleDateString`
 * on purpose: current ICU gives en-GB "Sept" for September, and every date in
 * this app reads "19 Sep 2026" (CLAUDE.md). A fixed table also means a tick
 * label is the same string on every machine a screenshot is taken on.
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
]

const LONG_MONTHS = [
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
]

function parts(iso: string): { day: number; month: string; year: number } {
  const date = fromIsoDay(iso)
  return {
    day: date.getUTCDate(),
    month: SHORT_MONTHS[date.getUTCMonth()] ?? "",
    year: date.getUTCFullYear(),
  }
}

/** "19 Sep 2026", the way every date reads on screen. */
export function formatDay(iso: string): string {
  const { day, month, year } = parts(iso)
  return `${day} ${month} ${year}`
}

/**
 * A range in as few words as it can honestly be said in: "19 Sep 2026" for
 * one day, "1 to 31 Aug 2026" inside one month, "1 Aug to 30 Sep 2026" inside
 * one year, both years otherwise.
 */
export function formatRange(range: DateRange, options: { year?: boolean } = {}): string {
  const withYear = options.year ?? true
  const from = parts(range.from)
  const to = parts(range.to)
  const tail = withYear ? ` ${to.year}` : ""

  if (range.from === range.to) return `${to.day} ${to.month}${tail}`
  if (from.year !== to.year) {
    return `${from.day} ${from.month} ${from.year} to ${to.day} ${to.month} ${to.year}`
  }
  if (from.month === to.month) return `${from.day} to ${to.day} ${to.month}${tail}`
  return `${from.day} ${from.month} to ${to.day} ${to.month}${tail}`
}

/** "against 1 to 31 Aug". The year is only printed when the two differ. */
export function compareLabel(range: DateRange, previous: DateRange): string {
  const sameYear =
    range.from.slice(0, 4) === previous.from.slice(0, 4) &&
    range.to.slice(0, 4) === previous.to.slice(0, 4)
  return `against ${formatRange(previous, { year: !sameYear })}`
}

/**
 * A delta beside a figure. Never a red or a green: the sign carries it, and
 * whether a fall is bad depends on which report you are reading.
 */
export function formatDelta(
  current: number,
  before: number,
  format: (value: number) => string
): string {
  const change = current - before
  if (change === 0) return "No change"
  return `${change > 0 ? "+" : "-"}${format(Math.abs(change))}`
}

/** The short tick under a bar: "19 Sep", "14 Sep", "Sep". */
export function bucketTick(label: string, group: ReportGroup): string {
  if (group === "month") return parts(`${label}-01`).month
  const { day, month } = parts(label)
  return `${day} ${month}`
}

/** The fuller label in a tooltip and in an exported CSV's first column. */
export function bucketTitle(label: string, group: ReportGroup): string {
  if (group === "month") {
    const date = fromIsoDay(`${label}-01`)
    return `${LONG_MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`
  }
  if (group === "week") return `Week of ${formatDay(label)}`
  return formatDay(label)
}
