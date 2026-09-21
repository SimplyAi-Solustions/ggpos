import { describe, expect, it } from "vitest"

import {
  cardPaymentReducer,
  checkoutAmount,
  checkoutForBasket,
  heldPayment,
  IDLE,
  isCardPaymentLocked,
  isCardPaymentOpen,
  isStrandedPayment,
  paidCheckout,
  paymentReference,
  pendingCheckoutId,
  stoppedReason,
  type CardPaymentState,
} from "@/features/sell/checkout"
import type { SumUpCheckout } from "@/lib/api/types"

const BASKET = "basket-1"

const pending: SumUpCheckout = {
  id: "checkout_1",
  status: "pending",
  amount: 32499,
  sale_client_id: BASKET,
  reader_name: "Counter Solo",
  client_transaction_id: "ctx_1",
}

const paid: SumUpCheckout = {
  ...pending,
  status: "paid",
  transaction_code: "TEHY9001",
  card_last4: "4242",
  paid_at: "2026-09-20T09:03:00Z",
}

/** Take the card payment and have the customer pay it. */
function afterPaying(): CardPaymentState {
  let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
  state = cardPaymentReducer(state, { type: "opened", checkout: pending })
  return cardPaymentReducer(state, { type: "status", checkout: paid })
}

describe("taking the payment", () => {
  it("opens on the amount before the checkout exists", () => {
    const state = cardPaymentReducer(IDLE, { type: "take", amount: 4500 })
    expect(state).toEqual({ phase: "opening", amount: 4500 })
    expect(checkoutAmount(state)).toBe(4500)
    expect(isCardPaymentOpen(state)).toBe(true)
  })

  it("waits once the amount is on the reader", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    expect(state).toMatchObject({ phase: "waiting" })
    expect(pendingCheckoutId(state)).toBe("checkout_1")
    expect(paidCheckout(state)).toBeNull()
  })

  it("goes straight to completing when the checkout comes back already paid", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: paid })
    expect(state).toMatchObject({ phase: "completing" })
    expect(paidCheckout(state)?.id).toBe("checkout_1")
  })

  it("shows the server's own refusal when no checkout could be opened", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, {
      type: "refused",
      reason: "The reader is offline. Check it is on and connected, then try again.",
    })
    expect(state).toEqual({
      phase: "stopped",
      checkout: null,
      reason: "The reader is offline. Check it is on and connected, then try again.",
      retry: true,
    })
  })

  it("does not open a second checkout while one is on the reader", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    expect(cardPaymentReducer(state, { type: "take", amount: 32499 })).toBe(state)
  })
})

describe("what the reader says next", () => {
  it("completes the sale once the customer has paid", () => {
    const state = afterPaying()
    expect(state).toMatchObject({ phase: "completing" })
    expect(paidCheckout(state)?.id).toBe("checkout_1")
    expect(cardPaymentReducer(state, { type: "completed" })).toEqual(IDLE)
  })

  it("stays put while the row is still pending", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    expect(cardPaymentReducer(state, { type: "status", checkout: pending })).toBe(state)
  })

  it("says why in one sentence when the card is declined", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    state = cardPaymentReducer(state, {
      type: "status",
      checkout: {
        ...pending,
        status: "failed",
        error: "The card was declined. Ask for another card, or take the payment another way.",
      },
    })
    expect(state).toMatchObject({
      phase: "stopped",
      reason:
        "The card was declined. Ask for another card, or take the payment another way.",
    })
  })

  it("has words of its own for a failure that arrived without any", () => {
    expect(stoppedReason({ ...pending, status: "failed" })).toBe(
      "The card payment did not go through. Try again, or take the money another way."
    )
    expect(stoppedReason({ ...pending, status: "cancelled" })).toBe(
      "The payment was stopped before the customer paid."
    )
    expect(stoppedReason({ ...pending, status: "expired" })).toBe(
      "The reader stopped waiting for that payment. Take it again."
    )
  })

  it("never lets a stray update take a paid payment away", () => {
    const completing = afterPaying()
    const stray = cardPaymentReducer(completing, {
      type: "status",
      checkout: { ...paid, status: "expired" },
    })
    expect(stray).toBe(completing)
    expect(paidCheckout(stray)?.id).toBe("checkout_1")
  })

  it("ignores an update about some other checkout", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    expect(
      cardPaymentReducer(state, {
        type: "status",
        checkout: { ...paid, id: "checkout_other" },
      })
    ).toBe(state)
  })

  it("can be tried again after a decline", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    state = cardPaymentReducer(state, {
      type: "status",
      checkout: { ...pending, status: "failed" },
    })
    expect(cardPaymentReducer(state, { type: "take", amount: 32499 })).toMatchObject({
      phase: "opening",
    })
  })
})

describe("money taken on a sale that will not complete", () => {
  it("holds the paid checkout and the reason on screen", () => {
    const state = cardPaymentReducer(afterPaying(), {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    expect(state).toMatchObject({
      phase: "taken",
      reason: "Open a cash session before taking cash.",
    })
    expect(state.phase === "taken" ? state.checkout.transaction_code : "").toBe(
      "TEHY9001"
    )
  })

  it("keeps the checkout so the sale can be completed against it", () => {
    const state = cardPaymentReducer(afterPaying(), {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    expect(paidCheckout(state)?.id).toBe("checkout_1")
    expect(checkoutAmount(state)).toBe(32499)
  })

  it("is never started over or refused away, because the money is real", () => {
    const taken = cardPaymentReducer(afterPaying(), {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    expect(cardPaymentReducer(taken, { type: "take", amount: 32499 })).toBe(taken)
    expect(cardPaymentReducer(taken, { type: "refused", reason: "x." })).toBe(taken)
  })

  it("closes to a line on the page, so the basket can be put right", () => {
    const taken = cardPaymentReducer(afterPaying(), {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    const held = cardPaymentReducer(taken, { type: "close" })
    expect(held).toMatchObject({ phase: "held" })
    expect(isCardPaymentOpen(held)).toBe(false)
    expect(heldPayment(held)?.checkout.transaction_code).toBe("TEHY9001")
    expect(paidCheckout(held)?.id).toBe("checkout_1")
    expect(checkoutAmount(held)).toBe(32499)
    // And pressing the button again does not open a second checkout.
    expect(cardPaymentReducer(held, { type: "take", amount: 32499 })).toBe(held)
    expect(cardPaymentReducer(held, { type: "close" })).toBe(held)
  })

  it("keeps the payment when the sale is refused a second time", () => {
    const held = cardPaymentReducer(
      cardPaymentReducer(afterPaying(), {
        type: "completionRefused",
        reason: "Open a cash session before taking cash.",
      }),
      { type: "close" }
    )
    const again = cardPaymentReducer(held, {
      type: "completionRefused",
      reason: "The cash part is more than the cash cap allows.",
    })
    expect(again).toMatchObject({
      phase: "held",
      reason: "The cash part is more than the cash cap allows.",
    })
    expect(paidCheckout(again)?.id).toBe("checkout_1")
  })

  it("clears once the sale finally goes through", () => {
    const taken = cardPaymentReducer(afterPaying(), {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    expect(cardPaymentReducer(taken, { type: "completed" })).toEqual(IDLE)
    const held = cardPaymentReducer(taken, { type: "close" })
    expect(cardPaymentReducer(held, { type: "completed" })).toEqual(IDLE)
    expect(heldPayment(IDLE)).toBeNull()
  })

  it("is a plain stop when the sale refused before any money moved", () => {
    const state = cardPaymentReducer(IDLE, {
      type: "completionRefused",
      reason: "That sale did not go through. Try again.",
    })
    expect(state).toMatchObject({ phase: "stopped", checkout: null })
  })
})

describe("a live payment has one way out", () => {
  it("is locked while the amount is going to the reader and while it is there", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    expect(isCardPaymentLocked(state)).toBe(true)
    // Esc, the backdrop and the corner cross all arrive here, and none of
    // them may leave a customer paying with nothing watching.
    expect(cardPaymentReducer(state, { type: "close" })).toBe(state)

    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    expect(isCardPaymentLocked(state)).toBe(true)
    expect(cardPaymentReducer(state, { type: "close" })).toBe(state)
    expect(pendingCheckoutId(cardPaymentReducer(state, { type: "close" }))).toBe(
      "checkout_1"
    )
  })

  it("is locked while the sale is being completed, so a refusal still lands", () => {
    const state = afterPaying()
    expect(isCardPaymentLocked(state)).toBe(true)
    const stillCompleting = cardPaymentReducer(state, { type: "close" })
    expect(stillCompleting).toBe(state)
    // And the refusal that follows says money was taken, with the code.
    const refused = cardPaymentReducer(stillCompleting, {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    expect(refused).toMatchObject({ phase: "taken" })
    expect(paidCheckout(refused)?.transaction_code).toBe("TEHY9001")
  })

  it("closes from every phase that is not live", () => {
    expect(cardPaymentReducer(IDLE, { type: "close" })).toEqual(IDLE)
    const stopped = cardPaymentReducer(IDLE, {
      type: "refused",
      reason: "The reader is offline. Check it is on and connected, then try again.",
    })
    expect(cardPaymentReducer(stopped, { type: "close" })).toEqual(IDLE)
    expect(isCardPaymentLocked(stopped)).toBe(false)
  })

  it("does not offer another go at a refusal that cannot be got past", () => {
    const busy = cardPaymentReducer(
      cardPaymentReducer(IDLE, { type: "take", amount: 32499 }),
      {
        type: "refused",
        reason: "The reader is busy with another payment. Finish or cancel that one first.",
        retry: false,
      }
    )
    expect(busy).toMatchObject({ phase: "stopped", retry: false })
  })
})

describe("a payment belongs to one basket", () => {
  it("is only ever completed against the basket it was taken for", () => {
    const held = cardPaymentReducer(
      cardPaymentReducer(afterPaying(), {
        type: "completionRefused",
        reason: "Open a cash session before taking cash.",
      }),
      { type: "close" }
    )
    expect(checkoutForBasket(held, BASKET)).toBe("checkout_1")
    expect(checkoutForBasket(held, "basket-2")).toBeNull()
    expect(isStrandedPayment(held, "basket-2")).toBe(true)
    expect(isStrandedPayment(held, BASKET)).toBe(false)
  })

  it("carries nothing when there is no payment at all", () => {
    expect(checkoutForBasket(IDLE, BASKET)).toBeNull()
    expect(isStrandedPayment(IDLE, BASKET)).toBe(false)
  })

  it("is put down when the staff member says it has been refunded", () => {
    const taken = cardPaymentReducer(afterPaying(), {
      type: "completionRefused",
      reason: "Open a cash session before taking cash.",
    })
    expect(cardPaymentReducer(taken, { type: "refunded" })).toEqual(IDLE)
    const held = cardPaymentReducer(taken, { type: "close" })
    expect(cardPaymentReducer(held, { type: "refunded" })).toEqual(IDLE)
    // And nothing else is put down by it.
    expect(cardPaymentReducer(IDLE, { type: "refunded" })).toEqual(IDLE)
  })
})

describe("something to find the payment by", () => {
  it("leads with the receipt code staff read off the slip", () => {
    expect(paymentReference(paid)).toEqual({
      label: "SumUp transaction",
      value: "TEHY9001",
    })
  })

  it("falls back through the ids, then the card and the time", () => {
    expect(
      paymentReference({ ...paid, transaction_code: "", transaction_id: "txn_9" })
    ).toEqual({ label: "SumUp transaction id", value: "txn_9" })
    expect(
      paymentReference({ ...paid, transaction_code: "", transaction_id: "" })
    ).toEqual({ label: "Reader payment id", value: "ctx_1" })
    expect(
      paymentReference({
        ...paid,
        transaction_code: "",
        transaction_id: "",
        client_transaction_id: "",
      })
    ).toEqual({ label: "Card", value: "Ending 4242 at 09:03" })
    expect(
      paymentReference({
        ...paid,
        transaction_code: "",
        transaction_id: "",
        client_transaction_id: "",
        card_last4: "",
      })
    ).toBeNull()
  })
})

describe("closing the sheet", () => {
  it("puts the till back to nothing on the reader", () => {
    let state = cardPaymentReducer(IDLE, { type: "take", amount: 32499 })
    state = cardPaymentReducer(state, { type: "opened", checkout: pending })
    state = cardPaymentReducer(state, {
      type: "status",
      checkout: { ...pending, status: "cancelled" },
    })
    expect(cardPaymentReducer(state, { type: "close" })).toEqual(IDLE)
    expect(isCardPaymentOpen(IDLE)).toBe(false)
    expect(checkoutAmount(IDLE)).toBe(0)
  })
})
