/**
 * The demo shop's CSV imports.
 *
 * The file that is actually chosen is read and classified here, through the
 * same parser and the same rules the screen previews with, so a demo import
 * of a real Card Uploader export produces a real review queue rather than a
 * canned one. Nothing is persisted: it lives in memory for the tab, like
 * every other demo store.
 */
import { parseDecimalToMinor } from "@gg/shared"

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
  LinkReviewResult,
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
    status: "done",
    file: filename,
    rows_total: total,
    rows_ok: ok,
    rows_skipped: 0,
    resolved_rows: [],
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
        condition: row.condition ?? "",
        quantity: Number(row.quantity ?? "1") || 1,
        ebay_sku: row.csSku ?? "",
        // Integer pence through the shared parser, or null when the cell
        // was not an amount - exactly what the route stores.
        price: parseDecimalToMinor(row.price ?? ""),
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

/**
 * The link route's own behaviour, as far as a demo can mirror it.
 *
 * Same refusals in the same order, and the same three-path outcome: the demo
 * shop holds nothing behind a Card Uploader listing, so a link always lands
 * on "created" and leaves the zero-cost note the real importer leaves. The
 * route owns the item write; nothing here invents one.
 */
function resolve(
  id: string,
  row: number,
  card: string | null
): LinkReviewResult {
  const record = getImport(id)
  const resolved = record.resolved_rows ?? []
  if (resolved.includes(row)) {
    throw new Error("This row has already been linked or skipped.")
  }
  const entry = (record.errors ?? []).find(
    (candidate) =>
      candidate.kind === "review" &&
      candidate.message === "needs match" &&
      candidate.row === row
  )
  if (!entry) throw new Error("That row is not waiting for a match.")
  if (card !== null && (entry.price === null || entry.price === undefined)) {
    throw new Error(
      "This row's price could not be read as an amount. Re-import the file with a valid price."
    )
  }

  record.errors = (record.errors ?? []).filter((candidate) => candidate !== entry)
  record.resolved_rows = [...resolved, row]

  if (card === null) {
    record.rows_skipped = (record.rows_skipped ?? 0) + 1
    return { import: { ...record }, item: null, path: "skipped" }
  }

  // The demo has nothing in stock behind these listings, so the rule lands
  // on its third path and leaves the same note the importer would.
  record.errors.push({
    row,
    kind: "review",
    message: "Listed card was not in stock. Created with no cost - check it.",
    card,
    sku: entry.ebay_sku ?? "",
  })
  return {
    import: { ...record },
    item: {
      id: `item_demo_link_${row}`,
      sku: `GGS${row}LINK`,
      kind: "single",
      game: "game_pokemon",
      card,
      title: entry.name ?? "",
      qty: entry.quantity ?? 1,
      price: entry.price ?? 0,
      status: "listed_ebay",
      ebay_sku: entry.ebay_sku ?? "",
      source: "supplier",
      tax_scheme: "margin",
    },
    path: "created",
  }
}

export function linkReviewRow(input: LinkReviewInput): LinkReviewResult {
  return resolve(input.importId, input.row, input.cardId)
}

export function skipReviewRow(id: string, row: number): LinkReviewResult {
  return resolve(id, row, null)
}
