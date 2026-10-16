import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * What the price routes are actually sent.
 *
 * The bodies matter more than they look: a card files its comp under a
 * finish and a condition, a retro title files its under a completeness, and
 * a refresh that forgets the condition has eBay searching for the wrong
 * card. None of that shows up on screen until a figure is wrong, so it is
 * checked here against a stubbed client.
 */

const send = vi.fn()

vi.mock("@/lib/pb", () => ({
  pb: {
    send: (path: string, options: unknown) => send(path, options),
    collection: () => ({ getFullList: async () => [] }),
    files: { getURL: () => "" },
    authStore: { record: { id: "staff_demo" } },
  },
  pingPocketBase: async () => true,
}))

const { setDataMode } = await import("@/lib/api/mode")
const {
  addRetroUkComp,
  addUkComp,
  getPrices,
  priceKeys,
  refreshPrices,
  refreshRetroPrices,
} = await import("@/lib/api/prices")

const EMPTY = { chosen: null, sources: [], condition_adjusted: null }

const COMP = {
  price: 4500,
  url: "https://www.ebay.co.uk/itm/226119440823",
  sold_at: "2026-09-12",
}

beforeEach(() => {
  setDataMode(false)
  send.mockReset()
  send.mockResolvedValue(EMPTY)
})

describe("reading a card's prices", () => {
  it("asks for the finish and condition being looked at", async () => {
    await getPrices("card_1", "holo", "LP")
    expect(send).toHaveBeenCalledWith("/api/vault/cards/card_1/prices", {
      method: "GET",
      query: { finish: "holo", condition: "LP" },
    })
  })
})

describe("refreshing", () => {
  it("sends the condition, so the eBay search matches the card in hand", async () => {
    await refreshPrices("card_1", "holo", "LP")
    expect(send).toHaveBeenCalledWith("/api/vault/cards/card_1/refresh-prices", {
      method: "POST",
      body: { finish: "holo", condition: "LP" },
    })
  })

  it("never sends an empty condition, which the route would have to guess at", async () => {
    await refreshPrices("card_1", "holo", "")
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      body: { condition: "NM" },
    })
  })

  it("refreshes a retro title on its completeness", async () => {
    await refreshRetroPrices("retro_1", "cib")
    expect(send).toHaveBeenCalledWith("/api/vault/retro/retro_1/refresh-prices", {
      method: "POST",
      body: { completeness: "cib" },
    })
  })
})

describe("a UK sold comp", () => {
  it("files a card's comp under its finish and condition", async () => {
    await addUkComp("card_1", { ...COMP, finish: "holo", condition: "LP" })
    expect(send).toHaveBeenCalledWith("/api/vault/cards/card_1/uk-comp", {
      method: "POST",
      body: { ...COMP, finish: "holo", condition: "LP" },
    })
  })

  it("files a retro title's comp under its completeness, and nothing else", async () => {
    // The retro route reads `completeness`; a comp sent with a finish and a
    // condition lands against no completeness at all and is never chosen.
    await addRetroUkComp("retro_1", { ...COMP, completeness: "cib" })
    expect(send).toHaveBeenCalledWith("/api/vault/retro/retro_1/uk-comp", {
      method: "POST",
      body: { ...COMP, completeness: "cib" },
    })
    const body = send.mock.calls[0]?.[1]?.body as Record<string, unknown>
    expect(body.finish).toBeUndefined()
    expect(body.condition).toBeUndefined()
  })
})

describe("the query keys", () => {
  it("leave the condition out, because nothing on screen reads it", () => {
    // `condition_adjusted` is worked out on the client with the shared
    // helper, so keying on the condition only emptied the cache and flashed
    // "No price yet" every time somebody tapped a condition chip.
    expect(priceKeys.card("card_1", "holo")).toEqual([
      "prices",
      "card",
      "card_1",
      "holo",
    ])
    expect(priceKeys.card("card_1", "holo")).not.toContain("LP")
  })

  it("keep every finish of one card under the same prefix", () => {
    const all = priceKeys.cardAll("card_1")
    expect(priceKeys.card("card_1", "holo").slice(0, all.length)).toEqual([...all])
  })
})
