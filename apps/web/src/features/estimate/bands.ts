import { formatGBP } from "@gg/shared"

/**
 * How an estimate band reads.
 *
 * The server sends the offer at the grade asked for and at one grade lower,
 * which is the honest width of a valuation made from a photo. Both ends are
 * integer GBP pence and both are formatted with `formatGBP`, so a band is
 * never a decimal string and never a bare "45p".
 */

export interface Band {
  low: number
  high: number
}

/**
 * "£12.00 to £15.00", or one figure when the two ends meet, which they do
 * for a card cheap enough to fall in the bulk rate at both grades.
 */
export function formatBand(band: Band): string {
  const low = Math.min(band.low, band.high)
  const high = Math.max(band.low, band.high)
  if (low === high) return formatGBP(high)
  return `${formatGBP(low)} to ${formatGBP(high)}`
}

/** True when there is nothing worth showing: no price, or a band of zero. */
export function bandIsEmpty(band: Band | null | undefined): boolean {
  if (!band) return true
  return band.low <= 0 && band.high <= 0
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
