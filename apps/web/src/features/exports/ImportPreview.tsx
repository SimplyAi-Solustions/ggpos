/**
 * What the first ten rows of a chosen file will do, read against the same
 * mapping the server imports through (docs/csv-formats.md).
 *
 * This is a preview and nothing more: no row is written until Import is
 * pressed, and what actually happens to each one is the server's own
 * decision. The verdicts here are the importer's published rules, so a row
 * this says will be skipped is a row the import will report as skipped.
 */
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { MicroLabel } from "@/components/ui/micro-label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  classifyCardUploaderRow,
  classifyEbayOrderRow,
  type MappedFile,
  type RowVerdict,
} from "@/lib/api/csv-parse"
import type { CsvImportType } from "@/lib/api/types"

const PREVIEW_ROWS = 10

const VERDICT_WORDS: Record<RowVerdict["kind"], string> = {
  matched: "Will import",
  review: "Needs a match",
  error: "Will be skipped",
}

/** The field names as a heading, in the mapping's own order. */
const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  set: "Set",
  number: "Number",
  condition: "Condition",
  price: "Price",
  quantity: "Qty",
  tcgplayerId: "TCGplayer id",
  cardmarketId: "Cardmarket id",
  csSku: "Custom label",
  customLabel: "Custom label",
  itemNumber: "Item number",
  orderNumber: "Order",
  saleDate: "Sold on",
  salePrice: "Sold for",
  currency: "Currency",
}

/**
 * The cell as money when it reads as money, and exactly as written when it
 * does not. The shared parser, never a float multiply: "12.34" is 1234
 * pence through string arithmetic, and anything it refuses is shown raw so
 * staff can see what the file actually says.
 */
function priceText(raw: string): string {
  const pence = parseDecimalToMinor(raw)
  return pence === null ? raw : formatGBP(pence)
}

export function ImportPreview({
  file,
  type,
}: {
  file: MappedFile
  type: CsvImportType
}) {
  const classify = type === "card_uploader" ? classifyCardUploaderRow : classifyEbayOrderRow
  const rows = file.rows.slice(0, PREVIEW_ROWS)
  const verdicts = rows.map(classify)
  const problems = verdicts.filter((verdict) => verdict.kind !== "matched").length

  return (
    <div className="mt-8" data-testid="import-preview">
      <MicroLabel tone="ink" className="mb-4">
        First {rows.length} {rows.length === 1 ? "row" : "rows"}
      </MicroLabel>
      <p className="mb-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        {file.rows.length} {file.rows.length === 1 ? "row" : "rows"} in the file,
        read through the columns the mapping knows.
        {problems > 0
          ? ` ${problems} of the rows shown here need something doing.`
          : ""}
      </p>

      {/* From 900px: the mapped columns as a table. */}
      <div className="hidden min-[900px]:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Line</TableHead>
              {file.fields.map((field) => (
                <TableHead key={field} numeric={field === "price" || field === "salePrice"}>
                  {FIELD_LABELS[field] ?? field}
                </TableHead>
              ))}
              <TableHead>What happens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={file.lines[index] ?? index}>
                <TableCell className="tnum font-mono text-[13px]">
                  {file.lines[index] ?? index + 2}
                </TableCell>
                {file.fields.map((field) => (
                  <TableCell
                    key={field}
                    numeric={field === "price" || field === "salePrice"}
                  >
                    {field === "price" || field === "salePrice"
                      ? priceText(row[field] ?? "")
                      : (row[field] ?? "")}
                  </TableCell>
                ))}
                <TableCell className="text-muted-foreground-2">
                  {VERDICT_WORDS[verdicts[index]?.kind ?? "matched"]}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Below 900px: one line each, the way every other table reads there. */}
      <ul className="min-[900px]:hidden">
        {rows.map((row, index) => (
          <li
            key={file.lines[index] ?? index}
            className="flex min-h-12 items-center justify-between gap-4 border-b border-hairline-soft py-3 first:border-t"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] text-foreground">
                {row.name || row.customLabel || `Line ${file.lines[index] ?? index + 2}`}
              </span>
              <span className="truncate text-[13px] text-muted-foreground-2">
                {VERDICT_WORDS[verdicts[index]?.kind ?? "matched"]}
              </span>
            </span>
            <span className="tnum shrink-0 text-[15px] text-foreground">
              {priceText(row.price || row.salePrice || "")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
