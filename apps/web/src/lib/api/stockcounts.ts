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

/**
 * The statuses that mean "this is on that shelf right now".
 *
 * A reserved item and one listed on eBay are both still physically there
 * and both have to be found by a count; only sold, returned and written off
 * are gone. Anything else that turns up is a real stray, and the line says
 * where it is recorded instead.
 */
export const COUNTED_STATUSES = ["in_stock", "reserved", "listed_ebay"] as const

const COUNTED_FILTER = COUNTED_STATUSES.map((status) => `status = "${status}"`).join(" || ")

/** PocketBase's batch API takes 200 requests at a time by default. */
const BATCH_SIZE = 200

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

/**
 * The count already open for a location, or null.
 *
 * Two counts of one shelf at once would both be wrong, so the screen offers
 * to carry on with this one rather than starting a second.
 */
export async function getOpenStockCount(
  locationId: string
): Promise<StockCountDetail | null> {
  if (isDemo()) return demo.openFor(locationId)
  const page = await pb.collection("stock_counts").getList<CountRecord>(1, 1, {
    filter: `location = "${quote(locationId)}" && status = "open"`,
    expand: COUNT_EXPAND,
    sort: "-created",
  })
  const count = page.items[0]
  if (!count) return null
  return toDetail(count, await linesFor(count.id))
}

/**
 * A new count, with one line per unit the location is recorded as holding.
 *
 * The lines go in through the batch API rather than one create each: a
 * binder of three hundred singles is three hundred round trips otherwise,
 * and a count nobody waits for is a count nobody does.
 */
export async function startStockCount(locationId: string): Promise<StockCountDetail> {
  if (isDemo()) return demo.start(locationId)

  // Belt and braces with the screen's own offer to resume: whoever asks
  // second gets the count that is already open, not a second one.
  const open = await getOpenStockCount(locationId)
  if (open) return open

  const count = await pb.collection("stock_counts").create<CountRecord>(
    {
      location: locationId,
      started_by: pb.authStore.record?.id,
      status: "open",
    },
    { expand: COUNT_EXPAND }
  )

  const expected = await pb.collection("items").getFullList<StockItemRecord>({
    filter: `(${COUNTED_FILTER}) && location = "${quote(locationId)}"`,
    sort: "title",
  })

  // A stock line already down to zero is not on the shelf to be found.
  const lines = expected
    .map((item) => ({ item, qty: item.qty ?? 1 }))
    .filter((row) => row.qty > 0)

  for (let at = 0; at < lines.length; at += BATCH_SIZE) {
    const batch = pb.createBatch()
    for (const row of lines.slice(at, at + BATCH_SIZE)) {
      batch.collection("stock_count_lines").create({
        stock_count: count.id,
        item: row.item.id,
        expected_qty: row.qty,
        scanned_qty: 0,
        variance: 0,
      })
    }
    await batch.send()
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
 * Close the count.
 *
 * `POST /api/vault/stock-counts/:id/close` (admin) does it in one
 * transaction: the variance on every line, the count's own status, and the
 * move of anything that turned up here when `move_unexpected` is set, all
 * audited. The client then reads the count back rather than mapping the
 * route's body, so the screen always has the same joined shape it draws
 * everywhere else and neither package can break the other by moving a
 * field.
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

  await pb.send(`/api/vault/stock-counts/${countId}/close`, {
    method: "POST",
    body: { move_unexpected: moveUnexpected },
  })
  noteNetworkSuccess()

  const closed = await getStockCount(countId)
  if (!closed) {
    throw new Error("That count closed but could not be read back. Open it again.")
  }
  return closed
}
