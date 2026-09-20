import { describe, expect, it } from "vitest"
import { formatGBP } from "@gg/shared"

import {
  addDays,
  bucketLabel,
  daysBetween,
  eachDay,
  mondayOf,
  quarterStart,
  rangeLength,
} from "@/lib/api/dates"
import {
  bucketTick,
  bucketTitle,
  compareLabel,
  formatDay,
  formatDelta,
  formatRange,
  presetFor,
  previousPeriod,
  rangeError,
  resolvePreset,
} from "@/features/reports/range"

/** A Sunday, deliberately: the week arithmetic is where a Sunday bites. */
const SUNDAY = "2026-09-20"

describe("UTC day arithmetic", () => {
  it("counts a range by both ends", () => {
    expect(rangeLength("2026-09-14", "2026-09-20")).toBe(7)
    expect(rangeLength("2026-09-20", "2026-09-20")).toBe(1)
    expect(daysBetween("2026-09-14", "2026-09-20")).toBe(6)
  })

  it("puts a Sunday in the week that started the Monday before it", () => {
    expect(mondayOf(SUNDAY)).toBe("2026-09-14")
    expect(mondayOf("2026-09-14")).toBe("2026-09-14")
    expect(mondayOf("2026-09-19")).toBe("2026-09-14")
  })

  it("crosses a month and a year without drifting", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
    // 2028 is a leap year, so the 29th exists.
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29")
  })

  it("starts a quarter on the right month", () => {
    expect(quarterStart("2026-09-20")).toBe("2026-07-01")
    expect(quarterStart("2026-01-31")).toBe("2026-01-01")
    expect(quarterStart("2026-12-25")).toBe("2026-10-01")
  })

  it("walks every day in a range, both ends included", () => {
    expect(eachDay("2026-09-18", "2026-09-20")).toEqual([
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ])
  })

  it("labels a bucket the way the routes do", () => {
    expect(bucketLabel(SUNDAY, "day")).toBe("2026-09-20")
    expect(bucketLabel(SUNDAY, "week")).toBe("2026-09-14")
    expect(bucketLabel(SUNDAY, "month")).toBe("2026-09")
  })
})

describe("the presets", () => {
  it("resolves each one against a fixed today", () => {
    expect(resolvePreset("today", SUNDAY)).toEqual({ from: SUNDAY, to: SUNDAY })
    expect(resolvePreset("week", SUNDAY)).toEqual({ from: "2026-09-14", to: SUNDAY })
    expect(resolvePreset("month", SUNDAY)).toEqual({ from: "2026-09-01", to: SUNDAY })
    expect(resolvePreset("last30", SUNDAY)).toEqual({ from: "2026-08-22", to: SUNDAY })
    expect(resolvePreset("quarter", SUNDAY)).toEqual({ from: "2026-07-01", to: SUNDAY })
    expect(resolvePreset("year", SUNDAY)).toEqual({ from: "2026-01-01", to: SUNDAY })
  })

  it("last 30 days is 30 days, not 31", () => {
    const range = resolvePreset("last30", SUNDAY)
    expect(rangeLength(range.from, range.to)).toBe(30)
  })

  it("names the preset a range already matches, and custom when it does not", () => {
    expect(presetFor({ from: "2026-09-01", to: SUNDAY }, SUNDAY)).toBe("month")
    expect(presetFor({ from: "2026-05-02", to: "2026-06-04" }, SUNDAY)).toBe("custom")
  })
})

describe("the comparison period", () => {
  it("is the same length, immediately before", () => {
    expect(previousPeriod({ from: "2026-09-14", to: "2026-09-20" })).toEqual({
      from: "2026-09-07",
      to: "2026-09-13",
    })
  })

  it("is one day back for a one-day range", () => {
    expect(previousPeriod({ from: SUNDAY, to: SUNDAY })).toEqual({
      from: "2026-09-19",
      to: "2026-09-19",
    })
  })

  it("moves a part month back by its own number of days, not a calendar month", () => {
    // 1 to 20 Sep is 20 days, so the period before it is 12 to 31 Aug.
    expect(previousPeriod({ from: "2026-09-01", to: "2026-09-20" })).toEqual({
      from: "2026-08-12",
      to: "2026-08-31",
    })
  })

  it("never overlaps the range it is compared with", () => {
    const range = { from: "2026-01-01", to: "2026-12-31" }
    expect(previousPeriod(range).to < range.from).toBe(true)
  })
})

describe("what a range reads as", () => {
  it("says one day once", () => {
    expect(formatDay(SUNDAY)).toBe("20 Sep 2026")
    expect(formatRange({ from: SUNDAY, to: SUNDAY })).toBe("20 Sep 2026")
  })

  it("collapses a month it shares", () => {
    expect(formatRange({ from: "2026-08-01", to: "2026-08-31" })).toBe("1 to 31 Aug 2026")
  })

  it("keeps both months inside one year", () => {
    expect(formatRange({ from: "2026-08-01", to: "2026-09-30" })).toBe(
      "1 Aug to 30 Sep 2026"
    )
  })

  it("prints both years when the range crosses one", () => {
    expect(formatRange({ from: "2025-12-20", to: "2026-01-05" })).toBe(
      "20 Dec 2025 to 5 Jan 2026"
    )
  })

  it("drops the year on the comparison line when both sit in one year", () => {
    const range = { from: "2026-09-01", to: "2026-09-30" }
    expect(compareLabel(range, { from: "2026-08-02", to: "2026-08-31" })).toBe(
      "against 2 to 31 Aug"
    )
  })

  it("keeps the year on the comparison line when it differs", () => {
    const range = { from: "2026-01-01", to: "2026-01-31" }
    expect(compareLabel(range, { from: "2025-12-02", to: "2025-12-31" })).toBe(
      "against 2 to 31 Dec 2025"
    )
  })

  it("writes a tick short and a tooltip full", () => {
    expect(bucketTick("2026-09-20", "day")).toBe("20 Sep")
    expect(bucketTick("2026-09", "month")).toBe("Sep")
    expect(bucketTitle("2026-09-14", "week")).toBe("Week of 14 Sep 2026")
    expect(bucketTitle("2026-09", "month")).toBe("September 2026")
  })
})

describe("a delta beside a figure", () => {
  it("carries its sign and the formatted amount", () => {
    expect(formatDelta(52_000, 47_880, formatGBP)).toBe("+£41.20")
    expect(formatDelta(12, 15, String)).toBe("-3")
  })

  it("says so in words when nothing moved", () => {
    expect(formatDelta(1000, 1000, formatGBP)).toBe("No change")
  })
})

describe("the range the routes will refuse", () => {
  it("says what to do about a date that is not a date", () => {
    expect(rangeError({ from: "", to: SUNDAY })).toBe(
      "Pick a date range. Both from and to are needed, as YYYY-MM-DD."
    )
    expect(rangeError({ from: "2026-13-45", to: SUNDAY })).toBe(
      "Pick a date range. Both from and to are needed, as YYYY-MM-DD."
    )
  })

  it("says which way round the two dates go", () => {
    expect(rangeError({ from: SUNDAY, to: "2026-09-01" })).toBe(
      "The from date is after the to date. Swap them over."
    )
  })

  it("holds the same 400-day bound the routes do", () => {
    expect(rangeError({ from: "2025-01-01", to: "2026-09-20" })).toBe(
      "Pick a range of up to 400 days."
    )
    // Exactly 400 days is fine; 401 is not.
    expect(rangeError({ from: addDays(SUNDAY, -399), to: SUNDAY })).toBeNull()
    expect(rangeError({ from: addDays(SUNDAY, -400), to: SUNDAY })).toBe(
      "Pick a range of up to 400 days."
    )
  })

  it("passes an ordinary range", () => {
    expect(rangeError({ from: "2026-09-01", to: SUNDAY })).toBeNull()
  })
})
