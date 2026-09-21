/**
 * The sell price the counter suggests, from the shop's own markup bands.
 *
 * `suggestSellPrice` and the band shape are shared with the server and the
 * admin preview (`packages/shared/src/pricing.ts`); this only feeds it the
 * bands and the retail ending out of settings, so Add stock, the item page
 * and Settings' own preview cannot disagree about what £31.67 should sell
 * for.
 */
import { suggestSellPrice } from "@gg/shared"

import type { PricingSettings } from "@/lib/api/prices"

/**
 * Market times the band's markup, rounded up to the next .49 or .99. Null in,
 * null out: a card with no figure gets no suggestion rather than £0.49.
 */
export function suggestedSellPrice(
  marketPence: number | null | undefined,
  settings: Pick<PricingSettings, "markupBands" | "sellEnding">
): number | null {
  if (marketPence === null || marketPence === undefined) return null
  if (!Number.isFinite(marketPence) || marketPence <= 0) return null
  return suggestSellPrice(marketPence, settings.markupBands, settings.sellEnding)
}
