import { describe, expect, it } from "vitest"

import { counterTilt, guideLine, shouldAutoCapture } from "./capture-guide"

describe("guideLine", () => {
  it("says the brief's words, in order of what to fix", () => {
    expect(guideLine({ kind: "issue", issue: "dark" })).toEqual({ text: "Find better light", tone: "warn" })
    expect(guideLine({ kind: "issue", issue: "moving" }).text).toBe("Hold still")
    expect(guideLine({ kind: "issue", issue: "tilted" }).text).toBe("Hold level")
    expect(guideLine({ kind: "issue", issue: "glare" }).text).toBe("Too much glare. Tilt the card away from the light")
    expect(guideLine({ kind: "issue", issue: "blurry" }).text).toBe("Move a little further back to focus")
    expect(guideLine({ kind: "ready" })).toEqual({ text: "Ready to scan", tone: "ready" })
  })

  it("asks to line the card up before the first frame", () => {
    expect(guideLine(null).tone).toBe("neutral")
  })
})

describe("counterTilt", () => {
  it("checks tilt over the counter and skips it when the card is held up", () => {
    expect(counterTilt(5, -20)).toBe(20)
    expect(counterTilt(80, 2)).toBeNull()
    expect(counterTilt(null, null)).toBeNull()
  })
})

describe("shouldAutoCapture", () => {
  it("fires only after the guide has held green for the hold time", () => {
    expect(shouldAutoCapture(null, 5000)).toBe(false)
    expect(shouldAutoCapture(1000, 1500)).toBe(false)
    expect(shouldAutoCapture(1000, 1700)).toBe(true)
  })
})
