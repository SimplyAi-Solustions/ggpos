import { describe, expect, it } from "vitest"

import {
  daysFromTo,
  dashboardHeadline,
  profitPct,
  summariseDashboard,
  type DashboardLine,
} from "../src/dashboard"

/**
 * The dashboard's adding up, against the same two hand-worked sales the
 * backend check rings up (pb/scripts/checks/36-reports-vat.sh).
 */

const BRANCH = { id: "b1", label: "Trading cards" }
const OTHER = { id: "", label: "(none)" }

function line(partial: Partial<DashboardLine> & Pick<DashboardLine, "gross">): DashboardLine {
  return {
    date: "2026-10-09",
    discount: 0,
    refunded: 0,
    vat: 0,
    cost: 0,
    qty: 1,
    branch: BRANCH,
    key: `item:${partial.title ?? "x"}`,
    title: "Item",
    sku: "",
    ...partial,
  }
}

/**
 * Sale 1: margin box 700.00 less 70.00 (its share of the ticket discount),
 * cost 400.00, VAT 38.33; deck 24.00 less 4.00 on the line and 2.00 of the
 * ticket's, VAT 3.00, cost 10.00; two drinks 21.00 less 2.10, VAT 0.90,
 * cost 10.00; a book 3.00 less 0.30, cost 1.00; a service 8.00 less 0.80.
 * Sale 2: two sleeves 24.00, one back (12.00), VAT 2.00 on the one kept,
 * cost 6.00; a card 50.00, all back.
 */
const LINES: DashboardLine[] = [
  line({ title: "Margin box", sku: "GG-1", gross: 70000, discount: 7000, vat: 3833, cost: 40000 }),
  line({ title: "Deck", gross: 2400, discount: 600, vat: 300, cost: 1000 }),
  line({ title: "Drinks", gross: 2100, discount: 210, vat: 90, cost: 1000, qty: 2 }),
  line({ title: "Book", gross: 300, discount: 30, cost: 100, branch: OTHER }),
  line({ title: "Service", key: "product:p1", gross: 800, discount: 80 }),
  line({ title: "Sleeves", gross: 2400, refunded: 1200, vat: 200, cost: 600, date: "2026-10-10" }),
  line({ title: "Card", gross: 5000, refunded: 5000, qty: 0, date: "2026-10-10" }),
]

const INPUT = {
  from: "2026-10-08",
  to: "2026-10-10",
  saleCount: 2,
  lines: LINES,
  payments: [
    { method: "card_tide", label: "Card", amount: 67680 },
    { method: "cash", label: "Cash", amount: 7400 },
    { method: "cash", label: "Cash", amount: -6200 },
    { method: "points", label: "Points", amount: 0 },
  ],
  buyIns: { spend: 3500, count: 1 },
  stock: { cost: 100000, retail: 180000, items: 42 },
}

describe("the dashboard", () => {
  it("adds up the headline figures by hand", () => {
    const board = summariseDashboard(INPUT)
    // Gross 830.00, discounts 79.20, refunds 62.00, net 688.80, VAT 44.23,
    // cost 427.00, profit 688.80 - 44.23 - 427.00 = 217.57, over 644.57 of
    // sales less VAT is 33.8 percent.
    expect(board.sales).toEqual({ gross: 83000, discounts: 7920, refunds: 6200, net: 68880, vat: 4423, count: 2, average: 34440 })
    expect(board.cost).toBe(42700)
    expect(board.profit).toBe(21757)
    expect(board.margin_pct).toBe(33.8)
    expect(board.buy_ins).toEqual({ spend: 3500, count: 1 })
    expect(board.stock).toEqual({ cost: 100000, retail: 180000, items: 42 })
  })

  it("draws a point for every day of the range, empty days at nothing", () => {
    const board = summariseDashboard(INPUT)
    expect(board.series).toEqual([
      { date: "2026-10-08", net: 0, cost: 0, profit: 0 },
      // 630.00 + 18.00 + 18.90 + 2.70 + 7.20 = 676.80; VAT 42.23; cost 421.00.
      { date: "2026-10-09", net: 67680, cost: 42100, profit: 67680 - 4223 - 42100 },
      { date: "2026-10-10", net: 1200, cost: 600, profit: 400 },
    ])
  })

  it("splits by top-level branch, largest first, each with its own margin", () => {
    const board = summariseDashboard(INPUT)
    expect(board.by_category).toEqual([
      // 688.80 - 2.70 = 686.10; VAT 44.23; cost 426.00; profit 215.87 over 641.87.
      { id: "b1", label: "Trading cards", net: 68610, cost: 42600, profit: 21587, margin_pct: 33.6 },
      { id: "", label: "(none)", net: 270, cost: 100, profit: 170, margin_pct: 63 },
    ])
  })

  it("lists the top items by net, leaving out a line that all went back", () => {
    const board = summariseDashboard(INPUT)
    expect(board.top_items[0]).toEqual({ title: "Margin box", sku: "GG-1", net: 63000, profit: 63000 - 3833 - 40000, count: 1 })
    // 630.00, 18.90, 18.00, 12.00, 7.20, 2.70; the card went back whole.
    expect(board.top_items.map((item) => item.title)).toEqual(["Margin box", "Drinks", "Deck", "Sleeves", "Service", "Book"])
  })

  it("nets each payment method and leaves out one that came to nothing", () => {
    const board = summariseDashboard(INPUT)
    expect(board.payments).toEqual([
      { method: "card_tide", label: "Card", net: 67680 },
      { method: "cash", label: "Cash", net: 1200 },
    ])
  })

  it("carries at most ten top items", () => {
    const many = Array.from({ length: 14 }, (_, index) => line({ title: `T${index}`, key: `item:${index}`, gross: 100 + index }))
    expect(summariseDashboard({ ...INPUT, lines: many }).top_items).toHaveLength(10)
  })

  it("gives the headline alone for a comparison period, and nothing on an empty range", () => {
    expect(dashboardHeadline({ ...INPUT, lines: [], saleCount: 0 })).toEqual({
      sales: { gross: 0, discounts: 0, refunds: 0, net: 0, vat: 0, count: 0, average: 0 },
      cost: 0,
      profit: 0,
      margin_pct: 0,
      buy_ins: { spend: 3500, count: 1 },
    })
  })

  it("works a margin to one place, half-up, and nothing over nothing", () => {
    expect(profitPct(21757, 64457)).toBe(33.8)
    expect(profitPct(1, 8)).toBe(12.5)
    expect(profitPct(-1, 8)).toBe(-12.5)
    expect(profitPct(5, 0)).toBe(0)
  })

  it("lists the days of a range, both ends included", () => {
    expect(daysFromTo("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"])
    expect(daysFromTo("2026-12-30", "2026-12-29")).toEqual([])
  })
})
