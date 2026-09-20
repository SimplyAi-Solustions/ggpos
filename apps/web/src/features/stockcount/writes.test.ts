import { describe, expect, it, vi } from "vitest"

import { createWriteQueue } from "@/features/stockcount/writes"
import type { StockCountLine } from "@/lib/api/types"

/**
 * Two scans of one card, a moment apart.
 *
 * Both start from the same line, so sending them at once would create the
 * row twice or let the earlier answer land last and lose a count. The queue
 * runs one write per item at a time and hands the next one the id the last
 * came back with, and the close waits for all of them.
 */

function line(overrides: Partial<StockCountLine> = {}): StockCountLine {
  return {
    id: "new:GGS1",
    itemId: "item_1",
    sku: "GGS1",
    title: "Charizard ex",
    detail: "",
    expectedQty: 1,
    scannedQty: 1,
    locationName: "Showcase",
    ...overrides,
  }
}

/** A writer that hands back control, so the test can order the answers. */
function deferredWriter() {
  const calls: { line: StockCountLine; settle: (saved: StockCountLine) => void }[] = []
  const write = vi.fn(
    (row: StockCountLine) =>
      new Promise<StockCountLine>((resolve) => {
        calls.push({ line: row, settle: resolve })
      })
  )
  return { calls, write }
}

describe("writing count lines", () => {
  it("sends one write per item at a time", async () => {
    const { calls, write } = deferredWriter()
    const queue = createWriteQueue(write)

    const first = queue.push(line({ scannedQty: 1 }))
    const second = queue.push(line({ scannedQty: 2 }))

    // The second scan waits: the first has not come back yet.
    expect(write).toHaveBeenCalledTimes(1)
    expect(queue.busy()).toBe(true)

    calls[0]!.settle(line({ id: "count_line_1", scannedQty: 1 }))
    await first

    expect(write).toHaveBeenCalledTimes(2)
    // And it goes out against the row the first one created, not a second.
    expect(calls[1]!.line.id).toBe("count_line_1")
    expect(calls[1]!.line.scannedQty).toBe(2)

    calls[1]!.settle(line({ id: "count_line_1", scannedQty: 2 }))
    await second
    expect(queue.busy()).toBe(false)
  })

  it("lets two different items go at once", async () => {
    const { calls, write } = deferredWriter()
    const queue = createWriteQueue(write)

    void queue.push(line({ itemId: "item_1" }))
    void queue.push(line({ itemId: "item_2", id: "new:GGS2", sku: "GGS2" }))

    expect(write).toHaveBeenCalledTimes(2)
    for (const call of calls) call.settle(line())
  })

  it("still sends the next scan after one fails", async () => {
    const write = vi
      .fn<(row: StockCountLine) => Promise<StockCountLine>>()
      .mockRejectedValueOnce(new Error("That scan did not save."))
      .mockImplementation(async (row) => ({ ...row, id: "count_line_1" }))
    const queue = createWriteQueue(write)

    await expect(queue.push(line({ scannedQty: 1 }))).rejects.toThrow()
    const second = await queue.push(line({ scannedQty: 2 }))

    expect(write).toHaveBeenCalledTimes(2)
    expect(second.id).toBe("count_line_1")
  })

  it("drains before the count is closed on a variance", async () => {
    const { calls, write } = deferredWriter()
    const queue = createWriteQueue(write)

    void queue.push(line({ scannedQty: 1 }))
    let drained = false
    const drain = queue.drain().then(() => {
      drained = true
    })

    await Promise.resolve()
    expect(drained).toBe(false)

    calls[0]!.settle(line({ id: "count_line_1" }))
    await drain

    expect(drained).toBe(true)
    expect(queue.busy()).toBe(false)
  })

  it("drains a queue nothing was ever put in", async () => {
    const queue = createWriteQueue(async (row) => row)
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})
