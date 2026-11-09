import { beforeEach, describe, expect, it, vi } from "vitest"
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"

import * as api from "./api"
import { cardLineFromHit, customLine, dealReducer, newDraft } from "./state"
import type { CardLine } from "./types"

describe("searchCards", () => {
  it("calls the lookup route and maps rows", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue({
      cards: [
        {
          id: "c1",
          game: "pokemon",
          set_name: "Base Set",
          set_code: "base1",
          number: "4/102",
          name: "Charizard",
          image_small: "s.png",
          finishes_available: ["holo"],
        },
        { name: "No id, skipped" },
      ],
    })
    const hits = await api.searchCards("pokemon", " charizard ")
    expect(send).toHaveBeenCalledWith("/api/vault/lookup", expect.objectContaining({ query: { game: "pokemon", q: "charizard" } }))
    expect(hits).toEqual([
      {
        id: "c1",
        game: "pokemon",
        name: "Charizard",
        setName: "Base Set",
        setCode: "base1",
        number: "4/102",
        rarity: "",
        image: "s.png",
        finishes: ["holo"],
      },
    ])
  })

  it("does not search one letter", async () => {
    const send = vi.spyOn(pb, "send")
    expect(await api.searchCards("pokemon", "c")).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })
})

describe("getConditionPrices", () => {
  it("uses each condition's own comp when the server returns them", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue({
      chosen: { source: "uk_sold_manual", gbp_market: 51795 },
      condition_adjusted: 51795,
      conditions: { NM: { gbp_market: 51795 }, LP: { gbp_market: 27873 } },
    })
    const prices = await api.getConditionPrices("c1", "holo")
    expect(send).toHaveBeenCalledTimes(1)
    expect(prices.LP).toEqual({ pence: 27873, basis: "comp", source: undefined })
    expect(prices.MP).toBeUndefined()
  })

  it("falls back to the condition-adjusted figure, labelled estimated", async () => {
    vi.spyOn(pb, "send").mockImplementation(async (_path: string, options?: { query?: Record<string, unknown> }) => {
      const condition = options?.query?.condition
      const map: Record<string, number> = { NM: 10000, LP: 8700, MP: 7300, HP: 5700, DMG: 3000 }
      return { chosen: { source: "cardmarket", gbp_market: 10000 }, condition_adjusted: map[String(condition)] }
    })
    const prices = await api.getConditionPrices("c1", "holo")
    expect(prices.NM).toEqual({ pence: 10000, basis: "comp", source: "cardmarket" })
    expect(prices.LP).toEqual({ pence: 8700, basis: "estimated", source: "cardmarket" })
    expect(prices.DMG?.pence).toBe(3000)
  })

  it("stops at NM when there is no price at all", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue({ chosen: null, condition_adjusted: null })
    const prices = await api.getConditionPrices("c1", "")
    expect(send).toHaveBeenCalledTimes(1)
    expect(prices).toEqual({ NM: { pence: null, basis: "comp", source: undefined } })
  })
})

type Call = [string, string, ...unknown[]]

/** A stand-in for pb.collection(name) that records every call. */
function fakeCollections(responses: Record<string, Record<string, unknown>> = {}) {
  const calls: Call[] = []
  vi.spyOn(pb, "collection").mockImplementation(((name: string) => {
    const handler = (method: string) =>
      vi.fn(async (...args: unknown[]) => {
        calls.push([name, method, ...args])
        const r = responses[name]?.[method]
        return typeof r === "function" ? (r as (...a: unknown[]) => unknown)(...args) : (r ?? {})
      })
    return {
      create: handler("create"),
      update: handler("update"),
      delete: handler("delete"),
      getOne: handler("getOne"),
      getList: handler("getList"),
      getFullList: handler("getFullList"),
      getFirstListItem: handler("getFirstListItem"),
    }
  }) as never)
  return calls
}

const GAMES = { games: { getFullList: [{ id: "g_pokemon", key: "pokemon" }, { id: "g_other", key: "other" }, { id: "g_retro", key: "retro" }] } }

describe("saveDeal", () => {
  beforeEach(() => api.resetGameCache())

  const card = (id: string): CardLine => ({
    ...cardLineFromHit(
      { id: "card1", game: "g_pokemon", name: "Charizard", setName: "Base Set", setCode: "base1", number: "4/102", rarity: "", image: "", finishes: [] },
      "holo",
      id
    ),
    priceStatus: "ready",
    prices: { NM: { pence: 10000, basis: "comp", source: "cardmarket" } },
  })

  it("creates the deal with its id, then each line with the game resolved", async () => {
    const calls = fakeCollections(GAMES)
    const draft = {
      ...newDraft("deal00000000001"),
      name: "Sam",
      lines: [customLine({ name: "Beano", category: "comic", marketPence: 500, qty: 2 }, "line0000000000b"), card("line0000000000a")],
    }
    await api.saveDeal(null, draft)
    const writes = calls.filter(([n]) => n !== "games")
    expect(writes[0]).toEqual([
      "trade_ins",
      "create",
      expect.objectContaining({ id: "deal00000000001", status: "draft", deal_name: "Sam", customer: "", trade_pct: 80, cash_pct: 70, trade_override_kind: "" }),
    ])
    // Oldest line first: the screen shows the newest on top.
    expect(writes[1]).toEqual([
      "trade_in_lines",
      "create",
      expect.objectContaining({ id: "line0000000000a", kind: "single", card: "card1", game: "g_pokemon", condition: "NM", market_price: 10000, market_source: "cardmarket", accepted: true, trade_pct: null }),
    ])
    expect(writes[2]).toEqual([
      "trade_in_lines",
      "create",
      expect.objectContaining({ id: "line0000000000b", kind: "other", game: "g_other", free_text_title: "Beano", qty: 2, market_source: "staff_entered" }),
    ])
  })

  it("writes only what changed, and deletes removed lines", async () => {
    const before = { ...newDraft("deal00000000001"), lines: [card("a"), card("b")] }
    let after = dealReducer(before, { type: "setLineRate", lineId: "a", side: "trade", pct: 75 })
    after = dealReducer(after, { type: "removeLine", lineId: "b" })
    after = dealReducer(after, { type: "setOverride", side: "cash", override: { kind: "pct", pct: 60 } })
    const calls = fakeCollections(GAMES)
    await api.saveDeal(before, after)
    const writes = calls.filter(([n]) => n !== "games")
    expect(writes).toEqual([
      ["trade_ins", "update", "deal00000000001", expect.objectContaining({ cash_override_kind: "pct", cash_override_pct: 60, cash_override_pence: 0 })],
      ["trade_in_lines", "update", "a", expect.objectContaining({ trade_pct: 75, cash_pct: null })],
      ["trade_in_lines", "delete", "b"],
    ])
  })

  it("writes nothing when nothing changed", async () => {
    const draft = { ...newDraft("d"), lines: [card("a")] }
    const calls = fakeCollections(GAMES)
    await api.saveDeal(draft, { ...draft })
    expect(calls).toEqual([])
  })
})

describe("getDeal", () => {
  beforeEach(() => api.resetGameCache())

  it("reads a completed deal back with its seller, rates, overrides and lines", async () => {
    fakeCollections({
      ...GAMES,
      trade_ins: {
        getOne: {
          id: "d1",
          status: "completed",
          number: "GG-BI-000002",
          deal_name: "Sam",
          trade_pct: 85,
          cash_pct: 65,
          trade_override_kind: "amount",
          trade_override_pence: 12000,
          payout_type: "mixed",
          payout_cash: 5000,
          payout_credit: 6324,
          deal_trade_total: 12000,
          deal_cash_total: 10570,
          calculated_trade: 12590,
          completed_at: "2026-11-09 15:00:00.000Z",
          created: "x",
          updated: "y",
          expand: { customer: { id: "c1", name: "Sam Hill", code: "GGC1" } },
        },
      },
      trade_in_lines: {
        getFullList: [
          { id: "l1", trade_in: "d1", card: "card1", game: "g_pokemon", finish: "holo", condition: "LP", qty: 1, market_price: 27873, trade_pct: 90, cash_pct: null, created: "x", expand: { card: { id: "card1", game: "g_pokemon", name: "Charizard", number: "4/102", expand: { set: { name: "Base Set" } } } } },
          { id: "l2", trade_in: "d1", kind: "retro", game: "g_retro", free_text_title: "Pokemon Yellow", qty: 1, market_price: 6499, created: "x" },
        ],
      },
    })
    const draft = await api.getDeal("d1")
    expect(draft).toMatchObject({
      name: "Sam",
      status: "completed",
      rates: { tradePct: 85, cashPct: 65 },
      overrides: { trade: { kind: "amount", pence: 12000 }, cash: null },
      seller: { id: "c1", name: "Sam Hill" },
      completed: { number: "GG-BI-000002", payout: { type: "mixed", cash: 5000, credit: 6324 }, tradeOverridden: true, calculatedTrade: 12590 },
    })
    expect(draft!.lines[0]).toMatchObject({ kind: "card", name: "Charizard", setName: "Base Set", condition: "LP", manualMarket: 27873, tradePct: 90 })
    expect(draft!.lines[0]).not.toHaveProperty("cashPct")
    expect(draft!.lines[1]).toMatchObject({ kind: "custom", category: "retro", game: "retro", name: "Pokemon Yellow" })
  })

  it("returns null for a deal that is not there", async () => {
    fakeCollections({
      trade_ins: { getOne: () => Promise.reject(new ClientResponseError({ status: 404, response: {} })) },
    })
    expect(await api.getDeal("nope")).toBeNull()
  })
})

describe("completeDeal", () => {
  it("posts the split and maps the result", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue({
      trade_in: { id: "d1", number: "GG-BI-000002", status: "completed", payout_type: "mixed", cash_taken: 5000, credit_given: 6324 },
      items: [{ id: "i1", sku: "GGS7F3K2Q", title: "Charizard" }],
      labels_queued: 1,
    })
    const result = await api.completeDeal("d1", { cash_taken: 5000, credit_given: 6324, terms_accepted: true, id_check: null })
    expect(send).toHaveBeenCalledWith("/api/vault/deals/d1/complete", {
      method: "POST",
      body: { cash_taken: 5000, credit_given: 6324, terms_accepted: true, id_check: null },
    })
    expect(result).toEqual({
      tradeIn: { id: "d1", number: "GG-BI-000002", payoutType: "mixed", cashTaken: 5000, creditGiven: 6324 },
      items: [{ id: "i1", sku: "GGS7F3K2Q", title: "Charizard" }],
      labelsQueued: 1,
    })
  })
})

describe("explain", () => {
  it("passes the hooks' own messages through", () => {
    const error = new ClientResponseError({ status: 422, response: { message: "Take a photo of the customer's ID before paying cash." } })
    expect(api.explain(error)).toBe("Take a photo of the customer's ID before paying cash.")
  })

  it("says what to do when the server cannot be reached", () => {
    expect(api.explain(new ClientResponseError({ status: 0, response: {} }))).toMatch(/Could not reach the server/)
  })

  it("replaces PocketBase's generic wording", () => {
    const error = new ClientResponseError({ status: 400, response: { message: "Failed to create record." } })
    expect(api.explain(error)).toBe("The server refused those details. Check them and try again.")
  })
})
