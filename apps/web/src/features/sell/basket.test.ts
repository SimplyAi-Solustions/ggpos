import { describe, expect, it } from "vitest"

import {
  basketReducer,
  checkPayment,
  emptyBasket,
  emptySplit,
  perkFor,
  pointsPreview,
  summarise,
  voucherProblem,
  type BasketLine,
  type BasketState,
} from "@/features/sell/basket"
import type { LoyaltySetup, RewardVoucher, SaleCustomer } from "@/lib/api/types"

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

const SETUP: LoyaltySetup = {
  programme: PROGRAMME,
  rules: [],
  tiers: [
    {
      id: "tier_legend",
      name: "Legend",
      thresholdPoints: 10000,
      sort: 30,
      perks: [
        { type: "percent_off", value: 10, scope: ["single", "sealed"] },
        { type: "points_multiplier", value: 1.5 },
      ],
      paidPlan: false,
    },
  ],
}

const LEGEND: SaleCustomer = {
  id: "cust_1",
  name: "Brock Harrison",
  code: "GGC2X5N8W",
  tierId: "tier_legend",
  tierName: "Legend",
  perks: SETUP.tiers[0]!.perks,
  creditBalance: 4500,
  pointsBalance: 11400,
}

function line(over: Partial<BasketLine> = {}): BasketLine {
  return {
    itemId: "item_1",
    sku: "GGS7F3K2Q",
    title: "Charizard ex",
    detail: "SV151 199/165",
    kind: "single",
    condition: "NM",
    platform: "tcg_card",
    unitPrice: 32499,
    listPrice: 32499,
    qty: 1,
    maxQty: 1,
    game: "game_pokemon",
    ...over,
  }
}

const SEALED = line({
  itemId: "item_2",
  sku: "GGP5N2W8H",
  title: "Surging Sparks ETB",
  kind: "sealed",
  unitPrice: 4995,
  listPrice: 4995,
  maxQty: 6,
})

function withLines(...lines: BasketLine[]): BasketState {
  return lines.reduce(
    (state, one) => basketReducer(state, { type: "add", line: one }),
    emptyBasket()
  )
}

describe("the basket reducer", () => {
  it("adds a line", () => {
    const state = withLines(line())
    expect(state.lines).toHaveLength(1)
    expect(state.lines[0]?.qty).toBe(1)
  })

  it("increments a multi-quantity line instead of repeating it", () => {
    const state = basketReducer(withLines(SEALED), { type: "add", line: SEALED })
    expect(state.lines).toHaveLength(1)
    expect(state.lines[0]?.qty).toBe(2)
  })

  it("never takes a single past one, because a single is one row per unit", () => {
    const once = withLines(line())
    const twice = basketReducer(once, { type: "add", line: line() })
    expect(twice.lines[0]?.qty).toBe(1)
  })

  it("stops at the quantity in stock", () => {
    const state = basketReducer(withLines(SEALED), {
      type: "setQty",
      itemId: SEALED.itemId,
      qty: 99,
    })
    expect(state.lines[0]?.qty).toBe(6)
  })

  it("removes a line, and a quantity of zero removes it too", () => {
    const state = basketReducer(withLines(line(), SEALED), {
      type: "remove",
      itemId: "item_1",
    })
    expect(state.lines.map((row) => row.itemId)).toEqual(["item_2"])

    const zeroed = basketReducer(state, {
      type: "setQty",
      itemId: "item_2",
      qty: 0,
    })
    expect(zeroed.lines).toHaveLength(0)
  })

  it("overrides a unit price and keeps the ticket price beside it", () => {
    const state = basketReducer(withLines(line()), {
      type: "setUnitPrice",
      itemId: "item_1",
      unitPrice: 30000,
    })
    expect(state.lines[0]?.unitPrice).toBe(30000)
    expect(state.lines[0]?.listPrice).toBe(32499)
  })

  it("drops a voucher when the customer it belonged to is swapped out", () => {
    const voucher: RewardVoucher = {
      id: "r1",
      code: "GGV3H7K9T",
      customer: LEGEND.id,
      rewardName: "Five pounds off",
      type: "money_off",
      value: 500,
      expiresAt: null,
    }
    const attached = basketReducer(withLines(line()), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    const withVoucher = basketReducer(attached, { type: "applyVoucher", voucher })
    expect(withVoucher.voucher).not.toBeNull()

    const detached = basketReducer(withVoucher, {
      type: "attachCustomer",
      customer: null,
    })
    expect(detached.voucher).toBeNull()
  })

  it("clears the split when the payment method changes", () => {
    const split = basketReducer(withLines(line()), {
      type: "setSplit",
      method: "cash",
      amount: 1000,
    })
    expect(split.split.cash).toBe(1000)
    const changed = basketReducer(split, { type: "setPayment", payment: "mixed" })
    expect(changed.split).toEqual(emptySplit())
  })
})

describe("the totals", () => {
  it("adds the lines up in pence", () => {
    const totals = summarise(withLines(line(), SEALED))
    expect(totals.subtotal).toBe(32499 + 4995)
    expect(totals.discount).toBe(0)
    expect(totals.total).toBe(37494)
  })

  it("takes a manual amount off", () => {
    const state = basketReducer(withLines(line()), {
      type: "setDiscount",
      discount: { kind: "amount", value: 2499 },
    })
    const totals = summarise(state)
    expect(totals.manualDiscount).toBe(2499)
    expect(totals.total).toBe(30000)
    expect(totals.discountSource).toBe("manual")
  })

  it("takes a manual percentage off, rounded half-up to the penny", () => {
    const state = basketReducer(withLines(line()), {
      type: "setDiscount",
      discount: { kind: "percent", value: 10 },
    })
    const totals = summarise(state)
    expect(totals.manualDiscount).toBe(3250)
    expect(totals.total).toBe(29249)
  })

  it("never discounts past zero", () => {
    const state = basketReducer(withLines(line({ unitPrice: 500 })), {
      type: "setDiscount",
      discount: { kind: "amount", value: 900 },
    })
    expect(summarise(state).total).toBe(0)
  })

  it("applies the tier perk only to the kinds it covers", () => {
    const retro = line({ itemId: "item_3", kind: "retro", unitPrice: 2000, sku: "GGRAAAA1" })
    const state = basketReducer(withLines(line(), SEALED, retro), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    const perk = perkFor(state.lines, LEGEND)
    // 10 percent off the single and the sealed box, nothing off the retro.
    expect(perk.amount).toBe(3250 + 500)
    expect(perk.percent).toBe(10)

    const totals = summarise(state)
    expect(totals.perkDiscount).toBe(3750)
    expect(totals.discountSource).toBe("tier_perk")
  })

  it("lets a reward stand in for every other discount, never stack on them", () => {
    const voucher: RewardVoucher = {
      id: "r1",
      code: "GGV3H7K9T",
      customer: LEGEND.id,
      rewardName: "Five pounds off",
      type: "money_off",
      value: 500,
      expiresAt: null,
    }
    let state = basketReducer(withLines(line()), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    state = basketReducer(state, {
      type: "setDiscount",
      discount: { kind: "amount", value: 100 },
    })
    state = basketReducer(state, { type: "applyVoucher", voucher })

    const totals = summarise(state)
    // The completion route checks the discount equals the reward's value, so
    // the Legend perk and the manual pound both step aside.
    expect(totals.voucherDiscount).toBe(500)
    expect(totals.perkDiscount).toBe(0)
    expect(totals.manualDiscount).toBe(0)
    expect(totals.discount).toBe(500)
    expect(totals.discountSource).toBe("reward")

    const cleared = basketReducer(state, { type: "applyVoucher", voucher: null })
    const after = summarise(cleared)
    expect(after.perkDiscount).toBe(3250)
    expect(after.manualDiscount).toBe(100)
    expect(after.discountSource).toBe("manual")
  })

  it("refuses a reward that is not this customer's", () => {
    const voucher: RewardVoucher = {
      id: "r1",
      code: "GGV3H7K9T",
      customer: "cust_someone_else",
      rewardName: "Five pounds off",
      type: "money_off",
      value: 500,
      expiresAt: null,
    }
    const state = basketReducer(withLines(line()), {
      type: "applyVoucher",
      voucher,
    })
    const check = checkPayment(state, summarise(state), {
      programme: PROGRAMME,
      cashSessionOpen: true,
    })
    expect(check.ok).toBe(false)
    expect(check.problems).toContain(
      "A reward needs the customer it was issued to on the sale."
    )
  })

  it("spreads the discount across the lines for the points preview", () => {
    const state = basketReducer(withLines(line(), SEALED), {
      type: "setDiscount",
      discount: { kind: "amount", value: 1000 },
    })
    const totals = summarise(state)
    const spread = totals.lineTotals.reduce((sum, row) => sum + row.total, 0)
    expect(spread).toBe(totals.total)
  })

  it("earns nothing without a customer and the tier multiplier with one", () => {
    const plain = withLines(line({ unitPrice: 1000 }))
    expect(pointsPreview(plain, summarise(plain), SETUP, 0)).toBe(0)

    const attached = basketReducer(plain, {
      type: "attachCustomer",
      customer: LEGEND,
    })
    const totals = summarise(attached)
    // £9 after the 10 percent Legend perk, 10 points a pound, then 1.5x.
    expect(totals.total).toBe(900)
    expect(pointsPreview(attached, totals, SETUP, 0)).toBe(135)
  })
})

describe("the payment check", () => {
  const ctx = { programme: PROGRAMME, cashSessionOpen: true }

  it("puts the whole total on a single method", () => {
    const state = withLines(line())
    const check = checkPayment(state, summarise(state), ctx)
    expect(check.split.sumup_card).toBe(32499)
    expect(check.sumupAmount).toBe(32499)
    expect(check.ok).toBe(true)
  })

  it("refuses a mixed payment that does not reach the total", () => {
    let state = basketReducer(withLines(line()), {
      type: "setPayment",
      payment: "mixed",
    })
    state = basketReducer(state, { type: "setSplit", method: "cash", amount: 20000 })
    const check = checkPayment(state, summarise(state), ctx)
    expect(check.ok).toBe(false)
    expect(check.problems[0]).toContain("£124.99")
  })

  it("accepts a mixed payment that sums exactly", () => {
    let state = basketReducer(withLines(line()), {
      type: "setPayment",
      payment: "mixed",
    })
    state = basketReducer(state, { type: "setSplit", method: "cash", amount: 20000 })
    state = basketReducer(state, {
      type: "setSplit",
      method: "sumup_card",
      amount: 12499,
    })
    const check = checkPayment(state, summarise(state), ctx)
    expect(check.ok).toBe(true)
    expect(check.sumupAmount).toBe(12499)
  })

  it("refuses cash with no session open", () => {
    const state = basketReducer(withLines(line()), {
      type: "setPayment",
      payment: "cash",
    })
    const check = checkPayment(state, summarise(state), {
      ...ctx,
      cashSessionOpen: false,
    })
    expect(check.ok).toBe(false)
    expect(check.problems).toContain("Open a cash session before taking cash.")
  })

  it("says how short the store credit is", () => {
    const poor: SaleCustomer = { ...LEGEND, creditBalance: 1000 }
    let state = basketReducer(withLines(line({ unitPrice: 5000 })), {
      type: "attachCustomer",
      customer: poor,
    })
    state = basketReducer(state, { type: "setPayment", payment: "store_credit" })
    const check = checkPayment(state, summarise(state), ctx)
    expect(check.ok).toBe(false)
    expect(check.problems[0]).toContain("Short by")
  })

  it("holds points to the programme's share of a sale", () => {
    let state = basketReducer(withLines(line({ unitPrice: 5000 })), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    state = basketReducer(state, { type: "setPayment", payment: "points" })
    const totals = summarise(state)
    const check = checkPayment(state, totals, ctx)
    // The Legend perk leaves £45, and points may cover half of it at most.
    expect(totals.total).toBe(4500)
    expect(check.ok).toBe(false)
    expect(check.problems[0]).toContain("Points cover at most")
  })

  it("refuses an empty basket", () => {
    const state = emptyBasket()
    const check = checkPayment(state, summarise(state), ctx)
    expect(check.ok).toBe(false)
    expect(check.problems).toContain("Scan an item to start a sale.")
  })
})

describe("a reward that cannot go on the basket", () => {
  const voucher: RewardVoucher = {
    id: "r1",
    code: "GGV3H7K9T",
    customer: LEGEND.id,
    rewardName: "Five pounds off",
    type: "money_off",
    value: 500,
    expiresAt: null,
  }

  it("refuses anything that is not money off", () => {
    expect(
      voucherProblem({ ...voucher, type: "free_item" }, LEGEND, 10000)
    ).toBe("That reward is not money off. Use it on the customer's account instead.")
  })

  it("refuses one worth more than the basket, which the route could not take", () => {
    expect(voucherProblem(voucher, LEGEND, 300)).toBe(
      "This £5.00 reward is more than the basket. Add another item or take the reward off."
    )
  })

  it("refuses one issued to somebody else", () => {
    expect(voucherProblem(voucher, null, 10000)).toBe(
      "A reward needs the customer it was issued to on the sale."
    )
  })

  it("lets a money-off reward that fits through", () => {
    expect(voucherProblem(voucher, LEGEND, 10000)).toBeNull()
  })

  it("comes off with the last item, so no reward is left on an empty basket", () => {
    let state = basketReducer(withLines(line()), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    state = basketReducer(state, { type: "applyVoucher", voucher })
    expect(state.voucher).not.toBeNull()
    state = basketReducer(state, { type: "remove", itemId: "item_1" })
    expect(state.voucher).toBeNull()
  })
})

describe("a manual amount against a shrinking basket", () => {
  it("comes down with the basket rather than printing what was typed", () => {
    let state = withLines(line({ unitPrice: 5000 }), SEALED)
    state = basketReducer(state, {
      type: "setDiscount",
      discount: { kind: "amount", value: 6000 },
    })
    expect(summarise(state).manualDiscount).toBe(6000)

    state = basketReducer(state, { type: "remove", itemId: "item_1" })
    // Only the £49.95 box left, so that is the most that can come off, and
    // the stored figure says so too rather than the £60.00 that was typed.
    expect(state.manualDiscount).toEqual({ kind: "amount", value: 4995 })
    expect(summarise(state).manualDiscount).toBe(4995)
    expect(summarise(state).total).toBe(0)

    state = basketReducer(state, { type: "remove", itemId: "item_2" })
    expect(state.manualDiscount).toEqual({ kind: "none" })
  })

  it("leaves a discount that still fits alone", () => {
    let state = withLines(line({ unitPrice: 5000 }), SEALED)
    state = basketReducer(state, {
      type: "setDiscount",
      discount: { kind: "amount", value: 1000 },
    })
    state = basketReducer(state, { type: "remove", itemId: "item_1" })
    expect(state.manualDiscount).toEqual({ kind: "amount", value: 1000 })
  })
})

describe("the cash cap", () => {
  it("refuses cash when the shop has switched cash sales off", () => {
    const state = basketReducer(withLines(line()), {
      type: "setPayment",
      payment: "cash",
    })
    const check = checkPayment(state, summarise(state), {
      programme: PROGRAMME,
      cashSessionOpen: true,
      cashCap: 0,
    })
    expect(check.problems).toContain("Cash sales are switched off in settings.")
  })

  it("refuses cash over the cap, and says to put the rest on the card", () => {
    const state = basketReducer(withLines(line()), {
      type: "setPayment",
      payment: "cash",
    })
    const check = checkPayment(state, summarise(state), {
      programme: PROGRAMME,
      cashSessionOpen: true,
      cashCap: 30000,
    })
    expect(check.problems[0]).toContain("over the £300.00 cash cap")
  })

  it("refuses nothing on the cap's account while the config is still loading", () => {
    const state = basketReducer(withLines(line()), {
      type: "setPayment",
      payment: "cash",
    })
    const check = checkPayment(state, summarise(state), {
      programme: PROGRAMME,
      cashSessionOpen: true,
    })
    expect(check.ok).toBe(true)
  })
})

describe("the discount spread", () => {
  it("adds back up to the total, with the last line absorbing the remainder", () => {
    const state = basketReducer(
      withLines(
        line({ itemId: "a", unitPrice: 1000 }),
        line({ itemId: "b", unitPrice: 1000, maxQty: 1 }),
        line({ itemId: "c", unitPrice: 1000, maxQty: 1 })
      ),
      { type: "setDiscount", discount: { kind: "amount", value: 100 } }
    )
    const totals = summarise(state)
    expect(totals.lineTotals.map((row) => row.total)).toEqual([967, 967, 966])
    expect(totals.lineTotals.reduce((sum, row) => sum + row.total, 0)).toBe(
      totals.total
    )
  })
})
