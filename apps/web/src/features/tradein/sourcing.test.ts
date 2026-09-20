import { describe, expect, it } from "vitest"
import { DEFAULT_OFFER_SETTINGS, type PricingRule } from "@gg/shared/pricing"

import {
  lineOffer,
  marketSourceLabel,
  toLineInputs,
  totals,
  BULK_SOURCE,
  MANUAL_SOURCE,
  PENDING_SOURCE,
  type TradeLine,
} from "@/features/tradein/machine"
import { DEMO_PRICING_RULES } from "@/lib/api/demo/tradeins"

/**
 * Where a buy-in line's market value came from.
 *
 * The figure itself now arrives from the price routes rather than from the
 * staff member's keyboard, so these cover the two things that changes: what
 * the line says about the source, and what it writes to `market_source` when
 * the draft is saved. The offer maths is deliberately unchanged, and the last
 * group here is what proves it.
 */

const RULES: PricingRule[] = DEMO_PRICING_RULES
const SETTINGS = DEFAULT_OFFER_SETTINGS

function line(patch: Partial<TradeLine> = {}): TradeLine {
  return {
    key: "k1",
    kind: "single",
    title: "Charizard ex",
    cardId: "card_sv151_199",
    gameKey: "pokemon",
    condition: "NM",
    qty: 1,
    marketPence: 31_699,
    marketSource: "cardmarket",
    accepted: true,
    ...patch,
  }
}

describe("marketSourceLabel", () => {
  it("names every source the contract names", () => {
    expect(marketSourceLabel("uk_sold_manual")).toBe("UK sold comp")
    expect(marketSourceLabel("ebay_uk_asking")).toBe("eBay UK asking")
    expect(marketSourceLabel("cardmarket")).toBe("Cardmarket")
    expect(marketSourceLabel("tcgplayer")).toBe("TCGplayer")
    expect(marketSourceLabel("pricecharting_pal")).toBe("PriceCharting PAL")
    expect(marketSourceLabel("pricecharting_ntsc")).toBe("PriceCharting NTSC")
  })

  it("credits OPTCG for a One Piece price stored under tcgplayer", () => {
    expect(marketSourceLabel("tcgplayer", "onepiece")).toBe("TCGplayer (OPTCG)")
  })

  it("reads a line still waiting on the lookup as manual", () => {
    expect(marketSourceLabel(PENDING_SOURCE)).toBe(MANUAL_SOURCE)
    expect(marketSourceLabel("")).toBe(MANUAL_SOURCE)
    expect(marketSourceLabel(BULK_SOURCE)).toBe(BULK_SOURCE)
  })
})

describe("what a sourced line saves", () => {
  it("writes the source key to market_source", () => {
    const [input] = toLineInputs([line()], RULES, SETTINGS, "cash")
    expect(input?.marketSource).toBe("cardmarket")
    expect(input?.marketPrice).toBe(31_699)
  })

  it("saves a line the routes never answered for as a manual figure", () => {
    const [input] = toLineInputs(
      [line({ marketSource: PENDING_SOURCE, marketPence: 0 })],
      RULES,
      SETTINGS,
      "cash"
    )
    expect(input?.marketSource).toBe(MANUAL_SOURCE)
  })

  it("keeps a typed figure manual", () => {
    const [input] = toLineInputs(
      [line({ marketSource: MANUAL_SOURCE, marketPence: 10_000 })],
      RULES,
      SETTINGS,
      "cash"
    )
    expect(input?.marketSource).toBe(MANUAL_SOURCE)
  })

  it("carries the reason for a source a staff member picked", () => {
    const [input] = toLineInputs(
      [
        line({
          marketSource: "tcgplayer",
          marketPence: 31_575,
          overrideReason: "Cardmarket is one seller's week",
        }),
      ],
      RULES,
      SETTINGS,
      "cash"
    )
    expect(input?.overrideReason).toBe("Cardmarket is one seller's week")
    // The figure paid is still the band's, not a hand-typed one: picking a
    // source changes the market, never the percentage.
    expect(input?.overrideCash).toBeUndefined()
    expect(input?.offerPrice).toBe(lineOffer(line({ marketPence: 31_575 }), RULES, SETTINGS).cash)
  })
})

describe("the offer over a sourced market", () => {
  it("prices a sourced line exactly as a typed one of the same value", () => {
    const sourced = lineOffer(line({ marketSource: "cardmarket" }), RULES, SETTINGS)
    const typed = lineOffer(line({ marketSource: MANUAL_SOURCE }), RULES, SETTINGS)
    expect(sourced).toEqual(typed)
  })

  it("still takes the condition off the market before the band", () => {
    const nm = lineOffer(line({ condition: "NM" }), RULES, SETTINGS)
    const lp = lineOffer(line({ condition: "LP" }), RULES, SETTINGS)
    expect(lp.cash).toBeLessThan(nm.cash)
    expect(lp.credit).toBeLessThan(nm.credit)
  })

  it("offers nothing at all for a line the routes have not answered for", () => {
    // Not the bulk rate: a card waiting on its price is not a penny card,
    // and a real offer for a figure that is about to arrive is worse than
    // no offer at all.
    const offer = lineOffer(
      line({ marketSource: PENDING_SOURCE, marketPence: 0 }),
      RULES,
      SETTINGS
    )
    expect(offer.cash).toBe(0)
    expect(offer.credit).toBe(0)
    expect(offer.source).toBe("none")
    expect(
      totals([line({ marketPence: 0, marketSource: PENDING_SOURCE })], RULES, SETTINGS)
        .market
    ).toBe(0)
  })

  it("still takes an override on a line that is waiting", () => {
    const offer = lineOffer(
      line({
        marketSource: PENDING_SOURCE,
        marketPence: 0,
        overrideCash: 1200,
        overrideCredit: 1500,
        overrideReason: "Agreed at the counter",
      }),
      RULES,
      SETTINGS
    )
    expect(offer.cash).toBe(1200)
    expect(offer.source).toBe("override")
  })
})
