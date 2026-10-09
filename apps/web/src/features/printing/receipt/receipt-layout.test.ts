import { describe, expect, it } from "vitest"
import type { ReceiptData } from "@gg/shared"

import { getReceipt } from "@/lib/api/demo/printing"

import type { DrawOp, FontSpec, Layout, Measure, TextOp } from "./draw"
import {
  formatDateTime,
  layoutReceipt,
  layoutTestReceipt,
  MARGIN_SCHEME_NOTE,
  tenderLabel,
} from "./receipt-layout"

/** Half the font size a character, plus its tracking. */
const measure: Measure = (text: string, font: FontSpec) =>
  Array.from(text).length * (font.size * 0.5 + (font.tracking ?? 0))

const sale = (): ReceiptData => getReceipt({ saleId: "sale_1" })

function textOps(layout: Layout): TextOp[] {
  return layout.ops.filter((op): op is TextOp => op.kind === "text")
}

function lines(layout: Layout): string[] {
  return textOps(layout).map((op) => op.text)
}

function has(layout: Layout, needle: string): boolean {
  return lines(layout).some((line) => line.includes(needle))
}

function find(layout: Layout, text: string): TextOp {
  const op = textOps(layout).find((entry) => entry.text === text)
  if (!op) throw new Error(`No text op says "${text}". It says: ${lines(layout).join(" | ")}`)
  return op
}

/** The first text op that starts with `start`, for a title the wrapping may have cut short. */
function findStarting(layout: Layout, start: string): TextOp {
  const op = textOps(layout).find((entry) => entry.text.startsWith(start))
  if (!op) throw new Error(`No text op starts "${start}". It says: ${lines(layout).join(" | ")}`)
  return op
}

function kinds(layout: Layout, kind: DrawOp["kind"]) {
  return layout.ops.filter((op) => op.kind === kind)
}

describe("a sale receipt", () => {
  const layout = layoutReceipt(sale(), { width: 576, measure })

  it("heads the page with the shop name in Anton, centred, then the address and contact lines", () => {
    const name = find(layout, "GG ENTERTAINMENT")
    expect(name.font.family).toBe("Anton")
    expect(name.align).toBe("center")
    expect(name.x).toBe(288)
    for (const line of ["Market Place", "S44 6PN", "01246 000000", "hello@ggentertainment.co.uk"]) {
      expect(find(layout, line).align).toBe("center")
    }
  })

  it("shows the VAT number in Space Mono only when there is one", () => {
    expect(find(layout, "VAT GB 123 4567 89").font.family).toBe("Space Mono")
    const none = sale()
    none.shop.vat_number = ""
    expect(has(layoutReceipt(none, { width: 576, measure }), "VAT GB")).toBe(false)
  })

  it("puts the receipt number in Space Mono, flush right, with the date, register and staff first name", () => {
    const number = find(layout, "GG-S-000456")
    expect(number.font.family).toBe("Space Mono")
    expect(number.align).toBe("right")
    expect(find(layout, "9 Oct 2026, 14:32").font.family).toBe("Space Mono")
    expect(find(layout, "Counter")).toBeDefined()
    expect(find(layout, "Served by Sam").align).toBe("right")
  })

  it("sets each line's title in Jost and its total flush right on the title's own baseline", () => {
    const title = find(layout, "Charizard ex")
    const total = find(layout, "£12.50")
    expect(title.font.family).toBe("Jost Variable")
    expect(total.align).toBe("right")
    expect(total.x).toBe(576 - 14)
    expect(total.y).toBe(title.y)
  })

  it("wraps a long title to the room beside its total and keeps the total on the first line", () => {
    const first = find(layout, "£16.18")
    const parts = textOps(layout).filter((op) => op.align === "left" && op.y >= first.y)
    const wrapped = parts.filter((op) => op.font.size === 26).slice(0, 2)
    expect(wrapped).toHaveLength(2)
    expect(wrapped[0]?.y).toBe(first.y)
    expect(wrapped[1]?.y).toBeGreaterThan(first.y)
    for (const part of wrapped) {
      expect(measure(part.text, part.font)).toBeLessThanOrEqual(548 - measure("£16.18", part.font) - 24)
    }
  })

  it("says quantity times unit price for a line of more than one", () => {
    expect(has(layout, "2 x £8.99")).toBe(true)
    // A single is not repeated as "1 x".
    expect(has(layout, "1 x")).toBe(false)
  })

  it("puts a discount line directly under the line it discounts", () => {
    const discount = find(layout, "Discount")
    const quantity = find(layout, "2 x £8.99")
    expect(discount.y).toBeGreaterThan(quantity.y)
    // And before the next line's title.
    expect(discount.y).toBeLessThan(findStarting(layout, "Pokémon").y)
    expect(find(layout, "-£1.80").align).toBe("right")
  })

  it("shows the subtotal and the discount only when something was taken off", () => {
    expect(has(layout, "Subtotal")).toBe(true)
    expect(has(layout, "Guild perk, 10% off sleeves")).toBe(true)
    const plain = sale()
    plain.discount = 0
    plain.discount_label = ""
    const without = layoutReceipt(plain, { width: 576, measure })
    expect(has(without, "Subtotal")).toBe(false)
  })

  it("sets the total in Anton, flush right, on the same baseline as its label", () => {
    const total = find(layout, "£53.67")
    const label = find(layout, "TOTAL")
    expect(total.font.family).toBe("Anton")
    expect(total.align).toBe("right")
    expect(label.font.family).toBe("Space Mono")
    expect(label.y).toBe(total.y)
    // It is the only Anton line below the shop name.
    const anton = textOps(layout).filter((op) => op.font.family === "Anton")
    expect(anton.map((op) => op.text)).toEqual(["GG ENTERTAINMENT", "£53.67"])
  })

  it("prints the VAT table for standard-rated lines and the margin note when a line is margin scheme", () => {
    expect(has(layout, "RATE")).toBe(true)
    expect(has(layout, "20%")).toBe(true)
    expect(has(layout, "£34.31")).toBe(true)
    expect(has(layout, "£6.86")).toBe(true)
    expect(has(layout, "£41.17")).toBe(true)
    expect(lines(layout).join(" ")).toContain("VAT is not shown on second-hand goods")

    const none = sale()
    none.vat = []
    none.margin_scheme = false
    const plain = layoutReceipt(none, { width: 576, measure })
    expect(has(plain, "RATE")).toBe(false)
    expect(lines(plain).join(" ")).not.toContain("margin scheme")
  })

  it("keeps the margin-scheme sentence word for word", () => {
    expect(MARGIN_SCHEME_NOTE).toBe(
      "VAT is not shown on second-hand goods sold under the margin scheme."
    )
  })

  it("lists the tenders, naming the card's last four, and shows what was handed over and the change", () => {
    expect(has(layout, "PAID BY")).toBe(true)
    expect(find(layout, "Cash").align).toBe("left")
    expect(find(layout, "£30.00").align).toBe("right")
    expect(find(layout, "Card ending 4242")).toBeDefined()
    expect(find(layout, "£23.67").align).toBe("right")
    expect(find(layout, "Cash handed over")).toBeDefined()
    expect(find(layout, "£40.00")).toBeDefined()
    expect(find(layout, "Change")).toBeDefined()
    expect(find(layout, "£10.00")).toBeDefined()
  })

  it("shows the customer's code, the points this earned and the balance", () => {
    expect(find(layout, "GGC7K2M9Q").font.family).toBe("Space Mono")
    expect(find(layout, "+536")).toBeDefined()
    expect(find(layout, "1,776")).toBeDefined()
    expect(find(layout, "£5.00")).toBeDefined()
  })

  it("has no customer block for a sale with no customer", () => {
    const guest = sale()
    guest.customer = null
    const out = layoutReceipt(guest, { width: 576, measure })
    expect(has(out, "GG GUILD")).toBe(false)
    expect(has(out, "Points earned")).toBe(false)
  })

  it("closes with the returns policy, the footer, the receipt number as a barcode and the My Vault QR", () => {
    expect(lines(layout).join(" ")).toContain("Items can be returned within 14 days")
    expect(has(layout, "Thank you. See you soon.")).toBe(true)
    const [barcode] = kinds(layout, "barcode")
    expect(barcode).toMatchObject({ kind: "barcode", value: "GGS000456" })
    const [qr] = kinds(layout, "qr")
    expect(qr).toMatchObject({ kind: "qr", value: "https://ggpos.ggentertainment.co.uk/account" })
    // The barcode comes before the QR, which is the last picture on the page.
    expect(barcode?.y).toBeLessThan(qr?.y ?? 0)
  })

  it("leaves the QR out when the receipt has no portal address", () => {
    const none = sale()
    none.portal_url = ""
    const out = layoutReceipt(none, { width: 576, measure })
    expect(kinds(out, "qr")).toHaveLength(0)
    expect(kinds(out, "barcode")).toHaveLength(1)
  })

  it("keeps every operation on the paper and the page tall enough for the last of them", () => {
    for (const width of [576, 384] as const) {
      const out = layoutReceipt(sale(), { width, measure })
      expect(out.width).toBe(width)
      for (const op of out.ops) {
        expect(op.x).toBeGreaterThanOrEqual(0)
        expect(op.x).toBeLessThanOrEqual(width)
        expect(op.y).toBeGreaterThanOrEqual(0)
        expect(op.y).toBeLessThan(out.height)
      }
      const last = out.ops.at(-1)
      expect((last?.y ?? 0) + (last && "size" in last ? last.size : 0)).toBeLessThanOrEqual(out.height)
    }
  })

  it("has no em-dash anywhere on the page", () => {
    for (const variant of [layout, layoutReceipt(sale(), { width: 576, measure, gift: true })]) {
      expect(lines(variant).join("\n")).not.toContain(String.fromCharCode(0x2014))
    }
  })
})

describe("on 58 mm paper", () => {
  const narrow = layoutReceipt(sale(), { width: 384, measure })

  it("puts values at the narrower right edge and the centre at the narrower middle", () => {
    expect(find(narrow, "GG ENTERTAINMENT").x).toBe(192)
    expect(find(narrow, "£12.50").x).toBe(384 - 10)
  })

  it("wraps more, since fewer characters fit", () => {
    const wide = layoutReceipt(sale(), { width: 576, measure })
    expect(textOps(narrow).length).toBeGreaterThan(textOps(wide).length)
  })

  it("brings the display sizes down but not the body text", () => {
    expect(find(narrow, "GG ENTERTAINMENT").font.size).toBeLessThan(
      find(layoutReceipt(sale(), { width: 576, measure }), "GG ENTERTAINMENT").font.size
    )
    expect(find(narrow, "Charizard ex").font.size).toBe(26)
  })
})

describe("a gift receipt", () => {
  const gift = layoutReceipt(sale(), { width: 576, measure, gift: true })

  it("is headed Gift receipt and keeps the words and the quantities", () => {
    expect(find(gift, "GIFT RECEIPT")).toBeDefined()
    expect(find(gift, "Charizard ex")).toBeDefined()
    expect(find(gift, "Obsidian Flames 125/197, Near Mint, holo")).toBeDefined()
    expect(find(gift, "x2")).toBeDefined()
  })

  it("drops every price, the totals, the VAT table and the tenders", () => {
    expect(lines(gift).some((line) => line.includes("£"))).toBe(false)
    for (const word of ["TOTAL", "Subtotal", "Discount", "PAID BY", "Change", "RATE", "margin scheme"]) {
      expect(has(gift, word)).toBe(false)
    }
    expect(textOps(gift).some((op) => op.font.family === "Anton" && op.text !== "GG ENTERTAINMENT")).toBe(
      false
    )
  })

  it("drops the customer, who is not the person holding the receipt", () => {
    for (const word of ["GG GUILD", "GGC7K2M9Q", "Points", "Store credit"]) {
      expect(has(gift, word)).toBe(false)
    }
  })

  it("keeps what a return needs: the number, the returns policy and the barcode", () => {
    expect(find(gift, "GG-S-000456")).toBeDefined()
    expect(lines(gift).join(" ")).toContain("Items can be returned")
    expect(kinds(gift, "barcode")).toHaveLength(1)
  })
})

describe("a refund receipt", () => {
  const refund = layoutReceipt(getReceipt({ saleId: "sale_1", refundRef: "GG-S-000456-R1" }), {
    width: 576,
    measure,
  })

  it("is headed Refund with the original receipt's number", () => {
    expect(find(refund, "REFUND")).toBeDefined()
    expect(find(refund, "GG-S-000456-R1")).toBeDefined()
    expect(find(refund, "ORIGINAL")).toBeDefined()
    expect(find(refund, "GG-S-000456")).toBeDefined()
  })

  it("shows what was given back as negative amounts and where it went", () => {
    expect(has(refund, "REFUNDED TO")).toBe(true)
    expect(find(refund, "Card ending 4242")).toBeDefined()
    expect(textOps(refund).filter((op) => op.text === "-£24.99").length).toBeGreaterThanOrEqual(2)
    expect(has(refund, "PAID BY")).toBe(false)
  })

  it("has no change or handed-over line, and says the line was returned", () => {
    expect(has(refund, "Change")).toBe(false)
    expect(has(refund, "Cash handed over")).toBe(false)
    expect(has(refund, "Returned.")).toBe(true)
  })

  it("barcodes the refund's own reference", () => {
    expect(kinds(refund, "barcode")[0]).toMatchObject({ value: "GGS000456R1" })
  })
})

describe("a part-exchange", () => {
  it("shows the trade-in's number, value and how the difference was paid", () => {
    const data = sale()
    data.trade_in = { number: "GG-BI-000123", value: 4000, payout_cash: 1000, payout_credit: 500 }
    const out = layoutReceipt(data, { width: 576, measure })
    expect(has(out, "PART-EXCHANGE")).toBe(true)
    expect(has(out, "Trade-in GG-BI-000123")).toBe(true)
    expect(find(out, "£40.00")).toBeDefined()
    expect(has(out, "Paid out in cash")).toBe(true)
    expect(has(out, "Added as store credit")).toBe(true)
  })
})

describe("the test print", () => {
  const out = layoutTestReceipt({
    width: 576,
    measure,
    printerName: "Counter printer",
    now: new Date("2026-10-09T15:26:00.000Z"),
    qrValue: "https://ggpos.ggentertainment.co.uk",
  })

  it("uses all three faces, a barcode and a QR, so a clean test means a clean receipt", () => {
    const families = new Set(textOps(out).map((op) => op.font.family))
    expect(families).toEqual(new Set(["Anton", "Space Mono", "Jost Variable"]))
    expect(kinds(out, "barcode")).toHaveLength(1)
    expect(kinds(out, "qr")).toHaveLength(1)
  })

  it("names the printer, its paper and the time in shop time", () => {
    expect(find(out, "Counter printer")).toBeDefined()
    expect(find(out, "80 mm, 576 dots")).toBeDefined()
    expect(find(out, "9 Oct 2026, 16:26")).toBeDefined()
  })

  it("says 58 mm and 384 dots on the narrow roll", () => {
    const narrow = layoutTestReceipt({
      width: 384,
      measure,
      printerName: "Back",
      now: new Date(),
      qrValue: "",
    })
    expect(find(narrow, "58 mm, 384 dots")).toBeDefined()
    expect(kinds(narrow, "qr")).toHaveLength(0)
  })
})

describe("small helpers", () => {
  it("formats a date in shop time whatever the browser's zone is", () => {
    // 13:32 UTC in October is 14:32 in Bolsover, and 13:32 in January.
    expect(formatDateTime("2026-10-09T13:32:00.000Z")).toBe("9 Oct 2026, 14:32")
    expect(formatDateTime("2026-01-09T13:32:00.000Z")).toBe("9 Jan 2026, 13:32")
  })

  it("returns an unreadable date as it came rather than the word Invalid", () => {
    expect(formatDateTime("not a date")).toBe("not a date")
  })

  it("labels a card by its last four and anything else by its method", () => {
    const base = {
      amount: 100,
      tendered: 0,
      change: 0,
      reference: "",
    }
    expect(tenderLabel({ ...base, method: "card_tide", label: "Card", card_last4: "4242" })).toBe(
      "Card ending 4242"
    )
    expect(tenderLabel({ ...base, method: "cash", label: "Cash", card_last4: "" })).toBe("Cash")
    expect(tenderLabel({ ...base, method: "store_credit", label: "", card_last4: "" })).toBe(
      "Store credit"
    )
  })
})
