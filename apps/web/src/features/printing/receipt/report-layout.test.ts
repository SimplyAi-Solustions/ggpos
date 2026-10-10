import { describe, expect, it } from "vitest"
import type { TillReport } from "@gg/shared"

import { getTillReport } from "@/lib/api/demo/printing"

import type { FontSpec, Layout, Measure, TextOp } from "./draw"
import { layoutTillReport, varianceWords } from "./report-layout"

const measure: Measure = (text: string, font: FontSpec) =>
  Array.from(text).length * (font.size * 0.5 + (font.tracking ?? 0))

function textOps(layout: Layout): TextOp[] {
  return layout.ops.filter((op): op is TextOp => op.kind === "text")
}

function lines(layout: Layout): string[] {
  return textOps(layout).map((op) => op.text)
}

function has(layout: Layout, needle: string): boolean {
  return lines(layout).some((line) => line.includes(needle))
}

function find(layout: Layout, text: string): TextOp {
  const op = textOps(layout).find((entry) => entry.text === text)
  if (!op) throw new Error(`No text op says "${text}". It says: ${lines(layout).join(" | ")}`)
  return op
}

/** The value printed on the same baseline as a label, flush right. */
function valueOf(layout: Layout, label: string): string {
  // A name can also appear as a value (the staff member who ran the report).
  const left = textOps(layout).find((op) => op.text === label && op.align === "left")
  if (!left) throw new Error(`No left-hand text says "${label}"`)
  const right = textOps(layout).find((op) => op.align === "right" && op.y === left.y)
  if (!right) throw new Error(`"${label}" has no value beside it`)
  return right.text
}

describe("varianceWords", () => {
  it("says over, short or exact, in words and never by sign alone", () => {
    expect(varianceWords(240)).toBe("£2.40 over")
    expect(varianceWords(-110)).toBe("£1.10 short")
    expect(varianceWords(0)).toBe("Exact")
    expect(varianceWords(-5)).toBe("£0.05 short")
    expect(varianceWords(123456)).toBe("£1,234.56 over")
  })
})

describe("a Z report", () => {
  const report = getTillReport("z_1")
  const layout = layoutTillReport(report, { width: 576, measure })

  it("is headed with its kind and number, the register and the period", () => {
    const heading = find(layout, "Z REPORT")
    expect(heading.font.family).toBe("Anton")
    expect(heading.align).toBe("center")
    expect(find(layout, "No. 14").font.family).toBe("Space Mono")
    expect(find(layout, "Counter").align).toBe("center")
    expect(valueOf(layout, "FROM")).toBe("9 Oct 2026, 09:02")
    expect(valueOf(layout, "TO")).toBe("9 Oct 2026, 17:45")
    expect(valueOf(layout, "RUN BY")).toBe("Sam Bell")
  })

  it("has one Anton line, the heading", () => {
    expect(textOps(layout).filter((op) => op.font.family === "Anton")).toHaveLength(1)
  })

  it("lays the sales out with the figures flush right", () => {
    expect(valueOf(layout, "Sales")).toBe("23")
    expect(valueOf(layout, "Gross sales")).toBe("£612.50")
    expect(valueOf(layout, "Discounts")).toBe("-£12.50")
    expect(valueOf(layout, "Refunds (1)")).toBe("-£16.00")
    expect(valueOf(layout, "Net sales")).toBe("£584.00")
    expect(valueOf(layout, "Average basket")).toBe("£25.39")
  })

  it("lists each payment method with its net and a line saying how many, taken and refunded", () => {
    expect(valueOf(layout, "Cash")).toBe("£210.00")
    expect(valueOf(layout, "Card")).toBe("£374.00")
    expect(has(layout, "13 payments, taken £390.00, refunded £16.00")).toBe(true)
    expect(has(layout, "10 payments, taken £210.00")).toBe(true)
  })

  it("shows the cash in the drawer: expected, counted and the difference in words", () => {
    expect(valueOf(layout, "Opening float")).toBe("£100.00")
    expect(valueOf(layout, "Paid out")).toBe("-£15.00")
    expect(valueOf(layout, "Bank drops")).toBe("-£200.00")
    expect(valueOf(layout, "Expected in drawer")).toBe("£55.00")
    expect(valueOf(layout, "Counted")).toBe("£57.40")
    const differences = textOps(layout).filter((op) => op.text === "£2.40 over")
    expect(differences).toHaveLength(1)
  })

  it("leaves out the cash lines that are nothing", () => {
    expect(has(layout, "Cash refunds")).toBe(false)
    expect(has(layout, "Paid in")).toBe(false)
    expect(has(layout, "Adjustments")).toBe(false)
  })

  it("compares the till's card total with the Tide figure, in words", () => {
    expect(valueOf(layout, "Card payments in the till")).toBe("£374.00")
    expect(valueOf(layout, "Tide total")).toBe("£372.90")
    expect(has(layout, "£1.10 short")).toBe(true)
  })

  it("counts the voids, no sales, overrides and discounts", () => {
    expect(valueOf(layout, "Voids")).toBe("2, £18.00")
    expect(valueOf(layout, "No sales")).toBe("3")
    expect(valueOf(layout, "Manager overrides")).toBe("1")
    expect(valueOf(layout, "Discounts given")).toBe("4, £12.50")
  })

  it("covers trade-ins, then sales by category and by staff", () => {
    expect(valueOf(layout, "Trade-ins")).toBe("3")
    expect(valueOf(layout, "Paid out in cash")).toBe("£40.00")
    expect(valueOf(layout, "Store credit issued")).toBe("£25.00")
    expect(valueOf(layout, "Singles")).toBe("£312.00")
    expect(has(layout, "9 sales")).toBe(true)
    expect(has(layout, "1 sale")).toBe(true)
    expect(valueOf(layout, "Sam Bell")).toBe("£362.00")
    expect(has(layout, "BY CATEGORY")).toBe(true)
    expect(has(layout, "BY STAFF")).toBe(true)
  })

  it("prints the notes and says when the report was saved", () => {
    expect(has(layout, "Card is £1.10 short")).toBe(true)
    expect(has(layout, "Z 14 saved 9 Oct 2026, 17:47")).toBe(true)
  })

  it("has no em-dash and keeps every operation on the paper", () => {
    expect(lines(layout).join("\n")).not.toContain(String.fromCharCode(0x2014))
    for (const op of layout.ops) {
      expect(op.x).toBeGreaterThanOrEqual(0)
      expect(op.x).toBeLessThanOrEqual(576)
      expect(op.y).toBeLessThan(layout.height)
    }
  })

  it("fits 58 mm paper", () => {
    const narrow = layoutTillReport(report, { width: 384, measure })
    expect(narrow.width).toBe(384)
    expect(find(narrow, "Z REPORT").x).toBe(192)
    expect(valueOf(narrow, "Net sales")).toBe("£584.00")
  })
})

describe("an X report", () => {
  const report = getTillReport("x_1")
  const layout = layoutTillReport(report, { width: 576, measure })

  it("is an X report with its own number", () => {
    expect(find(layout, "X REPORT")).toBeDefined()
    expect(find(layout, "No. 31")).toBeDefined()
  })

  it("has nothing counted, no Tide figure and no notes, because nothing has been closed", () => {
    expect(has(layout, "Counted")).toBe(false)
    expect(has(layout, "Tide total")).toBe(false)
    expect(has(layout, "NOTES")).toBe(false)
    expect(valueOf(layout, "Expected in drawer")).toBe("£55.00")
  })
})

describe("odd data", () => {
  const base = (): TillReport => getTillReport("z_1")

  it("says the Tide total was not entered when the shop does not ask for it", () => {
    const report = base()
    report.card.reported_total = null
    report.card.variance = null
    expect(valueOf(layoutTillReport(report, { width: 576, measure }), "Tide total")).toBe("Not entered")
  })

  it("says Exact for a drawer that balances", () => {
    const report = base()
    report.cash.counted = report.cash.expected
    report.cash.variance = 0
    expect(has(layoutTillReport(report, { width: 576, measure }), "Exact")).toBe(true)
  })

  it("works the difference out when the server leaves it null", () => {
    const report = base()
    report.cash.variance = null
    expect(has(layoutTillReport(report, { width: 576, measure }), "£2.40 over")).toBe(true)
  })

  it("shows an adjustment with its sign, and refunds and payouts as money out whichever way they were stored", () => {
    const report = base()
    report.cash.adjustments = -500
    report.cash.paid_out = -1500
    const out = layoutTillReport(report, { width: 576, measure })
    expect(valueOf(out, "Adjustments")).toBe("-£5.00")
    expect(valueOf(out, "Paid out")).toBe("-£15.00")
  })

  it("copes with a day with nothing in it", () => {
    const report = base()
    report.tenders = []
    report.by_category = []
    report.by_staff = []
    report.sales = { count: 0, gross: 0, discounts: 0, net: 0, average_basket: 0, vat: [] }
    report.refunds = { count: 0, total: 0 }
    const out = layoutTillReport(report, { width: 576, measure })
    expect(has(out, "No payments")).toBe(true)
    expect(has(out, "BY CATEGORY")).toBe(false)
    expect(valueOf(out, "Net sales")).toBe("£0.00")
  })
})
