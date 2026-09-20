import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONDITION_MULTIPLIERS,
  DEFAULT_OFFER_SETTINGS,
  type ConditionMultipliers,
  type PricingRule,
} from "@gg/shared/pricing"

import {
  canAdvance,
  hydrate,
  initialState,
  lineOffer,
  marketPatchFor,
  marketSourceLabel,
  toLineInputs,
  totals,
  BULK_SOURCE,
  MANUAL_SOURCE,
  PENDING_SOURCE,
  type TradeLine,
} from "@/features/tradein/machine"
import { DEMO_PRICING_RULES } from "@/lib/api/demo/tradeins"
import type { TradeInRecord } from "@/lib/api"

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


describe("the shop's own condition multipliers", () => {
  /** An admin who has decided LP costs more than the shared default. */
  const HOUSE: ConditionMultipliers = {
    ...DEFAULT_CONDITION_MULTIPLIERS,
    LP: 0.95,
  }

  it("prices a buy-in line through them, not through the defaults", () => {
    const shared = lineOffer(line({ condition: "LP" }), RULES, SETTINGS)
    const house = lineOffer(line({ condition: "LP" }), RULES, SETTINGS, HOUSE)
    // 0.95 of the market rather than 0.85, so the customer is paid more.
    expect(house.cash).toBeGreaterThan(shared.cash)
    expect(house.credit).toBeGreaterThan(shared.credit)
  })

  it("carries them into the totals", () => {
    const lines = [line({ condition: "LP" })]
    expect(totals(lines, RULES, SETTINGS, HOUSE).cash).toBeGreaterThan(
      totals(lines, RULES, SETTINGS).cash
    )
  })

  it("carries them into what is actually saved and paid", () => {
    const [shared] = toLineInputs([line({ condition: "LP" })], RULES, SETTINGS, "cash")
    const [house] = toLineInputs(
      [line({ condition: "LP" })],
      RULES,
      SETTINGS,
      "cash",
      HOUSE
    )
    expect(house?.offerPrice).toBeGreaterThan(shared?.offerPrice ?? 0)
  })

  it("leaves a near-mint line alone, whatever the multipliers say", () => {
    expect(lineOffer(line(), RULES, SETTINGS, HOUSE)).toEqual(
      lineOffer(line(), RULES, SETTINGS)
    )
  })
})

describe("marketPatchFor", () => {
  const view = (gbp: number | null, src = "cardmarket") => ({
    chosen: gbp === null ? null : { gbp_market: gbp, source: src },
  })

  it("writes the chosen figure onto a line that is waiting", () => {
    expect(
      marketPatchFor(line({ marketSource: PENDING_SOURCE, marketPence: 0 }), view(25302))
    ).toEqual({ marketPence: 25302, marketSource: "cardmarket" })
  })

  it("follows a finish change to a new figure", () => {
    expect(marketPatchFor(line({ marketPence: 25302 }), view(31696))).toEqual({
      marketPence: 31696,
      marketSource: "cardmarket",
    })
  })

  it("clears a sourced line when the new finish has no price at all", () => {
    // Otherwise the figure is the old finish's while the note says there is
    // no price, and the offer is for a card nobody is buying.
    expect(marketPatchFor(line({ marketPence: 31696 }), view(null))).toEqual({
      marketPence: 0,
      marketSource: MANUAL_SOURCE,
    })
  })

  it("leaves a typed figure, a picked source and an unanswered route alone", () => {
    expect(
      marketPatchFor(line({ marketSource: MANUAL_SOURCE, marketPence: 999 }), view(25302))
    ).toBeNull()
    expect(
      marketPatchFor(
        line({ marketSource: "tcgplayer", marketPence: 25500, overrideReason: "Closer" }),
        view(25302)
      )
    ).toBeNull()
    expect(marketPatchFor(line(), undefined)).toBeNull()
  })

  it("leaves a line with no catalogue row behind it alone", () => {
    expect(
      marketPatchFor(
        { ...line(), cardId: undefined, retroTitleId: undefined },
        view(25302)
      )
    ).toBeNull()
  })

  it("writes nothing when the figure on the line is already the chosen one", () => {
    expect(marketPatchFor(line({ marketPence: 25302 }), view(25302))).toBeNull()
  })
})

describe("a retro line's own title", () => {
  const retro = (patch: Partial<TradeLine> = {}): TradeLine => ({
    ...line(),
    kind: "retro",
    cardId: undefined,
    retroTitleId: "retro_smk",
    title: "Super Mario Kart",
    condition: "cib",
    ...patch,
  })

  it("reaches trade_in_lines.retro_title", () => {
    const [input] = toLineInputs([retro()], RULES, SETTINGS, "cash")
    expect(input?.retroTitleId).toBe("retro_smk")
    expect(input?.completeness).toBe("cib")
    expect(input?.condition).toBeUndefined()
  })

  it("comes back on a reopened draft, so the line prices itself again", () => {
    const state = hydrate(
      { id: "trade_1", customer: "cust_1", status: "draft" } as TradeInRecord,
      [
        {
          id: "line_1",
          trade_in: "trade_1",
          kind: "retro",
          retro_title: "retro_smk",
          free_text_title: "Super Mario Kart",
          completeness: "cib",
          qty: 1,
          market_price: 8088,
          market_source: "pricecharting_pal",
          accepted: true,
        },
      ],
      null
    )
    expect(state.lines[0]?.retroTitleId).toBe("retro_smk")
    expect(state.lines[0]?.condition).toBe("cib")
  })
})

describe("advancing while a line is still being priced", () => {
  const sums = { market: 0, cash: 0, credit: 0, lines: 1, units: 1 }
  const payout = { type: "credit" as const, cash: 0, credit: 0 }
  const customer = {
    id: "cust_1",
    name: "Jasmine Okafor",
    code: "GGC4K7M2Z",
    email: "",
    phone: "",
    creditBalance: 0,
    facts: { flags: [], idStatus: "none" as const },
  }

  it("holds the wizard on the items step", () => {
    const state = {
      ...initialState,
      step: "items" as const,
      customer,
      lines: [line({ marketSource: PENDING_SOURCE, marketPence: 0 })],
    }
    const advance = canAdvance(state, sums, payout, 800_000)
    expect(advance.ok).toBe(false)
    expect(advance.reason).toBe("One line is still being priced. Give it a moment.")
  })

  it("lets it through once the figure has landed", () => {
    const state = {
      ...initialState,
      step: "items" as const,
      customer,
      lines: [line({ marketSource: "cardmarket", marketPence: 25302 })],
    }
    expect(
      canAdvance(state, { ...sums, market: 25302, cash: 15200 }, payout, 800_000).ok
    ).toBe(true)
  })
})
