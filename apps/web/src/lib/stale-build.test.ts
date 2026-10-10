import { describe, expect, it, vi } from "vitest"

import { claimStaleBuildReload, watchForStaleBuild } from "@/lib/stale-build"

function memoryStore() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function fakeWindow(store: Storage | undefined) {
  const target = new EventTarget()
  const reload = vi.fn()
  const win = {
    addEventListener: (type: "vite:preloadError", listener: (event: Event) => void) =>
      target.addEventListener(type, listener),
    location: { reload },
    sessionStorage: store,
  }
  const fail = () => {
    const event = new Event("vite:preloadError", { cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  return { win, reload, fail }
}

describe("a screen from an older build", () => {
  it("reloads once, and not again within the minute", () => {
    const store = memoryStore()
    expect(claimStaleBuildReload(store, 1_000_000)).toBe(true)
    expect(claimStaleBuildReload(store, 1_030_000)).toBe(false)
    expect(claimStaleBuildReload(store, 1_061_000)).toBe(true)
  })

  it("still reloads when storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    expect(claimStaleBuildReload(refusing, 5)).toBe(true)
    expect(claimStaleBuildReload(null, 5)).toBe(true)
  })

  it("reloads the page and stops the error, then lets a repeat show", () => {
    const store = memoryStore() as unknown as Storage
    const { win, reload, fail } = fakeWindow(store)
    watchForStaleBuild(win)

    const first = fail()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)

    const second = fail()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(false)
  })
})
