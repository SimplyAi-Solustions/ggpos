/**
 * VAT on a sale (docs/api-contract-epos.md, section 4, "VAT").
 *
 * Every price in the shop is VAT inclusive, so VAT is worked out inside a
 * line's gross amount (what the customer paid for it, after its discount and
 * its share of a ticket discount), rounded half-up per line. Only standard
 * rated lines carry VAT, and only while the shop is VAT registered; margin
 * scheme lines never show VAT (it sits on the margin and is worked out in the
 * stock book), and exempt lines have none.
 *
 * Pure and shared: the server stores what this says on each `sale_lines` row
 * and on `sales.vat_total`, and the receipt and the X and Z reports summarise
 * the same figures by rate, so a till preview and a printed receipt cannot
 * disagree by a penny.
 */
import type { VatLine } from "./epos-types"

export type TaxScheme = "margin" | "standard" | "exempt"

/** The standard UK rate, for stock items, which carry no rate of their own. */
export const STANDARD_VAT_RATE = 20

/**
 * The VAT inside a VAT-inclusive amount at a percentage rate, rounded half-up
 * (symmetric for a negative amount, so a refund mirrors its sale). Worked in
 * whole numbers: the rate is scaled to thousandths of a percent, so 20, 5 and
 * 12.5 are all exact and no float rounding reaches the penny.
 */
export function vatInside(gross: number, ratePercent: number): number {
  if (!(ratePercent > 0) || gross === 0) return 0
  const scaled = Math.round(ratePercent * 1000)
  const sign = gross < 0 ? -1 : 1
  const numerator = Math.abs(gross) * scaled
  const denominator = 100000 + scaled
  // floor(n / d + 1/2) without a fractional intermediate.
  return sign * Math.floor((2 * numerator + denominator) / (2 * denominator))
}

/** The rate a line is charged at: its own rate when it carries VAT, otherwise 0. */
export function rateFor(input: { taxScheme: TaxScheme | string; rate: number; vatRegistered: boolean }): number {
  if (!input.vatRegistered || input.taxScheme !== "standard") return 0
  return input.rate > 0 ? input.rate : 0
}

/** The VAT on one line: standard rated and VAT registered only, otherwise 0. */
export function lineVat(input: {
  gross: number
  taxScheme: TaxScheme | string
  rate: number
  vatRegistered: boolean
}): number {
  return vatInside(input.gross, rateFor(input))
}

/**
 * The per-rate summary for a receipt or a report: one row per rate, highest
 * rate first, from the lines that carried VAT. `net` is the amount before
 * VAT, so `net + vat = gross` on every row. Lines at a zero rate (margin,
 * exempt, or sold while not registered) are left out.
 */
export function vatSummary(lines: readonly { gross: number; rate: number; vat: number }[]): VatLine[] {
  const byRate = new Map<number, VatLine>()
  for (const line of lines) {
    if (!(line.rate > 0)) continue
    const row = byRate.get(line.rate) ?? { rate: line.rate, net: 0, vat: 0, gross: 0 }
    row.gross += line.gross
    row.vat += line.vat
    row.net = row.gross - row.vat
    byRate.set(line.rate, row)
  }
  return [...byRate.values()].sort((a, b) => b.rate - a.rate)
}

/** The VAT a sale carries in total: the sum of its lines' own rounded VAT. */
export function vatTotal(lines: readonly { vat: number }[]): number {
  return lines.reduce((sum, line) => sum + line.vat, 0)
}
