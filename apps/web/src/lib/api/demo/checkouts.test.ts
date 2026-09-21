import { afterEach, describe, expect, it } from "vitest"
import { formatGBP } from "@gg/shared"

import {
  cancelCheckout,
  createCheckout,
  getCheckout,
  listReaders,
  spendCheckoutOnSale,
} from "@/lib/api/demo/checkouts"

/** The demo reader's own switch, the one the e2e suite drives it with. */
function reader(mode: string) {
  if (mode) localStorage.setItem("gg-demo-reader", mode)
  else localStorage.removeItem("gg-demo-reader")
}

afterEach(() => reader(""))

function open(saleClientId = "basket-1", amount = 32499) {
  return createCheckout({ amount, saleClientId, description: "1 item" })
}

describe("one payment per basket", () => {
  it("puts the amount on the reader the shop has paired", () => {
    const { checkout, reused } = open()
    expect(reused).toBe(false)
    expect(checkout).toMatchObject({
      status: "pending",
      amount: 32499,
      sale_client_id: "basket-1",
      reader_name: "Counter Solo",
    })
    // Something to verify the payment by afterwards, always.
    expect(checkout.client_transaction_id).toBeTruthy()
    expect(listReaders().not_configured).toBe(false)
  })

  it("hands back the amount already on the reader rather than a second one", () => {
    const first = open("basket-2")
    const second = open("basket-2")
    expect(second.reused).toBe(true)
    expect(second.checkout.id).toBe(first.checkout.id)
  })

  it("hands back a payment already made for that basket, and never overwrites it", () => {
    reader("prepaid")
    const paid = open("basket-3")
    expect(paid.reused).toBe(true)
    expect(paid.checkout.status).toBe("paid")
    expect(paid.checkout.transaction_code).toMatch(/TEHY\d+/)

    // Asking again finds the paid row rather than replacing it with a
    // pending one, which is what would lose a payment the customer made.
    reader("")
    const again = open("basket-3")
    expect(again.reused).toBe(true)
    expect(again.checkout.id).toBe(paid.checkout.id)
    expect(again.checkout.status).toBe("paid")
    expect(getCheckout(paid.checkout.id).status).toBe("paid")
  })
})

describe("the refusals the reader can answer with", () => {
  it("says the reader is busy with somebody else's payment", () => {
    reader("busy")
    expect(() => open("basket-busy")).toThrow(
      "The reader is busy with another payment. Finish or cancel that one first."
    )
  })

  it("says so when SumUp gives the payment no reference", () => {
    reader("noref")
    expect(() => open("basket-noref")).toThrow(
      "SumUp did not give that payment a reference, so it could not be tracked."
    )
  })

  it("says SumUp is not set up at all", () => {
    reader("off")
    expect(() => open("basket-off")).toThrow("SumUp is not set up.")
    expect(listReaders().not_configured).toBe(true)
  })

  it("says nothing is paired", () => {
    reader("unpaired")
    expect(() => open("basket-unpaired")).toThrow("No card reader is paired.")
  })

  it("refuses an amount that is not whole pence above zero", () => {
    expect(() => open("basket-bad", 0)).toThrow(
      "The card part of this sale is not an amount the reader can take."
    )
  })
})

describe("a payment against a sale", () => {
  function paidFor(basket: string) {
    reader("prepaid")
    const { checkout } = open(basket)
    reader("")
    return checkout
  }

  it("must be paid", () => {
    const { checkout } = open("basket-pending")
    expect(() =>
      spendCheckoutOnSale(
        checkout.id,
        32499,
        { id: "sale_1", number: "GG-S-000456" },
        formatGBP
      )
    ).toThrow(
      "That card payment is pending, not paid. Take the payment on the reader before completing the sale."
    )
  })

  it("must be for the card part of the sale, and says both figures", () => {
    const checkout = paidFor("basket-mismatch")
    expect(() =>
      spendCheckoutOnSale(
        checkout.id,
        30000,
        { id: "sale_2", number: "GG-S-000457" },
        formatGBP
      )
    ).toThrow(
      "The reader took £324.99 but the card part of this sale is £300.00. Adjust the split or refund the difference from the SumUp app."
    )
  })

  it("can only be spent once, and the refusal names the sale that has it", () => {
    const checkout = paidFor("basket-once")
    spendCheckoutOnSale(
      checkout.id,
      32499,
      { id: "sale_3", number: "GG-S-000458" },
      formatGBP
    )
    expect(() =>
      spendCheckoutOnSale(
        checkout.id,
        32499,
        { id: "sale_4", number: "GG-S-000459" },
        formatGBP
      )
    ).toThrow("That card payment has already been used on sale GG-S-000458.")
  })

  it("is not offered again to the basket that spent it", () => {
    const checkout = paidFor("basket-spent")
    spendCheckoutOnSale(
      checkout.id,
      32499,
      { id: "sale_5", number: "GG-S-000460" },
      formatGBP
    )
    const next = open("basket-spent")
    expect(next.reused).toBe(false)
    expect(next.checkout.id).not.toBe(checkout.id)
  })

  it("is not found where there is no such payment", () => {
    expect(() =>
      spendCheckoutOnSale(
        "checkout_nowhere",
        1,
        { id: "sale_6", number: "GG-S-000461" },
        formatGBP
      )
    ).toThrow("That card payment was not found. Take the payment on the reader again.")
  })
})

describe("stopping a payment", () => {
  it("carries the paid checkout back with the refusal when it is too late", () => {
    const checkout = (() => {
      reader("prepaid")
      const made = open("basket-late").checkout
      reader("")
      return made
    })()

    try {
      cancelCheckout(checkout.id)
      throw new Error("the cancel should have been refused")
    } catch (error) {
      const body = (error as { response?: { checkout?: { id: string } } }).response
      expect((error as Error).message).toBe("The customer already paid. Complete the sale.")
      expect(body?.checkout?.id).toBe(checkout.id)
    }
  })

  it("stops a payment nobody has made yet", () => {
    const { checkout } = open("basket-stop")
    expect(cancelCheckout(checkout.id).status).toBe("cancelled")
  })
})
