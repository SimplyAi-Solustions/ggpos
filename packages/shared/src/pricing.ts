/**
 * Valuation and offer maths shared by the web app (previews), the PocketBase
 * hooks (the record of truth) and pricesync. Pure functions, pence in, pence out.
 */
import { applyPercent, roundHalfUp, roundToStep, type RoundingStep } from "./money"

export type PriceSource =
  | "uk_sold_manual"
  | "ebay_uk_asking"
  | "cardmarket"
  | "tcgplayer"
  | "pricecharting_pal"
  | "pricecharting_ntsc"

export const DEFAULT_TCG_PRIORITY: PriceSource[] = [
  "uk_sold_manual",
  "ebay_uk_asking",
  "cardmarket",
  "tcgplayer",
]

export const DEFAULT_RETRO_PRIORITY: PriceSource[] = [
  "uk_sold_manual",
  "pricecharting_pal",
  "ebay_uk_asking",
  "pricecharting_ntsc",
]

export interface PriceCandidate {
  source: PriceSource
  /** Market value already converted to GBP pence. */
  gbpMarket: number
  /** ISO timestamp of the fetch. */
  fetchedAt: string
  nativeCurrency: "GBP" | "EUR" | "USD"
  nativeAmount: number
  fxRate: number | null
  fxDate: string | null
}

export interface FreshnessPolicy {
  /** Max age in hours per source; sources missing here never go stale. */
  maxAgeHours: Partial<Record<PriceSource, number>>
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  maxAgeHours: {
    uk_sold_manual: 30 * 24,
    ebay_uk_asking: 48,
    cardmarket: 72,
    tcgplayer: 72,
    pricecharting_pal: 72,
    pricecharting_ntsc: 72,
  },
}

export interface ChosenPrice {
  chosen: PriceCandidate | null
  /** Every candidate with its status, in priority order, for the side-by-side view. */
  considered: { candidate: PriceCandidate; status: "chosen" | "stale" | "skipped" }[]
}

/**
 * Pick the first fresh candidate in priority order. Stale candidates are
 * reported but skipped; if nothing is fresh, the freshest stale candidate wins
 * so staff still see a number, marked stale by the caller.
 */
export function chooseMarketPrice(
  candidates: PriceCandidate[],
  priority: PriceSource[],
  now: Date,
  freshness: FreshnessPolicy = DEFAULT_FRESHNESS
): ChosenPrice {
  const considered: ChosenPrice["considered"] = []
  let chosen: PriceCandidate | null = null
  for (const source of priority) {
    const matches = candidates
      .filter((c) => c.source === source)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    const candidate = matches[0]
    if (!candidate) continue
    const maxAge = freshness.maxAgeHours[source]
    const ageHours = (now.getTime() - new Date(candidate.fetchedAt).getTime()) / 36e5
    const stale = maxAge !== undefined && ageHours > maxAge
    if (!stale && !chosen) {
      chosen = candidate
      considered.push({ candidate, status: "chosen" })
    } else {
      considered.push({ candidate, status: stale ? "stale" : "skipped" })
    }
  }
  if (!chosen) {
    const freshest = [...candidates].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0]
    if (freshest) chosen = freshest
  }
  return { chosen, considered }
}

/** Card conditions in the order staff pick them. */
export type CardCondition = "NM" | "LP" | "MP" | "HP" | "DMG"

export type ConditionMultipliers = Record<CardCondition, number>

export const DEFAULT_CONDITION_MULTIPLIERS: ConditionMultipliers = {
  NM: 1,
  LP: 0.85,
  MP: 0.7,
  HP: 0.5,
  DMG: 0.3,
}

/** Market value adjusted for condition, half-up to the penny. */
export function adjustForCondition(
  gbpMarket: number,
  condition: CardCondition,
  multipliers: ConditionMultipliers = DEFAULT_CONDITION_MULTIPLIERS
): number {
  return roundHalfUp(gbpMarket * multipliers[condition])
}

export interface PricingRule {
  id: string
  game: string | null
  kind: string | null
  condition: string | null
  finish: string | null
  rarity: string | null
  /** Inclusive lower bound in pence. */
  bandMin: number
  /** Exclusive upper bound in pence; null means open-ended. */
  bandMax: number | null
  cashPct: number
  creditPct: number
  rounding: RoundingStep
  priority: number
  active: boolean
}

export interface OfferContext {
  game: string
  kind: string
  condition: string
  finish?: string | null
  rarity?: string | null
}

/**
 * Select the most specific active rule for the context and adjusted market
 * value. Specificity counts matched optional fields; ties break on priority
 * (higher first), then on the narrower band.
 */
export function selectRule(
  rules: PricingRule[],
  ctx: OfferContext,
  adjustedMarket: number
): PricingRule | null {
  const matches = rules.filter((r) => {
    if (!r.active) return false
    if (adjustedMarket < r.bandMin) return false
    if (r.bandMax !== null && adjustedMarket >= r.bandMax) return false
    if (r.game !== null && r.game !== ctx.game) return false
    if (r.kind !== null && r.kind !== ctx.kind) return false
    if (r.condition !== null && r.condition !== ctx.condition) return false
    if (r.finish !== null && r.finish !== (ctx.finish ?? null)) return false
    if (r.rarity !== null && r.rarity !== (ctx.rarity ?? null)) return false
    return true
  })
  if (matches.length === 0) return null
  const specificity = (r: PricingRule) =>
    [r.game, r.kind, r.condition, r.finish, r.rarity].filter((v) => v !== null).length
  const bandWidth = (r: PricingRule) =>
    r.bandMax === null ? Number.POSITIVE_INFINITY : r.bandMax - r.bandMin
  return matches.sort(
    (a, b) =>
      specificity(b) - specificity(a) ||
      b.priority - a.priority ||
      bandWidth(a) - bandWidth(b)
  )[0] as PricingRule
}

export interface OfferSettings {
  /** Below this adjusted market value the bulk rate applies (pence). */
  bulkThreshold: number
  /** Flat offer per card at or below the bulk threshold (pence), cash and credit. */
  bulkCash: number
  bulkCredit: number
  /** Never offer less than this for a non-bulk single (pence). */
  minimumOffer: number
}

export const DEFAULT_OFFER_SETTINGS: OfferSettings = {
  bulkThreshold: 100,
  bulkCash: 5,
  bulkCredit: 10,
  minimumOffer: 25,
}

export interface Offer {
  cash: number
  credit: number
  cashPct: number
  creditPct: number
  rule: PricingRule | null
  bulk: boolean
  adjustedMarket: number
}

/** Full offer computation for one line. */
export function computeOffer(
  gbpMarket: number,
  ctx: OfferContext & { condition: CardCondition | string },
  rules: PricingRule[],
  settings: OfferSettings = DEFAULT_OFFER_SETTINGS,
  multipliers: ConditionMultipliers = DEFAULT_CONDITION_MULTIPLIERS
): Offer {
  const condition = ctx.condition as CardCondition
  const adjustedMarket =
    condition in multipliers ? adjustForCondition(gbpMarket, condition, multipliers) : gbpMarket
  if (adjustedMarket <= settings.bulkThreshold) {
    return {
      cash: settings.bulkCash,
      credit: settings.bulkCredit,
      cashPct: 0,
      creditPct: 0,
      rule: null,
      bulk: true,
      adjustedMarket,
    }
  }
  const rule = selectRule(rules, ctx, adjustedMarket)
  if (!rule) {
    return { cash: 0, credit: 0, cashPct: 0, creditPct: 0, rule: null, bulk: false, adjustedMarket }
  }
  const cash = Math.max(settings.minimumOffer, roundToStep(applyPercent(adjustedMarket, rule.cashPct), rule.rounding))
  const credit = Math.max(settings.minimumOffer, roundToStep(applyPercent(adjustedMarket, rule.creditPct), rule.rounding))
  return { cash, credit, cashPct: rule.cashPct, creditPct: rule.creditPct, rule, bulk: false, adjustedMarket }
}

/** Sell price suggestion: market times a markup band, then a retail ending. */
export interface MarkupBand {
  /** Inclusive lower bound in pence. */
  from: number
  multiplier: number
}

export const DEFAULT_MARKUP_BANDS: MarkupBand[] = [
  { from: 0, multiplier: 1.1 },
  { from: 500, multiplier: 1.05 },
  { from: 5000, multiplier: 1.0 },
]

export function suggestSellPrice(
  gbpMarket: number,
  bands: MarkupBand[] = DEFAULT_MARKUP_BANDS,
  ending: (pence: number) => number = (p) => p
): number {
  const band = [...bands].sort((a, b) => b.from - a.from).find((b) => gbpMarket >= b.from)
  const raw = roundHalfUp(gbpMarket * (band?.multiplier ?? 1))
  return ending(raw)
}
