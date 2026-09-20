/**
 * The want list: cards a customer is after, and the holds the shop puts on
 * an item when one comes in.
 *
 * Adding and closing are the two custom routes. Reading is a collection-API
 * read of the customer's own rows, which is what the Phase 5 list means by
 * "rows readable by their customer as now"; the matched item is expanded so
 * the row can say what is being held and until when.
 */
import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { demoAddWant, demoCloseWant, demoListWants } from "@/lib/api/demo/portal"
import type {
  CardRecord,
  ItemRecord,
  NewWantInput,
  WantListRecord,
  WantListRow,
} from "@/lib/api/types"

function escapeFilter(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

type ExpandedWant = WantListRecord & {
  expand?: {
    card?: CardRecord & { expand?: { set?: { name?: string; code?: string } } }
    matched_item?: ItemRecord & { reserved_until?: string }
  }
}

function toRow(record: ExpandedWant): WantListRow {
  const card = record.expand?.card
  const item = record.expand?.matched_item
  const setName = card?.expand?.set?.name ?? card?.expand?.set?.code ?? ""
  return {
    id: record.id,
    title: card?.name ?? record.free_text ?? "Card",
    subtitle: card
      ? [setName, card.number].filter(Boolean).join(" - ")
      : "Typed in by you",
    image: card?.image_small || card?.image_large || undefined,
    maxPrice: record.max_price ?? null,
    status: record.status ?? "open",
    heldUntil: item?.reserved_until ?? null,
    heldPrice: item?.price ?? null,
    created: record.created ?? "",
  }
}

export async function listMyWants(): Promise<WantListRow[]> {
  if (isDemo()) return demoListWants()
  const id = customerAuthId()
  if (!id) return []
  const page = await pbCustomer.collection("want_list").getList<ExpandedWant>(1, 100, {
    filter: `customer = "${escapeFilter(id)}" && status != "closed"`,
    sort: "-created",
    expand: "card,card.set,matched_item",
  })
  return page.items.map(toRow)
}

export async function addWant(
  input: NewWantInput,
  display: { title: string; subtitle: string }
): Promise<WantListRow> {
  if (isDemo()) return demoAddWant(input, display.title, display.subtitle)
  const body: Record<string, unknown> = {}
  if (input.cardId) body.card = input.cardId
  if (input.freeText) body.free_text = input.freeText
  if (input.maxPrice !== null) body.max_price = input.maxPrice
  const record = await pbCustomer.send<ExpandedWant>("/api/vault/want-list", {
    method: "POST",
    body,
  })
  return {
    ...toRow(record),
    title: display.title || toRow(record).title,
    subtitle: display.subtitle || toRow(record).subtitle,
  }
}

export async function closeWant(id: string): Promise<void> {
  if (isDemo()) {
    demoCloseWant(id)
    return
  }
  await pbCustomer.send(`/api/vault/want-list/${id}/close`, { method: "POST" })
}
