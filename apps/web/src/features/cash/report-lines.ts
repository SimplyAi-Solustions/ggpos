/**
 * An X or Z report as the groups of lines the screen draws, laid out like
 * the printed receipt (DESIGN.md section 10, "Cashing up": MicroLabel
 * headings, rows with the figure right-aligned, hairlines between groups).
 *
 * Pure, so what the report says can be tested without rendering it, and so
 * a figure that is not there (a Z-only line on an X) is left out here
 * rather than drawn as a zero that would read as a count.
 *
 * Money out of the drawer is shown as the amount that went, whatever sign
 * it arrives with: the label says which way it moved, and a minus sign
 * beside "Paid out" would say it twice. Adjustments are the one signed line.
 */
import {
  DENOMINATIONS,
  formatGBP,
  type TillReport,
} from "@gg/shared"

import { denominationLabel, varianceWords } from "@/features/cash/count"
import { formatDateTime } from "@/lib/dates"

export interface ReportLine {
  label: string
  value: string
  /** A grey line under the label: "3 payments, £2.49 refunded". */
  note?: string
  /** The line that matters most in its group, set in Jost 500. */
  strong?: boolean
  testId?: string
}

export interface ReportGroup {
  heading: string
  lines: ReportLine[]
}

function out(pence: number): string {
  return formatGBP(Math.abs(pence))
}

function signed(pence: number): string {
  return pence < 0 ? `-${formatGBP(-pence)}` : formatGBP(pence)
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "X report 87" or "Z report 42". */
export function reportTitle(report: Pick<TillReport, "type" | "number">): string {
  return `${report.type === "z" ? "Z" : "X"} report ${report.number}`
}

function time(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
}

/** The lines under the title: where, when and who, and the period it covers. */
export function reportHeader(report: TillReport): string[] {
  const lines = [
    `${report.register.name}, ${formatDateTime(report.created)}`,
    `Run by ${report.created_by.name}`,
  ]
  if (report.period_start) {
    lines.push(`From ${formatDateTime(report.period_start)} to ${time(report.period_end || report.created)}`)
  }
  return lines
}

export function reportGroups(report: TillReport): ReportGroup[] {
  const groups: ReportGroup[] = []
  const z = report.type === "z"

  // ---- Sales ----
  const sales: ReportLine[] = [
    { label: "Sales", value: String(report.sales.count) },
    { label: "Gross", value: formatGBP(report.sales.gross) },
    { label: "Discounts", value: out(report.sales.discounts) },
    {
      label: "Refunds",
      value: out(report.refunds.total),
      note: report.refunds.count ? plural(report.refunds.count, "refund", "refunds") : undefined,
    },
    { label: "Net", value: formatGBP(report.sales.net), strong: true, testId: "report-net" },
    { label: "Average basket", value: formatGBP(report.sales.average_basket) },
  ]
  groups.push({ heading: "Sales", lines: sales })

  if (report.sales.vat.length) {
    groups.push({
      heading: "VAT",
      lines: report.sales.vat.map((row) => ({
        label: `${row.rate}%`,
        value: formatGBP(row.vat),
        note: `On ${formatGBP(row.gross)}, ${formatGBP(row.net)} before VAT`,
      })),
    })
  }

  // ---- Tenders ----
  if (report.tenders.length) {
    groups.push({
      heading: "Tenders",
      lines: report.tenders.map((row) => ({
        label: row.label,
        value: formatGBP(row.net),
        note: [
          plural(row.count, "payment", "payments"),
          row.refunded ? `${out(row.refunded)} refunded` : "",
        ]
          .filter(Boolean)
          .join(", "),
      })),
    })
  }

  // ---- Cash ----
  const cash = report.cash
  const cashLines: ReportLine[] = [
    { label: "Opening float", value: formatGBP(cash.opening_float) },
    { label: "Cash sales", value: formatGBP(cash.cash_sales) },
  ]
  if (cash.cash_refunds) cashLines.push({ label: "Cash refunds", value: out(cash.cash_refunds) })
  if (cash.paid_in) cashLines.push({ label: "Paid in", value: out(cash.paid_in) })
  if (cash.paid_out) cashLines.push({ label: "Paid out", value: out(cash.paid_out) })
  if (cash.buy_in_payouts) {
    cashLines.push({ label: "Buy-in payouts", value: out(cash.buy_in_payouts) })
  }
  if (cash.bank_drops) cashLines.push({ label: "Bank drops", value: out(cash.bank_drops) })
  if (cash.adjustments) cashLines.push({ label: "Adjustments", value: signed(cash.adjustments) })
  cashLines.push({
    label: "Expected in the drawer",
    value: formatGBP(cash.expected),
    strong: !z,
    testId: "report-expected",
  })
  if (z && cash.counted !== null) {
    cashLines.push({ label: "Counted", value: formatGBP(cash.counted), testId: "report-counted" })
    cashLines.push({
      label: "Cash variance",
      value: varianceWords(cash.variance),
      strong: true,
      testId: "report-cash-variance",
    })
  }
  groups.push({ heading: "Cash", lines: cashLines })

  // ---- Card ----
  const card: ReportLine[] = [{ label: "Card on the till", value: formatGBP(report.card.till_total) }]
  if (z) {
    card.push({
      label: "Tide total",
      value: report.card.reported_total === null ? "Not keyed" : formatGBP(report.card.reported_total),
    })
    if (report.card.variance !== null) {
      card.push({
        label: "Card variance",
        value: varianceWords(report.card.variance),
        strong: true,
        testId: "report-card-variance",
      })
    }
  }
  groups.push({ heading: "Card", lines: card })

  // ---- The count ----
  if (z && report.counts) {
    const counted = DENOMINATIONS.filter((value) => (report.counts?.[`${value}`] ?? 0) > 0)
    if (counted.length) {
      groups.push({
        heading: "The count",
        lines: counted.map((value) => {
          const count = report.counts?.[`${value}`] ?? 0
          return {
            label: `${denominationLabel(value)} × ${count}`,
            value: formatGBP(value * count),
          }
        }),
      })
    }
  }

  // ---- Everything else on the day ----
  const other: ReportLine[] = [
    {
      label: "Voids",
      value: formatGBP(report.voids.total),
      note: plural(report.voids.count, "line", "lines"),
    },
    { label: "No sales", value: String(report.no_sales.count) },
    { label: "Manager approvals", value: String(report.overrides.count) },
    {
      label: "Discounts given",
      value: formatGBP(report.discounts.total),
      note: plural(report.discounts.count, "sale", "sales"),
    },
  ]
  if (report.trade_ins.count) {
    other.push({
      label: "Buy-ins",
      value: formatGBP(report.trade_ins.cash_paid + report.trade_ins.credit_issued),
      note: `${plural(report.trade_ins.count, "buy-in", "buy-ins")}: ${formatGBP(report.trade_ins.cash_paid)} cash, ${formatGBP(report.trade_ins.credit_issued)} credit`,
    })
  }
  if (report.trade_ins.part_exchange_value) {
    other.push({ label: "Part-exchange", value: formatGBP(report.trade_ins.part_exchange_value) })
  }
  groups.push({ heading: "On the day", lines: other })

  if (report.by_category.length) {
    groups.push({
      heading: "By category",
      lines: report.by_category.map((row) => ({
        label: row.category,
        value: formatGBP(row.net),
        note: plural(row.count, "sale", "sales"),
      })),
    })
  }
  if (report.by_staff.length) {
    groups.push({
      heading: "By staff",
      lines: report.by_staff.map((row) => ({
        label: row.name,
        value: formatGBP(row.net),
        note: plural(row.count, "sale", "sales"),
      })),
    })
  }

  if (report.notes.trim()) {
    groups.push({ heading: "Notes", lines: [{ label: report.notes.trim(), value: "" }] })
  }
  return groups
}
