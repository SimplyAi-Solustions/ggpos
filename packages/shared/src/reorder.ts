/**
 * The supplier reorder report (docs/api-contract-reorder.md): for the weekly
 * call with a supplier's rep, what of theirs is in stock, what sold, what is
 * out, what to order to fill the shelf back up, and what customers have asked
 * for.
 *
 * Pure and shared: the route (`GET /api/vault/reorder`) reads the supplier's
 * stock rows, the units sold in the range and the open requests, and the
 * demo builds its own; both add them up here so the two always agree.
 *
 * - A **product** is every stock row of the supplier's that is the same
 *   thing: the same supplier code, else the same barcode, else the same
 *   title. Restocking adds a new row (there is no goods-in yet), so a product
 *   that sold out last month and came back this week is two rows and one
 *   line here.
 * - **In stock** is the units on hand across those rows: a row's `qty` while
 *   it is in stock, reserved or listed, nothing once it is sold, returned or
 *   written off.
 * - **Shelf target** is how many to keep on the shelf; 0 means the product
 *   is not kept to a target. Rows of one product that disagree take the
 *   largest.
 * - **To order** tops the shelf back up: target less in stock, never below
 *   0, and 0 for a product with no target.
 * - **Sold** is units kept (sold less refunded) in the range.
 */

/** Where a product stands. */
export type ReorderStatus = "out" | "low" | "ok" | "untracked"

export const REORDER_STATUS_LABELS: Record<ReorderStatus, string> = {
  out: "Out of stock",
  low: "Below target",
  ok: "Stocked",
  untracked: "No target",
}

/** A customer's request for something the shop does not have. */
export const REQUEST_STATUSES = ["waiting", "asked", "ordered", "arrived", "collected", "cancelled"] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  waiting: "Waiting",
  asked: "Asked the rep",
  ordered: "Ordered",
  arrived: "Arrived",
  collected: "Collected",
  cancelled: "Cancelled",
}

/** Still needs something doing: everything before Collected, and not Cancelled. */
export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = ["waiting", "asked", "ordered", "arrived"]

export function isOpenRequest(status: RequestStatus): boolean {
  return OPEN_REQUEST_STATUSES.includes(status)
}

/** One stock row of the supplier's, as the route reads it. Money in pence. */
export interface ReorderItem {
  id: string
  sku: string
  title: string
  ean: string
  supplierCode: string
  categoryPath: string
  /** `qty` while the row is in stock, reserved or listed; 0 otherwise. */
  onHand: number
  /** Keep this many on the shelf; 0 or null when there is no target. */
  shelfTarget: number | null
  price: number
  /** ISO time the row last changed; the newest row names the product. */
  updated: string
}

/** Units kept (sold less refunded) of one stock row in the range. */
export interface ReorderSold {
  itemId: string
  qty: number
}

/** One product on the report. */
export interface ReorderLine {
  /** Stable for the product: "code:...", "ean:..." or "title:...". */
  key: string
  title: string
  supplierCode: string
  ean: string
  categoryPath: string
  inStock: number
  shelfTarget: number
  sold: number
  toOrder: number
  status: ReorderStatus
  /** The current shelf price, in pence. */
  price: number
  /** Every stock row of this product, so a new target can be set on all. */
  itemIds: string[]
  /** The row to open: the newest with stock on hand, else the newest. */
  sku: string
}

export interface ReorderTotals {
  /** Products on the report. */
  products: number
  /** Products kept to a shelf target. */
  onTarget: number
  /** Units on hand across every product. */
  inStock: number
  /** Units sold in the range. */
  sold: number
  /** Products with none on hand. */
  outOfStock: number
  /** Products with some on hand but fewer than their target. */
  belowTarget: number
  /** Units to order. */
  toOrder: number
  /** Requests still open. */
  openRequests: number
}

/** The supplier, as the report names it and the call needs it. */
export interface ReorderSupplier {
  id: string
  name: string
  accountNumber: string
  repName: string
  repEmail: string
  repPhone: string
}

/** One customer request, as the report and the requests list show it. */
export interface StockRequestView {
  id: string
  supplierId: string
  title: string
  qty: number
  /** The Guild member who asked, when they are one. */
  customerId: string
  customerName: string
  customerCode: string
  /** Who asked when they are not a member, or a better number for them. */
  contactName: string
  contactPhone: string
  notes: string
  status: RequestStatus
  created: string
  statusChangedAt: string
  createdByName: string
}

/** What `GET /api/vault/reorder` answers. */
export interface ReorderReport {
  supplier: ReorderSupplier
  /** YYYY-MM-DD, both days counted. */
  from: string
  to: string
  lines: ReorderLine[]
  totals: ReorderTotals
  /** Open requests for this supplier, oldest first: the order they were asked. */
  requests: StockRequestView[]
}

const STATUS_RANK: Record<ReorderStatus, number> = { out: 0, low: 1, ok: 2, untracked: 3 }

/** The same product across restocks: supplier code, else barcode, else title. */
export function productKey(item: Pick<ReorderItem, "supplierCode" | "ean" | "title">): string {
  const code = item.supplierCode.trim().toLowerCase()
  if (code) return `code:${code}`
  const ean = item.ean.trim()
  if (ean) return `ean:${ean}`
  return `title:${item.title.trim().toLowerCase().replace(/\s+/g, " ")}`
}

/** A product's status from what is on hand and its target. */
export function reorderStatus(inStock: number, shelfTarget: number): ReorderStatus {
  if (inStock <= 0) return "out"
  if (shelfTarget <= 0) return "untracked"
  return inStock < shelfTarget ? "low" : "ok"
}

/** How many to order to bring the shelf back to its target. */
export function unitsToOrder(inStock: number, shelfTarget: number): number {
  return shelfTarget > 0 ? Math.max(0, shelfTarget - Math.max(0, inStock)) : 0
}

const whole = (n: number | null | undefined) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0)

/**
 * The report's lines, one per product: what to order first (most units),
 * then out of stock, below target, stocked and untargeted, then by title.
 */
export function buildReorderLines(items: ReorderItem[], sold: ReorderSold[]): ReorderLine[] {
  const soldBy = new Map<string, number>()
  for (const s of sold) soldBy.set(s.itemId, (soldBy.get(s.itemId) ?? 0) + whole(s.qty))

  const groups = new Map<string, ReorderItem[]>()
  for (const item of items) {
    const key = productKey(item)
    const rows = groups.get(key)
    if (rows) rows.push(item)
    else groups.set(key, [item])
  }

  const lines: ReorderLine[] = []
  for (const [key, rows] of groups) {
    const newestFirst = [...rows].sort((a, b) => b.updated.localeCompare(a.updated))
    const named = newestFirst[0]
    if (!named) continue
    const open = newestFirst.find((row) => whole(row.onHand) > 0) ?? named
    const inStock = rows.reduce((sum, row) => sum + whole(row.onHand), 0)
    const shelfTarget = rows.reduce((max, row) => Math.max(max, whole(row.shelfTarget)), 0)
    const units = rows.reduce((sum, row) => sum + (soldBy.get(row.id) ?? 0), 0)
    lines.push({
      key,
      title: named.title,
      supplierCode: newestFirst.find((row) => row.supplierCode.trim())?.supplierCode.trim() ?? "",
      ean: newestFirst.find((row) => row.ean.trim())?.ean.trim() ?? "",
      categoryPath: named.categoryPath,
      inStock,
      shelfTarget,
      sold: units,
      toOrder: unitsToOrder(inStock, shelfTarget),
      status: reorderStatus(inStock, shelfTarget),
      price: open.price,
      itemIds: rows.map((row) => row.id),
      sku: open.sku,
    })
  }

  return lines.sort(
    (a, b) =>
      b.toOrder - a.toOrder ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.title.localeCompare(b.title, "en-GB", { sensitivity: "base" })
  )
}

/** The figures across the top of the report. */
export function reorderTotals(lines: ReorderLine[], requests: Pick<StockRequestView, "status">[]): ReorderTotals {
  return {
    products: lines.length,
    onTarget: lines.filter((line) => line.shelfTarget > 0).length,
    inStock: lines.reduce((sum, line) => sum + line.inStock, 0),
    sold: lines.reduce((sum, line) => sum + line.sold, 0),
    outOfStock: lines.filter((line) => line.status === "out").length,
    belowTarget: lines.filter((line) => line.status === "low").length,
    toOrder: lines.reduce((sum, line) => sum + line.toOrder, 0),
    openRequests: requests.filter((request) => isOpenRequest(request.status)).length,
  }
}

/** The last seven days ending on `today` (YYYY-MM-DD), both ends counted. */
export function defaultReorderPeriod(today: string): { from: string; to: string } {
  const end = new Date(`${today}T00:00:00Z`)
  const start = new Date(end.getTime() - 6 * 86_400_000)
  return { from: start.toISOString().slice(0, 10), to: today }
}
