/**
 * Reading a CSV in the browser: the preview the Imports screen shows before
 * anything is sent, and the row classifier behind it.
 *
 * The server reads the same files through `pb_hooks/lib/csv.js` against the
 * mapping in `settings.import_mappings`, so this is deliberately the same
 * shape: `{ headerRow, columns: { field: [header, header, ...] } }`, the
 * first alias present in the header row winning per field
 * (docs/csv-formats.md). The screen only previews and classifies; the import
 * itself is always the server's, so the two can never disagree about what
 * was actually written.
 */

export interface MappingConfig {
  /** 1-based, as the mapping config writes it. */
  headerRow?: number
  columns: Record<string, string[]>
}

/** The seeded default, from docs/csv-formats.md, "Card Uploader import". */
export const CARD_UPLOADER_MAPPING: MappingConfig = {
  headerRow: 1,
  columns: {
    name: ["Card Name", "Name", "Title"],
    set: ["Set", "Set Name"],
    number: ["Number", "Card Number", "#"],
    condition: ["Condition"],
    price: ["Price", "Sale Price"],
    quantity: ["Quantity", "Qty"],
    tcgplayerId: ["TCGplayer ID", "TCGplayer Product ID"],
    cardmarketId: ["Cardmarket ID", "Cardmarket Product ID"],
    csSku: ["CS SKU", "Custom Label"],
  },
}

/** The seeded default, from docs/csv-formats.md, "eBay orders import". */
export const EBAY_ORDERS_MAPPING: MappingConfig = {
  headerRow: 1,
  columns: {
    customLabel: ["Custom Label", "Custom Label (SKU)"],
    itemNumber: ["Item Number"],
    orderNumber: ["Order Number", "Sales Record Number"],
    saleDate: ["Sale Date"],
    salePrice: ["Sold For", "Sale Price"],
    quantity: ["Quantity"],
    currency: ["Sale Currency", "Currency"],
  },
}

/**
 * RFC 4180, as far as a real export ever goes: quoted fields, `""` for an
 * embedded quote, commas and newlines inside quotes, CRLF, bare LF or bare
 * CR line endings, and a leading byte order mark dropped.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false

  for (let at = 0; at < clean.length; at += 1) {
    const char = clean[at]
    if (quoted) {
      if (char === '"') {
        if (clean[at + 1] === '"') {
          cell += '"'
          at += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ",") {
      row.push(cell)
      cell = ""
      continue
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && clean[at + 1] === "\n") at += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
      continue
    }
    cell += char
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  // A trailing newline leaves one empty row behind; nothing else should go.
  return rows.filter((entry) => entry.some((value) => value.trim() !== ""))
}

/** Which column each mapped field sits in, or -1 when the file has none. */
export function resolveColumns(
  header: string[],
  mapping: MappingConfig
): Record<string, number> {
  const normalised = header.map((name) => name.trim().toLowerCase())
  const found: Record<string, number> = {}
  for (const [field, aliases] of Object.entries(mapping.columns)) {
    found[field] = -1
    for (const alias of aliases) {
      const at = normalised.indexOf(alias.trim().toLowerCase())
      if (at >= 0) {
        found[field] = at
        break
      }
    }
  }
  return found
}

export interface MappedFile {
  /** The header row exactly as the file wrote it. */
  header: string[]
  /** The fields the mapping resolved, in mapping order. */
  fields: string[]
  /** One record per row, keyed by mapped field name. */
  rows: Record<string, string>[]
  /** The 1-based line each row came from, for matching an error entry back. */
  lines: number[]
}

/** Read a whole file into mapped rows. An unmapped column is simply dropped. */
export function mapRows(text: string, mapping: MappingConfig): MappedFile {
  const table = parseCsv(text)
  const headerAt = Math.max(1, mapping.headerRow ?? 1) - 1
  const header = table[headerAt] ?? []
  const columns = resolveColumns(header, mapping)
  const fields = Object.keys(mapping.columns).filter((field) => columns[field] !== -1)

  const rows: Record<string, string>[] = []
  const lines: number[] = []
  for (let at = headerAt + 1; at < table.length; at += 1) {
    const cells = table[at] ?? []
    const row: Record<string, string> = {}
    for (const field of fields) {
      row[field] = (cells[columns[field] ?? -1] ?? "").trim()
    }
    rows.push(row)
    lines.push(at + 1)
  }
  return { header, fields, rows, lines }
}

/** The refusal both importers make when nothing in the header is recognised. */
export const UNRECOGNISED_FILE =
  "That file is not a CSV we recognise. Check the first line has the column headings."

export type RowKind = "matched" | "review" | "error"

export interface RowVerdict {
  kind: RowKind
  message: string
}

/** Does a cell read as an amount of money at all? */
function readsAsPrice(raw: string): boolean {
  if (!raw) return false
  return /^-?[£$€]?\s*\d+(\.\d{1,2})?$/.test(raw.replace(/,/g, "").trim())
}

/**
 * What the Card Uploader importer will make of one row.
 *
 * The same order the route itself works in: a row with neither an id nor a
 * name, or with a price that is not an amount, is a hard failure; a row
 * carrying a TCGplayer or Cardmarket id matches a card directly; a row with
 * only a name goes to the review queue rather than being guessed at.
 */
export function classifyCardUploaderRow(row: Record<string, string>): RowVerdict {
  const hasId = Boolean(row.tcgplayerId?.trim() || row.cardmarketId?.trim())
  const name = row.name?.trim() ?? ""
  if (!hasId && !name) {
    return { kind: "error", message: "No card name and no id on this row." }
  }
  if (!readsAsPrice(row.price ?? "")) {
    return { kind: "error", message: "The price on this row is not an amount." }
  }
  if (hasId) return { kind: "matched", message: "Matches a card by id." }
  return { kind: "review", message: "needs match" }
}

/** What the eBay orders importer will make of one row, before it looks it up. */
export function classifyEbayOrderRow(row: Record<string, string>): RowVerdict {
  const label = row.customLabel?.trim() ?? ""
  if (!label) {
    return { kind: "error", message: "No custom label on this row, so it matches no item." }
  }
  if (!readsAsPrice(row.salePrice ?? "")) {
    return { kind: "error", message: "The sold price on this row is not an amount." }
  }
  return { kind: "matched", message: `Matches ${label}.` }
}
