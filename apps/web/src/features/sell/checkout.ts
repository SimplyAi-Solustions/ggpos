/**
 * Taking the card part of a sale on the Solo reader, as a state machine.
 *
 * Pure: no React, no network. The Sell screen dispatches what happened and
 * renders what comes back, so the one part of this that must never be wrong,
 * what the counter believes about money that has already moved, is unit
 * tested on its own.
 *
 * The state that matters is `taken`: the customer has paid and the sale
 * would not complete. Nothing may quietly drop that. The sheet shows the
 * transaction code and the two ways out, refund it in the SumUp app or put
 * the basket right and complete the sale against the same checkout; closing
 * the sheet only moves that to `held`, which the Sell screen keeps on the
 * page until one of the two has happened.
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
  /** No money moved, and why. */
  | { phase: "stopped"; checkout: SumUpCheckout | null; reason: string }
  /** Money moved and the sale did not complete. The one state that cannot be lost. */
  | { phase: "taken"; checkout: SumUpCheckout; reason: string }
  /**
   * The same, with the sheet out of the way so the basket can be put right.
   * The Sell screen keeps the paid checkout and its code on the page, and
   * "Mark sold" completes the sale against it.
   */
  | { phase: "held"; checkout: SumUpCheckout; reason: string }

export type CardPaymentEvent =
  | { type: "take"; amount: number }
  | { type: "opened"; checkout: SumUpCheckout }
  | { type: "refused"; reason: string }
  | { type: "status"; checkout: SumUpCheckout }
  | { type: "completed" }
  | { type: "completionRefused"; reason: string }
  | { type: "close" }

export const IDLE: CardPaymentState = { phase: "idle" }

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
      if (state.phase === "waiting" || state.phase === "completing") return state
      return { phase: "opening", amount: event.amount }
    }

    case "opened": {
      if (state.phase !== "opening") return state
      // An idempotent create can hand back a checkout the customer has
      // already paid, which goes straight to completing the sale.
      if (event.checkout.status === "paid") {
        return { phase: "completing", checkout: event.checkout }
      }
      if (event.checkout.status === "pending") {
        return { phase: "waiting", checkout: event.checkout }
      }
      return {
        phase: "stopped",
        checkout: event.checkout,
        reason: stoppedReason(event.checkout),
      }
    }

    case "refused": {
      if (state.phase === "taken" || state.phase === "held") return state
      return { phase: "stopped", checkout: null, reason: event.reason }
    }

    case "status": {
      if (state.phase !== "waiting" && state.phase !== "completing") return state
      if (event.checkout.id !== state.checkout.id) return state
      if (event.checkout.status === "pending") return state
      if (event.checkout.status === "paid") {
        // Already completing: keep the checkout fresh, so the transaction
        // code is there if the sale then refuses.
        return { phase: "completing", checkout: event.checkout }
      }
      return {
        phase: "stopped",
        checkout: event.checkout,
        reason: stoppedReason(event.checkout),
      }
    }

    case "completed":
      return IDLE

    case "completionRefused": {
      // A second refusal, after the basket was meant to be put right, must
      // not lose the payment either.
      if (state.phase === "held") {
        return { phase: "held", checkout: state.checkout, reason: event.reason }
      }
      if (state.phase !== "completing") {
        return { phase: "stopped", checkout: null, reason: event.reason }
      }
      return { phase: "taken", checkout: state.checkout, reason: event.reason }
    }

    case "close": {
      // Closing on money that has moved puts the sheet away and nothing
      // else: the payment stays on the screen until the sale carries it.
      if (state.phase === "taken") {
        return { phase: "held", checkout: state.checkout, reason: state.reason }
      }
      if (state.phase === "held") return state
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
 * The paid checkout the sale must be completed against, whether the sale is
 * being completed now or is waiting for somebody to fix the basket.
 */
export function paidCheckoutId(state: CardPaymentState): string | null {
  if (
    state.phase === "completing" ||
    state.phase === "taken" ||
    state.phase === "held"
  ) {
    return state.checkout.id
  }
  return null
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
      return state.checkout?.amount ?? 0
    default:
      return 0
  }
}
