import { describe, expect, it } from "vitest"
import { DEFAULT_CONDITION_MULTIPLIERS, DEFAULT_OFFER_SETTINGS } from "@gg/shared/pricing"

import { EMPTY_CAPTURE } from "@/features/tradein/id-capture"
import type { TradeLine, WizardCustomer } from "@/features/tradein/machine"
import {
  agreementProblem,
  cashRateSurplus,
  leftProblem,
  needsIdStep,
  payLabel,
  refundDestination,
  refundProblem,
  refundTender,
  returnsInput,
  returnsValue,
  settleSentence,
  settleTicket,
  surplusCash,
  surplusCashProblem,
  surplusDifference,
  surplusSentence,
  ticketTradeLines,
  tradeFigures,
  tradeProblem,
  tradeSettlementInput,
  type AgreementInput,
  type PricingContext,
} from "@/features/till/exchange"
import {
  emptyTicket,
  ticketIsEmpty,
  ticketReducer,
  type Ticket,
  type TicketReturn,
  type TicketTrade,
} from "@/features/till/ticket"
import { emptyTill, tillReducer, type TillState } from "@/features/till/till-store"
import { DEMO_PRICING_RULES } from "@/lib/api/demo/tradeins"
import type { SaleCustomer } from "@/lib/api/types"

/**
 * A part-exchange and a return on the ticket (docs/api-contract-epos.md,
 * section 7): S the sale, V the trade at credit rates with A = min(V, S)
 * paying towards it, then R the return with E = min(R, S - A). What is left
 * to pay is S - A - E; the trade's surplus is V - A and the return's
 * difference R - E.
 */

const PRICING: PricingContext = {
  rules: DEMO_PRICING_RULES,
  settings: DEFAULT_OFFER_SETTINGS,
  multipliers: DEFAULT_CONDITION_MULTIPLIERS,
}

function line(over: Partial<TradeLine> = {}): TradeLine {
  return {
    key: `line_${Math.random().toString(36).slice(2, 8)}`,
    kind: "sealed",
    title: "Surging Sparks Elite Trainer Box",
    qty: 1,
    marketPence: 4000,
    marketSource: "Manual",
    accepted: true,
    ...over,
  }
}

const JASMINE: WizardCustomer = {
  id: "cust_demo_1",
  name: "Jasmine Okafor",
  code: "GGC4K7M2S",
  email: "",
  phone: "",
  creditBalance: 0,
  facts: {
    flags: [],
    idStatus: "verified",
    idType: "Passport",
    idExpiry: "2031-01-01",
    dob: "1994-03-18",
    address: "12 Castle Street, Bolsover, S44 6PP",
  },
}

function agreement(over: Partial<AgreementInput> = {}): AgreementInput {
  return {
    settlement: settleTicket(1249, { trade: 2800 }),
    choice: "credit",
    cash: 0,
    terms: true,
    signature: "data:image/png;base64,AAAA",
    customer: JASMINE,
    cashCap: 800_000,
    gate: { needed: false },
    capture: EMPTY_CAPTURE,
    ...over,
  }
}

const RETURN: TicketReturn = {
  saleId: "sale_demo_2",
  saleNumber: "GG-S-000456",
  customer: null,
  lines: [
    { saleLine: "line_a", title: "Llanowar Elves", detail: "GGS-W8Q4R", qty: 1, amount: 249 },
    { saleLine: "line_b", title: "Lightning Bolt", detail: "GGS-B0LT5", qty: 2, amount: 600 },
  ],
  reason: "Wrong card",
  restock: true,
  refundMethod: "cash",
  cardLast4: "",
}

describe("what is left to pay", () => {
  it("is the sale itself with nothing set against it", () => {
    const owed = settleTicket(4000)
    expect(owed).toMatchObject({ kind: "none", applied: 0, exchange: 0, toPay: 4000, mode: "pay" })
  })

  it("is the sale less the trade when the trade is worth less", () => {
    const owed = settleTicket(32499, { trade: 2800 })
    expect(owed).toMatchObject({
      kind: "trade",
      applied: 2800,
      toPay: 29699,
      surplus: 0,
      refund: 0,
      mode: "pay",
    })
  })

  it("is nothing when the trade is worth more, and the surplus is the rest of it", () => {
    const owed = settleTicket(1249, { trade: 2800 })
    expect(owed).toMatchObject({ applied: 1249, toPay: 0, surplus: 1551, mode: "settle" })
  })

  it("settles a trade that covers the sale exactly, with no surplus", () => {
    expect(settleTicket(2800, { trade: 2800 })).toMatchObject({ toPay: 0, surplus: 0, mode: "settle" })
  })

  it("caps an exchange at the sale and refunds the difference", () => {
    expect(settleTicket(1249, { returns: 249 })).toMatchObject({
      kind: "return",
      exchange: 249,
      toPay: 1000,
      refund: 0,
      mode: "pay",
    })
    expect(settleTicket(1249, { returns: 4745 })).toMatchObject({
      exchange: 1249,
      toPay: 0,
      refund: 3496,
      mode: "refund",
    })
  })

  it("makes a ticket of returns alone a refund of all of it", () => {
    expect(settleTicket(0, { returns: 4745 })).toMatchObject({
      exchange: 0,
      toPay: 0,
      refund: 4745,
      mode: "refund",
    })
  })

  it("applies the trade first, then the return against what it left", () => {
    const owed = settleTicket(32499, { trade: 2800, returns: 249 })
    expect(owed).toMatchObject({
      kind: "both",
      applied: 2800,
      exchange: 249,
      toPay: 29450,
      surplus: 0,
      refund: 0,
      mode: "pay",
    })

    // The return takes what the trade did not, and the rest goes back.
    const covered = settleTicket(3000, { trade: 2800, returns: 849 })
    expect(covered).toMatchObject({ applied: 2800, exchange: 200, toPay: 0, refund: 649, mode: "settle" })

    // A trade worth the whole sale leaves the return nothing to pay for.
    const traded = settleTicket(1249, { trade: 2800, returns: 249 })
    expect(traded).toMatchObject({ applied: 1249, exchange: 0, surplus: 1551, refund: 249 })
  })

  it("never reads a negative sale or credit as anything but nothing", () => {
    expect(settleTicket(-100, { trade: -50 })).toMatchObject({ sale: 0, applied: 0, toPay: 0 })
  })
})

describe("the trade's figures", () => {
  it("values accepted lines at the credit offer, with the cash offer beside it", () => {
    // A £40.00 sealed box: 70 percent credit, 55 percent cash.
    const figures = tradeFigures([line(), line({ accepted: false, marketPence: 10_000 })], PRICING)
    expect(figures).toEqual({ credit: 2800, cash: 2200, lines: 1, pending: false })
  })

  it("lists only the accepted lines on the ticket, at their credit totals", () => {
    const lines = ticketTradeLines(
      [
        line({ key: "box", qty: 2 }),
        line({ key: "gone", accepted: false }),
        line({ key: "lot", kind: "bulk", title: "Bulk lot, 400 cards", qty: 400, bulkOffer: 2000 }),
      ],
      PRICING
    )
    expect(lines).toEqual([
      expect.objectContaining({ key: "box", credit: 5600, detail: "2 of them" }),
      // A lot is one flat figure whatever its card count.
      expect.objectContaining({ key: "lot", credit: 2000, detail: "" }),
    ])
  })

  it("says what stops a trade being paid with, first problem first", () => {
    const trade: TicketTrade = {
      customerId: "cust_demo_1",
      customerName: "Jasmine Okafor",
      tradeInId: null,
      lines: [line()],
    }
    const figures = tradeFigures(trade.lines, PRICING)
    expect(tradeProblem(trade, figures, 1)).toBe("The trade-in is still being saved. Give it a moment.")
    const saved = { ...trade, tradeInId: "trade_1" }
    expect(tradeProblem(saved, { ...figures, lines: 0 }, 1)).toBe(
      "Add at least one item to the trade-in, or take it off."
    )
    expect(tradeProblem(saved, { ...figures, pending: true }, 1)).toBe(
      "One trade-in line is still being priced. Give it a moment."
    )
    expect(tradeProblem(saved, { ...figures, credit: 0 }, 1)).toBe(
      "Every trade-in line is at nothing. Enter a market price, or override the offer."
    )
    expect(tradeProblem(saved, figures, 0)).toBe(
      "There is nothing on the ticket for the trade-in to pay for. Add an item, or complete it as a buy-in."
    )
    expect(tradeProblem(saved, figures, 1)).toBeNull()
  })
})

describe("the surplus in cash", () => {
  it("values the unused part of the trade at the lines' cash rate, half-up", () => {
    // £15.51 of £28.00 credit, at £22.00 cash for the lot: £12.186... is £12.19.
    expect(cashRateSurplus(1551, { credit: 2800, cash: 2200 })).toBe(1219)
    // The whole trade unused is the whole cash offer.
    expect(cashRateSurplus(2800, { credit: 2800, cash: 2200 })).toBe(2200)
  })

  it("never suggests more cash than the credit surplus, or any with nothing over", () => {
    // An override can put the cash offer above the credit offer.
    expect(cashRateSurplus(1000, { credit: 2000, cash: 3000 })).toBe(1000)
    expect(cashRateSurplus(0, { credit: 2800, cash: 2200 })).toBe(0)
    expect(cashRateSurplus(500, { credit: 0, cash: 0 })).toBe(0)
  })

  it("takes the keyed figure over the suggestion", () => {
    expect(surplusCash("", { surplus: 1551 }, { credit: 2800, cash: 2200 })).toBe(1219)
    expect(surplusCash("1000", { surplus: 1551 }, { credit: 2800, cash: 2200 })).toBe(1000)
  })

  it("refuses nothing, and more than the credit surplus, in the server's words", () => {
    const words = "Pay between £0.01 and £15.51 in cash, or pay the surplus as credit."
    expect(surplusCashProblem(0, 1551)).toBe(words)
    expect(surplusCashProblem(1552, 1551)).toBe(words)
    expect(surplusCashProblem(1551, 1551)).toBeNull()
    expect(surplusCashProblem(1, 1551)).toBeNull()
  })

  it("says what choosing cash costs in words", () => {
    expect(surplusDifference(1219, 1551)).toBe(
      "Paying £12.19 in cash instead of £15.51 in store credit. The £3.32 difference stays with the shop."
    )
    expect(surplusDifference(1551, 1551)).toBe("Paying the whole £15.51 in cash.")
  })
})

describe("the buy-in's rules at the till", () => {
  it("lets a signed credit surplus through", () => {
    expect(agreementProblem(agreement())).toBeNull()
  })

  it("asks where the surplus goes before anything else", () => {
    expect(agreementProblem(agreement({ choice: null }))).toBe("Pay the surplus as credit or cash.")
  })

  it("needs no choice when the trade only pays for the sale", () => {
    const owed = settleTicket(32499, { trade: 2800 })
    expect(agreementProblem(agreement({ settlement: owed, choice: null }))).toBeNull()
  })

  it("holds cash to the surplus, the customer's flags, the cap and the ID step", () => {
    expect(agreementProblem(agreement({ choice: "cash", cash: 2000 }))).toBe(
      "Pay between £0.01 and £15.51 in cash, or pay the surplus as credit."
    )
    const noCash = { ...JASMINE, facts: { ...JASMINE.facts, flags: ["no_cash" as const] } }
    expect(agreementProblem(agreement({ choice: "cash", cash: 1219, customer: noCash }))).toBe(
      "This customer is marked store credit only, so cash is not an option."
    )
    expect(agreementProblem(agreement({ choice: "cash", cash: 1219, cashCap: 1000 }))).toBe(
      "Cash is capped at £10.00 per buy-in. Pay the rest as store credit."
    )
    expect(
      agreementProblem(
        agreement({ choice: "cash", cash: 1219, gate: { needed: true, reason: "full" } })
      )
    ).toBe("Photograph the ID before you continue.")
    expect(agreementProblem(agreement({ choice: "cash", cash: 1219 }))).toBeNull()
  })

  it("wants the terms and then the signature on every trade", () => {
    expect(agreementProblem(agreement({ terms: false }))).toBe(
      "Read the terms to the customer and tick the box."
    )
    expect(agreementProblem(agreement({ signature: null }))).toBe(
      "Ask the customer to sign before you continue."
    )
  })

  it("has nothing to say about a ticket without a trade", () => {
    expect(agreementProblem(agreement({ settlement: settleTicket(1000), terms: false }))).toBeNull()
  })

  it("runs the ID step only for a cash surplus", () => {
    const owed = settleTicket(1249, { trade: 2800 })
    expect(needsIdStep(owed, "cash")).toBe(true)
    expect(needsIdStep(owed, "credit")).toBe(false)
    expect(needsIdStep(settleTicket(32499, { trade: 2800 }), "cash")).toBe(false)
  })

  it("sends the settlement the route takes", () => {
    const owed = settleTicket(1249, { trade: 2800 })
    const check = {
      id_type: "passport" as const,
      id_expiry: "2032-06-30",
      id_ref_last4: "4471",
      dob: "1990-05-02",
      address: "4 Sherwood Lodge Drive",
      id_document: "iddoc_1",
    }
    expect(
      tradeSettlementInput({ settlement: owed, choice: "cash", cash: 1000, terms: true, signature: "sig", idCheck: check })
    ).toEqual({
      surplus: "cash",
      surplus_cash: 1000,
      terms_accepted: true,
      signature: "sig",
      id_check: check,
    })
    expect(
      tradeSettlementInput({ settlement: owed, choice: "credit", cash: 1219, terms: true, signature: "sig", idCheck: check })
    ).toEqual({ surplus: "credit", terms_accepted: true, signature: "sig" })
    // No surplus: no choice to send.
    expect(
      tradeSettlementInput({
        settlement: settleTicket(32499, { trade: 2800 }),
        choice: "cash",
        cash: 0,
        terms: true,
        signature: null,
        idCheck: null,
      })
    ).toEqual({ terms_accepted: true })
  })
})

describe("a return on the ticket", () => {
  it("is worth what its lines come back at", () => {
    expect(returnsValue(RETURN)).toBe(849)
    expect(returnsValue(null)).toBe(0)
  })

  it("goes to the server as its lines, with the refund tender only when something goes back", () => {
    expect(returnsInput(RETURN, null)).toEqual({
      sale: "sale_demo_2",
      lines: [
        { sale_line: "line_a", qty: 1, restock: true },
        { sale_line: "line_b", qty: 2, restock: true },
      ],
      reason: "Wrong card",
    })
    expect(returnsInput(RETURN, refundTender("card_tide", 300, "4242")).tenders).toEqual([
      { method: "card_tide", amount: 300, card_last4: "4242" },
    ])
    expect(returnsInput(RETURN, refundTender("cash", 0, "")).tenders).toBeUndefined()
  })

  it("refuses store credit without the original sale's customer, and a short card number", () => {
    expect(refundProblem(null, RETURN, "")).toBe("Choose where the money goes back.")
    expect(refundProblem("store_credit", RETURN, "")).toBe(
      "Store credit needs the customer on the sale. Refund it another way."
    )
    expect(refundProblem("card_tide", RETURN, "42")).toBe("Key the last four digits of the card.")
    expect(refundProblem("card_tide", RETURN, "")).toBeNull()
    expect(refundProblem("cash", RETURN, "")).toBeNull()
  })

  it("says where the money went", () => {
    expect(refundDestination("cash", "")).toBe("in cash")
    expect(refundDestination("store_credit", "")).toBe("as store credit")
    expect(refundDestination("card_tide", "4242")).toBe("to the card ending 4242")
    expect(refundDestination("card_tide", "")).toBe("to the card")
  })
})

describe("what the ticket says", () => {
  it("names the block for how the ticket is finished", () => {
    expect(payLabel(settleTicket(4000))).toBe("Pay")
    expect(payLabel(settleTicket(1249, { trade: 2800 }))).toBe("Settle")
    expect(payLabel(settleTicket(1249, { returns: 4745 }))).toBe("Refund")
    expect(payLabel(settleTicket(249, { returns: 249 }))).toBe("Exchange")
  })

  it("says when the trade or the return is worth more than the ticket", () => {
    expect(surplusSentence(settleTicket(1249, { trade: 2800 }), 1)).toBe(
      "The trade-in is worth £15.51 more than the ticket."
    )
    expect(surplusSentence(settleTicket(1249, { returns: 4745 }), 1)).toBe(
      "The return is worth £34.96 more than the ticket."
    )
    expect(surplusSentence(settleTicket(0, { returns: 4745 }), 0)).toBe(
      "Nothing new is on the ticket, so this is a refund of £47.45."
    )
    expect(surplusSentence(settleTicket(1249, { trade: 2800, returns: 249 }), 1)).toBe(
      "The trade-in is worth £15.51 more than the ticket. The return, £2.49, goes back to the customer."
    )
    expect(surplusSentence(settleTicket(4000, { trade: 2800 }), 1)).toBeNull()
  })

  it("says on the Settle pane what each part does", () => {
    expect(settleSentence(settleTicket(1249, { trade: 2800 }))).toBe(
      "The trade-in pays the whole £12.49 ticket and is worth £15.51 more."
    )
    expect(settleSentence(settleTicket(2800, { trade: 2800 }))).toBe(
      "The trade-in pays the whole £28.00 ticket, exactly."
    )
    expect(settleSentence(settleTicket(3000, { trade: 2800, returns: 849 }))).toBe(
      "The trade-in pays £28.00 of the £30.00 ticket and the return the other £2.00. £6.49 of the return goes back to the customer."
    )
  })

  it("refuses payments that do not cover what is left, in the server's words", () => {
    expect(leftProblem(settleTicket(1000, { trade: 200 }), 600, 0)).toBe(
      "The payments come to £6.00 but £8.00 is left after the trade-in."
    )
    expect(leftProblem(settleTicket(1000, { returns: 200 }), 600, 0)).toBe(
      "The payments come to £6.00 but £8.00 is left after the exchange."
    )
    expect(leftProblem(settleTicket(1000, { trade: 200, returns: 100 }), 600, 0)).toBe(
      "The payments come to £6.00 but £7.00 is left after the trade-in and the exchange."
    )
    expect(leftProblem(settleTicket(4000), 3800, 0)).toBe(
      "The payments come to £38.00 but the total is £40.00."
    )
    expect(leftProblem(settleTicket(1000, { trade: 200 }), 800, 0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The ticket and the till holding them
// ---------------------------------------------------------------------------

const TOM: SaleCustomer = {
  id: "cust_demo_2",
  name: "Tom Bradbury",
  code: "GGC9QB3XA",
  tierId: null,
  tierName: null,
  perks: [],
  creditBalance: 0,
  pointsBalance: 0,
}

function withTrade(): Ticket {
  return ticketReducer(
    { ...emptyTicket(), customer: TOM },
    { type: "startTrade", customerId: TOM.id, customerName: TOM.name }
  )
}

describe("the ticket's trade and return", () => {
  it("starts one trade for the ticket's customer and takes the wizard's line actions", () => {
    let ticket = withTrade()
    expect(ticket.trade).toEqual({ customerId: TOM.id, customerName: TOM.name, tradeInId: null, lines: [] })
    expect(ticketIsEmpty(ticket)).toBe(false)

    const box = line({ key: "box" })
    ticket = ticketReducer(ticket, { type: "trade", action: { type: "add-line", line: box } })
    ticket = ticketReducer(ticket, { type: "trade", action: { type: "set-draft", tradeInId: "trade_1" } })
    ticket = ticketReducer(ticket, {
      type: "trade",
      action: { type: "update-line", key: "box", patch: { marketPence: 5000 } },
    })
    ticket = ticketReducer(ticket, { type: "trade", action: { type: "adopt-line-ids", ids: ["line_1"] } })
    expect(ticket.trade?.tradeInId).toBe("trade_1")
    expect(ticket.trade?.lines).toEqual([expect.objectContaining({ key: "box", id: "line_1", marketPence: 5000 })])

    // A second start is the same trade, not a new one.
    expect(ticketReducer(ticket, { type: "startTrade", customerId: "other", customerName: "Other" })).toBe(ticket)
  })

  it("keeps the customer the trade was drafted for", () => {
    const ticket = withTrade()
    expect(ticketReducer(ticket, { type: "attachCustomer", customer: null })).toBe(ticket)
    expect(
      ticketReducer(ticket, { type: "attachCustomer", customer: { ...TOM, id: "cust_demo_1" } })
    ).toBe(ticket)
    const dropped = ticketReducer(ticket, { type: "dropTrade" })
    expect(dropped.trade).toBeNull()
    expect(ticketReducer(dropped, { type: "attachCustomer", customer: null }).customer).toBeNull()
  })

  it("writes the lines to a new draft when the old one has gone", () => {
    let ticket = withTrade()
    ticket = ticketReducer(ticket, { type: "trade", action: { type: "add-line", line: line({ id: "line_1" }) } })
    ticket = ticketReducer(ticket, { type: "trade", action: { type: "set-draft", tradeInId: "trade_1" } })
    const rebased = ticketReducer(ticket, { type: "rebaseTrade" })
    expect(rebased.trade?.tradeInId).toBeNull()
    expect(rebased.trade?.lines[0]?.id).toBeUndefined()
  })

  it("holds a return beside a trade, and takes it off again", () => {
    const ticket = ticketReducer(withTrade(), { type: "setReturns", returns: RETURN })
    expect(ticket.returns).toBe(RETURN)
    expect(ticket.trade).not.toBeNull()
    expect(ticketReducer(ticket, { type: "setReturns", returns: null }).returns).toBeNull()
    expect(ticketIsEmpty(ticketReducer(emptyTicket(), { type: "setReturns", returns: RETURN }))).toBe(false)
  })
})

describe("the till holding a part-exchange", () => {
  function paying(): TillState {
    const ticket = withTrade()
    return tillReducer({ ...emptyTill(), ticket }, { type: "pay" })
  }

  it("keeps the terms and the signature while paying, and drops them back at the ticket", () => {
    let state = paying()
    state = tillReducer(state, { type: "settlement", patch: { terms: true, signature: "sig", surplus: "cash" } })
    expect(state.settlement).toMatchObject({ terms: true, signature: "sig", surplus: "cash" })
    state = tillReducer(state, { type: "backToTicket" })
    expect(state.settlement).toMatchObject({ terms: false, signature: null, surplus: null })
  })

  it("takes no settlement outside paying", () => {
    const state = { ...emptyTill(), ticket: withTrade() }
    expect(tillReducer(state, { type: "settlement", patch: { terms: true } })).toBe(state)
  })

  it("never lets the trade's housekeeping start the next sale over the done view", () => {
    const done = tillReducer(paying(), {
      type: "completed",
      done: { saleId: "sale_1", number: "GG-S-000500", total: 0, change: 0, pointsEarned: 0, cash: false, queued: false },
    })
    expect(tillReducer(done, { type: "rebaseTrade" })).toBe(done)
    expect(tillReducer(done, { type: "trade", action: { type: "adopt-line-ids", ids: ["x"] } })).toBe(done)
    // A real change does start the next one.
    expect(tillReducer(done, { type: "dropTrade" }).phase).toBe("ticket")
  })
})
