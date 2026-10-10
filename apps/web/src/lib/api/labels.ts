/**
 * The label queue. `label_jobs` rows are ordinary records with a staff create
 * rule (docs/api-contract.md, "Labels"), so there is no custom route: the
 * print page renders them and marks them printed when the dialog closes.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemDetailLine, templateForItem } from "@/lib/api/item-shape"
import * as demo from "@/lib/api/demo/labels"
import type {
  LabelJobDetail,
  LabelJobStatus,
  LabelTemplateKey,
  StockItemRecord,
} from "@/lib/api/types"

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

interface TemplateRecord {
  id: string
  key: LabelTemplateKey
}

type ExpandedJob = {
  id: string
  item: string
  template: string
  copies?: number
  status?: LabelJobStatus
  created?: string
  /** Phase 7's queue fields: who has it, and why it last failed. */
  printer?: string
  error?: string
  attempts?: number
  expand?: { item?: StockItemRecord; template?: TemplateRecord }
}

function toDetail(job: ExpandedJob): LabelJobDetail {
  const item = job.expand?.item
  return {
    id: job.id,
    status: job.status ?? "queued",
    copies: job.copies ?? 1,
    template:
      job.expand?.template?.key ??
      (item ? templateForItem(item.kind, item.completeness) : "toploader_40x20"),
    itemId: job.item,
    code: item?.sku ?? "",
    title: item?.title ?? "",
    detail: item ? itemDetailLine(item) : "",
    condition: item?.condition ?? "",
    price: item?.price ?? 0,
    requestedAt: job.created ?? "",
    printer: job.printer ?? "",
    error: job.error ?? "",
    attempts: job.attempts ?? 0,
  }
}

const JOB_EXPAND = "item,template"

/** As many as one screen can be read at: a queue longer than this is a job for the filters. */
const JOB_PAGE = 200

/** One job per item. The template follows the item unless one is named. */
export async function queueLabels(
  itemIds: string[],
  templateKey?: LabelTemplateKey
): Promise<LabelJobDetail[]> {
  if (isDemo()) return demo.queue(itemIds, templateKey)

  const templates = await pb
    .collection("label_templates")
    .getFullList<TemplateRecord>({ filter: "active = true" })

  const byKey = new Map(templates.map((template) => [template.key, template.id]))
  const created: LabelJobDetail[] = []

  for (const itemId of itemIds) {
    const item = await pb.collection("items").getOne<StockItemRecord>(itemId)
    const key = templateKey ?? templateForItem(item.kind, item.completeness)
    const templateId = byKey.get(key) ?? templates[0]?.id
    if (!templateId) throw new Error("No label template is set up yet.")
    const job = await pb.collection("label_jobs").create<ExpandedJob>(
      {
        item: itemId,
        template: templateId,
        copies: 1,
        status: "queued",
        requested_by: pb.authStore.record?.id,
      },
      { expand: JOB_EXPAND }
    )
    created.push(toDetail(job))
  }

  return created
}

/**
 * The queue screen's list. Blank means every job; a list of statuses reads
 * as "any of these", which is what the waiting view wants: a job somebody
 * else's printer is holding is still waiting as far as the counter is
 * concerned.
 */
export async function listLabelJobs(
  status?: LabelJobStatus | LabelJobStatus[]
): Promise<LabelJobDetail[]> {
  const wanted = status ? (Array.isArray(status) ? status : [status]) : []
  if (isDemo()) return demo.list(wanted)
  // Newest first, and capped: bulk reprint can add 500 at a time and the
  // printed view would otherwise read every label the shop has ever run.
  const page = await pb.collection("label_jobs").getList<ExpandedJob>(1, JOB_PAGE, {
    filter: wanted.map((one) => `status = "${quote(one)}"`).join(" || "),
    expand: JOB_EXPAND,
    sort: "-created",
  })
  return page.items.map(toDetail)
}

/** The jobs named in `/labels/print?jobs=`, in the order they were asked for. */
export async function getLabelJobs(ids: string[]): Promise<LabelJobDetail[]> {
  if (isDemo()) return demo.byIds(ids)
  if (ids.length === 0) return []
  const filter = ids.map((id) => `id = "${quote(id)}"`).join(" || ")
  const jobs = await pb
    .collection("label_jobs")
    .getFullList<ExpandedJob>({ filter, expand: JOB_EXPAND })
  const byId = new Map(jobs.map((job) => [job.id, toDetail(job)]))
  return ids
    .map((id) => byId.get(id))
    .filter((job): job is LabelJobDetail => Boolean(job))
}

/** Called once the browser's print dialog has closed. */
export async function markLabelJobsPrinted(
  ids: string[]
): Promise<LabelJobDetail[]> {
  if (isDemo()) return demo.markPrinted(ids)
  const printedAt = new Date().toISOString()
  const printed: LabelJobDetail[] = []
  for (const id of ids) {
    const job = await pb
      .collection("label_jobs")
      .update<ExpandedJob>(id, { status: "printed", printed_at: printedAt }, {
        expand: JOB_EXPAND,
      })
    printed.push(toDetail(job))
    if (job.item) {
      await pb
        .collection("items")
        .update(job.item, { label_printed_at: printedAt })
        .catch(() => undefined)
    }
  }
  return printed
}
