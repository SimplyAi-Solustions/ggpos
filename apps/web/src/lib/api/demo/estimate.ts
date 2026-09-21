import {
  computeOffer,
  DEFAULT_CONDITION_MULTIPLIERS,
  type CardCondition,
} from "@gg/shared/pricing"

import { DEMO_CARDS } from "@/lib/api/fixtures"
import { DEMO_OFFER_SETTINGS, DEMO_PRICING_RULES } from "@/lib/api/demo/tradeins"
import { parseCardQuery, cardMatches } from "@/lib/api/query"
import type { EstimateCardHit, EstimateResult } from "@/lib/api/types"

/**
 * The public estimate, answered from the demo catalogue.
 *
 * The bands come out of the same shared offer calculator the counter and the
 * server use, so a demo estimate and a real one are the same arithmetic on
 * different numbers. The market value is a fixed figure per card rather than
 * a random one, so the page reads the same on every run.
 */

/**
 * A deterministic market value per demo card, in integer GBP pence.
 *
 * `card_blb_223` is deliberately absent: the real route answers a card with
 * no cached price with a null market and two null bands rather than a
 * fabricated zero, and the demo has to be able to show that too.
 */
const DEMO_MARKET: Record<string, number> = {
  card_sv151_199: 32000,
  card_sv151_201: 11000,
  card_sv151_205: 6000,
  card_sv151_025: 180,
  card_sv8_113: 4800,
}

/**
 * When the demo price cache was written.
 *
 * A literal, not "yesterday": a screenshot taken on two different days has
 * to read the same, and an end-to-end test that asserts the line under the
 * bands cannot chase a moving date.
 */
const DEMO_AS_OF = "2026-09-18T02:40:00.000Z"

export function demoMarketFor(cardId: string): number | null {
  return DEMO_MARKET[cardId] ?? null
}

export function demoEstimateSearch(query: string): EstimateCardHit[] {
  const parsed = parseCardQuery(query)
  if (!parsed.setCode && !parsed.number && !parsed.text) return []
  return DEMO_CARDS.filter((card) => cardMatches(card, parsed))
    .slice(0, 8)
    .map((card) => ({
      id: card.id,
      name: card.name,
      set: card.setName,
      number: card.number,
      image: card.image,
      finishes: card.finishes,
    }))
}

/** The grade one step below the one asked for, which sets the band's low end. */
export const GRADE_BELOW: Record<CardCondition, CardCondition> = {
  NM: "LP",
  LP: "MP",
  MP: "HP",
  HP: "DMG",
  DMG: "DMG",
}

export function demoEstimate(
  cardId: string,
  condition: CardCondition,
  finish: string
): EstimateResult {
  const card = DEMO_CARDS.find((entry) => entry.id === cardId)
  // The same sentence the live route sends for an unresolved card id.
  if (!card) {
    throw new Error("Card not found. Search again or visit the shop for a look in person.")
  }
  const market = demoMarketFor(cardId)
  const shape = {
    name: card.name,
    set: card.setName,
    number: card.number,
    image: card.image,
  }

  if (market === null) {
    return {
      card: shape,
      market: null,
      as_of: null,
      cash: { low: null, high: null },
      credit: { low: null, high: null },
      note: "Subject to inspection in the shop.",
    }
  }

  const at = (grade: CardCondition) =>
    computeOffer(
      market,
      { kind: "single", game: card.gameKey, condition: grade, finish },
      DEMO_PRICING_RULES,
      DEMO_OFFER_SETTINGS,
      DEFAULT_CONDITION_MULTIPLIERS
    )

  const high = at(condition)
  const low = at(GRADE_BELOW[condition])

  return {
    card: shape,
    market,
    as_of: DEMO_AS_OF,
    cash: { low: low.cash, high: high.cash },
    credit: { low: low.credit, high: high.credit },
    note: "Subject to inspection in the shop.",
  }
}
