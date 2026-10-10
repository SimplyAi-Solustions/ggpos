import { beforeEach, describe, expect, it } from "vitest"

import {
  demoCompleteTradeIn,
  demoCreateDraft,
  demoIdDocuments,
  demoSaveLines,
  demoTradeIns,
} from "@/lib/api/demo/tradeins"
import { DEMO_CUSTOMERS } from "@/lib/api/demo/customers"
import type { CompleteTradeInPayload, TradeInLineInput } from "@/lib/api/types"

/**
 * Demo mode has to refuse what the server refuses, in the same words.
 *
 * A demo that says yes to everything is how a shape the completion route
 * rejects gets built, demonstrated and shipped; these are the sentences from
 * pb_hooks/tradeins.pb.js.
 */

const JASMINE = "cust_demo_1" // verified ID, photo on file, address, £45 credit
const TOM = "cust_demo_2" // no ID, no photo, has an address
const CALLUM = "cust_demo_3" // flagged no_cash, no address

function card(patch: Partial<TradeInLineInput> = {}): TradeInLineInput {
  return {
    kind: "single",
    title: "Charizard ex",
    condition: "NM",
    qty: 1,
    marketPrice: 10_000,
    offerPrice: 6000,
    accepted: true,
    ...patch,
  }
}

function payload(patch: Partial<CompleteTradeInPayload> = {}): CompleteTradeInPayload {
  return {
    payout_type: "credit",
    payout_cash: 0,
    payout_credit: 6000,
    terms_accepted: true,
    signature: "data:image/png;base64,AAA",
    cash_session: null,
    id_check: null,
    ...patch,
  }
}

function draftFor(customerId: string, lines: TradeInLineInput[] = [card()]) {
  const draft = demoCreateDraft(customerId)
  demoSaveLines(draft.id, lines)
  return draft.id
}

/** The demo book is module state, so each test starts from the seed. */
const SEED_DOCUMENTS = new Map(demoIdDocuments)
const SEED_CUSTOMERS = DEMO_CUSTOMERS.map((entry) => ({
  customer: { ...entry.customer },
  private: { ...entry.private },
}))
const SEED_TRADE_INS = demoTradeIns.length

beforeEach(() => {
  demoIdDocuments.clear()
  for (const [key, value] of SEED_DOCUMENTS) demoIdDocuments.set(key, value)
  DEMO_CUSTOMERS.forEach((entry, index) => {
    const seed = SEED_CUSTOMERS[index]
    if (!seed) return
    Object.assign(entry.customer, seed.customer)
    Object.assign(entry.private, seed.private)
  })
  demoTradeIns.length = SEED_TRADE_INS
})

describe("demo completion", () => {
  it("completes a plain credit buy-in", () => {
    const id = draftFor(JASMINE)
    const result = demoCompleteTradeIn(id, payload())
    expect(result.trade_in.number).toMatch(/^GG-BI-\d{6}$/)
    expect(result.items).toHaveLength(1)
  })

  it("refuses a buy-in with nothing accepted", () => {
    const id = draftFor(JASMINE, [card({ accepted: false })])
    expect(() =>
      demoCompleteTradeIn(id, payload({ payout_credit: 0 }))
    ).toThrow("Accept at least one line before completing this trade-in.")
  })

  it("refuses a payout that does not match the lines", () => {
    const id = draftFor(JASMINE)
    expect(() => demoCompleteTradeIn(id, payload({ payout_credit: 5000 }))).toThrow(
      "The payout adds up to £50.00 but the accepted lines come to £60.00. Adjust the split and try again."
    )
  })

  it("refuses a buy-in the customer has not agreed to", () => {
    const id = draftFor(JASMINE)
    expect(() =>
      demoCompleteTradeIn(id, payload({ terms_accepted: false }))
    ).toThrow("Ask the customer to accept the terms before completing.")
  })

  it("refuses cash to a customer marked no cash", () => {
    const id = draftFor(CALLUM)
    expect(() =>
      demoCompleteTradeIn(
        id,
        payload({ payout_type: "cash", payout_cash: 6000, payout_credit: 0 })
      )
    ).toThrow("This customer is marked no cash. Pay as store credit.")
  })

  it("refuses cash with no address on the record", () => {
    // Callum is the one with no address, so his flag is lifted for this.
    const callum = DEMO_CUSTOMERS.find((entry) => entry.customer.id === CALLUM)
    if (callum) callum.private.flags = []
    const id = draftFor(CALLUM)
    expect(() =>
      demoCompleteTradeIn(
        id,
        payload({ payout_type: "cash", payout_cash: 6000, payout_credit: 0 })
      )
    ).toThrow("Add the seller's address before paying cash.")
  })

  it("refuses cash with no ID check at all", () => {
    const id = draftFor(TOM)
    expect(() =>
      demoCompleteTradeIn(
        id,
        payload({ payout_type: "cash", payout_cash: 6000, payout_credit: 0 })
      )
    ).toThrow(
      "Take an ID check before paying cash. Photograph the seller's ID on the ID step."
    )
  })

  it("refuses cash when the ID photo has been purged", () => {
    // Jasmine's fields are verified and in date, but no photo survives.
    demoIdDocuments.delete(JASMINE)
    const id = draftFor(JASMINE)
    expect(() =>
      demoCompleteTradeIn(
        id,
        payload({ payout_type: "cash", payout_cash: 6000, payout_credit: 0 })
      )
    ).toThrow("Take a photo of the customer's ID before paying cash.")
  })

  it("refuses cash on an ID that has run out", () => {
    const id = draftFor(TOM)
    expect(() =>
      demoCompleteTradeIn(
        id,
        payload({
          payout_type: "cash",
          payout_cash: 6000,
          payout_credit: 0,
          id_check: {
            id_type: "passport",
            id_expiry: "2020-01-01",
            id_ref_last4: "4471",
            dob: "1994-03-18",
            address: "18 Hill Top, Bolsover, S44 6NB",
            id_document: "iddoc_new",
          },
        })
      )
    ).toThrow("That ID has expired. Ask for one that is still in date.")
  })

  it("refuses cash to anyone under 18", () => {
    const born = new Date()
    born.setFullYear(born.getFullYear() - 16)
    const id = draftFor(TOM)
    expect(() =>
      demoCompleteTradeIn(
        id,
        payload({
          payout_type: "cash",
          payout_cash: 6000,
          payout_credit: 0,
          id_check: {
            id_type: "passport",
            id_expiry: "2032-06-30",
            id_ref_last4: "4471",
            dob: born.toISOString().slice(0, 10),
            address: "18 Hill Top, Bolsover, S44 6NB",
            id_document: "iddoc_new",
          },
        })
      )
    ).toThrow("We cannot buy for cash from anyone under 18.")
  })

  it("completes a cash buy-in once the ID check is in", () => {
    const id = draftFor(TOM)
    const result = demoCompleteTradeIn(
      id,
      payload({
        payout_type: "cash",
        payout_cash: 6000,
        payout_credit: 0,
        id_check: {
          id_type: "passport",
          id_expiry: "2032-06-30",
          id_ref_last4: "4471",
          dob: "1994-03-18",
          address: "18 Hill Top, Bolsover, S44 6NB",
          id_document: "iddoc_new",
        },
      })
    )
    expect(result.trade_in.payout_cash).toBe(6000)
  })

  it("refuses to complete the same buy-in twice", () => {
    const id = draftFor(JASMINE)
    demoCompleteTradeIn(id, payload())
    expect(() => demoCompleteTradeIn(id, payload())).toThrow(
      "This trade-in is already completed."
    )
  })

  it("takes a bulk lot at its flat figure, not per card", () => {
    // The shape the wizard sends: one line, quantity one, the flat figure.
    const id = draftFor(JASMINE, [
      {
        kind: "other",
        title: "Bulk lot, 400 cards",
        qty: 1,
        marketPrice: 2000,
        marketSource: "Bulk lot",
        offerPrice: 2000,
        accepted: true,
      },
    ])
    const result = demoCompleteTradeIn(
      id,
      payload({ payout_credit: 2000 })
    )
    expect(result.items).toHaveLength(1)
  })
})
