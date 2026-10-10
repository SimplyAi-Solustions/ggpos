import { beforeAll, describe, expect, it } from "vitest"

import { completeTicket, demoDrawerExpected, lookupSale } from "@/lib/api/demo/sales"
import { demoCreateDraft, demoSaveLines, demoTradeIns } from "@/lib/api/demo/tradeins"
import { DEMO_SALE_CUSTOMERS, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type { TillTicketPayload } from "@/lib/api/till"
import type { StockItemRecord, TradeInLineInput } from "@/lib/api/types"

/**
 * The demo sale with a part-exchange and a return on it
 * (docs/api-contract-epos.md, section 7). It stands in for the server's
 * transaction, so it has to do the same arithmetic and refuse the same
 * things: A = min(V, S) on the sale, the surplus V - A paid out, and a
 * return refunded off its own sale with E = min(R, S - A) set against the
 * new one. The stores are shared modules, so these run in order.
 */

let made = 0

function shelve(price: number): StockItemRecord {
  made += 1
  const item: StockItemRecord = {
    id: `item_px_${made}`,
    sku: `GGSPX${made}`,
    kind: "single",
    game: "game_pokemon",
    title: `Part-exchange card ${made}`,
    qty: 1,
    price,
    status: "in_stock",
    tax_scheme: "margin",
  }
  itemStore().push(item)
  return item
}

/** A draft trade-in for a customer: one sealed box at a £28.00 credit offer. */
function draft(customer: string, offer = 2800): string {
  const record = demoCreateDraft(customer)
  const input: TradeInLineInput = {
    kind: "sealed",
    title: "Surging Sparks Elite Trainer Box",
    qty: 1,
    marketPrice: 4000,
    marketSource: "Manual",
    offerPrice: offer,
    accepted: true,
  }
  demoSaveLines(record.id, [input])
  return record.id
}

function ticket(over: Partial<TillTicketPayload>): TillTicketPayload {
  return {
    lines: [],
    discount: 0,
    discount_source: null,
    reward_code: null,
    customer: null,
    tenders: [],
    ...over,
  }
}

const SIGNED = { terms_accepted: true, signature: "data:image/png;base64,AAAA" }

describe("the demo part-exchange", () => {
  beforeAll(() => {
    ensureSeeded()
  })

  it("puts the trade towards the sale and takes the rest by card", () => {
    const item = shelve(32499)
    const trade = draft("cust_demo_1")
    const result = completeTicket(
      ticket({
        customer: "cust_demo_1",
        lines: [{ item: item.id, qty: 1, unit_price: 32499, discount: 0 }],
        tenders: [{ method: "card_tide", amount: 29699, card_last4: "4242" }],
        trade_in: trade,
        trade_settlement: SIGNED,
      })
    )
    expect(result.tenders).toEqual([
      expect.objectContaining({ method: "part_exchange", amount: 2800 }),
      expect.objectContaining({ method: "card_tide", amount: 29699 }),
    ])
    expect(result.trade_in).toEqual({
      id: trade,
      number: expect.stringMatching(/^GG-BI-\d{6}$/),
      value: 2800,
      applied: 2800,
      payout_cash: 0,
      payout_credit: 0,
    })
    expect(result.refund).toBeNull()

    const record = demoTradeIns.find((entry) => entry.record.id === trade)?.record as unknown as Record<string, unknown>
    expect(record).toMatchObject({
      status: "completed",
      payout_type: "part_exchange",
      part_exchange_value: 2800,
      sale: result.sale?.id,
    })
    // The box is on the shelf at what was paid for it.
    expect(itemStore().find((row) => row.trade_in === trade)).toMatchObject({
      status: "in_stock",
      cost: 2800,
      source: "trade_in",
    })
  })

  it("pays a surplus as store credit, and earns points on that alone", () => {
    const item = shelve(1249)
    const trade = draft("cust_demo_1")
    const jasmine = DEMO_SALE_CUSTOMERS.find((row) => row.id === "cust_demo_1")
    const before = jasmine?.creditBalance ?? 0
    const result = completeTicket(
      ticket({
        customer: "cust_demo_1",
        lines: [{ item: item.id, qty: 1, unit_price: 1249, discount: 0 }],
        trade_in: trade,
        trade_settlement: { ...SIGNED, surplus: "credit" },
      })
    )
    expect(result.trade_in).toMatchObject({ applied: 1249, payout_credit: 1551, payout_cash: 0 })
    expect(jasmine?.creditBalance).toBe(before + 1551)
  })

  it("pays a surplus in cash out of the drawer, under the buy-in's ID gate", () => {
    const item = shelve(1249)
    const trade = draft("cust_demo_2")
    const base = ticket({
      customer: "cust_demo_2",
      lines: [{ item: item.id, qty: 1, unit_price: 1249, discount: 0 }],
      trade_in: trade,
    })
    // Tom has no ID on file.
    expect(() =>
      completeTicket({ ...base, trade_settlement: { ...SIGNED, surplus: "cash", surplus_cash: 1000 } })
    ).toThrow("Take an ID check before paying cash. Photograph the seller's ID on the ID step.")
    expect(() =>
      completeTicket({ ...base, trade_settlement: { ...SIGNED, surplus: "cash", surplus_cash: 1600 } })
    ).toThrow("Pay between £0.01 and £15.51 in cash, or pay the surplus as credit.")
    expect(() => completeTicket({ ...base, trade_settlement: SIGNED })).toThrow(
      "Pay the surplus as credit or cash."
    )

    const drawer = demoDrawerExpected()
    const result = completeTicket({
      ...base,
      trade_settlement: {
        ...SIGNED,
        surplus: "cash",
        surplus_cash: 1000,
        id_check: {
          id_type: "passport",
          id_expiry: "2032-06-30",
          id_ref_last4: "4471",
          dob: "1990-05-02",
          address: "4 Sherwood Lodge Drive, Chesterfield, S41 9AB",
          id_document: "iddoc_tom",
        },
      },
    })
    expect(result.trade_in).toMatchObject({ applied: 1249, payout_cash: 1000, payout_credit: 0 })
    expect(demoDrawerExpected()).toBe(drawer - 1000)
  })

  it("refuses a trade-in that is not open, not theirs, or with nothing to pay for", () => {
    const item = shelve(1000)
    const sale = { customer: "cust_demo_1", lines: [{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }] }
    expect(() =>
      completeTicket(ticket({ ...sale, trade_in: "trade_missing", trade_settlement: SIGNED }))
    ).toThrow("That trade-in was not found. Start the trade-in again.")
    expect(() =>
      completeTicket(ticket({ ...sale, trade_in: draft("cust_demo_2"), trade_settlement: SIGNED }))
    ).toThrow("That trade-in is for a different customer. Start it again with the customer on the ticket.")
    expect(() =>
      completeTicket(ticket({ customer: "cust_demo_1", trade_in: draft("cust_demo_1"), trade_settlement: SIGNED }))
    ).toThrow("There is nothing on the ticket for the trade-in to pay for. Add an item, or complete it as a buy-in.")
    expect(() =>
      completeTicket(ticket({ ...sale, trade_in: draft("cust_demo_1", 200), trade_settlement: { terms_accepted: false } }))
    ).toThrow("Ask the customer to accept the terms before completing.")
  })

  it("refuses tenders that do not cover what is left after the trade-in", () => {
    const item = shelve(1000)
    expect(() =>
      completeTicket(
        ticket({
          customer: "cust_demo_1",
          lines: [{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }],
          tenders: [{ method: "card_tide", amount: 600, card_last4: "4242" }],
          trade_in: draft("cust_demo_1", 200),
          trade_settlement: SIGNED,
        })
      )
    ).toThrow("The payments come to £6.00 but £8.00 is left after the trade-in.")
  })

  it("refuses a part-exchange payment with no trade-in on the ticket", () => {
    const item = shelve(1000)
    expect(() =>
      completeTicket(
        ticket({
          lines: [{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }],
          tenders: [{ method: "part_exchange", amount: 1000 }],
        })
      )
    ).toThrow("Take part-exchange through Trade in on the ticket.")
  })

  it("takes a part-exchange row only when it says what the trade pays", () => {
    const item = shelve(1000)
    const trade = draft("cust_demo_1", 200)
    const base = ticket({
      customer: "cust_demo_1",
      lines: [{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }],
      trade_in: trade,
      trade_settlement: SIGNED,
    })
    expect(() =>
      completeTicket({
        ...base,
        tenders: [
          { method: "part_exchange", amount: 300 },
          { method: "card_tide", amount: 800, card_last4: "4242" },
        ],
      })
    ).toThrow("The trade-in pays £2.00 towards this sale, not £3.00. Reload the ticket and try again.")
    const result = completeTicket({
      ...base,
      tenders: [
        { method: "part_exchange", amount: 200 },
        { method: "card_tide", amount: 800, card_last4: "4242" },
      ],
    })
    expect(result.trade_in).toMatchObject({ applied: 200 })
  })
})

describe("the demo exchange", () => {
  beforeAll(() => {
    ensureSeeded()
  })

  it("refunds the returned lines off their sale and sets them against the new one", () => {
    const item = shelve(1249)
    const original = lookupSale("GG-S-000456").sale
    const result = completeTicket(
      ticket({
        lines: [{ item: item.id, qty: 1, unit_price: 1249, discount: 0 }],
        tenders: [{ method: "cash", amount: 1000, tendered: 1000 }],
        returns: {
          sale: original.id,
          lines: [{ sale_line: original.lines[0]?.id ?? "", qty: 1 }],
          reason: "Wrong card",
        },
      })
    )
    expect(result.tenders).toEqual([
      expect.objectContaining({ method: "exchange", amount: 249 }),
      expect.objectContaining({ method: "cash", amount: 1000 }),
    ])
    expect(result.refund).toMatchObject({
      ref: "GG-S-000456-R1",
      amount: 249,
      exchange: 249,
      sale: { id: original.id, number: "GG-S-000456" },
      tenders: [expect.objectContaining({ method: "exchange", amount: -249 })],
    })
    expect(lookupSale("GG-S-000456").sale.lines[0]?.refundable_qty).toBe(0)
  })

  it("answers a ticket of returns alone with the refund route's body", () => {
    const original = lookupSale("GG-S-000455").sale
    const result = completeTicket(
      ticket({
        customer: "cust_demo_1",
        returns: {
          sale: original.id,
          lines: [{ sale_line: original.lines[0]?.id ?? "", qty: 1 }],
          reason: "Changed their mind",
          tenders: [{ method: "card_tide", amount: 4745, card_last4: "4242" }],
        },
      })
    )
    expect(result.sale).toEqual({ id: original.id, status: "refunded" })
    expect(result.refund).toMatchObject({ ref: "GG-S-000455-R1", amount: 4745, exchange: 0 })
    expect(result.trade_in).toBeUndefined()
  })

  it("sets a trade and a return against one sale, the trade first", () => {
    // Something sold earlier for £8.49 in cash, coming back now.
    const earlier = shelve(849)
    const first = completeTicket(
      ticket({
        lines: [{ item: earlier.id, qty: 1, unit_price: 849, discount: 0 }],
        tenders: [{ method: "cash", amount: 849, tendered: 849 }],
      })
    )
    const original = lookupSale(first.sale?.number ?? "").sale

    const item = shelve(3000)
    const drawer = demoDrawerExpected()
    const base = ticket({
      customer: "cust_demo_1",
      lines: [{ item: item.id, qty: 1, unit_price: 3000, discount: 0 }],
      trade_in: draft("cust_demo_1"),
      trade_settlement: SIGNED,
      returns: {
        sale: original.id,
        lines: [{ sale_line: original.lines[0]?.id ?? "", qty: 1 }],
        reason: "Doubled up",
      },
    })
    // A = £28.00 of the £30.00, E = the other £2.00, and £6.49 goes back.
    expect(() => completeTicket(base)).toThrow(
      "The refund is £6.49 but the payments come to £0.00. Make them match."
    )
    const result = completeTicket({
      ...base,
      returns: { ...base.returns!, tenders: [{ method: "cash", amount: 649 }] },
    })
    expect(result.tenders).toEqual([
      expect.objectContaining({ method: "part_exchange", amount: 2800 }),
      expect.objectContaining({ method: "exchange", amount: 200 }),
    ])
    expect(result.trade_in).toMatchObject({ value: 2800, applied: 2800 })
    expect(result.refund).toMatchObject({ amount: 849, exchange: 200 })
    expect(demoDrawerExpected()).toBe(drawer - 649)
  })

  it("refuses payments that do not cover what is left after both", () => {
    const earlier = shelve(500)
    const first = completeTicket(
      ticket({
        lines: [{ item: earlier.id, qty: 1, unit_price: 500, discount: 0 }],
        tenders: [{ method: "cash", amount: 500, tendered: 500 }],
      })
    )
    const original = lookupSale(first.sale?.number ?? "").sale
    const item = shelve(5000)
    expect(() =>
      completeTicket(
        ticket({
          customer: "cust_demo_1",
          lines: [{ item: item.id, qty: 1, unit_price: 5000, discount: 0 }],
          tenders: [{ method: "card_tide", amount: 1000, card_last4: "4242" }],
          trade_in: draft("cust_demo_1"),
          trade_settlement: SIGNED,
          returns: {
            sale: original.id,
            lines: [{ sale_line: original.lines[0]?.id ?? "", qty: 1 }],
            reason: "Doubled up",
          },
        })
      )
    ).toThrow("The payments come to £10.00 but £17.00 is left after the trade-in and the exchange.")
  })
})
