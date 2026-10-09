/**
 * The X and Z reports as a list of draw operations
 * (docs/api-contract-epos.md, section 3 for what is in a `TillReport`,
 * section 6 for how it is printed).
 *
 * The same paper and the same three faces as a receipt: the report's name and
 * number in Anton, section labels in Space Mono, the rows in Jost with their
 * figures right-aligned. A variance is always said in words ("£2.40 over",
 * "£1.10 short", "Exact") so it never rests on a sign alone.
 *
 * Pure, like `receipt-layout.ts`.
 */
import { formatGBP } from "@gg/shared"
import type { TillReport } from "@gg/shared"

import {
  createPage,
  displaySize,
  FACE,
  type FontSpec,
  type Layout,
  type Measure,
  type Page,
  type PaperWidth,
} from "./draw"
import { formatDateTime } from "./receipt-layout"

/** A cash or card difference in words: "£2.40 over", "£1.10 short" or "Exact". */
export function varianceWords(pence: number): string {
  if (pence === 0) return "Exact"
  return `${formatGBP(Math.abs(pence))} ${pence > 0 ? "over" : "short"}`
}

/** A signed adjustment: "+£5.00" or "-£5.00". */
function signed(pence: number): string {
  return `${pence < 0 ? "-" : "+"}${formatGBP(Math.abs(pence))}`
}

/** Money going out, whichever way round the server stored it. */
function out(pence: number): string {
  return formatGBP(-Math.abs(pence))
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export interface ReportLayoutOptions {
  width: PaperWidth
  measure: Measure
}

export function layoutTillReport(report: TillReport, opts: ReportLayoutOptions): Layout {
  const page = createPage(opts.width, opts.measure)
  const body = FACE.sans(23)
  const strong = FACE.sansMedium(24)
  const small = FACE.sans(20)
  const heading = FACE.monoBold(20, 3)
  const label = FACE.monoBold(19, 3)
  const zed = report.type === "z"

  function section(title: string) {
    page.gap(8)
    page.rule()
    page.line(title, heading)
    page.gap(2)
  }

  function optional(name: string, pence: number, value: string) {
    if (pence !== 0) page.row(name, value, body)
  }

  page.gap(20)
  page.line(`${report.type.toUpperCase()} REPORT`, FACE.display(displaySize(56, opts.width)), "center")
  page.gap(2)
  page.line(`No. ${report.number}`, FACE.monoBold(26, 3), "center")
  page.gap(6)
  page.wrap(report.register.name, FACE.sansMedium(26), "center")
  page.gap(4)
  page.rule()
  page.row("FROM", formatDateTime(report.period_start), label, FACE.sans(22))
  page.row("TO", formatDateTime(report.period_end), label, FACE.sans(22))
  page.row("RUN BY", report.created_by.name, label, FACE.sans(22))

  // Sales
  section("SALES")
  page.row("Sales", String(report.sales.count), body)
  page.row("Gross sales", formatGBP(report.sales.gross), body)
  if (report.sales.discounts > 0) page.row("Discounts", out(report.sales.discounts), body)
  if (report.refunds.count > 0 || report.refunds.total !== 0) {
    page.row(`Refunds (${report.refunds.count})`, out(report.refunds.total), body)
  }
  page.row("Net sales", formatGBP(report.sales.net), strong)
  page.row("Average basket", formatGBP(report.sales.average_basket), body)
  if (report.sales.vat.length > 0) {
    page.gap(6)
    for (const row of report.sales.vat) {
      page.row(`VAT at ${row.rate}% on ${formatGBP(row.net)}`, formatGBP(row.vat), small)
    }
  }

  // Tenders
  section("PAYMENTS")
  if (report.tenders.length === 0) page.line("No payments", body)
  for (const tender of report.tenders) {
    page.row(tender.label, formatGBP(tender.net), body)
    const parts = [plural(tender.count, "payment", "payments"), `taken ${formatGBP(tender.taken)}`]
    if (tender.refunded !== 0) parts.push(`refunded ${formatGBP(Math.abs(tender.refunded))}`)
    page.wrap(parts.join(", "), small)
  }

  // Cash in the drawer
  const cash = report.cash
  section("CASH")
  page.row("Opening float", formatGBP(cash.opening_float), body)
  page.row("Cash sales", formatGBP(cash.cash_sales), body)
  optional("Cash refunds", cash.cash_refunds, out(cash.cash_refunds))
  optional("Paid in", cash.paid_in, formatGBP(cash.paid_in))
  optional("Paid out", cash.paid_out, out(cash.paid_out))
  optional("Buy-in payouts", cash.buy_in_payouts, out(cash.buy_in_payouts))
  optional("Bank drops", cash.bank_drops, out(cash.bank_drops))
  optional("Adjustments", cash.adjustments, signed(cash.adjustments))
  page.row("Expected in drawer", formatGBP(cash.expected), strong)
  if (cash.counted !== null) {
    page.row("Counted", formatGBP(cash.counted), body)
    page.row("Difference", varianceWords(cash.variance ?? cash.counted - cash.expected), strong)
  }

  // Card against Tide
  section("CARD")
  page.row("Card payments in the till", formatGBP(report.card.till_total), body)
  if (zed) {
    if (report.card.reported_total === null) {
      page.row("Tide total", "Not entered", body)
    } else {
      page.row("Tide total", formatGBP(report.card.reported_total), body)
      page.row(
        "Difference",
        varianceWords(report.card.variance ?? report.card.reported_total - report.card.till_total),
        strong
      )
    }
  }

  // What staff did that a manager may want to see
  section("CHECKS")
  page.row("Voids", `${report.voids.count}, ${formatGBP(report.voids.total)}`, body)
  page.row("No sales", String(report.no_sales.count), body)
  page.row("Manager overrides", String(report.overrides.count), body)
  page.row("Discounts given", `${report.discounts.count}, ${formatGBP(report.discounts.total)}`, body)

  // Trade-ins
  const trade = report.trade_ins
  section("TRADE-INS")
  page.row("Trade-ins", String(trade.count), body)
  page.row("Paid out in cash", formatGBP(trade.cash_paid), body)
  page.row("Store credit issued", formatGBP(trade.credit_issued), body)
  page.row("Part-exchange value", formatGBP(trade.part_exchange_value), body)

  groups(
    page,
    "BY CATEGORY",
    report.by_category.map((row) => ({ name: row.category, net: row.net, count: row.count })),
    body,
    small
  )
  groups(
    page,
    "BY STAFF",
    report.by_staff.map((row) => ({ name: row.name, net: row.net, count: row.count })),
    body,
    small
  )

  if (zed && report.notes.trim()) {
    section("NOTES")
    page.wrap(report.notes.trim(), body)
  }

  page.gap(10)
  page.rule()
  page.wrap(
    `${report.type.toUpperCase()} ${report.number} saved ${formatDateTime(report.created)}`,
    FACE.mono(18),
    "center"
  )
  return page.finish(44)
}

/** A "by category" or "by staff" block: a name, what it took, how many sales. */
function groups(
  page: Page,
  title: string,
  rows: { name: string; net: number; count: number }[],
  body: FontSpec,
  small: FontSpec
) {
  if (rows.length === 0) return
  page.gap(8)
  page.rule()
  page.line(title, FACE.monoBold(20, 3))
  page.gap(2)
  for (const row of rows) {
    page.row(row.name || "Uncategorised", formatGBP(row.net), body)
    page.line(plural(row.count, "sale", "sales"), small)
  }
}
