import { describe, expect, it } from "vitest"

import { validateSignUp } from "./signup"

describe("validateSignUp", () => {
  it("passes a complete form", () => {
    expect(
      validateSignUp({ name: "Robin Hart", email: "robin@example.co.uk", terms: true })
    ).toEqual({})
  })

  it("says what is missing, field by field", () => {
    const errors = validateSignUp({ name: "  ", email: "", terms: false })
    expect(errors.name).toBe("Add your name.")
    expect(errors.email).toMatch(/^Add your email address/)
    expect(errors.terms).toMatch(/^Tick the box to accept the terms/)
  })

  it("refuses an address that is not one", () => {
    expect(validateSignUp({ name: "R", email: "robin-at-home", terms: true }).email).toMatch(
      /does not look right/
    )
  })

  it("never ends a sentence with an exclamation mark", () => {
    const errors = validateSignUp({ name: "", email: "x", terms: false })
    for (const message of Object.values(errors)) expect(message).not.toMatch(/!/)
  })
})
