import { describe, expect, it } from "vitest"

import { clearRecentScans, readRecentScans, RECENT_SCANS_KEY, RECENT_SCANS_MAX, rememberScan, withScan } from "./history"

const card = (id: string) => ({ id, name: `Card ${id}`, set_name: "Set", number: id, set_total: 100, image_small: "", nm_pence: 100 })

describe("recent scans", () => {
  it("puts the newest first, dedupes by card and caps at twenty", () => {
    let list = withScan([], card("a"), new Date("2026-11-09T10:00:00Z"))
    list = withScan(list, card("b"))
    list = withScan(list, card("a"))
    expect(list.map((e) => e.id)).toEqual(["a", "b"])
    expect(list[0]!.at > "2026-11-09T10:00:00.000Z").toBe(true)
    for (let i = 0; i < 30; i++) list = withScan(list, card(`c${i}`))
    expect(list).toHaveLength(RECENT_SCANS_MAX)
    expect(list[0]!.id).toBe("c29")
  })

  it("round-trips through storage and ignores junk", () => {
    expect(readRecentScans()).toEqual([])
    rememberScan(card("x"))
    rememberScan(card("y"))
    expect(readRecentScans().map((e) => e.id)).toEqual(["y", "x"])
    localStorage.setItem(RECENT_SCANS_KEY, "{not json")
    expect(readRecentScans()).toEqual([])
    localStorage.setItem(RECENT_SCANS_KEY, JSON.stringify([1, null, { id: "ok" }]))
    expect(readRecentScans().map((e) => e.id)).toEqual(["ok"])
    clearRecentScans()
    expect(localStorage.getItem(RECENT_SCANS_KEY)).toBeNull()
  })
})
