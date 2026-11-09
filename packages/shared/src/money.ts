/**
 * Money helpers. Every amount the app stores is an integer of GBP pence.
 * Foreign amounts are converted here, once, with an explicit rate, and the
 * result is rounded half-up to the penny. Decimal inputs are parsed as
 * strings so no float ever touches a price.
 */

export type Currency = "GBP" | "EUR" | "USD"

export interface Money {
  /** Integer minor units (pence for GBP). */
  readonly amount: number
  readonly currency: Currency
}

/** Round half-up to an integer, symmetric for negatives. */
export function roundHalfUp(value: number): number {
  const sign = value < 0 ? -1 : 1
  return sign * Math.floor(Math.abs(value) + 0.5)
}

/**
 * Parse a decimal string such as "16.50", "£1,234.56", "$17", "0.45" into
 * integer minor units. Returns null for anything that is not a plain amount.
 */
export function parseDecimalToMinor(input: string): number | null {
  const cleaned = input.replace(/[£$€\s,]/g, "")
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null
  const negative = cleaned.startsWith("-")
  const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".")
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2))
  return negative ? -minor : minor
}

/** Format pence as £1,234.56 (or -£1.00). Sub-pound values read £0.45. */
export function formatGBP(pence: number): string {
  const negative = pence < 0
  const abs = Math.abs(pence)
  const pounds = Math.floor(abs / 100)
  const rem = abs % 100
  const grouped = pounds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${negative ? "-" : ""}£${grouped}.${rem.toString().padStart(2, "0")}`
}

/**
 * Pence as a plain decimal-pounds string for an API that takes pounds, such
 * as Epos Now's "BalanceToAdd": 6324 -> "63.24", 5 -> "0.05", -100 -> "-1.00".
 * Integer arithmetic only, so no float ever touches the amount; put the
 * string into the JSON body as a bare number literal. Throws on anything
 * that is not a whole number of pence.
 */
export function penceToDecimal(pence: number): string {
  if (!Number.isSafeInteger(pence)) throw new Error(`Not a whole number of pence: ${pence}`)
  const negative = pence < 0
  const abs = Math.abs(pence)
  const pounds = Math.floor(abs / 100)
  const rem = abs % 100
  return `${negative ? "-" : ""}${pounds}.${rem.toString().padStart(2, "0")}`
}

/**
 * Convert minor units of a foreign currency to GBP pence at a rate expressed
 * as GBP per one unit of the foreign currency (for example 0.8606 GBP per EUR).
 * Rounds half-up after conversion, never before.
 */
export function convertMinorToGbpPence(
  minor: number,
  currency: Currency,
  gbpPerUnit: number
): number {
  if (currency === "GBP") return minor
  if (!(gbpPerUnit > 0)) throw new Error(`Invalid rate for ${currency}: ${gbpPerUnit}`)
  return roundHalfUp(minor * gbpPerUnit)
}

/** PriceCharting returns integer US cents ("1732" is $17.32). */
export function usdCentsToGbpPence(cents: number, gbpPerUsd: number): number {
  return convertMinorToGbpPence(cents, "USD", gbpPerUsd)
}

/** Cardmarket and Scryfall return EUR decimals as strings ("16.50"). */
export function eurDecimalToGbpPence(eur: string, gbpPerEur: number): number | null {
  const minor = parseDecimalToMinor(eur)
  if (minor === null) return null
  return convertMinorToGbpPence(minor, "EUR", gbpPerEur)
}

/** Apply a percentage (for example 55 for 55 percent) to pence, half-up. */
export function applyPercent(pence: number, percent: number): number {
  return roundHalfUp((pence * percent) / 100)
}

export type RoundingStep = 25 | 50 | 100

/** Round pence to the nearest 25p, 50p or £1 step, half-up. */
export function roundToStep(pence: number, step: RoundingStep): number {
  return roundHalfUp(pence / step) * step
}

/** Sell-price rounding up to the next .49 or .99 ending (never below the input). */
export function roundToRetailEnding(pence: number): number {
  const pounds = Math.floor(pence / 100)
  const rem = pence % 100
  if (rem <= 49) return pounds * 100 + 49
  return pounds * 100 + 99
}

/**
 * Split `total` pence across lines in proportion to `weights`, so the parts
 * add back up to `total` to the penny.
 *
 * Largest remainder, per unit: line i holds `units[i]` identical units (a
 * quantity), so its part is always a whole number of pence per unit times
 * that quantity, which is how a per-unit offer price is stored. Every unit
 * is first given the floor of its fair share; the pennies left over then go
 * one per unit to the lines with the largest fractional remainder, ties to
 * the earlier line, so the same inputs always give the same answer.
 *
 * With every quantity at 1 (the default) the parts always sum to `total`
 * exactly. A line of several units can only move in steps of its quantity,
 * so when every line has more than one unit a penny or two may be left that
 * no line can take; the parts then sum to slightly less than `total`, never
 * more, and the caller reads the real sum off the parts.
 *
 * Weights that are all zero share the total out equally per unit. A total
 * of zero or less gives zeros.
 */
export function allocatePence(
  total: number,
  weights: number[],
  units: number[] = weights.map(() => 1)
): number[] {
  const count = weights.length
  if (count === 0) return []
  const qty = weights.map((_, i) => Math.max(1, Math.floor(units[i] ?? 1)))
  if (!(total > 0)) return qty.map(() => 0)

  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  let sum = clean.reduce((acc, w) => acc + w, 0)
  // Nothing to go on: an equal share per unit.
  const basis = sum > 0 ? clean : qty.slice()
  if (sum <= 0) sum = qty.reduce((acc, q) => acc + q, 0)

  const perUnit: number[] = []
  const fraction: number[] = []
  let given = 0
  for (let i = 0; i < count; i++) {
    const ideal = (total * (basis[i] as number)) / sum / (qty[i] as number)
    const floor = Math.floor(ideal)
    perUnit.push(floor)
    fraction.push(ideal - floor)
    given += floor * (qty[i] as number)
  }

  let left = total - given
  // Largest fractional remainder first, earlier line on a tie.
  const order = perUnit
    .map((_, i) => i)
    .sort((a, b) => (fraction[b] as number) - (fraction[a] as number) || a - b)
  for (const i of order) {
    const step = qty[i] as number
    if (left >= step) {
      perUnit[i] = (perUnit[i] as number) + 1
      left -= step
    }
  }
  // Whatever a multi-unit line could not take goes to any line it fits,
  // in line order, until nothing that fits is left.
  let moved = true
  while (left > 0 && moved) {
    moved = false
    for (let i = 0; i < count && left > 0; i++) {
      const step = qty[i] as number
      if (left >= step) {
        perUnit[i] = (perUnit[i] as number) + 1
        left -= step
        moved = true
      }
    }
  }

  return perUnit.map((unit, i) => unit * (qty[i] as number))
}
