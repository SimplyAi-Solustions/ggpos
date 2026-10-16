import { describe, expect, it } from "vitest"

import {
  customerSchema,
  duplicateQuery,
  matchesQuery,
  phoneDigits,
} from "@/features/customers/schema"

describe("customerSchema", () => {
  it("takes a walk-in with nothing but a name", () => {
    const result = customerSchema.safeParse({
      name: "Tom Bradbury",
      marketingConsent: false,
    })
    expect(result.success).toBe(true)
  })

  it("says what to do about a name that is too short to print", () => {
    const result = customerSchema.safeParse({ name: "T", marketingConsent: false })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/card can be printed/)
  })

  it("accepts a UK number with spaces and a country code", () => {
    expect(
      customerSchema.safeParse({
        name: "Tom Bradbury",
        phone: "+44 7700 900456",
        marketingConsent: false,
      }).success
    ).toBe(true)
  })

  it("refuses a phone number with letters in it", () => {
    const result = customerSchema.safeParse({
      name: "Tom Bradbury",
      phone: "ring me",
      marketingConsent: false,
    })
    expect(result.success).toBe(false)
  })

  it("refuses an address that is not an email", () => {
    const result = customerSchema.safeParse({
      name: "Tom Bradbury",
      email: "tom at example",
      marketingConsent: false,
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/@/)
  })
})

describe("phoneDigits", () => {
  it("reduces every way of writing a number to the same digits", () => {
    expect(phoneDigits("07700 900456")).toBe("07700900456")
    expect(phoneDigits("(07700) 900-456")).toBe("07700900456")
    expect(phoneDigits(undefined)).toBe("")
  })
})

describe("duplicateQuery", () => {
  it("waits for a whole number before looking", () => {
    expect(duplicateQuery({ phone: "0770" })).toBeNull()
    expect(duplicateQuery({ phone: "07700900456" })?.phone).toBe("07700900456")
  })

  it("waits for a plausible email before looking", () => {
    expect(duplicateQuery({ email: "tom@" })).toBeNull()
    expect(duplicateQuery({ email: "Tom@Example.co.uk" })?.email).toBe(
      "tom@example.co.uk"
    )
  })

  it("has nothing to look for when both are empty", () => {
    expect(duplicateQuery({})).toBeNull()
  })
})

describe("matchesQuery", () => {
  const query = { phone: "07700900456", email: "tom@example.co.uk" }

  it("matches on the phone however it was typed", () => {
    expect(
      matchesQuery({ phone: "(07700) 900 456", email: "" }, query)
    ).toBe(true)
  })

  it("matches on the email whatever the case", () => {
    expect(matchesQuery({ phone: "", email: "TOM@example.co.uk" }, query)).toBe(true)
  })

  it("leaves a different person alone", () => {
    expect(matchesQuery({ phone: "07700900999", email: "t@b.com" }, query)).toBe(false)
  })
})
