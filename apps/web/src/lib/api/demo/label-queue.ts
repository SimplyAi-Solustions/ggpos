/**
 * The demo shop's print queue: bulk reprint, claiming and the two ways a job
 * can end, answered from the same in-memory jobs the queue screen lists.
 *
 * The refusals are the server's own sentences, word for word, so what the
 * e2e suite reads in demo mode is what staff read at the counter.
 */
import { ClientResponseError } from "pocketbase"

import { itemDetailLine, templateForItem } from "@/lib/api/item-shape"
import { demoId, demoLabelJobs, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import { demoTradeIns } from "@/lib/api/demo/tradeins"
import type {
  ItemStatus,
  LabelJobDetail,
  LabelJobStatus,
  LabelQueueResult,
  LabelQueueSelector,
  LabelTemplateKey,
  StockItemRecord,
} from "@/lib/api/types"

/** The statuses the shop still holds the item under, so a label is worth printing. */
const HELD: ItemStatus[] = ["in_stock", "reserved", "listed_ebay"]

const BATCH_CAP = 500

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** The screen's re-read, standing in for the realtime subscription. */
export function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function tradeInIdByNumber(number: string): string | null {
  return (
    demoTradeIns.find((entry) => entry.record.number === number)?.record.id ?? null
  )
}

/** `acquired_at` when the item has one, else when the row was written. */
function acquiredOn(item: StockItemRecord): string {
  return (item.acquired_at ?? item.created ?? "").slice(0, 10)
}

function selected(selector: LabelQueueSelector): StockItemRecord[] {
  const items = itemStore().filter((item) =>
    HELD.includes(item.status ?? "in_stock")
  )

  if (selector.items?.length) {
    const wanted = new Set(selector.items)
    return items.filter((item) => wanted.has(item.id))
  }

  if (selector.trade_in) {
    return items.filter((item) => item.trade_in === selector.trade_in)
  }

  return items.filter((item) => {
    const on = acquiredOn(item)
    if (!on) return false
    if (selector.acquired_from && on < selector.acquired_from) return false
    if (selector.acquired_to && on > selector.acquired_to) return false
    if (selector.location && item.location !== selector.location) return false
    if (selector.kind && item.kind !== selector.kind) return false
    if (selector.game && item.game !== selector.game) return false
    return true
  })
}

function waitingFor(itemId: string): boolean {
  return demoLabelJobs.some(
    (job) =>
      job.itemId === itemId && (job.status === "queued" || job.status === "printing")
  )
}

export function queueBatch(selector: LabelQueueSelector): LabelQueueResult {
  ensureSeeded()

  const anySelector =
    Boolean(selector.items?.length) ||
    Boolean(selector.trade_in) ||
    Boolean(selector.acquired_from) ||
    Boolean(selector.acquired_to) ||
    Boolean(selector.location) ||
    Boolean(selector.kind) ||
    Boolean(selector.game)
  if (!anySelector) {
    throw new Error(
      "Pick what to print: the items, a buy-in, a date range, a location, a kind or a game."
    )
  }

  const items = selected(selector)
  if (items.length > BATCH_CAP) {
    throw new Error(
      `That is ${items.length} labels. Narrow the range to ${BATCH_CAP} or fewer.`
    )
  }

  const jobIds: string[] = []
  let skipped = 0
  for (const item of items) {
    if (!selector.include_queued && waitingFor(item.id)) {
      skipped += 1
      continue
    }
    const template: LabelTemplateKey =
      selector.template ?? templateForItem(item.kind, item.completeness)
    const job: LabelJobDetail = {
      id: demoId("label_job"),
      status: "queued",
      copies: Math.max(1, selector.copies ?? 1),
      template,
      itemId: item.id,
      code: item.sku,
      title: item.title ?? "",
      detail: itemDetailLine(item),
      condition: item.condition ?? "",
      price: item.price ?? 0,
      requestedAt: new Date().toISOString(),
    }
    demoLabelJobs.unshift(job)
    jobIds.push(job.id)
  }

  emit()
  return { queued: jobIds.length, skipped, job_ids: jobIds }
}

/** Oldest first, up to `limit`, and only the sizes this printer has loaded. */
export function claim(
  printer: string,
  limit = 10,
  templates?: LabelTemplateKey[]
): LabelJobDetail[] {
  ensureSeeded()
  const taken = demoLabelJobs
    .filter((job) => job.status === "queued")
    .filter((job) => !templates?.length || templates.includes(job.template))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .slice(0, Math.max(1, limit))

  for (const job of taken) {
    job.status = "printing"
    job.printer = printer
    job.error = ""
  }
  if (taken.length > 0) emit()
  return taken.map((job) => ({ ...job }))
}

/** The shape a route refusal arrives in, so the screens read the demo alike. */
function refusal(status: number, message: string): never {
  throw new ClientResponseError({
    status,
    response: { code: status, message, data: {} },
  })
}

/**
 * The route leaves `items.label_printed_at` alone, as the print page does:
 * nothing reads it, and a reprint is not news about the item.
 *
 * A job this device is not holding is refused rather than accepted
 * quietly: that label has come out twice and somebody has to know.
 */
export function markPrinted(id: string): LabelJobStatus {
  const job = demoLabelJobs.find((row) => row.id === id)
  if (!job) refusal(404, "That label job is no longer here.")
  if (job.status !== "printing") {
    refusal(
      409,
      "That label went back in the queue, so another device may have printed it. Check the label before printing it again."
    )
  }
  job.status = "printed"
  job.error = ""
  job.printer = ""
  emit()
  return job.status
}

/** Three goes, then it stops and waits for somebody to look at it. */
export function markFailed(id: string, error: string): LabelJobStatus {
  const job = demoLabelJobs.find((row) => row.id === id)
  if (!job) return "queued"
  job.attempts = (job.attempts ?? 0) + 1
  job.error = error
  job.status = job.attempts < 3 ? "queued" : "failed"
  job.printer = ""
  emit()
  return job.status
}

export function requeue(id: string): LabelJobStatus {
  const job = demoLabelJobs.find((row) => row.id === id)
  if (!job) refusal(404, "That label job is no longer here.")
  if (job.status !== "failed" && job.status !== "cancelled") {
    refusal(409, "That label is already in the queue.")
  }
  job.status = "queued"
  job.attempts = 0
  job.error = ""
  job.printer = ""
  emit()
  return job.status
}
