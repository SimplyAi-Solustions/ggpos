import { beforeEach, describe, expect, it } from "vitest"
import { buildCode } from "@gg/shared"

import { claim, markFailed, markPrinted, queueBatch, requeue } from "@/lib/api/demo/label-queue"
import { demoLabelJobs, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type { ItemRecord } from "@/lib/api/types"

/** Crockford base 32, which is the only alphabet a GG code is built from. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function codeBody(index: number): string {
  let out = ""
  let left = index
  for (let place = 0; place < 5; place += 1) {
    out = ALPHABET[left % 32] + out
    left = Math.floor(left / 32)
  }
  return out
}

/** A shelf of items, all from one buy-in, for the batch rules. */
function shelf(count: number, tradeIn = "trade_bulk"): ItemRecord[] {
  const made: ItemRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const body = codeBody(index)
    made.push({
      id: `item_bulk_${index}`,
      sku: buildCode("single", body).encoded,
      // A drawer, a kind and a game of their own, so the seeded demo shelf
      // is never caught by a selector meant for these.
      kind: "other",
      game: "game_test",
      title: `Bulk single ${index}`,
      qty: 1,
      price: 100,
      status: "in_stock",
      location: "loc_test_drawer",
      trade_in: tradeIn,
      acquired_at: "2026-09-01T09:00:00.000Z",
    })
  }
  return made
}

beforeEach(() => {
  ensureSeeded()
  demoLabelJobs.length = 0
  const items = itemStore()
  const added = items.filter((item) => item.id.startsWith("item_bulk_"))
  for (const item of added) items.splice(items.indexOf(item), 1)
})

describe("the batch cap", () => {
  it("refuses a run of more than 500 and queues nothing", () => {
    itemStore().push(...shelf(512))
    expect(() => queueBatch({ trade_in: "trade_bulk" })).toThrow(
      "That is 512 labels. Narrow the range to 500 or fewer."
    )
    expect(demoLabelJobs).toHaveLength(0)
  })

  it("takes a run right up to the cap", () => {
    itemStore().push(...shelf(500))
    expect(queueBatch({ trade_in: "trade_bulk" }).queued).toBe(500)
  })
})

describe("what a selector takes", () => {
  it("wants one, and says which are allowed", () => {
    expect(() => queueBatch({})).toThrow(
      "Pick what to print: the items, a buy-in, a date range, a location, a kind or a game."
    )
  })

  it("takes a location, a kind or a game on its own", () => {
    itemStore().push(...shelf(2))
    expect(queueBatch({ location: "loc_test_drawer" }).queued).toBe(2)
    expect(queueBatch({ kind: "other", include_queued: true }).queued).toBe(2)
    expect(queueBatch({ game: "game_test", include_queued: true }).queued).toBe(2)
  })

  it("passes over an item that already has a label waiting", () => {
    itemStore().push(...shelf(2))
    expect(queueBatch({ location: "loc_test_drawer" })).toMatchObject({
      queued: 2,
      skipped: 0,
    })
    expect(queueBatch({ location: "loc_test_drawer" })).toMatchObject({
      queued: 0,
      skipped: 2,
    })
  })

  it("carries the copies and the size the sheet asked for", () => {
    itemStore().push(...shelf(1))
    queueBatch({ location: "loc_test_drawer", copies: 3, template: "sleeve_25x15" })
    expect(demoLabelJobs[0]).toMatchObject({ copies: 3, template: "sleeve_25x15" })
  })
})

describe("claiming and reporting", () => {
  it("gives one device the oldest jobs its roll can print", () => {
    itemStore().push(...shelf(3))
    queueBatch({ location: "loc_test_drawer" })
    const taken = claim("Counter PC", 2, ["toploader_40x20"])
    expect(taken).toHaveLength(2)
    expect(taken.every((job) => job.status === "printing")).toBe(true)
    expect(taken.every((job) => job.printer === "Counter PC")).toBe(true)
    // And nothing of another size is taken.
    expect(claim("Counter PC", 5, ["sleeve_25x15"])).toEqual([])
  })

  it("counts three failures before it gives up on a label", () => {
    itemStore().push(...shelf(1))
    queueBatch({ location: "loc_test_drawer" })
    const [job] = claim("Counter PC", 1)
    expect(markFailed(job.id, "Out of labels")).toBe("queued")
    expect(markFailed(job.id, "Out of labels")).toBe("queued")
    expect(markFailed(job.id, "Out of labels")).toBe("failed")
    expect(requeue(job.id)).toBe("queued")
    expect(demoLabelJobs[0]?.attempts).toBe(0)
  })

  it("refuses a printed call for a job it is not holding", () => {
    itemStore().push(...shelf(1))
    queueBatch({ location: "loc_test_drawer" })
    const [job] = claim("Counter PC", 1)
    expect(markPrinted(job.id)).toBe("printed")
    // The same call again: the job is no longer printing, which the server
    // refuses on purpose, because that label has come out twice.
    expect(() => markPrinted(job.id)).toThrow(
      "That label went back in the queue, so another device may have printed it. Check the label before printing it again."
    )
  })
})
