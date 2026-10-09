import { describe, expect, it } from "vitest"
import { researchWords } from "@gg/shared"

import { cardTarget, itemTarget, lineTarget } from "@/features/research/targets"
import type { TradeLine } from "@/features/tradein/machine"
import type { CardHit, ItemDetail } from "@/lib/api/types"

/**
 * What a trade-in line, an item and a price-check card search eBay for and
 * ask an agent about: the right words, and the right catalogue row, finish
 * and condition, so the comps that come back land where the line reads.
 */

function line(patch: Partial<TradeLine>): TradeLine {
  return {
    key: "line_a",
    kind: "single",
    title: "Charizard ex",
    qty: 1,
    marketPence: 0,
    marketSource: "",
    accepted: true,
    ...patch,
  }
}

describe("lineTarget", () => {
  it("asks about a card line's card, finish and condition, by its saved line", () => {
    const target = lineTarget(
      line({ id: "tl_1", cardId: "card_1", setName: "Scarlet & Violet 151", number: "199/165", finish: "holo", condition: "LP" })
    )
    expect(target.card).toBe("card_1")
    expect(target.tradeInLine).toBe("tl_1")
    expect(target.finish).toBe("holo")
    expect(target.condition).toBe("LP")
    expect(researchWords(target.subject)).toBe("Charizard ex Scarlet & Violet 151 199/165 holo")
  })

  it("reads a retro line's completeness from its condition", () => {
    const target = lineTarget(line({ kind: "retro", title: "Super Mario Kart", retroTitleId: "retro_smk", condition: "cib" }))
    expect(target.retroTitle).toBe("retro_smk")
    expect(target.card).toBeUndefined()
    expect(target.finish).toBe("cib")
    expect(target.condition).toBeUndefined()
    expect(researchWords(target.subject)).toBe("Super Mario Kart complete")
  })

  it("searches a sealed line by its title alone", () => {
    const target = lineTarget(line({ kind: "sealed", title: "Surging Sparks Elite Trainer Box" }))
    expect(target.card).toBeUndefined()
    expect(researchWords(target.subject)).toBe("Surging Sparks Elite Trainer Box")
  })
})

describe("itemTarget", () => {
  it("asks about the item, and says a graded card's grade", () => {
    const item = {
      id: "item_1",
      sku: "GGG1A2B3C",
      kind: "graded",
      game: "game_pokemon",
      card: "card_1",
      title: "Umbreon VMAX",
      number: "215/203",
      finish: "holo",
      grade_company: "PSA",
      grade: "10",
    } as ItemDetail
    const target = itemTarget(item)
    expect(target.item).toBe("item_1")
    expect(target.card).toBe("card_1")
    expect(researchWords(target.subject)).toBe("Umbreon VMAX 215/203 holo PSA 10")
  })
})

describe("cardTarget", () => {
  it("asks about a price-check card in the finish on screen, near mint", () => {
    const card = {
      id: "card_sv151_199",
      name: "Charizard ex",
      number: "199/165",
      setName: "Scarlet & Violet 151",
      finishes: ["normal", "holo"],
    } as CardHit
    const target = cardTarget(card, "normal")
    expect(target).toMatchObject({ card: "card_sv151_199", finish: "normal", condition: "NM" })
    expect(researchWords(target.subject)).toBe("Charizard ex Scarlet & Violet 151 199/165")
  })
})
