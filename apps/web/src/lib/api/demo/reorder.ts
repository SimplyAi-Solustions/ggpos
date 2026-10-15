/**
 * The supplier reorder report and customer requests in demo mode
 * (docs/api-contract-reorder.md, sections 2 to 4), answered from memory.
 *
 * The report adds up exactly as the route does, through the shared
 * `buildReorderLines` and `reorderTotals`, over the demo item store: the
 * Games Workshop rack in `demo/supplier-stock.ts`, anything Add stock or
 * the item page has since put on the supplier, and every Keep on shelf
 * changed from the report itself. Units sold are the rack's seeded week
 * of sales plus anything rung up on the demo till since, kept less
 * refunded, in the range by the sale's day.
 *
 * Refusals are the route's and the hooks' own sentences, as a
 * `ClientResponseError`, so a screen shows them the same way live or demo.
 */
import { ClientResponseError } from "pocketbase"
import {
  buildReorderLines,
  displayCode,
  isOpenRequest,
  REQUEST_STATUSES,
  reorderTotals,
  type ReorderItem,
  type ReorderReport,
  type ReorderSold,
  type RequestStatus,
  type StockRequestView,
} from "@gg/shared"

import { isIsoDay, rangeLength, daysBetween } from "@/lib/api/dates"
import { DEMO_STAFF } from "@/lib/api/fixtures"
import { demoCategoryPaths } from "@/lib/api/demo/categories"
import { DEMO_SALE_CUSTOMERS, demoSales, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import { DEMO_SUPPLIER_SALES, demoDaysAgo } from "@/lib/api/demo/supplier-stock"
import { DEMO_GW_ID, demoSupplierById } from "@/lib/api/demo/suppliers"
import type {
  ItemStatus,
  NewStockRequestInput,
  StockItemRecord,
  StockRequestPatch,
} from "@/lib/api/types"

function refuse(status: number, message: string): never {
  throw new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

/** The statuses whose `qty` is on the shelf (`STOCK_STATUS_FILTER`). */
const ON_HAND: ReadonlySet<ItemStatus> = new Set<ItemStatus>(["in_stock", "reserved", "listed_ebay"])

/** A stock row as the route reads it. */
export function toReorderItem(item: StockItemRecord, paths: Map<string, string>): ReorderItem {
  const status = item.status ?? "in_stock"
  return {
    id: item.id,
    sku: item.sku,
    title: item.title || "Untitled item",
    ean: item.ean ?? "",
    supplierCode: item.supplier_code ?? "",
    categoryPath: item.category ? (paths.get(item.category) ?? "") : "",
    onHand: ON_HAND.has(status) ? Math.max(0, item.qty ?? 1) : 0,
    shelfTarget: item.shelf_target && item.shelf_target > 0 ? item.shelf_target : null,
    price: item.price ?? 0,
    updated: item.updated ?? item.created ?? "",
  }
}

/** The UTC day an ISO moment falls on. */
function dayOf(iso: string | undefined): string {
  return (iso ?? "").slice(0, 10)
}

function inRange(day: string, from: string, to: string): boolean {
  return Boolean(day) && day >= from && day <= to
}

/** Units kept of each of these rows in the range: the seeded week, then the demo till's. */
function soldIn(itemIds: Set<string>, from: string, to: string): ReorderSold[] {
  const sold: ReorderSold[] = []
  for (const line of DEMO_SUPPLIER_SALES) {
    if (!itemIds.has(line.itemId)) continue
    if (!inRange(dayOf(demoDaysAgo(line.daysAgo)), from, to)) continue
    sold.push({ itemId: line.itemId, qty: line.qty - line.refunded })
  }
  for (const sale of demoSales) {
    if (!inRange(dayOf(sale.created), from, to)) continue
    for (const line of sale.lines) {
      if (!itemIds.has(line.item)) continue
      const kept = (line.qty ?? 1) - (line.refunded_qty ?? 0)
      if (kept > 0) sold.push({ itemId: line.item, qty: kept })
    }
  }
  return sold
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface DemoRequest {
  id: string
  supplier: string
  title: string
  qty: number
  customer: string
  contactName: string
  contactPhone: string
  notes: string
  status: RequestStatus
  created: string
  statusChangedAt: string
  createdByName: string
}

/** Three open, oldest first, and one already collected. */
const SEED_REQUESTS: DemoRequest[] = [
  {
    id: "request_demo_1",
    supplier: DEMO_GW_ID,
    title: "Combat Patrol: Necrons",
    qty: 1,
    customer: "cust_demo_2",
    contactName: "",
    contactPhone: "",
    notes: "",
    status: "waiting",
    created: demoDaysAgo(6, 15),
    statusChangedAt: demoDaysAgo(6, 15),
    createdByName: DEMO_STAFF.name,
  },
  {
    id: "request_demo_2",
    supplier: DEMO_GW_ID,
    title: "Citadel Contrast: Ultramarines Blue",
    qty: 2,
    customer: "",
    contactName: "Sam Whitlock",
    contactPhone: "07700 900842",
    notes: "Painting a Space Marine army with his son.",
    status: "asked",
    created: demoDaysAgo(4, 12),
    statusChangedAt: demoDaysAgo(3, 10),
    createdByName: DEMO_STAFF.name,
  },
  {
    id: "request_demo_3",
    supplier: DEMO_GW_ID,
    title: "Kill Team: Hivestorm",
    qty: 1,
    customer: "cust_demo_1",
    contactName: "",
    contactPhone: "",
    notes: "Wants it before the league night on the 24th.",
    status: "ordered",
    created: demoDaysAgo(2, 16),
    statusChangedAt: demoDaysAgo(1, 9),
    createdByName: DEMO_STAFF.name,
  },
  {
    id: "request_demo_4",
    supplier: DEMO_GW_ID,
    title: "Citadel Shade: Nuln Oil",
    qty: 3,
    customer: "",
    contactName: "Jo Pearce",
    contactPhone: "07700 900617",
    notes: "",
    status: "collected",
    created: demoDaysAgo(12, 14),
    statusChangedAt: demoDaysAgo(8, 11),
    createdByName: DEMO_STAFF.name,
  },
]

let requestRows: DemoRequest[] = SEED_REQUESTS.map((row) => ({ ...row }))

/** Tests only: the four seeded requests again, as they were. */
export function resetDemoRequests(): void {
  requestRows = SEED_REQUESTS.map((row) => ({ ...row }))
}

function toView(row: DemoRequest): StockRequestView {
  const customer = DEMO_SALE_CUSTOMERS.find((entry) => entry.id === row.customer)
  return {
    id: row.id,
    supplierId: row.supplier,
    title: row.title,
    qty: row.qty,
    customerId: row.customer,
    customerName: customer?.name ?? "",
    customerCode: customer ? displayCode(customer.code) : "",
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    notes: row.notes,
    status: row.status,
    created: row.created,
    statusChangedAt: row.statusChangedAt,
    createdByName: row.createdByName,
  }
}

/** A supplier's requests, oldest first: every one, or the open ones. */
export function demoListRequests(filters: { supplierId?: string; open?: boolean }): StockRequestView[] {
  return requestRows.filter(
    (row) =>
      (!filters.supplierId || row.supplier === filters.supplierId) &&
      (!filters.open || isOpenRequest(row.status))
  )
    .sort((a, b) => a.created.localeCompare(b.created))
    .map(toView)
}

/** The hook's checks, in its own words. */
function checkRequest(fields: { title: string; qty: number; customer: string; contactName: string }) {
  if (!fields.title) refuse(400, "Say what the customer is after.")
  if (!Number.isInteger(fields.qty) || fields.qty < 1) {
    refuse(400, "The quantity is a whole number, 1 or more.")
  }
  if (!fields.customer && !fields.contactName) {
    refuse(400, "Add the customer, or a name to contact, so they can be told when it comes in.")
  }
}

export function demoCreateRequest(input: NewStockRequestInput, staffName = DEMO_STAFF.name): StockRequestView {
  const supplier = input.supplierId ? demoSupplierById(input.supplierId) : null
  if (input.supplierId && !supplier) refuse(404, "That supplier was not found.")
  const fields = {
    title: input.title.trim(),
    qty: input.qty,
    customer: input.customerId ?? "",
    contactName: (input.contactName ?? "").trim(),
  }
  checkRequest(fields)
  if (fields.customer && !DEMO_SALE_CUSTOMERS.some((entry) => entry.id === fields.customer)) {
    refuse(404, "That customer was not found.")
  }
  const now = new Date().toISOString()
  const row: DemoRequest = {
    id: `request_${Math.random().toString(36).slice(2, 10)}`,
    supplier: input.supplierId,
    ...fields,
    contactPhone: (input.contactPhone ?? "").trim(),
    notes: (input.notes ?? "").trim(),
    status: "waiting",
    created: now,
    statusChangedAt: now,
    createdByName: staffName,
  }
  requestRows.push(row)
  return toView(row)
}

export function demoUpdateRequest(id: string, patch: StockRequestPatch): StockRequestView {
  const row = requestRows.find((entry) => entry.id === id)
  if (!row) refuse(404, "That request was not found.")
  if (patch.status !== undefined && !REQUEST_STATUSES.includes(patch.status)) {
    refuse(400, "Choose one of the request's statuses.")
  }
  const next = {
    title: row.title,
    qty: patch.qty ?? row.qty,
    customer: row.customer,
    contactName: row.contactName,
  }
  checkRequest(next)
  row.qty = next.qty
  if (patch.notes !== undefined) row.notes = patch.notes.trim()
  if (patch.status !== undefined && patch.status !== row.status) {
    row.status = patch.status
    row.statusChangedAt = new Date().toISOString()
  }
  return toView(row)
}

// ---------------------------------------------------------------------------
// Keep on shelf and the report
// ---------------------------------------------------------------------------

/** Every row of one product to the same target; null or 0 is none. */
export function demoSetShelfTarget(itemIds: string[], target: number | null): void {
  if (target !== null && (!Number.isInteger(target) || target < 0)) {
    refuse(400, "Keep on shelf is a whole number, 0 or more.")
  }
  ensureSeeded()
  const now = new Date().toISOString()
  for (const item of itemStore()) {
    if (!itemIds.includes(item.id)) continue
    item.shelf_target = target ?? 0
    item.updated = now
  }
}

const BAD_DATES = "The dates do not make sense. Check the from and to dates."

/** `GET /api/vault/reorder`, from the demo store. */
export function demoReorderReport(input: { supplierId: string; from: string; to: string }): ReorderReport {
  if (!input.supplierId) refuse(400, "Choose a supplier.")
  const supplier = demoSupplierById(input.supplierId)
  if (!supplier) refuse(404, "That supplier was not found.")
  const { from, to } = input
  if (!isIsoDay(from) || !isIsoDay(to) || daysBetween(from, to) < 0 || rangeLength(from, to) > 400) {
    refuse(400, BAD_DATES)
  }

  ensureSeeded()
  const paths = demoCategoryPaths()
  const rows = itemStore().filter((item) => item.supplier === supplier.id)
  const items = rows.map((item) => toReorderItem(item, paths))
  const sold = soldIn(new Set(rows.map((item) => item.id)), from, to)
  const lines = buildReorderLines(items, sold)
  const requests = demoListRequests({ supplierId: supplier.id, open: true })

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      accountNumber: supplier.accountNumber,
      repName: supplier.repName,
      repEmail: supplier.repEmail,
      repPhone: supplier.repPhone,
    },
    from,
    to,
    lines,
    totals: reorderTotals(lines, requests),
    requests,
  }
}
