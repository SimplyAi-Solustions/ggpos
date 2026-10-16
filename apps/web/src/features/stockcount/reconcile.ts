/**
 * What a scan does to a count, and what a count adds up to.
 *
 * Pure, so the live and the demo implementations both tick a line off the
 * same way and the arithmetic on the close screen can be tested without a
 * server. docs/PLAN.md, "Screens > Stock": a count snapshots what should be
 * on the shelf, staff scan their way through it, and the close records the
 * variance.
 */
import { normaliseCode } from "@gg/shared"

import type { StockCountLine } from "@/lib/api/types"

/** An item a scanned code turned out to be, as the count needs it. */
export interface ScannedItem {
  id: string
  sku: string
  title: string
  detail: string
  /** Where the item is recorded, which is not always where it turned up. */
  locationName: string
}

export type ScanOutcome =
  /** Expected here, and now found. */
  | { kind: "ticked"; line: StockCountLine }
  /** Expected here, but more copies turned up than the shelf should hold. */
  | { kind: "over"; line: StockCountLine }
  /** Ours, but recorded somewhere else. */
  | { kind: "extra"; line: StockCountLine }
  /** Not a code we hold at all. */
  | { kind: "unknown"; sku: string }

export interface ScanResult {
  lines: StockCountLine[]
  outcome: ScanOutcome
}

/** The id a line gets before it has been written. */
export function draftLineId(sku: string): string {
  return `new:${sku}`
}

export function isDraftLine(line: StockCountLine): boolean {
  return line.id.startsWith("new:")
}

/** The line for a code, whether it was typed with dashes or scanned without. */
export function findLine(
  lines: StockCountLine[],
  sku: string
): StockCountLine | undefined {
  const code = normaliseCode(sku)
  return lines.find((line) => normaliseCode(line.sku) === code)
}

/**
 * One scan against the count. The item is looked up by the caller, so this
 * stays pure: `null` means the code is not one of ours.
 */
export function applyScan(
  lines: StockCountLine[],
  sku: string,
  item: ScannedItem | null
): ScanResult {
  const code = normaliseCode(sku)
  const existing = findLine(lines, code)

  if (existing) {
    const line: StockCountLine = { ...existing, scannedQty: existing.scannedQty + 1 }
    const next = lines.map((row) => (row.id === existing.id ? line : row))
    const over = existing.expectedQty > 0 && existing.scannedQty >= existing.expectedQty
    return { lines: next, outcome: over ? { kind: "over", line } : { kind: "ticked", line } }
  }

  if (!item) return { lines, outcome: { kind: "unknown", sku: code } }

  const line: StockCountLine = {
    id: draftLineId(code),
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    detail: item.detail,
    expectedQty: 0,
    scannedQty: 1,
    locationName: item.locationName,
  }
  return { lines: [...lines, line], outcome: { kind: "extra", line } }
}

export interface CountSummary {
  /** Units the snapshot said should be here. */
  expected: number
  /** Units found. */
  scanned: number
  /** Units the shelf should hold that nobody found. */
  missing: number
  /** Units found beyond what the shelf should hold. */
  unexpected: number
}

export function summarise(lines: StockCountLine[]): CountSummary {
  return lines.reduce<CountSummary>(
    (total, line) => ({
      expected: total.expected + line.expectedQty,
      scanned: total.scanned + line.scannedQty,
      missing: total.missing + Math.max(0, line.expectedQty - line.scannedQty),
      unexpected: total.unexpected + Math.max(0, line.scannedQty - line.expectedQty),
    }),
    { expected: 0, scanned: 0, missing: 0, unexpected: 0 }
  )
}

/** Lines the shelf should hold that have not been found yet. */
export function stillMissing(lines: StockCountLine[]): StockCountLine[] {
  return lines.filter((line) => line.scannedQty < line.expectedQty)
}

/** Lines that turned up here but are recorded somewhere else. */
export function unexpectedLines(lines: StockCountLine[]): StockCountLine[] {
  return lines.filter((line) => line.expectedQty === 0 && line.scannedQty > 0)
}

/** `scanned - expected` for one line, which is what the row stores. */
export function lineVariance(line: StockCountLine): number {
  return line.scannedQty - line.expectedQty
}
