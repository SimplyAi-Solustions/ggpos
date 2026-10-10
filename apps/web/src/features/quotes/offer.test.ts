import { describe, expect, it } from "vitest"
import { DEFAULT_CONDITION_MULTIPLIERS, type PricingRule } from "@gg/shared/pricing"

import { offerProblem, quoteOfferTotal, toQuoteLines } from "@/features/quotes/offer"
import {
  BULK_SOURCE,
  MANUAL_SOURCE,
  PENDING_SOURCE,
  type TradeLine,
} from "@/features/tradein/machine"

const SETTINGS = {
  bulkThreshold: 100,
  bulkCash: 5,
  bulkCredit: 10,
  minimumOffer: 25,
}

/** One band: 50 percent cash, 65 percent credit, rounded to 50p. */
const RULES: PricingRule[] = [
  {
    id: "rule_single",
    game: null,
    kind: "single",
    condition: null,
    finish: null,
    rarity: null,
    bandMin: 0,
    bandMax: null,
    cashPct: 50,
    creditPct: 65,
    rounding: 50,
    priority: 10,
    active: true,
  },
]

function line(patch: Partial<TradeLine> = {}): TradeLine {
  return {
    key: "line_1",
    kind: "single",
    title: "Charizard ex",
    cardId: "card_sv151_199",
    gameId: "game_pokemon",
    condition: "NM",
    finish: "holo",
    qty: 1,
    marketPence: 10_000,
    marketSource: "cardmarket",
    accepted: true,
    ...patch,
  }
}

function convert(lines: TradeLine[]) {
  return toQuoteLines(lines, RULES, SETTINGS, DEFAULT_CONDITION_MULTIPLIERS)
}

describe("toQuoteLines", () => {
  it("sends the cash offer, not the credit one", () => {
    const [sent] = convert([line()])
    expect(sent).toMatchObject({
      card: "card_sv151_199",
      title: "Charizard ex",
      condition: "NM",
      finish: "holo",
      qty: 1,
      market_price: 10_000,
      market_source: "cardmarket",
      // 50 percent of £100, which is the cash band, not the 65 percent credit one.
      offer_price: 5000,
      kind: "single",
      game: "game_pokemon",
    })
  })

  it("carries a kind and a game on every line, so it can be received", () => {
    // The received route can only infer these for a card or a retro line.
    // A sealed box, a graded slab and a typed-in title cannot be received
    // without them, whatever the customer has accepted.
    const sent = convert([
      line({ key: "sealed", kind: "sealed", title: "Surging Sparks ETB", cardId: undefined }),
      line({ key: "graded", kind: "graded" }),
      line({
        key: "typed",
        kind: "retro",
        title: "Mario Kart 64",
        cardId: undefined,
        retroTitleId: undefined,
        gameId: "game_retro",
        condition: "cib",
      }),
    ])
    expect(sent.map((entry) => entry.kind)).toEqual(["sealed", "graded", "retro"])
    expect(sent.map((entry) => entry.game)).toEqual([
      "game_pokemon",
      "game_pokemon",
      "game_retro",
    ])
  })

  it("keeps the quantity, so the route's own total multiplies once", () => {
    const sent = convert([line({ qty: 3 })])
    expect(sent[0]?.qty).toBe(3)
    expect(quoteOfferTotal(sent)).toBe(15_000)
  })

  it("sends a lot as one line at quantity one, with the count in the title", () => {
    const sent = convert([
      line({
        key: "lot",
        kind: "bulk",
        title: "Bulk lot, 400 cards",
        cardId: undefined,
        qty: 400,
        bulkOffer: 2000,
        marketPence: 2000,
        marketSource: BULK_SOURCE,
      }),
    ])
    expect(sent[0]).toMatchObject({
      title: "Bulk lot, 400 cards",
      qty: 1,
      offer_price: 2000,
      market_source: BULK_SOURCE,
      // `trade_in_lines.kind` has no "bulk": a lot is one row on the shelf.
      kind: "other",
      game: "game_pokemon",
    })
    // £20 for the lot, never £20 x 400.
    expect(quoteOfferTotal(sent)).toBe(2000)
  })

  it("writes a line whose lookup never answered out as a manual figure", () => {
    const sent = convert([line({ marketSource: PENDING_SOURCE, marketPence: 4000 })])
    expect(sent[0]?.market_source).toBe(MANUAL_SOURCE)
  })

  it("carries an override straight through", () => {
    const sent = convert([
      line({ overrideCash: 7500, overrideCredit: 9000, overrideReason: "Signed" }),
    ])
    expect(sent[0]?.offer_price).toBe(7500)
  })

  it("leaves a line that was taken off the buy-in out of the offer", () => {
    expect(convert([line({ accepted: false })])).toHaveLength(0)
  })

  it("sends a retro line with its completeness as the condition", () => {
    const sent = convert([
      line({
        kind: "retro",
        title: "Super Mario World",
        cardId: undefined,
        retroTitleId: "retro_smw",
        condition: "cib",
        finish: undefined,
        marketSource: "pricecharting_pal",
      }),
    ])
    expect(sent[0]).toMatchObject({
      retro_title: "retro_smw",
      condition: "cib",
      market_source: "pricecharting_pal",
    })
  })
})

describe("offerProblem", () => {
  it("asks for a line before anything is sent", () => {
    expect(offerProblem([])).toBe(
      "Add a line for each thing in the photos before you send the offer."
    )
  })

  it("names the line whose price has not landed yet", () => {
    // A line still waiting on its price lookup is worth nothing until the
    // figure arrives, which is exactly what `lineOffer` refuses to price.
    const lines = convert([
      line(),
      line({ key: "b", marketPence: 0, marketSource: PENDING_SOURCE }),
    ])
    expect(lines[1]?.offer_price).toBe(0)
    expect(offerProblem(lines)).toBe(
      "Line 2 has no offer on it. Price it, or override the offer."
    )
  })

  it("still prices a line with no market at the shop's own bulk rate", () => {
    // Not a hole: £0 is under the bulk threshold, so the band pays the bulk
    // figure rather than nothing, and the offer can be sent.
    const lines = convert([line({ marketPence: 0, marketSource: MANUAL_SOURCE })])
    expect(lines[0]?.offer_price).toBe(SETTINGS.bulkCash)
    expect(offerProblem(lines)).toBeNull()
  })

  it("is happy with a priced offer", () => {
    expect(offerProblem(convert([line()]))).toBeNull()
  })

  it("names a line that could never be received, before it is offered", () => {
    const lines = convert([
      line({
        kind: "sealed",
        title: "Surging Sparks ETB",
        cardId: undefined,
        gameId: "",
        // Priced by hand, so it is the missing game and nothing else that
        // holds the offer back.
        overrideCash: 3000,
        overrideCredit: 3600,
        overrideReason: "Sealed, priced against the shelf",
      }),
    ])
    expect(offerProblem(lines)).toBe(
      "Line 1 has no game on it. Pick the game and try again."
    )
  })

  it("lets a card line through without a game of its own", () => {
    // The received route reads the card's game for it.
    const lines = convert([line({ gameId: "" })])
    expect(offerProblem(lines)).toBeNull()
  })
})
