/**
 * The card payment on the open sale, held outside React.
 *
 * It lives beside the basket, and for the same reason: a payment the reader
 * has already taken has to survive walking to the Cash screen to open a
 * drawer and walking back. React state would not. Nothing here is a record,
 * and clearing the basket clears this too, by way of the sale that completes
 * it.
 */
import * as React from "react"

import {
  cardPaymentReducer,
  IDLE,
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

/** Re-renders whenever the payment moves. */
export function useCardPayment(): CardPaymentState {
  return React.useSyncExternalStore(subscribe, getCardPayment, getCardPayment)
}

/** Tests and the screenshot script start from nothing on the reader. */
export function resetCardPayment() {
  state = IDLE
  emit()
}
