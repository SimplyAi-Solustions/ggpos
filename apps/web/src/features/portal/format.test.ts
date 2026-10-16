import { describe, expect, it } from "vitest"

import {
  DROP_OFF_LABEL,
  formatDate,
  formatDateTime,
  ID_STATUS_SENTENCE,
  MONTHS,
  quoteStatusLabel,
} from "@/features/portal/format"

describe("formatDate", () => {
  it("writes the house short date", () => {
    expect(formatDate("2026-09-19T10:00:00Z")).toBe("19 Sep 2026")
  })

  it("keeps September to three letters, which the browser does not", () => {
    // `toLocaleDateString("en-GB", { month: "short" })` gives "Sept" on
    // current ICU, which is why this module owns its own month table.
    expect(formatDate("2026-09-01T10:00:00Z")).toContain("Sep ")
    expect(formatDate("2026-09-01T10:00:00Z")).not.toContain("Sept")
  })

  it("writes every month as three letters", () => {
    const written = MONTHS.map((_month, index) =>
      formatDate(new Date(Date.UTC(2026, index, 15, 12)).toISOString()).split(" ")[1]
    )
    expect(written.every((month) => month?.length === 3)).toBe(true)
    expect(written[0]).toBe("Jan")
    expect(written[11]).toBe("Dec")
  })

  it("answers empty for nothing, and for something that is not a date", () => {
    expect(formatDate(undefined)).toBe("")
    expect(formatDate(null)).toBe("")
    expect(formatDate("")).toBe("")
    expect(formatDate("not a date")).toBe("")
  })
})

describe("formatDateTime", () => {
  it("writes the day, the month and a 24-hour time", () => {
    const at = new Date(2026, 8, 22, 14, 5)
    expect(formatDateTime(at.toISOString())).toBe("22 Sep, 14:05")
  })

  it("pads the hour, so a hold at nine reads 09:00", () => {
    const at = new Date(2026, 8, 22, 9, 0)
    expect(formatDateTime(at.toISOString())).toBe("22 Sep, 09:00")
  })

  it("answers empty for nothing", () => {
    expect(formatDateTime(undefined)).toBe("")
    expect(formatDateTime("nope")).toBe("")
  })
})

describe("ID_STATUS_SENTENCE", () => {
  it("says something about every status the server can send", () => {
    for (const status of ["none", "verified", "expired", "rejected"] as const) {
      expect(ID_STATUS_SENTENCE[status].length).toBeGreaterThan(20)
      expect(ID_STATUS_SENTENCE[status]).not.toContain("!")
    }
  })

  it("names the twelve months the photo is kept for, where it applies", () => {
    expect(ID_STATUS_SENTENCE.verified).toContain("twelve months")
  })

  it("tells somebody what to do when the ID has run out", () => {
    expect(ID_STATUS_SENTENCE.expired).toContain("Bring a current one")
  })
})

describe("quoteStatusLabel", () => {
  it("names every status the contract lists", () => {
    expect(quoteStatusLabel("submitted")).toBe("Sent")
    expect(quoteStatusLabel("offered")).toBe("Offer made")
    expect(quoteStatusLabel("completed")).toBe("Paid")
  })

  it("falls back rather than leaving a row blank", () => {
    expect(quoteStatusLabel("something_new")).toBe("In progress")
  })
})

describe("DROP_OFF_LABEL", () => {
  it("offers exactly the two the route accepts", () => {
    expect(Object.keys(DROP_OFF_LABEL)).toEqual(["in_store", "post"])
  })
})
