import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { addManyToDealHref } from "@/features/scan/addToDeal"

import * as api from "./api"
import { addScannedCards, MAX_SCAN_ADDS, parseScanAdds, scanSearch } from "./scan-adds"
import { newDraft } from "./state"
import type { CardHit, CardLine } from "./types"
import { useDealBuilder } from "./useDealBuilder"

const card = (id: string, name = id): CardHit => ({
  id,
  game: "g_pokemon",
  name,
  setName: "Base Set",
  setCode: "base1",
  number: "4/102",
  rarity: "",
  image: "",
  finishes: ["holo"],
})

describe("parseScanAdds", () => {
  it("reads one card, NM when no condition is sent", () => {
    expect(parseScanAdds("abc")).toEqual([{ cardId: "abc", condition: "NM", qty: 1 }])
  })

  it("reads a batch with conditions by position, merging repeats into a quantity", () => {
    expect(parseScanAdds("a,b,b", "NM,LP,LP")).toEqual([
      { cardId: "a", condition: "NM", qty: 1 },
      { cardId: "b", condition: "LP", qty: 2 },
    ])
  })

  it("keeps the same card in two conditions apart", () => {
    expect(parseScanAdds("b,b", "LP,MP")).toEqual([
      { cardId: "b", condition: "LP", qty: 1 },
      { cardId: "b", condition: "MP", qty: 1 },
    ])
  })

  it("treats a missing, short or unknown condition list as NM", () => {
    expect(parseScanAdds("a,b,c", "lp,,MINT")).toEqual([
      { cardId: "a", condition: "LP", qty: 1 },
      { cardId: "b", condition: "NM", qty: 1 },
      { cardId: "c", condition: "NM", qty: 1 },
    ])
    expect(parseScanAdds("a,b", "HP")).toEqual([
      { cardId: "a", condition: "HP", qty: 1 },
      { cardId: "b", condition: "NM", qty: 1 },
    ])
  })

  it("skips empty entries and nonsense", () => {
    expect(parseScanAdds(" a , ,b,", "DMG,,NM")).toEqual([
      { cardId: "a", condition: "DMG", qty: 1 },
      { cardId: "b", condition: "NM", qty: 1 },
    ])
    expect(parseScanAdds(undefined)).toEqual([])
    expect(parseScanAdds("")).toEqual([])
  })

  it("caps a runaway list", () => {
    const ids = Array.from({ length: MAX_SCAN_ADDS + 50 }, (_, i) => `c${i}`).join(",")
    expect(parseScanAdds(ids)).toHaveLength(MAX_SCAN_ADDS)
  })

  it("round-trips the Scan feature's own links", () => {
    const href = addManyToDealHref(null, [
      { cardId: "a", condition: "NM" },
      { cardId: "b", condition: "LP" },
      { cardId: "b", condition: "LP" },
    ])
    expect(href.startsWith("/deals?")).toBe(true)
    const params = new URLSearchParams(href.split("?")[1])
    expect(parseScanAdds(params.get("add"), params.get("condition"))).toEqual([
      { cardId: "a", condition: "NM", qty: 1 },
      { cardId: "b", condition: "LP", qty: 2 },
    ])
    expect(addManyToDealHref("deal1", [{ cardId: "a", condition: "MP" }])).toBe("/deals/deal1?add=a&condition=MP")
  })
})

describe("scanSearch", () => {
  it("keeps the params as strings, even an all-digit id", () => {
    expect(scanSearch({ add: 12345, condition: "NM" })).toEqual({ add: "12345", condition: "NM" })
    expect(scanSearch({ add: "", other: "x" })).toEqual({ add: undefined, condition: undefined })
  })
})

describe("addScannedCards", () => {
  it("loads each card once and adds every one in order with its condition and quantity", async () => {
    const getCard = vi.fn(async (id: string) => card(id, `Card ${id}`))
    const addCard = vi.fn()
    const outcome = await addScannedCards(parseScanAdds("a,b,b,a", "NM,LP,LP,NM"), getCard, addCard)
    expect(getCard).toHaveBeenCalledTimes(2)
    expect(addCard.mock.calls.map(([hit, variant, condition, qty]) => [hit.id, variant, condition, qty])).toEqual([
      ["a", "holo", "NM", 2],
      ["b", "holo", "LP", 2],
    ])
    expect(outcome).toMatchObject({ added: 4, missing: 0, failed: 0, onlyName: null })
  })

  it("names a single card", async () => {
    const outcome = await addScannedCards(parseScanAdds("a"), async () => card("a", "Charizard"), vi.fn())
    expect(outcome.onlyName).toBe("Charizard")
  })

  it("carries on past a card that is missing or fails to load", async () => {
    const getCard = vi.fn(async (id: string) => {
      if (id === "gone") return null
      if (id === "boom") throw new Error("Could not reach the server.")
      return card(id)
    })
    const addCard = vi.fn()
    const outcome = await addScannedCards(parseScanAdds("a,gone,boom,c"), getCard, addCard)
    expect(addCard).toHaveBeenCalledTimes(2)
    expect(outcome).toMatchObject({ added: 2, missing: 1, failed: 1 })
    expect((outcome.error as Error).message).toBe("Could not reach the server.")
  })
})

describe("useDealBuilder.addCard", () => {
  it("adds a scanned card at its condition and quantity", async () => {
    vi.spyOn(api, "getConditionPrices").mockResolvedValue({ NM: { pence: 1000, basis: "comp" }, LP: { pence: 800, basis: "estimated" } })
    vi.spyOn(api, "saveDeal").mockResolvedValue(undefined)
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDealBuilder(newDraft("scan")), { wrapper })
    act(() => result.current.addCard(card("b"), "holo", "LP", 2))
    await waitFor(() => expect((result.current.draft.lines[0] as CardLine).priceStatus).toBe("ready"))
    expect(result.current.draft.lines[0]).toMatchObject({ cardId: "b", condition: "LP", qty: 2 })
  })
})
