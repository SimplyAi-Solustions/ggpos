/**
 * The demo counter's stock counts.
 *
 * In memory for the tab, like every other demo store, and built off the very
 * item array Add stock appends to, so a count of the Showcase expects the
 * items that are actually sitting in it.
 */
import { itemDetailLine } from "@/lib/api/item-shape"
import { DEMO_LOCATIONS } from "@/lib/api/fixtures"
import { ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type {
  StockCountDetail,
  StockCountLine,
  StockCountStatus,
  StockItemRecord,
} from "@/lib/api/types"

interface DemoCount {
  id: string
  locationId: string
  status: StockCountStatus
  startedAt: string
  closedAt: string | null
  lines: StockCountLine[]
}

const counts: DemoCount[] = []
let sequence = 0

export function locationName(id?: string): string {
  return DEMO_LOCATIONS.find((location) => location.id === id)?.name ?? "No location"
}

function toLine(item: StockItemRecord, index: number): StockCountLine {
  return {
    id: `count_line_${index}_${item.id}`,
    itemId: item.id,
    sku: item.sku,
    title: item.title ?? "",
    detail: itemDetailLine(item),
    expectedQty: Math.max(1, item.qty ?? 1),
    scannedQty: 0,
    locationName: locationName(item.location),
  }
}

function detail(count: DemoCount): StockCountDetail {
  return {
    id: count.id,
    locationId: count.locationId,
    locationName: locationName(count.locationId),
    status: count.status,
    startedAt: count.startedAt,
    startedByName: "Demo Counter",
    closedAt: count.closedAt,
    lines: count.lines.map((line) => ({ ...line })),
  }
}

export function list(): StockCountDetail[] {
  ensureSeeded()
  return [...counts]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(detail)
}

export function start(locationId: string): StockCountDetail {
  ensureSeeded()
  sequence += 1
  const expected = itemStore().filter(
    (item) => item.location === locationId && (item.status ?? "in_stock") === "in_stock"
  )
  const count: DemoCount = {
    id: `count_demo_${sequence}`,
    locationId,
    status: "open",
    startedAt: new Date().toISOString(),
    closedAt: null,
    lines: expected.map((item, index) => toLine(item, index)),
  }
  counts.push(count)
  return detail(count)
}

export function get(id: string): StockCountDetail | null {
  ensureSeeded()
  const count = counts.find((row) => row.id === id)
  return count ? detail(count) : null
}

export function saveLine(id: string, line: StockCountLine): StockCountLine {
  const count = counts.find((row) => row.id === id)
  if (!count) return line
  const existing = count.lines.find((row) => row.id === line.id)
  if (existing) {
    existing.scannedQty = line.scannedQty
    return { ...existing }
  }
  sequence += 1
  const saved: StockCountLine = { ...line, id: `count_line_extra_${sequence}` }
  count.lines.push(saved)
  return { ...saved }
}

export function close(id: string, moveUnexpected: boolean): StockCountDetail | null {
  const count = counts.find((row) => row.id === id)
  if (!count) return null
  if (moveUnexpected) {
    const items = itemStore()
    for (const line of count.lines) {
      if (line.expectedQty > 0 || line.scannedQty === 0) continue
      const item = items.find((row) => row.id === line.itemId)
      if (item) item.location = count.locationId
    }
  }
  count.status = "closed"
  count.closedAt = new Date().toISOString()
  return detail(count)
}

/** The item behind a scanned code, wherever it is recorded. */
export function itemBySku(sku: string): StockItemRecord | null {
  ensureSeeded()
  return itemStore().find((item) => item.sku === sku) ?? null
}
