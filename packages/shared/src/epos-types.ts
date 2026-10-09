/**
 * The EPOS shapes the server produces and the counter renders
 * (docs/api-contract-epos.md). Types only: one source of truth for the
 * sale and refund receipt, the X and Z report and the tenders, so a receipt
 * printed from the Mac and one printed from the tablet read the same.
 *
 * Money is integer GBP pence throughout. Dates are ISO 8601 strings.
 */

/**
 * How a sale was paid, one row per tender (`sale_tenders.method`).
 * `sumup_card` exists only on sales taken before SumUp was removed.
 */
export const TENDER_METHODS = [
  "cash",
  "card_tide",
  "card_other",
  "store_credit",
  "points",
  "part_exchange",
  "gift_card",
  "sumup_card",
] as const
export type TenderMethod = (typeof TENDER_METHODS)[number]

/** What the till offers today. `card_other`, `gift_card` and `sumup_card` are for records only. */
export const TILL_TENDERS = ["cash", "card_tide", "store_credit", "points"] as const
export type TillTender = (typeof TILL_TENDERS)[number]

export const TENDER_LABELS: Record<TenderMethod, string> = {
  cash: "Cash",
  card_tide: "Card",
  card_other: "Card (other)",
  store_credit: "Store credit",
  points: "Points",
  part_exchange: "Part-exchange",
  gift_card: "Gift card",
  sumup_card: "Card (SumUp)",
}

/** A tender sent with a sale or a refund. */
export interface TenderInput {
  method: TillTender | "part_exchange"
  /** Pence put against the sale (or, on a refund, given back). Always positive here. */
  amount: number
  /** Cash only: what the customer handed over. Change is tendered minus amount. */
  tendered?: number
  /** Card only: the last four digits off the reader's slip or screen. */
  card_last4?: string
  /** Card only: the reader's authorisation code, when staff key it. */
  reference?: string
}

/** A stored tender row as the server returns it. Negative amounts are refunds or payouts. */
export interface Tender {
  method: TenderMethod
  label: string
  amount: number
  tendered: number
  change: number
  card_last4: string
  reference: string
}

/** UK notes and coins, in pence, largest first. Keys of a denomination count. */
export const DENOMINATIONS = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const
export type Denomination = (typeof DENOMINATIONS)[number]

/** A drawer count: how many of each denomination, keyed by the pence value as a string ("5000"). */
export type DenominationCounts = Partial<Record<`${Denomination}`, number>>

export interface VatLine {
  /** Percent, e.g. 20. */
  rate: number
  net: number
  vat: number
  gross: number
}

export interface ReceiptLine {
  title: string
  /** Set, number, condition, finish: one short line under the title. */
  detail: string
  sku: string
  qty: number
  unit_price: number
  /** Pence off this line (its share of a ticket discount included). */
  discount: number
  /** What the line comes to after discount. */
  total: number
  vat_rate: number
  tax_scheme: "margin" | "standard" | "exempt"
  /** On a part-exchange receipt, the trade lines carry a negative total. */
  kind: "sale" | "return" | "trade"
}

export interface ReceiptData {
  kind: "sale" | "refund"
  /** GG-S-000456, or for a refund the refund reference, e.g. GG-S-000456-R1. */
  number: string
  sale_id: string
  /** The number without dashes, for the barcode a return is scanned from. */
  barcode: string
  date: string
  register: string
  /** First name only. */
  staff: string
  shop: {
    name: string
    address_lines: string[]
    phone: string
    email: string
    /** Empty unless VAT registered. */
    vat_number: string
  }
  customer: null | {
    code: string
    first_name: string
    points_earned: number
    points_balance: number
    credit_balance: number
  }
  lines: ReceiptLine[]
  subtotal: number
  discount: number
  discount_label: string
  total: number
  /** Standard-rated lines only, and only when VAT registered. */
  vat: VatLine[]
  /** True when any line is margin scheme: the receipt then says VAT is not shown for those items. */
  margin_scheme: boolean
  tenders: Tender[]
  change: number
  refund: null | { of_number: string; reason: string }
  trade_in: null | { number: string; value: number; payout_cash: number; payout_credit: number }
  header: string
  footer: string
  returns_policy: string
  /** My Vault, for the QR at the foot. */
  portal_url: string
}

export interface TillReportTender {
  method: TenderMethod
  label: string
  taken: number
  refunded: number
  /** taken minus refunded */
  net: number
  count: number
}

export interface TillReport {
  id: string
  type: "x" | "z"
  number: number
  register: { id: string; name: string }
  session_id: string
  period_start: string
  period_end: string
  created: string
  created_by: { id: string; name: string }
  sales: {
    count: number
    /** Before discounts. */
    gross: number
    discounts: number
    /** gross minus discounts minus refunds */
    net: number
    average_basket: number
    vat: VatLine[]
  }
  refunds: { count: number; total: number }
  tenders: TillReportTender[]
  cash: {
    opening_float: number
    cash_sales: number
    cash_refunds: number
    paid_in: number
    paid_out: number
    buy_in_payouts: number
    bank_drops: number
    adjustments: number
    /** What should be in the drawer now. */
    expected: number
    /** Z only. */
    counted: number | null
    variance: number | null
  }
  card: {
    /** Card tenders the till recorded. */
    till_total: number
    /** Z only: the Tide total keyed in at cashing up. */
    reported_total: number | null
    variance: number | null
  }
  voids: { count: number; total: number }
  no_sales: { count: number }
  overrides: { count: number }
  discounts: { count: number; total: number }
  trade_ins: { count: number; cash_paid: number; credit_issued: number; part_exchange_value: number }
  by_category: { category: string; net: number; count: number }[]
  by_staff: { staff_id: string; name: string; net: number; count: number }[]
  first_sale_at: string | null
  last_sale_at: string | null
  /** Z only: the closing count by denomination. */
  counts: DenominationCounts | null
  notes: string
}

/** A refusal that a manager could approve. The till asks for a PIN and retries with the override. */
export interface NeedsOverride {
  message: string
  needs_override: true
  capability: import("./permissions").Capability
}

// ---------------------------------------------------------------------------
// Route shapes the counter reads (docs/api-contract-epos.md). One definition
// here so the till, the lock screen, cashing up and printing agree.
// ---------------------------------------------------------------------------

export interface NamedRef {
  id: string
  name: string
}

/** A browser registered as a till (`register_devices`). */
export interface TillDevice {
  id: string
  label: string
  register: string
  register_name: string
}

/** One name on the lock screen. */
export interface RosterEntry {
  id: string
  name: string
  initials: string
  role: import("./permissions").Role
  pin_set: boolean
  /** 4 or 6, 0 when no PIN is set. */
  pin_length: number
  pin_locked: boolean
}

export interface Roster {
  register: NamedRef
  staff: RosterEntry[]
}

/** `POST /api/vault/till/override`. */
export interface OverrideGrant {
  token: string
  capability: import("./permissions").Capability
  approver: NamedRef
  expires_at: string
}

/** An open cash session on a register. */
export interface TillSession {
  id: string
  register: NamedRef
  opened_at: string
  opened_by: NamedRef
  float: number
  opening_counts: DenominationCounts | null
}

/** `GET /api/vault/till/current`. `running` is an unsaved X report, null while closed. */
export interface TillCurrent {
  register: NamedRef
  session: TillSession | null
  running: TillReport | null
}

/** One row of `GET /api/vault/till/reports`. */
export interface TillReportSummary {
  id: string
  type: "x" | "z"
  number: number
  register_name: string
  created: string
  created_by_name: string
  net: number
  cash_variance: number | null
  card_variance: number | null
}

export type TillProductKind = "service" | "open_price" | "membership" | "deposit"

export interface TillCatalogueProduct {
  id: string
  name: string
  kind: TillProductKind
  price: number
  open_price: boolean
  image_url: string
  tax_scheme: "standard" | "margin" | "exempt"
}

export interface TillCatalogueItem {
  id: string
  sku: string
  title: string
  price: number
  qty: number
  image_url: string
  kind: string
  status: string
}

export interface TillKey {
  id: string
  position: number
  label: string
  product?: TillCatalogueProduct
  item?: TillCatalogueItem
}

export interface TillCategory {
  id: string
  name: string
  sort: number
  /** A dynamic category lists matching stock through the category items route. */
  dynamic: boolean
  keys: TillKey[]
}

/** `GET /api/vault/till/catalogue`. */
export interface TillCatalogue {
  categories: TillCategory[]
}

/** `GET /api/vault/sales/lookup`. */
export interface SaleLookupLine {
  id: string
  title: string
  detail: string
  sku: string
  qty: number
  refunded_qty: number
  unit_price: number
  discount: number
  net: number
  refundable_qty: number
  refundable_amount: number
  tax_scheme: "margin" | "standard" | "exempt"
}

export interface SaleLookup {
  id: string
  number: string
  occurred_at: string
  total: number
  status: string
  customer: { id: string; name: string; code: string } | null
  register_name: string
  staff_name: string
  lines: SaleLookupLine[]
  tenders: Tender[]
}

export type PrintJobKind =
  | "receipt"
  | "gift_receipt"
  | "refund_receipt"
  | "x_report"
  | "z_report"
  | "drawer"
  | "test"

export type PrintJobStatus = "queued" | "printing" | "done" | "failed" | "cancelled"

export interface PrintJob {
  id: string
  printer: string
  register: string
  kind: PrintJobKind
  ref: string
  status: PrintJobStatus
  attempts: number
  error: string
  created: string
  printed_at: string
}

export interface Printer {
  id: string
  name: string
  model: string
  mac: string
  register: string
  register_name: string
  /** 80 or 58 (mm). */
  paper_width: number
  active: boolean
  last_poll_at: string
  last_status: string
  /** Polled in the last 30 seconds. */
  online: boolean
}
