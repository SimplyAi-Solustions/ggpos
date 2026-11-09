/**
 * Column mapping for the CSV import. The server's Card Uploader importer
 * (pb_hooks/imports.pb.js) reads headers from settings.import_mappings, the
 * docs/csv-formats.md skeleton. Any file can go through it: staff map their
 * columns to its fields here, and the file is rewritten with each field's
 * first accepted header before it is sent, so the server reads exactly what
 * the preview showed.
 */
import { CARD_UPLOADER_MAPPING, classifyCardUploaderRow, parseCsv, resolveColumns, type RowVerdict } from "./csv-parse"

export const IMPORT_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "name", label: "Card name", hint: "Needed unless an id is mapped" },
  { key: "set", label: "Set", hint: "" },
  { key: "number", label: "Number", hint: "" },
  { key: "condition", label: "Condition", hint: "NM, LP, MP, HP or DMG" },
  { key: "price", label: "Price", hint: "Pounds, like 12.50" },
  { key: "quantity", label: "Quantity", hint: "" },
  { key: "tcgplayerId", label: "TCGplayer ID", hint: "Matches the card exactly" },
  { key: "cardmarketId", label: "Cardmarket ID", hint: "Matches the card exactly" },
  { key: "csSku", label: "Card Uploader SKU", hint: "CS-XXXXXX, kept as the eBay SKU" },
]

/** Field key to column index, -1 for not mapped. */
export type ColumnMap = Record<string, number>

export function autoMap(header: readonly string[]): ColumnMap {
  return resolveColumns([...header], CARD_UPLOADER_MAPPING)
}

export interface ParsedImport {
  header: string[]
  body: string[][]
}

export function readTable(text: string): ParsedImport {
  const table = parseCsv(text)
  const header = table[0] ?? []
  const body = table.slice(1).filter((cells) => cells.some((c) => c.trim() !== ""))
  return { header, body }
}

export function mappedRow(cells: readonly string[], map: ColumnMap): Record<string, string> {
  const row: Record<string, string> = {}
  for (const field of IMPORT_FIELDS) {
    const at = map[field.key] ?? -1
    if (at >= 0) row[field.key] = (cells[at] ?? "").trim()
  }
  return row
}

export interface ImportPreview {
  rows: { row: Record<string, string>; verdict: RowVerdict }[]
  matched: number
  review: number
  errors: number
}

export function previewImport(parsed: ParsedImport, map: ColumnMap): ImportPreview {
  const rows = parsed.body.map((cells) => {
    const row = mappedRow(cells, map)
    return { row, verdict: classifyCardUploaderRow(row) }
  })
  return {
    rows,
    matched: rows.filter((r) => r.verdict.kind === "matched").length,
    review: rows.filter((r) => r.verdict.kind === "review").length,
    errors: rows.filter((r) => r.verdict.kind === "error").length,
  }
}

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The file rewritten with the importer's own header names, mapped columns only. */
export function canonicalCsv(parsed: ParsedImport, map: ColumnMap): string {
  const fields = IMPORT_FIELDS.filter((f) => (map[f.key] ?? -1) >= 0)
  const header = fields.map((f) => CARD_UPLOADER_MAPPING.columns[f.key]?.[0] ?? f.key)
  const lines = [header.map(cell).join(",")]
  for (const cells of parsed.body) {
    lines.push(fields.map((f) => cell((cells[map[f.key] ?? -1] ?? "").trim())).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}

export function canImport(map: ColumnMap): string | null {
  const has = (key: string) => (map[key] ?? -1) >= 0
  if (!has("name") && !has("tcgplayerId") && !has("cardmarketId")) return "Map a card name or an id column first."
  return null
}
