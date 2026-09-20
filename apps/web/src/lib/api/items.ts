/**
 * Stock reads and the small writes the item page makes.
 *
 * Live mode talks to PocketBase's collection API (`items` is staff-only, see
 * 1789819320_stock_collections.js); demo mode answers from the same in-memory
 * store Add stock appends to. Screens call these, never `pb` directly.
 */
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemDetailLine, platformForItem } from "@/lib/api/item-shape"
import * as demo from "@/lib/api/demo/items"
import type {
  CardRecord,
  GameRecord,
  ItemDetail,
  ItemEvent,
  ItemFilters,
  ItemListPage,
  ItemPatch,
  ItemSummary,
  LocationRecord,
  SaleLineRecord,
  SaleRecord,
  StockItemRecord,
} from "@/lib/api/types"

export { platformForItem, itemDetailLine, templateForItem } from "@/lib/api/item-shape"

const PER_PAGE = 25

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

type ExpandedItem = StockItemRecord & {
  expand?: {
    card?: CardRecord
    game?: GameRecord
    location?: LocationRecord
    reserved_for?: { id: string; name?: string }
    trade_in_line?: {
      id: string
      expand?: { trade_in?: { number?: string; expand?: { customer?: { name?: string; code?: string } } } }
    }
  }
}

const DETAIL_EXPAND =
  "card,game,location,reserved_for,trade_in_line.trade_in,trade_in_line.trade_in.customer"

function imageFor(item: ExpandedItem): string | undefined {
  const card = item.expand?.card
  if (card?.image_small || card?.image_large) return card.image_small || card.image_large
  const photo = item.photos?.[0]
  if (photo) return pb.files.getURL(item, photo)
  return undefined
}

function toSummary(item: ExpandedItem): ItemSummary {
  return {
    id: item.id,
    sku: item.sku,
    kind: item.kind,
    title: item.title || item.expand?.card?.name || "Untitled item",
    detail: itemDetailLine(item),
    condition: item.condition || "",
    price: item.price ?? 0,
    status: item.status ?? "in_stock",
    locationName: item.expand?.location?.name ?? "",
    image: imageFor(item),
    platform: platformForItem(item),
    qty: item.qty ?? 1,
    game: item.game ?? null,
  }
}

type ExpandedSaleLine = SaleLineRecord & { expand?: { sale?: SaleRecord } }

/** Created, sold, refunded, reserved and written off, newest first. */
async function historyFor(item: ExpandedItem): Promise<ItemEvent[]> {
  const events: ItemEvent[] = [
    {
      kind: "created",
      at: item.acquired_at || item.created || new Date().toISOString(),
      detail:
        item.source === "trade_in"
          ? "Bought in over the counter"
          : item.source === "opening_stock"
            ? "Opening stock"
            : "Added to stock",
    },
  ]

  const lines = await pb
    .collection("sale_lines")
    .getFullList<ExpandedSaleLine>({
      filter: `item = "${quote(item.id)}"`,
      expand: "sale",
      sort: "-created",
    })
    .catch(() => [] as ExpandedSaleLine[])

  for (const line of lines) {
    const sale = line.expand?.sale
    events.push({
      kind: line.status === "refunded" ? "refunded" : "sold",
      at: sale?.created ?? line.created ?? "",
      detail: `${line.status === "refunded" ? "Refunded on" : "Sold on"} ${sale?.number ?? "a sale"}`,
    })
  }

  if (item.label_printed_at) {
    events.push({ kind: "label", at: item.label_printed_at, detail: "Label printed" })
  }
  if (item.status === "reserved" && item.reserved_until) {
    events.push({
      kind: "reserved",
      at: item.updated ?? "",
      detail: `Reserved until ${new Date(item.reserved_until).toLocaleString("en-GB")}`,
    })
  }
  if (item.status === "written_off") {
    events.push({
      kind: "written_off",
      at: item.updated ?? "",
      detail: item.notes || "Written off",
    })
  }

  return events.filter((event) => event.at).sort((a, b) => b.at.localeCompare(a.at))
}

async function toDetail(item: ExpandedItem): Promise<ItemDetail> {
  const tradeIn = item.expand?.trade_in_line?.expand?.trade_in
  const seller = tradeIn?.expand?.customer
  return {
    ...item,
    image: imageFor(item),
    platform: platformForItem(item),
    gameName: item.expand?.game?.name ?? "",
    locationName: item.expand?.location?.name ?? "",
    tradeInNumber: tradeIn?.number ?? null,
    sellerName: seller?.name ?? null,
    sellerCode: seller?.code ?? null,
    reservedForName: item.expand?.reserved_for?.name ?? null,
    reservedUntil: item.reserved_until ?? null,
    history: await historyFor(item),
  }
}

/** The whole item page in one call, or null when the code is not ours. */
export async function getItem(sku: string): Promise<ItemDetail | null> {
  if (isDemo()) return demo.getItem(sku)
  try {
    const item = await pb
      .collection("items")
      .getFirstListItem<ExpandedItem>(`sku = "${quote(sku)}"`, { expand: DETAIL_EXPAND })
    return await toDetail(item)
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) return null
    throw error
  }
}

/** Price, location, status or notes. Everything else is a route. */
export async function updateItem(id: string, patch: ItemPatch): Promise<ItemDetail> {
  if (isDemo()) return demo.updateItem(id, patch)
  const body: Record<string, unknown> = {}
  if (patch.price !== undefined) body.price = patch.price
  if (patch.locationId !== undefined) body.location = patch.locationId || null
  if (patch.status !== undefined) body.status = patch.status
  if (patch.notes !== undefined) body.notes = patch.notes
  const item = await pb
    .collection("items")
    .update<ExpandedItem>(id, body, { expand: DETAIL_EXPAND })
  return toDetail(item)
}

/** One page of the stock table, filtered and searched. */
export async function listItems(
  filters: ItemFilters = {},
  page = 1
): Promise<ItemListPage> {
  if (isDemo()) return demo.listItems(filters, page)

  const clauses: string[] = []
  if (filters.status) clauses.push(`status = "${quote(filters.status)}"`)
  if (filters.locationId) clauses.push(`location = "${quote(filters.locationId)}"`)
  if (filters.search?.trim()) {
    const needle = quote(filters.search.trim())
    clauses.push(
      `(title ~ "${needle}" || sku ~ "${needle}" || set_code ~ "${needle}" || number ~ "${needle}" || ean ~ "${needle}")`
    )
  }

  const result = await pb.collection("items").getList<ExpandedItem>(page, PER_PAGE, {
    filter: clauses.join(" && "),
    expand: "card,location",
    sort: "-created",
  })

  return {
    items: result.items.map(toSummary),
    page: result.page,
    perPage: result.perPage,
    totalItems: result.totalItems,
    totalPages: result.totalPages,
  }
}

/** A 48-hour hold, the same window a want-list match gets. */
export async function reserveItem(
  id: string,
  customerId: string
): Promise<ItemDetail> {
  if (isDemo()) return demo.reserveItem(id, customerId)
  const until = new Date()
  until.setHours(until.getHours() + 48)
  const item = await pb.collection("items").update<ExpandedItem>(
    id,
    {
      status: "reserved",
      reserved_for: customerId,
      reserved_until: until.toISOString(),
    },
    { expand: DETAIL_EXPAND }
  )
  return toDetail(item)
}

/** Damaged, lost or given away. The reason goes on the record. */
export async function writeOffItem(
  id: string,
  reason: string
): Promise<ItemDetail> {
  if (isDemo()) return demo.writeOffItem(id, reason)
  const item = await pb
    .collection("items")
    .update<ExpandedItem>(id, { status: "written_off", notes: reason }, {
      expand: DETAIL_EXPAND,
    })
  return toDetail(item)
}
