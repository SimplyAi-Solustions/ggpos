import { formatGBP } from "@gg/shared"

/**
 * How an estimate band reads.
 *
 * The server sends the offer at the grade asked for and at one grade lower,
 * which is the honest width of a valuation made from a photo. Both ends are
 * integer GBP pence and both are formatted with `formatGBP`, so a band is
 * never a decimal string and never a bare "45p".
 */

/**
 * A band's two ends.
 *
 * Both are null when the shop has no cached price for the card at all, which
 * `GET /api/vault/estimate` answers with rather than a fabricated zero.
 */
export interface Band {
  low: number | null
  high: number | null
}

/**
 * "£12.00 to £15.00", or one figure when the two ends meet, which they do
 * for a card cheap enough to fall in the bulk rate at both grades, and at
 * DMG, where there is no lower grade to price against.
 *
 * An empty band has no figures to show, so this never invents one: call
 * `bandIsEmpty` first and say what that means in words.
 */
export function formatBand(band: Band): string {
  if (bandIsEmpty(band)) return ""
  const ends = [band.low, band.high].filter(
    (end): end is number => typeof end === "number"
  )
  const low = Math.min(...ends)
  const high = Math.max(...ends)
  if (low === high) return formatGBP(high)
  return `${formatGBP(low)} to ${formatGBP(high)}`
}

/** True when there is nothing worth showing: no price, or a band of zero. */
export function bandIsEmpty(band: Band | null | undefined): boolean {
  if (!band) return true
  const low = band.low ?? 0
  const high = band.high ?? 0
  return low <= 0 && high <= 0
}

/** The conditions the estimate offers, worst last. */
export const CONDITIONS = [
  { value: "NM", label: "Near mint" },
  { value: "LP", label: "Lightly played" },
  { value: "MP", label: "Moderately played" },
  { value: "HP", label: "Heavily played" },
  { value: "DMG", label: "Damaged" },
] as const

export type EstimateCondition = (typeof CONDITIONS)[number]["value"]

const FINISH_LABEL: Record<string, string> = {
  normal: "Normal",
  holo: "Holo",
  reverse: "Reverse holo",
  foil: "Foil",
  etched: "Etched foil",
  cold_foil: "Cold foil",
}

export function finishLabel(finish: string): string {
  return FINISH_LABEL[finish] ?? finish.replace(/_/g, " ")
}
