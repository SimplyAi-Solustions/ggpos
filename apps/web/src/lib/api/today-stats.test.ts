import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The live `getTodayStats`, against a stubbed collection API.
 *
 * A refund never rewrites a sale's total or a line's quantity: it counts up
 * `sales.refunded_total` and `sale_lines.refunded_qty`. Home has to net those
 * off, or a part-refunded morning reads as a better one than it was.
 */

const getFullList = vi.fn()
const getList = vi.fn()

vi.mock("@/lib/pb", () => ({
  pb: {
    collection: (name: string) => ({
      getFullList: (options: unknown) => getFullList(name, options),
      getList: (page: number, perPage: number, options: unknown) =>
        getList(name, page, perPage, options),
    }),
    authStore: { record: { id: "staff_demo" } },
  },
  pingPocketBase: async () => true,
}))

const { setDataMode } = await import("@/lib/api/mode")
const { getTodayStats } = await import("@/lib/api/sales")

describe("the day's numbers in live mode", () => {
  beforeEach(() => {
    setDataMode(false)
    getFullList.mockReset()
    getList.mockReset()
  })

  it("nets a part-refunded sale off the total and the item count", async () => {
    getFullList.mockImplementation(async (name: string) => {
      if (name === "sales") {
        return [
          {
            id: "s1",
            number: "GG-S-000455",
            total: 4745,
            refunded_total: 0,
            payment_split: { sumup_card: 4745 },
            status: "complete",
            created: "2026-09-20T09:41:00Z",
            expand: { customer: { name: "Ash Ketchum" } },
          },
          {
            id: "s2",
            number: "GG-S-000456",
            total: 3000,
            // One of three units has gone back.
            refunded_total: 1000,
            payment_split: { cash: 3000 },
            status: "part_refunded",
            created: "2026-09-20T10:12:00Z",
          },
          {
            id: "s3",
            number: "GG-S-000457",
            total: 500,
            refunded_total: 500,
            payment_split: { cash: 500 },
            status: "refunded",
            created: "2026-09-20T10:30:00Z",
          },
        ]
      }
      if (name === "trade_ins") return []
      if (name === "cash_movements") {
        return [{ type: "payout", amount: -6500 }, { type: "cash_sale", amount: 3000 }]
      }
      if (name === "sale_lines") {
        return [
          { qty: 1, refunded_qty: 0, status: "sold" },
          { qty: 3, refunded_qty: 1, status: "sold" },
          { qty: 1, refunded_qty: 1, status: "refunded" },
        ]
      }
      return []
    })
    getList.mockResolvedValue({ totalItems: 0 })

    const stats = await getTodayStats()

    // A fully refunded sale drops out; a part-refunded one counts net.
    expect(stats.salesCount).toBe(2)
    expect(stats.salesTotal).toBe(4745 + (3000 - 1000))
    // Four units sold, two of them back: two left the shop.
    expect(stats.itemsOut).toBe(1 + 2 + 0)
    // Only what went out of the drawer, and a payout is signed negative.
    expect(stats.cashOut).toBe(6500)
  })

  it("counts a clean day without any refunded columns at all", async () => {
    getFullList.mockImplementation(async (name: string) => {
      if (name === "sales") {
        return [
          {
            id: "s1",
            number: "GG-S-000455",
            total: 1000,
            payment_split: { cash: 1000 },
            status: "complete",
            created: "2026-09-20T09:41:00Z",
          },
        ]
      }
      if (name === "sale_lines") return [{ qty: 2, status: "sold" }]
      return []
    })
    getList.mockResolvedValue({ totalItems: 3 })

    const stats = await getTodayStats()
    expect(stats.salesTotal).toBe(1000)
    expect(stats.itemsOut).toBe(2)
    expect(stats.itemsIn).toBe(3)
    expect(stats.salesByPayment.cash).toBe(1000)
  })
})
