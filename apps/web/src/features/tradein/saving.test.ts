import { describe, expect, it } from "vitest"

import {
  UNSAVED,
  needsSave,
  nextSavedShape,
} from "@/features/tradein/saving"

/**
 * When the wizard writes its lines, and what it remembers having written.
 *
 * The rule that matters: a shape is only remembered once the server has it.
 * Remembering it before the request is what loses a line, because the next
 * change looks identical to one already saved.
 */

describe("needsSave", () => {
  it("saves a shape the server has not seen", () => {
    expect(needsSave("[a]", "[]", false)).toBe(true)
  })

  it("leaves a shape the server already has", () => {
    expect(needsSave("[a]", "[a]", false)).toBe(false)
  })

  it("waits while a save is already in flight", () => {
    expect(needsSave("[a]", "[]", true)).toBe(false)
  })

  it("retries the same shape after a failure", () => {
    // The failure marks the memory as the sentinel, which never equals a
    // real shape, so the unchanged lines are written again.
    const afterFailure = nextSavedShape("failed", "[a]")
    expect(afterFailure).toBe(UNSAVED)
    expect(needsSave("[a]", afterFailure, false)).toBe(true)
  })

  it("stops once a retry succeeds", () => {
    const afterSuccess = nextSavedShape("saved", "[a]")
    expect(afterSuccess).toBe("[a]")
    expect(needsSave("[a]", afterSuccess, false)).toBe(false)
  })

  it("never mistakes the sentinel for a real shape", () => {
    expect(needsSave(UNSAVED, UNSAVED, false)).toBe(false)
    expect(UNSAVED).not.toBe("[]")
    expect(UNSAVED).not.toBe("")
  })
})

describe("nextSavedShape", () => {
  it("remembers a shape only once the server has it", () => {
    expect(nextSavedShape("saved", "[a]")).toBe("[a]")
  })

  it("forgets a shape the server refused", () => {
    expect(nextSavedShape("failed", "[a]")).toBe(UNSAVED)
  })
})
