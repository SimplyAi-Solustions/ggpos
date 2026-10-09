import { describe, expect, it } from "vitest"

import {
  amountDue,
  CARD_LAST4,
  changeDue,
  checkRefundTenders,
  checkSaleTenders,
  MAX_TENDERS,
  NEEDS_CUSTOMER,
  PART_EXCHANGE_LATER,
  paymentFor,
  REFUND_NEEDS_CUSTOMER,
  splitFor,
  SUMUP_GONE,
  sumProblem,
  toTender,
} from "../src/tenders"

/**
 * The till runs these before it sends a sale or a refund and the server runs
 * the same functions before it writes anything, so these pin down the
 * sentences and the arithmetic the two have to agree on.
 */

const rules = { total: 4000, requireCardLast4: true, hasCustomer: false }

function refused(result: ReturnType<typeof checkSaleTenders>): string {
  if (result.ok) throw new Error("expected a refusal")
  return result.message
}

describe("a sale's tenders", () => {
  it("accepts a split of cash and card that comes to the total, with change from the cash", () => {
    const result = checkSaleTenders(
      [
        { method: "cash", amount: 1500, tendered: 2000 },
        { method: "card_tide", amount: 2500, card_last4: "4242", reference: "A1B2" },
      ],
      rules
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paid).toBe(4000)
    expect(result.change).toBe(500)
    expect(result.cash).toBe(1500)
    expect(result.tenders).toEqual([
      { method: "cash", amount: 1500, tendered: 2000, change: 500, card_last4: "", reference: "" },
      { method: "card_tide", amount: 2500, tendered: 2500, change: 0, card_last4: "4242", reference: "A1B2" },
    ])
  })

  it("treats cash with no tendered figure as handed over exactly", () => {
    const result = checkSaleTenders([{ method: "cash", amount: 4000 }], rules)
    expect(result.ok && result.tenders[0]).toMatchObject({ tendered: 4000, change: 0 })
  })

  it("says what the payments come to when they do not match the total", () => {
    const message = refused(
      checkSaleTenders([{ method: "card_tide", amount: 3800, card_last4: "1234" }], rules)
    )
    expect(message).toBe("The payments come to £38.00 but the total is £40.00.")
    expect(sumProblem(3800, 4000)).toBe(message)
  })

  it("allows only one cash tender", () => {
    expect(
      refused(
        checkSaleTenders(
          [
            { method: "cash", amount: 2000 },
            { method: "cash", amount: 2000 },
          ],
          rules
        )
      )
    ).toBe("There are two cash payments. Put the cash together as one payment.")
  })

  it("refuses cash handed over that does not cover what it pays", () => {
    expect(refused(checkSaleTenders([{ method: "cash", amount: 4000, tendered: 2000 }], rules))).toBe(
      "£20.00 does not cover the £40.00 cash payment. Key what the customer handed over."
    )
  })

  it("gives change from cash only", () => {
    expect(
      refused(checkSaleTenders([{ method: "card_tide", amount: 4000, tendered: 5000, card_last4: "1234" }], rules))
    ).toBe("Only cash gives change. Key the exact amount for every other payment.")
  })

  it("asks for the card's last four digits when the shop wants them, and checks them when given", () => {
    expect(refused(checkSaleTenders([{ method: "card_tide", amount: 4000 }], rules))).toBe(CARD_LAST4)
    expect(refused(checkSaleTenders([{ method: "card_tide", amount: 4000, card_last4: "42" }], rules))).toBe(
      "Key the last four digits of the card."
    )
    const relaxed = { ...rules, requireCardLast4: false }
    expect(checkSaleTenders([{ method: "card_tide", amount: 4000 }], relaxed).ok).toBe(true)
    expect(refused(checkSaleTenders([{ method: "card_tide", amount: 4000, card_last4: "12a4" }], relaxed))).toBe(
      CARD_LAST4
    )
  })

  it("needs a customer for store credit and points, and says so as its own kind of refusal", () => {
    const result = checkSaleTenders([{ method: "store_credit", amount: 4000 }], rules)
    expect(result).toEqual({ ok: false, code: "needs_customer", message: NEEDS_CUSTOMER })
    expect(checkSaleTenders([{ method: "points", amount: 4000 }], { ...rules, hasCustomer: true }).ok).toBe(true)
  })

  it("refuses SumUp, part-exchange for now, and anything it does not know", () => {
    expect(refused(checkSaleTenders([{ method: "sumup_card", amount: 4000 }], rules))).toBe(SUMUP_GONE)
    expect(refused(checkSaleTenders([{ method: "part_exchange", amount: 4000 }], rules))).toBe(PART_EXCHANGE_LATER)
    expect(refused(checkSaleTenders([{ method: "gift_card", amount: 4000 }], rules))).toBe(
      "Pick how the customer is paying: cash, card, store credit or points."
    )
  })

  it("refuses an amount that is not whole pence above zero", () => {
    for (const amount of [0, -100, 12.5, "4000", null]) {
      expect(refused(checkSaleTenders([{ method: "cash", amount }], rules))).toBe(
        "Each payment needs an amount above £0.00."
      )
    }
  })

  it("takes no payment for a sale that comes to nothing", () => {
    expect(checkSaleTenders([], { ...rules, total: 0 })).toEqual({
      ok: true,
      tenders: [],
      paid: 0,
      change: 0,
      cash: 0,
    })
    expect(checkRefundTenders(undefined, { amount: 0, hasCustomer: false }).ok).toBe(true)
  })

  it("refuses no tenders at all, and too many", () => {
    expect(refused(checkSaleTenders([], rules))).toBe("Add how the customer is paying.")
    expect(refused(checkSaleTenders(undefined, rules))).toBe("Add how the customer is paying.")
    const many = Array.from({ length: MAX_TENDERS + 1 }, () => ({ method: "points", amount: 1 }))
    expect(refused(checkSaleTenders(many, { ...rules, hasCustomer: true }))).toBe(
      "A sale can take up to 10 payments. Put some of them together."
    )
  })
})

describe("what a set of tenders says about the sale", () => {
  it("names the one method, or mixed", () => {
    expect(paymentFor([{ method: "cash" }])).toBe("cash")
    expect(paymentFor([{ method: "card_tide" }, { method: "card_tide" }])).toBe("card_tide")
    expect(paymentFor([{ method: "cash" }, { method: "card_tide" }])).toBe("mixed")
  })

  it("mirrors the old payment split, with SumUp always at zero", () => {
    expect(
      splitFor([
        { method: "cash", amount: 1500 },
        { method: "card_tide", amount: 2500 },
      ])
    ).toEqual({ sumup_card: 0, cash: 1500, store_credit: 0, points: 0, card_tide: 2500 })
  })

  it("works out change and what is still due", () => {
    expect(changeDue(2000, 1500)).toBe(500)
    expect(changeDue(1000, 1500)).toBe(0)
    expect(amountDue(4000, [{ amount: 1500 }])).toBe(2500)
    expect(amountDue(4000, [{ amount: 1500 }, { amount: 3000 }])).toBe(-500)
  })

  it("labels a stored tender, historic SumUp included", () => {
    expect(toTender({ method: "sumup_card", amount: 1999 })).toEqual({
      method: "sumup_card",
      label: "Card (SumUp)",
      amount: 1999,
      tendered: 0,
      change: 0,
      card_last4: "",
      reference: "",
    })
    expect(toTender({ method: "card_tide", amount: -500, card_last4: "4242" }).label).toBe("Card")
  })
})

describe("a refund's tenders", () => {
  const refund = { amount: 2500, hasCustomer: true }

  it("accepts cash, card and store credit that come to the refund amount", () => {
    const result = checkRefundTenders(
      [
        { method: "cash", amount: 1000 },
        { method: "card_tide", amount: 1000 },
        { method: "store_credit", amount: 500 },
      ],
      refund
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cash).toBe(1000)
    expect(result.tenders.map((t) => t.method)).toEqual(["cash", "card_tide", "store_credit"])
  })

  it("says what the payments back come to when they do not match", () => {
    const result = checkRefundTenders([{ method: "cash", amount: 1000 }], refund)
    expect(result.ok ? "" : result.message).toBe("The payments back come to £10.00 but the refund is £25.00.")
  })

  it("refuses points, SumUp, a second cash tender and a bad card number", () => {
    const message = (input: unknown, r = refund) => {
      const result = checkRefundTenders(input, r)
      return result.ok ? "" : result.message
    }
    expect(message([{ method: "points", amount: 2500 }])).toBe(
      "Say how the refund is going back: cash, card or store credit."
    )
    expect(message([{ method: "sumup_card", amount: 2500 }])).toBe(
      "SumUp is no longer used. Refund card payments on the Tide reader."
    )
    expect(
      message([
        { method: "cash", amount: 1000 },
        { method: "cash", amount: 1500 },
      ])
    ).toBe("There are two cash payments back. Put the cash together as one payment.")
    expect(message([{ method: "card_tide", amount: 2500, card_last4: "99" }])).toBe(CARD_LAST4)
  })

  it("needs the sale's customer for store credit", () => {
    expect(checkRefundTenders([{ method: "store_credit", amount: 2500 }], { amount: 2500, hasCustomer: false })).toEqual({
      ok: false,
      code: "needs_customer",
      message: REFUND_NEEDS_CUSTOMER,
    })
  })
})
