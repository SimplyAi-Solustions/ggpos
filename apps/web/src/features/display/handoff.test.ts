import { describe, expect, it } from "vitest"

import {
  handoffSentence,
  handoffSettled,
  type DisplayHandoff,
} from "@/features/display/handoff"

const STATES: DisplayHandoff[] = ["off", "idle", "waiting", "accepted", "skipped"]

describe("handoffSettled", () => {
  it("holds the signature back only while the offer is with the customer", () => {
    expect(STATES.filter(handoffSettled)).toEqual(["off", "accepted", "skipped"])
  })
})

describe("handoffSentence", () => {
  it("says what is happening in each state, without an exclamation", () => {
    expect(handoffSentence("waiting")).toBe(
      "On the display now. It is signed here once the customer accepts it."
    )
    expect(handoffSentence("accepted")).toBe(
      "Accepted on the display. Take their signature below."
    )
    expect(handoffSentence("skipped")).toBe(
      "Taken verbally. Take their signature below."
    )
    expect(handoffSentence("idle")).toBe(
      "Send the offer to the screen facing the customer, and they accept it there."
    )
    for (const state of STATES) {
      expect(handoffSentence(state)).not.toContain("!")
    }
  })
})
