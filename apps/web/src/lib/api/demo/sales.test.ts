import { beforeAll, describe, expect, it } from "vitest"

import { completeSale, getSale, refundSale, todayStats } from "@/lib/api/demo/sales"
import { close as closeSession, getCurrent, open, openSession } from "@/lib/api/demo/cash"
import { getItem, listItems } from "@/lib/api/demo/items"
import {
  DEMO_SALE_CUSTOMERS,
  DEMO_VOUCHERS,
  ensureSeeded,
  itemStore,
} from "@/lib/api/demo/store"

/**
 * The demo counter's own arithmetic. It stands in for the server's
 * transaction, so it has to count the same things: what a sale does to stock,
 * to the drawer and to a customer's balances, and what Home shows for the day.
 *
 * The store is one shared module, so these run in order on purpose.
 */
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
    // £65 cash paid out on the seeded buy-in, nothing else out yet.
    expect(todayStats().cashOut).toBe(6500)
  })

  it("refuses cash with no session open", () => {
    const item = itemStore().find((row) => row.status === "in_stock")
    expect(item).toBeDefined()
    expect(() =>
      completeSale({
        lines: [{ item: item!.id, qty: 1, unit_price: item!.price ?? 0, discount: 0 }],
        customer: null,
        payment: "cash",
        payment_split: { cash: item!.price ?? 0 },
        discount: 0,
        discount_source: null,
        reward_code: null,
        cash_session: null,
        sumup_ref: "",
      })
    ).toThrow("Open a cash session")
  })

  it("sells an item for cash, marks it sold and moves the drawer", () => {
    open(10000)
    const item = itemStore().find((row) => row.status === "in_stock")!
    const price = item.price ?? 0

    const result = completeSale({
      lines: [{ item: item.id, qty: 1, unit_price: price, discount: 0 }],
      customer: null,
      payment: "cash",
      payment_split: { cash: price },
      discount: 0,
      discount_source: null,
      reward_code: null,
      cash_session: null,
      sumup_ref: "",
    })

    expect(result.sale.number).toMatch(/^GG-S-\d{6}$/)
    expect(result.sale.total).toBe(price)
    expect(getItem(item.sku)?.status).toBe("sold")

    const drawer = getCurrent()
    expect(drawer.expected).toBe(10000 + price)
    expect(drawer.movements[0]?.type).toBe("cash_sale")

    const stats = todayStats()
    expect(stats.salesCount).toBe(3)
    expect(stats.salesByPayment.cash).toBe(249 + price)
  })

  it("earns points and spends credit for the customer on the sale", () => {
    const customer = DEMO_SALE_CUSTOMERS[0]!
    const before = { credit: customer.creditBalance, points: customer.pointsBalance }
    const item = itemStore().find((row) => row.status === "in_stock")!
    const price = item.price ?? 0

    const result = completeSale({
      lines: [{ item: item.id, qty: 1, unit_price: price, discount: 0 }],
      customer: customer.id,
      payment: "mixed",
      payment_split: { store_credit: 250, sumup_card: price - 250 },
      discount: 0,
      discount_source: null,
      reward_code: null,
      cash_session: null,
      sumup_ref: "",
    })

    expect(result.credit_balance).toBe(before.credit - 250)
    expect(result.points_earned).toBeGreaterThan(0)
    expect(customer.pointsBalance).toBe(before.points + result.points_earned)
    expect(result.sumup_amount).toBe(price - 250)
  })

  it("puts a refunded line back in stock and off the day's count", () => {
    const before = todayStats()
    const sale = "sale_demo_2"
    const result = refundSale(sale, {
      lines: [{ sale_line: "sale_line_demo_2", qty: 1 }],
      reason: "Faulty",
      refund_method: "cash",
    })

    expect(result.refunded).toBe(249)
    expect(result.sale.status).toBe("refunded")
    const restocked = itemStore().find((row) => row.id === "item_demo_sold_2")
    expect(restocked?.status).toBe("in_stock")

    const after = todayStats()
    expect(after.salesCount).toBe(before.salesCount - 1)
    expect(after.salesTotal).toBe(before.salesTotal - 249)
    // The cash that went back out of the drawer counts as cash out.
    expect(after.cashOut).toBe(before.cashOut + 249)
  })

  it("filters and searches the stock list", () => {
    const sold = listItems({ status: "sold" }, 1)
    expect(sold.items.length).toBeGreaterThan(0)
    expect(sold.items.every((row) => row.status === "sold")).toBe(true)

    const byTitle = listItems({ search: "charizard" }, 1)
    expect(byTitle.items[0]?.title).toContain("Charizard")
  })
})

describe("the refund contract", () => {
  beforeAll(() => {
    ensureSeeded()
  })

  it("counts a part refund up rather than rewriting the line", () => {
    const item = itemStore().find(
      (row) => row.status === "in_stock" && (row.qty ?? 1) >= 3
    )
    // Nothing multi-quantity in the demo store, so make the case explicitly.
    const sealed = item ?? itemStore()[0]!
    sealed.status = "in_stock"
    sealed.qty = 3

    const already = openSession()
    if (already) closeSession(already.id, 0, "")
    open(5000)
    const sale = completeSale({
      lines: [{ item: sealed.id, qty: 3, unit_price: 1000, discount: 0 }],
      customer: null,
      payment: "cash",
      payment_split: { cash: 3000 },
      discount: 0,
      discount_source: null,
      reward_code: null,
      cash_session: null,
      sumup_ref: "",
    })

    const full = getSale(sale.sale.id)!
    const lineId = full.lines[0]!.id

    const first = refundSale(sale.sale.id, {
      lines: [{ sale_line: lineId, qty: 1 }],
      reason: "One came back",
      refund_method: "cash",
    })
    expect(first.refunded).toBe(1000)
    expect(first.sale.status).toBe("part_refunded")

    const afterOne = getSale(sale.sale.id)!
    expect(afterOne.lines[0]!.qty).toBe(3)
    expect(afterOne.lines[0]!.refunded_qty).toBe(1)
    expect(afterOne.lines[0]!.status).toBe("sold")
    expect(afterOne.refunded_total).toBe(1000)

    const rest = refundSale(sale.sale.id, {
      lines: [{ sale_line: lineId, qty: 2 }],
      reason: "The rest too",
      refund_method: "cash",
    })
    expect(rest.refunded).toBe(2000)
    expect(rest.sale.status).toBe("refunded")

    const afterAll = getSale(sale.sale.id)!
    expect(afterAll.lines[0]!.refunded_qty).toBe(3)
    expect(afterAll.lines[0]!.status).toBe("refunded")
    expect(afterAll.refunded_total).toBe(3000)

    // Nothing is left to give back.
    expect(
      refundSale(sale.sale.id, {
        lines: [{ sale_line: lineId, qty: 1 }],
        reason: "Again",
        refund_method: "cash",
      }).refunded
    ).toBe(0)
  })

  it("refuses a reward without the customer it was issued to", () => {
    const item = itemStore().find((row) => row.status === "in_stock")!
    expect(() =>
      completeSale({
        lines: [{ item: item.id, qty: 1, unit_price: 1000, discount: 500 }],
        customer: null,
        payment: "sumup_card",
        payment_split: { sumup_card: 500 },
        discount: 500,
        discount_source: "reward",
        reward_code: DEMO_VOUCHERS[0]!.code,
        cash_session: null,
        sumup_ref: "",
      })
    ).toThrow("A reward needs the customer")
  })

  it("refuses a reward stacked on another discount", () => {
    const item = itemStore().find((row) => row.status === "in_stock")!
    expect(() =>
      completeSale({
        lines: [{ item: item.id, qty: 1, unit_price: 1000, discount: 0 }],
        customer: DEMO_VOUCHERS[0]!.customer,
        payment: "sumup_card",
        payment_split: { sumup_card: 400 },
        discount: 600,
        discount_source: "reward",
        reward_code: DEMO_VOUCHERS[0]!.code,
        cash_session: null,
        sumup_ref: "",
      })
    ).toThrow("A reward is the whole discount")
  })
})
