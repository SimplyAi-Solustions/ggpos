/**
 * The deal builder's state: a reducer over a `DealDraft`, plus the
 * selectors that price it. Every figure comes from @gg/shared/deal
 * (`computeDeal`, `dealPayout`); nothing here does its own deal maths.
 */
import {
  clampDealPct,
  computeDeal,
  DEFAULT_DEAL_RATES,
  dealPayout,
  type Deal,
  type DealLineInput,
  type DealPayout,
  type DealPayoutType,
  type FinalOverride,
} from "@gg/shared/deal"
import { roundHalfUp } from "@gg/shared/money"

import type {
  CardHit,
  CardLine,
  Condition,
  ConditionPrices,
  CustomCategory,
  CustomLine,
  DealDraft,
  DraftLine,
} from "./types"

export type Side = "trade" | "cash"

/** The rate menu's presets, owner's list. */
export const RATE_PRESETS: ReadonlyArray<{ pct: number; label: string }> = [
  { pct: 100, label: "Market" },
  { pct: 90, label: "90%" },
  { pct: 85, label: "85%" },
  { pct: 80, label: "80%" },
  { pct: 75, label: "75%" },
  { pct: 70, label: "70%" },
  { pct: 65, label: "65%" },
  { pct: 60, label: "60%" },
]

/** The per-line quick chips. */
export const LINE_QUICK_PCTS = [90, 80, 70] as const

/** Rates the builder allows: 0 to 100, matching the server's line check. */
export const RATE_MIN = 0
export const RATE_MAX = 100

export function clampRate(pct: number): number {
  return Math.min(RATE_MAX, clampDealPct(Math.round(pct)))
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function newDraft(id: string = newId(), now: Date = new Date()): DealDraft {
  const at = now.toISOString()
  return {
    id,
    name: defaultDealName(now),
    status: "open",
    createdAt: at,
    updatedAt: at,
    rates: { ...DEFAULT_DEAL_RATES },
    lines: [],
    overrides: {},
    payout: { type: "credit", cashTaken: 0 },
    note: "",
    completed: null,
  }
}

/** "Deal 9 Nov, 14:05". */
export function defaultDealName(now: Date): string {
  const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return `Deal ${day}, ${time}`
}

// ---------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------

export function cardLineFromHit(hit: CardHit, variant: string, id: string = newId()): CardLine {
  return {
    id,
    kind: "card",
    cardId: hit.id,
    game: hit.game,
    name: hit.name,
    setName: hit.setName,
    setCode: hit.setCode,
    number: hit.number,
    image: hit.image,
    variant,
    condition: "NM",
    prices: {},
    priceStatus: "loading",
    manualMarket: null,
    qty: 1,
  }
}

export function customLine(
  input: { name: string; category: CustomCategory; marketPence: number; qty: number },
  id: string = newId()
): CustomLine {
  return {
    id,
    kind: "custom",
    name: input.name.trim(),
    category: input.category,
    manualMarket: Math.max(0, Math.floor(input.marketPence)),
    qty: Math.max(1, Math.floor(input.qty)),
  }
}

/** The condition's own price, when the catalogue has one. */
export function conditionPrice(line: CardLine, condition: Condition = line.condition): number | null {
  const price = line.prices[condition]?.pence
  return typeof price === "number" && price >= 0 ? price : null
}

/** Per unit market value in pence: the condition's price, else what staff typed, else 0. */
export function lineMarket(line: DraftLine): number {
  if (line.kind === "custom") return line.manualMarket ?? 0
  return conditionPrice(line) ?? line.manualMarket ?? 0
}

/** True when the line has a value to price from. */
export function linePriced(line: DraftLine): boolean {
  if (line.kind === "custom") return line.manualMarket !== null
  return conditionPrice(line) !== null || line.manualMarket !== null
}

export function lineOverridden(line: DraftLine): boolean {
  return line.tradePct !== undefined || line.cashPct !== undefined
}

export function toLineInput(line: DraftLine): DealLineInput {
  const input: DealLineInput = { marketPence: lineMarket(line), qty: line.qty }
  if (line.tradePct !== undefined) input.tradePct = line.tradePct
  if (line.cashPct !== undefined) input.cashPct = line.cashPct
  return input
}

// ---------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------

/** The whole deal priced by the shared calculator. */
export function priceDraft(draft: Pick<DealDraft, "lines" | "rates" | "overrides">): Deal {
  return computeDeal(draft.lines.map(toLineInput), draft.rates, draft.overrides)
}

/** What the customer would be paid with the payout chosen on review. */
export function draftPayout(draft: Pick<DealDraft, "payout">, deal: Pick<Deal, "trade" | "cash">): DealPayout {
  return dealPayout(draft.payout.type, deal, draft.payout.cashTaken)
}

/** Any cash at all, however small, needs ID on file. */
export function needsIdCheck(payout: DealPayout): boolean {
  return payout.cash > 0
}

export function itemCount(lines: DraftLine[]): number {
  return lines.reduce((sum, line) => sum + Math.max(1, line.qty), 0)
}

export interface RoundingSuggestion {
  step: number
  label: string
  pence: number
  /** Signed pence against the current figure. */
  diff: number
}

/**
 * The final figure rounded to the nearest £1, £5 and £10, half-up, with the
 * difference each makes. Duplicates and no-op rounds are dropped.
 */
export function roundingSuggestions(pence: number): RoundingSuggestion[] {
  const steps = [
    { step: 100, label: "Nearest £1" },
    { step: 500, label: "Nearest £5" },
    { step: 1000, label: "Nearest £10" },
  ]
  const seen = new Set<number>([pence])
  const out: RoundingSuggestion[] = []
  for (const { step, label } of steps) {
    const rounded = roundHalfUp(pence / step) * step
    if (rounded <= 0 || seen.has(rounded)) continue
    seen.add(rounded)
    out.push({ step, label, pence: rounded, diff: rounded - pence })
  }
  return out
}

/** eBay UK sold and completed listings for a line. */
export function ebaySoldUrl(line: DraftLine): string {
  const terms =
    line.kind === "card" ? [line.name, line.number, line.setName].filter(Boolean).join(" ") : line.name
  const params = new URLSearchParams({ _nkw: terms, LH_Sold: "1", LH_Complete: "1" })
  return `https://www.ebay.co.uk/sch/i.html?${params.toString()}`
}

// ---------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------

export type DealAction =
  | { type: "load"; draft: DealDraft }
  | { type: "rename"; name: string }
  | { type: "setRate"; side: Side; pct: number }
  | { type: "addLine"; line: DraftLine }
  | { type: "setPrices"; lineId: string; prices: ConditionPrices }
  | { type: "pricesFailed"; lineId: string }
  | { type: "setCondition"; lineId: string; condition: Condition }
  | { type: "setQty"; lineId: string; qty: number }
  | { type: "setManualMarket"; lineId: string; pence: number | null }
  | { type: "setLineRate"; lineId: string; side: Side; pct: number | null }
  | { type: "resetLineRates"; lineId: string }
  | { type: "removeLine"; lineId: string }
  | { type: "setOverride"; side: Side; override: FinalOverride | null }
  | { type: "setPayoutType"; payoutType: DealPayoutType }
  | { type: "setCashTaken"; pence: number }
  | { type: "setNote"; note: string }
  | { type: "complete"; at: string }

function mapLine(draft: DealDraft, lineId: string, fn: (line: DraftLine) => DraftLine): DealDraft {
  let changed = false
  const lines = draft.lines.map((line) => {
    if (line.id !== lineId) return line
    changed = true
    return fn(line)
  })
  return changed ? { ...draft, lines } : draft
}

function withRate(line: DraftLine, side: Side, pct: number | null): DraftLine {
  const next = { ...line }
  const key = side === "trade" ? "tradePct" : "cashPct"
  if (pct === null) delete next[key]
  else next[key] = clampRate(pct)
  return next
}

export function dealReducer(draft: DealDraft, action: DealAction): DealDraft {
  if (draft.status === "completed" && action.type !== "load" && action.type !== "rename") {
    // A completed deal is a record; only its name can change.
    return draft
  }
  switch (action.type) {
    case "load":
      return action.draft
    case "rename": {
      const name = action.name.replace(/\s+/g, " ").trimStart().slice(0, 80)
      return { ...draft, name }
    }
    case "setRate": {
      const key = action.side === "trade" ? "tradePct" : "cashPct"
      return { ...draft, rates: { ...draft.rates, [key]: clampRate(action.pct) } }
    }
    case "addLine":
      return { ...draft, lines: [action.line, ...draft.lines] }
    case "setPrices":
      return mapLine(draft, action.lineId, (line) =>
        line.kind === "card" ? { ...line, prices: action.prices, priceStatus: "ready" } : line
      )
    case "pricesFailed":
      return mapLine(draft, action.lineId, (line) =>
        line.kind === "card" ? { ...line, priceStatus: "error" } : line
      )
    case "setCondition":
      return mapLine(draft, action.lineId, (line) => {
        if (line.kind !== "card") return line
        // Swap to that condition's own price. A typed value only survives
        // when the new condition has no price of its own.
        const hasOwn = conditionPrice(line, action.condition) !== null
        return { ...line, condition: action.condition, manualMarket: hasOwn ? null : line.manualMarket }
      })
    case "setQty":
      return mapLine(draft, action.lineId, (line) => ({
        ...line,
        qty: Math.min(999, Math.max(1, Math.floor(action.qty))),
      }))
    case "setManualMarket":
      return mapLine(draft, action.lineId, (line) => ({
        ...line,
        manualMarket: action.pence === null ? null : Math.max(0, Math.floor(action.pence)),
      }))
    case "setLineRate":
      return mapLine(draft, action.lineId, (line) => withRate(line, action.side, action.pct))
    case "resetLineRates":
      return mapLine(draft, action.lineId, (line) => withRate(withRate(line, "trade", null), "cash", null))
    case "removeLine": {
      const lines = draft.lines.filter((line) => line.id !== action.lineId)
      // With nothing left to rescale, a final override means nothing.
      return { ...draft, lines, overrides: lines.length ? draft.overrides : {} }
    }
    case "setOverride":
      return { ...draft, overrides: { ...draft.overrides, [action.side]: action.override } }
    case "setPayoutType":
      return { ...draft, payout: { ...draft.payout, type: action.payoutType } }
    case "setCashTaken":
      return { ...draft, payout: { ...draft.payout, cashTaken: Math.max(0, Math.floor(action.pence)) } }
    case "setNote":
      return { ...draft, note: action.note.slice(0, 1000) }
    case "complete": {
      const deal = priceDraft(draft)
      const payout = draftPayout(draft, deal)
      return {
        ...draft,
        status: "completed",
        completed: {
          at: action.at,
          payout,
          market: deal.market,
          trade: deal.trade,
          cash: deal.cash,
          calculatedTrade: deal.calculatedTrade,
          calculatedCash: deal.calculatedCash,
          tradeOverridden: deal.tradeOverridden,
          cashOverridden: deal.cashOverridden,
        },
      }
    }
    default:
      return draft
  }
}
