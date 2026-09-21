import { describe, expect, it } from "vitest"

import {
  addStockSchema,
  defaultFinish,
  finishesFor,
} from "@/features/stock/schema"

const single = {
  gameId: "game_pokemon",
  kind: "single" as const,
  cardId: "card_sv151_199",
  setCode: "sv151",
  number: "199/165",
  finish: "holo",
  condition: "NM" as const,
  qty: 1,
  cost: "180.00",
  price: "324.99",
  locationId: "loc_showcase",
}

function errorsFor(input: unknown): Record<string, string> {
  const result = addStockSchema.safeParse(input)
  if (result.success) return {}
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join("."), issue.message])
  )
}

describe("addStockSchema", () => {
  it("accepts a complete single", () => {
    const result = addStockSchema.safeParse(single)
    expect(result.success).toBe(true)
  })

  it("needs a game", () => {
    expect(errorsFor({ ...single, gameId: "" }).gameId).toMatch(/Choose the game/)
  })

  it("needs a card chosen for a single", () => {
    expect(errorsFor({ ...single, cardId: undefined }).cardId).toMatch(
      /Search the set and number/
    )
  })

  it("needs a condition for a card", () => {
    expect(errorsFor({ ...single, condition: undefined }).condition).toMatch(
      /Pick a condition/
    )
  })

  it("needs completeness for retro rather than a condition", () => {
    const retro = {
      ...single,
      kind: "retro" as const,
      cardId: undefined,
      title: "GoldenEye 007",
      condition: undefined,
    }
    expect(errorsFor(retro).completeness).toMatch(/loose, boxed or complete/)
    expect(errorsFor({ ...retro, completeness: "cib" })).toEqual({})
  })

  it("needs a title when there is no card to name the item", () => {
    expect(
      errorsFor({ ...single, kind: "sealed", cardId: undefined, title: "" }).title
    ).toMatch(/Give the item a title/)
  })

  it("keeps singles to one per row", () => {
    expect(errorsFor({ ...single, qty: 3 }).qty).toMatch(/one row each/)
  })

  it("lets sealed lines carry a quantity", () => {
    expect(
      errorsFor({
        ...single,
        kind: "sealed",
        cardId: undefined,
        title: "Surging Sparks ETB",
        condition: undefined,
        qty: 6,
      })
    ).toEqual({})
  })

  it.each(["", "abc", "4.567", "£", "1.2.3", "12p"])("rejects %j as money", (value) => {
    expect(errorsFor({ ...single, cost: value }).cost).toBeTruthy()
  })

  it.each(["0", "4.5", "4.50", "1234.56", "£12.99", "1,234.56"])(
    "accepts %j as money",
    (value) => {
      expect(errorsFor({ ...single, cost: value }).cost).toBeUndefined()
    }
  )

  it("refuses a negative amount", () => {
    expect(errorsFor({ ...single, price: "-1.00" }).price).toMatch(/cannot be negative/)
  })

  it.each(["1234567", "12345678901234567", "50600ABCDE123"])(
    "rejects %j as an EAN",
    (value) => {
      expect(errorsFor({ ...single, ean: value }).ean).toMatch(/8 to 14 digits/)
    }
  )

  it("allows a blank EAN", () => {
    expect(errorsFor({ ...single, ean: "" }).ean).toBeUndefined()
  })

  it("stops notes at 200 characters", () => {
    expect(errorsFor({ ...single, notes: "x".repeat(201) }).notes).toMatch(/200/)
    expect(errorsFor({ ...single, notes: "x".repeat(200) }).notes).toBeUndefined()
  })

  it("turns the typed amount into pence downstream, not into a float", () => {
    const parsed = addStockSchema.parse({ ...single, cost: "4.50" })
    expect(parsed.cost).toBe("4.50")
  })
})

describe("finishesFor", () => {
  it("shows only the finishes a card exists in", () => {
    expect(finishesFor(["normal", "holo"]).map((finish) => finish.value)).toEqual([
      "normal",
      "holo",
    ])
  })

  it("falls back to the full list when the catalogue does not say", () => {
    expect(finishesFor(undefined).length).toBeGreaterThan(2)
    expect(finishesFor([]).length).toBeGreaterThan(2)
  })

  it("falls back rather than showing nothing for an unknown finish", () => {
    expect(finishesFor(["mystery"]).length).toBeGreaterThan(2)
  })
})


describe("defaultFinish", () => {
  /**
   * Every price route matches `price_snapshots.finish` exactly, so a card
   * chosen with no finish finds no snapshots and reads as worthless. Add
   * stock and price check both land on a real finish the moment a card is
   * picked.
   */
  it("takes the card's own first printing", () => {
    expect(defaultFinish(["holo", "normal"])).toBe("holo")
    expect(defaultFinish(["normal", "reverse"])).toBe("normal")
  })

  it("skips a printing this app has no name for", () => {
    expect(defaultFinish(["borderless", "foil"])).toBe("foil")
  })

  it("falls back to normal for a card that lists none, like a manual one", () => {
    expect(defaultFinish([])).toBe("normal")
    expect(defaultFinish(undefined)).toBe("normal")
  })

  it("never answers with an empty string", () => {
    for (const available of [[], undefined, ["nonsense"], ["holo"]]) {
      expect(defaultFinish(available)).not.toBe("")
    }
  })
})
