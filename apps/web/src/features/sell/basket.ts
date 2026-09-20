/**
 * The basket: what is in it, what it costs and whether the payment adds up.
 *
 * Pure. Every figure is integer GBP pence, the perk and reward arithmetic is
 * the shared evaluator's, and nothing here touches React or the network, so
 * the till's maths is unit tested on its own.
 */
import {
  applyPercent,
  checkPointsRedemption,
  evaluateSalePoints,
  formatGBP,
  penceToPoints,
  roundHalfUp,
  type LoyaltyProgramme,
  type SaleLineForPoints,
  type TierPerk,
} from "@gg/shared"

import type {
  DiscountSource,
  ItemKind,
  LoyaltySetup,
  PaymentMethod,
  RewardVoucher,
  SaleCustomer,
  SplitMethod,
} from "@/lib/api/types"

export interface BasketLine {
  itemId: string
  sku: string
  title: string
  /** The one grey line under the title: set, number, finish. */
  detail: string
  kind: ItemKind
  condition: string
  image?: string
  /** A `PlatformKey` for the ProductImage frame. */
  platform: string
  /** Integer GBP pence, editable on the line. */
  unitPrice: number
  /** What the item was priced at, so an override is visible. */
  listPrice: number
  qty: number
  /** 1 for singles, graded and retro; the stock line's qty for the rest. */
  maxQty: number
  game: string | null
}

export type ManualDiscount =
  | { kind: "none" }
  | { kind: "amount"; value: number }
  | { kind: "percent"; value: number }

export interface BasketState {
  lines: BasketLine[]
  customer: SaleCustomer | null
  manualDiscount: ManualDiscount
  voucher: RewardVoucher | null
  payment: PaymentMethod
  /** Only read when `payment` is "mixed". */
  split: Record<SplitMethod, number>
}

export const SPLIT_METHODS: SplitMethod[] = [
  "sumup_card",
  "cash",
  "store_credit",
  "points",
]

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  sumup_card: "SumUp card",
  cash: "Cash",
  store_credit: "Store credit",
  points: "Points",
  mixed: "Mixed",
}

export function emptySplit(): Record<SplitMethod, number> {
  return { sumup_card: 0, cash: 0, store_credit: 0, points: 0 }
}

export function emptyBasket(): BasketState {
  return {
    lines: [],
    customer: null,
    manualDiscount: { kind: "none" },
    voucher: null,
    payment: "sumup_card",
    split: emptySplit(),
  }
}

export type BasketAction =
  | { type: "add"; line: BasketLine }
  | { type: "setQty"; itemId: string; qty: number }
  | { type: "remove"; itemId: string }
  | { type: "setUnitPrice"; itemId: string; unitPrice: number }
  | { type: "attachCustomer"; customer: SaleCustomer | null }
  | { type: "setDiscount"; discount: ManualDiscount }
  | { type: "applyVoucher"; voucher: RewardVoucher | null }
  | { type: "setPayment"; payment: PaymentMethod }
  | { type: "setSplit"; method: SplitMethod; amount: number }
  | { type: "clear" }

export function lineTotal(line: BasketLine): number {
  return line.unitPrice * line.qty
}

/**
 * Scanning the same code twice adds one more of a multi-quantity line and
 * leaves a single alone: a card is one row per unit and there is only ever
 * one of it.
 */
export function basketReducer(
  state: BasketState,
  action: BasketAction
): BasketState {
  switch (action.type) {
    case "add": {
      const existing = state.lines.find((line) => line.itemId === action.line.itemId)
      if (!existing) return { ...state, lines: [...state.lines, action.line] }
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.itemId === action.line.itemId
            ? { ...line, qty: Math.min(line.maxQty, line.qty + 1) }
            : line
        ),
      }
    }
    case "setQty": {
      const qty = Math.max(0, Math.floor(action.qty))
      if (qty === 0) return basketReducer(state, { type: "remove", itemId: action.itemId })
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.itemId === action.itemId
            ? { ...line, qty: Math.min(line.maxQty, qty) }
            : line
        ),
      }
    }
    case "remove":
      return {
        ...state,
        lines: state.lines.filter((line) => line.itemId !== action.itemId),
      }
    case "setUnitPrice":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.itemId === action.itemId
            ? { ...line, unitPrice: Math.max(0, Math.round(action.unitPrice)) }
            : line
        ),
      }
    case "attachCustomer": {
      // A voucher belongs to the customer who earned it.
      const voucher =
        state.voucher && state.voucher.customer !== action.customer?.id
          ? null
          : state.voucher
      return { ...state, customer: action.customer, voucher }
    }
    case "setDiscount":
      return { ...state, manualDiscount: action.discount }
    case "applyVoucher":
      return { ...state, voucher: action.voucher }
    case "setPayment":
      return { ...state, payment: action.payment, split: emptySplit() }
    case "setSplit":
      return {
        ...state,
        split: { ...state.split, [action.method]: Math.max(0, Math.round(action.amount)) },
      }
    case "clear":
      return emptyBasket()
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface BasketTotals {
  subtotal: number
  /** Percent off eligible kinds from the customer's tier. */
  perkPercent: number
  perkDiscount: number
  manualDiscount: number
  voucherDiscount: number
  /** Everything above, never more than the subtotal. */
  discount: number
  discountSource: DiscountSource | null
  total: number
  /** Line totals after their share of the discount, for the points preview. */
  lineTotals: { itemId: string; total: number }[]
}

function percentOffPerks(perks: TierPerk[]) {
  return perks.filter(
    (perk): perk is Extract<TierPerk, { type: "percent_off" }> =>
      perk.type === "percent_off"
  )
}

/** The best percent off this basket's kinds, and what it takes off. */
export function perkFor(
  lines: BasketLine[],
  customer: SaleCustomer | null
): { percent: number; amount: number } {
  if (!customer) return { percent: 0, amount: 0 }
  const perks = percentOffPerks(customer.perks)
  if (perks.length === 0) return { percent: 0, amount: 0 }

  let amount = 0
  let best = 0
  for (const line of lines) {
    const match = perks
      .filter((perk) => perk.scope.includes(line.kind))
      .sort((a, b) => b.value - a.value)[0]
    if (!match) continue
    best = Math.max(best, match.value)
    amount += applyPercent(lineTotal(line), match.value)
  }
  return { percent: best, amount }
}

/** A money-off voucher is a discount; the other kinds are not money here. */
export function voucherDiscountFor(voucher: RewardVoucher | null): number {
  if (!voucher) return 0
  return voucher.type === "money_off" ? voucher.value : 0
}

export function summarise(state: BasketState): BasketTotals {
  const subtotal = state.lines.reduce((total, line) => total + lineTotal(line), 0)
  const perk = perkFor(state.lines, state.customer)

  const manual =
    state.manualDiscount.kind === "amount"
      ? state.manualDiscount.value
      : state.manualDiscount.kind === "percent"
        ? applyPercent(subtotal, state.manualDiscount.value)
        : 0

  // A reward is the whole discount on a sale: the completion route checks
  // that `discount` equals the reward's value, so a perk or a manual amount
  // steps aside while one is applied rather than stacking on top of it.
  const voucher = voucherDiscountFor(state.voucher)
  const perkApplied = voucher > 0 ? 0 : perk.amount
  const manualApplied = voucher > 0 ? 0 : manual
  const discount = Math.min(
    subtotal,
    voucher > 0 ? voucher : perkApplied + manualApplied
  )
  const total = subtotal - discount

  const source: DiscountSource | null =
    voucher > 0
      ? "reward"
      : manualApplied > 0
        ? "manual"
        : perkApplied > 0
          ? "tier_perk"
          : null

  return {
    subtotal,
    perkPercent: voucher > 0 ? 0 : perk.percent,
    perkDiscount: perkApplied,
    manualDiscount: manualApplied,
    voucherDiscount: voucher,
    discount,
    discountSource: source,
    total,
    lineTotals: state.lines.map((line) => ({
      itemId: line.itemId,
      total:
        subtotal > 0
          ? lineTotal(line) - roundHalfUp((discount * lineTotal(line)) / subtotal)
          : 0,
    })),
  }
}

/** The points this sale would earn, through the same evaluator the server runs. */
export function pointsPreview(
  state: BasketState,
  totals: BasketTotals,
  setup: LoyaltySetup | undefined,
  paidWithPoints: number
): number {
  if (!setup || !state.customer) return 0
  const lines: SaleLineForPoints[] = state.lines.map((line) => ({
    game: line.game,
    kind: line.kind,
    total: totals.lineTotals.find((row) => row.itemId === line.itemId)?.total ?? 0,
  }))
  return evaluateSalePoints(setup.programme, setup.rules, {
    lines,
    at: new Date(),
    isFirstPurchase: false,
    isBirthdayMonth: false,
    tier: setup.tiers.find((tier) => tier.id === state.customer?.tierId) ?? null,
    paidWithPoints,
  }).total
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface PaymentContext {
  programme?: LoyaltyProgramme
  /** Is there an open cash session to take cash into? */
  cashSessionOpen: boolean
}

export interface PaymentCheck {
  ok: boolean
  /** What goes in `payment_split`, whichever method was chosen. */
  split: Record<SplitMethod, number>
  /** One sentence each, shown under the chips. Never a toast. */
  problems: string[]
  /** The figure to key into the SumUp terminal. */
  sumupAmount: number
  pointsSpent: number
}

/**
 * Whether this basket can be paid for the way it is set. A single method
 * covers the whole total; `mixed` has to sum to it exactly.
 */
export function checkPayment(
  state: BasketState,
  totals: BasketTotals,
  ctx: PaymentContext
): PaymentCheck {
  const split =
    state.payment === "mixed"
      ? { ...state.split }
      : { ...emptySplit(), [state.payment]: totals.total }

  const problems: string[] = []
  const summed = SPLIT_METHODS.reduce((total, method) => total + split[method], 0)

  if (totals.total === 0 && state.lines.length === 0) {
    problems.push("Scan an item to start a sale.")
  }

  if (state.voucher && state.customer?.id !== state.voucher.customer) {
    problems.push("A reward needs the customer it was issued to on the sale.")
  }

  if (state.payment === "mixed" && summed !== totals.total) {
    const gap = totals.total - summed
    problems.push(
      gap > 0
        ? `${formatGBP(gap)} of this sale is not covered yet.`
        : `That is ${formatGBP(-gap)} more than the total.`
    )
  }

  if (split.cash > 0 && !ctx.cashSessionOpen) {
    problems.push("Open a cash session before taking cash.")
  }

  if (split.store_credit > 0) {
    if (!state.customer) {
      problems.push("Attach a customer to pay with store credit.")
    } else if (split.store_credit > state.customer.creditBalance) {
      problems.push(
        `Short by ${formatGBP(split.store_credit - state.customer.creditBalance)} of store credit.`
      )
    }
  }

  let pointsSpent = 0
  if (split.points > 0) {
    if (!state.customer || !ctx.programme) {
      problems.push("Attach a customer to pay with points.")
    } else {
      pointsSpent = penceToPoints(split.points, ctx.programme)
      const check = checkPointsRedemption(
        ctx.programme,
        state.customer.pointsBalance,
        pointsSpent,
        totals.total
      )
      if (!check.ok) problems.push(pointsRefusal(check.reason, check.maxPointsForSale, ctx.programme))
    }
  }

  return {
    ok: problems.length === 0 && state.lines.length > 0,
    split,
    problems,
    sumupAmount: split.sumup_card,
    pointsSpent,
  }
}

function pointsRefusal(
  reason: "disabled" | "below_minimum" | "insufficient" | "over_share" | "ok",
  maxPoints: number,
  programme: LoyaltyProgramme
): string {
  switch (reason) {
    case "disabled":
      return "The points programme is switched off."
    case "below_minimum":
      return `Points start at ${programme.minRedeemPoints.toLocaleString("en-GB")} on a sale.`
    case "insufficient":
      return "That is more points than this customer has."
    case "over_share":
      return `Points cover at most ${maxPoints.toLocaleString("en-GB")} of this sale.`
    default:
      return ""
  }
}
