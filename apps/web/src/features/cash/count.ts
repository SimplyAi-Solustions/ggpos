/**
 * Counting a drawer: the denominations, their totals and the variance in
 * words (DESIGN.md section 10, "Cashing up").
 *
 * Pure, so the count table, the demo till and the tests all add up the same
 * way. Every amount is integer pence; a count is a whole number of notes or
 * coins, never money.
 */
import { DENOMINATIONS, formatGBP, type Denomination, type DenominationCounts } from "@gg/shared"

/** £50 down to 1p: notes in pounds, coins under a pound in pence. */
export function denominationLabel(pence: Denomination): string {
  return pence >= 100 ? `£${pence / 100}` : `${pence}p`
}

/** The field text for each denomination, keyed as `DenominationCounts` is. */
export type CountFields = Partial<Record<`${Denomination}`, string>>

/** A count field's whole number, or null when it is not one. Empty is zero. */
export function parseCountField(text: string | undefined): number | null {
  const trimmed = (text ?? "").trim()
  if (trimmed === "") return 0
  if (!/^\d{1,5}$/.test(trimmed)) return null
  return Number(trimmed)
}

/** The fields that do not hold a whole number, by denomination. */
export function badCountFields(fields: CountFields): Denomination[] {
  return DENOMINATIONS.filter((value) => parseCountField(fields[`${value}`]) === null)
}

/** The fields as a count, leaving out every denomination there is none of. */
export function countsFromFields(fields: CountFields): DenominationCounts {
  const counts: DenominationCounts = {}
  for (const value of DENOMINATIONS) {
    const count = parseCountField(fields[`${value}`])
    if (count) counts[`${value}`] = count
  }
  return counts
}

/** What one row of the count comes to. */
export function rowTotal(value: Denomination, count: number): number {
  return value * count
}

/** What a whole count comes to, in pence. Anything that is not a count is ignored. */
export function countsTotal(counts: DenominationCounts | null | undefined): number {
  if (!counts) return 0
  let total = 0
  for (const value of DENOMINATIONS) {
    const count = counts[`${value}`]
    if (typeof count === "number" && Number.isInteger(count) && count > 0) {
      total += value * count
    }
  }
  return total
}

/** Whether anything at all has been counted. */
export function hasCount(counts: DenominationCounts | null | undefined): boolean {
  return countsTotal(counts) > 0
}

/**
 * A variance in words, never in colour alone: "£2.40 over", "£1.10 short",
 * "Exact". Counted minus expected, so over is positive.
 */
export function varianceWords(variance: number | null | undefined): string {
  if (variance === null || variance === undefined) return ""
  if (variance === 0) return "Exact"
  return `${formatGBP(Math.abs(variance))} ${variance > 0 ? "over" : "short"}`
}
