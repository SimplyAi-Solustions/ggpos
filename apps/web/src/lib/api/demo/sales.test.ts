import { beforeAll, describe, expect, it } from "vitest"

import { completeSale, refundSale, todayStats } from "@/lib/api/demo/sales"
import { getCurrent, open } from "@/lib/api/demo/cash"
import { getItem, listItems } from "@/lib/api/demo/items"
import { DEMO_SALE_CUSTOMERS, ensureSeeded, itemStore } from "@/lib/api/demo/store"

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
