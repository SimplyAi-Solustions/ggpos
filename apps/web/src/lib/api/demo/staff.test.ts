import { beforeEach, describe, expect, it } from "vitest"

import {
  DEMO_MANAGER,
  DEMO_MEMBER,
  DEMO_PINS,
  demoChangePassword,
  demoClearStaffPin,
  demoCreateStaff,
  demoListStaff,
  demoOverride,
  demoPasswordMatches,
  demoRoster,
  demoSetStaffPin,
  demoSignIn,
  demoUnlock,
  demoUpdateStaff,
  resetDemoStaff,
} from "@/lib/api/demo/staff"
import { demoRequire, resetDemoOverrides } from "@/lib/api/demo/overrides"
import { DEMO_LOCKED_STAFF, DEMO_STAFF } from "@/lib/api/fixtures"

/**
 * The demo counter's staff accounts, which are what the e2e suite's
 * proof of the first-sign-in lock, the PIN lock and manager approval rests
 * on: one ordinary admin, a manager and a member of staff with PINs, and
 * one admin still on a password somebody else chose. Each has to behave
 * the way the server does, or the demo would prove nothing about the real
 * thing.
 */

beforeEach(() => {
  resetDemoStaff()
  resetDemoOverrides()
  localStorage.clear()
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

function signInAs(id: string, role: string) {
  localStorage.setItem("gg-demo-staff", JSON.stringify({ id, role, name: "", email: "" }))
}

describe("the PIN lock in demo mode", () => {
  it("lists active staff by name, with their initials and PIN length, never the PIN", () => {
    const roster = demoRoster()
    expect(roster.register.name).toBe("Counter")
    expect(roster.staff.map((entry) => entry.name)).toEqual([
      "Demo Counter",
      "Mo Khan",
      "New Starter",
      "Sam Bell",
    ])
    const sam = roster.staff.find((entry) => entry.id === DEMO_MEMBER.id)
    expect(sam).toMatchObject({ initials: "SB", pin_set: true, pin_length: 6, role: "staff" })
    expect(JSON.stringify(roster)).not.toContain(DEMO_PINS[DEMO_MEMBER.id]!)
    expect(roster.staff.find((entry) => entry.name === "New Starter")?.pin_set).toBe(false)
  })

  it("unlocks with the right PIN and hands back a grant the demo sign-in takes once", () => {
    const auth = demoUnlock(DEMO_MANAGER.id, "1357")
    expect(auth.record.id).toBe(DEMO_MANAGER.id)
    expect(demoSignIn(DEMO_MANAGER.email, auth.token)?.role).toBe("manager")
    // Once, and only once.
    expect(demoSignIn(DEMO_MANAGER.email, auth.token)).toBeNull()
  })

  it("counts wrong PINs down and locks on the fifth, then counts nothing", () => {
    for (const left of [4, 3, 2]) {
      expect(() => demoUnlock(DEMO_MEMBER.id, "111111")).toThrow(
        `That PIN is not right. ${left} tries left.`
      )
    }
    expect(() => demoUnlock(DEMO_MEMBER.id, "111111")).toThrow("That PIN is not right. 1 try left.")
    expect(() => demoUnlock(DEMO_MEMBER.id, "111111")).toThrow(/^Too many wrong PINs/)
    // Locked: even the right PIN is refused.
    expect(() => demoUnlock(DEMO_MEMBER.id, "482916")).toThrow(/^Too many wrong PINs/)
    expect(demoRoster().staff.find((entry) => entry.id === DEMO_MEMBER.id)?.pin_locked).toBe(true)

    // A password sign-in clears the lock.
    expect(demoSignIn(DEMO_MEMBER.email, DEMO_MEMBER.password)).not.toBeNull()
    expect(demoUnlock(DEMO_MEMBER.id, "482916").record.id).toBe(DEMO_MEMBER.id)
  })

  it("says who has no PIN, by name", () => {
    expect(() => demoUnlock(DEMO_LOCKED_STAFF.id, "1357")).toThrow(
      "New Starter has no PIN yet. Sign in with a password to set one."
    )
  })

  it("lets a manager approve for staff, but not for themselves or past their role", () => {
    signInAs(DEMO_MEMBER.id, "staff")
    const grant = demoOverride({ capability: "no_sale", approver: DEMO_MANAGER.id, pin: "1357" })
    expect(grant.capability).toBe("no_sale")
    expect(grant.approver.name).toBe("Mo Khan")

    expect(() =>
      demoOverride({ capability: "refund", approver: DEMO_MEMBER.id, pin: "482916" })
    ).toThrow("You cannot approve your own request. Ask somebody else to key their PIN.")
    expect(() =>
      demoOverride({ capability: "staff_manage", approver: DEMO_STAFF.id, pin: "2580" })
    ).toThrow("That needs an admin signed in.")

    signInAs(DEMO_STAFF.id, "admin")
    expect(() =>
      demoOverride({ capability: "refund", approver: DEMO_MEMBER.id, pin: "482916" })
    ).toThrow("Sam Bell cannot approve that. Ask somebody who can give a refund.")
  })

  it("spends an approval on one call of the capability it was given for", () => {
    signInAs(DEMO_MEMBER.id, "staff")
    expect(() => demoRequire("no_sale")).toThrow("A manager needs to approve this.")
    const grant = demoOverride({ capability: "no_sale", approver: DEMO_MANAGER.id, pin: "1357" })
    const headers = { "X-GG-Override": grant.token }
    expect(() => demoRequire("paid_in_out", headers)).toThrow("A manager needs to approve this.")
    expect(() => demoRequire("no_sale", headers)).not.toThrow()
    expect(() => demoRequire("no_sale", headers)).toThrow("A manager needs to approve this.")
  })
})

describe("staff management in demo mode", () => {
  it("adds somebody on a temporary password they must change", () => {
    const added = demoCreateStaff({
      name: "Jo Price",
      email: "Jo@GGentertainment.co.uk",
      role: "manager",
      password: "a-temporary-password",
    })
    expect(added).toMatchObject({
      email: "jo@ggentertainment.co.uk",
      must_change_password: true,
      pin_set: false,
    })
    expect(() =>
      demoCreateStaff({
        name: "Mo",
        email: DEMO_MANAGER.email,
        role: "staff",
        password: "a-temporary-password",
      })
    ).toThrow("Somebody already uses that email.")
  })

  it("keeps at least one active admin", () => {
    demoUpdateStaff(DEMO_LOCKED_STAFF.id, { role: "staff" })
    expect(() => demoUpdateStaff(DEMO_STAFF.id, { active: false })).toThrow(
      "There has to be at least one active admin."
    )
    expect(demoListStaff().find((member) => member.id === DEMO_STAFF.id)?.active).toBe(true)
  })

  it("sets a PIN with the shared rules, and clears it", () => {
    expect(() => demoSetStaffPin(DEMO_LOCKED_STAFF.id, "1234")).toThrow(/run or a repeat/)
    demoSetStaffPin(DEMO_LOCKED_STAFF.id, "640517")
    expect(demoUnlock(DEMO_LOCKED_STAFF.id, "640517").record.id).toBe(DEMO_LOCKED_STAFF.id)
    demoClearStaffPin(DEMO_LOCKED_STAFF.id)
    expect(demoListStaff().find((member) => member.id === DEMO_LOCKED_STAFF.id)?.pin_set).toBe(false)
  })

  it("leaves an inactive member off the roster, and out of the counter", () => {
    demoUpdateStaff(DEMO_MEMBER.id, { active: false })
    expect(demoRoster().staff.map((entry) => entry.id)).not.toContain(DEMO_MEMBER.id)
    expect(demoSignIn(DEMO_MEMBER.email, DEMO_MEMBER.password)).toBeNull()
  })
})
