import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The lock flag: kept in localStorage so a reload of a locked till comes
 * back locked, and tied to who was signed in when it was set.
 */

let signedIn: { id: string } | null = { id: "staff_demo" }

vi.mock("@/lib/auth", () => ({
  currentStaff: () => signedIn,
}))
const clearStepUp = vi.fn()
vi.mock("@/lib/auth-stepup", () => ({ clearStepUp: () => clearStepUp() }))
const clearOfflineCaches = vi.fn(async () => undefined)
vi.mock("@/lib/offline/caches", () => ({ clearOfflineCaches: () => clearOfflineCaches() }))

const { isCounterLocked, lockCounter, subscribeLock, unlockCounter } = await import(
  "@/features/lock/lock-store"
)

beforeEach(() => {
  signedIn = { id: "staff_demo" }
  window.localStorage.clear()
  unlockCounter()
  clearStepUp.mockClear()
  clearOfflineCaches.mockClear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("the lock flag", () => {
  it("locks and unlocks, and tells whoever is listening", () => {
    const heard = vi.fn()
    const stop = subscribeLock(heard)
    lockCounter()
    expect(isCounterLocked()).toBe(true)
    unlockCounter()
    expect(isCounterLocked()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
  })

  it("survives a reload, because it lives in localStorage", () => {
    lockCounter()
    const stored = JSON.parse(window.localStorage.getItem("gg.counter.locked") ?? "{}")
    expect(stored.staff).toBe("staff_demo")
  })

  it("drops the step-up and the offline caches as it locks", () => {
    lockCounter()
    expect(clearStepUp).toHaveBeenCalled()
    expect(clearOfflineCaches).toHaveBeenCalled()
  })

  it("does not hold somebody else's fresh password sign-in behind the lock", () => {
    lockCounter()
    signedIn = { id: "staff_other" }
    expect(isCounterLocked()).toBe(false)
    signedIn = { id: "staff_demo" }
    expect(isCounterLocked()).toBe(true)
  })
})
