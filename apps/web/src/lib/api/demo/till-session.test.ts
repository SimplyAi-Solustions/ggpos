import { beforeEach, describe, expect, it } from "vitest"

import {
  demoCheckDevice,
  demoGetReport,
  demoListReports,
  demoMovement,
  demoNoSale,
  demoOpenTill,
  demoRegisterDevice,
  demoRevokeDevice,
  demoRunX,
  demoRunZ,
  demoTill,
  getDemoTillCurrent,
  resetDemoTill,
  setDemoThisDevice,
} from "@/lib/api/demo/till-session"
import { resetDemoOverrides } from "@/lib/api/demo/overrides"

/**
 * The demo till, which cashing up and the e2e suite walk. Expected cash is
 * worked the way docs/api-contract-epos.md section 3 defines it: the float,
 * plus cash taken, minus cash refunded, plus paid in, minus paid out,
 * buy-in payouts and bank drops. The morning seeded on the open session:
 * £100.00 float, £19.97 cash taken, £2.49 refunded, a £65.00 payout.
 */

function signInAs(role: string) {
  localStorage.setItem(
    "gg-demo-staff",
    JSON.stringify({ id: `staff_${role}`, role, name: `A ${role}`, email: "" })
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetDemoTill()
  resetDemoOverrides()
  signInAs("admin")
})

describe("the open demo till", () => {
  it("starts open, with a running report", () => {
    const current = getDemoTillCurrent()
    expect(current.session?.float).toBe(10000)
    expect(current.running?.cash.expected).toBe(5248)
    expect(current.running?.sales.net).toBe(15491)
    expect(current.running?.card.till_total).toBe(13243)
    expect(current.running?.number).toBe(0)
  })

  it("numbers X reports on from yesterday's and keeps them", () => {
    const x = demoRunX()
    expect(x.number).toBe(87)
    expect(demoRunX().number).toBe(88)
    expect(demoGetReport(x.id).number).toBe(87)
    expect(demoListReports({ type: "x" }).items.map((row) => row.number)).toEqual([88, 87, 86])
  })

  it("takes paid in and out off the drawer, and refuses more than it holds", () => {
    demoMovement({ type: "paid_in", amount: 1000, reason: "Float top-up" })
    demoMovement({ type: "paid_out", amount: 500, reason: "Milk" })
    expect(getDemoTillCurrent().running?.cash.expected).toBe(5248 + 1000 - 500)
    expect(() => demoMovement({ type: "paid_out", amount: 600, reason: "" })).toThrow(
      "Say what the money was for."
    )
    expect(() => demoMovement({ type: "bank_drop", amount: 6000, reason: "Bag 1" })).toThrow(
      "That is more than the £57.48 the drawer should hold."
    )
  })

  it("asks a member of staff for a manager's approval, the way the server does", () => {
    signInAs("staff")
    expect(() => demoNoSale("Change")).toThrow("A manager needs to approve this.")
    expect(() => demoRunZ({ counts: { "2000": 1 }, card_reported_total: 0 })).toThrow(
      "A manager needs to approve this."
    )
    // An X report is a member of staff's to run.
    expect(demoRunX().type).toBe("x")
  })
})

describe("the Z", () => {
  it("refuses an empty count and a missing Tide total on a day that took card", () => {
    expect(() => demoRunZ({ counts: {}, card_reported_total: 13243 })).toThrow(
      "Count the drawer before closing the till."
    )
    expect(() => demoRunZ({ counts: { "2000": 2 }, card_reported_total: null })).toThrow(
      "Enter the Tide card total for today from the Tide app."
    )
  })

  it("closes the session on the full count, less any bank drop taken from it", () => {
    // £109.60 counted, £50.00 to the bank: £59.60 stays against £2.48.
    const { report } = demoRunZ({
      counts: { "2000": 3, "1000": 2, "500": 4, "100": 6, "50": 3, "20": 8, "10": 5 },
      card_reported_total: 13000,
      bank_drop: 5000,
      notes: "Bag 14",
    })
    expect(report.type).toBe("z")
    expect(report.number).toBe(42)
    expect(report.cash.bank_drops).toBe(5000)
    expect(report.cash.expected).toBe(248)
    expect(report.cash.counted).toBe(5960)
    expect(report.cash.variance).toBe(5712)
    expect(report.card.variance).toBe(-243)
    expect(report.notes).toBe("Bag 14")
    expect(demoTill.session).toBeNull()
    expect(getDemoTillCurrent().running).toBeNull()
  })

  it("refuses a bank drop bigger than the count", () => {
    expect(() =>
      demoRunZ({ counts: { "2000": 1 }, card_reported_total: 13243, bank_drop: 2500 })
    ).toThrow("The bank drop cannot be more than the £20.00 counted.")
  })

  it("opens again on a counted float, and refuses a second open", () => {
    demoRunZ({ counts: { "2000": 2 }, card_reported_total: 13243 })
    expect(() => demoMovement({ type: "paid_in", amount: 100, reason: "x" })).toThrow(
      "Open the till first."
    )
    const session = demoOpenTill({ counts: { "2000": 2, "500": 4 } })
    expect(session.float).toBe(6000)
    expect(getDemoTillCurrent().running?.sales.count).toBe(0)
    expect(() => demoOpenTill({ float: 10000 })).toThrow(
      "The till is already open. Close it with a Z report first."
    )
  })
})

describe("till devices", () => {
  it("treats the demo browser as a till until it is forgotten", () => {
    expect(demoCheckDevice().device.id).toBe("device_demo")
    setDemoThisDevice(null)
    expect(() => demoCheckDevice()).toThrow(/This device is not registered as a till/)
  })

  it("registers a device to an active register and refuses it once revoked", () => {
    expect(() => demoRegisterDevice({ register: "register_demo", label: " " })).toThrow(
      "Give this device a name, for example Counter Mac."
    )
    const { device, secret } = demoRegisterDevice({ register: "register_demo", label: "Counter Mac" })
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    setDemoThisDevice({ ...device, secret })
    expect(demoCheckDevice().device.label).toBe("Counter Mac")
    demoRevokeDevice(device.id)
    expect(() => demoCheckDevice()).toThrow(/not registered as a till/)
  })
})
