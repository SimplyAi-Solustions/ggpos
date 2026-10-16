import { describe, expect, it } from "vitest"

import {
  HOUR_PX,
  blockBox,
  dropTarget,
  frameFor,
  frameHeight,
  hourMarks,
  isDrag,
  laneLayout,
  nowTop,
} from "@/features/bookings/layout"

const HOUR = 3_600_000

/** 16 October 2026 is in British Summer Time: 10:00 shop time is 09:00 UTC. */
function slot(start: string, end: string) {
  return { starts_at: `2026-10-16T${start}:00.000Z`, ends_at: `2026-10-16T${end}:00.000Z`, free: true }
}

function window(start: string, end: string) {
  return { starts_at: `2026-10-16T${start}:00.000Z`, ends_at: `2026-10-16T${end}:00.000Z` }
}

const RESOURCE = {
  id: "t1",
  name: "Table 1",
  kind: "table" as const,
  capacity: 6,
  slot_minutes: 60,
  price: 500,
  member_price: 400,
  deposit: null,
}

describe("frameFor", () => {
  it("runs from the first slot to the last, on whole hours", () => {
    const frame = frameFor({
      resources: [
        { resource: RESOURCE, slots: [slot("09:00", "10:00"), slot("10:00", "11:00")] },
        { resource: { ...RESOURCE, id: "t2" }, slots: [slot("10:30", "11:30")] },
      ],
    })
    expect(frame).toEqual({
      start: Date.parse("2026-10-16T09:00:00.000Z"),
      end: Date.parse("2026-10-16T12:00:00.000Z"),
    })
    expect(frameHeight(frame!)).toBe(3 * HOUR_PX)
  })

  it("is null on a day nothing is open", () => {
    expect(frameFor({ resources: [{ resource: RESOURCE, slots: [] }] })).toBeNull()
    expect(frameFor(undefined)).toBeNull()
  })
})

describe("hourMarks", () => {
  it("labels each hour on the shop's clock, not UTC", () => {
    const frame = { start: Date.parse("2026-10-16T09:00:00.000Z"), end: Date.parse("2026-10-16T12:00:00.000Z") }
    expect(hourMarks(frame).map((mark) => [mark.top, mark.label])).toEqual([
      [0, "10:00"],
      [HOUR_PX, "11:00"],
      [2 * HOUR_PX, "12:00"],
    ])
  })

  it("reads GMT after the clocks go back", () => {
    // 2 November 2026: GMT, so 10:00 UTC is 10:00 in the shop.
    const frame = { start: Date.parse("2026-11-02T10:00:00.000Z"), end: Date.parse("2026-11-02T11:00:00.000Z") }
    expect(hourMarks(frame)[0]?.label).toBe("10:00")
  })
})

describe("blockBox", () => {
  const frame = { start: Date.parse("2026-10-16T09:00:00.000Z"), end: Date.parse("2026-10-16T13:00:00.000Z") }

  it("places a booking by its start and length", () => {
    expect(blockBox(window("10:00", "11:30"), frame)).toEqual({ top: HOUR_PX, height: 1.5 * HOUR_PX })
  })

  it("clips a block that runs past the grid, and drops one off it", () => {
    expect(blockBox(window("12:00", "14:00"), frame)).toEqual({ top: 3 * HOUR_PX, height: HOUR_PX })
    expect(blockBox(window("14:00", "15:00"), frame)).toBeNull()
  })

  it("puts now on the grid only when it is inside it", () => {
    expect(nowTop(frame, Date.parse("2026-10-16T09:30:00.000Z"))).toBe(HOUR_PX / 2)
    expect(nowTop(frame, Date.parse("2026-10-16T08:00:00.000Z"))).toBeNull()
  })
})

describe("laneLayout", () => {
  it("gives a block that overlaps nothing the whole column", () => {
    const placed = laneLayout([window("10:00", "11:00"), window("11:00", "12:00")])
    expect(placed.map((entry) => [entry.lane, entry.lanes])).toEqual([
      [0, 1],
      [0, 1],
    ])
  })

  it("sets overlapping blocks side by side, as narrow as the busiest moment needs", () => {
    const a = window("10:00", "12:00")
    const b = window("10:30", "11:00")
    const c = window("11:00", "11:30")
    const d = window("13:00", "14:00")
    const placed = laneLayout([d, c, b, a])
    const by = (item: typeof a) => placed.find((entry) => entry.item === item)
    expect(by(a)).toMatchObject({ lane: 0, lanes: 2 })
    expect(by(b)).toMatchObject({ lane: 1, lanes: 2 })
    // c starts as b ends, so it takes b's lane again.
    expect(by(c)).toMatchObject({ lane: 1, lanes: 2 })
    expect(by(d)).toMatchObject({ lane: 0, lanes: 1 })
  })

  it("opens a third lane when three overlap at once", () => {
    const placed = laneLayout([window("10:00", "12:00"), window("10:00", "11:00"), window("10:30", "11:30")])
    expect(new Set(placed.map((entry) => entry.lane))).toEqual(new Set([0, 1, 2]))
    expect(placed.every((entry) => entry.lanes === 3)).toBe(true)
  })
})

describe("dropTarget", () => {
  const frame = { start: Date.parse("2026-10-16T09:00:00.000Z"), end: Date.parse("2026-10-16T19:00:00.000Z") }
  const base = {
    startMs: Date.parse("2026-10-16T11:00:00.000Z"),
    endMs: Date.parse("2026-10-16T12:00:00.000Z"),
    columnIndex: 1,
    columnCount: 4,
    columnWidth: 132,
    stepMinutes: 60,
    frame,
  }

  it("snaps down the column to the nearest slot", () => {
    const target = dropTarget({ ...base, dx: 0, dy: HOUR_PX * 2 + 20 })
    expect(new Date(target.startMs).toISOString()).toBe("2026-10-16T13:00:00.000Z")
    expect(target.endMs - target.startMs).toBe(HOUR)
    expect(target.columnIndex).toBe(1)
    expect(target.same).toBe(false)
  })

  it("moves across to the column under the pointer, and no further than the last", () => {
    expect(dropTarget({ ...base, dx: 140, dy: 0 }).columnIndex).toBe(2)
    expect(dropTarget({ ...base, dx: -400, dy: 0 }).columnIndex).toBe(0)
    expect(dropTarget({ ...base, dx: 4000, dy: 0 }).columnIndex).toBe(3)
  })

  it("keeps the block inside the day", () => {
    const early = dropTarget({ ...base, dx: 0, dy: -HOUR_PX * 9 })
    expect(early.startMs).toBe(frame.start)
    const late = dropTarget({ ...base, dx: 0, dy: HOUR_PX * 20 })
    expect(late.endMs).toBe(frame.end)
  })

  it("says when a small wobble changes nothing", () => {
    expect(dropTarget({ ...base, dx: 10, dy: 12 }).same).toBe(true)
  })

  it("snaps to half hours for a station with 30-minute slots", () => {
    const target = dropTarget({ ...base, stepMinutes: 30, dx: 0, dy: HOUR_PX / 2 + 4 })
    expect(new Date(target.startMs).toISOString()).toBe("2026-10-16T11:30:00.000Z")
  })
})

describe("isDrag", () => {
  it("treats a few pixels as a tap", () => {
    expect(isDrag(3, 2)).toBe(false)
    expect(isDrag(5, 5)).toBe(true)
  })
})
