/**
 * The CSV a report page exports, built here in the browser from the rows
 * already on screen.
 *
 * The escaping rule is the server's, character for character
 * (`pb_hooks/lib/vaultutil.js`'s `csvCell`): a cell that opens with `=`, `+`,
 * `-`, `@`, a tab or a carriage return is prefixed with a single quote and
 * quoted, so a title called `=HYPERLINK("x")` reads as text in Excel rather
 * than running. A cell that is already a plain number is exempt, which is
 * what keeps a negative margin a number rather than a quoted string.
 *
 * Money is written as pounds and pence from integer pence (`12.34`), never
 * with a symbol and never through a float.
 */

/** A cell a spreadsheet would try to evaluate rather than display. */
const FORMULA_START = /^[=+\-@\t\r]/

/** A cell that is already a plain number, which must stay a number. */
const NUMERIC_CELL = /^-?\d+(\.\d+)?$/

export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value)
  if (text !== "" && !NUMERIC_CELL.test(text) && FORMULA_START.test(text)) {
    return `"${`'${text}`.replace(/"/g, '""')}"`
  }
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** One line, CRLF terminated, the way RFC 4180 has it. */
export function csvRow(values: (string | number | null | undefined)[]): string {
  return `${values.map(csvCell).join(",")}\r\n`
}

/** Integer pence as a plain pounds figure: 1234 is `12.34`, -50 is `-0.50`. */
export function poundsCell(pence: number): string {
  const negative = pence < 0
  const abs = Math.abs(Math.round(pence))
  const whole = Math.floor(abs / 100)
  const rem = abs % 100
  return `${negative ? "-" : ""}${whole}.${rem < 10 ? `0${rem}` : String(rem)}`
}

/** One column of an exported table: its heading and how a row reads into it. */
export interface CsvColumn<Row> {
  label: string
  value: (row: Row) => string | number
}

/** A whole file: a header row from the column labels, then every row. */
export function buildCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]): string {
  let text = csvRow(columns.map((column) => column.label))
  for (const row of rows) text += csvRow(columns.map((column) => column.value(row)))
  return text
}

/** `gg-vault-sales-2026-09-01-2026-09-20.csv`. */
export function csvFilename(key: string, from: string, to: string): string {
  return `gg-vault-${key}-${from}-${to}.csv`
}

/**
 * Hand the file to the browser. A blob URL rather than a data URL, because a
 * year of rows is bigger than some browsers will take in a URL, and it is
 * revoked on the next frame so nothing is held open.
 */
export function downloadCsv(filename: string, text: string): void {
  // A BOM, so Excel opens a name with an accent in it as UTF-8.
  const blob = new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" })
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
