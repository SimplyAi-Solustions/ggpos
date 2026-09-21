import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Starting a count, against a stubbed collection API.
 *
 * What the snapshot takes is the whole question: a reserved card and one
 * listed on eBay are both still on the shelf and both have to be found, so
 * a count that only expected `in_stock` would report them missing every
 * time. Only sold, returned and written off are gone.
 */

const create = vi.fn()
const getFullList = vi.fn()
const getList = vi.fn()
const getOne = vi.fn()
const batchCreate = vi.fn()
const batchSend = vi.fn()

vi.mock("@/lib/pb", () => ({
  pb: {
    collection: (name: string) => ({
      create: (body: unknown, options: unknown) => create(name, body, options),
      getFullList: (options: unknown) => getFullList(name, options),
      getList: (page: number, perPage: number, options: unknown) =>
        getList(name, page, perPage, options),
      getOne: (id: string, options: unknown) => getOne(name, id, options),
    }),
    createBatch: () => ({
      collection: (name: string) => ({
        create: (body: unknown) => batchCreate(name, body),
      }),
      send: () => batchSend(),
    }),
    authStore: { record: { id: "staff_demo" } },
  },
  pingPocketBase: async () => true,
}))

const { setDataMode } = await import("@/lib/api/mode")
const { COUNTED_STATUSES, startStockCount } = await import("@/lib/api/stockcounts")

const COUNT = { id: "count_1", location: "loc_showcase", status: "open" }

function item(id: string, qty: number) {
  return { id, sku: `GGS${id}`, title: id, qty, location: "loc_showcase" }
}

describe("starting a count in live mode", () => {
  beforeEach(() => {
    setDataMode(false)
    for (const spy of [create, getFullList, getList, getOne, batchCreate, batchSend]) {
      spy.mockReset()
    }
    // No count is open for the location.
    getList.mockResolvedValue({ items: [] })
    create.mockResolvedValue(COUNT)
    getFullList.mockImplementation(async (name: string) =>
      name === "items" ? [item("a", 1), item("b", 3), item("c", 0)] : []
    )
    batchSend.mockResolvedValue([])
  })

  it("expects everything that is physically on the shelf", async () => {
    await startStockCount("loc_showcase")

    const [, options] = getFullList.mock.calls.find(([name]) => name === "items")!
    const filter = (options as { filter: string }).filter
    for (const status of COUNTED_STATUSES) {
      expect(filter).toContain(`status = "${status}"`)
    }
    expect(filter).not.toContain('status = "sold"')
    expect(filter).toContain('location = "loc_showcase"')
  })

  it("takes the real quantity, and skips a line that is already empty", async () => {
    await startStockCount("loc_showcase")

    const written = batchCreate.mock.calls.map(([, body]) => body) as {
      item: string
      expected_qty: number
    }[]
    expect(written.map((row) => [row.item, row.expected_qty])).toEqual([
      ["a", 1],
      ["b", 3],
    ])
    expect(batchSend).toHaveBeenCalledTimes(1)
  })

  it("carries on with the count already open rather than starting a second", async () => {
    getList.mockResolvedValue({ items: [{ ...COUNT, id: "count_open" }] })

    const count = await startStockCount("loc_showcase")

    expect(count.id).toBe("count_open")
    expect(create).not.toHaveBeenCalled()
    expect(batchCreate).not.toHaveBeenCalled()
  })
})

describe("starting a count in demo mode", () => {
  beforeEach(() => setDataMode(true))

  it("expects the reserved and listed items too", async () => {
    const { itemStore } = await import("@/lib/api/demo/store")
    const store = itemStore()
    const showcase = store.filter((row) => row.location === "loc_showcase")
    const first = showcase[0]
    expect(first).toBeDefined()
    first!.status = "reserved"

    const count = await startStockCount("loc_showcase")

    expect(count.lines.some((line) => line.itemId === first!.id)).toBe(true)
    first!.status = "in_stock"
  })
})
