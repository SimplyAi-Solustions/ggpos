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
 *
 * Since the launch (docs/api-contract-launch.md, section 3) this is also the
 * one place a stored scheme and rate become the rate a line is charged at
 * (`resolveVat`), the one place the registration date is applied
 * (`vatApplies`), and the one place a margin scheme line's VAT is worked out
 * (`marginVat`, `keptLine`), for the sale route, the dashboard, the margin
 * report and the VAT return alike.
 */
import { shopDateOf } from "./bookings"
import type { VatLine } from "./epos-types"
import { cumNet } from "./saleline"

/**
 * What a line, a till product, an item or a branch's default is stored as.
 * `zero` is its own scheme (pb_migrations/1789821200_vat_zero.js) because an
 * empty rate reads 0 and means the shop's standard rate.
 */
export type TaxScheme = "margin" | "standard" | "zero" | "exempt"

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

// ---------------------------------------------------------------------------
// Treatments (docs/api-contract-launch.md, section 3, "VAT settings")
// ---------------------------------------------------------------------------

/**
 * The five treatments staff choose from, per branch (its default), per till
 * product and per item. Each is stored as a scheme and a rate:
 *
 *   margin    scheme margin
 *   standard  scheme standard, rate 0 or empty (the shop's standard rate)
 *   reduced   scheme standard, rate 5
 *   zero      scheme zero
 *   exempt    scheme exempt
 *
 * A till product seeded before this (`vat_rate` 20 on a standard product)
 * still reads as standard: any rate other than 5 on a standard row is the
 * rate it carries.
 */
export type VatTreatment = "margin" | "standard" | "reduced" | "zero" | "exempt"

export const VAT_TREATMENTS: readonly VatTreatment[] = ["margin", "standard", "reduced", "zero", "exempt"]

/** The UK reduced rate. */
export const REDUCED_VAT_RATE = 5

const SCHEMES: readonly string[] = ["margin", "standard", "zero", "exempt"]

export function isTaxScheme(value: unknown): value is TaxScheme {
  return typeof value === "string" && SCHEMES.includes(value)
}

export function isVatTreatment(value: unknown): value is VatTreatment {
  return typeof value === "string" && (VAT_TREATMENTS as readonly string[]).includes(value)
}

/** The treatment a stored scheme and rate stand for, or null when nothing is set. */
export function treatmentOf(scheme: string | null | undefined, rate?: number | null): VatTreatment | null {
  if (!isTaxScheme(scheme)) return null
  if (scheme !== "standard") return scheme
  return rate === REDUCED_VAT_RATE ? "reduced" : "standard"
}

/** What a treatment is stored as on an item, a till product, a sale line or a branch. */
export function treatmentFields(treatment: VatTreatment): { tax_scheme: TaxScheme; vat_rate: number } {
  switch (treatment) {
    case "reduced":
      return { tax_scheme: "standard", vat_rate: REDUCED_VAT_RATE }
    case "standard":
      return { tax_scheme: "standard", vat_rate: 0 }
    default:
      return { tax_scheme: treatment, vat_rate: 0 }
  }
}

/** The shop's standard rate from `settings.vat_standard_rate`, 20 when it is unset. */
export function standardRateOf(value: unknown): number {
  const rate = typeof value === "number" ? value : Number(value)
  return Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : STANDARD_VAT_RATE
}

/** "Standard 20%", "Reduced 5%", "Zero 0%", "Margin scheme", "Exempt". */
export function treatmentLabel(treatment: VatTreatment, standardRate: number = STANDARD_VAT_RATE): string {
  switch (treatment) {
    case "margin":
      return "Margin scheme"
    case "standard":
      return `Standard ${standardRateOf(standardRate)}%`
    case "reduced":
      return `Reduced ${REDUCED_VAT_RATE}%`
    case "zero":
      return "Zero 0%"
    default:
      return "Exempt"
  }
}

/** A scheme and rate as stored on an item, a till product or a branch's defaults. */
export interface VatSource {
  scheme?: string | null
  rate?: number | null
}

/**
 * The scheme a line sells under and the rate it carries when VAT is
 * charged: the item's or till product's own treatment, else its branch's
 * default, else `fallback` (margin for stock, standard for a till product).
 * A standard row with no rate of its own is the shop's standard rate. Only a
 * standard line carries a rate; whether it is charged is `vatApplies` and
 * `rateFor`.
 */
export function resolveVat(input: {
  own: VatSource | null
  branch: VatSource | null
  fallback: TaxScheme
  standardRate: number
}): { scheme: TaxScheme; rate: number } {
  const source = isTaxScheme(input.own?.scheme)
    ? input.own
    : isTaxScheme(input.branch?.scheme)
      ? input.branch
      : null
  const scheme: TaxScheme = source && isTaxScheme(source.scheme) ? source.scheme : input.fallback
  if (scheme !== "standard") return { scheme, rate: 0 }
  const own = Number(source?.rate ?? 0)
  return { scheme, rate: Number.isFinite(own) && own > 0 ? own : standardRateOf(input.standardRate) }
}

/** `settings.vat_registered` and `settings.vat_registered_from`. */
export interface VatRegistration {
  registered: boolean
  /** "2026-11-01", PocketBase's "2026-11-01 00:00:00.000Z", or "" for no start date. */
  from: string | null | undefined
}

/** The registration date as a shop-time calendar day, or "" when there is none. */
export function registeredFromDay(from: string | null | undefined): string {
  const day = (from ?? "").trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ""
}

/**
 * Whether a sale made at `at` is inside the shop's VAT registration: VAT is
 * switched on and the sale's shop-time date is on or after
 * `vat_registered_from` (any date when none is set). Nothing is charged as
 * VAT outside it, and a sale before the date never is.
 */
export function vatApplies(registration: VatRegistration, at: Date): boolean {
  if (!registration.registered) return false
  const from = registeredFromDay(registration.from)
  return from === "" || shopDateOf(at) >= from
}

/**
 * The VAT due on a margin scheme line: the rate's fraction of its margin
 * (one sixth at 20 percent), rounded half-up, and nothing on a sale at a
 * loss. A loss on one line never reduces the VAT on another.
 */
export function marginVat(margin: number, standardRate: number): number {
  return margin > 0 ? vatInside(margin, standardRate) : 0
}

/** A line as sold, with what the stock behind it cost. Money in pence. */
export interface VatLineAsSold {
  /** The line's net after its own and its share of the ticket discount. */
  net: number
  qty: number
  /** What one unit cost the shop; 0 for a till product. */
  unitCost: number
  scheme: TaxScheme | string
  /** The rate stored on the line: what it was charged at, 0 when it was not. */
  rate: number
}

/** What a line comes to once some of it has gone back. */
export interface KeptLine {
  /** The VAT-inclusive amount the shop kept. */
  gross: number
  /** What the stock kept cost. */
  cost: number
  /** The VAT due on it. */
  vat: number
  /** gross less vat: what goes in box 6. */
  exVat: number
}

/**
 * A line with `refunded` units back: the amount kept (the shared refund
 * arithmetic, so it agrees with the refund route to the penny), the cost of
 * the units kept, and the VAT due. A standard line's VAT is inside what was
 * kept at the rate it was charged; a margin line's is `marginVat` on what
 * was kept less its cost, and only inside the registration (`inScope`);
 * zero, exempt and anything uncharged carry none.
 */
export function keptLine(
  line: VatLineAsSold,
  refunded: number,
  options: { inScope: boolean; standardRate: number }
): KeptLine {
  const qty = Math.max(1, line.qty)
  const back = Math.max(0, Math.min(qty, refunded))
  const gross = line.net - cumNet(line.net, qty, back)
  const cost = line.unitCost * (qty - back)
  let vat = 0
  if (line.scheme === "standard") vat = vatInside(gross, line.rate)
  else if (line.scheme === "margin" && options.inScope) vat = marginVat(gross - cost, options.standardRate)
  return { gross, cost, vat, exVat: gross - vat }
}
