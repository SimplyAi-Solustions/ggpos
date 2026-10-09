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

import { OfflineQueuedError } from "@/lib/offline/errors"
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemStore } from "@/lib/api/demo/store"
import { demoProduct } from "@/lib/api/demo/till"
import {
  completeSale,
  getSale,
  type TillSalePayload,
  type TillSaleResult,
} from "@/lib/api/sales"
import { queueLabels } from "@/lib/api/labels"
import {
  isOffline,
  noteNetworkFailure,
  noteNetworkSuccess,
  registerNetProbe,
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
  LabelJobDetail,
  LabelTemplateKey,
  SaleDetail,
  StockItemRecord,
} from "@/lib/api/types"

export { isOffline, isSimulatedOffline, setSimulatedOffline } from "@/lib/offline/net"
export { clearOfflineCaches, RUNTIME_CACHE_NAMES } from "@/lib/offline/caches"

/** A sale that is still in the queue carries this in place of its number. */
export const QUEUED_SALE_NUMBER = "Not sent yet"

// The wizard checks `isOffline()` itself and shows OFFLINE_BUY_IN_MESSAGE;
// `completeTradeIn` refuses with it too, so neither can be forgotten.
export { OfflineQueuedError, OFFLINE_BUY_IN_MESSAGE } from "@/lib/offline/errors"

const QUEUED_ID = "queued:"

/** True for the id `completeSale` hands back when a sale was queued. */
export function isQueuedSaleId(id: string): boolean {
  return id.startsWith(QUEUED_ID)
}

/** A request that reached nobody, as opposed to one the server refused. */
function noAnswer(error: unknown): boolean {
  if (error instanceof ClientResponseError) return error.status === 0
  // `fetch` itself failing (DNS, no route) never becomes a response.
  return error instanceof TypeError
}

function saleTotal(payload: TillSalePayload): number {
  const lines = payload.lines.reduce(
    (total, line) => total + line.unit_price * line.qty - line.discount,
    0
  )
  return lines - payload.discount
}

/** Where a queued line's title is looked up again: an item, or a till product. */
const PRODUCT_LINE = "product:"

function saleLines(payload: TillSalePayload): QueuedLine[] {
  return payload.lines.map((line) => ({
    itemId: "item" in line ? line.item : `${PRODUCT_LINE}${line.product}`,
    qty: line.qty,
    unitPrice: line.unit_price,
  }))
}

function itemWord(count: number): string {
  return count === 1 ? "item" : "items"
}

/** A sale payload that is certainly carrying its client id. */
type IdentifiedSale = TillSalePayload & { client_id: string }

/**
 * The payload with a client id on it. The same id is the queue's key, so a
 * sale that goes straight out, a sale that is retried and a sale that waits
 * in the queue are all the one sale as far as the server is concerned.
 */
function identified(payload: TillSalePayload): IdentifiedSale {
  return payload.client_id
    ? (payload as IdentifiedSale)
    : { ...payload, client_id: newClientId() }
}

/**
 * The queue's record of a sale is typed by `lib/offline/queue.ts` as the
 * old Sell payload. The till's carries tenders, product lines and voids
 * instead, and the queue only ever stores it and hands it back to
 * `completeSale` untouched, so the body crosses that boundary as-is.
 */
function asQueued(body: IdentifiedSale): CompleteSalePayload {
  return body as unknown as CompleteSalePayload
}

function fromQueued(body: CompleteSalePayload): TillSalePayload {
  return body as unknown as TillSalePayload
}

async function queueSale(payload: TillSalePayload): Promise<TillSaleResult> {
  const body = identified(payload)
  const total = saleTotal(body)
  const count = body.lines.reduce((sum, line) => sum + line.qty, 0)
  const entry = await enqueue({
    id: body.client_id,
    // The tenders travel in the body, so the sale lands paid the way it
    // was paid at the counter.
    work: { kind: "mark_sold", body: asQueued(body) },
    summary: `Sale, ${count} ${itemWord(count)}, ${formatGBP(total)}`,
    total,
    lines: saleLines(body),
  })
  const change = body.tenders.reduce(
    (sum, tender) =>
      sum + (tender.method === "cash" ? Math.max(0, (tender.tendered ?? tender.amount) - tender.amount) : 0),
    0
  )
  return {
    sale: {
      id: `${QUEUED_ID}${entry.id}`,
      number: QUEUED_SALE_NUMBER,
      total,
      status: "complete",
    },
    // The change was counted out at the counter whatever the line did.
    change,
    tenders: [],
    vat_total: 0,
    receipt: { number: QUEUED_SALE_NUMBER },
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
 * Exported as `completeSale` from `lib/api`, so offline is not a branch any
 * screen has to know about. `headers` carries a manager's approval on a
 * retry; a sale that has to wait in the queue goes without one, and the
 * server's refusal of it, if it needs one, lands in the conflicts sheet.
 */
export async function completeSaleQueued(
  payload: TillSalePayload,
  headers: Record<string, string> = {}
): Promise<TillSaleResult> {
  // The id is minted before the first attempt, not when the sale is queued:
  // a request that the server took but whose reply never arrived is sent
  // again under the same id rather than ringing the ticket up twice.
  const body = identified(payload)
  if (isOffline()) return queueSale(body)
  try {
    const result = await completeSale(body, headers)
    noteNetworkSuccess()
    // Something may have been waiting behind this; send it now the line is up.
    void replayQueue()
    return result
  } catch (error) {
    if (!noAnswer(error)) throw error
    noteNetworkFailure()
    return queueSale(body)
  }
}

/**
 * The sale behind an id, with a straight answer for one that has not gone
 * yet: a queued sale has no record to read back or refund.
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
    await completeSale(fromQueued(entry.work.body))
    return
  }
  await queueLabels(entry.work.itemIds, entry.work.template)
})

/**
 * How the network flag unlatches itself.
 *
 * On a tether the browser never fires `online`, so a failure that latched
 * would hide the Retry action for good. `GET /api/vault/config` is the
 * cheapest thing a staff token can ask for and writes no audit row
 * (docs/api-contract.md, "Config"); any answer, including a refusal, proves
 * the line is up. In demo mode the fixtures always answer, so the probe is
 * left unregistered and the switch in the menu stays in charge.
 */
registerNetProbe(async () => {
  if (isDemo()) throw new Error("Demo mode has no server to probe.")
  await pb.send("/api/vault/config", { method: "GET" })
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
      if (line.itemId.startsWith(PRODUCT_LINE)) {
        const product = demoProduct(line.itemId.slice(PRODUCT_LINE.length))
        return { ...line, title: product?.name || "Till product", sku: "" }
      }
      const item = items.find((row) => row.id === line.itemId)
      return { ...line, title: item?.title || "Item", sku: item?.sku ?? "" }
    })
  }
  const resolved = await Promise.all(
    lines.map(async (line) => {
      if (line.itemId.startsWith(PRODUCT_LINE)) {
        const product = await pb
          .collection("till_products")
          .getOne<{ name?: string }>(line.itemId.slice(PRODUCT_LINE.length))
          .catch(() => null)
        return { ...line, title: product?.name || "Till product", sku: "" }
      }
      const item = await pb
        .collection("items")
        .getOne<StockItemRecord>(line.itemId)
        .catch(() => null)
      return { ...line, title: item?.title || "Item", sku: item?.sku ?? "" }
    })
  )
  return resolved
}
