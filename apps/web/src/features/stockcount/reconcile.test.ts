import { buildCode } from "@gg/shared"
import { describe, expect, it } from "vitest"

import {
  applyScan,
  lineVariance,
  stillMissing,
  summarise,
  unexpectedLines,
  type ScannedItem,
} from "@/features/stockcount/reconcile"
import type { StockCountLine } from "@/lib/api/types"

const CHARIZARD = buildCode("single", "7F3K2")
const MABEL = buildCode("single", "T4M9P")
const STRAY = buildCode("single", "W8Q4R")

function line(overrides: Partial<StockCountLine> = {}): StockCountLine {
  return {
    id: "line_1",
    itemId: "item_1",
    sku: CHARIZARD.encoded,
    title: "Charizard ex",
    detail: "SV151 199/165 Holo",
    expectedQty: 1,
    scannedQty: 0,
    locationName: "Showcase",
    ...overrides,
  }
}

const strayItem: ScannedItem = {
  id: "item_stray",
  sku: STRAY.encoded,
  title: "Llanowar Elves",
  detail: "FDN 0179 Foil",
  locationName: "Binder B",
}

describe("counting a location", () => {
  it("ticks an expected item off", () => {
    const { lines, outcome } = applyScan([line()], CHARIZARD.encoded, null)

    expect(outcome.kind).toBe("ticked")
    expect(lines[0]!.scannedQty).toBe(1)
  })

  it("takes the code as it is typed, dashes and all", () => {
    const { outcome } = applyScan([line()], CHARIZARD.display, null)

    expect(outcome.kind).toBe("ticked")
  })

  it("flags an item that is recorded somewhere else", () => {
    const { lines, outcome } = applyScan([line()], STRAY.encoded, strayItem)

    expect(outcome.kind).toBe("extra")
    expect(outcome.kind === "extra" && outcome.line.locationName).toBe("Binder B")
    expect(lines).toHaveLength(2)
    expect(lines[1]!.expectedQty).toBe(0)
    expect(lines[1]!.scannedQty).toBe(1)
  })

  it("says so when the code is not one we hold", () => {
    const { lines, outcome } = applyScan([line()], STRAY.encoded, null)

    expect(outcome).toEqual({ kind: "unknown", sku: STRAY.encoded })
    expect(lines).toHaveLength(1)
  })

  it("counts a second copy of a single as one over", () => {
    const first = applyScan([line()], CHARIZARD.encoded, null)
    const second = applyScan(first.lines, CHARIZARD.encoded, null)

    expect(second.outcome.kind).toBe("over")
    expect(second.lines[0]!.scannedQty).toBe(2)
    expect(summarise(second.lines).unexpected).toBe(1)
  })

  it("keeps counting a multi-quantity line until the shelf is empty", () => {
    const sealed = line({ expectedQty: 3, title: "Surging Sparks ETB" })
    const once = applyScan([sealed], CHARIZARD.encoded, null)
    const twice = applyScan(once.lines, CHARIZARD.encoded, null)

    expect(twice.outcome.kind).toBe("ticked")
    expect(summarise(twice.lines)).toEqual({
      expected: 3,
      scanned: 2,
      missing: 1,
      unexpected: 0,
    })
  })

  it("adds a count up the way the close screen reads it", () => {
    const lines = [
      line({ id: "a", expectedQty: 1, scannedQty: 1 }),
      line({ id: "b", itemId: "item_2", sku: MABEL.encoded, expectedQty: 2, scannedQty: 0 }),
      line({
        id: "c",
        itemId: "item_stray",
        sku: STRAY.encoded,
        expectedQty: 0,
        scannedQty: 1,
        locationName: "Binder B",
      }),
    ]

    expect(summarise(lines)).toEqual({
      expected: 3,
      scanned: 2,
      missing: 2,
      unexpected: 1,
    })
    expect(stillMissing(lines).map((row) => row.id)).toEqual(["b"])
    expect(unexpectedLines(lines).map((row) => row.id)).toEqual(["c"])
    expect(lineVariance(lines[1]!)).toBe(-2)
    expect(lineVariance(lines[2]!)).toBe(1)
  })

  it("adds an empty count up to nothing", () => {
    expect(summarise([])).toEqual({
      expected: 0,
      scanned: 0,
      missing: 0,
      unexpected: 0,
    })
  })
})
