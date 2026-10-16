import { describe, expect, it } from "vitest"

import {
  QUOTE_STATUS_LABEL,
  formatAge,
  formatDate,
  formatDateTime,
  photoCount,
} from "@/features/quotes/format"

describe("formatDate", () => {
  it("writes the house short date", () => {
    expect(formatDate("2026-09-19T10:00:00Z")).toBe("19 Sep 2026")
  })

  it("keeps September to three letters, whatever ICU would say", () => {
    expect(formatDate("2026-09-01T00:00:00Z")).toContain("Sep ")
    expect(formatDate("2026-09-01T00:00:00Z")).not.toContain("Sept")
  })

  it("is empty for nothing, rather than an invalid date", () => {
    expect(formatDate(null)).toBe("")
    expect(formatDate("not a date")).toBe("")
  })
})

describe("formatDateTime", () => {
  it("writes a day and a 24-hour time", () => {
    expect(formatDateTime("2026-09-22T14:00:00Z")).toMatch(/^22 Sep, \d{2}:\d{2}$/)
  })
})

describe("formatAge", () => {
  const now = new Date("2026-09-20T14:00:00Z")

  it("says just now under the hour", () => {
    expect(formatAge("2026-09-20T13:20:00Z", now)).toBe("Just now")
  })

  it("counts hours, then days", () => {
    expect(formatAge("2026-09-20T09:00:00Z", now)).toBe("5 hours ago")
    expect(formatAge("2026-09-20T13:00:00Z", now)).toBe("1 hour ago")
    expect(formatAge("2026-09-18T14:00:00Z", now)).toBe("2 days ago")
    expect(formatAge("2026-09-19T14:00:00Z", now)).toBe("1 day ago")
  })

  it("falls back to the date once it is over a month old", () => {
    expect(formatAge("2026-07-01T14:00:00Z", now)).toBe("1 Jul 2026")
  })
})

describe("photoCount", () => {
  it("counts photos in words a counter would use", () => {
    expect(photoCount(0)).toBe("No photos")
    expect(photoCount(1)).toBe("1 photo")
    expect(photoCount(4)).toBe("4 photos")
  })
})

describe("QUOTE_STATUS_LABEL", () => {
  it("keeps every label short enough to set uppercase", () => {
    for (const label of Object.values(QUOTE_STATUS_LABEL)) {
      expect(label.length).toBeLessThanOrEqual(24)
    }
  })
})
