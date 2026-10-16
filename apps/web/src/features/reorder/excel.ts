/**
 * The supplier call as an Excel file (docs/api-contract-reorder.md, section
 * 4.2): a cover, then To order, Rack and Requests, through the reports'
 * own Excel helper so money, dates and counts are typed cells exactly as in
 * every other file the counter makes.
 */
import {
  REORDER_STATUS_LABELS,
  REQUEST_STATUS_LABELS,
  type ReorderLine,
  type ReorderReport,
  type StockRequestView,
} from "@gg/shared"

import { sheet, xlsxFilename, type ExcelBook } from "@/features/reports/excel"
import { requestWho } from "@/features/reorder/rack"

/** "games-workshop", for the file name. */
export function supplierSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "supplier"
  )
}

/** `gg-vault-reorder-games-workshop-2026-10-09-2026-10-15.xlsx`. */
export function reorderFilename(report: Pick<ReorderReport, "supplier" | "from" | "to">): string {
  return xlsxFilename(`reorder-${supplierSlug(report.supplier.name)}`, report.from, report.to)
}

export function reorderBook(report: ReorderReport, made: Date = new Date()): ExcelBook {
  const toOrder = report.lines.filter((line) => line.toOrder > 0)
  return {
    title: `${report.supplier.name} call`,
    range: { from: report.from, to: report.to },
    made,
    sheets: [
      sheet<ReorderLine>(
        "To order",
        [
          { label: "Code", kind: "text", value: (line) => line.supplierCode },
          { label: "Product", kind: "text", value: (line) => line.title },
          { label: "To order", kind: "count", value: (line) => line.toOrder },
          { label: "In stock", kind: "count", value: (line) => line.inStock },
          { label: "Keep on shelf", kind: "count", value: (line) => line.shelfTarget },
          { label: "Barcode", kind: "text", value: (line) => line.ean },
        ],
        toOrder
      ),
      sheet<ReorderLine>(
        "Rack",
        [
          { label: "Product", kind: "text", value: (line) => line.title },
          { label: "Code", kind: "text", value: (line) => line.supplierCode },
          { label: "Barcode", kind: "text", value: (line) => line.ean },
          { label: "Branch", kind: "text", value: (line) => line.categoryPath },
          { label: "In stock", kind: "count", value: (line) => line.inStock },
          {
            label: "Keep on shelf",
            kind: "count",
            value: (line) => (line.shelfTarget > 0 ? line.shelfTarget : null),
          },
          { label: "Sold", kind: "count", value: (line) => line.sold },
          { label: "To order", kind: "count", value: (line) => line.toOrder },
          { label: "Status", kind: "text", value: (line) => REORDER_STATUS_LABELS[line.status] },
          { label: "Price", kind: "money", value: (line) => line.price },
        ],
        report.lines
      ),
      sheet<StockRequestView>(
        "Requests",
        [
          { label: "Asked", kind: "datetime", value: (request) => request.created },
          { label: "What", kind: "text", value: (request) => request.title },
          { label: "Quantity", kind: "count", value: (request) => request.qty },
          { label: "Who", kind: "text", value: (request) => requestWho(request).name },
          { label: "Guild code", kind: "text", value: (request) => request.customerCode },
          { label: "Phone", kind: "text", value: (request) => request.contactPhone },
          { label: "Status", kind: "text", value: (request) => REQUEST_STATUS_LABELS[request.status] },
          { label: "Notes", kind: "text", value: (request) => request.notes },
          { label: "Logged by", kind: "text", value: (request) => request.createdByName },
        ],
        report.requests
      ),
    ],
    notes: [
      "To order tops each product back up to its Keep on shelf target: the target less what is in stock, never below 0.",
      "Sold is units kept, sold less refunded, between the two dates.",
    ],
  }
}
