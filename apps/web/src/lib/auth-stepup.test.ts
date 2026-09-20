import { beforeEach, describe, expect, it, vi } from "vitest"

const getStepUp = vi.fn()

vi.mock("@/lib/api/sales", () => ({ getStepUp }))

const {
  clearStepUp,
  hasStepUp,
  setStepUpPrompt,
  setStepUpToken,
  stepUp,
  StepUpCancelled,
} = await import("@/lib/auth-stepup")

function inMinutes(minutes: number): string {
  const when = new Date()
  when.setMinutes(when.getMinutes() + minutes)
  return when.toISOString()
}

describe("the step-up cache", () => {
  beforeEach(() => {
    clearStepUp()
    getStepUp.mockReset()
  })

  it("asks for the password the first time and caches what comes back", async () => {
    getStepUp.mockResolvedValue({ token: "tok-1", expiresAt: inMinutes(10) })
    const prompt = vi.fn().mockResolvedValue("ggvault-demo")
    const release = setStepUpPrompt(prompt)

    await expect(stepUp()).resolves.toBe("tok-1")
    await expect(stepUp()).resolves.toBe("tok-1")

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(getStepUp).toHaveBeenCalledTimes(1)
    release()
  })

  it("asks again once the ten minutes have run out", async () => {
    setStepUpToken({ token: "stale", expiresAt: inMinutes(-1) })
    expect(hasStepUp()).toBe(false)

    getStepUp.mockResolvedValue({ token: "tok-2", expiresAt: inMinutes(10) })
    const prompt = vi.fn().mockResolvedValue("ggvault-demo")
    const release = setStepUpPrompt(prompt)

    await expect(stepUp()).resolves.toBe("tok-2")
    expect(prompt).toHaveBeenCalledTimes(1)
    release()
  })

  it("treats a token in its last half minute as spent, so nothing expires mid-request", () => {
    setStepUpToken({ token: "nearly", expiresAt: inMinutes(0.2) })
    expect(hasStepUp()).toBe(false)

    setStepUpToken({ token: "fresh", expiresAt: inMinutes(5) })
    expect(hasStepUp()).toBe(true)
  })

  it("throws StepUpCancelled when the dialog is closed, and caches nothing", async () => {
    const prompt = vi.fn().mockResolvedValue(null)
    const release = setStepUpPrompt(prompt)

    await expect(stepUp()).rejects.toBeInstanceOf(StepUpCancelled)
    expect(getStepUp).not.toHaveBeenCalled()
    expect(hasStepUp()).toBe(false)
    release()
  })

  it("keeps no token when the password is refused", async () => {
    getStepUp.mockRejectedValue(new Error("That password is not right. Try again."))
    const prompt = vi.fn().mockResolvedValue("wrong")
    const release = setStepUpPrompt(prompt)

    await expect(stepUp()).rejects.toThrow("That password is not right")
    expect(hasStepUp()).toBe(false)
    release()
  })

  it("clears on demand, for a sign-out", async () => {
    setStepUpToken({ token: "tok", expiresAt: inMinutes(10) })
    expect(hasStepUp()).toBe(true)
    clearStepUp()
    expect(hasStepUp()).toBe(false)
  })
})
