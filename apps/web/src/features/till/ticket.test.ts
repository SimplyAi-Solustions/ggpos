import { describe, expect, it } from "vitest"

import {
  emptyTicket,
  lineFromCatalogueItem,
  lineFromProduct,
  overDiscountLimit,
  perkFor,
  pointsPreview,
  saleLines,
  summarise,
  ticketReducer,
  vatInside,
  voucherProblem,
  type Ticket,
  type TicketAction,
  type TicketLine,
} from "@/features/till/ticket"
import type { LoyaltySetup, RewardVoucher, SaleCustomer } from "@/lib/api/types"

/**
 * The till's arithmetic, against the completion route's own rules
 * (docs/api-contract-epos.md, section 4): a line comes to
 * `unit_price * qty - discount`, the ticket discount comes off the lines'
 * total and is spread back over them, the last line taking the remainder.
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
  member: true,
  paidMember: false,
}

const VOUCHER: RewardVoucher = {
  id: "r1",
  code: "GGV3H7K9T",
  customer: LEGEND.id,
  rewardName: "Five pounds off",
  type: "money_off",
  value: 500,
  expiresAt: null,
}

function line(over: Partial<TicketLine> = {}): TicketLine {
  const key = over.key ?? over.itemId ?? "item_1"
  return {
    key,
    itemId: key,
    productId: null,
    productKind: null,
    sku: "GGS7F3K2Q",
    title: "Charizard ex",
    detail: "SV151 199/165",
    kind: "single",
    condition: "NM",
    platform: "tcg_card",
    unitPrice: 32499,
    listPrice: 32499,
    openPrice: false,
    qty: 1,
    maxQty: 1,
    game: "game_pokemon",
    taxScheme: "margin",
    vatRate: 20,
    discount: { kind: "none" },
    note: "",
    ...over,
  }
}

const SEALED = line({
  key: "item_2",
  itemId: "item_2",
  sku: "GGP5N2W8H",
  title: "Surging Sparks ETB",
  kind: "sealed",
  unitPrice: 4995,
  listPrice: 4995,
  maxQty: 6,
  taxScheme: "standard",
})

function apply(ticket: Ticket, ...actions: TicketAction[]): Ticket {
  return actions.reduce(ticketReducer, ticket)
}

function withLines(...lines: TicketLine[]): Ticket {
  return apply(emptyTicket(), ...lines.map((one) => ({ type: "add" as const, line: one })))
}

describe("the ticket reducer", () => {
  it("adds a line", () => {
    const ticket = withLines(line())
    expect(ticket.lines).toHaveLength(1)
    expect(ticket.lines[0]?.qty).toBe(1)
  })

  it("adds one more of a stock line instead of repeating it", () => {
    const ticket = apply(withLines(SEALED), { type: "add", line: SEALED })
    expect(ticket.lines).toHaveLength(1)
    expect(ticket.lines[0]?.qty).toBe(2)
  })

  it("never takes a single past one, because a single is one row per unit", () => {
    const ticket = apply(withLines(line()), { type: "add", line: line() })
    expect(ticket.lines[0]?.qty).toBe(1)
  })

  it("stops at the quantity in stock", () => {
    const ticket = apply(withLines(SEALED), { type: "setQty", key: "item_2", qty: 99 })
    expect(ticket.lines[0]?.qty).toBe(6)
  })

  it("removes a line, logs it as a void, and a quantity of zero does the same", () => {
    const ticket = apply(withLines(line(), SEALED), { type: "remove", key: "item_1" })
    expect(ticket.lines.map((row) => row.key)).toEqual(["item_2"])
    expect(ticket.voided).toEqual([{ title: "Charizard ex", qty: 1, amount: 32499 }])

    const zeroed = apply(ticket, { type: "setQty", key: "item_2", qty: 0 })
    expect(zeroed.lines).toHaveLength(0)
    expect(zeroed.voided).toHaveLength(2)
    expect(zeroed.voided[1]).toEqual({ title: "Surging Sparks ETB", qty: 1, amount: 4995 })
  })

  it("changes a price and keeps the ticket price beside it", () => {
    const ticket = apply(withLines(line()), {
      type: "updateLine",
      key: "item_1",
      patch: { unitPrice: 30000, note: "  Corner ding  " },
    })
    expect(ticket.lines[0]?.unitPrice).toBe(30000)
    expect(ticket.lines[0]?.listPrice).toBe(32499)
    expect(ticket.lines[0]?.note).toBe("Corner ding")
  })

  it("brings a line discount down with the line rather than past it", () => {
    let ticket = apply(withLines(SEALED), { type: "setQty", key: "item_2", qty: 3 })
    ticket = apply(ticket, {
      type: "updateLine",
      key: "item_2",
      patch: { discount: { kind: "amount", value: 10000 } },
    })
    expect(ticket.lines[0]?.discount).toEqual({ kind: "amount", value: 10000 })
    ticket = apply(ticket, { type: "setQty", key: "item_2", qty: 1 })
    expect(ticket.lines[0]?.discount).toEqual({ kind: "amount", value: 4995 })
  })

  it("drops a voucher when the customer it belonged to is taken off", () => {
    const withVoucher = apply(
      withLines(line()),
      { type: "attachCustomer", customer: LEGEND },
      { type: "applyVoucher", voucher: VOUCHER }
    )
    expect(withVoucher.voucher).not.toBeNull()
    const detached = apply(withVoucher, { type: "attachCustomer", customer: null })
    expect(detached.voucher).toBeNull()
  })

  it("takes a membership off with the customer it was being sold to", () => {
    const membership = lineFromProduct(
      {
        id: "product_guild",
        name: "Guild Membership, 12 months",
        kind: "membership",
        price: 2400,
        open_price: false,
        image_url: "",
        tax_scheme: "standard",
      },
      { key: "m1" }
    )
    const ticket = apply(
      withLines(line()),
      { type: "attachCustomer", customer: LEGEND },
      { type: "add", line: membership },
      { type: "attachCustomer", customer: null }
    )
    expect(ticket.lines.map((row) => row.key)).toEqual(["item_1"])
  })

  it("keeps two open-price keys as two lines, and one fixed product as one line", () => {
    const single = {
      id: "product_single",
      name: "Single card",
      kind: "open_price" as const,
      price: 0,
      open_price: true,
      image_url: "",
      tax_scheme: "margin" as const,
    }
    const table = {
      id: "product_table",
      name: "Table time, 1 hour",
      kind: "service" as const,
      price: 500,
      open_price: false,
      image_url: "",
      tax_scheme: "standard" as const,
    }
    const ticket = withLines(
      lineFromProduct(single, { key: "a", price: 250, detail: "Pikachu" }),
      lineFromProduct(single, { key: "b", price: 400 }),
      lineFromProduct(table, { key: "c" }),
      lineFromProduct(table, { key: "d" })
    )
    expect(ticket.lines.map((row) => [row.title, row.unitPrice, row.qty])).toEqual([
      ["Single card: Pikachu", 250, 1],
      ["Single card", 400, 1],
      ["Table time, 1 hour", 500, 2],
    ])
  })
})

describe("the totals", () => {
  it("adds the lines up in pence", () => {
    const totals = summarise(withLines(line(), SEALED))
    expect(totals.subtotal).toBe(32499 + 4995)
    expect(totals.discount).toBe(0)
    expect(totals.total).toBe(37494)
  })

  it("takes a line's own discount off that line, as the route does", () => {
    const ticket = apply(withLines(line(), SEALED), {
      type: "updateLine",
      key: "item_2",
      patch: { discount: { kind: "percent", value: 10 } },
    })
    const totals = summarise(ticket)
    // 10 percent of £49.95 is £5.00 to the penny, half-up.
    expect(totals.lineDiscounts).toBe(500)
    expect(totals.subtotal).toBe(32499 + 4495)
    expect(totals.total).toBe(36994)
    expect(saleLines(ticket)[1]).toEqual({
      item: "item_2",
      qty: 1,
      unit_price: 4995,
      discount: 500,
    })
  })

  it("takes a manual amount off the ticket", () => {
    const totals = summarise(
      apply(withLines(line()), { type: "setDiscount", discount: { kind: "amount", value: 2499 } })
    )
    expect(totals.manualDiscount).toBe(2499)
    expect(totals.total).toBe(30000)
    expect(totals.discountSource).toBe("manual")
  })

  it("takes a manual percentage off, rounded half-up to the penny", () => {
    const totals = summarise(
      apply(withLines(line()), { type: "setDiscount", discount: { kind: "percent", value: 10 } })
    )
    expect(totals.manualDiscount).toBe(3250)
    expect(totals.total).toBe(29249)
  })

  it("never discounts past zero", () => {
    const ticket = apply(withLines(line({ unitPrice: 500 })), {
      type: "setDiscount",
      discount: { kind: "amount", value: 900 },
    })
    expect(summarise(ticket).total).toBe(0)
  })

  it("applies the tier perk only to the kinds it covers", () => {
    const retro = line({ key: "item_3", itemId: "item_3", kind: "retro", unitPrice: 2000 })
    const ticket = apply(withLines(line(), SEALED, retro), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    const perk = perkFor(ticket.lines, LEGEND)
    // 10 percent off the single and the sealed box, nothing off the retro.
    expect(perk.amount).toBe(3250 + 500)
    expect(perk.percent).toBe(10)
    const totals = summarise(ticket)
    expect(totals.perkDiscount).toBe(3750)
    expect(totals.discountSource).toBe("tier_perk")
  })

  it("lets a reward stand in for every other discount, never stack on them", () => {
    const ticket = apply(
      withLines(line()),
      { type: "attachCustomer", customer: LEGEND },
      { type: "setDiscount", discount: { kind: "amount", value: 100 } },
      { type: "applyVoucher", voucher: VOUCHER }
    )
    const totals = summarise(ticket)
    expect(totals.voucherDiscount).toBe(500)
    expect(totals.perkDiscount).toBe(0)
    expect(totals.manualDiscount).toBe(0)
    expect(totals.discount).toBe(500)
    expect(totals.discountSource).toBe("reward")

    const after = summarise(apply(ticket, { type: "applyVoucher", voucher: null }))
    expect(after.perkDiscount).toBe(3250)
    expect(after.manualDiscount).toBe(100)
    expect(after.discountSource).toBe("manual")
  })

  it("spreads the ticket discount over the lines, the last taking the remainder", () => {
    const ticket = apply(
      withLines(
        line({ key: "a", itemId: "a", unitPrice: 1000 }),
        line({ key: "b", itemId: "b", unitPrice: 1000 }),
        line({ key: "c", itemId: "c", unitPrice: 1000 })
      ),
      { type: "setDiscount", discount: { kind: "amount", value: 100 } }
    )
    const totals = summarise(ticket)
    expect(totals.lines.map((row) => row.paid)).toEqual([967, 967, 966])
    expect(totals.lines.reduce((sum, row) => sum + row.paid, 0)).toBe(totals.total)
  })

  it("counts VAT inside the standard-rated lines only, after discounts", () => {
    expect(vatInside(1200, 20)).toBe(200)
    expect(vatInside(4995, 20)).toBe(833)
    const totals = summarise(withLines(line(), SEALED))
    // The single is margin scheme, so only the box carries VAT.
    expect(totals.vat).toBe(833)
  })

  it("earns nothing without a customer and the tier multiplier with one", () => {
    const plain = withLines(line({ unitPrice: 1000 }))
    expect(pointsPreview(plain, summarise(plain), SETUP, 0)).toBe(0)
    const attached = apply(plain, { type: "attachCustomer", customer: LEGEND })
    const totals = summarise(attached)
    // £9 after the 10 percent Legend perk, 10 points a pound, then 1.5x.
    expect(totals.total).toBe(900)
    expect(pointsPreview(attached, totals, SETUP, 0)).toBe(135)
  })

  it("earns nothing on the part paid with points", () => {
    const attached = apply(withLines(line({ unitPrice: 1000 })), {
      type: "attachCustomer",
      customer: LEGEND,
    })
    const totals = summarise(attached)
    expect(pointsPreview(attached, totals, SETUP, 450)).toBe(68)
  })
})

describe("the discount limit", () => {
  it("is over when a manual discount takes more than the shop allows", () => {
    const ticket = apply(withLines(line({ unitPrice: 1000 })), {
      type: "setDiscount",
      discount: { kind: "amount", value: 150 },
    })
    expect(overDiscountLimit(ticket, 10)).toBe(true)
    expect(overDiscountLimit(ticket, 15)).toBe(false)
  })

  it("counts a line discount against that line", () => {
    const ticket = apply(withLines(line({ unitPrice: 1000 }), SEALED), {
      type: "updateLine",
      key: "item_1",
      patch: { discount: { kind: "percent", value: 20 } },
    })
    expect(overDiscountLimit(ticket, 10)).toBe(true)
  })

  it("never counts the tier perk, which is the server's own arithmetic", () => {
    const ticket = apply(withLines(line()), { type: "attachCustomer", customer: LEGEND })
    expect(overDiscountLimit(ticket, 5)).toBe(false)
  })
})

describe("a reward that cannot go on the ticket", () => {
  it("refuses anything that is not money off", () => {
    expect(voucherProblem({ ...VOUCHER, type: "free_item" }, LEGEND, 10000)).toBe(
      "That reward is not money off. Use it on the customer's account instead."
    )
  })

  it("refuses one worth more than the ticket, which the route could not take", () => {
    expect(voucherProblem(VOUCHER, LEGEND, 300)).toBe(
      "This £5.00 reward is more than the ticket. Add another item or take the reward off."
    )
  })

  it("refuses one issued to somebody else", () => {
    expect(voucherProblem(VOUCHER, null, 10000)).toBe(
      "A reward needs the customer it was issued to on the sale."
    )
  })

  it("comes off with the last line, so no reward is left on an empty ticket", () => {
    let ticket = apply(
      withLines(line()),
      { type: "attachCustomer", customer: LEGEND },
      { type: "applyVoucher", voucher: VOUCHER }
    )
    expect(ticket.voucher).not.toBeNull()
    ticket = apply(ticket, { type: "remove", key: "item_1" })
    expect(ticket.voucher).toBeNull()
  })
})

describe("a manual amount against a shrinking ticket", () => {
  it("comes down with the ticket rather than printing what was typed", () => {
    let ticket = apply(withLines(line({ unitPrice: 5000 }), SEALED), {
      type: "setDiscount",
      discount: { kind: "amount", value: 6000 },
    })
    expect(summarise(ticket).manualDiscount).toBe(6000)
    ticket = apply(ticket, { type: "remove", key: "item_1" })
    expect(ticket.discount).toEqual({ kind: "amount", value: 4995 })
    expect(summarise(ticket).total).toBe(0)
    ticket = apply(ticket, { type: "remove", key: "item_2" })
    expect(ticket.discount).toEqual({ kind: "none" })
  })
})

describe("what goes to the server", () => {
  it("sends a product line with its price, and an open-price title", () => {
    const ticket = withLines(
      lineFromProduct(
        {
          id: "product_single",
          name: "Single card",
          kind: "open_price",
          price: 0,
          open_price: true,
          image_url: "",
          tax_scheme: "margin",
        },
        { key: "a", price: 1250, detail: "Charizard ex" }
      ),
      lineFromCatalogueItem({
        id: "item_line",
        sku: "GGP5N2W8H",
        title: "Booster pack",
        price: 549,
        qty: 30,
        image_url: "",
        kind: "sealed",
        status: "in_stock",
      })
    )
    expect(saleLines(ticket)).toEqual([
      {
        product: "product_single",
        qty: 1,
        unit_price: 1250,
        discount: 0,
        title: "Single card: Charizard ex",
      },
      { item: "item_line", qty: 1, unit_price: 549, discount: 0 },
    ])
    expect(ticket.lines[1]?.maxQty).toBe(30)
  })
})
