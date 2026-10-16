/**
 * The demo counter's receipt printer, its jobs, and the sample receipt and
 * report it prints.
 *
 * Everything answers from memory for the tab, exactly like the rest of the
 * demo till: one printer, online, which "prints" a job the moment it is sent.
 * Nothing is persisted and nothing leaves the page. The sample receipt is
 * also what the browser print page shows in demo mode, so screenshots and
 * the end-to-end suite have something to look at.
 */
import type {
  NamedRef,
  Printer,
  PrintJob,
  ReceiptData,
  TillReport,
} from "@gg/shared"

import { DEMO_REGISTER, demoListRegisters } from "@/lib/api/demo/till-session"
import type { PrintJobInput, PrinterWithUrl, NewPrinter, PrintJobList } from "@/lib/api/printing"

const DEMO_MAC = "00:11:e5:06:04:ff"

function demoPrinter(): Printer {
  return {
    id: "printer_demo",
    name: "Counter printer",
    model: "Star TSP143IV",
    mac: DEMO_MAC,
    register: DEMO_REGISTER.id,
    register_name: DEMO_REGISTER.name,
    paper_width: 80,
    active: true,
    last_poll_at: new Date().toISOString(),
    last_status: "200 OK",
    online: true,
  }
}

const state: { printers: Printer[]; jobs: PrintJob[]; lastImage: Blob | null; serial: number } = {
  printers: [demoPrinter()],
  jobs: [],
  lastImage: null,
  serial: 0,
}

/** Back to one online printer and no jobs. Tests call it between cases. */
export function resetDemoPrinting(): void {
  state.printers = [demoPrinter()]
  state.jobs = []
  state.lastImage = null
  state.serial = 0
}

/** The jobs the demo printer has been sent, oldest first. */
export function demoPrintJobs(): PrintJob[] {
  return state.jobs.map((job) => ({ ...job }))
}

/** The last image sent to the demo printer, for the end-to-end suite to look at. */
export function demoLastImage(): Blob | null {
  return state.lastImage
}

/**
 * The demo printer is always on the network, so its poll is always just now.
 * One added in the demo has never been given its URL and stays "not seen
 * yet", the same as on the real server.
 */
function fresh(printer: Printer): Printer {
  return printer.active && printer.last_poll_at
    ? { ...printer, online: true, last_poll_at: new Date().toISOString() }
    : { ...printer }
}

export function listPrinters(): Printer[] {
  return state.printers.map(fresh)
}

/** The demo's switched-on registers, the same list Settings, Tills edits. */
export function listRegisters(): NamedRef[] {
  return demoListRegisters()
    .filter((row) => row.active)
    .map((row) => ({ id: row.id, name: row.name }))
}

function token(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}

function urlFor(secret: string): string {
  const origin =
    typeof window === "undefined" ? "https://ggpos.ggentertainment.co.uk" : window.location.origin
  return `${origin}/api/vault/cloudprnt/${secret}`
}

function normaliseMac(raw: string): string {
  const text = raw.trim().toLowerCase()
  if (!/^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/.test(text)) return ""
  const hex = text.replace(/[:-]/g, "")
  return hex.match(/.{2}/g)?.join(":") ?? ""
}

export function createPrinter(input: NewPrinter): PrinterWithUrl {
  const name = input.name.trim()
  if (!name) throw new Error("Give the printer a name, for example Counter printer.")
  const mac = normaliseMac(input.mac)
  if (!mac) throw new Error("Type the printer's MAC address, for example 00:11:e5:06:04:ff.")
  if (state.printers.some((printer) => printer.mac === mac)) {
    throw new Error(
      "A printer with that MAC address is already set up. Edit that one, or remove it first."
    )
  }
  const register = listRegisters().find((row) => row.id === input.register) ?? DEMO_REGISTER
  const printer: Printer = {
    id: `printer_demo_${state.serial + 1}`,
    name,
    model: input.model?.trim() ?? "",
    mac,
    register: register.id,
    register_name: register.name,
    paper_width: input.paper_width,
    active: true,
    // Never polled yet: the real server says the same until it hears from it.
    last_poll_at: "",
    last_status: "",
    online: false,
  }
  state.serial += 1
  state.printers = [...state.printers, printer]
  return { printer: { ...printer }, url: urlFor(token()) }
}

export function rotatePrinter(id: string): PrinterWithUrl {
  const printer = state.printers.find((row) => row.id === id)
  if (!printer) throw new Error("That printer was not found.")
  return { printer: fresh(printer), url: urlFor(token()) }
}

export function removePrinter(id: string): void {
  state.printers = state.printers.filter((row) => row.id !== id)
  state.jobs = state.jobs.filter((job) => job.printer !== id)
}

function newJob(printer: Printer, input: Pick<PrintJobInput, "kind" | "ref">): PrintJob {
  state.serial += 1
  const now = new Date().toISOString()
  const job: PrintJob = {
    id: `print_job_demo_${state.serial}`,
    printer: printer.id,
    register: printer.register,
    kind: input.kind,
    ref: input.ref ?? "",
    // The demo printer is on the counter and answers at once.
    status: "done",
    attempts: 1,
    error: "",
    created: now,
    printed_at: now,
  }
  state.jobs = [...state.jobs, job]
  return job
}

function printerFor(input: { printer?: string; register?: string }): Printer {
  const wanted = input.printer
    ? state.printers.find((row) => row.id === input.printer)
    : state.printers.find(
        (row) => row.active && (!input.register || row.register === input.register)
      )
  if (!wanted) {
    throw new Error(
      `No receipt printer is set up for ${DEMO_REGISTER.name}. Add one under Settings, Printers.`
    )
  }
  return wanted
}

export function sendPrintJob(input: PrintJobInput): PrintJob {
  const printer = printerFor(input)
  if (!input.image && !input.text) throw new Error("Add the receipt image or the text to print.")
  if (input.image) state.lastImage = input.image
  return { ...newJob(printer, input) }
}

export function sendDrawerKick(register?: string): PrintJob {
  const printer = printerFor({ register })
  return { ...newJob(printer, { kind: "drawer" }) }
}

export function listPrintJobs(filter: { register?: string; status?: string; page?: number }): PrintJobList {
  const rows = state.jobs
    .filter((job) => !filter.register || job.register === filter.register)
    .filter((job) => !filter.status || job.status === filter.status)
    .reverse()
  return { items: rows, page: filter.page ?? 1, per_page: 25, total: rows.length }
}

export function retryPrintJob(id: string): PrintJob {
  const job = state.jobs.find((row) => row.id === id)
  if (!job) throw new Error("That print job was not found.")
  throw new Error("That job already printed. Print the receipt again from the sale.")
}

// ---------------------------------------------------------------------------
// The sample receipt and report
// ---------------------------------------------------------------------------

const SHOP = {
  name: "GG Entertainment",
  address_lines: ["Market Place", "Bolsover, Chesterfield", "S44 6PN"],
  phone: "01246 000000",
  email: "hello@ggentertainment.co.uk",
  vat_number: "GB 123 4567 89",
}

const POLICY =
  "Items can be returned within 14 days with this receipt, in the condition they were sold. Singles and graded cards are exchanged only if faulty. This does not affect your statutory rights."

/**
 * A believable sale: a margin-scheme single, VAT-rated sleeves with a line
 * discount, a booster bundle, paid part cash and part card, with a Guild
 * member attached. Long enough to wrap, short enough to read.
 */
function sampleSale(saleId: string): ReceiptData {
  return {
    kind: "sale",
    number: "GG-S-000456",
    sale_id: saleId,
    barcode: "GGS000456",
    date: "2026-10-09T13:32:00.000Z",
    register: DEMO_REGISTER.name,
    staff: "Sam",
    shop: SHOP,
    customer: {
      code: "GGC7K2M9Q",
      first_name: "Alex",
      points_earned: 536,
      points_balance: 1776,
      credit_balance: 500,
    },
    lines: [
      {
        title: "Charizard ex",
        detail: "Obsidian Flames 125/197, Near Mint, holo",
        sku: "GGS3K9X2M",
        qty: 1,
        unit_price: 1250,
        discount: 0,
        total: 1250,
        vat_rate: 0,
        tax_scheme: "margin",
        kind: "sale",
      },
      {
        title: "Dragon Shield matte sleeves, Black, pack of 100",
        detail: "Accessory",
        sku: "GGA7P4D1R",
        qty: 2,
        unit_price: 899,
        discount: 180,
        total: 1618,
        vat_rate: 20,
        tax_scheme: "standard",
        kind: "sale",
      },
      {
        title: "Pokémon Scarlet & Violet 151 Booster Bundle",
        detail: "Sealed",
        sku: "GGX2N8B5T",
        qty: 1,
        unit_price: 2499,
        discount: 0,
        total: 2499,
        vat_rate: 20,
        tax_scheme: "standard",
        kind: "sale",
      },
    ],
    subtotal: 5547,
    discount: 180,
    discount_label: "Guild perk, 10% off sleeves",
    total: 5367,
    vat: [{ rate: 20, net: 3431, vat: 686, gross: 4117 }],
    margin_scheme: true,
    tenders: [
      {
        method: "cash",
        label: "Cash",
        amount: 3000,
        tendered: 4000,
        change: 1000,
        card_last4: "",
        reference: "",
      },
      {
        method: "card_tide",
        label: "Card",
        amount: 2367,
        tendered: 0,
        change: 0,
        card_last4: "4242",
        reference: "",
      },
    ],
    change: 1000,
    refund: null,
    trade_in: null,
    header: "Games, cards and collectables.",
    footer: "Thank you. See you soon.",
    returns_policy: POLICY,
    portal_url: "https://ggpos.ggentertainment.co.uk/account",
  }
}

/** The refund of the booster bundle, back to the card. */
function sampleRefund(saleId: string, refundRef: string): ReceiptData {
  const sale = sampleSale(saleId)
  return {
    ...sale,
    kind: "refund",
    number: refundRef,
    barcode: refundRef.replace(/-/g, ""),
    lines: [
      {
        title: "Pokémon Scarlet & Violet 151 Booster Bundle",
        detail: "Sealed",
        sku: "GGX2N8B5T",
        qty: 1,
        unit_price: 2499,
        discount: 0,
        total: -2499,
        vat_rate: 20,
        tax_scheme: "standard",
        kind: "return",
      },
    ],
    subtotal: -2499,
    discount: 0,
    discount_label: "",
    total: -2499,
    vat: [{ rate: 20, net: -2083, vat: -416, gross: -2499 }],
    margin_scheme: false,
    tenders: [
      {
        method: "card_tide",
        label: "Card",
        amount: -2499,
        tendered: 0,
        change: 0,
        card_last4: "4242",
        reference: "",
      },
    ],
    change: 0,
    refund: { of_number: sale.number, reason: "Wrong set" },
    customer: sale.customer ? { ...sale.customer, points_earned: -250, points_balance: 1526 } : null,
  }
}

export function getReceipt(input: {
  saleId: string
  gift?: boolean
  refundRef?: string
  reprint?: boolean
}): ReceiptData {
  return input.refundRef ? sampleRefund(input.saleId, input.refundRef) : sampleSale(input.saleId)
}

/** A closed day: a few pence over in the drawer and a little short on card. */
export function getTillReport(reportId: string): TillReport {
  const zed = !reportId.toLowerCase().startsWith("x")
  return {
    id: reportId,
    type: zed ? "z" : "x",
    number: zed ? 14 : 31,
    register: DEMO_REGISTER,
    session_id: "till_session_demo",
    period_start: "2026-10-09T08:02:00.000Z",
    period_end: "2026-10-09T16:45:00.000Z",
    created: "2026-10-09T16:47:00.000Z",
    created_by: { id: "staff_demo", name: "Sam Bell" },
    sales: {
      count: 23,
      gross: 61250,
      discounts: 1250,
      net: 58400,
      average_basket: 2539,
      vat: [{ rate: 20, net: 21000, vat: 4200, gross: 25200 }],
    },
    refunds: { count: 1, total: 1600 },
    tenders: [
      { method: "cash", label: "Cash", taken: 21000, refunded: 0, net: 21000, count: 10 },
      { method: "card_tide", label: "Card", taken: 39000, refunded: 1600, net: 37400, count: 13 },
    ],
    cash: {
      opening_float: 10000,
      cash_sales: 21000,
      cash_refunds: 0,
      paid_in: 0,
      paid_out: 1500,
      buy_in_payouts: 4000,
      bank_drops: 20000,
      adjustments: 0,
      expected: 5500,
      counted: zed ? 5740 : null,
      variance: zed ? 240 : null,
    },
    card: {
      till_total: 37400,
      reported_total: zed ? 37290 : null,
      variance: zed ? -110 : null,
    },
    voids: { count: 2, total: 1800 },
    no_sales: { count: 3 },
    overrides: { count: 1 },
    discounts: { count: 4, total: 1250 },
    trade_ins: { count: 3, cash_paid: 4000, credit_issued: 2500, part_exchange_value: 0 },
    by_category: [
      { category: "Singles", net: 31200, count: 9 },
      { category: "Sealed", net: 18900, count: 6 },
      { category: "Accessories", net: 6800, count: 7 },
      { category: "Services", net: 1500, count: 1 },
    ],
    by_staff: [
      { staff_id: "staff_demo", name: "Sam Bell", net: 36200, count: 14 },
      { staff_id: "staff_demo_2", name: "Alex Hart", net: 22200, count: 9 },
    ],
    first_sale_at: "2026-10-09T08:11:00.000Z",
    last_sale_at: "2026-10-09T16:38:00.000Z",
    counts: zed ? { "2000": 2, "1000": 1, "500": 3, "100": 5 } : null,
    notes: zed ? "Card is £1.10 short against the Tide app. Checked the slips, none missing." : "",
  }
}
