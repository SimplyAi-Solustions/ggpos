import { ClientResponseError } from "pocketbase"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { resetNet } from "@/lib/offline/net"
import {
  dismissConflict,
  enqueue,
  queueSnapshot,
  replayQueue,
  resetQueue,
  type QueuedEntry,
} from "@/lib/offline/queue"
import { memoryStore } from "@/lib/offline/store"
import type { CompleteSalePayload } from "@/lib/api/types"

/**
 * jsdom has no IndexedDB, and a queue that only works with one would be a
 * queue that quietly loses sales in private browsing. Both run on the same
 * store interface, so the memory store is the whole surface under test.
 */

function payload(item: string, price: number): CompleteSalePayload {
  return {
    lines: [{ item, qty: 1, unit_price: price, discount: 0 }],
    customer: null,
    payment: "cash",
    payment_split: { cash: price },
    discount: 0,
    discount_source: null,
    reward_code: null,
    cash_session: null,
    sumup_ref: "",
  }
}

function sale(id: string, item: string, price: number, at: string) {
  return {
    id,
    work: { kind: "mark_sold" as const, body: payload(item, price) },
    summary: `Sale, 1 item`,
    total: price,
    lines: [{ itemId: item, qty: 1, unitPrice: price }],
    queuedAt: at,
  }
}

/** The shape docs/api-contract.md sends for a 409. */
function refusal(status: number, message: string): ClientResponseError {
  return new ClientResponseError({
    status,
    response: { code: status, message, data: {} },
  })
}

/** A request that never reached anybody. */
function dropped(): ClientResponseError {
  return new ClientResponseError({ status: 0, response: {}, isAbort: false })
}

describe("the offline queue", () => {
  beforeEach(async () => {
    resetNet()
    await resetQueue(memoryStore())
  })

  it("holds an action and reports it", async () => {
    await enqueue(sale("a", "item_1", 32499, "2026-09-20T10:00:00.000Z"))

    expect(queueSnapshot().pending).toHaveLength(1)
    expect(queueSnapshot().pending[0]!.total).toBe(32499)
    expect(queueSnapshot().conflicts).toHaveLength(0)
  })

  it("replays in the order the sales were taken, not the order they arrived", async () => {
    await enqueue(sale("late", "item_2", 100, "2026-09-20T10:05:00.000Z"))
    await enqueue(sale("early", "item_1", 200, "2026-09-20T10:01:00.000Z"))

    const seen: string[] = []
    const report = await replayQueue(async (entry: QueuedEntry) => {
      seen.push(entry.id)
    })

    expect(seen).toEqual(["early", "late"])
    expect(report.sent).toBe(2)
    expect(queueSnapshot().pending).toHaveLength(0)
  })

  it("stops at the first refusal and keeps the rest waiting", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))
    await enqueue(sale("two", "item_2", 200, "2026-09-20T10:02:00.000Z"))
    await enqueue(sale("three", "item_3", 300, "2026-09-20T10:03:00.000Z"))

    const send = vi.fn(async (entry: QueuedEntry) => {
      if (entry.id === "two") throw refusal(409, "That item is already sold.")
    })
    const report = await replayQueue(send)

    expect(send).toHaveBeenCalledTimes(2)
    expect(report.sent).toBe(1)
    expect(report.conflict?.message).toBe("That item is already sold.")
    expect(queueSnapshot().conflicts.map((c) => c.entry.id)).toEqual(["two"])
    expect(queueSnapshot().pending.map((entry) => entry.id)).toEqual(["three"])
  })

  it("treats a sentence written for staff as a refusal, whoever wrote it", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))

    // Demo mode raises a plain Error with the same words the route sends.
    const report = await replayQueue(async () => {
      throw new Error("That item is already sold.")
    })

    expect(report.conflict?.message).toBe("That item is already sold.")
    expect(queueSnapshot().pending).toHaveLength(0)
  })

  it("keeps a browser fetch failure out of the conflicts", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))

    const report = await replayQueue(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.")
    })

    expect(report.offline).toBe(true)
    expect(report.conflict).toBeNull()
    expect(queueSnapshot().pending).toHaveLength(1)
  })

  it("keeps an action that reached nobody, without making it a conflict", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))

    const report = await replayQueue(async () => {
      throw dropped()
    })

    expect(report.offline).toBe(true)
    expect(report.conflict).toBeNull()
    expect(queueSnapshot().pending).toHaveLength(1)
    expect(queueSnapshot().conflicts).toHaveLength(0)
  })

  it("holds one action per client id, however many times it is queued", async () => {
    const first = await enqueue(sale("same", "item_1", 100, "2026-09-20T10:01:00.000Z"))
    const second = await enqueue(sale("same", "item_1", 100, "2026-09-20T10:04:00.000Z"))

    expect(second).toBe(first)
    expect(queueSnapshot().pending).toHaveLength(1)
    expect(queueSnapshot().pending[0]!.queuedAt).toBe("2026-09-20T10:01:00.000Z")
  })

  it("sends each action once, even with two replays running", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))
    await enqueue(sale("two", "item_2", 200, "2026-09-20T10:02:00.000Z"))

    const seen: string[] = []
    const send = async (entry: QueuedEntry) => {
      seen.push(entry.id)
      await Promise.resolve()
    }
    const [a, b] = await Promise.all([replayQueue(send), replayQueue(send)])

    expect(seen).toEqual(["one", "two"])
    // The second caller joins the replay already running rather than starting
    // a second one, so both see the same report.
    expect(b).toBe(a)
    expect(queueSnapshot().pending).toHaveLength(0)
  })

  it("does not send a refused action again on the next replay", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))
    await replayQueue(async () => {
      throw refusal(422, "Open a cash session before taking cash.")
    })

    const send = vi.fn(async () => {})
    await replayQueue(send)

    expect(send).not.toHaveBeenCalled()
    expect(queueSnapshot().conflicts).toHaveLength(1)
  })

  it("forgets a conflict once staff have dealt with it", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))
    await replayQueue(async () => {
      throw refusal(409, "That item is already sold.")
    })

    await dismissConflict("one")

    expect(queueSnapshot().conflicts).toHaveLength(0)
    expect(queueSnapshot().pending).toHaveLength(0)
  })

  it("keeps nothing back when everything goes through", async () => {
    await enqueue(sale("one", "item_1", 100, "2026-09-20T10:01:00.000Z"))
    await enqueue({
      id: "labels",
      work: { kind: "queue_labels", itemIds: ["item_1", "item_2"] },
      summary: "2 label jobs",
      queuedAt: "2026-09-20T10:02:00.000Z",
    })

    const report = await replayQueue(async () => {})

    expect(report.sent).toBe(2)
    expect(report.remaining).toBe(0)
  })
})
