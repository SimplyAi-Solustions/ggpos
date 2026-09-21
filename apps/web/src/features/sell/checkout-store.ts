/**
 * The card payment on the open sale, held outside React.
 *
 * It lives beside the basket, and for the same reason: a payment the reader
 * has already taken has to survive walking to the Cash screen to open a
 * drawer and walking back. React state would not.
 *
 * Clearing the basket ends the sale, so `clearCardPayment` puts the card
 * state down with it, with one exception that is the whole point of this
 * module: money that has actually moved stays on the screen until the sale
 * carries it or a staff member says it has been refunded.
 */
import * as React from "react"

import {
  cardPaymentReducer,
  IDLE,
  paidCheckout,
  type CardPaymentEvent,
  type CardPaymentState,
} from "@/features/sell/checkout"

let state: CardPaymentState = IDLE
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCardPayment(): CardPaymentState {
  return state
}

export function dispatchCardPayment(event: CardPaymentEvent) {
  const next = cardPaymentReducer(state, event)
  if (next === state) return
  state = next
  emit()
}

/**
 * The basket has been cleared, so the sale it belonged to is over.
 *
 * A payment that never happened goes with it. A payment that did happen
 * stays: it is still on the customer's card, and the Sell screen goes on
 * showing it, with its reference, until the sale carries it or somebody
 * refunds it in the SumUp app.
 */
export function clearCardPayment() {
  if (paidCheckout(state)) return
  if (state === IDLE) return
  state = IDLE
  emit()
}

/** Re-renders whenever the payment moves. */
export function useCardPayment(): CardPaymentState {
  return React.useSyncExternalStore(subscribe, getCardPayment, getCardPayment)
}
