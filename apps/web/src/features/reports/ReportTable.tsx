/**
 * A report's table: hairline rows, a sticky heading row, figures right
 * aligned in tabular numerals, and below 900px the list of summaries the
 * settings matrix uses instead of a table nobody can read on a phone.
 *
 * Sorting is TanStack Table's, over the sort value each column spec gives,
 * so a money column sorts on its pence and a name column on its own text.
 * The heading is a button, so the whole thing works from the keyboard.
 */
import * as React from "react"
import {
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"

import { ProductImage } from "@/components/product-image"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableImageCell,
  TableRow,
} from "@/components/ui/table"
import type { ReportRow } from "@/lib/api/types"
import type { ColumnSpec } from "@/features/reports/specs"

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
})

export interface ReportTableProps {
  columns: ColumnSpec[]
  rows: ReportRow[]
  /** One line saying what is empty and what to do about it. */
  empty: string
  /**
   * When a row is an item, the frame its thumbnail is drawn in. The report
   * routes carry no image URL, so this is the silhouette in the right shape
   * rather than a picture, and it keeps the rows on one left rail.
   */
  imagePlatform?: string
  /**
   * How many rows to draw. A year of the buy-in register is thousands of
   * lines, and a page nobody can scroll is no more useful than a page that
   * says how many there are. The exported CSV always carries the lot.
   */
  limit?: number
  testId?: string
}

export function ReportTable({
  columns,
  rows,
  empty,
  imagePlatform,
  limit = 200,
  testId,
}: ReportTableProps) {
  const shown = rows.length > limit ? rows.slice(0, limit) : rows
  const defs = React.useMemo(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorFn: (row: ReportRow) =>
          column.sortValue ? column.sortValue(row) : column.text(row),
        header: column.label,
        sortFn: column.numeric ? ("basic" as const) : ("alphanumeric" as const),
      })),
    [columns]
  )

  const table = useTable({ features, columns: defs, data: shown })

  if (rows.length === 0) {
    return (
      <p className="text-[15px] text-muted-foreground-2" data-testid={testId}>
        {empty}
      </p>
    )
  }

  const title = columns.find((column) => column.summary === "title") ?? columns[0]
  const details = columns.filter((column) => column.summary === "detail")
  const figure = columns.find((column) => column.summary === "figure")

  return (
    <div data-testid={testId}>
      {/* From 900px: the table, in its own scrollport so the heading row
          has something to stick to. Without one, `sticky top-0` sticks to
          the page and a long table's heading scrolls away regardless. */}
      <div className="hidden max-h-[70vh] overflow-y-auto min-[900px]:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {imagePlatform ? (
                  <TableHead className="sticky top-0 z-10 w-14 bg-background" />
                ) : null}
                {group.headers.map((header) => {
                  const column = columns.find((entry) => entry.key === header.id)
                  const sorted = header.column.getIsSorted()
                  return (
                    <TableHead
                      key={header.id}
                      numeric={column?.numeric}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                      className="sticky top-0 z-10 bg-background"
                    >
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={`inline-flex items-center gap-1.5 rounded-[var(--radius)] uppercase ${
                          column?.numeric ? "flex-row-reverse" : ""
                        }`}
                      >
                        {column?.label ?? header.id}
                        {sorted === "asc" ? (
                          <ArrowUpIcon aria-hidden="true" className="size-3 stroke-[1.5]" />
                        ) : sorted === "desc" ? (
                          <ArrowDownIcon aria-hidden="true" className="size-3 stroke-[1.5]" />
                        ) : null}
                      </button>
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {imagePlatform ? (
                  <TableImageCell>
                    <ProductImage src={undefined} alt="" platform={imagePlatform} height={40} />
                  </TableImageCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell key={column.key} numeric={column.numeric}>
                    {column.cell ? column.cell(row.original) : column.text(row.original)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Below 900px: one readable line per row, with the figure on the right. */}
      <ul className="min-[900px]:hidden">
        {table.getRowModel().rows.map((row) => (
          <li
            key={row.id}
            data-testid="report-row-small"
            className="flex min-h-12 items-center justify-between gap-4 border-b border-hairline-soft py-3 first:border-t"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] text-foreground">
                {title?.cell ? title.cell(row.original) : (title?.text(row.original) ?? "")}
              </span>
              {details.length > 0 ? (
                <span className="tnum truncate text-[13px] text-muted-foreground-2">
                  {details
                    .map((column) => `${column.label} ${column.text(row.original)}`)
                    .join(" · ")}
                </span>
              ) : null}
            </span>
            {figure ? (
              <span className="tnum shrink-0 text-[15px] text-foreground">
                {figure.text(row.original)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {rows.length > shown.length ? (
        <p className="mt-6 text-[13px] text-muted-foreground-2">
          Showing the first {shown.length} of {rows.length.toLocaleString("en-GB")}{" "}
          rows. The exported file has them all.
        </p>
      ) : null}
    </div>
  )
}
