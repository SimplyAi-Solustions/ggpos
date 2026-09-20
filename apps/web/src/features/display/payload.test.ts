import { describe, expect, it } from "vitest"

import {
  buyInLine,
  buyInPayload,
  salePayload,
  saleLine,
  samePayload,
  shortName,
  scrubPayload,
} from "@/features/display/payload"

/**
 * The display faces the shop, so the promise this module makes is about
 * what does *not* reach it: a record id, a SKU, a phone number, an email
 * address or an ID document field. Every test that matters here is a test
 * that something was left behind.
 */
const EVERYTHING = {
  title: "Charizard ex",
  detail: "Scarlet & Violet 151 · 199/165",
  qty: 2,
  unit_price: 32499,
  offer_price: 18000,
  image_url: "https://images.example.co.uk/charizard.png",
  // None of the following is the customer-facing screen's business.
  id: "item_9f2",
  item: "item_9f2",
  sku: "GGS-7F3K2X",
  customer: "cust_demo_1",
  phone: "07700 900456",
  email: "jasmine@example.co.uk",
  id_ref_last4: "4821",
  dob: "1994-02-11",
  address: "12 Market Street, Bolsover",
  cost: 12000,
}

describe("saleLine", () => {
  it("copies the five things a line shows and nothing else", () => {
    expect(saleLine({
      title: EVERYTHING.title,
      detail: EVERYTHING.detail,
      qty: EVERYTHING.qty,
      unitPrice: EVERYTHING.unit_price,
      image: EVERYTHING.image_url,
    })).toEqual({
      title: "Charizard ex",
      detail: "Scarlet & Violet 151 · 199/165",
      qty: 2,
      unit_price: 32499,
      image_url: "https://images.example.co.uk/charizard.png",
    })
  })

  it("leaves the picture out rather than carrying an empty one", () => {
    const line = saleLine({ title: "Booster", qty: 1, unitPrice: 450 })
    expect("image_url" in line).toBe(false)
    expect(line.detail).toBe("")
  })

  it("holds money to whole pence and a quantity to at least one", () => {
    const line = saleLine({ title: "Lot", qty: 0, unitPrice: 1999.6 })
    expect(line.unit_price).toBe(2000)
    expect(line.qty).toBe(1)
  })

  it("never shows an empty title", () => {
    expect(saleLine({ title: "   ", qty: 1, unitPrice: 0 }).title).toBe("Item")
  })
})

describe("salePayload", () => {
  it("carries the totals, the discount label and the points", () => {
    expect(
      salePayload({
        lines: [{ title: "Booster", qty: 1, unitPrice: 450 }],
        subtotal: 450,
        discount: 50,
        discountLabel: "Regular 10% off",
        total: 400,
        pointsToEarn: 40,
        customerName: "Jasmine Cole",
      })
    ).toEqual({
      lines: [{ title: "Booster", detail: "", qty: 1, unit_price: 450 }],
      subtotal: 450,
      discount: 50,
      discount_label: "Regular 10% off",
      total: 400,
      points_to_earn: 40,
      customer_name: "Jasmine C.",
    })
  })

  it("leaves the customer and the discount label out when there are none", () => {
    const payload = salePayload({
      lines: [],
      subtotal: 0,
      discount: 0,
      total: 0,
      pointsToEarn: 0,
    })
    expect(payload).toEqual({
      lines: [],
      subtotal: 0,
      discount: 0,
      total: 0,
      points_to_earn: 0,
    })
  })

  it("never shows points as a negative", () => {
    const payload = salePayload({
      lines: [],
      subtotal: 0,
      discount: 0,
      total: 0,
      pointsToEarn: -40,
    })
    expect(payload.points_to_earn).toBe(0)
  })
})

describe("buyInPayload", () => {
  it("carries the offer, what it is paid as and the credit's points", () => {
    expect(
      buyInPayload({
        lines: [
          {
            title: EVERYTHING.title,
            detail: EVERYTHING.detail,
            qty: 1,
            offerPrice: EVERYTHING.offer_price,
            image: EVERYTHING.image_url,
          },
        ],
        totalMarket: 32499,
        totalOffer: 18000,
        payoutType: "credit",
        customerName: "Tom Whitfield",
        creditBonusPoints: 900,
      })
    ).toEqual({
      lines: [
        {
          title: "Charizard ex",
          detail: "Scarlet & Violet 151 · 199/165",
          qty: 1,
          offer_price: 18000,
          image_url: "https://images.example.co.uk/charizard.png",
        },
      ],
      total_market: 32499,
      total_offer: 18000,
      payout_type: "credit",
      customer_name: "Tom W.",
      credit_bonus_points: 900,
    })
  })

  it("leaves the bonus points out when the payout earns none", () => {
    const payload = buyInPayload({
      lines: [],
      totalMarket: 0,
      totalOffer: 0,
      payoutType: "cash",
      customerName: "",
    })
    expect("credit_bonus_points" in payload).toBe(false)
    expect(payload.customer_name).toBe("")
  })

  it("holds an offer line to whole pence", () => {
    expect(buyInLine({ title: "Lot", qty: 1, offerPrice: 2000.4 }).offer_price).toBe(
      2000
    )
  })
})

describe("shortName", () => {
  it("is a first name and a last initial at most", () => {
    expect(shortName("Jasmine Cole")).toBe("Jasmine C.")
    expect(shortName("  ruth  amelia  okafor ")).toBe("ruth O.")
    expect(shortName("Cher")).toBe("Cher")
    expect(shortName("")).toBe("")
    expect(shortName(undefined)).toBe("")
  })
})

describe("scrubPayload", () => {
  it("drops every field a line was built from but the five it shows", () => {
    const payload = scrubPayload("sale", {
      lines: [EVERYTHING],
      subtotal: 64998,
      discount: 0,
      total: 64998,
      points_to_earn: 650,
      ...EVERYTHING,
    })
    const text = JSON.stringify(payload)
    for (const secret of [
      "item_9f2",
      "GGS-7F3K2X",
      "cust_demo_1",
      "07700 900456",
      "jasmine@example.co.uk",
      "4821",
      "1994-02-11",
      "Market Street",
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(Object.keys(payload).sort()).toEqual([
      "discount",
      "lines",
      "points_to_earn",
      "subtotal",
      "total",
    ])
    expect(Object.keys((payload as { lines: object[] }).lines[0]).sort()).toEqual([
      "detail",
      "image_url",
      "qty",
      "title",
      "unit_price",
    ])
  })

  it("does the same to a buy-in payload", () => {
    const payload = scrubPayload("buy_in", {
      lines: [EVERYTHING],
      total_market: 32499,
      total_offer: 18000,
      payout_type: "credit",
      customer_name: "Tom Whitfield",
      ...EVERYTHING,
    })
    expect(JSON.stringify(payload)).not.toContain("jasmine@example.co.uk")
    expect(Object.keys(payload).sort()).toEqual([
      "customer_name",
      "lines",
      "payout_type",
      "total_market",
      "total_offer",
    ])
  })

  it("makes an idle screen out of anything at all", () => {
    expect(scrubPayload("idle", EVERYTHING)).toEqual({})
    expect(scrubPayload("sale", null)).toEqual({})
    expect(scrubPayload("sale", "a string")).toEqual({})
  })

  it("survives a payload with no lines in it", () => {
    expect(scrubPayload("sale", { total: 100 })).toEqual({
      lines: [],
      subtotal: 0,
      discount: 0,
      total: 100,
      points_to_earn: 0,
    })
  })
})

describe("samePayload", () => {
  it("is true only while nothing has changed", () => {
    const one = salePayload({
      lines: [{ title: "Booster", qty: 1, unitPrice: 450 }],
      subtotal: 450,
      discount: 0,
      total: 450,
      pointsToEarn: 45,
    })
    const two = salePayload({
      lines: [{ title: "Booster", qty: 1, unitPrice: 450 }],
      subtotal: 450,
      discount: 0,
      total: 450,
      pointsToEarn: 45,
    })
    expect(samePayload(one, two)).toBe(true)
    expect(samePayload(one, { ...two, total: 400 })).toBe(false)
    expect(samePayload(one, null)).toBe(false)
  })
})
