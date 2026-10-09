/**
 * The till's reads and writes (docs/api-contract-epos.md, section 4): the
 * catalogue and its dynamic categories, sale completion with tenders, the
 * sale lookup for returns, the refund, the receipt email, parked tickets
 * and the voids of a cleared ticket.
 *
 * Everything a manager might have to approve goes through `withOverride`:
 * the route answers 403 `needs_override`, the approval dialog takes a
 * manager's PIN, and the same call goes again with the token. The server
 * is the judge; the till never decides on its own that a discount or a
 * refund is allowed.
 *
 * Not re-exported from `lib/api/index.ts`: that barrel travels in the entry
 * chunk, and this belongs to the till's route alone.
 */
import {
  formatGBP,
  type Capability,
  type SaleLookup,
  type TillCatalogue,
  type TillCatalogueItem,
  type TillCatalogueProduct,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { completeSaleQueued } from "@/lib/api/offline"
import {
  refundSale,
  type TillRefundPayload,
  type TillRefundResult,
  type TillSalePayload,
  type TillSaleResult,
  type TillVoidedLine,
} from "@/lib/api/sales"
import { currentRegisterId } from "@/lib/api/till-session"
import { withOverride } from "@/features/lock/override"
import * as demo from "@/lib/api/demo/till"
import * as demoSales from "@/lib/api/demo/sales"

export type {
  TillRefundPayload,
  TillRefundResult,
  TillSalePayload,
  TillSaleResult,
  TillVoidedLine,
} from "@/lib/api/sales"

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** Every category, its tiles and what they sell, in one call. */
export async function getTillCatalogue(): Promise<TillCatalogue> {
  if (isDemo()) return demo.demoCatalogue()
  const result = await pb.send<TillCatalogue>("/api/vault/till/catalogue", { method: "GET" })
  noteNetworkSuccess()
  return { categories: [...(result.categories ?? [])].sort((a, b) => a.sort - b.sort) }
}

export interface CategoryItemsPage {
  items: TillCatalogueItem[]
  page: number
  total: number
}

/** One page of a dynamic category's in-stock stock lines. */
export async function getCategoryItems(
  categoryId: string,
  query: { q?: string; page?: number } = {}
): Promise<CategoryItemsPage> {
  if (isDemo()) return demo.demoCategoryItems(categoryId, query)
  const result = await pb.send<Partial<CategoryItemsPage>>(
    `/api/vault/till/category/${encodeURIComponent(categoryId)}/items`,
    {
      method: "GET",
      query: {
        ...(query.q?.trim() ? { q: query.q.trim() } : {}),
        page: query.page ?? 1,
      },
    }
  )
  return {
    items: result.items ?? [],
    page: result.page ?? query.page ?? 1,
    total: result.total ?? 0,
  }
}

interface ProductRow {
  id: string
  name: string
  kind: TillCatalogueProduct["kind"]
  price?: number
  image?: string
  tax_scheme?: TillCatalogueProduct["tax_scheme"]
  collectionId?: string
  collectionName?: string
}

function toProduct(row: ProductRow): TillCatalogueProduct {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    price: row.price ?? 0,
    open_price: row.kind === "open_price",
    image_url: row.image ? pb.files.getURL(row as never, row.image) : "",
    tax_scheme: row.tax_scheme ?? "standard",
  }
}

/** Till products by name, for the search box. */
export async function searchTillProducts(query: string): Promise<TillCatalogueProduct[]> {
  if (isDemo()) return demo.demoSearchProducts(query)
  const needle = query.trim()
  if (!needle) return []
  const page = await pb.collection("till_products").getList<ProductRow>(1, 12, {
    filter: `active = true && name ~ "${quote(needle)}"`,
    sort: "sort,name",
  })
  return page.items.map(toProduct)
}

/** The till product behind a scanned barcode, or null. */
export async function tillProductByBarcode(code: string): Promise<TillCatalogueProduct | null> {
  if (isDemo()) return demo.demoProductByBarcode(code)
  const page = await pb.collection("till_products").getList<ProductRow>(1, 1, {
    filter: `active = true && barcode = "${quote(code)}"`,
  })
  const row = page.items[0]
  return row ? toProduct(row) : null
}

// ---------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------

/**
 * Completes a till sale, through the offline queue (a sale taken with the
 * line down waits, under the same client id, and goes when it is back) and
 * through a manager's approval when the server asks for one.
 */
export async function completeTillSale(
  payload: TillSalePayload,
  describe: (capability: Capability) => string
): Promise<TillSaleResult> {
  const register = payload.register ?? currentRegisterId()
  const body: TillSalePayload = register ? { ...payload, register } : payload
  return withOverride((headers) => completeSaleQueued(body, headers), { describe })
}

/**
 * A sale by its receipt number, in either form the receipt prints:
 * "GG-S-000456" or the barcode's "GGS000456". A number nobody has is the
 * route's 404 with its own sentence, which the caller shows.
 */
export async function lookupSale(number: string): Promise<SaleLookup> {
  if (isDemo()) return demoSales.lookupSale(number).sale
  const result = await pb.send<{ sale: SaleLookup }>("/api/vault/sales/lookup", {
    method: "GET",
    query: { number: number.trim() },
  })
  noteNetworkSuccess()
  return result.sale
}

/** A refund, with a manager's approval when the role does not hold `refund`. */
export async function refundTillSale(
  saleId: string,
  payload: TillRefundPayload,
  amount: number
): Promise<TillRefundResult> {
  const register = payload.register ?? currentRegisterId()
  const body: TillRefundPayload = register ? { ...payload, register } : payload
  return withOverride((headers) => refundSale(saleId, body, headers), {
    describe: () => `Give a refund of ${formatGBP(amount)}`,
    context: { sale: saleId, amount, reason: payload.reason },
  })
}

/**
 * Emails the receipt: to the customer's own address, or to the one typed.
 * With neither, the route answers 400 "There is no email address for this
 * sale. Type one in.", which is how the till knows to ask.
 */
export async function emailReceipt(saleId: string, email?: string): Promise<{ sent_to: string }> {
  if (isDemo()) return demo.demoEmailReceipt(saleId, email)
  return pb.send<{ sent_to: string }>(
    `/api/vault/sales/${encodeURIComponent(saleId)}/receipt/email`,
    { method: "POST", body: email?.trim() ? { email: email.trim() } : {} }
  )
}

/**
 * Lines that were on a ticket and came off it before payment
 * (docs/api-contract-epos.md, section 3, `POST /api/vault/till/void`):
 * `ticket` when the whole ticket was cleared. Counted on the X and the Z.
 */
export async function voidTicketLines(input: {
  register?: string
  ticket: boolean
  lines: TillVoidedLine[]
}): Promise<void> {
  if (input.lines.length === 0) return
  if (isDemo()) {
    demo.demoRecordVoids(input.ticket ? "void_ticket" : "void_line", input.lines)
    return
  }
  const register = input.register ?? currentRegisterId()
  await withOverride(
    (headers) =>
      pb.send("/api/vault/till/void", {
        method: "POST",
        body: { ...(register ? { register } : {}), ticket: input.ticket, lines: input.lines },
        headers,
      }),
    { describe: () => (input.ticket ? "Clear the whole ticket" : "Remove a line from the ticket") }
  )
}

// ---------------------------------------------------------------------------
// Parked tickets (the `parked_tickets` collection: staff create, list, delete)
// ---------------------------------------------------------------------------

export interface ParkedTicket {
  id: string
  register: string
  label: string
  customer: string
  staff: string
  /** The ticket exactly as the till held it. */
  payload: unknown
  total: number
  itemIds: string[]
  created: string
}

interface ParkedRow {
  id: string
  register: string
  label: string
  customer?: string
  staff?: string
  payload?: unknown
  total?: number
  item_ids?: unknown
  created?: string
}

function toParked(row: ParkedRow): ParkedTicket {
  return {
    id: row.id,
    register: row.register,
    label: row.label,
    customer: row.customer ?? "",
    staff: row.staff ?? "",
    payload: row.payload ?? null,
    total: row.total ?? 0,
    itemIds: Array.isArray(row.item_ids)
      ? row.item_ids.filter((id): id is string => typeof id === "string")
      : [],
    created: row.created ?? "",
  }
}

/** The register's parked tickets, newest first. */
export async function listParkedTickets(register: string): Promise<ParkedTicket[]> {
  if (isDemo()) return demo.demoListParked(register).map(toParked)
  const rows = await pb.collection("parked_tickets").getFullList<ParkedRow>({
    filter: `register = "${quote(register)}"`,
    sort: "-created",
  })
  return rows.map(toParked)
}

export interface ParkTicketInput {
  register: string
  label: string
  customer: string | null
  payload: unknown
  total: number
  itemIds: string[]
}

export async function parkTicket(input: ParkTicketInput): Promise<ParkedTicket> {
  const body = {
    register: input.register,
    label: input.label.trim().slice(0, 60),
    customer: input.customer ?? "",
    payload: input.payload,
    total: input.total,
    item_ids: input.itemIds,
  }
  if (isDemo()) return toParked(demo.demoPark(body))
  const staff = pb.authStore.record?.id
  const row = await pb
    .collection("parked_tickets")
    .create<ParkedRow>({ ...body, ...(staff ? { staff } : {}) })
  return toParked(row)
}

/** Taken off the list when it is recalled, so the other till cannot take it too. */
export async function deleteParkedTicket(id: string): Promise<void> {
  if (isDemo()) {
    demo.demoDeleteParked(id)
    return
  }
  await pb.collection("parked_tickets").delete(id)
}
