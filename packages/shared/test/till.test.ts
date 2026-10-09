import { describe, expect, it } from "vitest"

import {
  buildTillReport,
  cardTillTotal,
  cardVariance,
  cashBreakdown,
  cashVariance,
  categoryForKind,
  countedAfterDrop,
  denominationTotal,
  expectedCash,
  hasCounts,
  isTillMovementType,
  parkedTicketsMessage,
  parseDenominationCounts,
  signedMovementAmount,
  summariseRefunds,
  summariseTenders,
  takesDrawerBelowZero,
  type DrawerMovement,
  type TillReportInput,
  type TillReportSale,
  type TillReportSaleLine,
  type TillReportTenderRow,
} from "../src/till"

/**
 * The server saves its X and Z reports from buildTillReport and the counter
 * previews one from it, so these pin every figure on the report to the
 * records it is built from: the movements add back up to the expected
 * drawer, the tenders split taken from refunded, a refund of an earlier
 * session's sale comes off this session's net, and the Z's variances are
 * counted minus expected and Tide minus till.
 */

const REGISTER = { id: "reg1", name: "Counter" }
const SAM = { id: "staff_sam", name: "Sam Bell" }
const MO = { id: "staff_mo", name: "Mo Khan" }

function line(over: Partial<TillReportSaleLine> = {}): TillReportSaleLine {
  return {
    qty: 1,
    unit_price: 1000,
    discount: 0,
    vat_rate: 0,
    vat_amount: 0,
    tax_scheme: "margin",
    category: "Singles",
    ...over,
  }
}

function sale(over: Partial<TillReportSale> = {}): TillReportSale {
  return {
    id: "sale1",
    occurred_at: "2026-10-09T10:00:00.000Z",
    staff: SAM,
    discount: 0,
    lines: [line()],
    ...over,
  }
}

function tender(method: TillReportTenderRow["method"], amount: number, refund_ref = ""): TillReportTenderRow {
  return { method, amount, refund_ref }
}

function input(over: Partial<TillReportInput> = {}): TillReportInput {
  return {
    type: "x",
    number: 0,
    register: REGISTER,
    session: { id: "sess1", float: 10000, opened_at: "2026-10-09 09:00:00.000Z" },
    created: "2026-10-09T17:30:00.000Z",
    created_by: SAM,
    vat_registered: false,
    sales: [],
    tenders: [],
    movements: [],
    trade_ins: [],
    events: [],
    ...over,
  }
}

describe("denomination counts", () => {
  it("totals notes and coins in pence", () => {
    expect(denominationTotal({ "5000": 1, "2000": 2, "500": 3, "100": 4, "50": 1, "2": 3, "1": 1 })).toBe(
      5000 + 4000 + 1500 + 400 + 50 + 6 + 1
    )
  })

  it("totals nothing for no count", () => {
    expect(denominationTotal(null)).toBe(0)
    expect(denominationTotal(undefined)).toBe(0)
    expect(denominationTotal({})).toBe(0)
  })

  it("ignores keys that are not a note or coin", () => {
    expect(denominationTotal({ "1000": 1, ...({ "300": 5 } as object) })).toBe(1000)
  })

  it("accepts a whole count, zeros kept, as a copy rather than the object it was given", () => {
    const raw = { "1": 3, "5000": 0, "2000": 2 }
    const result = parseDenominationCounts(raw)
    expect(result).toEqual({ ok: true, counts: { "5000": 0, "2000": 2, "1": 3 } })
    if (result.ok) expect(result.counts).not.toBe(raw)
  })

  it("ignores what an object inherits, reading its own keys only", () => {
    const inherited = Object.create({ "5000": 3 }) as Record<string, unknown>
    inherited["1000"] = 1
    expect(parseDenominationCounts(inherited)).toEqual({ ok: true, counts: { "1000": 1 } })
  })

  it("refuses something that is not a count", () => {
    for (const value of [null, undefined, 12, "5000", [1, 2]]) {
      expect(parseDenominationCounts(value)).toEqual({
        ok: false,
        message: "Count the drawer note by note and coin by coin.",
      })
    }
  })

  it("refuses a note or coin that is not UK money", () => {
    expect(parseDenominationCounts({ "300": 1 })).toEqual({
      ok: false,
      message: "The count has a note or coin that is not UK money. Count the drawer again.",
    })
  })

  it("refuses a negative, fractional, text or absurd count", () => {
    for (const n of [-1, 1.5, "2", Number.NaN, 100001]) {
      expect(parseDenominationCounts({ "1000": n })).toEqual({
        ok: false,
        message: "Count each note and coin as a whole number, 0 or more.",
      })
    }
  })

  it("only treats an object naming a note or coin as a count", () => {
    expect(hasCounts({ "5000": 0 })).toBe(true)
    expect(hasCounts({})).toBe(false)
    expect(hasCounts(null)).toBe(false)
    expect(hasCounts([])).toBe(false)
    expect(hasCounts("1000")).toBe(false)
  })
})

describe("the drawer", () => {
  const movements: DrawerMovement[] = [
    { type: "cash_sale", amount: 1500 },
    { type: "cash_sale", amount: 700 },
    { type: "refund", amount: -400 },
    { type: "paid_in", amount: 2000 },
    { type: "float_in", amount: 500 },
    { type: "paid_out", amount: -350 },
    { type: "payout", amount: -1200 },
    { type: "bank_drop", amount: -5000 },
    { type: "adjustment", amount: 25 },
    { type: "adjustment", amount: -10 },
  ]

  it("groups the movements by type, money out shown as positive figures", () => {
    expect(cashBreakdown(10000, movements)).toEqual({
      opening_float: 10000,
      cash_sales: 2200,
      cash_refunds: 400,
      paid_in: 2500,
      paid_out: 350,
      buy_in_payouts: 1200,
      bank_drops: 5000,
      adjustments: 15,
      expected: 10000 + 2200 - 400 + 2500 - 350 - 1200 - 5000 + 15,
    })
  })

  it("expects the float plus every signed movement, as lib/vaultutil.js sessionExpected does", () => {
    const sum = movements.reduce((total, m) => total + m.amount, 10000)
    expect(expectedCash(10000, movements)).toBe(sum)
  })

  it("counts a movement type it does not name as an adjustment, so the groups still add up", () => {
    const odd = [{ type: "drawer_open", amount: 0 }, { type: "mystery", amount: -75 }]
    const result = cashBreakdown(1000, odd)
    expect(result.adjustments).toBe(-75)
    expect(result.expected).toBe(925)
  })

  it("expects the float alone with no movements", () => {
    expect(cashBreakdown(0, []).expected).toBe(0)
    expect(expectedCash(12345, [])).toBe(12345)
  })

  it("stores paid in positive, paid out and bank drops negative, and adjustments as given", () => {
    expect(signedMovementAmount("paid_in", 500)).toBe(500)
    expect(signedMovementAmount("paid_out", 500)).toBe(-500)
    expect(signedMovementAmount("bank_drop", 500)).toBe(-500)
    expect(signedMovementAmount("paid_out", -500)).toBe(-500)
    expect(signedMovementAmount("adjustment", -250)).toBe(-250)
    expect(signedMovementAmount("adjustment", 250)).toBe(250)
  })

  it("knows the four till movement types", () => {
    expect(isTillMovementType("paid_in")).toBe(true)
    expect(isTillMovementType("adjustment")).toBe(true)
    expect(isTillMovementType("cash_sale")).toBe(false)
    expect(isTillMovementType(undefined)).toBe(false)
  })

  it("refuses money out that would leave the drawer below nothing, and nothing else", () => {
    expect(takesDrawerBelowZero(8240, -8240)).toBe(false)
    expect(takesDrawerBelowZero(8240, -8241)).toBe(true)
    expect(takesDrawerBelowZero(-100, 50)).toBe(false)
    expect(takesDrawerBelowZero(0, 0)).toBe(false)
  })

  it("reports variances as counted minus expected and Tide minus till", () => {
    expect(cashVariance(9950, 10000)).toBe(-50)
    expect(cashVariance(10020, 10000)).toBe(20)
    expect(cardVariance(4500, 4600)).toBe(-100)
    expect(cardVariance(null, 4600)).toBeNull()
  })
})

describe("tenders and refunds", () => {
  const rows: TillReportTenderRow[] = [
    tender("cash", 1500),
    tender("card_tide", 2400),
    tender("card_tide", 600),
    tender("store_credit", 500),
    tender("cash", -300, "GG-S-000001-R1"),
    tender("card_tide", -600, "GG-S-000002-R1"),
    tender("store_credit", -200, "GG-S-000002-R1"),
    tender("sumup_card", 900),
  ]

  it("splits taken from refunded per method, counting the sale rows, in the till's tender order", () => {
    expect(summariseTenders(rows)).toEqual([
      { method: "cash", label: "Cash", taken: 1500, refunded: 300, net: 1200, count: 1 },
      { method: "card_tide", label: "Card", taken: 3000, refunded: 600, net: 2400, count: 2 },
      { method: "store_credit", label: "Store credit", taken: 500, refunded: 200, net: 300, count: 1 },
      { method: "sumup_card", label: "Card (SumUp)", taken: 900, refunded: 0, net: 900, count: 1 },
    ])
  })

  it("counts card taken on the Tide reader and other cards, not SumUp or anything else", () => {
    expect(cardTillTotal(summariseTenders(rows))).toBe(2400)
    expect(cardTillTotal(summariseTenders([tender("card_other", 1000), tender("card_tide", 250)]))).toBe(1250)
    expect(cardTillTotal([])).toBe(0)
  })

  it("counts one refund per reference, however many tenders it was given back on", () => {
    expect(summariseRefunds(rows)).toEqual({ count: 2, total: 1100 })
  })

  it("counts a negative row with no reference as a refund of its own", () => {
    expect(summariseRefunds([tender("cash", -100), tender("cash", -50)])).toEqual({ count: 2, total: 150 })
    expect(summariseRefunds([])).toEqual({ count: 0, total: 0 })
  })
})

describe("labels and sentences", () => {
  it("names a stock line's category from its kind", () => {
    expect(categoryForKind("single")).toBe("Singles")
    expect(categoryForKind("graded")).toBe("Graded")
    expect(categoryForKind("retro")).toBe("Retro")
    expect(categoryForKind("sealed")).toBe("Sealed")
    expect(categoryForKind("accessory")).toBe("Accessories")
    expect(categoryForKind("other")).toBe("Other")
    expect(categoryForKind("")).toBe("Other")
    expect(categoryForKind(null)).toBe("Other")
    expect(categoryForKind("constructor")).toBe("Other")
  })

  it("says how many tickets are parked, as the contract words it", () => {
    expect(parkedTicketsMessage(2, "Counter")).toBe(
      "Two tickets are parked on Counter. Complete or delete them before closing the till."
    )
    expect(parkedTicketsMessage(1, "Counter")).toBe(
      "One ticket is parked on Counter. Complete or delete it before closing the till."
    )
    expect(parkedTicketsMessage(10, "Back till")).toBe(
      "Ten tickets are parked on Back till. Complete or delete them before closing the till."
    )
    expect(parkedTicketsMessage(12, "Counter")).toBe(
      "12 tickets are parked on Counter. Complete or delete them before closing the till."
    )
  })
})

describe("the report", () => {
  it("is all zeros for a session with nothing in it, the float expected", () => {
    const report = buildTillReport(input())
    expect(report.sales).toEqual({ count: 0, gross: 0, discounts: 0, net: 0, average_basket: 0, vat: [] })
    expect(report.refunds).toEqual({ count: 0, total: 0 })
    expect(report.tenders).toEqual([])
    expect(report.cash.expected).toBe(10000)
    expect(report.cash.counted).toBeNull()
    expect(report.cash.variance).toBeNull()
    expect(report.card).toEqual({ till_total: 0, reported_total: null, variance: null })
    expect(report.by_category).toEqual([])
    expect(report.by_staff).toEqual([])
    expect(report.first_sale_at).toBeNull()
    expect(report.last_sale_at).toBeNull()
    expect(report.counts).toBeNull()
    expect(report.notes).toBe("")
  })

  it("carries who, where and when, with PocketBase dates made ISO", () => {
    const report = buildTillReport(input({ id: "rep1", number: 7 }))
    expect(report.id).toBe("rep1")
    expect(report.type).toBe("x")
    expect(report.number).toBe(7)
    expect(report.register).toEqual(REGISTER)
    expect(report.session_id).toBe("sess1")
    expect(report.period_start).toBe("2026-10-09T09:00:00.000Z")
    expect(report.period_end).toBe("2026-10-09T17:30:00.000Z")
    expect(report.created).toBe("2026-10-09T17:30:00.000Z")
    expect(report.created_by).toEqual(SAM)
  })

  it("numbers the running report 0 with no id", () => {
    const report = buildTillReport(input())
    expect(report.number).toBe(0)
    expect(report.id).toBe("")
  })

  it("adds up gross before discounts, the line and ticket discounts, and the net", () => {
    const report = buildTillReport(
      input({
        sales: [
          sale({
            id: "a",
            discount: 300,
            lines: [line({ qty: 2, unit_price: 1000, discount: 200 }), line({ unit_price: 500 })],
          }),
          sale({ id: "b", lines: [line({ unit_price: 1250 })] }),
        ],
      })
    )
    // a: gross 2500, discounts 200 + 300, total 2000. b: 1250.
    expect(report.sales.count).toBe(2)
    expect(report.sales.gross).toBe(3750)
    expect(report.sales.discounts).toBe(500)
    expect(report.sales.net).toBe(3250)
    expect(report.discounts).toEqual({ count: 1, total: 500 })
  })

  it("averages the basket half-up", () => {
    const report = buildTillReport(
      input({
        sales: [
          sale({ id: "a", lines: [line({ unit_price: 1000 })] }),
          sale({ id: "b", lines: [line({ unit_price: 1000 })] }),
          sale({ id: "c", lines: [line({ unit_price: 1001 })] }),
          sale({ id: "d", lines: [line({ unit_price: 1001 })] }),
        ],
      })
    )
    // 4002 / 4 = 1000.5, half-up 1001.
    expect(report.sales.average_basket).toBe(1001)
  })

  it("takes a refund given in this session off its net, even for a sale from an earlier session", () => {
    // Today: one £20 cash sale. A customer brings back yesterday's £8 sale
    // and gets cash; the sale is not in this session, only its refund rows.
    const report = buildTillReport(
      input({
        sales: [sale({ lines: [line({ unit_price: 2000 })] })],
        tenders: [tender("cash", 2000), tender("cash", -800, "GG-S-000040-R1")],
        movements: [
          { type: "cash_sale", amount: 2000 },
          { type: "refund", amount: -800 },
        ],
      })
    )
    expect(report.sales.count).toBe(1)
    expect(report.sales.gross).toBe(2000)
    expect(report.refunds).toEqual({ count: 1, total: 800 })
    expect(report.sales.net).toBe(1200)
    expect(report.sales.average_basket).toBe(1200)
    expect(report.tenders).toEqual([
      { method: "cash", label: "Cash", taken: 2000, refunded: 800, net: 1200, count: 1 },
    ])
    expect(report.cash.cash_sales).toBe(2000)
    expect(report.cash.cash_refunds).toBe(800)
    expect(report.cash.expected).toBe(10000 + 2000 - 800)
    // What was sold is reported before refunds: the refund's lines may belong elsewhere.
    expect(report.by_category).toEqual([{ category: "Singles", net: 2000, count: 1 }])
  })

  it("reports a refund-only session with a negative net", () => {
    const report = buildTillReport(input({ tenders: [tender("card_tide", -1500, "GG-S-000012-R1")] }))
    expect(report.sales.count).toBe(0)
    expect(report.sales.net).toBe(-1500)
    expect(report.sales.average_basket).toBe(0)
    expect(report.card.till_total).toBe(-1500)
  })

  it("splits a split tender by method and counts the sale once in the sales", () => {
    const report = buildTillReport(
      input({
        sales: [sale({ lines: [line({ unit_price: 5000 })] })],
        tenders: [tender("card_tide", 3000), tender("cash", 1500), tender("store_credit", 500)],
        movements: [{ type: "cash_sale", amount: 1500 }],
      })
    )
    expect(report.sales.count).toBe(1)
    expect(report.sales.net).toBe(5000)
    expect(report.tenders.map((t) => [t.method, t.net, t.count])).toEqual([
      ["cash", 1500, 1],
      ["card_tide", 3000, 1],
      ["store_credit", 500, 1],
    ])
    expect(report.card.till_total).toBe(3000)
    expect(report.cash.expected).toBe(11500)
  })

  it("expects only the cash kept, not what was handed over, when change is given", () => {
    // £12.40 paid with a £20 note: the tender and the movement are both 1240.
    const report = buildTillReport(
      input({
        sales: [sale({ lines: [line({ unit_price: 1240 })] })],
        tenders: [tender("cash", 1240)],
        movements: [{ type: "cash_sale", amount: 1240 }],
      })
    )
    expect(report.tenders[0]).toMatchObject({ taken: 1240, net: 1240 })
    expect(report.cash.cash_sales).toBe(1240)
    expect(report.cash.expected).toBe(11240)
  })

  it("puts paid in, paid out, buy-in payouts, bank drops and adjustments in the drawer", () => {
    const report = buildTillReport(
      input({
        movements: [
          { type: "paid_in", amount: 1000 },
          { type: "paid_out", amount: -450 },
          { type: "payout", amount: -2000 },
          { type: "bank_drop", amount: -5000 },
          { type: "adjustment", amount: -30 },
        ],
        trade_ins: [
          { payout_cash: 2000, payout_credit: 0 },
          { payout_cash: 0, payout_credit: 1800 },
        ],
      })
    )
    expect(report.cash).toEqual({
      opening_float: 10000,
      cash_sales: 0,
      cash_refunds: 0,
      paid_in: 1000,
      paid_out: 450,
      buy_in_payouts: 2000,
      bank_drops: 5000,
      adjustments: -30,
      expected: 3520,
      counted: null,
      variance: null,
    })
    expect(report.trade_ins).toEqual({ count: 2, cash_paid: 2000, credit_issued: 1800, part_exchange_value: 0 })
  })

  it("counts voids with the value removed, no sales and overrides from the till events", () => {
    const report = buildTillReport(
      input({
        events: [
          { kind: "void_line", amount: 450 },
          { kind: "void_line", amount: 1200 },
          { kind: "void_ticket", amount: 3000 },
          { kind: "no_sale", amount: 0 },
          { kind: "no_sale", amount: 0 },
          { kind: "override", amount: 500 },
          { kind: "reprint", amount: 0 },
        ],
      })
    )
    expect(report.voids).toEqual({ count: 3, total: 4650 })
    expect(report.no_sales).toEqual({ count: 2 })
    expect(report.overrides).toEqual({ count: 1 })
  })

  it("spreads a ticket discount across the categories, largest first, units counted", () => {
    const report = buildTillReport(
      input({
        sales: [
          sale({
            discount: 100,
            lines: [
              line({ unit_price: 300, qty: 2, category: "Singles" }),
              line({ unit_price: 400, category: "Sealed" }),
            ],
          }),
          sale({ id: "s2", lines: [line({ unit_price: 2500, category: "Services" })] }),
        ],
      })
    )
    // 600 and 400 share 100 off pro rata: 60 and 40.
    expect(report.by_category).toEqual([
      { category: "Services", net: 2500, count: 1 },
      { category: "Singles", net: 540, count: 2 },
      { category: "Sealed", net: 360, count: 1 },
    ])
    const sum = report.by_category.reduce((total, c) => total + c.net, 0)
    expect(sum).toBe(report.sales.gross - report.sales.discounts)
  })

  it("adds up each member of staff's sales, largest first", () => {
    const report = buildTillReport(
      input({
        sales: [
          sale({ id: "a", staff: SAM, lines: [line({ unit_price: 500 })] }),
          sale({ id: "b", staff: MO, lines: [line({ unit_price: 2000 })] }),
          sale({ id: "c", staff: SAM, discount: 100, lines: [line({ unit_price: 700 })] }),
        ],
      })
    )
    expect(report.by_staff).toEqual([
      { staff_id: "staff_mo", name: "Mo Khan", net: 2000, count: 1 },
      { staff_id: "staff_sam", name: "Sam Bell", net: 1100, count: 2 },
    ])
  })

  it("orders equal figures by name so the report reads the same every time", () => {
    const report = buildTillReport(
      input({
        sales: [
          sale({ id: "a", staff: SAM, lines: [line({ category: "Retro" })] }),
          sale({ id: "b", staff: MO, lines: [line({ category: "Graded" })] }),
        ],
      })
    )
    expect(report.by_category.map((c) => c.category)).toEqual(["Graded", "Retro"])
    expect(report.by_staff.map((s) => s.name)).toEqual(["Mo Khan", "Sam Bell"])
  })

  it("groups VAT by rate from standard-rated lines only, when VAT registered", () => {
    const sales = [
      sale({
        lines: [
          line({ unit_price: 1200, tax_scheme: "standard", vat_rate: 20, vat_amount: 200 }),
          line({ unit_price: 600, tax_scheme: "standard", vat_rate: 20, vat_amount: 100 }),
          line({ unit_price: 1050, tax_scheme: "standard", vat_rate: 5, vat_amount: 50 }),
          line({ unit_price: 5000, tax_scheme: "margin", vat_rate: 0, vat_amount: 0 }),
          line({ unit_price: 2000, tax_scheme: "exempt", vat_rate: 0, vat_amount: 0 }),
        ],
      }),
    ]
    const report = buildTillReport(input({ vat_registered: true, sales }))
    expect(report.sales.vat).toEqual([
      { rate: 20, net: 1500, vat: 300, gross: 1800 },
      { rate: 5, net: 1000, vat: 50, gross: 1050 },
    ])
    expect(buildTillReport(input({ vat_registered: false, sales })).sales.vat).toEqual([])
  })

  it("takes a VAT line's gross after its share of a ticket discount", () => {
    const report = buildTillReport(
      input({
        vat_registered: true,
        sales: [
          sale({
            discount: 200,
            lines: [
              line({ unit_price: 1200, tax_scheme: "standard", vat_rate: 20, vat_amount: 167 }),
              line({ unit_price: 1200, tax_scheme: "margin" }),
            ],
          }),
        ],
      })
    )
    expect(report.sales.vat).toEqual([{ rate: 20, net: 933, vat: 167, gross: 1100 }])
  })

  it("marks the first and last sale, whatever order they arrive in", () => {
    const report = buildTillReport(
      input({
        sales: [
          sale({ id: "b", occurred_at: "2026-10-09 15:20:00.000Z" }),
          sale({ id: "a", occurred_at: "2026-10-09T09:05:00.000Z" }),
          sale({ id: "c", occurred_at: "2026-10-09 12:00:00.000Z" }),
        ],
      })
    )
    expect(report.first_sale_at).toBe("2026-10-09T09:05:00.000Z")
    expect(report.last_sale_at).toBe("2026-10-09T15:20:00.000Z")
  })

  it("leaves the count, the variances and the notes off an X even when close figures are passed", () => {
    const report = buildTillReport(
      input({ type: "x", close: { counts: { "1000": 3 }, card_reported_total: 500, notes: "Late." } })
    )
    expect(report.cash.counted).toBeNull()
    expect(report.cash.variance).toBeNull()
    expect(report.card.reported_total).toBeNull()
    expect(report.card.variance).toBeNull()
    expect(report.counts).toBeNull()
    expect(report.notes).toBe("")
  })

  it("closes a Z with counted minus expected and Tide minus till", () => {
    const report = buildTillReport(
      input({
        type: "z",
        number: 3,
        sales: [
          sale({ id: "a", lines: [line({ unit_price: 2600 })] }),
          sale({ id: "b", lines: [line({ unit_price: 4000 })] }),
        ],
        tenders: [tender("cash", 2600), tender("card_tide", 4000)],
        movements: [{ type: "cash_sale", amount: 2600 }],
        close: {
          counts: { "2000": 2, "1000": 1, "500": 1, "100": 1, "50": 1 },
          card_reported_total: 3990,
          notes: "Counted twice.",
        },
      })
    )
    // Expected 10000 + 2600 = 12600; counted 4000 + 1000 + 500 + 100 + 50 = 5650.
    expect(report.cash.expected).toBe(12600)
    expect(report.cash.counted).toBe(5650)
    expect(report.cash.variance).toBe(-6950)
    expect(report.card).toEqual({ till_total: 4000, reported_total: 3990, variance: -10 })
    expect(report.counts).toEqual({ "2000": 2, "1000": 1, "500": 1, "100": 1, "50": 1 })
    expect(report.notes).toBe("Counted twice.")
    expect(report.type).toBe("z")
    expect(report.number).toBe(3)
  })

  it("takes a Z's bank drop out of the full count, leaving the variance as it was before the drop", () => {
    // The whole drawer is counted first: £126.20 against £126.00 expected,
    // 20p over. Then £50.00 is banked from it. The server has written that
    // drop as a movement, so expected is £76.00 and £76.20 is left: 20p over.
    const full = { "5000": 2, "1000": 2, "500": 1, "100": 1, "20": 1 }
    const before = buildTillReport(
      input({
        type: "z",
        movements: [{ type: "cash_sale", amount: 2600 }],
        close: { counts: full, card_reported_total: null, notes: "" },
      })
    )
    const after = buildTillReport(
      input({
        type: "z",
        movements: [
          { type: "cash_sale", amount: 2600 },
          { type: "bank_drop", amount: -5000 },
        ],
        close: { counts: full, bank_drop: 5000, card_reported_total: null, notes: "" },
      })
    )
    expect(before.cash).toMatchObject({ expected: 12600, counted: 12620, variance: 20, bank_drops: 0 })
    expect(after.cash).toMatchObject({ expected: 7600, counted: 7620, variance: 20, bank_drops: 5000 })
    // The count on the report is the drawer as keyed, before the drop.
    expect(after.counts).toEqual(full)
  })

  it("leaves the counted figure alone with no bank drop or a drop of nothing", () => {
    expect(countedAfterDrop({ counts: { "1000": 3 } })).toBe(3000)
    expect(countedAfterDrop({ counts: { "1000": 3 }, bank_drop: 0 })).toBe(3000)
    expect(countedAfterDrop({ counts: { "1000": 3 }, bank_drop: 2000 })).toBe(1000)
  })

  it("ignores a bank drop on an X, which has no count", () => {
    const report = buildTillReport(
      input({ type: "x", close: { counts: { "1000": 3 }, bank_drop: 2000, card_reported_total: null, notes: "" } })
    )
    expect(report.cash.counted).toBeNull()
    expect(report.cash.variance).toBeNull()
  })

  it("leaves the card variance empty on a Z with no Tide total keyed", () => {
    const report = buildTillReport(
      input({ type: "z", close: { counts: { "5000": 0 }, card_reported_total: null, notes: "" } })
    )
    expect(report.card).toEqual({ till_total: 0, reported_total: null, variance: null })
    expect(report.cash.counted).toBe(0)
    expect(report.cash.variance).toBe(-10000)
  })

  it("adds up a whole day to the penny", () => {
    // Float £100. Three sales: a split cash and card sale with change given,
    // a discounted card sale, a store credit sale. One refund of an earlier
    // session's sale to cash, a paid in, a paid out, a cash buy-in, a bank
    // drop and an adjustment. Then the drawer is counted £0.30 short and
    // Tide reports £0.50 more card than the till.
    const report = buildTillReport(
      input({
        type: "z",
        number: 12,
        vat_registered: true,
        sales: [
          sale({
            id: "s1",
            occurred_at: "2026-10-09T10:15:00.000Z",
            staff: SAM,
            lines: [
              line({ unit_price: 3000, category: "Singles" }),
              line({ unit_price: 500, tax_scheme: "standard", vat_rate: 20, vat_amount: 83, category: "Services" }),
            ],
          }),
          sale({
            id: "s2",
            occurred_at: "2026-10-09T13:40:00.000Z",
            staff: MO,
            discount: 250,
            lines: [line({ unit_price: 2500, qty: 2, discount: 0, category: "Sealed" })],
          }),
          sale({
            id: "s3",
            occurred_at: "2026-10-09T16:05:00.000Z",
            staff: SAM,
            lines: [line({ unit_price: 1200, category: "Retro" })],
          }),
        ],
        tenders: [
          tender("cash", 1500),
          tender("card_tide", 2000),
          tender("card_tide", 4750),
          tender("store_credit", 1200),
          tender("cash", -900, "GG-S-000031-R1"),
        ],
        movements: [
          { type: "cash_sale", amount: 1500 },
          { type: "refund", amount: -900 },
          { type: "paid_in", amount: 1000 },
          { type: "paid_out", amount: -640 },
          { type: "payout", amount: -2500 },
          { type: "bank_drop", amount: -6000 },
          { type: "adjustment", amount: 15 },
        ],
        trade_ins: [{ payout_cash: 2500, payout_credit: 0 }],
        events: [
          { kind: "void_line", amount: 999 },
          { kind: "no_sale", amount: 0 },
          { kind: "override", amount: -640 },
        ],
        close: {
          // 2000 + 400 + 40 + 5 = 2445
          counts: { "1000": 2, "200": 2, "20": 2, "5": 1 },
          card_reported_total: 6800,
          notes: "",
        },
      })
    )

    expect(report.sales).toEqual({
      count: 3,
      gross: 3500 + 5000 + 1200,
      discounts: 250,
      net: 9700 - 250 - 900,
      average_basket: 2850,
      vat: [{ rate: 20, net: 417, vat: 83, gross: 500 }],
    })
    expect(report.refunds).toEqual({ count: 1, total: 900 })
    expect(report.tenders).toEqual([
      { method: "cash", label: "Cash", taken: 1500, refunded: 900, net: 600, count: 1 },
      { method: "card_tide", label: "Card", taken: 6750, refunded: 0, net: 6750, count: 2 },
      { method: "store_credit", label: "Store credit", taken: 1200, refunded: 0, net: 1200, count: 1 },
    ])
    // 10000 + 1500 - 900 + 1000 - 640 - 2500 - 6000 + 15 = 2475
    expect(report.cash).toEqual({
      opening_float: 10000,
      cash_sales: 1500,
      cash_refunds: 900,
      paid_in: 1000,
      paid_out: 640,
      buy_in_payouts: 2500,
      bank_drops: 6000,
      adjustments: 15,
      expected: 2475,
      counted: 2445,
      variance: -30,
    })
    expect(report.card).toEqual({ till_total: 6750, reported_total: 6800, variance: 50 })
    expect(report.voids).toEqual({ count: 1, total: 999 })
    expect(report.no_sales).toEqual({ count: 1 })
    expect(report.overrides).toEqual({ count: 1 })
    expect(report.discounts).toEqual({ count: 1, total: 250 })
    expect(report.trade_ins).toEqual({ count: 1, cash_paid: 2500, credit_issued: 0, part_exchange_value: 0 })
    expect(report.by_category).toEqual([
      { category: "Sealed", net: 4750, count: 2 },
      { category: "Singles", net: 3000, count: 1 },
      { category: "Retro", net: 1200, count: 1 },
      { category: "Services", net: 500, count: 1 },
    ])
    expect(report.by_staff).toEqual([
      { staff_id: "staff_mo", name: "Mo Khan", net: 4750, count: 1 },
      { staff_id: "staff_sam", name: "Sam Bell", net: 4700, count: 2 },
    ])
    expect(report.first_sale_at).toBe("2026-10-09T10:15:00.000Z")
    expect(report.last_sale_at).toBe("2026-10-09T16:05:00.000Z")
  })
})
