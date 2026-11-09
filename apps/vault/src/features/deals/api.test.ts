import { describe, expect, it, vi } from "vitest"

import { pb } from "@/lib/pb"

import * as api from "./api"
import { dealReducer, newDraft } from "./state"

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

describe("local drafts", () => {
  it("saves, lists newest first, and deletes", async () => {
    await api.saveDeal(newDraft("a"), new Date("2026-11-09T10:00:00Z"))
    await api.saveDeal(newDraft("b"), new Date("2026-11-09T11:00:00Z"))
    expect((await api.listDeals()).map((d) => d.id)).toEqual(["b", "a"])
    expect((await api.getDeal("a"))?.updatedAt).toBe("2026-11-09T10:00:00.000Z")
    await api.deleteDeal("a")
    expect(await api.getDeal("a")).toBeNull()
  })

  it("completes a credit deal", async () => {
    const done = dealReducer(newDraft("c"), { type: "complete", at: "2026-11-09T12:00:00Z" })
    const saved = await api.completeDeal(done)
    expect(saved.status).toBe("completed")
  })

  it("refuses to complete any cash payout while the server ID check is not wired", async () => {
    const draft = {
      ...newDraft("d"),
      lines: [{ id: "x", kind: "custom" as const, name: "Lot", category: "other" as const, manualMarket: 1000, qty: 1 }],
      payout: { type: "mixed" as const, cashTaken: 1 },
    }
    const done = dealReducer(draft, { type: "complete", at: "2026-11-09T12:00:00Z" })
    expect(done.completed?.payout.cash).toBe(1)
    await expect(api.completeDeal(done)).rejects.toThrow(/ID on file/)
    expect(await api.getDeal("d")).toBeNull()
  })
})
