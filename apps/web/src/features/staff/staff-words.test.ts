import { describe, expect, it } from "vitest"

import {
  emailProblem,
  passwordProblem,
  passwordWord,
  pinWord,
  roleWord,
  statusWord,
  summaryLine,
} from "@/features/staff/staff-words"
import type { StaffMember } from "@/lib/api/staff"

const SAM: StaffMember = {
  id: "staff_1",
  name: "Sam Bell",
  email: "sam@ggentertainment.co.uk",
  role: "staff",
  active: true,
  pin_set: true,
  pin_locked: false,
  must_change_password: false,
  created: "2026-10-01T09:00:00.000Z",
}

describe("the staff list in words", () => {
  it("names the role, the status and the PIN", () => {
    expect(roleWord("manager")).toBe("Manager")
    expect(statusWord(SAM)).toBe("Active")
    expect(statusWord({ active: false })).toBe("Inactive")
    expect(pinWord(SAM)).toBe("Set")
    expect(pinWord({ pin_set: false, pin_locked: false })).toBe("None")
    expect(pinWord({ pin_set: true, pin_locked: true })).toBe("Locked")
    expect(passwordWord({ must_change_password: true })).toBe("Must change password")
    expect(passwordWord(SAM)).toBe("")
  })

  it("sums a person up in one line for the phone", () => {
    expect(summaryLine(SAM)).toBe("Staff, PIN set")
    expect(
      summaryLine({ ...SAM, role: "admin", active: false, pin_set: false, must_change_password: true })
    ).toBe("Admin, inactive, PIN none, must change password")
  })

  it("checks a temporary password and an email before anything is sent", () => {
    expect(passwordProblem("short")).toContain("at least 12 characters")
    expect(passwordProblem("a-long-enough-one")).toBeNull()
    expect(emailProblem("not an email")).toBe("That is not an email address. Check it and try again.")
    expect(emailProblem("jo@ggentertainment.co.uk")).toBeNull()
  })
})
