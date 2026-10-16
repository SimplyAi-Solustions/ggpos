/**
 * Stock, answered from the demo item store. Same signatures as the live
 * implementations in `src/lib/api/items.ts`, so no screen branches on mode.
 */
import { displayCode, treatmentFields } from "@gg/shared"

import { ClientResponseError } from "pocketbase"

import { DEMO_GAMES, DEMO_LOCATIONS } from "@/lib/api/fixtures"
import {
  itemDetailLine,
  platformForItem,
  productRowIdsIn,
  supplierFieldsOf,
  supplierPatchBody,
} from "@/lib/api/item-shape"
import { demoSupplierById } from "@/lib/api/demo/suppliers"
import { demoBranchForItem } from "@/lib/api/demo/branches"
import { demoCategoryPaths, demoSubtreeIds } from "@/lib/api/demo/categories"
import {
  DEMO_SALE_CUSTOMERS,
  demoBuyIns,
  demoCardImage,
  demoLabelJobs,
  demoSales,
  ensureSeeded,
  itemStore,
} from "@/lib/api/demo/store"
import type {
  ItemDetail,
  ItemEvent,
  ItemFilters,
  ItemListPage,
  ItemPatch,
  StockItemRecord,
  ItemSummary,
} from "@/lib/api/types"

const PER_PAGE = 25

function gameName(id?: string): string {
  return DEMO_GAMES.find((game) => game.id === id)?.name ?? ""
}

function locationName(id?: string): string {
  return DEMO_LOCATIONS.find((location) => location.id === id)?.name ?? ""
}

export function toSummary(
  item: StockItemRecord,
  paths: Map<string, string> = demoCategoryPaths()
): ItemSummary {
  return {
    id: item.id,
    sku: item.sku,
    kind: item.kind,
    title: item.title || "Untitled item",
    detail: itemDetailLine(item),
    condition: item.condition || "",
    price: item.price ?? 0,
    status: item.status ?? "in_stock",
    locationName: locationName(item.location),
    image: demoCardImage(item.card),
    platform: platformForItem(item),
    qty: item.qty ?? 1,
    game: item.game ?? null,
    categoryId: item.category ?? "",
    categoryPath: item.category ? (paths.get(item.category) ?? "") : "",
  }
}

function historyFor(item: StockItemRecord): ItemEvent[] {
  const events: ItemEvent[] = [
    {
      kind: "created",
      at: item.created ?? new Date().toISOString(),
      detail:
        item.source === "trade_in"
          ? "Bought in over the counter"
          : item.source === "opening_stock"
            ? "Opening stock"
            : "Added to stock",
    },
  ]

  for (const sale of demoSales) {
    for (const line of sale.lines) {
      if (line.item !== item.id) continue
      events.push({
        kind: "sold",
        at: sale.created ?? new Date().toISOString(),
        detail: `Sold on ${sale.number}`,
      })
      if ((line.refunded_qty ?? 0) > 0) {
        events.push({
          kind: "refunded",
          at: sale.created ?? new Date().toISOString(),
          detail: `Refunded on ${sale.number}`,
        })
      }
    }
  }

  for (const job of demoLabelJobs) {
    if (job.itemId !== item.id || job.status !== "printed") continue
    events.push({ kind: "label", at: job.requestedAt, detail: "Label printed" })
  }

  if (item.status === "reserved" && item.reserved_until) {
    events.push({
      kind: "reserved",
      at: item.updated ?? item.created ?? new Date().toISOString(),
      detail: "Reserved for a customer",
    })
  }
  if (item.status === "written_off") {
    events.push({
      kind: "written_off",
      at: item.updated ?? new Date().toISOString(),
      detail: item.notes || "Written off",
    })
  }

  return events.sort((a, b) => b.at.localeCompare(a.at))
}

export function getItem(sku: string): ItemDetail | null {
  ensureSeeded()
  // Files the row first if nobody has, so its branch comes back with it.
  const paths = demoCategoryPaths()
  const item = itemStore().find((row) => row.sku === sku)
  if (!item) return null

  const buyIn = item.source === "trade_in" ? demoBuyIns[0] : undefined
  const reservedFor = DEMO_SALE_CUSTOMERS.find(
    (customer) => customer.id === item.reserved_for
  )

  return {
    ...item,
    image: demoCardImage(item.card),
    platform: platformForItem(item),
    gameName: gameName(item.game),
    locationName: locationName(item.location),
    tradeInNumber: buyIn?.number ?? null,
    sellerName: buyIn?.customerName ?? null,
    sellerCode: buyIn ? DEMO_SALE_CUSTOMERS[2]?.code ?? null : null,
    reservedForName: reservedFor?.name ?? null,
    reservedForCode: reservedFor?.code ? displayCode(reservedFor.code) : null,
    reservedUntil: item.reserved_until ?? null,
    history: historyFor(item),
    categoryPath: item.category ? (paths.get(item.category) ?? "") : "",
    // Filed by the shared rule, as the server files stock, so the till
    // prices an offer on a branch the way the sale does.
    category: item.category ?? demoBranchForItem(item),
    ...supplierFieldsOf(item, demoSupplierById(item.supplier)?.name ?? ""),
  }
}

/** The items guard's refusal for a target that is not a whole number 0 or more. */
export const SHELF_TARGET_REFUSAL = "Keep on shelf is a whole number, 0 or more."

/** The supplier fields of a patch, checked as the server checks them. */
export function applySupplierPatch(item: StockItemRecord, patch: ItemPatch): void {
  const target = patch.shelfTarget
  if (target !== undefined && target !== null && (!Number.isInteger(target) || target < 0)) {
    throw new ClientResponseError({
      status: 400,
      response: { code: 400, message: SHELF_TARGET_REFUSAL, data: {} },
    })
  }
  if (patch.supplierId && !demoSupplierById(patch.supplierId)) {
    throw new ClientResponseError({
      status: 404,
      response: { code: 404, message: "That supplier was not found.", data: {} },
    })
  }
  const body = supplierPatchBody(patch)
  if (body.supplier !== undefined) item.supplier = body.supplier ?? ""
  if (body.shelf_target !== undefined) item.shelf_target = body.shelf_target
  if (body.supplier_code !== undefined) item.supplier_code = body.supplier_code
}

export function updateItem(id: string, patch: ItemPatch): ItemDetail {
  ensureSeeded()
  const item = itemStore().find((row) => row.id === id)
  if (!item) throw new Error("That item is no longer in stock.")
  applySupplierPatch(item, patch)
  if (patch.price !== undefined) item.price = patch.price
  if (patch.locationId !== undefined) item.location = patch.locationId
  if (patch.status !== undefined) item.status = patch.status
  if (patch.notes !== undefined) item.notes = patch.notes
  if (patch.vatTreatment !== undefined) Object.assign(item, treatmentFields(patch.vatTreatment))
  item.updated = new Date().toISOString()
  return getItem(item.sku) as ItemDetail
}

/** The live call's twin: the supplier fields on every row of the product. */
export function updateProductSupplierFields(
  item: Pick<StockItemRecord, "id" | "supplier" | "supplier_code" | "ean" | "title">,
  patch: Pick<ItemPatch, "supplierId" | "shelfTarget" | "supplierCode">
): { item: ItemDetail; rows: number } {
  ensureSeeded()
  const ids = productRowIdsIn(item, itemStore())
  const now = new Date().toISOString()
  // Checked on the item first, so a refusal changes nothing anywhere.
  const self = itemStore().find((row) => row.id === item.id)
  if (!self) throw new Error("That item is no longer in stock.")
  applySupplierPatch(self, patch)
  for (const row of itemStore()) {
    if (row.id === item.id || !ids.includes(row.id)) continue
    applySupplierPatch(row, patch)
    row.updated = now
  }
  self.updated = now
  return { item: getItem(self.sku) as ItemDetail, rows: ids.length }
}

export function listItems(filters: ItemFilters, page: number): ItemListPage {
  ensureSeeded()
  // Files any row nobody has filed yet, so the paths below are all there.
  const paths = demoCategoryPaths()
  const within = filters.category ? demoSubtreeIds(filters.category) : null
  const needle = filters.search?.trim().toLowerCase() ?? ""
  const matched = itemStore().filter((item) => {
    if (filters.status && (item.status ?? "in_stock") !== filters.status) return false
    if (filters.locationId && item.location !== filters.locationId) return false
    if (within && !within.has(item.category ?? "")) return false
    if (!needle) return true
    const haystack = [item.title, item.sku, item.set_code, item.number, item.ean]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    return haystack.includes(needle)
  })

  const start = (page - 1) * PER_PAGE
  return {
    items: matched.slice(start, start + PER_PAGE).map((item) => toSummary(item, paths)),
    page,
    perPage: PER_PAGE,
    totalItems: matched.length,
    totalPages: Math.max(1, Math.ceil(matched.length / PER_PAGE)),
  }
}

/** The shop's own hold window, which the caller reads from settings. */
export function reserveItem(id: string, customerId: string, hours = 48): ItemDetail {
  ensureSeeded()
  const item = itemStore().find((row) => row.id === id)
  if (!item) throw new Error("That item is no longer in stock.")
  if (item.status === "sold") throw new Error("That item is already sold.")
  const until = new Date()
  until.setHours(until.getHours() + hours)
  item.status = "reserved"
  item.reserved_for = customerId
  item.reserved_until = until.toISOString()
  item.updated = new Date().toISOString()
  return getItem(item.sku) as ItemDetail
}

export function writeOffItem(id: string, reason: string): ItemDetail {
  ensureSeeded()
  const item = itemStore().find((row) => row.id === id)
  if (!item) throw new Error("That item is no longer in stock.")
  item.status = "written_off"
  item.notes = reason
  item.updated = new Date().toISOString()
  return getItem(item.sku) as ItemDetail
}
