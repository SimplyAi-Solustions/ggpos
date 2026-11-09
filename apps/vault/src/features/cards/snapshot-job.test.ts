/**
 * The daily snapshot job's pure helpers (pb/pb_hooks/lib/vault_snapshots.js):
 * which cards a run picks and in what order, and the dated trend points a
 * Cardmarket rolling average honestly supports.
 */
import { describe, expect, it } from "vitest"

import * as job from "../../../../../pb/pb_hooks/lib/vault_snapshots.js"

describe("selectCards", () => {
  it("orders stock, then open deals, then recent scans, each card once", () => {
    const picked = job.selectCards({ stock: ["a", "b"], deals: ["b", "c"], scans: ["c", "d", "a"] }, [], 10)
    expect(picked.cards).toEqual([
      { id: "a", reason: "stock" },
      { id: "b", reason: "stock" },
      { id: "c", reason: "deals" },
      { id: "d", reason: "scans" },
    ])
    expect(picked.total).toBe(4)
    expect(picked.capped).toBe(false)
  })

  it("skips cards done inside the window and says when it is capped", () => {
    const picked = job.selectCards({ stock: ["a", "b", "c"], deals: [], scans: ["d"] }, ["b"], 2)
    expect(picked.cards.map((c) => c.id)).toEqual(["a", "c"])
    expect(picked.total).toBe(3)
    expect(picked.capped).toBe(true)
  })

  it("ignores blanks and missing pools and defaults the limit", () => {
    const picked = job.selectCards({ stock: ["", "a"] }, [], undefined)
    expect(picked.cards).toEqual([{ id: "a", reason: "stock" }])
    expect(job.RUN_LIMIT).toBeGreaterThan(0)
  })
})

describe("seedPoints", () => {
  it("dates each average at the middle of its own window, oldest first", () => {
    expect(job.seedPoints({ avg1: "756.67", avg7: "500", avg30: "356.4" })).toEqual([
      { basis: "avg30", daysAgo: 15, value: "356.4" },
      { basis: "avg7", daysAgo: 4, value: "500" },
      { basis: "avg1", daysAgo: 1, value: "756.67" },
    ])
  })

  it("leaves out averages that are missing, zero or not numbers", () => {
    expect(job.seedPoints({ avg1: null, avg7: "0", avg30: "abc" })).toEqual([])
    expect(job.seedPoints(undefined)).toEqual([])
    expect(job.seedPoints({ avg7: "12.5" })).toEqual([{ basis: "avg7", daysAgo: 4, value: "12.5" }])
  })
})

describe("ebayWords and dates", () => {
  it("builds the search words without a condition", () => {
    expect(job.ebayWords({ name: "Umbreon VMAX", setName: "Evolving Skies", number: "215", finish: "" })).toBe("Umbreon VMAX Evolving Skies 215")
    expect(job.ebayWords({ name: "Pikachu", setName: "", number: "25", finish: "holo" })).toBe("Pikachu 25 holo")
  })

  it("writes dates the way PocketBase stores them", () => {
    const now = new Date("2026-11-09T05:15:00.000Z")
    expect(job.daysBefore(now, 15)).toBe("2026-10-25T05:15:00.000Z")
    expect(job.pbDate(now)).toBe("2026-11-09 05:15:00.000Z")
  })
})
