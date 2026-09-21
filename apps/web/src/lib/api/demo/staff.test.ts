import { beforeEach, describe, expect, it } from "vitest"

import {
  demoChangePassword,
  demoPasswordMatches,
  demoSignIn,
  resetDemoStaff,
} from "@/lib/api/demo/staff"
import { DEMO_LOCKED_STAFF, DEMO_STAFF } from "@/lib/api/fixtures"

/**
 * The demo counter's two staff accounts, which are what the e2e suite's
 * proof of the first-sign-in lock rests on: one ordinary account and one
 * still on a password somebody else chose. A password change here has to
 * behave the way PocketBase does, or the demo would prove nothing about
 * the real thing.
 */

beforeEach(() => {
  resetDemoStaff()
})

describe("demoSignIn", () => {
  it("signs the ordinary demo account in, unlocked", () => {
    const staff = demoSignIn(DEMO_STAFF.email, DEMO_STAFF.password)
    expect(staff?.id).toBe(DEMO_STAFF.id)
    expect(staff?.must_change_password).toBe(false)
  })

  it("signs the new starter in locked to a password change", () => {
    const staff = demoSignIn(DEMO_LOCKED_STAFF.email, DEMO_LOCKED_STAFF.password)
    expect(staff?.id).toBe(DEMO_LOCKED_STAFF.id)
    expect(staff?.must_change_password).toBe(true)
  })

  it("never hands the password back on the record", () => {
    const staff = demoSignIn(DEMO_STAFF.email, DEMO_STAFF.password)
    expect(staff).not.toBeNull()
    expect(Object.keys(staff!)).not.toContain("password")
  })

  it("refuses a wrong password and an email nobody has", () => {
    expect(demoSignIn(DEMO_STAFF.email, "not-the-password")).toBeNull()
    expect(demoSignIn("nobody@ggentertainment.co.uk", DEMO_STAFF.password)).toBeNull()
  })

  it("reads an email the way a counter types it", () => {
    expect(demoSignIn(` ${DEMO_STAFF.email.toUpperCase()} `, DEMO_STAFF.password)).not.toBeNull()
  })
})

describe("demoChangePassword", () => {
  const NEXT = "a-brand-new-counter-password"

  it("clears the lock and leaves the new password the one that works", () => {
    const changed = demoChangePassword(
      DEMO_LOCKED_STAFF.email,
      DEMO_LOCKED_STAFF.password,
      NEXT
    )
    expect(changed?.must_change_password).toBe(false)
    expect(demoSignIn(DEMO_LOCKED_STAFF.email, NEXT)?.must_change_password).toBe(false)
    expect(demoSignIn(DEMO_LOCKED_STAFF.email, DEMO_LOCKED_STAFF.password)).toBeNull()
  })

  it("refuses a wrong current password and changes nothing", () => {
    expect(demoChangePassword(DEMO_LOCKED_STAFF.email, "not-the-one", NEXT)).toBeNull()
    expect(demoSignIn(DEMO_LOCKED_STAFF.email, DEMO_LOCKED_STAFF.password)).not.toBeNull()
    expect(demoPasswordMatches(DEMO_LOCKED_STAFF.email, NEXT)).toBe(false)
  })

  it("refuses an email nobody has", () => {
    expect(demoChangePassword("nobody@ggentertainment.co.uk", "anything", NEXT)).toBeNull()
  })

  it("is put back by resetDemoStaff, so one test never leaks into the next", () => {
    demoChangePassword(DEMO_LOCKED_STAFF.email, DEMO_LOCKED_STAFF.password, NEXT)
    resetDemoStaff()
    expect(demoPasswordMatches(DEMO_LOCKED_STAFF.email, DEMO_LOCKED_STAFF.password)).toBe(true)
    expect(demoSignIn(DEMO_LOCKED_STAFF.email, DEMO_LOCKED_STAFF.password)?.must_change_password).toBe(
      true
    )
  })
})
