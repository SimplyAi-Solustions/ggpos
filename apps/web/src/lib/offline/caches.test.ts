import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearOfflineCaches,
  RUNTIME_CACHE_NAMES,
  RUNTIME_CACHES,
} from "@/lib/offline/caches"

/**
 * The service worker's read-through caches hold the stock list and the
 * customers' names and codes, fetched under whoever was signed in. The
 * counter PC is shared, so signing out and the idle lock both empty them.
 */

const remove = vi.fn()

beforeEach(() => {
  remove.mockReset()
  remove.mockResolvedValue(true)
  ;(globalThis as { caches?: unknown }).caches = { delete: remove }
})

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches
  vi.resetModules()
})

describe("clearing what the worker kept", () => {
  it("deletes each runtime cache by name", async () => {
    await clearOfflineCaches()

    expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(
      [...RUNTIME_CACHE_NAMES].sort()
    )
    expect(RUNTIME_CACHE_NAMES).toContain(RUNTIME_CACHES.customers)
  })

  it("does nothing where there is no cache storage", async () => {
    delete (globalThis as { caches?: unknown }).caches

    await expect(clearOfflineCaches()).resolves.toBeUndefined()
    expect(remove).not.toHaveBeenCalled()
  })

  it("survives a browser that refuses to delete", async () => {
    remove.mockRejectedValue(new Error("Denied in private browsing."))

    await expect(clearOfflineCaches()).resolves.toBeUndefined()
  })

  it("is emptied when a staff member signs out", async () => {
    vi.resetModules()
    vi.doMock("@/lib/pb", () => ({
      pb: {
        authStore: {
          record: null,
          isValid: false,
          onChange: () => {},
          clear: () => {},
        },
      },
      pingPocketBase: async () => true,
    }))
    const { setDataMode } = await import("@/lib/api/mode")
    const { logout } = await import("@/lib/auth")
    setDataMode(true)

    logout()
    await Promise.resolve()

    expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(
      [...RUNTIME_CACHE_NAMES].sort()
    )
    vi.doUnmock("@/lib/pb")
  })
})
