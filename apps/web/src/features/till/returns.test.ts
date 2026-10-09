import { describe, expect, it } from "vitest"
import type { SaleLookup, Tender } from "@gg/shared"

import {
  defaultRefundMethod,
  initialChoice,
  originalCardLast4,
  refundTenders,
  refundTotal,
} from "@/features/till/returns"

function tender(over: Partial<Tender>): Tender {
  return {
    method: "cash",
    label: "Cash",
    amount: 0,
    tendered: 0,
    change: 0,
    card_last4: "",
    reference: "",
    ...over,
  }
}

/**
 * GG-S-000456: three boosters at £5.49 and a £20.00 binder, with £2.47 off
 * the sale. The lookup carries each line's as-sold net: £16.47 less its
 * share, £20.00 less the rest.
 */
const SALE: SaleLookup = {
  id: "sale_1",
  number: "GG-S-000456",
  occurred_at: "2026-10-09T10:12:00.000Z",
  total: 3400,
  status: "complete",
  customer: { id: "cust_1", name: "Jasmine Okafor", code: "GGC4K7M2S" },
  register_name: "Counter",
  staff_name: "Demo Counter",
  lines: [
    {
      id: "line_a",
      title: "Booster pack",
      detail: "",
      sku: "GGP5N2W8H",
      qty: 3,
      refunded_qty: 0,
      unit_price: 549,
      discount: 0,
      net: 1532,
      refundable_qty: 3,
      refundable_amount: 1532,
      tax_scheme: "standard",
    },
    {
      id: "line_b",
      title: "Binder",
      detail: "",
      sku: "GGA2W9H4K",
      qty: 1,
      refunded_qty: 0,
      unit_price: 2000,
      discount: 0,
      net: 1868,
      refundable_qty: 1,
      refundable_amount: 1868,
      tax_scheme: "standard",
    },
  ],
  tenders: [
    tender({ method: "card_tide", label: "Card", amount: 3000, card_last4: "4242" }),
    tender({ method: "cash", amount: 400, tendered: 500, change: 100 }),
  ],
}

describe("what a return comes to", () => {
  it("pays each unit back once, from the as-sold net", () => {
    expect(refundTotal(SALE, { line_a: 1 })).toBe(511)
    expect(refundTotal(SALE, { line_a: 3 })).toBe(1532)
    expect(refundTotal(SALE, { line_a: 3, line_b: 1 })).toBe(3400)
  })

  it("never refunds more than is left on a line", () => {
    const partly = {
      ...SALE,
      lines: SALE.lines.map((line) =>
        line.id === "line_a" ? { ...line, refunded_qty: 1, refundable_qty: 2 } : line
      ),
    }
    // The second and third boosters: what is left of the line's net.
    expect(refundTotal(partly, { line_a: 3 })).toBe(1532 - 511)
  })

  it("starts with nothing chosen on a sale of several lines", () => {
    expect(initialChoice(SALE)).toEqual({ line_a: 0, line_b: 0 })
    const one = { ...SALE, lines: [SALE.lines[1]!] }
    expect(initialChoice(one)).toEqual({ line_b: 1 })
  })
})

describe("where the money goes back", () => {
  it("goes to the card it was mostly paid on, with its last four digits", () => {
    expect(defaultRefundMethod(SALE)).toBe("card_tide")
    expect(originalCardLast4(SALE)).toBe("4242")
  })

  it("goes back as cash on a cash sale, and as credit on a credit sale", () => {
    expect(defaultRefundMethod({ ...SALE, tenders: [tender({ amount: 3400 })] })).toBe("cash")
    expect(
      defaultRefundMethod({
        ...SALE,
        tenders: [tender({ method: "store_credit", label: "Store credit", amount: 3400 })],
      })
    ).toBe("store_credit")
  })

  it("puts the whole amount on one method", () => {
    expect(refundTenders(["cash"], {}, 1532, "", true)).toEqual({
      ok: true,
      tenders: [{ method: "cash", amount: 1532 }],
    })
    expect(refundTenders(["card_tide"], {}, 1532, "4242", true)).toEqual({
      ok: true,
      tenders: [{ method: "card_tide", amount: 1532, card_last4: "4242" }],
    })
  })

  it("makes a split add up to the refund exactly", () => {
    expect(refundTenders(["cash", "store_credit"], { cash: 500, store_credit: 1000 }, 1532, "", true)).toEqual({
      ok: false,
      message: "Those come to £15.00 but the refund is £15.32. Make them match.",
    })
    expect(
      refundTenders(["cash", "store_credit"], { cash: 532, store_credit: 1000 }, 1532, "", true)
    ).toEqual({
      ok: true,
      tenders: [
        { method: "cash", amount: 532 },
        { method: "store_credit", amount: 1000 },
      ],
    })
  })

  it("will not put store credit on a sale with nobody on it", () => {
    expect(refundTenders(["store_credit"], {}, 1532, "", false)).toEqual({
      ok: false,
      message: "Store credit needs the customer on the sale. Refund it another way.",
    })
  })
})
