import { describe, expect, it } from "vitest"

import {
  CARD_UPLOADER_MAPPING,
  EBAY_ORDERS_MAPPING,
  classifyCardUploaderRow,
  classifyEbayOrderRow,
  mapRows,
  parseCsv,
  resolveColumns,
} from "@/lib/api/csv-parse"

describe("reading a CSV", () => {
  it("splits plain rows on commas and line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(parseCsv("a,b\r1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("keeps a comma, a newline and a doubled quote inside a quoted field", () => {
    const table = parseCsv('Name,Note\r\n"Charizard ex, holo","He said ""hi""\nagain"\r\n')
    expect(table[1]).toEqual(["Charizard ex, holo", 'He said "hi"\nagain'])
  })

  it("drops a byte order mark and any blank line", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })
})

describe("resolving a mapping against a header row", () => {
  it("takes the first alias that is actually in the file", () => {
    const columns = resolveColumns(
      ["Title", "Set Name", "Card Number", "Price", "Custom Label"],
      CARD_UPLOADER_MAPPING
    )
    expect(columns.name).toBe(0)
    expect(columns.set).toBe(1)
    expect(columns.number).toBe(2)
    expect(columns.price).toBe(3)
    expect(columns.csSku).toBe(4)
    // Nothing in the file carries either id.
    expect(columns.tcgplayerId).toBe(-1)
  })

  it("ignores case and stray spaces in a heading", () => {
    const columns = resolveColumns([" card name ", "PRICE"], CARD_UPLOADER_MAPPING)
    expect(columns.name).toBe(0)
    expect(columns.price).toBe(1)
  })

  it("resolves nothing at all for a file of the wrong shape", () => {
    const columns = resolveColumns(["alpha", "beta"], CARD_UPLOADER_MAPPING)
    expect(Object.values(columns).every((at) => at === -1)).toBe(true)
  })
})

describe("mapping a whole file", () => {
  const file = [
    "Card Name,Set,Number,Price,TCGplayer ID,Custom Label",
    "Charizard ex,SV151,199,240.00,558123,CS-441820",
    "Mystery card,,,4.50,,CS-441821",
  ].join("\r\n")

  it("keys each row by field and records the line it came from", () => {
    const mapped = mapRows(file, CARD_UPLOADER_MAPPING)
    expect(mapped.fields).toEqual(["name", "set", "number", "price", "tcgplayerId", "csSku"])
    expect(mapped.rows).toHaveLength(2)
    expect(mapped.rows[0]).toMatchObject({
      name: "Charizard ex",
      set: "SV151",
      number: "199",
      price: "240.00",
      tcgplayerId: "558123",
      csSku: "CS-441820",
    })
    // The header is line 1, so the first row of data is line 2.
    expect(mapped.lines).toEqual([2, 3])
  })

  it("reads an eBay orders file through its own mapping", () => {
    const orders = [
      "Sales Record Number,Custom Label,Sold For,Sale Date",
      "17-12345-67890,CS-441820,24.00,2026-09-18",
    ].join("\n")
    const mapped = mapRows(orders, EBAY_ORDERS_MAPPING)
    expect(mapped.rows[0]).toMatchObject({
      orderNumber: "17-12345-67890",
      customLabel: "CS-441820",
      salePrice: "24.00",
      saleDate: "2026-09-18",
    })
  })
})

describe("what the Card Uploader importer will do with a row", () => {
  it("matches a row carrying a TCGplayer id", () => {
    expect(
      classifyCardUploaderRow({ name: "Charizard ex", price: "240.00", tcgplayerId: "558123" })
    ).toEqual({ kind: "matched", message: "Matches a card by id." })
  })

  it("matches a row carrying only a Cardmarket id", () => {
    expect(classifyCardUploaderRow({ price: "12", cardmarketId: "744120" }).kind).toBe(
      "matched"
    )
  })

  it("sends a name-only row to the review queue rather than guessing", () => {
    expect(classifyCardUploaderRow({ name: "Mystery card", price: "4.50" })).toEqual({
      kind: "review",
      message: "needs match",
    })
  })

  it("refuses a row with neither a name nor an id", () => {
    expect(classifyCardUploaderRow({ price: "4.50" })).toEqual({
      kind: "error",
      message: "No card name and no id on this row.",
    })
  })

  it("refuses a price that is not an amount, id or no id", () => {
    expect(classifyCardUploaderRow({ name: "Charizard ex", price: "ask" })).toEqual({
      kind: "error",
      message: "The price on this row is not an amount.",
    })
    expect(
      classifyCardUploaderRow({ tcgplayerId: "558123", price: "" }).kind
    ).toBe("error")
  })

  it("takes a price with a symbol, a comma or no pence", () => {
    expect(classifyCardUploaderRow({ name: "A card", price: "£1,240.00" }).kind).toBe(
      "review"
    )
    expect(classifyCardUploaderRow({ name: "A card", price: "12" }).kind).toBe("review")
  })
})

describe("what the eBay orders importer will do with a row", () => {
  it("matches a row with a custom label and a price", () => {
    expect(classifyEbayOrderRow({ customLabel: "CS-441820", salePrice: "24.00" })).toEqual({
      kind: "matched",
      message: "Matches CS-441820.",
    })
  })

  it("refuses a row with no custom label, since it matches no item", () => {
    expect(classifyEbayOrderRow({ salePrice: "24.00" })).toEqual({
      kind: "error",
      message: "No custom label on this row, so it matches no item.",
    })
  })

  it("refuses a sold price that is not an amount", () => {
    expect(classifyEbayOrderRow({ customLabel: "CS-1", salePrice: "free" }).kind).toBe(
      "error"
    )
  })
})

describe("a blank line in the middle of a file", () => {
  const file = [
    "Card Name,Price,TCGplayer ID",
    "Charizard ex,240.00,558123",
    "",
    "Pikachu VMAX,18.50,551900",
  ].join("\r\n")

  it("is skipped as a row but still counted as a line", () => {
    const mapped = mapRows(file, CARD_UPLOADER_MAPPING)
    expect(mapped.rows).toHaveLength(2)
    expect(mapped.rows[1]?.name).toBe("Pikachu VMAX")
    // The second card is on line 4 of the file, not line 3: the server's
    // own error entries name that line, so the preview has to agree.
    expect(mapped.lines).toEqual([2, 4])
  })

  it("keeps the blank line in the parse, so nothing renumbers", () => {
    expect(parseCsv(file)).toHaveLength(4)
    expect(parseCsv(file)[2]).toEqual([""])
  })

  it("still drops the phantom row a trailing newline leaves", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toHaveLength(2)
  })
})
