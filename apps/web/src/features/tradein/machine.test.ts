import { describe, expect, it } from "vitest"
import { DEFAULT_OFFER_SETTINGS, type PricingRule } from "@gg/shared/pricing"

import {
  ageAt,
  canAdvance,
  cashBlock,
  hydrate,
  initialState,
  lineOffer,
  idFieldsGood,
  idGate,
  nextStep,
  payoutFor,
  previousStep,
  reducer,
  toLineInputs,
  totals,
  visibleSteps,
  type TradeLine,
  type WizardCustomer,
  type WizardState,
} from "@/features/tradein/machine"
import { DEMO_PRICING_RULES } from "@/lib/api/demo/tradeins"
import type { TradeInLineRecord, TradeInRecord } from "@/lib/api"

const RULES: PricingRule[] = DEMO_PRICING_RULES
const SETTINGS = DEFAULT_OFFER_SETTINGS
const CASH_CAP = 800_000
const NOW = new Date("2026-09-20T10:00:00Z")

function line(patch: Partial<TradeLine> = {}): TradeLine {
  return {
    key: "k1",
    kind: "single",
    title: "Charizard ex",
    condition: "NM",
    qty: 1,
    marketPence: 10_000,
    marketSource: "Manual",
    accepted: true,
    ...patch,
  }
}

function customer(patch: Partial<WizardCustomer> = {}): WizardCustomer {
  return {
    id: "cust_1",
    name: "Jasmine Okafor",
    code: "GGC4K7M2Z",
    email: "j@example.co.uk",
    phone: "07700 900123",
    creditBalance: 4500,
    facts: { flags: [], idStatus: "none" },
    ...patch,
  }
}

describe("step transitions", () => {
  it("runs customer to items to offer", () => {
    expect(nextStep("customer", { cashRequired: false })).toBe("items")
    expect(nextStep("items", { cashRequired: false })).toBe("offer")
  })

  it("skips the ID gate when nothing is paid in cash", () => {
    expect(nextStep("offer", { cashRequired: false })).toBe("done")
    expect(visibleSteps({ cashRequired: false })).not.toContain("id")
  })

  it("inserts the ID gate when cash is in play", () => {
    expect(nextStep("offer", { cashRequired: true })).toBe("id")
    expect(nextStep("id", { cashRequired: true })).toBe("done")
    expect(visibleSteps({ cashRequired: true })).toContain("id")
  })

  it("walks back one step at a time, and not off the front", () => {
    expect(previousStep("id")).toBe("offer")
    expect(previousStep("items")).toBe("customer")
    expect(previousStep("customer")).toBeNull()
  })
})

describe("offer totals", () => {
  it("prices a £100 NM single from the £50-and-over band", () => {
    // 60 percent cash, 75 percent credit, rounded to the nearest 50p.
    const offer = lineOffer(line(), RULES, SETTINGS)
    expect(offer.cash).toBe(6000)
    expect(offer.credit).toBe(7500)
    expect(offer.source).toBe("rule")
  })

  it("applies the condition multiplier before choosing the band", () => {
    // The seeded single bands are condition wildcards, so a played card
    // drops through the multiplier rather than matching nothing: £100 at MP
    // is £70, still the top band, at 60 and 75 percent.
    const offer = lineOffer(line({ condition: "MP" }), RULES, SETTINGS)
    expect(offer.source).toBe("rule")
    expect(offer.cash).toBe(4200)
    expect(offer.credit).toBe(5250)
  })

  it("drops a badly played card into a lower band", () => {
    // £100 at DMG is £30, which is the £5 to £50 band: 50 and 65 percent.
    const offer = lineOffer(line({ condition: "DMG" }), RULES, SETTINGS)
    expect(offer.cash).toBe(1500)
    expect(offer.credit).toBe(1950)
  })

  it("multiplies a sealed line by its quantity", () => {
    const offer = lineOffer(
      line({ kind: "sealed", condition: "", marketPence: 4000, qty: 3 }),
      RULES,
      SETTINGS
    )
    expect(offer.cashTotal).toBe(offer.cash * 3)
    expect(offer.marketTotal).toBe(12_000)
  })

  it("takes a bulk lot at its flat figure, whatever the count", () => {
    const offer = lineOffer(
      line({ kind: "bulk", qty: 400, bulkOffer: 2000, marketPence: 0 }),
      RULES,
      SETTINGS
    )
    expect(offer.cashTotal).toBe(2000)
    expect(offer.creditTotal).toBe(2000)
    expect(offer.source).toBe("lot")
  })

  it("uses an override in place of the band, quantity and all", () => {
    const offer = lineOffer(
      line({ qty: 2, overrideCash: 1000, overrideCredit: 1500, overrideReason: "Edge wear" }),
      RULES,
      SETTINGS
    )
    expect(offer.cashTotal).toBe(2000)
    expect(offer.creditTotal).toBe(3000)
    expect(offer.source).toBe("override")
  })

  it("says so when no band matches, rather than offering nothing quietly", () => {
    const offer = lineOffer(line({ kind: "graded" }), [], SETTINGS)
    expect(offer.source).toBe("none")
    expect(offer.cash).toBe(0)
  })

  it("adds accepted lines up and leaves declined ones out", () => {
    const sums = totals(
      [line(), line({ key: "k2", accepted: false }), line({ key: "k3" })],
      RULES,
      SETTINGS
    )
    expect(sums.lines).toBe(2)
    expect(sums.market).toBe(20_000)
    expect(sums.cash).toBe(12_000)
    expect(sums.credit).toBe(15_000)
  })
})

describe("the payout split", () => {
  const sums = { cash: 6000, credit: 7500 }

  it("pays the cash rate for cash and the credit rate for credit", () => {
    expect(payoutFor("cash", sums, 0)).toEqual({ type: "cash", cash: 6000, credit: 0 })
    expect(payoutFor("credit", sums, 0)).toEqual({
      type: "credit",
      cash: 0,
      credit: 7500,
    })
  })

  it("prices a mixed payout at the cash rate throughout", () => {
    const payout = payoutFor("mixed", sums, 2000)
    expect(payout.cash).toBe(2000)
    expect(payout.credit).toBe(4000)
    expect(payout.cash + payout.credit).toBe(sums.cash)
  })

  it("never hands over more cash than the offer is worth", () => {
    expect(payoutFor("mixed", sums, 99_999).cash).toBe(6000)
  })

  it("treats mixed with an empty cash box as a plain credit payout", () => {
    // Otherwise the whole thing is paid as credit at the lower cash rate,
    // which quietly shorts the customer the difference between the two.
    expect(payoutFor("mixed", sums, 0)).toEqual({
      type: "credit",
      cash: 0,
      credit: 7500,
    })
    expect(payoutFor("mixed", sums, -50)).toEqual({
      type: "credit",
      cash: 0,
      credit: 7500,
    })
  })
})

describe("the cash gate", () => {
  it("lets an ordinary customer take cash", () => {
    expect(cashBlock(customer().facts, 6000, CASH_CAP, NOW).kind).toBe("none")
  })

  it("refuses cash to a customer flagged no_cash, with the reason", () => {
    const block = cashBlock(customer({ facts: { flags: ["no_cash"], idStatus: "verified" } }).facts, 6000, CASH_CAP, NOW)
    expect(block.kind).toBe("flag")
    expect(block.message).toContain("store credit only")
  })

  it("refuses cash to someone under 18", () => {
    const facts = { flags: [], idStatus: "none" as const, dob: "2010-01-01" }
    const block = cashBlock(facts, 6000, CASH_CAP, NOW)
    expect(block.kind).toBe("under_18")
    expect(block.message).toContain("under 18")
  })

  it("lets an 18th birthday through on the day", () => {
    const facts = { flags: [], idStatus: "none" as const, dob: "2008-09-20" }
    expect(ageAt("2008-09-20", NOW)).toBe(18)
    expect(cashBlock(facts, 6000, CASH_CAP, NOW).kind).toBe("none")
  })

  it("says cash is switched off when the cap is zero", () => {
    const block = cashBlock(customer().facts, 0, 0, NOW)
    expect(block.kind).toBe("off")
    expect(block.message).toBe("Cash payouts are switched off in settings.")
  })

  it("refuses cash over the cap and names the cap", () => {
    const block = cashBlock(customer().facts, CASH_CAP + 1, CASH_CAP, NOW)
    expect(block.kind).toBe("cap")
    expect(block.message).toContain("£8,000.00")
  })

  it("allows exactly the cap", () => {
    expect(cashBlock(customer().facts, CASH_CAP, CASH_CAP, NOW).kind).toBe("none")
  })
})

describe("the ID gate", () => {
  const good = {
    flags: [] as const,
    idStatus: "verified" as const,
    idExpiry: "2030-01-01",
    address: "12 Castle Street, Bolsover, S44 6PP",
  }
  const HAS_PHOTO = { hasPhoto: true }

  it("asks for the whole check when no ID is on file", () => {
    expect(idGate({ flags: [], idStatus: "none" }, HAS_PHOTO, NOW)).toEqual({
      needed: true,
      reason: "full",
    })
  })

  it("asks again when the one on file has expired", () => {
    expect(idFieldsGood({ ...good, idExpiry: "2020-01-01" }, NOW)).toBe(false)
    expect(idGate({ ...good, idExpiry: "2020-01-01" }, HAS_PHOTO, NOW)).toEqual({
      needed: true,
      reason: "full",
    })
  })

  it("asks again when the photo has been purged, however good the fields are", () => {
    expect(idGate(good, { hasPhoto: false }, NOW)).toEqual({
      needed: true,
      reason: "full",
    })
  })

  it("asks again while the photo lookup has not answered", () => {
    expect(idGate(good, { hasPhoto: null }, NOW)).toEqual({
      needed: true,
      reason: "full",
    })
  })

  it("asks only for the address when that is all that is missing", () => {
    expect(idGate({ ...good, address: "" }, HAS_PHOTO, NOW)).toEqual({
      needed: true,
      reason: "address",
    })
  })

  it("is satisfied by verified fields, a photo and an address", () => {
    expect(idGate(good, HAS_PHOTO, NOW)).toEqual({ needed: false })
  })
})

describe("what each step will not let past", () => {
  const sums = totals([line()], RULES, SETTINGS)

  function stateAt(step: WizardState["step"], patch: Partial<WizardState> = {}): WizardState {
    return { ...initialState, step, customer: customer(), lines: [line()], ...patch }
  }

  it("will not leave the customer step with nobody chosen", () => {
    const gate = canAdvance(
      { ...initialState, customer: null },
      totals([], RULES, SETTINGS),
      payoutFor("credit", { cash: 0, credit: 0 }, 0),
      CASH_CAP,
      NOW
    )
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain("customer")
  })

  it("will not leave the items step empty-handed", () => {
    const gate = canAdvance(
      stateAt("items", { lines: [] }),
      totals([], RULES, SETTINGS),
      payoutFor("credit", { cash: 0, credit: 0 }, 0),
      CASH_CAP,
      NOW
    )
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain("at least one item")
  })

  it("will not take an offer without the terms and a signature", () => {
    const payout = payoutFor("credit", sums, 0)
    const noTerms = canAdvance(stateAt("offer"), sums, payout, CASH_CAP, NOW)
    expect(noTerms.reason).toContain("terms")

    const noSignature = canAdvance(
      stateAt("offer", { termsAccepted: true }),
      sums,
      payout,
      CASH_CAP,
      NOW
    )
    expect(noSignature.reason).toContain("sign")
  })

  it("blocks a cash offer to a no_cash customer at the offer step", () => {
    const blocked = stateAt("offer", {
      customer: customer({ facts: { flags: ["no_cash"], idStatus: "verified" } }),
      payoutType: "cash",
      termsAccepted: true,
      signature: "data:image/png;base64,AAA",
    })
    const gate = canAdvance(blocked, sums, payoutFor("cash", sums, 0), CASH_CAP, NOW)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain("store credit only")
  })

  it("blocks a cash offer over the cap at the offer step", () => {
    const big = totals([line({ marketPence: 2_000_000 })], RULES, SETTINGS)
    const state = stateAt("offer", {
      payoutType: "cash",
      termsAccepted: true,
      signature: "data:image/png;base64,AAA",
    })
    const gate = canAdvance(state, big, payoutFor("cash", big, 0), CASH_CAP, NOW)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain("capped")
  })

  it("lets a signed credit offer through", () => {
    const state = stateAt("offer", {
      termsAccepted: true,
      signature: "data:image/png;base64,AAA",
    })
    expect(canAdvance(state, sums, payoutFor("credit", sums, 0), CASH_CAP, NOW).ok).toBe(
      true
    )
  })
})

describe("the reducer", () => {
  it("puts a no_cash customer on credit before the offer step opens", () => {
    const next = reducer(
      { ...initialState, payoutType: "cash" },
      {
        type: "choose-customer",
        customer: customer({ facts: { flags: ["no_cash"], idStatus: "none" } }),
      }
    )
    expect(next.payoutType).toBe("credit")
  })

  it("adds, edits and removes lines", () => {
    let state = reducer(initialState, { type: "add-line", line: line() })
    state = reducer(state, { type: "update-line", key: "k1", patch: { qty: 4 } })
    expect(state.lines[0]?.qty).toBe(4)
    state = reducer(state, { type: "remove-line", key: "k1" })
    expect(state.lines).toHaveLength(0)
  })

  it("adopts the ids a save hands back, in order", () => {
    let state = reducer(initialState, { type: "add-line", line: line() })
    state = reducer(state, { type: "add-line", line: line({ key: "k2" }) })
    state = reducer(state, { type: "adopt-line-ids", ids: ["srv1", "srv2"] })
    expect(state.lines.map((entry) => entry.id)).toEqual(["srv1", "srv2"])
  })

  it("lands on done with the number the server assigned", () => {
    const state = reducer(initialState, {
      type: "completed",
      number: "GG-BI-000003",
      labels: 3,
      points: 150,
      items: [],
    })
    expect(state.step).toBe("done")
    expect(state.completed?.number).toBe("GG-BI-000003")
  })
})

describe("saving", () => {
  it("stores the offer the customer is actually taking", () => {
    const cash = toLineInputs([line()], RULES, SETTINGS, "cash")[0]
    const credit = toLineInputs([line()], RULES, SETTINGS, "credit")[0]
    expect(cash?.offerPrice).toBe(6000)
    expect(credit?.offerPrice).toBe(7500)
  })

  it("puts a retro line's grade in completeness, not condition", () => {
    const input = toLineInputs(
      [line({ kind: "retro", condition: "cib" })],
      RULES,
      SETTINGS,
      "credit"
    )[0]
    expect(input?.completeness).toBe("cib")
    expect(input?.condition).toBeUndefined()
    expect(input?.kind).toBe("retro")
  })

  it("sends a lot as one line, never as a price per card", () => {
    // 400 cards at £20 the lot. A quantity of 400 here is how the server
    // would come to owe £8,000 and refuse the whole buy-in.
    const lot = line({ kind: "bulk", qty: 400, bulkOffer: 2000, marketPence: 2000 })
    const input = toLineInputs([lot], RULES, SETTINGS, "cash")[0]
    expect(input?.kind).toBe("other")
    expect(input?.qty).toBe(1)
    expect(input?.offerPrice).toBe(2000)
    expect(input?.marketPrice).toBe(2000)
    expect(input?.marketSource).toBe("Bulk lot")
    expect(input?.title).toBe("Bulk lot, 400 cards")

    // And what the server is asked to pay matches what it will work out.
    const sums = totals([lot], RULES, SETTINGS)
    expect(payoutFor("cash", sums, 0).cash).toBe(2000)
    expect(sums.units).toBe(1)
  })

  it("adds a line's own quantity up under a mixed payout", () => {
    const lines = [line({ qty: 2 }), line({ key: "k2", kind: "sealed", condition: "", marketPence: 4000, qty: 3 })]
    const sums = totals(lines, RULES, SETTINGS)
    const payout = payoutFor("mixed", sums, 2000)
    expect(payout.cash + payout.credit).toBe(sums.cash)

    const sent = toLineInputs(lines, RULES, SETTINGS, "mixed").reduce(
      (total, input) => total + input.offerPrice * input.qty,
      0
    )
    expect(sent).toBe(payout.cash + payout.credit)
  })

  it("carries an override and its reason to the server", () => {
    const input = toLineInputs(
      [
        line({
          overrideCash: 1000,
          overrideCredit: 1500,
          overrideReason: "Edge wear the photo does not show",
        }),
      ],
      RULES,
      SETTINGS,
      "cash"
    )[0]
    expect(input?.offerPrice).toBe(1000)
    expect(input?.overrideCash).toBe(1000)
    expect(input?.overrideCredit).toBe(1500)
    expect(input?.overrideReason).toBe("Edge wear the photo does not show")
  })

  it("carries a retro cosmetic grade", () => {
    const input = toLineInputs(
      [line({ kind: "retro", condition: "cib", cosmetic: "B" })],
      RULES,
      SETTINGS,
      "credit"
    )[0]
    expect(input?.cosmeticGrade).toBe("B")
  })
})

describe("reopening a draft", () => {
  it("rebuilds the lines that decide money", () => {
    const record = {
      id: "trade_1",
      number: "",
      customer: "cust_1",
      status: "draft",
      payout_type: "cash",
    } as TradeInRecord
    const lines: TradeInLineRecord[] = [
      {
        id: "line_1",
        trade_in: "trade_1",
        kind: "retro",
        completeness: "boxed",
        free_text_title: "Mario Kart 64",
        qty: 1,
        market_price: 2500,
        market_source: "Manual",
        accepted: true,
      },
    ]
    const state = hydrate(record, lines, customer())
    expect(state.step).toBe("items")
    expect(state.tradeInId).toBe("trade_1")
    expect(state.payoutType).toBe("cash")
    expect(state.lines[0]).toMatchObject({
      id: "line_1",
      kind: "retro",
      condition: "boxed",
      marketPence: 2500,
    })
  })

  it("starts on the customer step when the draft has nobody on it", () => {
    const record = { id: "t", number: "", customer: "", status: "draft" } as TradeInRecord
    expect(hydrate(record, [], null).step).toBe("customer")
  })

  it("rebuilds a lot as a lot, count and flat figure intact", () => {
    const record = { id: "t", number: "", customer: "c", status: "draft" } as TradeInRecord
    const state = hydrate(
      record,
      [
        {
          id: "line_lot",
          trade_in: "t",
          kind: "other",
          free_text_title: "Bulk lot, 400 cards",
          qty: 1,
          market_price: 2000,
          market_source: "Bulk lot",
          offer_price: 2000,
          accepted: true,
        },
      ],
      customer()
    )
    expect(state.lines[0]).toMatchObject({
      kind: "bulk",
      qty: 400,
      bulkOffer: 2000,
    })
    // And it still sends as one line, not four hundred.
    expect(toLineInputs(state.lines, RULES, SETTINGS, "cash")[0]?.qty).toBe(1)
  })

  it("brings an override back overridden, rather than repricing it", () => {
    const record = { id: "t", number: "", customer: "c", status: "draft" } as TradeInRecord
    const state = hydrate(
      record,
      [
        {
          id: "line_1",
          trade_in: "t",
          kind: "single",
          free_text_title: "Charizard ex",
          condition: "NM",
          qty: 1,
          market_price: 10_000,
          offer_price: 1000,
          override_cash: 1000,
          override_credit: 1500,
          override_reason: "Edge wear the photo does not show",
          accepted: true,
        },
      ],
      customer()
    )
    expect(state.lines[0]).toMatchObject({
      overrideCash: 1000,
      overrideCredit: 1500,
      overrideReason: "Edge wear the photo does not show",
    })
    const offer = lineOffer(state.lines[0] as TradeLine, RULES, SETTINGS)
    expect(offer.source).toBe("override")
    expect(offer.cash).toBe(1000)
  })

  it("brings a retro cosmetic grade back", () => {
    const record = { id: "t", number: "", customer: "c", status: "draft" } as TradeInRecord
    const state = hydrate(
      record,
      [
        {
          id: "line_1",
          trade_in: "t",
          kind: "retro",
          completeness: "cib",
          cosmetic_grade: "C",
          free_text_title: "Mario Kart 64",
          qty: 1,
          accepted: true,
        },
      ],
      customer()
    )
    expect(state.lines[0]?.cosmetic).toBe("C")
  })
})
