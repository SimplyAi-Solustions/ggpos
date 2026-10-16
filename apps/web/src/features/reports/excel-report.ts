/**
 * A report's Excel file, from the same spec its screen and its CSV read
 * (features/reports/specs.tsx): a cover, the figures, the period's series,
 * the main table and each smaller list, one sheet each.
 */
import type { ReportEnvelope, ReportRow } from "@/lib/api/types"
import { sheet, type ExcelBook, type ExcelColumn, type ExcelKind, type ExcelSheet } from "@/features/reports/excel"
import { num, type ColumnSpec, type Figure, type ReportSpec } from "@/features/reports/specs"

/** A screen column as an Excel column: its kind, and the cell read the way that kind wants it. */
export function excelColumns(columns: ColumnSpec[]): ExcelColumn<ReportRow>[] {
  return columns.map((column) => {
    const kind: ExcelKind = column.excel ?? "text"
    return {
      label: column.label,
      kind,
      value: (row: ReportRow) => {
        if (column.excelValue) return column.excelValue(row)
        if (kind === "text") return column.text(row)
        return num(row, column.key)
      },
    }
  })
}

/** How a figure on the KPI row is written. */
export function figureKind(figure: Figure): ExcelKind {
  if (figure === "money") return "money"
  if (figure === "percent") return "percent"
  if (figure === "ratio") return "number"
  return "count"
}

function totalOf(totals: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = totals?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * The whole file for one report over one range. `columns` is the table as
 * the screen draws it (Sales by category has its own); `bucketTitle` writes
 * a series label the way the chart's tooltip does.
 */
export function reportBook(input: {
  spec: ReportSpec
  envelope: ReportEnvelope
  columns: ColumnSpec[]
  range: { from: string; to: string }
  bucketTitle: (label: string) => string
  made?: Date
}): ExcelBook {
  const { spec, envelope } = input
  const compare = envelope.compare?.totals ?? null
  const sheets: ExcelSheet[] = []

  type Kpi = (typeof spec.kpis)[number]
  const figures: ExcelColumn<Kpi>[] = [
    { label: "Figure", kind: "text", value: (kpi) => kpi.label },
    { label: "This period", kind: (kpi) => figureKind(kpi.figure), value: (kpi) => totalOf(envelope.totals, kpi.key) },
  ]
  if (compare) {
    figures.push({
      label: "Period before",
      kind: (kpi) => figureKind(kpi.figure),
      value: (kpi) => totalOf(compare, kpi.key),
    })
  }
  sheets.push(sheet("Figures", figures, spec.kpis))

  if (spec.chart && envelope.series.length > 0) {
    const kind: ExcelKind = spec.chart.money ? "money" : "count"
    sheets.push(
      sheet(
        "Over the period",
        [
          { label: "Period", kind: "text", value: (point: ReportEnvelope["series"][number]) => input.bucketTitle(point.label) },
          ...spec.chart.series.map((series) => ({
            label: series.label,
            kind,
            value: (point: ReportEnvelope["series"][number]) => point.values[series.key] ?? 0,
          })),
        ],
        envelope.series
      )
    )
  }

  sheets.push(sheet(spec.tableHeading, excelColumns(input.columns), envelope.table))

  for (const panel of spec.panels) {
    const rows = envelope.totals?.[panel.totalsKey]
    sheets.push(sheet(panel.heading, excelColumns(panel.columns), Array.isArray(rows) ? (rows as ReportRow[]) : []))
  }

  return {
    title: `${spec.title} report`,
    range: input.range,
    made: input.made ?? new Date(),
    sheets,
    notes: spec.note ? [spec.note] : [],
  }
}
