/**
 * Taking the card part of a sale on the Solo reader, as a state machine.
 *
 * Pure: no React, no network. The Sell screen dispatches what happened and
 * renders what comes back, so the one part of this that must never be wrong,
 * what the counter believes about money that has already moved, is unit
 * tested on its own.
 *
 * Two rules the reducer, not the screen, is responsible for:
 *
 * 1. While an amount is on the reader (`opening`, `waiting`, `completing`)
 *    there is no way out but Cancel, which terminates at the reader. `close`
 *    is a no-op in those phases, so Esc, the backdrop and a stray tap cannot
 *    leave a live payment with nothing watching it.
 * 2. Money that has moved is never lost. `taken` and `held` keep the paid
 *    checkout, its transaction reference and the reason the sale refused,
 *    and only a completed sale, or a staff member saying the payment has
 *    been refunded, puts them down.
 *
 * Both states carry the checkout, and the checkout carries the
 * `sale_client_id` of the basket it was taken for, so a payment can only
 * ever be attached to the sale it belongs to.
 */
import type { SumUpCheckout } from "@/lib/api/types"

export type CardPaymentState =
  /** Nothing on the reader. */
  | { phase: "idle" }
  /** The checkout is being created. */
  | { phase: "opening"; amount: number }
  /** The amount is on the reader and the customer is paying. */
  | { phase: "waiting"; checkout: SumUpCheckout }
  /** Paid: the sale is being completed against this checkout. */
  | { phase: "completing"; checkout: SumUpCheckout }
  /**
   * No money moved, and why. The amount is kept even where no checkout was
   * ever opened, so the sheet says what was being taken rather than nothing.
   * `retry` is false where trying again cannot work until something else
   * changes, such as a reader busy with somebody else's payment.
   */
  | {
      phase: "stopped"
      checkout: SumUpCheckout | null
      amount: number
      reason: string
      retry: boolean
    }
  /** Money moved and the sale did not complete. The one state that cannot be lost. */
  | { phase: "taken"; checkout: SumUpCheckout; reason: string }
  /**
   * The same, with the sheet out of the way so the basket can be put right.
   * The Sell screen keeps the paid checkout and its reference on the page,
   * and "Mark sold" completes the sale against it.
   */
  | { phase: "held"; checkout: SumUpCheckout; reason: string }

export type CardPaymentEvent =
  | { type: "take"; amount: number }
  | { type: "opened"; checkout: SumUpCheckout }
  /** `retry` false for a refusal that trying again cannot get past. */
  | { type: "refused"; reason: string; retry?: boolean }
  | { type: "status"; checkout: SumUpCheckout }
  /** A sale went through. `checkoutId` is the payment it carried, if any. */
  | { type: "completed"; checkoutId?: string }
  | { type: "completionRefused"; reason: string }
  | { type: "close" }
  /** Staff have refunded it in the SumUp app: the only way to put money down. */
  | { type: "refunded" }

export const IDLE: CardPaymentState = { phase: "idle" }

/** The phases where an amount is live on the reader and cannot be walked away from. */
export function isCardPaymentLocked(state: CardPaymentState): boolean {
  return (
    state.phase === "opening" ||
    state.phase === "waiting" ||
    state.phase === "completing"
  )
}

/** One sentence for an ending that is not a payment. */
export function stoppedReason(checkout: SumUpCheckout): string {
  if (checkout.error) return checkout.error
  if (checkout.status === "cancelled") {
    return "The payment was stopped before the customer paid."
  }
  if (checkout.status === "expired") {
    return "The reader stopped waiting for that payment. Take it again."
  }
  return "The card payment did not go through. Try again, or take the money another way."
}

export function cardPaymentReducer(
  state: CardPaymentState,
  event: CardPaymentEvent
): CardPaymentState {
  switch (event.type) {
    case "take": {
      // Money already taken is never thrown away by pressing the button
      // again: the screen is showing what to do about it.
      if (state.phase === "taken" || state.phase === "held") return state
      if (isCardPaymentLocked(state)) return state
      return { phase: "opening", amount: event.amount }
    }

    case "opened": {
      if (state.phase !== "opening") return state
      // The route is idempotent per basket, so it can hand back a checkout
      // the customer has already paid: that goes straight to completing the
      // sale rather than asking for the money twice.
      if (event.checkout.status === "paid") {
        return { phase: "completing", checkout: event.checkout }
      }
      if (event.checkout.status === "pending") {
        return { phase: "waiting", checkout: event.checkout }
      }
      return {
        phase: "stopped",
        checkout: event.checkout,
        amount: event.checkout.amount,
        reason: stoppedReason(event.checkout),
        retry: true,
      }
    }

    case "refused": {
      if (state.phase === "taken" || state.phase === "held") return state
      return {
        phase: "stopped",
        checkout: null,
        amount: checkoutAmount(state),
        reason: event.reason,
        retry: event.retry !== false,
      }
    }

    case "status": {
      if (state.phase !== "waiting" && state.phase !== "completing") return state
      if (event.checkout.id !== state.checkout.id) return state
      if (event.checkout.status === "pending") return state
      if (event.checkout.status === "paid") {
        // Already completing: keep the checkout fresh, so the reference is
        // there if the sale then refuses.
        return { phase: "completing", checkout: event.checkout }
      }
      // Nothing moves a paid checkout out of `completing`. The server never
      // leaves a final state, so this cannot arrive from it; the reducer is
      // where that guarantee is kept whatever arrives.
      if (state.phase === "completing") return state
      return {
        phase: "stopped",
        checkout: event.checkout,
        amount: event.checkout.amount,
        reason: stoppedReason(event.checkout),
        retry: true,
      }
    }

    case "completed": {
      const held = paidCheckout(state)
      // A sale that carried no card payment does not put one down: money
      // taken for an earlier basket stays on the screen until it is
      // carried or refunded, whatever else is rung up in the meantime.
      if (held && held.id !== event.checkoutId) return state
      return IDLE
    }

    case "completionRefused": {
      // Wherever a paid checkout is being held, a refusal keeps it and says
      // why: the amount, the reference and the two ways out.
      if (state.phase === "completing" || state.phase === "taken") {
        return { phase: "taken", checkout: state.checkout, reason: event.reason }
      }
      if (state.phase === "held") {
        return { phase: "held", checkout: state.checkout, reason: event.reason }
      }
      return {
        phase: "stopped",
        checkout: null,
        amount: checkoutAmount(state),
        reason: event.reason,
        retry: true,
      }
    }

    case "close": {
      // There is no way out of a live payment but Cancel, which stops it at
      // the reader; Esc and the backdrop reach here and are refused.
      if (isCardPaymentLocked(state)) return state
      if (state.phase === "taken") {
        return { phase: "held", checkout: state.checkout, reason: state.reason }
      }
      if (state.phase === "held") return state
      return IDLE
    }

    case "refunded": {
      // Said by a staff member who has just refunded it in the SumUp app.
      if (state.phase !== "taken" && state.phase !== "held") return state
      return IDLE
    }

    default:
      return state
  }
}

/** Whether the sheet is on screen at all. */
export function isCardPaymentOpen(state: CardPaymentState): boolean {
  return state.phase !== "idle" && state.phase !== "held"
}

/** A payment the sale still has to carry, said on the page rather than in a sheet. */
export function heldPayment(
  state: CardPaymentState
): { checkout: SumUpCheckout; reason: string } | null {
  return state.phase === "held" ? { checkout: state.checkout, reason: state.reason } : null
}

/** The row to poll and subscribe to while the customer is paying. */
export function pendingCheckoutId(state: CardPaymentState): string | null {
  return state.phase === "waiting" ? state.checkout.id : null
}

/**
 * The paid checkout, whether the sale is being completed now or is waiting
 * for somebody to fix the basket.
 */
export function paidCheckout(state: CardPaymentState): SumUpCheckout | null {
  if (
    state.phase === "completing" ||
    state.phase === "taken" ||
    state.phase === "held"
  ) {
    return state.checkout
  }
  return null
}

/**
 * The checkout to complete this basket against, and nothing else.
 *
 * A payment belongs to the basket it was taken for. Where the basket has
 * moved on, this is null and the sale completes with no card payment on it,
 * rather than spending one customer's money on the next customer's sale.
 *
 * A sale with no card part carries no card payment either: a cash sale rung
 * up while a payment is still held goes through as cash, and the payment
 * stays on the screen until it is carried or refunded.
 */
export function checkoutForBasket(
  state: CardPaymentState,
  saleClientId: string,
  cardPart: number
): string | null {
  const checkout = paidCheckout(state)
  if (!checkout) return null
  if (cardPart <= 0) return null
  if (!checkout.sale_client_id) return null
  return checkout.sale_client_id === saleClientId ? checkout.id : null
}

/** True when money is held for a basket that is no longer on the screen. */
export function isStrandedPayment(
  state: CardPaymentState,
  saleClientId: string
): boolean {
  const checkout = paidCheckout(state)
  if (!checkout) return false
  return Boolean(checkout.sale_client_id) && checkout.sale_client_id !== saleClientId
}

/** The amount the sheet shows, whatever it is showing about it. */
export function checkoutAmount(state: CardPaymentState): number {
  switch (state.phase) {
    case "opening":
      return state.amount
    case "waiting":
    case "completing":
    case "taken":
    case "held":
      return state.checkout.amount
    case "stopped":
      return state.amount
    default:
      return 0
  }
}

export interface PaymentReference {
  /** What the reference is called where staff will look for it. */
  label: string
  value: string
}

/**
 * Something to find the payment by in the SumUp app.
 *
 * The receipt code is what staff read off the slip, so it leads. SumUp's
 * own fields are all optional, though, and a payment nobody can point at is
 * the one thing this state must never be: the transaction id, then the id
 * the checkout was tracked by, then the card and the time, each named so
 * nobody mistakes one for another.
 */
export function paymentReference(checkout: SumUpCheckout): PaymentReference | null {
  if (checkout.transaction_code) {
    return { label: "SumUp transaction", value: checkout.transaction_code }
  }
  if (checkout.transaction_id) {
    return { label: "SumUp transaction id", value: checkout.transaction_id }
  }
  if (checkout.client_transaction_id) {
    return { label: "Reader payment id", value: checkout.client_transaction_id }
  }
  if (checkout.card_last4) {
    const at = checkout.paid_at ? ` at ${checkout.paid_at.slice(11, 16)}` : ""
    return { label: "Card", value: `Ending ${checkout.card_last4}${at}` }
  }
  return null
}
