/**
 * The offer a quote carries, worked out away from the DOM.
 *
 * The lines on the identify step are the buy-in's own `TradeLine`s, priced
 * by the buy-in's own `lineOffer`, so a remote quote and a counter buy-in
 * cannot put different money on the same card. This module is the one place
 * that turns those lines into what `POST /api/vault/quotes/:id/offer` takes.
 *
 * The figure sent is the **cash** offer. A quote is answered from home, out
 * of sight of the counter, so the number the customer accepts has to be the
 * one we can always honour; store credit is worked out again when the items
 * are on the counter and is never lower. `toQuoteLines` therefore mirrors
 * `toLineInputs` with the payout fixed at cash.
 *
 * Every line also carries its `kind` and its `game`. The received route can
 * infer both for a card or a retro line and for nothing else, so a sealed
 * box, a graded slab, a title nobody recognised or a bulk lot would be
 * accepted by the customer and then refused at the counter with "Line N has
 * no game set", leaving the quote stuck at `accepted`. `bulk` is not one of
 * `trade_in_lines.kind`'s values, so a lot goes as `other`, exactly as
 * `toLineInputs` writes it out for a buy-in.
 */
import type { ConditionMultipliers, OfferSettings, PricingRule } from "@gg/shared/pricing"

import {
  BULK_SOURCE,
  MANUAL_SOURCE,
  PENDING_SOURCE,
  bulkTitle,
  itemKindFor,
  lineOffer,
  type TradeLine,
} from "@/features/tradein/machine"
import type { QuoteLine } from "@/lib/api/types"

/**
 * The lines as the offer route takes them.
 *
 * A bulk lot goes on as one line at quantity one with the flat figure as
 * its price, and the card count in its title: the route multiplies
 * `offer_price` by `qty` to get the total, so a lot of 400 cards at £20
 * sent as quantity 400 would offer £8,000.
 */
export function toQuoteLines(
  lines: TradeLine[],
  rules: PricingRule[],
  settings: OfferSettings,
  multipliers: ConditionMultipliers
): QuoteLine[] {
  return lines
    .filter((line) => line.accepted)
    .map((line) => {
      const offer = lineOffer(line, rules, settings, multipliers)

      if (line.kind === "bulk") {
        const flat = line.bulkOffer ?? 0
        return {
          title: bulkTitle(line.qty),
          qty: 1,
          market_price: flat,
          market_source: BULK_SOURCE,
          offer_price: flat,
          kind: itemKindFor(line.kind),
          game: line.gameId,
        }
      }

      return {
        card: line.cardId,
        retro_title: line.retroTitleId,
        title: line.title,
        condition: line.condition,
        finish: line.finish,
        qty: line.qty,
        market_price: line.marketPence,
        // A line whose price lookup never answered is a figure a staff
        // member typed, which is what the buy-in writes out too.
        market_source:
          line.marketSource === PENDING_SOURCE ? MANUAL_SOURCE : line.marketSource,
        offer_price: offer.cash,
        kind: itemKindFor(line.kind),
        game: line.gameId,
      }
    })
}

/** What the offer adds up to: the sum the route recomputes server-side. */
export function quoteOfferTotal(lines: QuoteLine[]): number {
  return lines.reduce((sum, line) => sum + line.offer_price * line.qty, 0)
}

/**
 * Why this offer cannot be sent yet, or null when it can.
 *
 * Every message says what happened and what to do about it, because it
 * lands under the button that refused.
 */
export function offerProblem(lines: QuoteLine[]): string | null {
  if (lines.length === 0) {
    return "Add a line for each thing in the photos before you send the offer."
  }
  const blank = lines.findIndex((line) => line.offer_price <= 0)
  if (blank >= 0) {
    return `Line ${blank + 1} has no offer on it. Price it, or override the offer.`
  }
  // The received route needs a game on any line it cannot infer one from,
  // so the counter catches it here rather than letting the customer accept
  // an offer that cannot be turned into a buy-in.
  const gameless = lines.findIndex(
    (line) => !line.card && !line.retro_title && !line.game
  )
  if (gameless >= 0) {
    return `Line ${gameless + 1} has no game on it. Pick the game and try again.`
  }
  return null
}
