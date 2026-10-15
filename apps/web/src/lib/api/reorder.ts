/**
 * Suppliers, the supplier reorder report and customer requests
 * (docs/api-contract-reorder.md, section 4.1).
 *
 * The report is one route, `GET /api/vault/reorder`, which adds up with the
 * shared `buildReorderLines` and `reorderTotals`; suppliers, requests and a
 * product's Keep on shelf are written through the collection API, whose
 * hooks check them. Demo mode answers every call from
 * `lib/api/demo/reorder.ts` and `lib/api/demo/suppliers.ts`, which add up
 * the same way, so every screen works with no server behind it.
 */
import {
  displayCode,
  OPEN_REQUEST_STATUSES,
  type ReorderReport,
  type RequestStatus,
  type StockRequestView,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { escapeFilter } from "@/lib/api/filter"
import * as demo from "@/lib/api/demo/reorder"
import { demoSaveSupplier, demoSuppliers } from "@/lib/api/demo/suppliers"
import type {
  NewStockRequestInput,
  StockRequestPatch,
  StockRequestRecord,
  Supplier,
  SupplierInput,
  SupplierRecord,
} from "@/lib/api/types"

export type { ReorderReport, RequestStatus, StockRequestView }

export const reorderKeys = {
  /** Everything this module reads, for one invalidation after a write. */
  all: ["reorder"] as const,
  report: (supplierId: string, from: string, to: string) =>
    ["reorder", "report", supplierId, from, to] as const,
  requests: (supplierId: string, open: boolean) => ["reorder", "requests", supplierId, open] as const,
}

/** Every list of suppliers on any screen starts with this key. */
export const SUPPLIERS_KEY = ["suppliers"] as const

export function suppliersKey(activeOnly: boolean) {
  return [...SUPPLIERS_KEY, activeOnly ? "active" : "all"] as const
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export function supplierFrom(record: SupplierRecord): Supplier {
  return {
    id: record.id,
    name: record.name,
    accountNumber: record.account_number ?? "",
    repName: record.rep_name ?? "",
    repEmail: record.rep_email ?? "",
    repPhone: record.rep_phone ?? "",
    notes: record.notes ?? "",
    active: record.active === true,
    sort: record.sort ?? 0,
  }
}

/** By `sort`, then name: Games Workshop first. */
export async function listSuppliers(options: { activeOnly?: boolean } = {}): Promise<Supplier[]> {
  if (isDemo()) return demoSuppliers(options.activeOnly)
  const records = await pb.collection("suppliers").getFullList<SupplierRecord>({
    filter: options.activeOnly ? "active = true" : "",
    sort: "sort,name",
  })
  return records.map(supplierFrom)
}

/** Adds one (no id) or saves one. A manager's or an admin's; the hook checks the name. */
export async function saveSupplier(input: SupplierInput): Promise<Supplier> {
  if (isDemo()) return demoSaveSupplier(input)
  const body: Record<string, unknown> = {
    name: input.name.trim(),
    account_number: input.accountNumber.trim(),
    rep_name: input.repName.trim(),
    rep_email: input.repEmail.trim(),
    rep_phone: input.repPhone.trim(),
    notes: input.notes.trim(),
    active: input.active,
  }
  if (input.id) {
    return supplierFrom(await pb.collection("suppliers").update<SupplierRecord>(input.id, body))
  }
  // New ones go to the end of the list.
  const last = await pb
    .collection("suppliers")
    .getList<SupplierRecord>(1, 1, { sort: "-sort" })
    .then((page) => page.items[0]?.sort ?? 0)
    .catch(() => 0)
  return supplierFrom(
    await pb.collection("suppliers").create<SupplierRecord>({ ...body, sort: last + 10 })
  )
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export async function getReorderReport(input: {
  supplierId: string
  from: string
  to: string
}): Promise<ReorderReport> {
  if (isDemo()) return demo.demoReorderReport(input)
  return pb.send<ReorderReport>("/api/vault/reorder", {
    method: "GET",
    query: { supplier: input.supplierId, from: input.from, to: input.to },
  })
}

/**
 * Keep on shelf for one product: the same target on every stock row of it,
 * so a restock row and the row it replaced agree. Null clears it (0).
 */
export async function setShelfTarget(itemIds: string[], target: number | null): Promise<void> {
  if (isDemo()) return demo.demoSetShelfTarget(itemIds, target)
  for (const id of itemIds) {
    await pb.collection("items").update(id, { shelf_target: target ?? 0 })
  }
}

// ---------------------------------------------------------------------------
// Customer requests
// ---------------------------------------------------------------------------

type ExpandedRequest = StockRequestRecord & {
  expand?: {
    customer?: { id: string; name?: string; code?: string }
    created_by?: { id: string; name?: string }
  }
}

const REQUEST_EXPAND = "customer,created_by"

export function requestView(record: ExpandedRequest): StockRequestView {
  const customer = record.expand?.customer
  return {
    id: record.id,
    supplierId: record.supplier ?? "",
    title: record.title,
    qty: record.qty && record.qty > 0 ? record.qty : 1,
    customerId: record.customer ?? "",
    customerName: customer?.name ?? "",
    customerCode: customer?.code ? displayCode(customer.code) : "",
    contactName: record.contact_name ?? "",
    contactPhone: record.contact_phone ?? "",
    notes: record.notes ?? "",
    status: record.status,
    created: record.created ?? "",
    statusChangedAt: record.status_changed_at ?? "",
    createdByName: record.expand?.created_by?.name ?? "",
  }
}

/** A supplier's requests, oldest first: the order they were asked. */
export async function listRequests(filters: {
  supplierId: string
  open?: boolean
}): Promise<StockRequestView[]> {
  if (isDemo()) return demo.demoListRequests(filters)
  const clauses = [`supplier = "${escapeFilter(filters.supplierId)}"`]
  if (filters.open) {
    clauses.push(`(${OPEN_REQUEST_STATUSES.map((status) => `status = "${status}"`).join(" || ")})`)
  }
  const records = await pb.collection("stock_requests").getFullList<ExpandedRequest>({
    filter: clauses.join(" && "),
    expand: REQUEST_EXPAND,
    sort: "created",
  })
  return records.map(requestView)
}

/** Logs a request as Waiting; the hook makes the signed-in staff member `created_by`. */
export async function createRequest(input: NewStockRequestInput): Promise<StockRequestView> {
  if (isDemo()) return demo.demoCreateRequest(input)
  const record = await pb.collection("stock_requests").create<ExpandedRequest>(
    {
      supplier: input.supplierId || null,
      title: input.title.trim(),
      qty: input.qty,
      customer: input.customerId || null,
      contact_name: input.contactName?.trim() ?? "",
      contact_phone: input.contactPhone?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
      status: "waiting",
    },
    { expand: REQUEST_EXPAND }
  )
  return requestView(record)
}

/** Status, notes or quantity. A change of status is stamped by the hook. */
export async function updateRequest(id: string, patch: StockRequestPatch): Promise<StockRequestView> {
  if (isDemo()) return demo.demoUpdateRequest(id, patch)
  const body: Record<string, unknown> = {}
  if (patch.status !== undefined) body.status = patch.status
  if (patch.notes !== undefined) body.notes = patch.notes.trim()
  if (patch.qty !== undefined) body.qty = patch.qty
  return requestView(
    await pb
      .collection("stock_requests")
      .update<ExpandedRequest>(id, body, { expand: REQUEST_EXPAND })
  )
}
