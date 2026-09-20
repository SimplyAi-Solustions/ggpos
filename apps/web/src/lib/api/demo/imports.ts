/**
 * The demo shop's CSV imports.
 *
 * The file that is actually chosen is read and classified here, through the
 * same parser and the same rules the screen previews with, so a demo import
 * of a real Card Uploader export produces a real review queue rather than a
 * canned one. Nothing is persisted: it lives in memory for the tab, like
 * every other demo store.
 */
import {
  CARD_UPLOADER_MAPPING,
  EBAY_ORDERS_MAPPING,
  classifyCardUploaderRow,
  classifyEbayOrderRow,
  mapRows,
} from "@/lib/api/csv-parse"
import type {
  CardUploaderResult,
  CsvImportError,
  CsvImportRecord,
  EbayOrdersResult,
} from "@/lib/api/types"
import type { LinkReviewInput } from "@/lib/api/imports"

const imports: CsvImportRecord[] = []
let sequence = 0

function record(
  type: string,
  filename: string,
  total: number,
  ok: number,
  errors: CsvImportError[]
): CsvImportRecord {
  sequence += 1
  const row: CsvImportRecord = {
    id: `csv_import_demo_${sequence}`,
    type,
    filename,
    rows_total: total,
    rows_ok: ok,
    // The server caps its stored errors at 200 and adds one note saying how
    // many it left out; the demo does the same so the screen is exercised.
    errors: errors.slice(0, 200),
    staff: "staff_demo",
    created: new Date().toISOString(),
  }
  if (errors.length > 200) {
    row.errors = [
      ...errors.slice(0, 200),
      { kind: "truncated", message: `${errors.length - 200} more not recorded` },
    ]
  }
  imports.unshift(row)
  return row
}

export async function importCardUploader(file: File): Promise<CardUploaderResult> {
  const mapped = mapRows(await file.text(), CARD_UPLOADER_MAPPING)
  const errors: CsvImportError[] = []
  let matched = 0
  let review = 0

  mapped.rows.forEach((row, index) => {
    const line = mapped.lines[index] ?? index + 2
    const verdict = classifyCardUploaderRow(row)
    if (verdict.kind === "matched") {
      matched += 1
      return
    }
    if (verdict.kind === "review") {
      review += 1
      errors.push({
        row: line,
        kind: "review",
        message: "needs match",
        name: row.name ?? "",
        set: row.set ?? "",
        number: row.number ?? "",
        ebay_sku: row.csSku ?? "",
        price: Math.round(Number(String(row.price ?? "0").replace(/[^\d.-]/g, "")) * 100),
      })
      return
    }
    errors.push({ row: line, kind: "error", message: verdict.message })
  })

  return {
    import: record(
      "card_uploader",
      file.name,
      mapped.rows.length,
      matched + review,
      errors
    ),
    matched,
    review,
  }
}

export async function importEbayOrders(file: File): Promise<EbayOrdersResult> {
  const mapped = mapRows(await file.text(), EBAY_ORDERS_MAPPING)
  const errors: CsvImportError[] = []
  const seen = new Set<string>()
  let sold = 0
  let alreadySold = 0

  mapped.rows.forEach((row, index) => {
    const line = mapped.lines[index] ?? index + 2
    const verdict = classifyEbayOrderRow(row)
    if (verdict.kind !== "matched") {
      errors.push({ row: line, kind: "error", message: verdict.message })
      return
    }
    const label = row.customLabel ?? ""
    // The same line of the same order twice is a row that changed nothing.
    const fingerprint = `${row.orderNumber ?? ""}:${label}`
    if (seen.has(fingerprint)) {
      alreadySold += 1
      errors.push({
        row: line,
        kind: "already_sold",
        message: "already sold",
        custom_label: label,
      })
      return
    }
    seen.add(fingerprint)
    sold += 1
  })

  return {
    import: record("ebay_orders", file.name, mapped.rows.length, sold, errors),
    sold,
    already_sold: alreadySold,
  }
}

export function getImport(id: string): CsvImportRecord {
  const found = imports.find((row) => row.id === id)
  if (!found) throw new Error("That import is not on file.")
  return found
}

export function listImports(limit: number): CsvImportRecord[] {
  return imports.slice(0, limit)
}

function drop(id: string, row: number): CsvImportRecord {
  const found = getImport(id)
  found.errors = (found.errors ?? []).filter(
    (entry) => !(entry.kind === "review" && entry.row === row)
  )
  return found
}

export function linkReviewRow(input: LinkReviewInput): CsvImportRecord {
  return drop(input.importId, input.row)
}

export function skipReviewRow(id: string, row: number): CsvImportRecord {
  return drop(id, row)
}
