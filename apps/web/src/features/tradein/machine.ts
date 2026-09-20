import { formatGBP } from "@gg/shared"
import {
  computeOffer,
  type OfferSettings,
  type PricingRule,
} from "@gg/shared/pricing"

import type {
  CustomerFlag,
  IdStatus,
  ItemKind,
  PayoutType,
  TradeInLineInput,
  TradeInLineRecord,
  TradeInRecord,
} from "@/lib/api"

/**
 * The buy-in wizard's state machine.
 *
 * Everything that decides anything lives here and is pure: which step comes
 * next, whether a line may be added, what a line is worth, what the totals
 * are, and above all whether cash is allowed and why not. The screen renders
 * this and nothing else, so the rules that refuse a payout can be read and
 * tested without a browser.
 */

export const STEPS = ["customer", "items", "offer", "id", "done"] as const
export type WizardStep = (typeof STEPS)[number]

export const STEP_LABEL: Record<WizardStep, string> = {
  customer: "Customer",
  items: "Items",
  offer: "Offer",
  id: "ID check",
  done: "Done",
}

/** What a line is. `bulk` is the flat-offer lot of low-value cards. */
export type LineKind = "single" | "graded" | "retro" | "sealed" | "bulk"

export const CARD_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const
export const RETRO_COMPLETENESS = [
  { value: "loose", label: "Loose" },
  { value: "boxed", label: "Boxed" },
  { value: "cib", label: "CIB" },
] as const
export const COSMETIC_GRADES = ["A", "B", "C"] as const
export const LINE_FINISHES = [
  { value: "normal", label: "Normal" },
  { value: "holo", label: "Holo" },
  { value: "reverse", label: "Reverse" },
  { value: "foil", label: "Foil" },
  { value: "first_edition", label: "First edition" },
] as const

export interface TradeLine {
  /** Stable while the line is only on this screen. */
  key: string
  /** The `trade_in_lines` id, once the draft has been written. */
  id?: string
  kind: LineKind
  title: string
  cardId?: string
  gameId?: string
  setName?: string
  number?: string
  image?: string
  finish?: string
  /** NM to DMG for cards, loose/boxed/cib for retro. */
  condition?: string
  /** Retro only: the cosmetic grade of the box and label. */
  cosmetic?: (typeof COSMETIC_GRADES)[number]
  qty: number
  /** Integer GBP pence, per unit. Entered by hand this phase. */
  marketPence: number
  marketSource: string
  /** A flat offer for the whole lot, in pence. `bulk` lines only. */
  bulkOffer?: number
  /** Integer GBP pence per unit, replacing the computed cash offer. */
  overrideCash?: number
  overrideCredit?: number
  overrideReason?: string
  accepted: boolean
}

export interface LineOffer {
  /** Per unit, in pence. */
  cash: number
  credit: number
  /** For the whole line, quantity included. */
  cashTotal: number
  creditTotal: number
  marketTotal: number
  source: "rule" | "bulk" | "override" | "lot" | "none"
  cashPct: number
  creditPct: number
}

/** The `items` kind a line becomes when the trade-in completes. */
export function itemKindFor(kind: LineKind): ItemKind {
  return kind === "bulk" ? "single" : kind
}

/**
 * What one line is worth.
 *
 * A bulk lot is a flat figure for the whole lot, so it never multiplies. An
 * override replaces the computed figure but keeps the quantity. Everything
 * else goes through the shared `computeOffer`, so the counter preview and the
 * server's record of truth cannot drift apart.
 */
export function lineOffer(
  line: TradeLine,
  rules: PricingRule[],
  settings: OfferSettings
): LineOffer {
  if (line.kind === "bulk") {
    const flat = line.bulkOffer ?? 0
    return {
      cash: flat,
      credit: flat,
      cashTotal: flat,
      creditTotal: flat,
      marketTotal: line.marketPence,
      source: "lot",
      cashPct: 0,
      creditPct: 0,
    }
  }

  const marketTotal = line.marketPence * line.qty

  if (line.overrideCash !== undefined && line.overrideCredit !== undefined) {
    return {
      cash: line.overrideCash,
      credit: line.overrideCredit,
      cashTotal: line.overrideCash * line.qty,
      creditTotal: line.overrideCredit * line.qty,
      marketTotal,
      source: "override",
      cashPct: 0,
      creditPct: 0,
    }
  }

  const offer = computeOffer(
    line.marketPence,
    {
      game: line.gameId ?? "",
      kind: itemKindFor(line.kind),
      condition: line.condition ?? "",
      finish: line.finish ?? null,
    },
    rules,
    settings
  )

  const nothingMatched = !offer.bulk && offer.rule === null
  return {
    cash: offer.cash,
    credit: offer.credit,
    cashTotal: offer.cash * line.qty,
    creditTotal: offer.credit * line.qty,
    marketTotal,
    source: nothingMatched ? "none" : offer.bulk ? "bulk" : "rule",
    cashPct: offer.cashPct,
    creditPct: offer.creditPct,
  }
}

export interface Totals {
  market: number
  cash: number
  credit: number
  lines: number
  units: number
}

export function totals(
  lines: TradeLine[],
  rules: PricingRule[],
  settings: OfferSettings
): Totals {
  return lines
    .filter((line) => line.accepted)
    .reduce<Totals>(
      (sum, line) => {
        const offer = lineOffer(line, rules, settings)
        return {
          market: sum.market + offer.marketTotal,
          cash: sum.cash + offer.cashTotal,
          credit: sum.credit + offer.creditTotal,
          lines: sum.lines + 1,
          units: sum.units + (line.kind === "bulk" ? line.qty : line.qty),
        }
      },
      { market: 0, cash: 0, credit: 0, lines: 0, units: 0 }
    )
}

// ---------------------------------------------------------------------------
// The cash gate
// ---------------------------------------------------------------------------

export interface CustomerGateFacts {
  flags: CustomerFlag[]
  idStatus: IdStatus
  /** "Passport", "Driving licence": what the counter wrote down last time. */
  idType?: string
  idExpiry?: string
  dob?: string
  address?: string
}

export type CashBlock =
  /** `message` is null here so a caller can read it without narrowing first. */
  | { kind: "none"; message: null }
  | { kind: "flag"; message: string }
  | { kind: "under_18"; message: string }
  | { kind: "cap"; message: string }

/** Whole years between a date of birth and now; null when it is unknown. */
export function ageAt(dob: string | undefined, now: Date): number | null {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  let age = now.getFullYear() - born.getFullYear()
  const months = now.getMonth() - born.getMonth()
  if (months < 0 || (months === 0 && now.getDate() < born.getDate())) age -= 1
  return age
}

/**
 * Why this customer may not take cash, in the order the counter would find
 * out: a standing flag first, then their age, then the amount itself.
 * `{ kind: "none" }` means cash is on the table, which is not the same as
 * saying the ID is already good enough: that is `needsIdGate`.
 */
export function cashBlock(
  facts: CustomerGateFacts,
  cashPence: number,
  cashCap: number,
  now: Date = new Date()
): CashBlock {
  if (facts.flags.includes("no_cash")) {
    return {
      kind: "flag",
      message: "This customer is marked store credit only, so cash is not an option.",
    }
  }
  const age = ageAt(facts.dob, now)
  if (facts.flags.includes("under_18") || (age !== null && age < 18)) {
    return {
      kind: "under_18",
      message: "This customer is under 18, so cash is not an option. Offer store credit.",
    }
  }
  if (cashPence > cashCap) {
    return {
      kind: "cap",
      message: `Cash is capped at ${formatGBP(cashCap)} per buy-in. Pay the rest as store credit.`,
    }
  }
  return { kind: "none", message: null }
}

/** True when a cash payout still needs an ID captured before it can happen. */
export function needsIdGate(
  facts: CustomerGateFacts,
  now: Date = new Date()
): boolean {
  if (facts.idStatus !== "verified") return true
  if (!facts.idExpiry) return true
  const expiry = new Date(facts.idExpiry)
  if (Number.isNaN(expiry.getTime())) return true
  return expiry.getTime() <= now.getTime()
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface StepContext {
  /** True when the chosen payout puts any cash in the customer's hand. */
  cashRequired: boolean
}

export function nextStep(step: WizardStep, ctx: StepContext): WizardStep {
  switch (step) {
    case "customer":
      return "items"
    case "items":
      return "offer"
    case "offer":
      return ctx.cashRequired ? "id" : "done"
    case "id":
      return "done"
    case "done":
      return "done"
  }
}

export function previousStep(step: WizardStep): WizardStep | null {
  switch (step) {
    case "customer":
      return null
    case "items":
      return "customer"
    case "offer":
      return "items"
    case "id":
      return "offer"
    case "done":
      return null
  }
}

/** Which segments the progress bar shows, given whether cash is in play. */
export function visibleSteps(ctx: StepContext): WizardStep[] {
  return ctx.cashRequired
    ? [...STEPS]
    : STEPS.filter((step) => step !== "id")
}

// ---------------------------------------------------------------------------
// The wizard's own state
// ---------------------------------------------------------------------------

export interface WizardCustomer {
  id: string
  name: string
  code: string
  email: string
  phone: string
  facts: CustomerGateFacts
  creditBalance: number
}

export interface WizardState {
  step: WizardStep
  customer: WizardCustomer | null
  tradeInId: string | null
  lines: TradeLine[]
  payoutType: PayoutType
  /** Mixed only: what the customer asked to take in cash, in pence. */
  mixedCash: number
  termsAccepted: boolean
  signature: string | null
  /** Set once the completion route has answered. */
  completed: {
    number: string
    labels: number
    points: number
    items: { id: string; sku: string; title: string }[]
  } | null
}

export const initialState: WizardState = {
  step: "customer",
  customer: null,
  tradeInId: null,
  lines: [],
  payoutType: "credit",
  mixedCash: 0,
  termsAccepted: false,
  signature: null,
  completed: null,
}

export type WizardAction =
  | { type: "choose-customer"; customer: WizardCustomer }
  | { type: "set-draft"; tradeInId: string }
  | { type: "add-line"; line: TradeLine }
  | { type: "update-line"; key: string; patch: Partial<TradeLine> }
  | { type: "remove-line"; key: string }
  | { type: "adopt-line-ids"; ids: (string | undefined)[] }
  | { type: "set-payout"; payoutType: PayoutType }
  | { type: "set-mixed-cash"; pence: number }
  | { type: "set-terms"; accepted: boolean }
  | { type: "set-signature"; signature: string | null }
  | { type: "go"; step: WizardStep }
  | { type: "next"; ctx: StepContext }
  | { type: "back" }
  | {
      type: "completed"
      number: string
      labels: number
      points: number
      items: { id: string; sku: string; title: string }[]
    }
  | { type: "reset" }

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "choose-customer":
      return {
        ...state,
        customer: action.customer,
        // A customer who cannot take cash starts on credit, so the offer
        // step never opens with an option that is about to be refused.
        payoutType: action.customer.facts.flags.includes("no_cash")
          ? "credit"
          : state.payoutType,
      }
    case "set-draft":
      return { ...state, tradeInId: action.tradeInId }
    case "add-line":
      return { ...state, lines: [...state.lines, action.line] }
    case "update-line":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.key === action.key ? { ...line, ...action.patch } : line
        ),
      }
    case "remove-line":
      return { ...state, lines: state.lines.filter((line) => line.key !== action.key) }
    case "adopt-line-ids":
      return {
        ...state,
        lines: state.lines.map((line, index) => ({
          ...line,
          id: action.ids[index] ?? line.id,
        })),
      }
    case "set-payout":
      return { ...state, payoutType: action.payoutType }
    case "set-mixed-cash":
      return { ...state, mixedCash: Math.max(0, action.pence) }
    case "set-terms":
      return { ...state, termsAccepted: action.accepted }
    case "set-signature":
      return { ...state, signature: action.signature }
    case "go":
      return { ...state, step: action.step }
    case "next":
      return { ...state, step: nextStep(state.step, action.ctx) }
    case "back": {
      const back = previousStep(state.step)
      return back ? { ...state, step: back } : state
    }
    case "completed":
      return {
        ...state,
        step: "done",
        completed: {
          number: action.number,
          labels: action.labels,
          points: action.points,
          items: action.items,
        },
      }
    case "reset":
      return { ...initialState }
  }
}

// ---------------------------------------------------------------------------
// What the payout actually is
// ---------------------------------------------------------------------------

export interface Payout {
  type: PayoutType
  cash: number
  credit: number
}

/**
 * The split the completion route is sent. `payout_cash + payout_credit` has
 * to equal the accepted offer total, so a mixed split takes the cash the
 * customer asked for, clamped to the total, and the rest goes to credit.
 *
 * Cash and credit are priced differently, so the total depends on which one
 * is chosen. A mixed payout is priced on the cash total, which is the lower
 * of the two: the shop never pays the credit rate in cash.
 */
export function payoutFor(
  payoutType: PayoutType,
  sums: Pick<Totals, "cash" | "credit">,
  mixedCash: number
): Payout {
  if (payoutType === "cash") {
    return { type: "cash", cash: sums.cash, credit: 0 }
  }
  if (payoutType === "credit") {
    return { type: "credit", cash: 0, credit: sums.credit }
  }
  const cash = Math.min(Math.max(0, mixedCash), sums.cash)
  return { type: "mixed", cash, credit: sums.cash - cash }
}

// ---------------------------------------------------------------------------
// Gates between steps
// ---------------------------------------------------------------------------

export interface Advance {
  ok: boolean
  reason: string | null
}

const OK: Advance = { ok: true, reason: null }

export function canAdvance(
  state: WizardState,
  sums: Totals,
  payout: Payout,
  cashCap: number,
  now: Date = new Date()
): Advance {
  switch (state.step) {
    case "customer":
      return state.customer
        ? OK
        : { ok: false, reason: "Scan or search for the customer first." }
    case "items":
      if (sums.lines === 0) {
        return { ok: false, reason: "Add at least one item to make an offer." }
      }
      if (sums.market === 0 && sums.cash === 0 && sums.credit === 0) {
        return {
          ok: false,
          reason: "Every line is at nothing. Enter a market price, or override the offer.",
        }
      }
      return OK
    case "offer": {
      if (!state.termsAccepted) {
        return { ok: false, reason: "Read the terms to the customer and tick the box." }
      }
      if (!state.signature) {
        return { ok: false, reason: "Ask the customer to sign before you continue." }
      }
      if (payout.cash > 0 && state.customer) {
        const block = cashBlock(state.customer.facts, payout.cash, cashCap, now)
        if (block.kind !== "none") return { ok: false, reason: block.message }
      }
      return OK
    }
    case "id":
      return OK
    case "done":
      return OK
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/** The wizard's lines in the shape `saveTradeInLines` writes. */
export function toLineInputs(
  lines: TradeLine[],
  rules: PricingRule[],
  settings: OfferSettings,
  payoutType: PayoutType
): TradeInLineInput[] {
  return lines.map((line) => {
    const offer = lineOffer(line, rules, settings)
    // The stored offer is the one the customer is taking, so the receipt and
    // the item's cost match what was actually paid.
    const perUnit = payoutType === "credit" ? offer.credit : offer.cash
    const pct = payoutType === "credit" ? offer.creditPct : offer.cashPct
    return {
      id: line.id,
      kind: itemKindFor(line.kind),
      gameId: line.gameId,
      cardId: line.cardId,
      title: line.title,
      finish: line.finish,
      condition: line.kind === "retro" ? undefined : line.condition,
      completeness: line.kind === "retro" ? line.condition : undefined,
      qty: line.qty,
      marketPrice: line.marketPence,
      marketSource: line.marketSource,
      offerPct: pct,
      offerPrice: perUnit,
      accepted: line.accepted,
    }
  })
}

/**
 * A saved draft back in the wizard's own shape.
 *
 * Rebuilt rather than kept: a line's card art and set name are not on
 * `trade_in_lines`, so a reopened draft shows the title it was saved with and
 * the silhouette frame until the card is searched again. Everything that
 * decides money, the market value, the condition and the quantity, survives.
 */
export function hydrate(
  record: TradeInRecord,
  lines: TradeInLineRecord[],
  customer: WizardCustomer | null
): WizardState {
  return {
    ...initialState,
    step: customer ? "items" : "customer",
    customer,
    tradeInId: record.id,
    payoutType: record.payout_type ?? "credit",
    lines: lines.map((line, index) => ({
      key: line.id || `line_${index}`,
      id: line.id,
      kind: (line.kind ?? "single") as LineKind,
      title: line.free_text_title || "Item",
      cardId: line.card || undefined,
      gameId: line.game || undefined,
      finish: line.finish || undefined,
      condition: line.completeness || line.condition || undefined,
      qty: line.qty ?? 1,
      marketPence: line.market_price ?? 0,
      marketSource: line.market_source || "Manual",
      accepted: line.accepted !== false,
    })),
  }
}
