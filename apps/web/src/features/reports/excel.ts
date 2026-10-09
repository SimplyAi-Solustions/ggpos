/**
 * Excel downloads (docs/api-contract-launch.md, section 3, "Excel"): every
 * report, the dashboard, the VAT return and every export can be taken as an
 * `.xlsx` as well as a CSV, built here in the browser from the rows already
 * on screen.
 *
 * - Money is a number in pounds formatted `"£"#,##0.00`, written from integer
 *   pence as text ("1234.56") so no float reaches the file.
 * - Dates are dates (`dd/mm/yyyy`), counts are numbers, percentages are
 *   numbers formatted `0.0%`.
 * - One sheet per table, the header row frozen, plus a cover sheet with what
 *   the file is, the range it covers and when it was made.
 * - Text is always a string cell, never a formula: a title that opens with
 *   "=" is shown, not run.
 *
 * The file is a plain SpreadsheetML package: the XML here, zipped by fflate's
 * synchronous `zipSync`. Synchronous on purpose: fflate's asynchronous zip
 * starts a worker from a blob URL for anything over 160 KB, and the shop's
 * Content-Security-Policy (`worker-src 'self'`, deploy/Caddyfile.snippet)
 * refuses one, so a year of rows would fail to download.
 */
import { strToU8, zipSync } from "fflate"
import { parseDecimalToMinor } from "@gg/shared"

import { parseCsv } from "@/lib/api/csv-parse"

// ---------------------------------------------------------------------------
// The workbook, as data
// ---------------------------------------------------------------------------

/** How a cell is written. */
export type ExcelKind = "text" | "money" | "count" | "number" | "percent" | "date" | "datetime"

/**
 * A cell's value: money in integer pence, a percent as the figure ("33.8"
 * for 33.8%), a date as "YYYY-MM-DD", a date and time as an ISO string or a
 * Date, everything else as it reads.
 */
export type ExcelValue = string | number | Date | null | undefined

export interface ExcelCell {
  kind: ExcelKind
  value: ExcelValue
}

export interface ExcelColumn<Row> {
  label: string
  /** The column's kind, or one per row for a sheet of mixed figures. */
  kind: ExcelKind | ((row: Row) => ExcelKind)
  value: (row: Row) => ExcelValue
}

/** One sheet: its name, the header and the typed cells. */
export interface ExcelSheet {
  name: string
  header: string[]
  rows: ExcelCell[][]
}

export interface ExcelBook {
  /** What the file is: "Sales report", "VAT return". */
  title: string
  /** The days it covers, both YYYY-MM-DD, when it covers a range. */
  range?: { from: string; to: string } | null
  /** Said instead of a range, "1 October to 31 December 2026". */
  period?: string
  made: Date
  sheets: ExcelSheet[]
  /** Lines said on the cover under the list of sheets. */
  notes?: string[]
}

/** A sheet from rows and the columns that read them. */
export function sheet<Row>(name: string, columns: ExcelColumn<Row>[], rows: readonly Row[]): ExcelSheet {
  return {
    name,
    header: columns.map((column) => column.label),
    rows: rows.map((row) =>
      columns.map((column) => ({
        kind: typeof column.kind === "function" ? column.kind(row) : column.kind,
        value: column.value(row),
      }))
    ),
  }
}

/** `gg-vault-sales-2026-09-01-2026-09-30.xlsx`, beside the CSV's own name. */
export function xlsxFilename(key: string, from?: string, to?: string): string {
  return from && to ? `gg-vault-${key}-${from}-${to}.xlsx` : `gg-vault-${key}.xlsx`
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** Characters XML 1.0 cannot carry at all. */
// eslint-disable-next-line no-control-regex -- taking control characters out is the point
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g

export function xmlText(value: string): string {
  return value
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** "A", "B", ... "Z", "AA" for a zero-based column. */
export function columnName(index: number): string {
  let name = ""
  let n = index + 1
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** Integer pence as exact pounds text: 123456 is "1234.56", -5 is "-0.05". */
export function poundsText(pence: number): string {
  const whole = Math.round(pence)
  const sign = whole < 0 ? "-" : ""
  const abs = Math.abs(whole)
  const rem = abs % 100
  return `${sign}${Math.floor(abs / 100)}.${rem < 10 ? `0${rem}` : rem}`
}

const DAY_MS = 86_400_000
/** Excel's day 0, which makes 1 March 1900 day 61 as Excel counts it. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

/** A YYYY-MM-DD day as an Excel date serial. */
export function dateSerial(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!match) return null
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(at) ? null : Math.round((at - EXCEL_EPOCH) / DAY_MS)
}

/**
 * A moment as an Excel date and time serial, on the clock it reads in the
 * file: an ISO string in UTC as written (the server's own exports are UTC),
 * a Date in this browser's local time (the shop's own clock).
 */
export function dateTimeSerial(value: string | Date): number | null {
  let at: number
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    at = Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds()
    )
  } else {
    at = Date.parse(value.trim().replace(" ", "T"))
    if (Number.isNaN(at)) return null
  }
  return Math.round(((at - EXCEL_EPOCH) / DAY_MS) * 86_400) / 86_400
}

/** The styles each kind is written in: indexes into styles.xml's cellXfs. */
const STYLE = { text: 0, bold: 1, money: 2, date: 3, datetime: 4, count: 5, percent: 6, number: 0 } as const

/** One cell's XML, or "" for an empty cell. */
export function cellXml(ref: string, cell: ExcelCell, bold = false): string {
  const { kind, value } = cell
  if (value === null || value === undefined || value === "") return ""
  const text = (body: string) =>
    `<c r="${ref}" t="inlineStr"${bold ? ` s="${STYLE.bold}"` : ""}><is><t xml:space="preserve">${xmlText(body)}</t></is></c>`
  const number = (body: string, style: number) => `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${body}</v></c>`

  switch (kind) {
    case "money": {
      const pence = typeof value === "number" ? value : Number(value)
      return Number.isFinite(pence) ? number(poundsText(pence), STYLE.money) : text(String(value))
    }
    case "count":
    case "number": {
      const n = typeof value === "number" ? value : Number(value)
      return Number.isFinite(n) ? number(String(n), kind === "count" ? STYLE.count : STYLE.number) : text(String(value))
    }
    case "percent": {
      const n = typeof value === "number" ? value : Number(value)
      // 33.8 is written 0.338: tenths of a percent over a thousand, exactly.
      return Number.isFinite(n) ? number(String(Math.round(n * 10) / 1000), STYLE.percent) : text(String(value))
    }
    case "date": {
      const serial = typeof value === "string" ? dateSerial(value) : null
      return serial === null ? text(String(value)) : number(String(serial), STYLE.date)
    }
    case "datetime": {
      const serial = typeof value === "string" || value instanceof Date ? dateTimeSerial(value) : null
      return serial === null ? text(String(value)) : number(String(serial), STYLE.datetime)
    }
    default:
      return text(value instanceof Date ? value.toISOString() : String(value))
  }
}

/** How wide a column should be, in characters, from what is in it. */
function widthOf(cells: (ExcelCell | string)[]): number {
  let widest = 8
  for (const cell of cells) {
    const shown =
      typeof cell === "string"
        ? cell
        : cell.kind === "money" && typeof cell.value === "number"
          ? `£${poundsText(cell.value)},`
          : cell.kind === "date"
            ? "00/00/0000"
            : cell.kind === "datetime"
              ? "00/00/0000 00:00"
              : String(cell.value ?? "")
    widest = Math.max(widest, shown.length + 2)
  }
  return Math.min(60, widest)
}

/** A worksheet's XML. `freeze` keeps the first row in view. */
export function sheetXml(header: string[], rows: ExcelCell[][], options: { freeze?: boolean; boldFirstColumn?: boolean } = {}): string {
  const columns = Math.max(header.length, ...rows.map((row) => row.length))
  const widths: string[] = []
  for (let c = 0; c < columns; c++) {
    const width = widthOf([header[c] ?? "", ...rows.map((row) => row[c] ?? { kind: "text", value: "" })])
    widths.push(`<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`)
  }
  const lines: string[] = []
  let r = 1
  if (header.length) {
    const cells = header.map((label, c) => cellXml(`${columnName(c)}${r}`, { kind: "text", value: label }, true))
    lines.push(`<row r="${r}">${cells.join("")}</row>`)
    r += 1
  }
  for (const row of rows) {
    const cells = row.map((cell, c) => cellXml(`${columnName(c)}${r}`, cell, options.boldFirstColumn === true && c === 0))
    lines.push(`<row r="${r}">${cells.join("")}</row>`)
    r += 1
  }
  const pane = options.freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    pane +
    (widths.length ? `<cols>${widths.join("")}</cols>` : "") +
    `<sheetData>${lines.join("")}</sheetData>` +
    `</worksheet>`
  )
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

/**
 * A name Excel will take: at most 31 characters, none of `: \ / ? * [ ]`,
 * not wrapped in apostrophes, and not one already used in the file.
 */
export function sheetName(name: string, used: Set<string>): string {
  let clean = name.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "")
  if (!clean) clean = "Sheet"
  clean = clean.slice(0, 31).trim()
  let candidate = clean
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` ${n}`
    candidate = `${clean.slice(0, 31 - suffix.length).trim()}${suffix}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "9 October 2026 at 20:48", in this browser's own time. */
function madeText(made: Date): string {
  const hh = String(made.getHours()).padStart(2, "0")
  const mm = String(made.getMinutes()).padStart(2, "0")
  return `${made.getDate()} ${LONG_MONTHS[made.getMonth()]} ${made.getFullYear()} at ${hh}:${mm}`
}

/** The cover sheet: what the file is, its range, when it was made and what is in it. */
export function coverRows(book: ExcelBook, names: string[]): ExcelCell[][] {
  const t = (value: string): ExcelCell => ({ kind: "text", value })
  const rows: ExcelCell[][] = [[t("GG Entertainment")], [t(book.title)], []]
  if (book.range) {
    rows.push([t("From"), { kind: "date", value: book.range.from }])
    rows.push([t("To"), { kind: "date", value: book.range.to }])
  }
  if (book.period) rows.push([t("Period"), t(book.period)])
  rows.push([t("Made"), t(madeText(book.made))])
  rows.push([])
  rows.push([t("Sheets")])
  for (const name of names) rows.push([t(name)])
  if (book.notes?.length) {
    rows.push([])
    for (const note of book.notes) rows.push([t(note)])
  }
  return rows
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="4">` +
  `<numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0.00"/>` +
  `<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>` +
  `<numFmt numFmtId="166" formatCode="dd/mm/yyyy hh:mm"/>` +
  `<numFmt numFmtId="167" formatCode="0.0%"/>` +
  `</numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="7">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`

/** Every file of the package, by path, as XML text. */
export function workbookFiles(book: ExcelBook): Record<string, string> {
  const used = new Set<string>()
  const cover = sheetName("Cover", used)
  const tables = book.sheets.map((entry) => ({ ...entry, name: sheetName(entry.name, used) }))
  const all = [
    { name: cover, xml: sheetXml([], coverRows(book, tables.map((entry) => entry.name)), { boldFirstColumn: true }) },
    ...tables.map((entry) => ({ name: entry.name, xml: sheetXml(entry.header, entry.rows, { freeze: true }) })),
  ]

  const files: Record<string, string> = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      all
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("") +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    "xl/workbook.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>` +
      all.map((entry, index) => `<sheet name="${xmlText(entry.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") +
      `</sheets>` +
      `</workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      all
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
        )
        .join("") +
      `<Relationship Id="rId${all.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    "xl/styles.xml": STYLES_XML,
  }
  all.forEach((entry, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = entry.xml
  })
  return files
}

/** The `.xlsx` file itself. */
export function buildXlsx(book: ExcelBook): Uint8Array {
  const files = workbookFiles(book)
  const zipped: Record<string, Uint8Array> = {}
  // Copied into this realm's own Uint8Array: fflate tells a file from a
  // folder with `instanceof`, and a TextEncoder from another realm (a test
  // environment's) hands back one that fails it.
  for (const [path, xml] of Object.entries(files)) zipped[path] = new Uint8Array(strToU8(xml))
  return zipSync(zipped, { level: 6 })
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** Build the file and hand it to the browser, the way the CSV download does. */
export function downloadXlsx(filename: string, book: ExcelBook): void {
  const bytes = buildXlsx(book)
  const blob = new Blob([bytes.slice().buffer], { type: XLSX_TYPE })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ---------------------------------------------------------------------------
// An export's CSV as a sheet
// ---------------------------------------------------------------------------

/** A column header that names a count: kept a number. Anything else digits-only stays text (SKUs, EANs, phones). */
const COUNT_HEADER = /\b(qty|quantity|count|lines|units|items|points|days|sales)\b/i
const MONEY_CELL = /^-?\d+\.\d{2}$/
const DATE_CELL = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_CELL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/
const INTEGER_CELL = /^-?\d{1,9}$/
/** The quote the server's csvCell puts before a cell that would run as a formula. */
const FORMULA_GUARD = /^'(?=[=+\-@\t\r])/

/** What kind a CSV column is, from its header and every value in it. */
export function inferKind(header: string, values: string[]): ExcelKind {
  const filled = values.filter((value) => value !== "")
  if (filled.length === 0) return "text"
  if (filled.every((value) => MONEY_CELL.test(value))) return "money"
  if (filled.every((value) => DATE_CELL.test(value))) return "date"
  if (filled.every((value) => DATETIME_CELL.test(value))) return "datetime"
  if (COUNT_HEADER.test(header) && filled.every((value) => INTEGER_CELL.test(value))) return "count"
  return "text"
}

/**
 * One sheet from a CSV the server sent: the header row, each column typed by
 * what is in it, money back to pence first so it is written exactly.
 */
export function sheetFromCsv(name: string, text: string): ExcelSheet {
  const parsed = parseCsv(text.replace(/^\ufeff/, ""))
  const header = parsed[0] ?? []
  const body = parsed.slice(1).filter((row) => row.some((cell) => cell !== ""))
  const kinds = header.map((label, c) => inferKind(label, body.map((row) => row[c] ?? "")))
  return {
    name,
    header,
    rows: body.map((row) =>
      header.map((_, c) => {
        const raw = row[c] ?? ""
        const kind = kinds[c] ?? "text"
        if (raw === "") return { kind, value: null }
        if (kind === "money") return { kind, value: parseDecimalToMinor(raw) }
        if (kind === "count") return { kind, value: Number(raw) }
        if (kind === "text") return { kind, value: raw.replace(FORMULA_GUARD, "") }
        return { kind, value: raw }
      })
    ),
  }
}
