/**
 * The want list: cards a customer is after, and the holds the shop puts on
 * an item when one comes in.
 *
 * Adding and closing are the two custom routes. Reading is a collection-API
 * read of the customer's own rows, which is what the Phase 5 list means by
 * "rows readable by their customer as now"; the matched item is expanded so
 * the row can say what is being held and until when.
 *
 * The counter's own reads of the holds themselves are in their own section
 * below.
 */
import { displayCode } from "@gg/shared"

import { pb as pbStaff } from "@/lib/pb"
import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  demoAddWant,
  demoCloseWant,
  demoHoldsEndingToday,
  demoListWants,
} from "@/lib/api/demo/portal"
import type {
  CardRecord,
  HoldRow,
  ItemRecord,
  NewWantInput,
  StockItemRecord,
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

// ---------------------------------------------------------------------------
// The counter's own calls
//
// A hold is an `items` row, not a want-list row: the match hook reserves the
// item, and `holds_release` puts it back. So the counter reads the items,
// which covers a hold a staff member put on by hand as well as one a want
// list made, and goes through `pb`, the counter's own client.
// ---------------------------------------------------------------------------

/** The end of today, local time: what "ending today" is measured against. */
export function endOfToday(now: Date = new Date()): Date {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return end
}

type ReservedItem = StockItemRecord & {
  expand?: { reserved_for?: { id: string; name?: string; code?: string } }
}

function toHoldRow(item: ReservedItem): HoldRow {
  const customer = item.expand?.reserved_for
  return {
    itemId: item.id,
    sku: item.sku,
    title: item.title || "Item",
    price: item.price ?? 0,
    customerId: customer?.id ?? item.reserved_for ?? "",
    customerName: customer?.name ?? "",
    customerCode: customer?.code ? displayCode(customer.code) : "",
    until: item.reserved_until ?? "",
  }
}

/**
 * Every hold that runs out today, soonest first.
 *
 * Anything already past its time is included: the release cron runs every
 * fifteen minutes, so a hold that has just lapsed is still on the shelf and
 * is still worth a phone call.
 */
export async function listHoldsEndingToday(
  now: Date = new Date()
): Promise<HoldRow[]> {
  if (isDemo()) return demoHoldsEndingToday(now)
  const until = endOfToday(now).toISOString()
  const page = await pbStaff.collection("items").getList<ReservedItem>(1, 50, {
    filter: `status = "reserved" && reserved_until != "" && reserved_until <= "${escapeFilter(until)}"`,
    sort: "reserved_until",
    expand: "reserved_for",
  })
  return page.items.map(toHoldRow)
}

/** The count alone, for Home's waiting line. */
export async function countHoldsEndingToday(
  now: Date = new Date()
): Promise<number> {
  if (isDemo()) return demoHoldsEndingToday(now).length
  const until = endOfToday(now).toISOString()
  const page = await pbStaff.collection("items").getList(1, 1, {
    filter: `status = "reserved" && reserved_until != "" && reserved_until <= "${escapeFilter(until)}"`,
    fields: "id",
  })
  return page.totalItems
}
