import { describe, expect, it } from "vitest"

import {
  checkNewPassword,
  isLocked,
  lockedRedirect,
  MIN_PASSWORD_LENGTH,
  PASSWORD_PATH,
  PASSWORD_REFUSAL,
} from "@/features/auth/gate"
import type { StaffRecord } from "@/lib/api/types"

function staff(overrides: Partial<StaffRecord> = {}): StaffRecord {
  return {
    id: "staff_1",
    email: "sam@ggentertainment.co.uk",
    name: "Sam",
    role: "staff",
    active: true,
    ...overrides,
  }
}

describe("isLocked", () => {
  it("is false with no session at all", () => {
    expect(isLocked(null)).toBe(false)
    expect(isLocked(undefined)).toBe(false)
  })

  it("is false for a staff member with the flag unset or false", () => {
    expect(isLocked(staff())).toBe(false)
    expect(isLocked(staff({ must_change_password: false }))).toBe(false)
  })

  it("is true only for the flag itself, never a truthy stand-in", () => {
    expect(isLocked(staff({ must_change_password: true }))).toBe(true)
    // A record that arrived as JSON with the field missing must not lock.
    expect(isLocked({ ...staff(), must_change_password: undefined })).toBe(false)
  })
})

describe("lockedRedirect", () => {
  it("leaves an unlocked staff member where they are", () => {
    expect(lockedRedirect(staff(), "/counter/scan")).toBeNull()
    expect(lockedRedirect(null, "/counter/scan")).toBeNull()
  })

  it("sends a locked staff member to the password screen from every route", () => {
    const locked = staff({ must_change_password: true })
    for (const path of [
      "/counter",
      "/counter/scan",
      "/counter/stock/new",
      "/counter/trade/abc/receipt",
      "/counter/settings",
    ]) {
      expect(lockedRedirect(locked, path)).toBe(PASSWORD_PATH)
    }
  })

  it("does not bounce the password screen into itself", () => {
    const locked = staff({ must_change_password: true })
    expect(lockedRedirect(locked, PASSWORD_PATH)).toBeNull()
    expect(lockedRedirect(locked, `${PASSWORD_PATH}/`)).toBeNull()
  })

  it("does not mistake a route that merely starts with the same letters", () => {
    const locked = staff({ must_change_password: true })
    expect(lockedRedirect(locked, "/counter/passwords-report")).toBe(PASSWORD_PATH)
  })
})

describe("checkNewPassword", () => {
  const good = {
    current: "seeded-temporary-password",
    next: "a-brand-new-counter-password",
    confirm: "a-brand-new-counter-password",
  }

  it("passes a long, different, matching password", () => {
    expect(checkNewPassword(good)).toBeNull()
  })

  it("asks for the current password first", () => {
    expect(checkNewPassword({ ...good, current: "" })).toEqual({
      field: "current",
      message: "Enter your current password.",
    })
  })

  it("refuses a new password under twelve characters, under the new field", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1)
    expect(checkNewPassword({ ...good, next: short, confirm: short })).toEqual({
      field: "next",
      message: PASSWORD_REFUSAL,
    })
  })

  it("accepts exactly twelve characters", () => {
    const twelve = "a".repeat(MIN_PASSWORD_LENGTH)
    expect(checkNewPassword({ ...good, next: twelve, confirm: twelve })).toBeNull()
  })

  it("refuses the password already on the account, in the same words", () => {
    expect(
      checkNewPassword({ ...good, next: good.current, confirm: good.current })
    ).toEqual({ field: "next", message: PASSWORD_REFUSAL })
  })

  it("says so under the second field when the two do not match", () => {
    expect(checkNewPassword({ ...good, confirm: "something-else-entirely" })).toEqual({
      field: "confirm",
      message: "The two new passwords are different. Type the same one twice.",
    })
  })
})
