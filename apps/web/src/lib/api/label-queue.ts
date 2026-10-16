/**
 * The cross-device print queue and bulk reprint (Phase 7 contract, section 4).
 *
 * `lib/api/labels.ts` is the day-one path: rows written straight through the
 * collection API and printed by the browser. These are the routes that let a
 * phone queue a label the counter PC then prints over USB, so they are
 * deliberately not re-exported from `lib/api/index.ts`: that barrel travels
 * in the entry chunk, and nothing here belongs anywhere but the Labels
 * screen.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemDetailLine } from "@/lib/api/item-shape"
import { noteNetworkSuccess } from "@/lib/offline/net"
import * as demo from "@/lib/api/demo/label-queue"
import type {
  ItemKind,
  LabelJobDetail,
  LabelJobStatus,
  LabelQueueResult,
  LabelQueueSelector,
  LabelTemplateKey,
  StockItemRecord,
} from "@/lib/api/types"

/** One job as `POST /api/vault/labels/claim` hands it over. */
interface ClaimedJob {
  id: string
  status?: LabelJobStatus
  copies?: number
  attempts?: number
  printer?: string
  claimed_at?: string
  printed_at?: string
  error?: string
  template?: { key?: LabelTemplateKey; width_mm?: number; height_mm?: number; dpi?: number }
  item?: {
    id?: string
    sku?: string
    title?: string
    set_code?: string
    number?: string
    finish?: string
    condition?: string
    price?: number
    kind?: ItemKind
    game_key?: string
    qr_text?: string
  }
}

/** The `{ job }` the printed, failed and requeue routes answer with. */
interface JobRow {
  id?: string
  status?: LabelJobStatus
  printer?: string
  attempts?: number
  error?: string
  printed_at?: string
}

function fromClaim(job: ClaimedJob): LabelJobDetail {
  const item = job.item ?? {}
  const detail = itemDetailLine({
    kind: item.kind ?? "other",
    set_code: item.set_code,
    number: item.number,
    finish: item.finish,
  } as StockItemRecord)
  return {
    id: job.id,
    status: job.status ?? "printing",
    copies: job.copies ?? 1,
    template: job.template?.key ?? "toploader_40x20",
    itemId: item.id ?? "",
    code: item.sku ?? "",
    title: item.title ?? "",
    detail,
    condition: item.condition ?? "",
    price: item.price ?? 0,
    requestedAt: "",
    // The server is the authority on what the QR carries, so its text wins
    // over anything worked out from the code here.
    qrText: item.qr_text || undefined,
    printer: job.printer ?? "",
    error: job.error ?? "",
    attempts: job.attempts ?? 0,
    claimedAt: job.claimed_at ?? "",
    printedAt: job.printed_at ?? "",
    templateWidthMm: job.template?.width_mm,
    templateHeightMm: job.template?.height_mm,
  }
}

/**
 * Bulk reprint. At least one selector, and the counts come back from the
 * server: what it queued, and what it passed over because a label was
 * already waiting.
 */
export async function queueLabelBatch(
  selector: LabelQueueSelector
): Promise<LabelQueueResult> {
  if (isDemo()) return demo.queueBatch(selector)
  const result = await pb.send<LabelQueueResult>("/api/vault/labels/queue", {
    method: "POST",
    body: selector,
  })
  noteNetworkSuccess()
  return {
    queued: result.queued ?? 0,
    skipped: result.skipped ?? 0,
    job_ids: result.job_ids ?? [],
  }
}

/**
 * Takes the next jobs for this device.
 *
 * The flip to `printing` happens on the server in one transaction, so two
 * counters with a printer each never take the same label twice.
 */
export async function claimLabelJobs(
  printer: string,
  limit = 10,
  templates?: LabelTemplateKey[]
): Promise<LabelJobDetail[]> {
  if (isDemo()) return demo.claim(printer, limit, templates)
  const result = await pb.send<{ jobs?: ClaimedJob[] }>("/api/vault/labels/claim", {
    method: "POST",
    body: templates?.length ? { printer, limit, templates } : { printer, limit },
  })
  noteNetworkSuccess()
  return (result.jobs ?? []).map(fromClaim)
}

/** The label came out of the printer. */
export async function markJobPrinted(id: string): Promise<LabelJobStatus> {
  if (isDemo()) return demo.markPrinted(id)
  const result = await pb.send<{ job?: JobRow }>(`/api/vault/labels/${id}/printed`, {
    method: "POST",
    body: {},
  })
  return result.job?.status ?? "printed"
}

/**
 * It did not. The server counts the attempt, puts the job back in the queue
 * while there are tries left, and gives up after three.
 */
export async function markJobFailed(
  id: string,
  error: string
): Promise<LabelJobStatus> {
  if (isDemo()) return demo.markFailed(id, error)
  const result = await pb.send<{ job?: JobRow }>(`/api/vault/labels/${id}/failed`, {
    method: "POST",
    body: { error },
  })
  return result.job?.status ?? "queued"
}

/** A failed or cancelled job, back in the queue with its attempts reset. */
export async function requeueLabelJob(id: string): Promise<LabelJobStatus> {
  if (isDemo()) return demo.requeue(id)
  const result = await pb.send<{ job?: JobRow }>(`/api/vault/labels/${id}/requeue`, {
    method: "POST",
    body: {},
  })
  return result.job?.status ?? "queued"
}

/**
 * The buy-in behind a number staff typed or scanned.
 *
 * The queue route takes a record id, and what is written on a receipt and
 * printed on a label is `GG-BI-000123`, so the counter turns one into the
 * other. `trade_ins` is a staff-readable collection, which is why this is a
 * read and not a route of its own.
 */
export async function findTradeInByNumber(number: string): Promise<string | null> {
  const wanted = number.trim().toUpperCase()
  if (!wanted) return null
  if (isDemo()) return demo.tradeInIdByNumber(wanted)
  const row = await pb
    .collection("trade_ins")
    .getFirstListItem<{ id: string }>(`number = "${wanted.replace(/["\\]/g, "\\$&")}"`)
    .catch(() => null)
  return row?.id ?? null
}

/**
 * Follows `label_jobs` so a label queued on a phone reaches the counter's
 * printer without waiting for the poll.
 *
 * The subscription is the quick path, not the only one: the runner polls
 * every five seconds underneath it, so a socket that never connects (an
 * offline tab, a proxy that drops websockets) only costs a few seconds.
 */
export function subscribeLabelJobs(onChange: () => void): () => void {
  if (isDemo()) return demo.subscribe(onChange)

  let live = true
  let unsubscribe: (() => void) | null = null

  void pb
    .collection("label_jobs")
    .subscribe("*", () => onChange())
    .then((stop) => {
      if (!live) {
        void stop()
        return
      }
      unsubscribe = stop
    })
    .catch(() => {
      // The poll is the fallback, and it is already running.
    })

  return () => {
    live = false
    if (unsubscribe) void unsubscribe()
  }
}
