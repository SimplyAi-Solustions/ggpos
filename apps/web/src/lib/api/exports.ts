/**
 * The files the Exports screen hands over.
 *
 * Every export route answers with `Content-Disposition: attachment` and needs
 * a staff token, so a plain `<a href>` cannot fetch one: the call carries the
 * token as a header and the blob is handed to the browser here
 * (docs/api-contract.md, "Phase 4: exports, imports and SumUp").
 *
 * When an export was last taken is not on the server for most of these, so
 * it is remembered per browser instead and labelled as exactly that. The one
 * figure that is on the server is how many stock lines SumUp has never seen,
 * which is read straight off `items`.
 */
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/exports"
import type { EndListingRow, ExportKey } from "@/lib/api/types"

/** Where a browser remembers the last time it took each file. */
const LAST_RUN_KEY = "gg-exports-last-run"

function readLastRuns(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    // Private browsing, or storage switched off: the screen says "not yet".
    return {}
  }
}

/** When this browser last downloaded a given export, or null. */
export function lastRunOf(key: ExportKey): string | null {
  return readLastRuns()[key] ?? null
}

function noteRun(key: ExportKey) {
  try {
    localStorage.setItem(
      LAST_RUN_KEY,
      JSON.stringify({ ...readLastRuns(), [key]: new Date().toISOString() })
    )
  } catch {
    // Nothing to do: the download itself still happened.
  }
}

/** The name in the response's own header, when it sent one. */
function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return match?.[1] ? decodeURIComponent(match[1]) : fallback
}

function handOver(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export interface ExportCall {
  key: ExportKey
  /** The route, query string included. */
  path: string
  /** What to save it as when the response does not name one. */
  filename: string
}

/**
 * Fetch one export and give it to the browser. A refusal comes back as a
 * `ClientResponseError`, so the screen shows the server's own sentence.
 */
export async function downloadExport(call: ExportCall): Promise<void> {
  if (isDemo()) {
    handOver(demo.exportFile(call.key), call.filename)
    noteRun(call.key)
    return
  }

  const response = await fetch(pb.buildURL(call.path), {
    headers: { Authorization: pb.authStore.token },
  })
  if (!response.ok) {
    throw new ClientResponseError({
      status: response.status,
      response: await response.json().catch(() => ({})),
    })
  }
  const blob = await response.blob()
  handOver(blob, filenameFrom(response.headers.get("Content-Disposition"), call.filename))
  noteRun(call.key)
}

/** How many stock lines SumUp has never been told about. */
export async function countUnsyncedForSumUp(): Promise<number> {
  if (isDemo()) return demo.unsyncedCount()
  const page = await pb.collection("items").getList(1, 1, {
    filter:
      'status = "in_stock" && sumup_synced_at = "" && (kind = "retro" || kind = "sealed" || kind = "accessory" || kind = "other")',
    fields: "id",
  })
  return page.totalItems
}

/**
 * The ids of what is in stock, newest first, for the eBay listing file.
 *
 * That route takes an explicit list of ids rather than a filter, and the
 * Exports screen has no item picker of its own, so this is what it sends:
 * the newest `limit` in-stock items. Picking a narrower set is the Stock
 * screen's job, where bulk actions already live.
 */
export async function inStockItemIds(limit = 500): Promise<string[]> {
  if (isDemo()) return demo.inStockIds(limit)
  const page = await pb.collection("items").getList<{ id: string }>(1, limit, {
    filter: 'status = "in_stock"',
    fields: "id",
    sort: "-created",
  })
  return page.items.map((row) => row.id)
}

/**
 * The items whose eBay listing still needs ending: sold in the shop but
 * still carrying an eBay listing id or a Card Uploader `CS-` SKU.
 *
 * There is no JSON route for this list, only the CSV, so the rows are read
 * off `items` with the same filter the CSV export uses; the ids are what
 * `POST /api/vault/items/end-listings` then clears.
 */
export async function listEndListings(): Promise<EndListingRow[]> {
  if (isDemo()) return demo.endListings()
  const rows = await pb.collection("items").getFullList<{
    id: string
    sku: string
    title?: string
    ebay_sku?: string
    ebay_listing_id?: string
    updated?: string
  }>({
    filter: 'status = "sold" && (ebay_listing_id != "" || ebay_sku != "")',
    sort: "-updated",
  })
  return rows.map((row) => ({
    item_id: row.id,
    sku: row.sku,
    title: row.title ?? "",
    ebay_sku: row.ebay_sku ?? "",
    ebay_listing_id: row.ebay_listing_id ?? "",
    sold_at: row.updated ?? "",
  }))
}

/** Clears the eBay fields once the listings really have been ended. */
export async function endListings(ids: string[]): Promise<string[]> {
  if (isDemo()) return demo.markEnded(ids)
  const result = await pb.send<{ ended: string[] }>("/api/vault/items/end-listings", {
    method: "POST",
    body: { ids },
  })
  return result.ended ?? []
}
