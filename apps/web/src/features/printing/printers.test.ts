import { describe, expect, it } from "vitest"

import {
  EMPTY_PRINTER_FORM,
  lastSeenText,
  normaliseMac,
  printerMeta,
  validatePrinterForm,
} from "./printers"

describe("normaliseMac", () => {
  it("writes a MAC in lower case with colons whichever way it was typed", () => {
    expect(normaliseMac("00:11:E5:06:04:FF")).toBe("00:11:e5:06:04:ff")
    expect(normaliseMac("00-11-e5-06-04-ff")).toBe("00:11:e5:06:04:ff")
    expect(normaliseMac("0011E50604FF")).toBe("00:11:e5:06:04:ff")
    expect(normaliseMac("  00:11:e5:06:04:ff  ")).toBe("00:11:e5:06:04:ff")
  })

  it("refuses anything that is not six pairs of hex digits", () => {
    expect(normaliseMac("")).toBe("")
    expect(normaliseMac("00:11:e5:06:04")).toBe("")
    expect(normaliseMac("00:11:e5:06:04:ff:aa")).toBe("")
    expect(normaliseMac("zz:11:e5:06:04:ff")).toBe("")
    expect(normaliseMac("00.11.e5.06.04.ff")).toBe("")
  })
})

describe("validatePrinterForm", () => {
  const good = { ...EMPTY_PRINTER_FORM, name: "Counter printer", mac: "00:11:e5:06:04:ff", register: "r1" }

  it("accepts a name, a real MAC and a register", () => {
    expect(validatePrinterForm(good)).toEqual({})
  })

  it("says what to do about each mistake, in the server's own words", () => {
    const errors = validatePrinterForm(EMPTY_PRINTER_FORM)
    expect(errors.name).toBe("Give the printer a name, for example Counter printer.")
    expect(errors.mac).toBe("Type the printer's MAC address, for example 00:11:e5:06:04:ff.")
    expect(errors.register).toBe("Choose the register this printer serves.")
  })

  it("refuses a name over 60 characters", () => {
    expect(validatePrinterForm({ ...good, name: "x".repeat(61) }).name).toMatch(/60 characters/)
  })
})

describe("lastSeenText", () => {
  const now = new Date("2026-10-09T12:00:00.000Z")

  it("says Online for a printer that polled in the last thirty seconds", () => {
    expect(lastSeenText({ online: true, last_poll_at: "2026-10-09T11:59:50.000Z" }, now)).toBe("Online")
  })

  it("says when it was last seen, in shop time, for one that has gone quiet today", () => {
    // 09:42 UTC is 10:42 in Bolsover in October.
    expect(lastSeenText({ online: false, last_poll_at: "2026-10-09T09:42:00.000Z" }, now)).toBe(
      "Last seen 10:42"
    )
  })

  it("adds the day for one last seen before today", () => {
    expect(lastSeenText({ online: false, last_poll_at: "2026-10-07T09:42:00.000Z" }, now)).toBe(
      "Last seen 7 Oct, 10:42"
    )
  })

  it("says so for a printer that has never polled", () => {
    expect(lastSeenText({ online: false, last_poll_at: "" }, now)).toBe("Not seen yet")
    expect(lastSeenText({ online: false, last_poll_at: "nonsense" }, now)).toBe("Not seen yet")
  })

  it("counts the day in shop time, not UTC", () => {
    // 23:30 UTC on the 8th is 00:30 on the 9th in Bolsover: the same day as noon on the 9th.
    expect(lastSeenText({ online: false, last_poll_at: "2026-10-08T23:30:00.000Z" }, now)).toBe(
      "Last seen 00:30"
    )
  })
})

describe("printerMeta", () => {
  it("lists the model, the register and the paper, leaving out what is empty", () => {
    expect(printerMeta({ model: "Star TSP143IV", register_name: "Counter", paper_width: 80 })).toBe(
      "Star TSP143IV, Counter, 80 mm paper"
    )
    expect(printerMeta({ model: "", register_name: "Counter", paper_width: 58 })).toBe(
      "Counter, 58 mm paper"
    )
  })
})
