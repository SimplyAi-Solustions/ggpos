/**
 * Prices per condition for the card page.
 *
 * Each condition is priced from its own UK sold comps when there are enough
 * of them (PulseTCG's approach, see RESEARCH/POKEPULSE_FEATURE_MAP.md
 * section 1). Where comps are thin, the price is the NM figure times an
 * era-aware multiplier and is labelled "Estimated":
 *
 *   modern         LP 0.87  MP 0.73  HP 0.57  DMG 0.35
 *   vintage (WOTC) LP 0.55  MP 0.40  HP 0.27  DMG 0.15
 *
 * LP to HP come from the condition ratios observed on 09/11/2026. DMG is
 * ours (PulseTCG has no DMG tier): the observed curves lose about 40% of
 * value from MP to HP, so DMG takes roughly the same step again below HP,
 * 0.57 x 0.6 = 0.34, rounded to 0.35 for modern and 0.27 x 0.55 = 0.15 for
 * vintage, where damaged vintage still trades on the card itself.
 *
 * Every amount is integer pence, rounded half up through the shared helper.
 */
import { roundHalfUp } from "@gg/shared/money"

export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const
export type CardCondition = (typeof CONDITIONS)[number]

export type Era = "modern" | "vintage"

export const ERA_MULTIPLIERS: Record<Era, Record<CardCondition, number>> = {
  modern: { NM: 1, LP: 0.87, MP: 0.73, HP: 0.57, DMG: 0.35 },
  vintage: { NM: 1, LP: 0.55, MP: 0.4, HP: 0.27, DMG: 0.15 },
}

/** Comps needed in a condition before its own sales set the price. */
export const MIN_COMPS = 2
/** Only sales this recent price a condition. */
export const COMP_WINDOW_DAYS = 90
/** How many of the latest sales the price is the median of. */
export const COMP_SAMPLE = 5

export interface SoldComp {
  pence: number
  condition: string
  /** YYYY-MM-DD */
  sold_at: string
}

export interface ConditionPrice {
  condition: CardCondition
  /** Null when there is nothing to price it from. */
  pence: number | null
  /** True when the figure is NM times the era multiplier, not this condition's own sales. */
  estimated: boolean
  /** Sales in this condition inside the window. */
  sales: number
  /** YYYY-MM-DD of the latest sale in this condition, or null. */
  lastSold: string | null
}

/**
 * Vintage means the Wizards of the Coast era: sets released before July
 * 2003 (Skyridge was the last WOTC Pokemon set). The same date marks the
 * old-frame era for Magic. Everything later, or undated, is modern.
 */
export function eraFor(releaseDate: string | null | undefined): Era {
  if (!releaseDate) return "modern"
  return releaseDate.slice(0, 10) < "2003-07-01" ? "vintage" : "modern"
}

export function normaliseCondition(raw: string): CardCondition | null {
  const upper = raw.trim().toUpperCase()
  if (upper === "DM" || upper === "DAMAGED") return "DMG"
  return (CONDITIONS as readonly string[]).includes(upper) ? (upper as CardCondition) : null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : roundHalfUp((sorted[mid - 1]! + sorted[mid]!) / 2)
}

function daysBetween(a: string, b: Date): number {
  return (b.getTime() - new Date(`${a.slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000
}

/**
 * The five condition prices. `nmMarket` is the chosen UK-first market figure
 * (the price routes' `chosen.gbp_market`), used for NM when NM has too few
 * comps of its own, and as the base for every estimate.
 */
export function conditionPrices(
  nmMarket: number | null,
  comps: readonly SoldComp[],
  era: Era,
  now: Date = new Date()
): ConditionPrice[] {
  const recent = new Map<CardCondition, SoldComp[]>()
  for (const comp of comps) {
    const condition = normaliseCondition(comp.condition)
    if (!condition || !(comp.pence > 0)) continue
    if (daysBetween(comp.sold_at, now) > COMP_WINDOW_DAYS) continue
    const list = recent.get(condition) ?? []
    list.push(comp)
    recent.set(condition, list)
  }
  for (const list of recent.values()) list.sort((a, b) => b.sold_at.localeCompare(a.sold_at))

  const own = (condition: CardCondition): number | null => {
    const list = recent.get(condition) ?? []
    if (list.length < MIN_COMPS) return null
    return median(list.slice(0, COMP_SAMPLE).map((c) => c.pence))
  }

  const nmOwn = own("NM")
  const base = nmOwn ?? nmMarket

  return CONDITIONS.map((condition) => {
    const list = recent.get(condition) ?? []
    const lastSold = list[0]?.sold_at ?? null
    const sold = own(condition)
    if (sold != null) return { condition, pence: sold, estimated: false, sales: list.length, lastSold }
    if (condition === "NM") return { condition, pence: nmMarket, estimated: false, sales: list.length, lastSold }
    if (base == null) return { condition, pence: null, estimated: false, sales: list.length, lastSold }
    return {
      condition,
      pence: roundHalfUp(base * ERA_MULTIPLIERS[era][condition]),
      estimated: true,
      sales: list.length,
      lastSold,
    }
  })
}

/** Mean of the latest `count` sales in any condition, half up to the penny. Null with no sales. */
export function averageOfLast(comps: readonly SoldComp[], count = 5): number | null {
  const latest = [...comps].sort((a, b) => b.sold_at.localeCompare(a.sold_at)).slice(0, count)
  if (!latest.length) return null
  return roundHalfUp(latest.reduce((sum, c) => sum + c.pence, 0) / latest.length)
}
