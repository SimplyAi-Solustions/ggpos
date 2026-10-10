import { describe, expect, it } from "vitest"

import {
  maxPoints,
  maxStoreCredit,
  quickNotes,
  resolveTenders,
  takeCard,
  takeCash,
  takePoints,
  takeStoreCredit,
  tenderInputs,
  tenderLabel,
  tendersProblem,
  type TakenTender,
} from "@/features/till/tenders"
import type { LoyaltySetup, SaleCustomer } from "@/lib/api/types"

/**
 * The tender rules, in the contract's own words (docs/api-contract-epos.md,
 * section 4): the payments sum to the total exactly, one cash tender at
 * most, only cash gives change, and the card carries its last four digits.
 */

const PROGRAMME: LoyaltySetup["programme"] = {
  enabled: true,
  earnPerPoundSales: 10,
  earnPerPoundTradeInCredit: 5,
  pointsPerPoundRedemption: 100,
  minRedeemPoints: 500,
  maxPointsShareOfSale: 50,
  expiryMonthsInactive: 18,
  tierWindowMonths: 12,
  welcomeBonus: 100,
  referralBonusReferrer: 250,
  referralBonusReferee: 250,
}

const JASMINE: SaleCustomer = {
  id: "cust_1",
  name: "Jasmine Okafor",
  code: "GGC4K7M2S",
  tierId: null,
  tierName: null,
  perks: [],
  creditBalance: 1500,
  pointsBalance: 2000,
  member: true,
  paidMember: false,
}

function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}

describe("cash", () => {
  it("takes the exact amount and gives no change", () => {
    const taken = ok(takeCash([], 4000, 4000))
    const state = resolveTenders(4000, taken)
    expect(state.left).toBe(0)
    expect(state.change).toBe(0)
    expect(tenderInputs(state)).toEqual([{ method: "cash", amount: 4000, tendered: 4000 }])
  })

  it("gives change on a note, and sends the amount and what was handed over", () => {
    const state = resolveTenders(3760, ok(takeCash([], 3760, 5000)))
    expect(state.left).toBe(0)
    expect(state.change).toBe(1240)
    expect(tenderInputs(state)).toEqual([{ method: "cash", amount: 3760, tendered: 5000 }])
  })

  it("puts a second handful on the one cash tender", () => {
    const first = ok(takeCash([], 4000, 1000))
    const second = ok(takeCash(first, 4000, 5000))
    expect(second.filter((tender) => tender.method === "cash")).toHaveLength(1)
    const state = resolveTenders(4000, second)
    expect(state.change).toBe(2000)
    expect(state.left).toBe(0)
  })

  it("works its share out again when the ticket changes underneath it", () => {
    const taken = ok(takeCash([], 4000, 5000))
    expect(resolveTenders(3000, taken).change).toBe(2000)
    expect(resolveTenders(6000, taken)).toMatchObject({ left: 1000, change: 0 })
  })

  it("refuses nothing keyed, and says how", () => {
    expect(takeCash([], 4000, 0)).toEqual({
      ok: false,
      message: "Key the cash handed over, or press Exact.",
    })
  })

  it("holds to the cash cap, and to cash being switched off", () => {
    expect(takeCash([], 900_000, 900_000, 800_000)).toEqual({
      ok: false,
      message: "Cash is capped at £8,000.00 a sale. Take the rest by card.",
    })
    expect(takeCash([], 1000, 1000, 0)).toEqual({
      ok: false,
      message: "Cash sales are switched off in settings.",
    })
  })
})

describe("the Tide card", () => {
  it("takes what is left, with the last four digits", () => {
    const taken = ok(takeCard([], 4000, "4242", true))
    const state = resolveTenders(4000, taken)
    expect(state.left).toBe(0)
    expect(tenderLabel(state.tenders[0]!)).toBe("Card ending 4242")
    expect(tenderInputs(state)).toEqual([
      { method: "card_tide", amount: 4000, card_last4: "4242" },
    ])
  })

  it("asks for the last four digits when the shop wants them", () => {
    expect(takeCard([], 4000, "", true)).toEqual({
      ok: false,
      message: "Key the last four digits of the card.",
    })
    expect(takeCard([], 4000, "42", false)).toEqual({
      ok: false,
      message: "Key the last four digits of the card.",
    })
    expect(takeCard([], 4000, "", false).ok).toBe(true)
  })

  it("splits with cash: the card takes the rest", () => {
    const cash = ok(takeCash([], 4000, 1500))
    const left = resolveTenders(4000, cash).left
    expect(left).toBe(2500)
    const both = ok(takeCard(cash, left, "1234", true))
    const state = resolveTenders(4000, both)
    expect(state.left).toBe(0)
    expect(tendersProblem(4000, state)).toBeNull()
  })
})

describe("store credit", () => {
  it("needs the customer, and no more than they hold", () => {
    expect(takeStoreCredit([], 4000, 1000, null)).toEqual({
      ok: false,
      message: "Attach the customer to pay with store credit.",
    })
    expect(takeStoreCredit([], 4000, 2000, JASMINE)).toEqual({
      ok: false,
      message: "This customer has £15.00 in store credit. Lower the amount.",
    })
    expect(maxStoreCredit([], 4000, JASMINE)).toBe(1500)
  })

  it("is never more than what is left", () => {
    expect(takeStoreCredit([], 1000, 1200, JASMINE)).toEqual({
      ok: false,
      message: "That is more than the £10.00 left to pay.",
    })
  })
})

describe("points", () => {
  it("covers at most the programme's share of the sale", () => {
    // Half of £40.00 is £20.00, but she only holds 2,000 points: £20.00.
    expect(maxPoints([], 4000, 4000, JASMINE, PROGRAMME)).toBe(2000)
    expect(maxPoints([], 4000, 3000, JASMINE, PROGRAMME)).toBe(1500)
  })

  it("starts at the programme's minimum", () => {
    expect(takePoints([], 4000, 4000, 300, JASMINE, PROGRAMME)).toEqual({
      ok: false,
      message: "Points start at 500 points. Take this one another way.",
    })
  })

  it("says how much points can cover when asked for more", () => {
    const rich = { ...JASMINE, pointsBalance: 10_000 }
    expect(takePoints([], 4000, 4000, 2500, rich, PROGRAMME)).toEqual({
      ok: false,
      message: "Points can cover at most £20.00 of this sale.",
    })
  })

  it("takes points that fit", () => {
    const taken = ok(takePoints([], 4000, 4000, 1000, JASMINE, PROGRAMME))
    expect(resolveTenders(4000, taken).left).toBe(3000)
  })
})

describe("the last check before the sale goes", () => {
  it("says what the payments come to against the total", () => {
    const taken: TakenTender[] = [{ id: "a", method: "card_tide", amount: 3800, card_last4: "1111" }]
    expect(tendersProblem(4000, resolveTenders(4000, taken))).toBe(
      "The payments come to £38.00 but the total is £40.00."
    )
  })

  it("asks for a payment to come off when the ticket came down after it", () => {
    const taken: TakenTender[] = [{ id: "a", method: "card_tide", amount: 4000, card_last4: "1111" }]
    const state = resolveTenders(3000, taken)
    expect(state.over).toBe(1000)
    expect(tendersProblem(3000, state)).toBe(
      "The payments come to £40.00 but the total is £30.00. Remove a payment."
    )
  })
})

describe("the quick note keys", () => {
  it("are the shop's notes above what is left, smallest first", () => {
    expect(quickNotes(1240, [500, 1000, 2000, 5000])).toEqual([2000, 5000])
    expect(quickNotes(300, [5000, 500, 2000, 1000])).toEqual([500, 1000, 2000, 5000])
    expect(quickNotes(6000, [500, 1000, 2000, 5000])).toEqual([])
  })
})
