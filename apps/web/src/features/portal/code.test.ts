import { describe, expect, it } from "vitest"

import {
  CODE_LENGTH,
  formatCodeForDisplay,
  isCompleteCode,
  normaliseCodeInput,
} from "@/features/portal/code"

describe("normaliseCodeInput", () => {
  it("keeps the digits out of a pasted line", () => {
    expect(normaliseCodeInput("Your code is 4821 9876")).toBe("48219876")
  })

  it("drops spaces, dashes and newlines", () => {
    expect(normaliseCodeInput(" 4821-9876\n")).toBe("48219876")
  })

  it("never keeps more than the code's length", () => {
    expect(normaliseCodeInput("482198765432")).toHaveLength(CODE_LENGTH)
    expect(normaliseCodeInput("482198765432")).toBe("48219876")
  })

  it("answers empty for a line with no digits in it", () => {
    expect(normaliseCodeInput("no code here")).toBe("")
  })
})

describe("isCompleteCode", () => {
  it("is true only at the full length", () => {
    expect(isCompleteCode("4821987")).toBe(false)
    expect(isCompleteCode("48219876")).toBe(true)
  })

  it("counts the digits, not the characters typed", () => {
    expect(isCompleteCode("4821 9876")).toBe(true)
  })
})

describe("formatCodeForDisplay", () => {
  it("splits the code in half, the way people read it out", () => {
    expect(formatCodeForDisplay("48219876")).toBe("4821 9876")
  })

  it("leaves a short code alone", () => {
    expect(formatCodeForDisplay("482")).toBe("482")
  })
})
