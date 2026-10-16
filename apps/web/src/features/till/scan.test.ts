import { describe, expect, it } from "vitest"
import { buildCode } from "@gg/shared"

import { readTillScan, worthSearching } from "@/features/till/scan"

describe("what the till's field reads a code as", () => {
  it("reads a receipt's printed number and its barcode as the same sale", () => {
    expect(readTillScan("GG-S-000456")).toEqual({
      kind: "receipt",
      number: "GG-S-000456",
      alsoItem: null,
    })
    expect(readTillScan("ggs0004567")).toEqual({
      kind: "receipt",
      number: "GG-S-0004567",
      alsoItem: null,
    })
    expect(readTillScan("GG-S-000456-R1")).toMatchObject({ number: "GG-S-000456" })
  })

  it("marks a receipt barcode that is also a valid item code, to try the item first", () => {
    // A single's code made only of digits has the barcode's shape exactly.
    const sku = Array.from({ length: 100 }, (_, n) => buildCode("single", String(n).padStart(5, "0")))
      .find((code) => /^\d$/.test(code.check))
    expect(sku).toBeDefined()
    expect(readTillScan(sku!.encoded)).toEqual({
      kind: "receipt",
      number: `GG-S-${sku!.encoded.slice(3)}`,
      alsoItem: sku!.encoded,
    })
  })

  it("passes item, customer and voucher codes through as the counter reads them", () => {
    expect(readTillScan(buildCode("single", "7F3K2").display)).toMatchObject({ kind: "item" })
    expect(readTillScan(buildCode("customer", "4K7M2").display)).toMatchObject({ kind: "customer" })
    expect(readTillScan(buildCode("voucher", "3H7K9").display)).toMatchObject({ kind: "voucher" })
    expect(readTillScan("5012345678900")).toEqual({ kind: "ean", ean: "5012345678900" })
  })

  it("treats words as a search, and a misread code as a misread", () => {
    expect(readTillScan("booster pack")).toEqual({ kind: "search", query: "booster pack" })
    expect(readTillScan("GGS-7F3K2X").kind).toBe("unknown")
  })
})

describe("live search while typing", () => {
  it("searches words, not a code a scanner is halfway through", () => {
    expect(worthSearching("char")).toBe(true)
    expect(worthSearching("c")).toBe(false)
    expect(worthSearching("GGS-7F3")).toBe(false)
    expect(worthSearching("50123")).toBe(false)
    expect(worthSearching("gg sleeves")).toBe(true)
  })
})
