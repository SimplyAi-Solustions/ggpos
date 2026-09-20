/**
 * The label queue, answered from memory. A job carries the words the print
 * page puts on the label, so `/labels/print` never has to go back for the
 * item behind it.
 */
import { itemDetailLine, templateForItem } from "@/lib/api/item-shape"
import {
  demoId,
  demoLabelJobs,
  ensureSeeded,
  itemStore,
} from "@/lib/api/demo/store"
import type { LabelJobDetail, LabelJobStatus, LabelTemplateKey } from "@/lib/api/types"

export function queue(
  itemIds: string[],
  template?: LabelTemplateKey
): LabelJobDetail[] {
  ensureSeeded()
  const created: LabelJobDetail[] = []
  for (const itemId of itemIds) {
    const item = itemStore().find((row) => row.id === itemId)
    if (!item) continue
    const job: LabelJobDetail = {
      id: demoId("label_job"),
      status: "queued",
      copies: 1,
      template: template ?? templateForItem(item.kind, item.completeness),
      itemId: item.id,
      code: item.sku,
      title: item.title ?? "",
      detail: itemDetailLine(item),
      condition: item.condition ?? "",
      price: item.price ?? 0,
      requestedAt: new Date().toISOString(),
    }
    demoLabelJobs.unshift(job)
    created.push(job)
  }
  return created
}

export function list(status: LabelJobStatus[] = []): LabelJobDetail[] {
  ensureSeeded()
  return demoLabelJobs
    .filter((job) => status.length === 0 || status.includes(job.status))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .map((job) => ({ ...job }))
}

export function byIds(ids: string[]): LabelJobDetail[] {
  ensureSeeded()
  return ids
    .map((id) => demoLabelJobs.find((job) => job.id === id))
    .filter((job): job is LabelJobDetail => Boolean(job))
}

export function markPrinted(ids: string[]): LabelJobDetail[] {
  ensureSeeded()
  const printed: LabelJobDetail[] = []
  for (const id of ids) {
    const job = demoLabelJobs.find((row) => row.id === id)
    if (!job) continue
    job.status = "printed"
    printed.push(job)
    const item = itemStore().find((row) => row.id === job.itemId)
    if (item) item.label_printed_at = new Date().toISOString()
  }
  return printed
}
