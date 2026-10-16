import { describe, expect, it } from "vitest"

import { cursorEntries, memoryStore } from "@/lib/offline/store"

/**
 * Reading the queue back.
 *
 * jsdom has no IndexedDB, so the cursor is driven by a fake object store
 * that behaves the way a real one does in the case that matters: a write
 * lands while the read is walking. Pairing a `getAllKeys` with a `getAll`
 * would hand back the wrong value under a key when that happens, which in
 * this queue means a sale replayed with another sale's basket.
 */

interface FakeRequest<T> {
  result: T
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

/**
 * An object store whose cursor walks the map one row at a time, running a
 * hook between rows so a test can write underneath it.
 */
function fakeStore(rows: Map<string, unknown>, between?: (at: number) => void) {
  return {
    openCursor() {
      const request: FakeRequest<unknown> = {
        result: null,
        onsuccess: null,
        onerror: null,
      }
      let at = 0
      const step = () => {
        const keys = [...rows.keys()]
        if (at >= keys.length) {
          request.result = null
          request.onsuccess?.()
          return
        }
        const key = keys[at] as string
        request.result = {
          key,
          value: rows.get(key),
          continue: () => {
            at += 1
            between?.(at)
            queueMicrotask(step)
          },
        }
        request.onsuccess?.()
      }
      queueMicrotask(step)
      return request
    },
  } as unknown as IDBObjectStore
}

describe("reading every row in one go", () => {
  it("keeps each value with its own key", async () => {
    const rows = new Map<string, unknown>([
      ["p:one", { id: "one" }],
      ["p:two", { id: "two" }],
    ])

    expect(await cursorEntries(fakeStore(rows))).toEqual([
      ["p:one", { id: "one" }],
      ["p:two", { id: "two" }],
    ])
  })

  it("does not shift values under keys when a write lands mid-read", async () => {
    const rows = new Map<string, unknown>([
      ["p:one", { id: "one" }],
      ["p:two", { id: "two" }],
      ["p:three", { id: "three" }],
    ])
    // A sale settles and another is queued while the read is walking, which
    // is exactly what a replay does to its own store.
    const store = fakeStore(rows, (at) => {
      if (at !== 1) return
      rows.delete("p:two")
      rows.set("p:four", { id: "four" })
    })

    const entries = await cursorEntries<{ id: string }>(store)

    // Whatever the set of rows turned out to be, no value ended up under
    // another row's key.
    for (const [key, value] of entries) {
      expect(key).toBe(`p:${value.id}`)
    }
    expect(entries.map(([key]) => key)).toContain("p:one")
  })

  it("reads what the memory store holds", async () => {
    const store = memoryStore()
    await store.set("p:one", { id: "one" })
    await store.set("p:two", { id: "two" })

    expect(await store.entries()).toEqual([
      ["p:one", { id: "one" }],
      ["p:two", { id: "two" }],
    ])

    await store.remove("p:one")
    expect(await store.entries()).toEqual([["p:two", { id: "two" }]])
  })
})
