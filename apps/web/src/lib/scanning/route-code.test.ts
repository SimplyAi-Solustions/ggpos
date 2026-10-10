import { describe, expect, it } from "vitest"
import { buildCode } from "@gg/shared"

import {
  routeScannedCode,
  UNKNOWN_MESSAGE,
  VOUCHER_MESSAGE,
} from "@/lib/scanning/route-code"

const item = buildCode("single", "7F3K2")
const sealed = buildCode("sealed", "T4M9P")
const customer = buildCode("customer", "QW8RT")
const voucher = buildCode("voucher", "3N5VZ")

describe("routeScannedCode", () => {
  it("routes an item SKU to the item", () => {
    expect(routeScannedCode(item.encoded)).toEqual({
      kind: "item",
      sku: item.encoded,
      display: item.display,
      itemKind: "single",
    })
  })

  it("accepts the hyphenated form printed on the label", () => {
    expect(routeScannedCode(item.display)).toMatchObject({ kind: "item" })
  })

  it("accepts lower case and surrounding whitespace", () => {
    expect(routeScannedCode(`  ${item.display.toLowerCase()} `)).toMatchObject({
      kind: "item",
      sku: item.encoded,
    })
  })

  it("routes every item kind to the item, not only singles", () => {
    expect(routeScannedCode(sealed.encoded)).toMatchObject({
      kind: "item",
      itemKind: "sealed",
    })
  })

  it("routes a customer card to the customer", () => {
    expect(routeScannedCode(customer.encoded)).toEqual({
      kind: "customer",
      code: customer.encoded,
      display: customer.display,
    })
  })

  it("sends a voucher to the Sell screen with a reason", () => {
    expect(routeScannedCode(voucher.encoded)).toEqual({
      kind: "voucher",
      code: voucher.encoded,
      message: VOUCHER_MESSAGE,
    })
  })

  it.each(["12345678", "5060012345678", "12345678901234"])(
    "treats %s as a retail barcode",
    (digits) => {
      expect(routeScannedCode(digits)).toEqual({ kind: "ean", ean: digits })
    }
  )

  it("strips the separators a printed barcode carries", () => {
    expect(routeScannedCode("5-060012 345678")).toEqual({
      kind: "ean",
      ean: "5060012345678",
    })
  })

  it.each(["1234567", "123456789012345"])(
    "does not mistake %s for a barcode",
    (digits) => {
      expect(routeScannedCode(digits)).toEqual({
        kind: "unknown",
        message: UNKNOWN_MESSAGE,
      })
    }
  )

  it("rejects a GG code whose check character is wrong", () => {
    const broken = item.encoded.slice(0, -1) + (item.check === "0" ? "1" : "0")
    expect(routeScannedCode(broken)).toEqual({
      kind: "unknown",
      message: UNKNOWN_MESSAGE,
    })
  })

  it.each(["", "   ", "hello", "GG", "GGZ7F3K2Q"])(
    "says what to do next for %j",
    (input) => {
      expect(routeScannedCode(input)).toEqual({
        kind: "unknown",
        message: UNKNOWN_MESSAGE,
      })
    }
  )
})
