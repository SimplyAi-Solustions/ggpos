/**
 * The buy-in deal calculator's maths.
 *
 * A deal values every card twice, as store credit ("trade") and as cash, at
 * two sweep rates of the card's market value: 80% trade and 70% cash unless
 * the shop or the staff member says otherwise. One card can carry its own
 * rate for either figure. Staff can then key a final total for either side,
 * as an amount or as a new percentage, and every card's figure is rescaled
 * pro rata so the lines still add up to the total exactly. A customer who
 * wants some cash takes it out of the cash total, and what is left converts
 * to credit at the trade rate.
 *
 * Every amount is integer GBP pence. Rounding goes through `applyPercent`
 * and `roundHalfUp`, and pennies are spread with `allocatePence`, so nothing
 * here rounds in a way of its own.
 */
import { allocatePence, applyPercent, roundHalfUp } from "./money"

export interface DealRates {
  /** Store credit, as a percentage of market value. */
  tradePct: number
  /** Cash, as a percentage of market value. */
  cashPct: number
}

/** The owner's defaults, used when settings do not say otherwise. */
export const DEFAULT_DEAL_RATES: DealRates = { tradePct: 80, cashPct: 70 }

/** The steps the rate controls move in, and the range they allow. */
export const DEAL_PCT_MIN = 0
export const DEAL_PCT_MAX = 200

/** A percentage clamped to the range the calculator allows. */
export function clampDealPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.min(DEAL_PCT_MAX, Math.max(DEAL_PCT_MIN, pct))
}

export interface DealLineInput {
  /** Per unit, integer pence, already adjusted for condition. */
  marketPence: number
  qty: number
  /** This card's own rates; absent follows the sweep. */
  tradePct?: number
  cashPct?: number
  /**
   * A fixed figure per unit that no rate touches: a bulk lot's flat offer,
   * or a line a staff member priced by hand with a reason.
   */
  fixedTrade?: number
  fixedCash?: number
}

/** One side of the final override: a total in pence, or a new percentage. */
export type FinalOverride =
  | { kind: "amount"; pence: number }
  | { kind: "pct"; pct: number }

export interface DealOverrides {
  trade?: FinalOverride | null
  cash?: FinalOverride | null
}

export interface DealLine {
  market: number
  /** What the rates make this line, before any final override. */
  calculatedTrade: number
  calculatedCash: number
  /** What the line is worth in the deal, after any final override. */
  trade: number
  cash: number
  /** The rate the calculated figure used: the card's own or the sweep. */
  tradePct: number
  cashPct: number
  /** True when the card carries its own rate rather than the sweep. */
  tradeCustom: boolean
  cashCustom: boolean
  /** True when a fixed figure, not a rate, priced the line. */
  fixed: boolean
}

export interface Deal {
  lines: DealLine[]
  market: number
  calculatedTrade: number
  calculatedCash: number
  /** The final totals: the calculated ones unless overridden. */
  trade: number
  cash: number
  tradeOverridden: boolean
  cashOverridden: boolean
}

/** One line at the sweep, or at its own rates. */
export function dealLine(line: DealLineInput, rates: DealRates): DealLine {
  const qty = Math.max(1, Math.floor(line.qty))
  const market = Math.max(0, line.marketPence) * qty
  const tradeCustom = line.tradePct !== undefined
  const cashCustom = line.cashPct !== undefined
  const tradePct = clampDealPct(line.tradePct ?? rates.tradePct)
  const cashPct = clampDealPct(line.cashPct ?? rates.cashPct)
  const fixed = line.fixedTrade !== undefined || line.fixedCash !== undefined
  // Per unit first, so the stored per-unit offer times the quantity is the
  // line's figure exactly.
  const tradeUnit = line.fixedTrade ?? applyPercent(Math.max(0, line.marketPence), tradePct)
  const cashUnit = line.fixedCash ?? applyPercent(Math.max(0, line.marketPence), cashPct)
  return {
    market,
    calculatedTrade: tradeUnit * qty,
    calculatedCash: cashUnit * qty,
    trade: tradeUnit * qty,
    cash: cashUnit * qty,
    tradePct,
    cashPct,
    tradeCustom,
    cashCustom,
    fixed,
  }
}

/** The total a final override asks for, from the market and the calculated figure. */
export function overrideTarget(
  override: FinalOverride | null | undefined,
  market: number,
  calculated: number
): number | null {
  if (!override) return null
  if (override.kind === "amount") return Math.max(0, Math.floor(override.pence))
  if (!Number.isFinite(override.pct)) return calculated
  return applyPercent(market, clampDealPct(override.pct))
}

/**
 * Rescale the lines' figures pro rata to a new total, per unit, so a line of
 * several units keeps one price per unit. Lines with nothing calculated
 * share by market value instead, and failing that equally.
 */
function rescale(
  target: number,
  calculated: number[],
  markets: number[],
  qtys: number[]
): number[] {
  const anyCalculated = calculated.some((value) => value > 0)
  const weights = anyCalculated ? calculated : markets
  return allocatePence(target, weights, qtys)
}

/** The whole deal: every line, both totals, and the final override applied. */
export function computeDeal(
  inputs: DealLineInput[],
  rates: DealRates,
  overrides: DealOverrides = {}
): Deal {
  const lines = inputs.map((line) => dealLine(line, rates))
  const qtys = inputs.map((line) => Math.max(1, Math.floor(line.qty)))
  const market = lines.reduce((sum, line) => sum + line.market, 0)
  const calculatedTrade = lines.reduce((sum, line) => sum + line.calculatedTrade, 0)
  const calculatedCash = lines.reduce((sum, line) => sum + line.calculatedCash, 0)

  const tradeTarget = lines.length ? overrideTarget(overrides.trade, market, calculatedTrade) : null
  const cashTarget = lines.length ? overrideTarget(overrides.cash, market, calculatedCash) : null

  if (tradeTarget !== null) {
    const parts = rescale(
      tradeTarget,
      lines.map((line) => line.calculatedTrade),
      lines.map((line) => line.market),
      qtys
    )
    lines.forEach((line, i) => {
      line.trade = parts[i] as number
    })
  }
  if (cashTarget !== null) {
    const parts = rescale(
      cashTarget,
      lines.map((line) => line.calculatedCash),
      lines.map((line) => line.market),
      qtys
    )
    lines.forEach((line, i) => {
      line.cash = parts[i] as number
    })
  }

  return {
    lines,
    market,
    calculatedTrade,
    calculatedCash,
    // Read back off the lines, so the total is always what they add up to.
    trade: lines.reduce((sum, line) => sum + line.trade, 0),
    cash: lines.reduce((sum, line) => sum + line.cash, 0),
    tradeOverridden: tradeTarget !== null,
    cashOverridden: cashTarget !== null,
  }
}

/** A figure as a percentage of market value, to one decimal place. */
export function effectivePct(figure: number, market: number): number {
  if (!(market > 0)) return 0
  return roundHalfUp((figure * 1000) / market) / 10
}

export interface DealSplit {
  /** Cash in the customer's hand, capped at the cash total. */
  cash: number
  /** What the rest of the deal converts to as store credit. */
  credit: number
}

/**
 * Part cash, part credit. The cash taken comes out of the cash total, and
 * the share of the deal it does not cover converts to credit at the trade
 * total: credit = trade x (1 - cash taken / cash total), half-up to the
 * penny. £100.00 trade and £87.50 cash with £35.00 taken gives £60.00 credit.
 */
export function splitDeal(trade: number, cashTotal: number, cashTaken: number): DealSplit {
  if (!(cashTotal > 0)) return { cash: 0, credit: Math.max(0, trade) }
  const cash = Math.min(Math.max(0, Math.floor(cashTaken)), cashTotal)
  const credit = roundHalfUp((Math.max(0, trade) * (cashTotal - cash)) / cashTotal)
  return { cash, credit }
}

export type DealPayoutType = "cash" | "credit" | "mixed"

export interface DealPayout {
  type: DealPayoutType
  cash: number
  credit: number
}

/**
 * What the customer is paid. All credit is the trade total, all cash is the
 * cash total, and a mixed payout is `splitDeal`. A mixed payout with no cash
 * in it is a credit payout, and one that takes the whole cash total is a
 * cash payout, so the type always says what really happens.
 */
export function dealPayout(
  type: DealPayoutType,
  deal: Pick<Deal, "trade" | "cash">,
  cashTaken: number
): DealPayout {
  if (type === "cash") return { type: "cash", cash: deal.cash, credit: 0 }
  if (type === "credit") return { type: "credit", cash: 0, credit: deal.trade }
  const split = splitDeal(deal.trade, deal.cash, cashTaken)
  if (split.cash <= 0) return { type: "credit", cash: 0, credit: deal.trade }
  if (split.credit <= 0) return { type: "cash", cash: split.cash, credit: 0 }
  return { type: "mixed", cash: split.cash, credit: split.credit }
}

export interface PayoutLines {
  /** Per unit, integer pence, in input order: what each line is recorded at. */
  perUnit: number[]
  /** The payout, with credit trimmed by any penny the lines could not carry. */
  payout: DealPayout
}

/**
 * What each line is recorded at for the payout being made, so the lines add
 * up to cash plus credit exactly (the completion route refuses anything
 * else). Credit uses the trade figures and cash the cash figures as they
 * stand; a mixed payout spreads cash plus credit over the lines in
 * proportion to their trade figures. In the rare case where every line has
 * several units and a penny cannot be placed, the credit gives up that
 * penny so the record and the payout still agree.
 */
export function payoutLines(
  deal: Pick<Deal, "lines">,
  qtys: number[],
  payout: DealPayout
): PayoutLines {
  const units = deal.lines.map((_, i) => Math.max(1, Math.floor(qtys[i] ?? 1)))
  const figures =
    payout.type === "cash"
      ? deal.lines.map((line) => line.cash)
      : payout.type === "credit"
        ? deal.lines.map((line) => line.trade)
        : allocatePence(
            payout.cash + payout.credit,
            deal.lines.map((line) => (line.trade > 0 ? line.trade : line.market)),
            units
          )
  const perUnit = figures.map((figure, i) => Math.floor(figure / (units[i] as number)))
  const recorded = perUnit.reduce((sum, unit, i) => sum + unit * (units[i] as number), 0)
  const owed = payout.cash + payout.credit
  if (recorded === owed) return { perUnit, payout }
  // Only the credit side ever moves, and only down to what was recorded.
  const credit = Math.max(0, recorded - payout.cash)
  return { perUnit, payout: { ...payout, credit } }
}
