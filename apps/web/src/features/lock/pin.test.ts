import { describe, expect, it } from "vitest"
import { ClientResponseError } from "pocketbase"

import { NOT_A_TILL, NO_ANSWER, pressPinKey, readRefusal } from "@/features/lock/pin"
import { approvalLine, firstName, pinNote } from "@/features/lock/roster"

function refusal(status: number, message: string) {
  return new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

describe("keying a PIN", () => {
  it("keeps a leading zero, which the money keypad would drop", () => {
    let pin = ""
    for (const key of ["0", "2", "5", "8"] as const) pin = pressPinKey(pin, key, 4)
    expect(pin).toBe("0258")
  })

  it("stops at the PIN's length", () => {
    expect(pressPinKey("2580", "1", 4)).toBe("2580")
    expect(pressPinKey("48291", "6", 6)).toBe("482916")
  })

  it("drops one digit, clears the lot, and ignores the double zero", () => {
    expect(pressPinKey("258", "back", 4)).toBe("25")
    expect(pressPinKey("258", "clear", 4)).toBe("")
    expect(pressPinKey("25", "00", 4)).toBe("25")
  })
})

describe("reading a refusal", () => {
  it("keeps the server's sentence for a wrong PIN", () => {
    expect(readRefusal(refusal(401, "That PIN is not right. 3 tries left."))).toEqual({
      kind: "wrong",
      message: "That PIN is not right. 3 tries left.",
    })
  })

  it("tells a revoked device from a wrong PIN, though both are 401", () => {
    expect(
      readRefusal(
        refusal(
          401,
          "This device is not registered as a till. Sign in with a password and register it under Settings."
        )
      )
    ).toEqual({ kind: "device", message: NOT_A_TILL })
  })

  it("knows a locked PIN, no PIN and a refusal to approve", () => {
    expect(readRefusal(refusal(423, "Too many wrong PINs.")).kind).toBe("locked")
    expect(readRefusal(refusal(409, "Sam Bell has no PIN yet.")).kind).toBe("no_pin")
    expect(readRefusal(refusal(403, "Mo Khan cannot approve that.")).kind).toBe("refused")
  })

  it("says the connection is down when nothing answered", () => {
    expect(readRefusal(new TypeError("Failed to fetch"))).toEqual({ kind: "network", message: NO_ANSWER })
    expect(readRefusal(new ClientResponseError({ status: 0 })).kind).toBe("network")
  })
})

describe("the roster's words", () => {
  it("takes the first name for the tile", () => {
    expect(firstName("Mo Khan")).toBe("Mo")
    expect(firstName("  Cher ")).toBe("Cher")
  })

  it("says why a PIN cannot be used", () => {
    expect(pinNote({ pin_set: true, pin_locked: false })).toBeNull()
    expect(pinNote({ pin_set: false, pin_locked: false })).toBe("No PIN")
    expect(pinNote({ pin_set: true, pin_locked: true })).toBe("PIN locked")
  })

  it("says what an approval is for, from the caller or the capability", () => {
    expect(approvalLine({ capability: "refund", description: "Give a refund of £12.00" })).toBe(
      "Give a refund of £12.00"
    )
    expect(approvalLine({ capability: "no_sale", description: "" })).toBe(
      "Open the drawer with no sale"
    )
  })
})
