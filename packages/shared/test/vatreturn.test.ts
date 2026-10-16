import { describe, expect, it } from "vitest"

import {
  buildVatReturn,
  dayAfter,
  longDate,
  quarterLabel,
  quarterOf,
  quarterStagger,
  recentQuarters,
  shiftQuarter,
  vatQuarter,
  vatScopeNote,
  vatScopeStart,
  wholePounds,
  type VatReturnRow,
} from "../src/vatreturn"

/**
 * The VAT return: quarters in shop time from the quarter's first month, and
 * the nine boxes added up from one row per sale line and per refund. Every
 * figure below is worked by hand in the comment beside it.
 */

describe("quarters", () => {
  it("run January to March and so on with a January stagger", () => {
    expect(vatQuarter("2026-Q4", 1)).toEqual({ period: "2026-Q4", year: 2026, quarter: 4, from: "2026-10-01", to: "2026-12-31" })
    expect(vatQuarter("2026-Q1", 1)).toMatchObject({ from: "2026-01-01", to: "2026-03-31" })
    // Any month of the stagger names the same quarters.
    expect(vatQuarter("2026-Q2", 7)).toMatchObject({ from: "2026-04-01", to: "2026-06-30" })
  })

  it("cross the new year with a February or March stagger", () => {
    expect(vatQuarter("2026-Q4", 2)).toMatchObject({ from: "2026-11-01", to: "2027-01-31" })
    expect(vatQuarter("2026-Q1", 11)).toMatchObject({ from: "2026-02-01", to: "2026-04-30" })
    expect(vatQuarter("2026-Q4", 3)).toMatchObject({ from: "2026-12-01", to: "2027-02-28" })
    expect(vatQuarter("2028-Q4", 3)).toMatchObject({ to: "2029-02-28" })
    expect(quarterStagger(12)).toBe(3)
  })

  it("place a day in its quarter, the early months in last year's fourth", () => {
    expect(quarterOf("2026-10-09", 1).period).toBe("2026-Q4")
    expect(quarterOf("2027-01-15", 2).period).toBe("2026-Q4")
    expect(quarterOf("2026-02-10", 3).period).toBe("2025-Q4")
    expect(quarterOf("2026-03-01", 3).period).toBe("2026-Q1")
  })

  it("step forward and back, and list the recent ones newest first", () => {
    const q4 = vatQuarter("2026-Q4", 1)!
    expect(shiftQuarter(q4, 1, 1).period).toBe("2027-Q1")
    expect(shiftQuarter(q4, -4, 1).period).toBe("2025-Q4")
    expect(recentQuarters("2026-10-09", 1, 3).map((q) => q.period)).toEqual(["2026-Q4", "2026-Q3", "2026-Q2"])
  })

  it("refuse anything that is not a quarter", () => {
    expect(vatQuarter("2026-Q5", 1)).toBeNull()
    expect(vatQuarter("2026-13", 1)).toBeNull()
    expect(vatQuarter("", 1)).toBeNull()
  })

  it("are written as dates in words", () => {
    expect(longDate("2026-11-01")).toBe("1 November 2026")
    expect(quarterLabel(vatQuarter("2026-Q4", 1)!)).toBe("1 October to 31 December 2026")
    expect(quarterLabel(vatQuarter("2026-Q4", 2)!)).toBe("1 November 2026 to 31 January 2027")
    expect(dayAfter("2026-12-31")).toBe("2027-01-01")
  })
})

describe("the part of a quarter inside the registration", () => {
  const q4 = vatQuarter("2026-Q4", 1)!

  it("is all of it from a date before the quarter, or with no date", () => {
    expect(vatScopeStart(q4, { registered: true, from: "2026-01-01" })).toBe("2026-10-01")
    expect(vatScopeStart(q4, { registered: true, from: "" })).toBe("2026-10-01")
    expect(vatScopeNote(q4, { registered: true, from: "2026-10-01" })).toBe("")
  })

  it("starts on the registration date inside the quarter", () => {
    expect(vatScopeStart(q4, { registered: true, from: "2026-11-15 00:00:00.000Z" })).toBe("2026-11-15")
    expect(vatScopeNote(q4, { registered: true, from: "2026-11-15" })).toBe(
      "The shop is VAT registered from 15 November 2026. Sales before then are not in this return."
    )
  })

  it("is none of it before registration, or with VAT off", () => {
    expect(vatScopeStart(q4, { registered: true, from: "2027-01-01" })).toBeNull()
    expect(vatScopeNote(q4, { registered: true, from: "2027-01-01" })).toBe(
      "The shop is VAT registered from 1 January 2027, after this quarter, so every box is 0."
    )
    expect(vatScopeStart(q4, { registered: false, from: "2026-01-01" })).toBeNull()
    expect(vatScopeNote(q4, { registered: false, from: "" })).toBe("The shop is not VAT registered, so every box is 0.")
  })
})

/** A row with the fields the sums do not read filled in. */
function row(partial: Partial<VatReturnRow> & Pick<VatReturnRow, "scheme" | "gross" | "vat">): VatReturnRow {
  return {
    kind: "sale",
    ref: "GG-S-000001",
    sale: "sale1",
    date: "2026-10-09",
    title: "Item",
    sku: "",
    rate: 0,
    cost: 0,
    ...partial,
  }
}

/**
 * Two sales and a refund, hand-worked. Sale 1 after its 10 percent ticket
 * discount: a margin box at 630.00 that cost 400.00 (230.00 margin, 38.33
 * VAT), a standard deck at 18.00 (3.00 VAT), two branch drinks at 18.90
 * reduced (0.90 VAT), a zero-rated book at 2.70 and an exempt service at
 * 7.20. Sale 2: two sleeves at 24.00 (4.00 VAT) and a margin card at 50.00
 * that cost 45.00 (0.83 VAT). The refund: one sleeve (12.00, 2.00 VAT) and
 * the card (50.00, 45.00 cost, 0.83 VAT).
 */
const ROWS: VatReturnRow[] = [
  row({ scheme: "margin", gross: 63000, vat: 3833, cost: 40000 }),
  row({ scheme: "standard", rate: 20, gross: 1800, vat: 300, cost: 1000 }),
  row({ scheme: "standard", rate: 5, gross: 1890, vat: 90, cost: 1000 }),
  row({ scheme: "zero", gross: 270, vat: 0, cost: 100 }),
  row({ scheme: "exempt", gross: 720, vat: 0 }),
  row({ sale: "sale2", ref: "GG-S-000002", scheme: "standard", rate: 20, gross: 2400, vat: 400, cost: 1200 }),
  row({ sale: "sale2", ref: "GG-S-000002", scheme: "margin", gross: 5000, vat: 83, cost: 4500 }),
  row({ kind: "refund", sale: "sale2", ref: "GG-S-000002-R1", scheme: "standard", rate: 20, gross: -1200, vat: -200, cost: -600 }),
  row({ kind: "refund", sale: "sale2", ref: "GG-S-000002-R1", scheme: "margin", gross: -5000, vat: -83, cost: -4500 }),
]

describe("the return", () => {
  const q4 = vatQuarter("2026-Q4", 1)!
  const registered = { registered: true, from: "2026-10-01" }
  const none = { vat: 0, net: 0, updated: "", by: "" }

  it("adds up the nine boxes by hand", () => {
    const vat = buildVatReturn({ quarter: q4, registration: registered, standardRate: 20, rows: ROWS, purchases: none })
    // Box 1: 38.33 + 3.00 + 0.90 + 4.00 + 0.83 - 2.00 - 0.83 = 44.23.
    // Sales excluding VAT: 688.80 kept less 44.23 = 644.57; box 6 drops the
    // pence: 644.00.
    expect(vat.boxes).toEqual({ box1: 4423, box2: 0, box3: 4423, box4: 0, box5: 4423, box6: 64400, box7: 0, box8: 0, box9: 0 })
    expect(vat.sales_ex_vat).toBe(64457)
    expect(vat.box5_reclaim).toBe(false)
    expect(vat.registered).toBe(true)
    expect(vat.note).toBe("")
  })

  it("splits the sales by rate, standard first and the margin scheme last", () => {
    const vat = buildVatReturn({ quarter: q4, registration: registered, standardRate: 20, rows: ROWS, purchases: none })
    expect(vat.by_rate.map((r) => [r.label, r.gross, r.net, r.vat, r.count])).toEqual([
      // 18.00 + 24.00 - 12.00 = 30.00, VAT 5.00, two sales.
      ["Standard 20%", 3000, 2500, 500, 2],
      ["Reduced 5%", 1890, 1800, 90, 1],
      ["Zero 0%", 270, 270, 0, 1],
      ["Exempt", 720, 720, 0, 1],
      // 630.00 + 50.00 - 50.00 = 630.00, VAT 38.33.
      ["Margin scheme, 20% of the margin", 63000, 59167, 3833, 2],
    ])
  })

  it("shows the margin scheme working: sales, cost, margin and its VAT", () => {
    const vat = buildVatReturn({ quarter: q4, registration: registered, standardRate: 20, rows: ROWS, purchases: none })
    expect(vat.margin).toEqual({ sales: 63000, cost: 40000, margin: 23000, vat: 3833, count: 2 })
  })

  it("keeps every row for the drill-down, with its treatment and group, and a cost only on margin rows", () => {
    const vat = buildVatReturn({ quarter: q4, registration: registered, standardRate: 20, rows: ROWS, purchases: none })
    expect(vat.rows).toHaveLength(9)
    expect(vat.rows.map((r) => r.treatment)).toEqual([
      "margin",
      "standard",
      "reduced",
      "zero",
      "exempt",
      "standard",
      "margin",
      "standard",
      "margin",
    ])
    expect(vat.rows[2]).toMatchObject({ group: "reduced:5", net: 1800, cost: 0 })
    expect(vat.rows[0]).toMatchObject({ group: "margin", rate: 20, net: 59167, cost: 40000 })
    expect(vat.rows[7]).toMatchObject({ kind: "refund", ref: "GG-S-000002-R1", net: -1000, cost: 0 })
  })

  it("takes boxes 4 and 7 from the purchases, box 7 in whole pounds, box 5 either way", () => {
    const purchases = { vat: 12345, net: 98765, updated: "2026-12-31T10:00:00.000Z", by: "Richard" }
    const owed = buildVatReturn({ quarter: q4, registration: registered, standardRate: 20, rows: ROWS, purchases })
    // 123.45 reclaimed: 44.23 - 123.45 is 79.22 back from HMRC.
    expect(owed.boxes).toMatchObject({ box3: 4423, box4: 12345, box5: 7922, box7: 98700 })
    expect(owed.box5_reclaim).toBe(true)
    expect(owed.purchases).toEqual(purchases)
  })

  it("answers every box 0 with the note for a quarter before registration", () => {
    const before = buildVatReturn({
      quarter: vatQuarter("2026-Q3", 1)!,
      registration: registered,
      standardRate: 20,
      rows: ROWS,
      purchases: { vat: 100, net: 100, updated: "", by: "" },
    })
    expect(before.registered).toBe(false)
    expect(Object.values(before.boxes).every((value) => value === 0)).toBe(true)
    expect(before.rows).toEqual([])
    expect(before.by_rate).toEqual([])
    expect(before.note).toBe("The shop is VAT registered from 1 October 2026, after this quarter, so every box is 0.")
  })

  it("labels a standard line sold in the quarter with no VAT charged on its own", () => {
    const vat = buildVatReturn({
      quarter: q4,
      registration: registered,
      standardRate: 20,
      rows: [row({ scheme: "standard", rate: 0, gross: 1200, vat: 0 })],
      purchases: none,
    })
    expect(vat.by_rate.map((r) => r.label)).toEqual(["Standard, no VAT charged"])
  })

  it("drops the pence from box 6 rather than rounding them", () => {
    expect(wholePounds(64457)).toBe(64400)
    expect(wholePounds(99)).toBe(0)
    expect(wholePounds(-150)).toBe(-100)
  })
})
