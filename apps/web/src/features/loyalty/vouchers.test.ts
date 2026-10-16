import { describe, expect, it } from "vitest"

import {
  MONEY_OFF_REFUSAL,
  isExpired,
  voucherActions,
  voucherStatusWord,
  voucherWorth,
} from "@/features/loyalty/vouchers"
import type { RewardType, VoucherDetail, VoucherStatus } from "@/lib/api/types"

const NOW = new Date("2026-09-20T12:00:00Z")

function voucher(
  type: RewardType,
  status: VoucherStatus = "issued",
  expiresAt: string | null = "2026-12-01T00:00:00Z"
): Pick<VoucherDetail, "type" | "status" | "expiresAt"> {
  return { type, status, expiresAt }
}

describe("voucherActions by type", () => {
  it("sends a money-off reward to the basket, and never marks it used here", () => {
    expect(voucherActions(voucher("money_off"), { admin: false, now: NOW })).toEqual({
      sell: true,
      markUsed: false,
      cancel: false,
      note: "",
    })
  })

  it("marks a free item, an event entry and a custom reward used at the counter", () => {
    for (const type of ["free_item", "event_entry", "custom"] as RewardType[]) {
      expect(voucherActions(voucher(type), { admin: false, now: NOW })).toMatchObject({
        sell: false,
        markUsed: true,
      })
    }
  })

  it("offers nothing on store credit, because it was paid out when it was redeemed", () => {
    expect(voucherActions(voucher("store_credit"), { admin: false, now: NOW })).toEqual({
      sell: false,
      markUsed: false,
      cancel: false,
      note: "The credit went on the account when this was redeemed. Nothing to do here.",
    })
  })

  it("offers the cancel only to an admin", () => {
    expect(
      voucherActions(voucher("free_item"), { admin: true, now: NOW }).cancel
    ).toBe(true)
    expect(
      voucherActions(voucher("free_item"), { admin: false, now: NOW }).cancel
    ).toBe(false)
    // Including on store credit, which is the only way those points come back.
    expect(
      voucherActions(voucher("store_credit"), { admin: true, now: NOW }).cancel
    ).toBe(true)
  })
})

describe("voucherActions by state", () => {
  it("does nothing with a voucher that is not open, and says why", () => {
    const used = voucherActions(voucher("free_item", "used"), { admin: true, now: NOW })
    expect(used).toEqual({
      sell: false,
      markUsed: false,
      cancel: false,
      note: "This voucher has already been used.",
    })

    expect(
      voucherActions(voucher("money_off", "expired"), { admin: true, now: NOW }).note
    ).toBe("This voucher has expired. The points are not coming back.")
    expect(
      voucherActions(voucher("money_off", "cancelled"), { admin: true, now: NOW }).note
    ).toBe("This voucher was cancelled and its points were returned.")
  })

  it("refuses one that is open but past its date", () => {
    expect(
      voucherActions(voucher("money_off", "issued", "2026-09-01T00:00:00Z"), {
        admin: true,
        now: NOW,
      })
    ).toEqual({
      sell: false,
      markUsed: false,
      cancel: false,
      note: "This voucher is past its expiry date.",
    })
  })

  it("leaves a voucher with no expiry date alone", () => {
    expect(isExpired({ expiresAt: null }, NOW)).toBe(false)
    expect(isExpired({ expiresAt: "not a date" }, NOW)).toBe(false)
    expect(isExpired({ expiresAt: "2026-09-19T00:00:00Z" }, NOW)).toBe(true)
  })
})

describe("voucherWorth", () => {
  it("is money for the two money types and words for the rest", () => {
    expect(voucherWorth("money_off", 500)).toBe("£5.00 off a sale")
    expect(voucherWorth("store_credit", 1000)).toBe("£10.00 of store credit")
    expect(voucherWorth("free_item", 0)).toBe("One free item")
    expect(voucherWorth("event_entry", 0)).toBe("One event entry")
    expect(voucherWorth("custom", 0)).toBe(
      "Ask the customer what they are claiming"
    )
  })
})

describe("voucherStatusWord", () => {
  it("is one word a customer would recognise", () => {
    expect(voucherStatusWord("issued")).toBe("Open")
    expect(voucherStatusWord("used")).toBe("Used")
    expect(voucherStatusWord("expired")).toBe("Expired")
    expect(voucherStatusWord("cancelled")).toBe("Cancelled")
  })
})

describe("the money-off refusal", () => {
  it("is the sentence the route uses, so the two agree", () => {
    expect(MONEY_OFF_REFUSAL).toBe("Use this one on the sale: scan it at Sell.")
  })
})
