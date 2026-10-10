/**
 * The sale receipt, the gift receipt, the refund receipt and the test print,
 * as a list of draw operations (docs/api-contract-epos.md, section 6, "The
 * renderer"; DESIGN.md section 10, "Receipts").
 *
 * Black on white and nothing else: thermal paper has one colour, so there is
 * no grey, no volt and no grain here. The shop name and the total are Anton,
 * labels and codes are Space Mono, and every line a person reads is Jost.
 * Money is always Jost, never mono, exactly as on screen.
 *
 * Pure: it takes the data and a `Measure` and returns positions. The canvas
 * painter in `paint.ts` is what turns them into dots.
 */
import { formatGBP, TENDER_LABELS } from "@gg/shared"
import type { ReceiptData, Tender } from "@gg/shared"

import {
  createPage,
  displaySize,
  FACE,
  type Layout,
  type Measure,
  type Page,
  type PaperWidth,
} from "./draw"

export const MARGIN_SCHEME_NOTE =
  "VAT is not shown on second-hand goods sold under the margin scheme."

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** "9 Oct 2026, 14:32" in shop time, whatever the browser's own zone is. */
export function formatDateTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    DATE_FORMAT.formatToParts(at).find((entry) => entry.type === type)?.value ?? ""
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}`
}

/** Pence taken off, written as a negative amount: "-£1.00". */
function off(pence: number): string {
  return formatGBP(-Math.abs(pence))
}

/** What the tender row says: the card's last four for a card, the method otherwise. */
export function tenderLabel(tender: Tender): string {
  if (tender.card_last4) return `Card ending ${tender.card_last4}`
  return tender.label || TENDER_LABELS[tender.method]
}

/** The shop's name, address and contact lines, centred at the top. */
function shopBlock(page: Page, receipt: ReceiptData) {
  const w = page.width
  page.wrap(receipt.shop.name.toUpperCase(), FACE.display(displaySize(56, w)), "center")
  page.gap(6)
  for (const line of receipt.shop.address_lines) {
    page.wrap(line, FACE.sans(22), "center")
  }
  if (receipt.shop.phone) page.wrap(receipt.shop.phone, FACE.sans(22), "center")
  if (receipt.shop.email) page.wrap(receipt.shop.email, FACE.sans(22), "center")
  if (receipt.shop.vat_number) {
    page.gap(4)
    page.wrap(`VAT ${receipt.shop.vat_number}`, FACE.mono(20), "center")
  }
  if (receipt.header.trim()) {
    page.gap(8)
    page.wrap(receipt.header.trim(), FACE.sans(22), "center")
  }
}

/** The barcode of the receipt number and the My Vault QR at the foot. */
function footBlock(page: Page, receipt: ReceiptData) {
  const w = page.width
  page.gap(18)
  page.barcode(receipt.barcode || receipt.number.replace(/-/g, ""), 84)
  page.gap(4)
  page.line(receipt.number, FACE.mono(20), "center")
  if (receipt.portal_url) {
    page.gap(16)
    page.qr(receipt.portal_url, w === 576 ? 190 : 160)
    page.gap(4)
    page.line("MY VAULT", FACE.monoBold(19, 3), "center")
    page.wrap("Scan to see your points and trade-ins.", FACE.sans(20), "center")
  }
}

/** The VAT table for standard-rated lines: rate, net, VAT, gross. */
function vatTable(page: Page, receipt: ReceiptData) {
  const label = FACE.monoBold(18, 2)
  const cell = FACE.sans(21)
  const w = page.width
  const rate = page.pad + 58
  const step = (w - page.pad - rate) / 3
  const rights = [rate, rate + step, rate + step * 2, rate + step * 3].map(Math.round)
  const [rRate = 0, rNet = 0, rVat = 0, rGross = 0] = rights

  page.gap(8)
  page.columns(
    [
      { text: "RATE", right: rRate },
      { text: "NET", right: rNet },
      { text: "VAT", right: rVat },
      { text: "GROSS", right: rGross },
    ],
    label
  )
  for (const row of receipt.vat) {
    page.columns(
      [
        { text: `${row.rate}%`, right: rRate },
        { text: formatGBP(row.net), right: rNet },
        { text: formatGBP(row.vat), right: rVat },
        { text: formatGBP(row.gross), right: rGross },
      ],
      cell
    )
  }
}

/**
 * The receipt's own lines: a sale's items, or everything a refund gave back.
 * A gift receipt keeps the words and drops every price. On a sale taken with
 * an exchange or a part-exchange, the lines brought back and traded in are
 * not the sale's: they print after the tenders they paid, under their own
 * headings (broughtBack, tradeInBlock).
 */
function lineItems(page: Page, receipt: ReceiptData, gift: boolean) {
  const title = FACE.sansMedium(26)
  const small = FACE.sans(21)
  const refund = receipt.kind === "refund"
  for (const line of receipt.lines) {
    if (!refund && line.kind !== "sale") continue
    const tag = refund ? "Returned. " : ""
    if (gift) {
      page.row(line.title, line.qty !== 1 ? `x${line.qty}` : "", title)
      const detail = `${tag}${line.detail}`.trim()
      if (detail) page.wrap(detail, small)
    } else {
      page.row(line.title, formatGBP(line.total), title)
      const detail = `${tag}${line.detail}`.trim()
      if (detail) page.wrap(detail, small)
      if (line.qty !== 1) page.line(`${line.qty} x ${formatGBP(line.unit_price)}`, small)
      if (line.discount > 0) page.row("Discount", off(line.discount), small)
    }
    page.gap(8)
  }
}

/** Subtotal, discount and the total, which is the receipt's one big figure. */
function totals(page: Page, receipt: ReceiptData) {
  const body = FACE.sans(24)
  page.rule()
  if (receipt.discount !== 0) {
    page.row("Subtotal", formatGBP(receipt.subtotal), body)
    page.row(receipt.discount_label.trim() || "Discount", off(receipt.discount), body)
  }
  page.row(
    "TOTAL",
    formatGBP(receipt.total),
    FACE.monoBold(24, 3),
    FACE.display(displaySize(54, page.width))
  )
  if (receipt.vat.length > 0) vatTable(page, receipt)
  if (receipt.margin_scheme) {
    page.gap(8)
    page.wrap(MARGIN_SCHEME_NOTE, FACE.sans(20))
  }
}

/** What was paid with, the change, and on a refund what was given back and how. */
function tenders(page: Page, receipt: ReceiptData) {
  const body = FACE.sans(24)
  const small = FACE.sans(21)
  page.rule()
  page.line(receipt.kind === "refund" ? "REFUNDED TO" : "PAID BY", FACE.monoBold(19, 3))
  page.gap(2)
  for (const tender of receipt.tenders) {
    page.row(tenderLabel(tender), formatGBP(tender.amount), body)
  }
  if (receipt.kind !== "refund") {
    // What the customer handed over for the cash part, then the change from it.
    const handed = receipt.tenders
      .filter((tender) => tender.method === "cash" && tender.tendered > tender.amount)
      .reduce((sum, tender) => sum + tender.tendered, 0)
    if (handed > 0) page.row("Cash handed over", formatGBP(handed), small)
    if (receipt.change > 0) page.row("Change", formatGBP(receipt.change), FACE.sansMedium(24))
  }
}

/** The customer's code, what this receipt earned and where they stand. */
function customerBlock(page: Page, receipt: ReceiptData) {
  const customer = receipt.customer
  if (!customer) return
  const body = FACE.sans(23)
  page.rule()
  page.line("GG GUILD", FACE.monoBold(19, 3))
  page.gap(2)
  page.row(customer.first_name || "Customer", customer.code, body, FACE.mono(21))
  const earned = customer.points_earned
  page.row("Points earned", `${earned > 0 ? "+" : ""}${earned.toLocaleString("en-GB")}`, body)
  page.row("Points balance", customer.points_balance.toLocaleString("en-GB"), body)
  if (customer.credit_balance > 0) {
    page.row("Store credit", formatGBP(customer.credit_balance), body)
  }
}

/** Lines of another kind on a sale's receipt, title and figure, detail under. */
function otherLines(page: Page, lines: ReceiptData["lines"]) {
  const title = FACE.sans(23)
  const small = FACE.sans(21)
  for (const line of lines) {
    page.row(line.title, formatGBP(line.total), title)
    if (line.detail.trim()) page.wrap(line.detail.trim(), small)
    if (line.qty !== 1) page.line(`${line.qty} x ${formatGBP(line.unit_price)}`, small)
  }
}

/** An exchange: the goods brought back, whose value is the Exchange tender above. */
function broughtBack(page: Page, receipt: ReceiptData) {
  if (receipt.kind === "refund") return
  const lines = receipt.lines.filter((line) => line.kind === "return")
  if (lines.length === 0) return
  page.rule()
  page.line("BROUGHT BACK", FACE.monoBold(19, 3))
  page.gap(2)
  otherLines(page, lines)
}

/** A part-exchange: what was traded in, what it came to, and how it was paid. */
function tradeInBlock(page: Page, receipt: ReceiptData) {
  const trade = receipt.trade_in
  if (!trade || receipt.kind === "refund") return
  const body = FACE.sans(23)
  page.rule()
  page.line("PART-EXCHANGE", FACE.monoBold(19, 3))
  page.gap(2)
  otherLines(
    page,
    receipt.lines.filter((line) => line.kind === "trade")
  )
  page.gap(4)
  page.row(`Trade-in ${trade.number}`, formatGBP(trade.value), FACE.sansMedium(23))
  if (trade.applied > 0) page.row("Towards this sale", formatGBP(trade.applied), body)
  if (trade.payout_cash > 0) page.row("Paid out in cash", formatGBP(trade.payout_cash), body)
  if (trade.payout_credit > 0) page.row("Added as store credit", formatGBP(trade.payout_credit), body)
}

export interface ReceiptLayoutOptions {
  width: PaperWidth
  /** Words and quantities only: no price, total, tender or customer. */
  gift?: boolean
  measure: Measure
}

export function layoutReceipt(receipt: ReceiptData, opts: ReceiptLayoutOptions): Layout {
  const page = createPage(opts.width, opts.measure)
  const gift = opts.gift === true
  const refund = receipt.kind === "refund"

  page.gap(20)
  shopBlock(page, receipt)
  page.gap(6)
  page.rule()

  if (refund) {
    page.gap(4)
    page.line("REFUND", FACE.monoBold(30, 4), "center")
    page.gap(4)
  } else if (gift) {
    page.gap(4)
    page.line("GIFT RECEIPT", FACE.monoBold(28, 4), "center")
    page.gap(4)
  }

  page.row("RECEIPT", receipt.number, FACE.monoBold(20, 3), FACE.mono(22))
  if (refund && receipt.refund) {
    page.row("ORIGINAL", receipt.refund.of_number, FACE.monoBold(20, 3), FACE.mono(22))
  }
  page.row(formatDateTime(receipt.date), "", FACE.mono(20))
  page.row(
    receipt.register,
    receipt.staff ? `Served by ${receipt.staff}` : "",
    FACE.sans(22)
  )
  page.rule()
  page.gap(6)

  lineItems(page, receipt, gift)

  if (!gift) {
    totals(page, receipt)
    tenders(page, receipt)
    broughtBack(page, receipt)
    tradeInBlock(page, receipt)
    customerBlock(page, receipt)
  }

  if (receipt.returns_policy.trim()) {
    page.rule()
    page.wrap(receipt.returns_policy.trim(), FACE.sans(19), "center")
  }
  if (receipt.footer.trim()) {
    page.gap(8)
    page.wrap(receipt.footer.trim(), FACE.sans(22), "center")
  }
  footBlock(page, receipt)
  return page.finish(44)
}

export interface TestReceiptOptions {
  width: PaperWidth
  measure: Measure
  printerName: string
  now: Date
  /** What the QR carries; the app's own address. */
  qrValue: string
}

/**
 * The short test print on Settings, Printers. It uses every face and both
 * codes, so a printer that prints it cleanly will print a receipt.
 */
export function layoutTestReceipt(opts: TestReceiptOptions): Layout {
  const page = createPage(opts.width, opts.measure)
  const mm = opts.width === 576 ? 80 : 58

  page.gap(20)
  page.wrap("TEST PRINT", FACE.display(displaySize(56, opts.width)), "center")
  page.gap(4)
  page.wrap(opts.printerName, FACE.sans(26), "center")
  page.gap(6)
  page.rule()
  page.row("PAPER", `${mm} mm, ${opts.width} dots`, FACE.monoBold(19, 3), FACE.mono(21))
  page.row("PRINTED", formatDateTime(opts.now.toISOString()), FACE.monoBold(19, 3), FACE.mono(21))
  page.rule()
  page.gap(6)
  page.wrap(
    "If you can read this, the printer is set up and collecting jobs from GG Vault.",
    FACE.sans(24),
    "center"
  )
  page.gap(18)
  page.barcode("GGTEST", 84)
  page.gap(4)
  page.line("GG-TEST", FACE.mono(20), "center")
  if (opts.qrValue) {
    page.gap(16)
    page.qr(opts.qrValue, opts.width === 576 ? 190 : 160)
    page.gap(4)
    page.line("MY VAULT", FACE.monoBold(19, 3), "center")
  }
  return page.finish(44)
}
