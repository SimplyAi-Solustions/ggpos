import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { breakdown, refundAmount, remainingQty, type TenderInput } from "@gg/shared"

import {
  completeSale,
  demoDrawerExpected,
  getSale,
  lookupSale,
  refundSale,
  todayStats,
} from "@/lib/api/demo/sales"
import { getItem, listItems } from "@/lib/api/demo/items"
import { demoTill } from "@/lib/api/demo/till-session"
import { demoTillEvents } from "@/lib/api/demo/till"
import {
  DEMO_SALE_CUSTOMERS,
  DEMO_VOUCHERS,
  ensureSeeded,
  itemStore,
} from "@/lib/api/demo/store"
import type { TillSalePayload } from "@/lib/api/sales"
import type { StockItemRecord } from "@/lib/api/types"

/**
 * The demo counter's own arithmetic. It stands in for the server's
 * transaction (docs/api-contract-epos.md, section 4), so it has to refuse
 * the same things and count the same things: what a sale does to stock, to
 * the drawer and to a customer's balances, and what Home shows for the day.
 *
 * The stores are shared modules, so these run in order on purpose, and
 * each test puts its own stock on the shelf.
 */

let made = 0

/** A fresh item on the demo shelf. */
function shelve(over: Partial<StockItemRecord> = {}): StockItemRecord {
  made += 1
  const item: StockItemRecord = {
    id: `item_test_${made}`,
    sku: `GGSTEST${made}`,
    kind: "single",
    game: "game_pokemon",
    title: `Test card ${made}`,
    qty: 1,
    price: 1000,
    status: "in_stock",
    tax_scheme: "margin",
    ...over,
  }
  itemStore().push(item)
  return item
}

function sale(
  lines: TillSalePayload["lines"],
  tenders: TenderInput[],
  over: Partial<TillSalePayload> = {}
): TillSalePayload {
  return {
    lines,
    discount: 0,
    discount_source: null,
    reward_code: null,
    customer: null,
    tenders,
    ...over,
  }
}

const session = demoTill.session

afterEach(() => {
  demoTill.session = session
})

describe("the demo counter", () => {
  beforeAll(() => {
    ensureSeeded()
  })

  it("starts the morning with two sales, a buy-in and yesterday's drawer", () => {
    const stats = todayStats()
    expect(stats.salesCount).toBe(2)
    expect(stats.salesTotal).toBe(4745 + 249)
    expect(stats.salesByPayment.sumup_card).toBe(4745)
    expect(stats.salesByPayment.cash).toBe(249)
    expect(stats.buyInCount).toBe(1)
    expect(stats.buyInTotal).toBe(8500)
    expect(stats.creditIssued).toBe(2000)
    expect(stats.itemsIn).toBe(4)
    expect(stats.itemsOut).toBe(2)
    expect(stats.recent).toHaveLength(3)
  })

  it("counts the buy-in's cash against the drawer", () => {
    expect(todayStats().cashOut).toBe(6500)
  })

  it("sells nothing while the till is closed", () => {
    const item = shelve()
    demoTill.session = null
    expect(() =>
      completeSale(sale([{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }], [
        { method: "cash", amount: 1000, tendered: 1000 },
      ]))
    ).toThrow("Open the till first.")
  })

  it("sells for cash with change, marks the item sold and moves the drawer by the sale", () => {
    const item = shelve({ price: 3760 })
    const drawer = demoDrawerExpected()

    const result = completeSale(
      sale([{ item: item.id, qty: 1, unit_price: 3760, discount: 0 }], [
        { method: "cash", amount: 3760, tendered: 5000 },
      ])
    )

    expect(result.sale.number).toMatch(/^GG-S-\d{6}$/)
    expect(result.receipt.number).toBe(result.sale.number)
    expect(result.change).toBe(1240)
    expect(result.tenders).toEqual([
      expect.objectContaining({ method: "cash", amount: 3760, tendered: 5000, change: 1240 }),
    ])
    expect(getItem(item.sku)?.status).toBe("sold")
    // The drawer moves by the sale, not by what was handed over.
    expect(demoDrawerExpected()).toBe(drawer + 3760)
    expect(todayStats().salesByPayment.cash).toBe(249 + 3760)
  })

  it("refuses payments that do not come to the total, in the contract's words", () => {
    const item = shelve({ price: 4000 })
    expect(() =>
      completeSale(sale([{ item: item.id, qty: 1, unit_price: 4000, discount: 0 }], [
        { method: "card_tide", amount: 3800, card_last4: "4242" },
      ]))
    ).toThrow("The payments come to £38.00 but the total is £40.00.")
  })

  it("asks for the card's last four digits", () => {
    const item = shelve({ price: 4000 })
    expect(() =>
      completeSale(sale([{ item: item.id, qty: 1, unit_price: 4000, discount: 0 }], [
        { method: "card_tide", amount: 4000 },
      ]))
    ).toThrow("Key the last four digits of the card.")
  })

  it("takes a split of store credit and card, and earns points on the rest", () => {
    const customer = DEMO_SALE_CUSTOMERS[0]!
    const before = { credit: customer.creditBalance, points: customer.pointsBalance }
    const item = shelve({ price: 2000 })

    const result = completeSale(
      sale(
        [{ item: item.id, qty: 1, unit_price: 2000, discount: 0 }],
        [
          { method: "store_credit", amount: 250 },
          { method: "card_tide", amount: 1750, card_last4: "1111" },
        ],
        { customer: customer.id }
      )
    )

    expect(result.credit_balance).toBe(before.credit - 250)
    expect(result.points_earned).toBeGreaterThan(0)
    expect(customer.pointsBalance).toBe(before.points + result.points_earned)
    expect(getSale(result.sale.id)?.payment).toBe("mixed")
  })

  it("sells till products, and asks the price of an open-price one", () => {
    expect(() =>
      completeSale(sale([{ product: "product_single_card", qty: 1, unit_price: 0, discount: 0 }], []))
    ).toThrow("Key a price for Single card.")

    const result = completeSale(
      sale(
        [
          { product: "product_table_time", qty: 2, unit_price: 500, discount: 0 },
          { product: "product_single_card", qty: 1, unit_price: 250, discount: 0, title: "Single card: Pikachu" },
        ],
        [{ method: "cash", amount: 1250, tendered: 1250 }]
      )
    )
    const lines = getSale(result.sale.id)!.lines
    expect(lines.map((line) => line.title)).toEqual(["Table time, 1 hour", "Single card: Pikachu"])
    expect(result.sale.total).toBe(1250)
  })

  it("will not sell a Guild Membership to nobody", () => {
    expect(() =>
      completeSale(
        sale([{ product: "product_guild_membership", qty: 1, unit_price: 2400, discount: 0 }], [
          { method: "cash", amount: 2400, tendered: 2400 },
        ])
      )
    ).toThrow("Attach the customer to sell a Guild Membership.")
  })

  it("writes the lines taken off the ticket as voids with the sale", () => {
    const item = shelve({ price: 500 })
    const before = demoTillEvents.length
    const result = completeSale(
      sale([{ item: item.id, qty: 1, unit_price: 500, discount: 0 }], [
        { method: "cash", amount: 500, tendered: 500 },
      ], { voided: [{ title: "Charizard ex", qty: 1, amount: 32499 }] })
    )
    expect(demoTillEvents.length).toBe(before + 1)
    expect(demoTillEvents.at(-1)).toMatchObject({
      kind: "void_line",
      amount: 32499,
      detail: { title: "Charizard ex", qty: 1, sale: result.sale.id },
    })
  })

  it("answers a replayed client id with the first sale, never a second", () => {
    const item = shelve({ price: 700 })
    const payload = sale([{ item: item.id, qty: 1, unit_price: 700, discount: 0 }], [
      { method: "cash", amount: 700, tendered: 700 },
    ], { client_id: "till-replay-1" })
    const first = completeSale(payload)
    const again = completeSale(payload)
    expect(again.sale.id).toBe(first.sale.id)
  })

  it("filters and searches the stock list", () => {
    const sold = listItems({ status: "sold" }, 1)
    expect(sold.items.every((row) => row.status === "sold")).toBe(true)
    expect(listItems({ search: "charizard" }, 1).items[0]?.title).toContain("Charizard")
  })
})

describe("finding a sale for a return", () => {
  it("finds it by the printed number and by the barcode's", () => {
    expect(lookupSale("GG-S-000456").sale.lines[0]?.title).toBe("Llanowar Elves")
    expect(lookupSale("GGS000456").sale.number).toBe("GG-S-000456")
  })

  it("says plainly when nobody has that number", () => {
    expect(() => lookupSale("GG-S-000999")).toThrow("No sale has the number GG-S-000999.")
  })

  it("shows what each line can still give back", () => {
    const found = lookupSale("GG-S-000455").sale
    // £49.95 with £2.50 off the sale: £47.45 went in, and that is what can come back.
    expect(found.lines[0]).toMatchObject({ refundable_qty: 1, refundable_amount: 4745 })
    expect(found.tenders[0]).toMatchObject({ method: "sumup_card", label: "Card (SumUp)" })
  })
})

describe("the refund contract", () => {
  it("counts a part refund up rather than rewriting the line, naming each refund", () => {
    const item = shelve({ kind: "sealed", qty: 3, price: 1000 })
    const sold = completeSale(
      sale([{ item: item.id, qty: 3, unit_price: 1000, discount: 0 }], [
        { method: "cash", amount: 3000, tendered: 3000 },
      ])
    )
    const lineId = getSale(sold.sale.id)!.lines[0]!.id

    const first = refundSale(sold.sale.id, {
      lines: [{ sale_line: lineId, qty: 1 }],
      reason: "One came back",
      tenders: [{ method: "cash", amount: 1000 }],
    })
    expect(first.refund).toMatchObject({ ref: `${sold.sale.number}-R1`, amount: 1000 })
    expect(first.sale.status).toBe("part_refunded")
    expect(getItem(item.sku)?.qty).toBe(1)

    const rest = refundSale(sold.sale.id, {
      lines: [{ sale_line: lineId, qty: 2, restock: false }],
      reason: "Both damaged",
      tenders: [{ method: "card_tide", amount: 2000, card_last4: "4242" }],
    })
    expect(rest.refund.ref).toBe(`${sold.sale.number}-R2`)
    expect(rest.sale.status).toBe("refunded")
    // Damaged: left out of stock.
    expect(getItem(item.sku)?.qty).toBe(1)
    expect(rest.refund.tenders[0]).toMatchObject({ method: "card_tide", amount: -2000 })

    expect(() =>
      refundSale(sold.sale.id, {
        lines: [{ sale_line: lineId, qty: 1 }],
        reason: "Again",
        tenders: [{ method: "cash", amount: 1000 }],
      })
    ).toThrow("Nothing on that sale is left to refund.")
  })

  it("makes the tenders add up to the refund", () => {
    const found = lookupSale("GG-S-000455").sale
    expect(() =>
      refundSale(found.id, {
        lines: [{ sale_line: found.lines[0]!.id, qty: 1 }],
        reason: "Faulty",
        tenders: [{ method: "card_tide", amount: 4000 }],
      })
    ).toThrow("The refund is £47.45 but the payments come to £40.00. Make them match.")
  })

  it("will not give back more cash than the drawer should hold", () => {
    const item = shelve({ price: 900_000 })
    const sold = completeSale(
      sale([{ item: item.id, qty: 1, unit_price: 900_000, discount: 0 }], [
        { method: "card_tide", amount: 900_000, card_last4: "4242" },
      ])
    )
    const lineId = getSale(sold.sale.id)!.lines[0]!.id
    expect(() =>
      refundSale(sold.sale.id, {
        lines: [{ sale_line: lineId, qty: 1 }],
        reason: "Changed their mind",
        tenders: [{ method: "cash", amount: 900_000 }],
      })
    ).toThrow(/The drawer should only hold £[\d,.]+\. Refund the rest to card or store credit\./)
  })

  it("refuses a reward without the customer it was issued to", () => {
    const item = shelve()
    expect(() =>
      completeSale(
        sale([{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }], [
          { method: "cash", amount: 500, tendered: 500 },
        ], { discount: 500, discount_source: "reward", reward_code: DEMO_VOUCHERS[0]!.code })
      )
    ).toThrow("A reward needs the customer")
  })

  it("refuses a reward stacked on another discount", () => {
    const item = shelve()
    expect(() =>
      completeSale(
        sale([{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }], [
          { method: "cash", amount: 400, tendered: 400 },
        ], {
          discount: 600,
          discount_source: "reward",
          reward_code: DEMO_VOUCHERS[0]!.code,
          customer: DEMO_VOUCHERS[0]!.customer,
        })
      )
    ).toThrow("A reward is the whole discount")
  })
})

describe("what a refund is worth", () => {
  it("gives back what was paid, not the ticket price, on a discounted sale", () => {
    const original = getSale("sale_demo_1")!
    const sold = breakdown(
      original.lines.map((line) => ({
        id: line.id,
        qty: line.qty ?? 1,
        unitPrice: line.unit_price ?? 0,
        discount: line.discount ?? 0,
        refundedQty: line.refunded_qty ?? 0,
      })),
      original.discount ?? 0
    )
    const sheetFigure = sold.lines.reduce((sum, row) => sum + refundAmount(row, remainingQty(row)), 0)
    expect(sheetFigure).toBe(4745)

    const result = refundSale("sale_demo_1", {
      lines: [{ sale_line: "sale_line_demo_1", qty: 1 }],
      reason: "Faulty",
      tenders: [{ method: "store_credit", amount: sheetFigure }],
    })
    expect(result.refund.amount).toBe(sheetFigure)
    expect(result.sale.status).toBe("refunded")
  })
})
