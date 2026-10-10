import { describe, expect, it } from "vitest"
import type { TillCatalogueItem, TillCatalogueProduct } from "@gg/shared"

import {
  earnsPoints,
  emptyTicket,
  lineFromCatalogueItem,
  lineFromProduct,
  pointsPreview,
  summarise,
  ticketReducer,
  type Ticket,
} from "@/features/till/ticket"
import type { LoyaltySetup, SaleCustomer } from "@/lib/api/types"

/**
 * The till's "Earns N points" under the launch's rules
 * (docs/api-contract-launch.md, section 2): only a Guild member earns, a
 * Guild Membership on the ticket joins whoever buys it, and an offer on a
 * branch, an item or a product prices the line the till knows it by, the
 * way the sale route will.
 */

const SETUP: LoyaltySetup = {
  programme: {
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
  },
  rules: [
    {
      id: "pokemon",
      name: "Double Pokémon",
      type: "multiplier",
      conditions: { categories: ["branch_pokemon"] },
      value: 2,
      active: true,
      priority: 10,
      startsAt: null,
      endsAt: null,
    },
    {
      id: "table",
      name: "Table time bonus",
      type: "fixed_bonus",
      conditions: { products: ["product_table"] },
      value: 150,
      active: true,
      priority: 5,
      startsAt: null,
      endsAt: null,
    },
    {
      id: "plus",
      name: "Guild+ triple sleeves",
      type: "multiplier",
      conditions: { items: ["item_sleeves"], paidMembersOnly: true },
      value: 3,
      active: true,
      priority: 1,
      startsAt: null,
      endsAt: null,
    },
  ],
  tiers: [],
}

const LINEAGES = {
  branch_tcg: "|branch_tcg|",
  branch_pokemon: "|branch_tcg|branch_pokemon|",
  branch_singles: "|branch_tcg|branch_pokemon|branch_singles|",
  branch_retro: "|branch_retro|",
}

function customer(patch: Partial<SaleCustomer> = {}): SaleCustomer {
  return {
    id: "cust_1",
    name: "Jo Bloggs",
    code: "GGC4K7M2S",
    tierId: null,
    tierName: null,
    perks: [],
    creditBalance: 0,
    pointsBalance: 0,
    member: true,
    paidMember: false,
    ...patch,
  }
}

function item(id: string, price: number, category?: string): TillCatalogueItem {
  return { id, sku: id, title: id, price, qty: 5, image_url: "", kind: "sealed", status: "in_stock", category }
}

function product(id: string, kind: TillCatalogueProduct["kind"], price: number, category?: string): TillCatalogueProduct {
  return { id, name: id, kind, price, open_price: false, image_url: "", tax_scheme: "standard", category }
}

function ticketOf(lines: Ticket["lines"], who: SaleCustomer | null): Ticket {
  return ticketReducer({ ...emptyTicket(), lines }, { type: "attachCustomer", customer: who })
}

function points(ticket: Ticket): number {
  return pointsPreview(ticket, summarise(ticket), SETUP, 0, LINEAGES)
}

describe("the Guild at the till", () => {
  it("earns nothing for a customer who has not joined, and says so", () => {
    const ticket = ticketOf([lineFromCatalogueItem(item("box", 3000))], customer({ member: false }))
    expect(earnsPoints(ticket)).toBe(false)
    expect(points(ticket)).toBe(0)
  })

  it("earns for a member", () => {
    const ticket = ticketOf([lineFromCatalogueItem(item("box", 3000))], customer())
    expect(earnsPoints(ticket)).toBe(true)
    expect(points(ticket)).toBe(300)
  })

  it("lets the Guild Membership join whoever buys it, as a paid-plan member", () => {
    const ticket = ticketOf(
      [
        lineFromProduct(product("product_guild", "membership", 2400), { key: "p1" }),
        lineFromCatalogueItem(item("item_sleeves", 1000)),
      ],
      customer({ member: false })
    )
    expect(earnsPoints(ticket)).toBe(true)
    // 240 on the membership, 100 on the sleeves tripled by the paid-plan offer.
    expect(points(ticket)).toBe(240 + 300)
  })

  it("prices an offer on a branch by the line's branch, beneath it included", () => {
    const ticket = ticketOf(
      [
        lineFromCatalogueItem(item("single", 1000, "branch_singles")),
        lineFromCatalogueItem(item("cart", 1000, "branch_retro")),
        lineFromCatalogueItem(item("loose", 1000)),
      ],
      customer()
    )
    expect(points(ticket)).toBe(200 + 100 + 100)
    // Before the tree has been read the till prices it as the plain rate.
    expect(pointsPreview(ticket, summarise(ticket), SETUP, 0)).toBe(300)
  })

  it("prices a product offer, and nothing on a deposit", () => {
    const ticket = ticketOf(
      [
        lineFromProduct(product("product_table", "service", 500), { key: "p1" }),
        lineFromProduct({ ...product("product_deposit", "deposit", 0), open_price: true }, { key: "p2", price: 2000 }),
      ],
      customer()
    )
    expect(points(ticket)).toBe(50 + 150)
  })

  it("keeps a paid-plan offer for a paid-plan member", () => {
    const sleeves = [lineFromCatalogueItem(item("item_sleeves", 1000))]
    expect(points(ticketOf(sleeves, customer()))).toBe(100)
    expect(points(ticketOf(sleeves, customer({ paidMember: true })))).toBe(300)
  })
})
