import { describe, expect, it } from "vitest"
import type { TillReport } from "@gg/shared"

import { reportGroups, reportHeader, reportTitle } from "@/features/cash/report-lines"

/**
 * What an X or a Z says on screen, line by line. The Z-only figures are
 * left off an X rather than drawn as a zero, money out of the drawer is the
 * amount that went whatever its sign, and every variance is in words.
 */

function report(overrides: Partial<TillReport> = {}): TillReport {
  return {
    id: "report_1",
    type: "x",
    number: 87,
    register: { id: "register_1", name: "Counter" },
    session_id: "session_1",
    period_start: "2026-10-09T09:00:00.000Z",
    period_end: "2026-10-09T15:40:00.000Z",
    created: "2026-10-09T15:40:00.000Z",
    created_by: { id: "staff_1", name: "Mo Khan" },
    sales: { count: 6, gross: 15990, discounts: 250, net: 15491, average_basket: 2582, vat: [] },
    refunds: { count: 1, total: 249 },
    tenders: [
      { method: "cash", label: "Cash", taken: 1997, refunded: 249, net: 1748, count: 3 },
      { method: "card_tide", label: "Card", taken: 13243, refunded: 0, net: 13243, count: 3 },
    ],
    cash: {
      opening_float: 10000,
      cash_sales: 1997,
      cash_refunds: 249,
      paid_in: 0,
      paid_out: 0,
      buy_in_payouts: 6500,
      bank_drops: 0,
      adjustments: 0,
      expected: 5248,
      counted: null,
      variance: null,
    },
    card: { till_total: 13243, reported_total: null, variance: null },
    voids: { count: 1, total: 499 },
    no_sales: { count: 0 },
    overrides: { count: 0 },
    discounts: { count: 1, total: 250 },
    trade_ins: { count: 1, cash_paid: 6500, credit_issued: 2000, part_exchange_value: 0 },
    by_category: [{ category: "Singles", net: 6243, count: 3 }],
    by_staff: [{ staff_id: "staff_1", name: "Mo Khan", net: 2999, count: 1 }],
    first_sale_at: "2026-10-09T09:14:00.000Z",
    last_sale_at: "2026-10-09T12:02:00.000Z",
    counts: null,
    notes: "",
    ...overrides,
  }
}

function group(groups: ReturnType<typeof reportGroups>, heading: string) {
  return groups.find((entry) => entry.heading === heading)
}

function line(groups: ReturnType<typeof reportGroups>, heading: string, label: string) {
  return group(groups, heading)?.lines.find((entry) => entry.label === label)
}

describe("an X report", () => {
  it("is titled by its type and number", () => {
    expect(reportTitle({ type: "x", number: 87 })).toBe("X report 87")
    expect(reportTitle({ type: "z", number: 42 })).toBe("Z report 42")
  })

  it("says where, who and the period it covers", () => {
    const header = reportHeader(report())
    expect(header[0]).toMatch(/^Counter, \d{1,2} Oct, \d{2}:\d{2}$/)
    expect(header[1]).toBe("Run by Mo Khan")
    expect(header[2]).toMatch(/^From \d{1,2} Oct, \d{2}:\d{2} to \d{2}:\d{2}$/)
  })

  it("shows the sales, the tenders and what the drawer should hold", () => {
    const groups = reportGroups(report())
    expect(line(groups, "Sales", "Net")?.value).toBe("£154.91")
    expect(line(groups, "Sales", "Refunds")?.note).toBe("1 refund")
    expect(line(groups, "Tenders", "Cash")?.value).toBe("£17.48")
    expect(line(groups, "Tenders", "Cash")?.note).toBe("3 payments, £2.49 refunded")
    expect(line(groups, "Cash", "Expected in the drawer")?.value).toBe("£52.48")
    expect(line(groups, "Cash", "Buy-in payouts")?.value).toBe("£65.00")
  })

  it("leaves the Z-only lines off rather than drawing them as zero", () => {
    const groups = reportGroups(report())
    expect(line(groups, "Cash", "Counted")).toBeUndefined()
    expect(line(groups, "Cash", "Cash variance")).toBeUndefined()
    expect(line(groups, "Card", "Tide total")).toBeUndefined()
    expect(group(groups, "The count")).toBeUndefined()
    // And a movement that did not happen is not a line either.
    expect(line(groups, "Cash", "Paid out")).toBeUndefined()
  })

  it("shows money out as the amount that went, whatever sign it arrives with", () => {
    const groups = reportGroups(
      report({
        cash: { ...report().cash, paid_out: -500, bank_drops: -2000, adjustments: -100 },
      })
    )
    expect(line(groups, "Cash", "Paid out")?.value).toBe("£5.00")
    expect(line(groups, "Cash", "Bank drops")?.value).toBe("£20.00")
    // An adjustment is the one line that keeps its sign.
    expect(line(groups, "Cash", "Adjustments")?.value).toBe("-£1.00")
  })

  it("lists VAT only when there is some", () => {
    expect(group(reportGroups(report()), "VAT")).toBeUndefined()
    const withVat = reportGroups(
      report({
        sales: {
          ...report().sales,
          vat: [{ rate: 20, net: 4579, vat: 916, gross: 5495 }],
        },
      })
    )
    expect(line(withVat, "VAT", "20%")?.value).toBe("£9.16")
  })
})

describe("a Z report", () => {
  const z = report({
    type: "z",
    number: 42,
    cash: { ...report().cash, counted: 5960, variance: 5712, bank_drops: 5000 },
    card: { till_total: 13243, reported_total: 13000, variance: -243 },
    counts: { "2000": 3, "50": 3 },
    notes: "Two pound coins short in the bag",
  })

  it("says the variances in words", () => {
    const groups = reportGroups(z)
    expect(line(groups, "Cash", "Counted")?.value).toBe("£59.60")
    expect(line(groups, "Cash", "Cash variance")?.value).toBe("£57.12 over")
    expect(line(groups, "Card", "Tide total")?.value).toBe("£130.00")
    expect(line(groups, "Card", "Card variance")?.value).toBe("£2.43 short")
  })

  it("lists the count by denomination, largest first", () => {
    const counted = group(reportGroups(z), "The count")?.lines
    expect(counted?.map((entry) => [entry.label, entry.value])).toEqual([
      ["£20 × 3", "£60.00"],
      ["50p × 3", "£1.50"],
    ])
  })

  it("says Exact for a drawer that balances, and Not keyed when Tide was not", () => {
    const groups = reportGroups(
      report({
        type: "z",
        cash: { ...report().cash, counted: 5248, variance: 0 },
        card: { till_total: 0, reported_total: null, variance: null },
      })
    )
    expect(line(groups, "Cash", "Cash variance")?.value).toBe("Exact")
    expect(line(groups, "Card", "Tide total")?.value).toBe("Not keyed")
    expect(line(groups, "Card", "Card variance")).toBeUndefined()
  })

  it("keeps the notes", () => {
    expect(group(reportGroups(z), "Notes")?.lines[0]?.label).toBe("Two pound coins short in the bag")
  })
})
