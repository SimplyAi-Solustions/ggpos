/**
 * Stock counts: `stock_counts` and `stock_count_lines`, through the
 * collection API (both are staff-writable, like the rest of the stock
 * collections).
 *
 * Starting a count snapshots what the location should hold, one line per
 * item, so the count is a record of what was expected on the day and not a
 * live query that changes under the person holding the scanner. The scan
 * arithmetic itself is in `features/stockcount/reconcile.ts`, which both
 * modes share.
 */
import { ClientResponseError } from "pocketbase"
import { normaliseCode } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemDetailLine } from "@/lib/api/item-shape"
import * as demo from "@/lib/api/demo/stockcounts"
import type { ScannedItem } from "@/features/stockcount/reconcile"
import type {
  LocationRecord,
  StaffRecord,
  StockCountDetail,
  StockCountLine,
  StockCountStatus,
  StockCountSummary,
  StockItemRecord,
} from "@/lib/api/types"

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

interface CountRecord {
  id: string
  location?: string
  started_by?: string
  started_at?: string
  closed_by?: string
  closed_at?: string
  status?: StockCountStatus
  created?: string
  expand?: { location?: LocationRecord; started_by?: StaffRecord }
}

interface LineRecord {
  id: string
  stock_count: string
  item: string
  expected_qty?: number
  scanned_qty?: number
  variance?: number
  expand?: { item?: StockItemRecord & { expand?: { location?: LocationRecord } } }
}

const COUNT_EXPAND = "location,started_by"
const LINE_EXPAND = "item,item.location"

function toLine(record: LineRecord): StockCountLine {
  const item = record.expand?.item
  return {
    id: record.id,
    itemId: record.item,
    sku: item?.sku ?? "",
    title: item?.title ?? "",
    detail: item ? itemDetailLine(item) : "",
    expectedQty: record.expected_qty ?? 0,
    scannedQty: record.scanned_qty ?? 0,
    locationName: item?.expand?.location?.name ?? "No location",
  }
}

function toDetail(count: CountRecord, lines: LineRecord[]): StockCountDetail {
  return {
    id: count.id,
    locationId: count.location ?? "",
    locationName: count.expand?.location?.name ?? "No location",
    status: count.status ?? "open",
    startedAt: count.started_at ?? count.created ?? "",
    // `staff` is admin-only, so an ordinary token cannot expand the name.
    startedByName: count.expand?.started_by?.name ?? "A staff member",
    closedAt: count.closed_at || null,
    lines: lines.map(toLine),
  }
}

async function linesFor(countId: string): Promise<LineRecord[]> {
  return pb.collection("stock_count_lines").getFullList<LineRecord>({
    filter: `stock_count = "${quote(countId)}"`,
    expand: LINE_EXPAND,
    sort: "created",
  })
}

/** Every count, newest first, with what each one came to. */
export async function listStockCounts(limit = 10): Promise<StockCountSummary[]> {
  const details = isDemo()
    ? demo.list().slice(0, limit)
    : await (async () => {
        const counts = await pb.collection("stock_counts").getList<CountRecord>(1, limit, {
          expand: COUNT_EXPAND,
          sort: "-created",
        })
        return Promise.all(
          counts.items.map(async (count) => toDetail(count, await linesFor(count.id)))
        )
      })()

  return details.map((count) => {
    const expected = count.lines.reduce((total, line) => total + line.expectedQty, 0)
    const scanned = count.lines.reduce((total, line) => total + line.scannedQty, 0)
    return {
      id: count.id,
      locationName: count.locationName,
      status: count.status,
      startedAt: count.startedAt,
      closedAt: count.closedAt,
      expected,
      scanned,
      missing: count.lines.reduce(
        (total, line) => total + Math.max(0, line.expectedQty - line.scannedQty),
        0
      ),
      unexpected: count.lines.reduce(
        (total, line) => total + Math.max(0, line.scannedQty - line.expectedQty),
        0
      ),
    }
  })
}

/** A new count, with one line per item the location is recorded as holding. */
export async function startStockCount(locationId: string): Promise<StockCountDetail> {
  if (isDemo()) return demo.start(locationId)

  const count = await pb.collection("stock_counts").create<CountRecord>(
    {
      location: locationId,
      started_by: pb.authStore.record?.id,
      status: "open",
    },
    { expand: COUNT_EXPAND }
  )

  const expected = await pb.collection("items").getFullList<StockItemRecord>({
    filter: `status = "in_stock" && location = "${quote(locationId)}"`,
    sort: "title",
  })

  for (const item of expected) {
    await pb.collection("stock_count_lines").create({
      stock_count: count.id,
      item: item.id,
      expected_qty: Math.max(1, item.qty ?? 1),
      scanned_qty: 0,
      variance: 0,
    })
  }

  return toDetail(count, await linesFor(count.id))
}

export async function getStockCount(id: string): Promise<StockCountDetail | null> {
  if (isDemo()) return demo.get(id)
  try {
    const count = await pb
      .collection("stock_counts")
      .getOne<CountRecord>(id, { expand: COUNT_EXPAND })
    return toDetail(count, await linesFor(id))
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) return null
    throw error
  }
}

/**
 * The item behind a scanned code, wherever it is recorded, or null when the
 * code is not one of ours.
 */
export async function lookupCountItem(sku: string): Promise<ScannedItem | null> {
  const code = normaliseCode(sku)
  if (isDemo()) {
    const item = demo.itemBySku(code)
    if (!item) return null
    return {
      id: item.id,
      sku: item.sku,
      title: item.title ?? "",
      detail: itemDetailLine(item),
      locationName: demo.locationName(item.location),
    }
  }
  try {
    const item = await pb
      .collection("items")
      .getFirstListItem<StockItemRecord & { expand?: { location?: LocationRecord } }>(
        `sku = "${quote(code)}"`,
        { expand: "location" }
      )
    return {
      id: item.id,
      sku: item.sku,
      title: item.title ?? "",
      detail: itemDetailLine(item),
      locationName: item.expand?.location?.name ?? "No location",
    }
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) return null
    throw error
  }
}

/**
 * One line, written as it is counted rather than in a batch at the end: two
 * people can count one location from two phones, and a dropped tab loses
 * nothing but the scan in the air.
 */
export async function saveCountLine(
  countId: string,
  line: StockCountLine
): Promise<StockCountLine> {
  if (isDemo()) return demo.saveLine(countId, line)

  const variance = line.scannedQty - line.expectedQty
  if (line.id.startsWith("new:")) {
    const created = await pb.collection("stock_count_lines").create<LineRecord>(
      {
        stock_count: countId,
        item: line.itemId,
        expected_qty: line.expectedQty,
        scanned_qty: line.scannedQty,
        variance,
      },
      { expand: LINE_EXPAND }
    )
    return { ...line, id: created.id }
  }

  await pb.collection("stock_count_lines").update(line.id, {
    scanned_qty: line.scannedQty,
    variance,
  })
  return line
}

/**
 * Close the count. Admin only by the shop's own rule, which the screen
 * enforces: the variance is the number the stock book carries.
 */
export async function closeStockCount(
  countId: string,
  moveUnexpected: boolean
): Promise<StockCountDetail> {
  if (isDemo()) {
    const closed = demo.close(countId, moveUnexpected)
    if (!closed) throw new Error("That count is no longer open.")
    return closed
  }

  const count = await pb
    .collection("stock_counts")
    .getOne<CountRecord>(countId, { expand: COUNT_EXPAND })
  const lines = await linesFor(countId)

  if (moveUnexpected && count.location) {
    for (const line of lines) {
      const expected = line.expected_qty ?? 0
      const scanned = line.scanned_qty ?? 0
      if (expected > 0 || scanned === 0) continue
      await pb.collection("items").update(line.item, { location: count.location })
    }
  }

  const closed = await pb.collection("stock_counts").update<CountRecord>(
    countId,
    {
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: pb.authStore.record?.id,
    },
    { expand: COUNT_EXPAND }
  )
  return toDetail(closed, await linesFor(countId))
}
