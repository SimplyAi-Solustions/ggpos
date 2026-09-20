/**
 * The demo shop's export files.
 *
 * Each one is built here from the same in-memory stores the rest of the demo
 * runs on, with the column names docs/csv-formats.md gives, so the Exports
 * screen downloads a real file with no server behind it. Every cell goes
 * through the same formula-injection guard the server uses.
 */
import { displayCode } from "@gg/shared"

import { buildCsv, poundsCell, type CsvColumn } from "@/features/reports/csv"
import { demoItemStore } from "@/lib/api/index"
import { demoSales, ensureSeeded } from "@/lib/api/demo/store"
import type { EndListingRow, ExportKey, StockItemRecord } from "@/lib/api/types"

/** Items the demo pretends were listed through Card Uploader. */
const ENDED = new Set<string>()

function items(): StockItemRecord[] {
  ensureSeeded()
  return demoItemStore
}

function column<Row>(label: string, value: (row: Row) => string | number): CsvColumn<Row> {
  return { label, value }
}

function sumupFile(): string {
  const rows = items().filter(
    (item) =>
      item.status === "in_stock" &&
      ["retro", "sealed", "accessory", "other"].includes(item.kind)
  )
  return buildCsv<StockItemRecord>(
    [
      column("Item name", (item) => `${displayCode(item.sku)} ${item.title ?? ""}`.trim()),
      column("Description", (item) => [item.set_code, item.condition].filter(Boolean).join(" ")),
      column("Category", (item) => item.kind),
      column("Price", (item) => poundsCell(item.price ?? 0)),
      column("SKU", (item) => item.sku),
      column("Barcode", (item) => item.ean || item.sku),
      column("Quantity", (item) => item.qty ?? 0),
      column("Tax rate (%)", () => 0),
      column("Variations", () => ""),
      column("Option set 1", () => ""),
      column("Option set 2", () => ""),
      column("Option set 3", () => ""),
      column("Option set 4", () => ""),
      column("Modifiers", () => ""),
      column("Display colour", () => ""),
    ],
    rows
  )
}

function inventoryFile(): string {
  return buildCsv<StockItemRecord>(
    [
      column("SKU", (item) => item.sku),
      column("Kind", (item) => item.kind),
      column("Game", (item) => item.game),
      column("Title", (item) => item.title ?? ""),
      column("Set code", (item) => item.set_code ?? ""),
      column("Number", (item) => item.number ?? ""),
      column("Finish", (item) => item.finish ?? ""),
      column("Condition", (item) => item.condition ?? ""),
      column("EAN", (item) => item.ean ?? ""),
      column("Quantity", (item) => item.qty ?? 0),
      column("Cost", (item) => poundsCell(item.cost ?? 0)),
      column("Market value at intake", (item) => poundsCell(item.market_at_intake ?? 0)),
      column("Sell price", (item) => poundsCell(item.price ?? 0)),
      column("Tax scheme", (item) => item.tax_scheme ?? ""),
      column("Status", (item) => item.status ?? ""),
      column("Source", (item) => item.source ?? ""),
      column("Acquired date", (item) => (item.acquired_at ?? item.created ?? "").slice(0, 10)),
    ],
    items()
  )
}

interface SaleLineRow {
  number: string
  created: string
  customer: string
  sku: string
  title: string
  qty: number
  unit: number
  discount: number
  payment: string
  total: number
  status: string
}

function salesFile(): string {
  ensureSeeded()
  const rows: SaleLineRow[] = []
  for (const sale of demoSales) {
    for (const line of sale.lines) {
      rows.push({
        number: sale.number,
        created: (sale.created ?? "").slice(0, 10),
        customer: sale.customerName ?? "",
        sku: line.sku,
        title: line.title,
        qty: line.qty ?? 1,
        unit: line.unit_price ?? 0,
        discount: line.discount ?? 0,
        payment: sale.payment ?? "",
        total: sale.total ?? 0,
        status: line.status ?? "sold",
      })
    }
  }
  return buildCsv<SaleLineRow>(
    [
      column("Sale number", (row) => row.number),
      column("Date", (row) => row.created),
      column("Customer", (row) => row.customer),
      column("SKU", (row) => row.sku),
      column("Item title", (row) => row.title),
      column("Quantity", (row) => row.qty),
      column("Unit price", (row) => poundsCell(row.unit)),
      column("Discount", (row) => poundsCell(row.discount)),
      column("Payment method", (row) => row.payment),
      column("Sale total", (row) => poundsCell(row.total)),
      column("Line status", (row) => row.status),
    ],
    rows
  )
}

function ebayListingFile(): string {
  const rows = items().filter((item) => item.status === "in_stock")
  return buildCsv<StockItemRecord>(
    [
      column("Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193)", () => "Add"),
      column("Custom label (SKU)", (item) => item.ebay_sku || item.sku),
      column("Title", (item) => (item.title ?? "").slice(0, 80)),
      column("Description", (item) => [item.set_code, item.condition].filter(Boolean).join(" ")),
      column("Category", () => ""),
      column("ConditionID", () => ""),
      column("Format", () => "FixedPrice"),
      column("Duration", () => "GTC"),
      column("StartPrice", (item) => poundsCell(item.price ?? 0)),
      column("Quantity", (item) => item.qty ?? 0),
      column("ImageURL", () => ""),
      column("Location", () => "Bolsover"),
      column("PostalCode", () => "S44 6PN"),
    ],
    rows
  )
}

function registerFile(): string {
  return buildCsv<{ number: string; name: string }>(
    [
      column("Trade-in number", (row) => row.number),
      column("Seller name", (row) => row.name),
      column("Payout type", () => "mixed"),
      column("Cash amount", () => poundsCell(6500)),
      column("Credit amount", () => poundsCell(2000)),
    ],
    [{ number: "GG-BI-000122", name: "Brock Harrison" }]
  )
}

const FILES: Record<ExportKey, () => string> = {
  sumup: sumupFile,
  "ebay-listings": ebayListingFile,
  inventory: inventoryFile,
  sales: salesFile,
  "buy-in-register": registerFile,
  "stock-book": registerFile,
  audit: () =>
    buildCsv<{ created: string; action: string }>(
      [
        column("created", (row) => row.created),
        column("actor", () => "Demo Counter"),
        column("action", (row) => row.action),
        column("collection", () => "items"),
      ],
      [{ created: new Date().toISOString(), action: "item_create" }]
    ),
  "end-listings": () =>
    buildCsv<EndListingRow>(
      [
        column("SKU", (row) => row.sku),
        column("Title", (row) => row.title),
        column("eBay listing ID", (row) => row.ebay_listing_id ?? ""),
        column("eBay SKU", (row) => row.ebay_sku ?? ""),
      ],
      endListings()
    ),
}

export function exportFile(key: ExportKey): Blob {
  const text = FILES[key]?.() ?? ""
  return new Blob([`\ufeff${text}`], { type: "text/csv;charset=utf-8" })
}

/** How many stock lines SumUp has never seen, in the demo shop. */
export function unsyncedCount(): number {
  return items().filter(
    (item) =>
      item.status === "in_stock" &&
      ["retro", "sealed", "accessory", "other"].includes(item.kind)
  ).length
}

/** The ids the eBay listing file would be built from. */
export function inStockIds(limit: number): string[] {
  return items()
    .filter((item) => item.status === "in_stock")
    .slice(0, limit)
    .map((item) => item.id)
}

/** Sold in the shop, still listed on eBay. */
export function endListings(): EndListingRow[] {
  ensureSeeded()
  return [
    {
      item_id: "item_demo_ebay_1",
      sku: "GGS3R7K2V",
      title: "Pikachu VMAX 044/185",
      ebay_sku: "CS-441820",
      ebay_listing_id: "",
      sold_at: new Date().toISOString(),
    },
    {
      item_id: "item_demo_ebay_2",
      sku: "GGS8W2M4P",
      title: "Rayquaza VMAX 218/203",
      ebay_sku: "CS-441904",
      ebay_listing_id: "",
      sold_at: new Date().toISOString(),
    },
  ].filter((row) => !ENDED.has(row.item_id))
}

export function markEnded(ids: string[]): string[] {
  const ended: string[] = []
  for (const id of ids) {
    if (!ENDED.has(id)) {
      ENDED.add(id)
      ended.push(id)
    }
  }
  return ended
}
