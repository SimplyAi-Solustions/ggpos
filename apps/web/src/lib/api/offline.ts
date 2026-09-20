/**
 * The offline-aware half of the API layer.
 *
 * docs/PLAN.md, "Core flows and rules > Offline": the counter may take a sale
 * and queue labels without a server, and buy-ins may not. So the two writes
 * that are allowed to wait are wrapped here rather than in the screens, and
 * `lib/api/index.ts` exports these in place of the direct calls. A screen
 * keeps calling `completeSale`; what changes is where the sale goes when
 * nothing is listening.
 *
 * A refusal is never queued. If the server answered at all, whatever it said
 * is the truth and the screen shows it; only a request that reached nobody
 * goes into the queue.
 */
import { ClientResponseError } from "pocketbase"
import { formatGBP } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemStore } from "@/lib/api/demo/store"
import { completeSale, getSale } from "@/lib/api/sales"
import { queueLabels } from "@/lib/api/labels"
import {
  isOffline,
  noteNetworkFailure,
  noteNetworkSuccess,
} from "@/lib/offline/net"
import {
  enqueue,
  hydrateQueue,
  newClientId,
  registerSender,
  replayQueue,
  type QueuedEntry,
  type QueuedLine,
  type ReplayReport,
} from "@/lib/offline/queue"
import type {
  CompleteSalePayload,
  CompleteSaleResult,
  LabelJobDetail,
  LabelTemplateKey,
  SaleDetail,
  StockItemRecord,
} from "@/lib/api/types"

export { isOffline, isSimulatedOffline, setSimulatedOffline } from "@/lib/offline/net"

/** A sale that is still in the queue carries this in place of its number. */
export const QUEUED_SALE_NUMBER = "Not sent yet"

/**
 * What a buy-in says when there is no connection.
 *
 * A buy-in writes the seller snapshot, the ID gate, the cash movement and
 * the items in one transaction on the server (docs/api-contract.md), so it
 * is never queued. The wizard checks `isOffline()` itself and shows this.
 */
export const OFFLINE_BUY_IN_MESSAGE =
  "Buy-ins need the server. Reconnect and try again."

const QUEUED_ID = "queued:"

/** True for the id `completeSale` hands back when a sale was queued. */
export function isQueuedSaleId(id: string): boolean {
  return id.startsWith(QUEUED_ID)
}

/**
 * Something this app queued rather than sent. The message is written for
 * staff, so `refusalOrFallback` shows it as it stands.
 */
export class OfflineQueuedError extends Error {}

/** A request that reached nobody, as opposed to one the server refused. */
function noAnswer(error: unknown): boolean {
  if (error instanceof ClientResponseError) return error.status === 0
  // `fetch` itself failing (DNS, no route) never becomes a response.
  return error instanceof TypeError
}

function saleTotal(payload: CompleteSalePayload): number {
  const lines = payload.lines.reduce(
    (total, line) => total + line.unit_price * line.qty - line.discount,
    0
  )
  return lines - payload.discount
}

function saleLines(payload: CompleteSalePayload): QueuedLine[] {
  return payload.lines.map((line) => ({
    itemId: line.item,
    qty: line.qty,
    unitPrice: line.unit_price,
  }))
}

function itemWord(count: number): string {
  return count === 1 ? "item" : "items"
}

async function queueSale(payload: CompleteSalePayload): Promise<CompleteSaleResult> {
  const total = saleTotal(payload)
  const count = payload.lines.reduce((sum, line) => sum + line.qty, 0)
  const entry = await enqueue({
    id: newClientId(),
    work: { kind: "mark_sold", body: payload },
    summary: `Sale, ${count} ${itemWord(count)}, ${formatGBP(total)}`,
    total,
    lines: saleLines(payload),
  })
  return {
    sale: {
      id: `${QUEUED_ID}${entry.id}`,
      number: QUEUED_SALE_NUMBER,
      total,
      status: "complete",
    },
    sumup_amount: total,
    // Points, credit and the balances are the server's arithmetic. Nothing
    // here guesses at them: the ledger rows are written when the sale lands.
    points_earned: 0,
    credit_balance: 0,
    points_balance: 0,
  }
}

/**
 * Complete a sale, or hold it until there is somewhere to send it.
 *
 * Exported as `completeSale` from `lib/api`, so the Sell screen's call is
 * unchanged and offline is not a branch any screen has to know about.
 */
export async function completeSaleQueued(
  payload: CompleteSalePayload
): Promise<CompleteSaleResult> {
  if (isOffline()) return queueSale(payload)
  try {
    const result = await completeSale(payload)
    noteNetworkSuccess()
    // Something may have been waiting behind this; send it now the line is up.
    void replayQueue()
    return result
  } catch (error) {
    if (!noAnswer(error)) throw error
    noteNetworkFailure()
    return queueSale(payload)
  }
}

/**
 * The sale behind an id, with a straight answer for one that has not gone yet.
 * The undo on the Sell screen reads the sale back before refunding it, and a
 * queued sale has nothing to refund.
 */
export async function getSaleQueued(id: string): Promise<SaleDetail | null> {
  if (isQueuedSaleId(id)) {
    throw new OfflineQueuedError(
      "That sale is still waiting to send, so it cannot be undone yet. Send it first, then refund it."
    )
  }
  return getSale(id)
}

/**
 * Queue labels, or hold the job until the printer's server is back.
 *
 * Offline this refuses out loud rather than answering with jobs that do not
 * exist yet: the reprint screen sends staff straight to the print page with
 * the ids it gets back, and a page of blank labels helps nobody. The job is
 * in the queue either way, and the strip under the nav says so.
 */
export async function queueLabelsQueued(
  itemIds: string[],
  template?: LabelTemplateKey
): Promise<LabelJobDetail[]> {
  if (isOffline()) return holdLabels(itemIds, template)
  try {
    const jobs = await queueLabels(itemIds, template)
    noteNetworkSuccess()
    void replayQueue()
    return jobs
  } catch (error) {
    if (!noAnswer(error)) throw error
    noteNetworkFailure()
    return holdLabels(itemIds, template)
  }
}

async function holdLabels(
  itemIds: string[],
  template?: LabelTemplateKey
): Promise<never> {
  const count = itemIds.length
  await enqueue({
    id: newClientId(),
    work: { kind: "queue_labels", itemIds, template },
    summary: `${count} label ${count === 1 ? "job" : "jobs"}`,
  })
  throw new OfflineQueuedError(
    count === 1
      ? "That label is waiting to send. It queues for the printer once the connection is back."
      : "Those labels are waiting to send. They queue for the printer once the connection is back."
  )
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

registerSender(async (entry: QueuedEntry) => {
  if (entry.work.kind === "mark_sold") {
    await completeSale(entry.work.body)
    return
  }
  await queueLabels(entry.work.itemIds, entry.work.template)
})

/** Send everything waiting. The strip's retry action and the reconnect both call it. */
export function replayOfflineQueue(): Promise<ReplayReport> {
  return replayQueue()
}

/** Read what the last session left in the queue. Called once by the shell. */
export function loadOfflineQueue(): Promise<void> {
  return hydrateQueue()
}

// ---------------------------------------------------------------------------
// Reading a refused basket back
// ---------------------------------------------------------------------------

export interface ResolvedQueuedLine extends QueuedLine {
  /** The item's own words, or a plain stand-in when it cannot be read. */
  title: string
  sku: string
}

/**
 * The titles behind a refused sale's lines. A conflict only exists once the
 * server has answered, so this runs with the connection back up.
 */
export async function resolveQueuedLines(
  lines: QueuedLine[]
): Promise<ResolvedQueuedLine[]> {
  if (lines.length === 0) return []
  if (isDemo()) {
    const items = itemStore()
    return lines.map((line) => {
      const item = items.find((row) => row.id === line.itemId)
      return { ...line, title: item?.title || "Item", sku: item?.sku ?? "" }
    })
  }
  const resolved = await Promise.all(
    lines.map(async (line) => {
      const item = await pb
        .collection("items")
        .getOne<StockItemRecord>(line.itemId)
        .catch(() => null)
      return { ...line, title: item?.title || "Item", sku: item?.sku ?? "" }
    })
  )
  return resolved
}
