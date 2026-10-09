/**
 * Cashing up: the X and Z report and the drawer arithmetic behind them
 * (docs/api-contract-epos.md, section 3).
 *
 * `buildTillReport` is the one source of every figure on an X or a Z. The
 * server builds the report it saves from the session's own records with it
 * (pb/pb_hooks/lib/till.js, through the generated copy in
 * pb/pb_hooks/lib/shared/till.js), and the counter can preview one from the
 * same input, so the two cannot disagree. Pure: plain data in, a `TillReport`
 * out, nothing read from anywhere else.
 *
 * Money is integer GBP pence throughout.
 *
 * Signs. `cash_movements.amount` is stored signed: cash sales and paid in
 * positive; refunds, buy-in payouts, paid out and bank drops negative;
 * adjustments either way. The expected drawer is the float plus every
 * movement, exactly as `lib/vaultutil.js` `sessionExpected` adds it up. The
 * report's `cash` breakdown is the same movements grouped by type, with the
 * money-out groups shown as positive figures, so on every report
 *
 *   expected = opening_float + cash_sales - cash_refunds + paid_in - paid_out
 *              - buy_in_payouts - bank_drops + adjustments
 *
 * which is the contract's formula, and `adjustments` keeps its own sign.
 *
 * `sale_tenders.amount` is signed too: positive is taken, negative is given
 * back on a refund. A cash tender's amount is the cash kept, not what was
 * handed over, so change given never reaches the report.
 */
import { CATEGORY_PATH_SEPARATOR } from "./categories"
import { roundHalfUp } from "./money"
import { grossOf, spread } from "./saleline"
import {
  DENOMINATIONS,
  TENDER_LABELS,
  TENDER_METHODS,
  type DenominationCounts,
  type NamedRef,
  type TenderMethod,
  type TillReport,
  type TillReportTender,
  type VatLine,
} from "./epos-types"

// ---------------------------------------------------------------------------
// Drawer counts by denomination
// ---------------------------------------------------------------------------

/** The most of any one note or coin a count may hold. Anything above is a typing slip. */
export const MAX_DENOMINATION_COUNT = 100000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDenominationKey(key: string): boolean {
  return DENOMINATIONS.some((d) => String(d) === key)
}

/**
 * Whether a request carries a count at all: an object naming at least one
 * note or coin. `{}` is no count, so a client that sends an empty grid cannot
 * close the till on a drawer of nothing; an explicit `{ "5000": 0 }` is a
 * count of an empty drawer.
 */
export function hasCounts(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length > 0
}

export type CountsResult = { ok: true; counts: DenominationCounts } | { ok: false; message: string }

/**
 * A drawer count checked and copied clean: every key a UK note or coin in
 * pence, every value a whole number from 0 to `MAX_DENOMINATION_COUNT`. Zeros
 * are kept, since they are what was keyed. (Integer-like keys always list in
 * ascending order in JavaScript, so a reader that wants largest first walks
 * `DENOMINATIONS`, as `denominationTotal` does.)
 */
export function parseDenominationCounts(value: unknown): CountsResult {
  if (!isPlainObject(value)) {
    return { ok: false, message: "Count the drawer note by note and coin by coin." }
  }
  for (const key of Object.keys(value)) {
    if (!isDenominationKey(key)) {
      return { ok: false, message: "The count has a note or coin that is not UK money. Count the drawer again." }
    }
    const n = value[key]
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_DENOMINATION_COUNT) {
      return { ok: false, message: "Count each note and coin as a whole number, 0 or more." }
    }
  }
  const counts: DenominationCounts = {}
  for (const d of DENOMINATIONS) {
    const key = `${d}` as const
    if (Object.prototype.hasOwnProperty.call(value, key)) counts[key] = value[key] as number
  }
  return { ok: true, counts }
}

/** What a count comes to in pence. Keys that are not a note or coin count for nothing. */
export function denominationTotal(counts: DenominationCounts | null | undefined): number {
  if (!counts) return 0
  let total = 0
  for (const d of DENOMINATIONS) {
    const n = counts[`${d}`]
    if (typeof n === "number" && Number.isInteger(n) && n > 0) total += d * n
  }
  return total
}

// ---------------------------------------------------------------------------
// The drawer: movements, expected cash and the variances
// ---------------------------------------------------------------------------

/** One `cash_movements` row as the report reads it: its type and its signed amount. */
export interface DrawerMovement {
  type: string
  amount: number
}

/** What `POST /api/vault/till/movement` takes. */
export const TILL_MOVEMENT_TYPES = ["paid_in", "paid_out", "bank_drop", "adjustment"] as const
export type TillMovementType = (typeof TILL_MOVEMENT_TYPES)[number]

export function isTillMovementType(value: unknown): value is TillMovementType {
  return typeof value === "string" && (TILL_MOVEMENT_TYPES as readonly string[]).includes(value)
}

/**
 * The signed amount a till movement is stored with. Paid in is money in;
 * paid out and a bank drop are money out, whatever sign they arrive with; an
 * adjustment keeps the sign it was given.
 */
export function signedMovementAmount(type: TillMovementType, amount: number): number {
  if (type === "paid_out" || type === "bank_drop") return -Math.abs(amount)
  if (type === "paid_in") return Math.abs(amount)
  return amount
}

/** True when a movement would leave the drawer expected to hold less than nothing. */
export function takesDrawerBelowZero(expected: number, signedAmount: number): boolean {
  return signedAmount < 0 && expected + signedAmount < 0
}

/** The drawer's cash figures before a count: every field of `TillReport["cash"]` but the Z's two. */
export type CashBreakdown = Omit<TillReport["cash"], "counted" | "variance">

/**
 * The movements grouped by type. Every movement lands in exactly one group,
 * so the groups always add back up to `expected`. `float_in` (a top-up of the
 * float, from before the till) counts as paid in; any type the report does not
 * name counts as an adjustment.
 */
export function cashBreakdown(float: number, movements: DrawerMovement[]): CashBreakdown {
  let cashSales = 0
  let refunds = 0
  let paidIn = 0
  let paidOut = 0
  let payouts = 0
  let bankDrops = 0
  let adjustments = 0
  for (const m of movements) {
    const amount = m.amount
    switch (m.type) {
      case "cash_sale":
        cashSales += amount
        break
      case "refund":
        refunds -= amount
        break
      case "paid_in":
      case "float_in":
        paidIn += amount
        break
      case "paid_out":
        paidOut -= amount
        break
      case "payout":
        payouts -= amount
        break
      case "bank_drop":
        bankDrops -= amount
        break
      default:
        adjustments += amount
    }
  }
  return {
    opening_float: float,
    cash_sales: cashSales,
    cash_refunds: refunds,
    paid_in: paidIn,
    paid_out: paidOut,
    buy_in_payouts: payouts,
    bank_drops: bankDrops,
    adjustments: adjustments,
    expected: float + cashSales - refunds + paidIn - paidOut - payouts - bankDrops + adjustments,
  }
}

/** What the drawer should hold: the float plus every signed movement. */
export function expectedCash(float: number, movements: DrawerMovement[]): number {
  return cashBreakdown(float, movements).expected
}

/** Counted minus expected: positive is over, negative is short. */
export function cashVariance(counted: number, expected: number): number {
  return counted - expected
}

/** What Tide reported minus what the till recorded. Null when nothing was keyed. */
export function cardVariance(reported: number | null, tillTotal: number): number | null {
  return reported === null ? null : reported - tillTotal
}

// ---------------------------------------------------------------------------
// Labels and sentences
// ---------------------------------------------------------------------------

const KIND_CATEGORIES: Record<string, string> = {
  single: "Singles",
  graded: "Graded",
  retro: "Retro",
  sealed: "Sealed",
  accessory: "Accessories",
  other: "Other",
}

/**
 * An item kind named the way the shop says it ("Singles"). Since the category
 * tree a line sells under its branch (`branchLabel`), so the server no longer
 * labels a report line with this; it stays for the demo's X report and for
 * anything that only knows a kind.
 */
export function categoryForKind(kind: string | null | undefined): string {
  // An own-property check, so "constructor" and friends are not read off the prototype.
  if (kind && Object.prototype.hasOwnProperty.call(KIND_CATEGORIES, kind)) {
    return KIND_CATEGORIES[kind] as string
  }
  return "Other"
}

/** The label of a line with no branch on an X or a Z. */
export const NO_BRANCH_LABEL = "Other"

/**
 * The category a line sells under on an X or a Z
 * (docs/api-contract-inventory.md, section 1.4): the first two levels of its
 * home branch's path ("Trading cards / Pokémon", "Retro / Sega", "Services /
 * Table time"), a top-level branch alone when it has no second level
 * ("Trading cards"), and "Other" when the line has no branch at all.
 * `path` is the branch's stored path, "Trading cards / Pokémon / Singles".
 */
export function branchLabel(path: string | null | undefined): string {
  const names = (path ?? "")
    .split(CATEGORY_PATH_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name !== "")
  if (names.length === 0) return NO_BRANCH_LABEL
  return names.slice(0, 2).join(CATEGORY_PATH_SEPARATOR)
}

const SMALL_NUMBERS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]

/** The Z report's refusal while tickets are parked on the register. */
export function parkedTicketsMessage(count: number, registerName: string): string {
  const n = SMALL_NUMBERS[count] || String(count)
  if (count === 1) {
    return `One ticket is parked on ${registerName}. Complete or delete it before closing the till.`
  }
  return `${n} tickets are parked on ${registerName}. Complete or delete them before closing the till.`
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One `sale_lines` row, as sold. */
export interface TillReportSaleLine {
  qty: number
  unit_price: number
  /** The line's own discount, as sold. */
  discount: number
  /** Percent. */
  vat_rate: number
  /** VAT inside the line's net, as stored on the line. */
  vat_amount: number
  tax_scheme: string
  /** The line's `branchLabel`: the first two levels of its branch's path, or "Other". */
  category: string
}

/** One sale taken in the session. */
export interface TillReportSale {
  id: string
  /** ISO 8601. */
  occurred_at: string
  staff: NamedRef
  /** The ticket discount (`sales.discount`), spread across the lines pro rata. */
  discount: number
  /** In "created,id" order, the order the ticket discount's remainder is assigned in. */
  lines: TillReportSaleLine[]
}

/** One `sale_tenders` row whose `session` is this session: a sale's or a refund's. */
export interface TillReportTenderRow {
  method: TenderMethod
  /** Signed: positive taken, negative given back. */
  amount: number
  /** Empty for a sale; the refund's reference (GG-S-000456-R1) for a refund. */
  refund_ref: string
}

/**
 * One completed trade-in on the session, whatever it paid out. On a
 * part-exchange (docs/api-contract-epos.md, section 7) the two payouts are
 * the surplus alone.
 */
export interface TillReportTradeIn {
  payout_cash: number
  payout_credit: number
  /** What a part-exchange put against its sale (`trade_ins.part_exchange_value`); 0 for a buy-in. */
  part_exchange_value?: number
}

/** One `till_events` row on the session. */
export interface TillReportEvent {
  kind: string
  amount: number
}

/**
 * The Z's own figures: the count, the bank drop, the Tide total keyed in, the
 * notes. Staff count the whole drawer first and then take the bank drop out
 * of what they counted, so `counts` is the full drawer before the drop and
 * the report's `cash.counted` is that total less the drop: what is left in
 * the drawer. The drop is also one of the input's movements (the server
 * writes it as a `bank_drop` movement before building the Z), so `expected`
 * is after the drop as well and the variance comes out the same as it would
 * have before the drop was taken.
 */
export interface TillReportClose {
  /** The full drawer as keyed, before the bank drop. */
  counts: DenominationCounts
  /** Pence taken out of the counted cash to bank. 0 or absent for none. */
  bank_drop?: number
  card_reported_total: number | null
  notes: string
}

/** What is left in the drawer once a Z's bank drop is taken out of the count. */
export function countedAfterDrop(close: Pick<TillReportClose, "counts" | "bank_drop">): number {
  return denominationTotal(close.counts) - (close.bank_drop ?? 0)
}

export interface TillReportInput {
  type: "x" | "z"
  /** 0 for the running report, which is neither numbered nor saved. */
  number: number
  /** The saved report's id; empty for the running report. */
  id?: string
  register: NamedRef
  session: { id: string; float: number; opened_at: string }
  /** When the report was run, ISO 8601. Also the end of its period. */
  created: string
  created_by: NamedRef
  /** `settings.vat_registered`: without it the report shows no VAT. */
  vat_registered: boolean
  sales: TillReportSale[]
  tenders: TillReportTenderRow[]
  movements: DrawerMovement[]
  trade_ins: TillReportTradeIn[]
  events: TillReportEvent[]
  /** A Z's count and card total. Ignored on an X. */
  close?: TillReportClose | null
}

/** A date as an ISO 8601 string, from PocketBase's "2026-10-09 14:00:00.000Z" form too. */
function iso(value: string): string {
  return value ? value.replace(" ", "T") : ""
}

function tenderLabel(method: TenderMethod): string {
  return TENDER_LABELS[method] ?? method
}

/** Per method: positive rows taken, negative rows refunded, sale rows counted. In TENDER_METHODS order. */
export function summariseTenders(rows: TillReportTenderRow[]): TillReportTender[] {
  const byMethod = new Map<TenderMethod, TillReportTender>()
  for (const row of rows) {
    let entry = byMethod.get(row.method)
    if (!entry) {
      entry = { method: row.method, label: tenderLabel(row.method), taken: 0, refunded: 0, net: 0, count: 0 }
      byMethod.set(row.method, entry)
    }
    if (row.amount > 0) entry.taken += row.amount
    if (row.amount < 0) entry.refunded -= row.amount
    if (!row.refund_ref) entry.count += 1
  }
  const out: TillReportTender[] = []
  for (const method of TENDER_METHODS) {
    const entry = byMethod.get(method)
    if (!entry) continue
    entry.net = entry.taken - entry.refunded
    out.push(entry)
  }
  return out
}

/** The till's card figure: net card taken on the Tide reader and on any other card tender. */
export function cardTillTotal(tenders: TillReportTender[]): number {
  let total = 0
  for (const t of tenders) {
    if (t.method === "card_tide" || t.method === "card_other") total += t.net
  }
  return total
}

/** Refunds given in the session, from the negative tender rows: one refund per reference. */
export function summariseRefunds(rows: TillReportTenderRow[]): { count: number; total: number } {
  const refs = new Set<string>()
  let total = 0
  rows.forEach((row, index) => {
    if (row.amount >= 0) return
    total -= row.amount
    refs.add(row.refund_ref ? `ref:${row.refund_ref}` : `row:${index}`)
  })
  return { count: refs.size, total }
}

function byNetThenName<T extends { net: number }>(name: (row: T) => string) {
  return (a: T, b: T) => b.net - a.net || name(a).localeCompare(name(b))
}

/**
 * Build the X or Z report for a session. Every figure comes from the input
 * and nothing else:
 *
 * - **sales**: `count` the sales, `gross` before any discount, `discounts` the
 *   line and ticket discounts together, `net` gross minus discounts minus the
 *   refunds given in this session (which may be for a sale from an earlier
 *   one), `average_basket` net over count half-up, `vat` by rate from the
 *   standard-rated lines when VAT registered (gross is the line's net after
 *   discounts, vat its stored VAT, net the difference).
 * - **refunds**: the negative tender rows, one per refund reference.
 * - **tenders**: per method from the tender rows (`summariseTenders`).
 * - **cash**: the float and the movements (`cashBreakdown`); on a Z the
 *   counted total less any bank drop taken from it (`countedAfterDrop`) and
 *   counted minus expected. `counts` stays the full count as keyed.
 * - **card**: the till's net card; on a Z the Tide total keyed in and
 *   reported minus till.
 * - **voids**, **no_sales**, **overrides**: the till events, voids with the
 *   value of the lines removed.
 * - **discounts**: how many sales carried a discount and what they came to.
 * - **trade_ins**: the buy-ins paid from the session.
 * - **by_category**, **by_staff**: what was sold after discounts and before
 *   refunds, since a refund's lines may belong to another session. By
 *   category counts units, by staff counts sales; both largest first.
 */
export function buildTillReport(input: TillReportInput): TillReport {
  const isZ = input.type === "z"
  const close = isZ && input.close ? input.close : null

  // --- sales, discounts, VAT, categories and staff ----------------------
  let gross = 0
  let discounts = 0
  let discountedSales = 0
  let first: string | null = null
  let last: string | null = null
  const vatByRate = new Map<number, VatLine>()
  const categories = new Map<string, { category: string; net: number; count: number }>()
  const staff = new Map<string, { staff_id: string; name: string; net: number; count: number }>()

  for (const sale of input.sales) {
    const lineGrosses = sale.lines.map((line) =>
      grossOf({ qty: line.qty, unitPrice: line.unit_price, discount: line.discount })
    )
    const nets = spread(lineGrosses, sale.discount)

    let saleGross = 0
    let saleDiscount = sale.discount
    let saleNet = 0
    sale.lines.forEach((line, index) => {
      const qty = Math.max(1, line.qty)
      const net = nets[index] as number
      saleGross += line.unit_price * qty
      saleDiscount += line.discount
      saleNet += net

      const category = categories.get(line.category) ?? { category: line.category, net: 0, count: 0 }
      category.net += net
      category.count += qty
      categories.set(line.category, category)

      if (input.vat_registered && line.tax_scheme === "standard") {
        const vat = vatByRate.get(line.vat_rate) ?? { rate: line.vat_rate, net: 0, vat: 0, gross: 0 }
        vat.gross += net
        vat.vat += line.vat_amount
        vat.net = vat.gross - vat.vat
        vatByRate.set(line.vat_rate, vat)
      }
    })

    gross += saleGross
    discounts += saleDiscount
    if (saleDiscount > 0) discountedSales += 1

    const person = staff.get(sale.staff.id) ?? { staff_id: sale.staff.id, name: sale.staff.name, net: 0, count: 0 }
    person.net += saleNet
    person.count += 1
    staff.set(sale.staff.id, person)

    const at = iso(sale.occurred_at)
    if (at) {
      if (first === null || at < first) first = at
      if (last === null || at > last) last = at
    }
  }

  const refunds = summariseRefunds(input.tenders)
  const salesNet = gross - discounts - refunds.total
  const count = input.sales.length

  // --- tenders and card ------------------------------------------------
  const tenders = summariseTenders(input.tenders)
  const cardTotal = cardTillTotal(tenders)
  const reported = close ? close.card_reported_total : null

  // --- the drawer ------------------------------------------------------
  const breakdown = cashBreakdown(input.session.float, input.movements)
  const counted = close ? countedAfterDrop(close) : null

  // --- till events -----------------------------------------------------
  let voidCount = 0
  let voidTotal = 0
  let noSales = 0
  let overrides = 0
  for (const event of input.events) {
    if (event.kind === "void_line" || event.kind === "void_ticket") {
      voidCount += 1
      voidTotal += event.amount
    } else if (event.kind === "no_sale") {
      noSales += 1
    } else if (event.kind === "override") {
      overrides += 1
    }
  }

  // --- trade-ins -------------------------------------------------------
  let cashPaid = 0
  let creditIssued = 0
  let partExchange = 0
  for (const t of input.trade_ins) {
    cashPaid += t.payout_cash
    creditIssued += t.payout_credit
    partExchange += t.part_exchange_value ?? 0
  }

  return {
    id: input.id ?? "",
    type: input.type,
    number: input.number,
    register: { id: input.register.id, name: input.register.name },
    session_id: input.session.id,
    period_start: iso(input.session.opened_at),
    period_end: iso(input.created),
    created: iso(input.created),
    created_by: { id: input.created_by.id, name: input.created_by.name },
    sales: {
      count,
      gross,
      discounts,
      net: salesNet,
      average_basket: count > 0 ? roundHalfUp(salesNet / count) : 0,
      vat: [...vatByRate.values()].sort((a, b) => b.rate - a.rate),
    },
    refunds,
    tenders,
    cash: {
      ...breakdown,
      counted,
      variance: counted === null ? null : cashVariance(counted, breakdown.expected),
    },
    card: {
      till_total: cardTotal,
      reported_total: reported,
      variance: close ? cardVariance(reported, cardTotal) : null,
    },
    voids: { count: voidCount, total: voidTotal },
    no_sales: { count: noSales },
    overrides: { count: overrides },
    discounts: { count: discountedSales, total: discounts },
    trade_ins: {
      count: input.trade_ins.length,
      cash_paid: cashPaid,
      credit_issued: creditIssued,
      part_exchange_value: partExchange,
    },
    by_category: [...categories.values()].sort(byNetThenName((row) => row.category)),
    by_staff: [...staff.values()].sort(byNetThenName((row) => row.name)),
    first_sale_at: first,
    last_sale_at: last,
    counts: close ? close.counts : null,
    notes: close ? close.notes : "",
  }
}
