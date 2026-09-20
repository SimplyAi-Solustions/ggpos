import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  isOffline,
  subscribeNet,
  netSnapshot,
  noteNetworkFailure,
  noteNetworkSuccess,
  registerNetProbe,
  resetNet,
  runNetProbe,
  setSimulatedOffline,
} from "@/lib/offline/net"

/**
 * The flag that says the line is down has to be able to come back up on its
 * own. On a tethered phone `navigator.onLine` never goes false and the
 * browser never fires `online`, so without the probe a single failed
 * request would leave the counter looking offline until somebody reloaded
 * the page.
 */

describe("knowing whether the line is up", () => {
  beforeEach(() => resetNet())

  it("starts online", () => {
    expect(isOffline()).toBe(false)
    expect(netSnapshot().offline).toBe(false)
  })

  it("goes offline on a request that reached nobody", () => {
    noteNetworkFailure()

    expect(isOffline()).toBe(true)
    expect(netSnapshot().offline).toBe(true)
  })

  it("comes back when the probe gets an answer", async () => {
    const probe = vi.fn().mockResolvedValue({ settings: {} })
    registerNetProbe(probe)
    noteNetworkFailure()

    await runNetProbe()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(isOffline()).toBe(false)
  })

  it("stays offline while the probe gets nothing", async () => {
    registerNetProbe(async () => {
      throw new Error("no route to host")
    })
    noteNetworkFailure()

    await runNetProbe()

    expect(isOffline()).toBe(true)
  })

  it("counts a refusal as an answer: the line is up either way", async () => {
    registerNetProbe(async () => {
      // A 403 is the server talking.
      return { code: 403 }
    })
    noteNetworkFailure()

    await runNetProbe()

    expect(isOffline()).toBe(false)
  })

  it("does not probe when nothing has failed", async () => {
    const probe = vi.fn().mockResolvedValue({})
    registerNetProbe(probe)

    await runNetProbe()

    expect(probe).not.toHaveBeenCalled()
  })

  it("does not probe past the demo switch", async () => {
    const probe = vi.fn().mockResolvedValue({})
    registerNetProbe(probe)
    setSimulatedOffline(true)

    await runNetProbe()

    expect(probe).not.toHaveBeenCalled()
    expect(isOffline()).toBe(true)
    setSimulatedOffline(false)
  })

  it("comes back on any answered request, wherever it was made", () => {
    noteNetworkFailure()
    expect(isOffline()).toBe(true)

    noteNetworkSuccess()

    expect(isOffline()).toBe(false)
  })

  it("tells its subscribers when the answer changes, and only then", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeNet(listener)

    noteNetworkFailure()
    noteNetworkFailure()
    noteNetworkSuccess()

    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
