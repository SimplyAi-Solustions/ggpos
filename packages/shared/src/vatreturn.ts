/**
 * The VAT return (docs/api-contract-launch.md, section 3,
 * `GET /api/vault/reports/vat?period=2026-Q4`): the quarter a period names,
 * which of it is inside the shop's VAT registration, and the nine boxes, the
 * figures by rate and the margin scheme working, added up from one row per
 * sale line and per refund.
 *
 * Pure and shared: the route gathers the rows (each one's VAT worked out by
 * `keptLine` in ./vat), and the demo does the same from its own sales, so the
 * two can only differ in what was sold.
 *
 * Quarters run in shop time (Europe/London), because a VAT return is about
 * the calendar days the shop traded on. `settings.vat_period_start_month` is
 * the first month of any one of the shop's quarters; the stagger it falls in
 * fixes all four. Quarter 1 of a year is the one starting in the first month
 * of that stagger (January, February or March), so with a February stagger
 * 2026-Q4 runs from 1 November 2026 to 31 January 2027.
 *
 * A refund counts in the quarter it was given, not the quarter of its sale:
 * once a return is sent its figures never change, and a later refund comes
 * off the return it falls in. Boxes 6 and 7 are whole pounds, as HMRC asks;
 * the pence are dropped rather than rounded.
 */
import { treatmentOf, type VatTreatment, registeredFromDay, type VatRegistration, standardRateOf } from "./vat"

// ---------------------------------------------------------------------------
// Quarters
// ---------------------------------------------------------------------------

export interface VatQuarter {
  /** "2026-Q4". */
  period: string
  year: number
  quarter: number
  /** The first day, shop time, YYYY-MM-DD. */
  from: string
  /** The last day, shop time, YYYY-MM-DD. */
  to: string
}

const PERIOD_RE = /^(\d{4})-Q([1-4])$/

/** The first month (1 to 3) of the stagger `startMonth` falls in. */
export function quarterStagger(startMonth: number): number {
  const month = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1
  return ((month - 1) % 3) + 1
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** The quarter of `year` numbered `quarter`, for a shop whose quarters start in `startMonth`. */
function quarterAt(year: number, quarter: number, startMonth: number): VatQuarter {
  const first = quarterStagger(startMonth) + (quarter - 1) * 3
  const startYear = year + Math.floor((first - 1) / 12)
  const startMonthIndex = (first - 1) % 12
  const end = new Date(Date.UTC(startYear, startMonthIndex + 3, 0))
  return {
    period: `${year}-Q${quarter}`,
    year,
    quarter,
    from: `${startYear}-${pad(startMonthIndex + 1)}-01`,
    to: end.toISOString().slice(0, 10),
  }
}

/** The quarter a period names, or null for anything that is not "YYYY-Qn". */
export function vatQuarter(period: string, startMonth: number): VatQuarter | null {
  const match = PERIOD_RE.exec(period.trim())
  if (!match) return null
  return quarterAt(Number(match[1]), Number(match[2]), startMonth)
}

/** The quarter a shop-time day (YYYY-MM-DD) falls in. */
export function quarterOf(day: string, startMonth: number): VatQuarter {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  const stagger = quarterStagger(startMonth)
  if (month < stagger) return quarterAt(year - 1, 4, startMonth)
  return quarterAt(year, Math.floor((month - stagger) / 3) + 1, startMonth)
}

/** The quarter `steps` quarters after this one (before it, for a negative number). */
export function shiftQuarter(quarter: VatQuarter, steps: number, startMonth: number): VatQuarter {
  const index = quarter.year * 4 + (quarter.quarter - 1) + steps
  return quarterAt(Math.floor(index / 4), (index % 4) + 1, startMonth)
}

/** The quarter `today` is in and the `count - 1` before it, newest first. */
export function recentQuarters(today: string, startMonth: number, count: number): VatQuarter[] {
  const current = quarterOf(today, startMonth)
  const out: VatQuarter[] = []
  for (let step = 0; step < count; step++) out.push(shiftQuarter(current, -step, startMonth))
  return out
}

/** The day after a YYYY-MM-DD day. */
export function dayAfter(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "1 November 2026". */
export function longDate(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? ""
  return `${Number(day.slice(8, 10))} ${month} ${day.slice(0, 4)}`
}

/** "1 October to 31 December 2026", or across a new year "1 November 2026 to 31 January 2027". */
export function quarterLabel(quarter: Pick<VatQuarter, "from" | "to">): string {
  const sameYear = quarter.from.slice(0, 4) === quarter.to.slice(0, 4)
  const start = longDate(quarter.from)
  return `${sameYear ? start.slice(0, -5) : start} to ${longDate(quarter.to)}`
}

/**
 * The part of a quarter inside the registration: the first day it covers,
 * or null when none of it does (VAT is off, or registered from after the
 * quarter ends).
 */
export function vatScopeStart(quarter: VatQuarter, registration: VatRegistration): string | null {
  if (!registration.registered) return null
  const from = registeredFromDay(registration.from)
  if (from === "" || from <= quarter.from) return quarter.from
  return from <= quarter.to ? from : null
}

/** The sentence a return carries when some or all of its quarter is outside the registration. */
export function vatScopeNote(quarter: VatQuarter, registration: VatRegistration): string {
  if (!registration.registered) return "The shop is not VAT registered, so every box is 0."
  const from = registeredFromDay(registration.from)
  if (from === "" || from <= quarter.from) return ""
  if (from > quarter.to) {
    return `The shop is VAT registered from ${longDate(from)}, after this quarter, so every box is 0.`
  }
  return `The shop is VAT registered from ${longDate(from)}. Sales before then are not in this return.`
}

// ---------------------------------------------------------------------------
// The return
// ---------------------------------------------------------------------------

/** One sale line as sold, or one refund of it, in the quarter. Money in pence, signed. */
export interface VatReturnRow {
  kind: "sale" | "refund"
  /** The sale's number, or the refund's reference (GG-S-000456-R1). */
  ref: string
  /** The sale's id. */
  sale: string
  /** Shop-time day, YYYY-MM-DD. */
  date: string
  title: string
  sku: string
  /** The line's stored scheme. */
  scheme: string
  /** The line's stored rate: what it was charged at. */
  rate: number
  /** VAT inclusive: positive for a sale, negative for a refund. */
  gross: number
  /** The VAT in it. */
  vat: number
  /** Margin scheme lines: what the stock cost. 0 otherwise. */
  cost: number
}

/**
 * A row of the return with its treatment worked out, as the route answers
 * it. Its `rate` is the rate it was charged at, or for a margin scheme row
 * the rate its margin's VAT is worked at.
 */
export interface VatReturnLine extends VatReturnRow {
  treatment: VatTreatment
  /** gross less vat. */
  net: number
  /** The by-rate row it is counted in. */
  group: string
}

export interface VatRateRow {
  key: string
  label: string
  treatment: VatTreatment
  rate: number
  gross: number
  net: number
  vat: number
  count: number
}

export interface VatBoxes {
  /** VAT due on sales: standard and reduced lines plus the margin scheme's VAT. */
  box1: number
  /** VAT due on goods from the EU into Northern Ireland: none here. */
  box2: number
  /** Box 1 plus box 2. */
  box3: number
  /** VAT reclaimed on purchases, entered by hand. */
  box4: number
  /** Box 3 less box 4, as a positive figure (`box5_reclaim` says which way). */
  box5: number
  /** Sales excluding VAT, in whole pounds. */
  box6: number
  /** Purchases excluding VAT, in whole pounds, entered by hand. */
  box7: number
  box8: number
  box9: number
}

export interface VatPurchases {
  /** Box 4, pence. */
  vat: number
  /** Box 7 before the pence are dropped, pence. */
  net: number
  /** When they were last entered, ISO 8601, "" when never. */
  updated: string
  /** Who entered them, "" when never. */
  by: string
}

export interface VatMarginWorking {
  /** What margin scheme goods sold for, refunds off. */
  sales: number
  /** What they cost the shop. */
  cost: number
  /** sales less cost. */
  margin: number
  /** The VAT on it, line by line: nothing on a line sold at a loss. */
  vat: number
  /** Margin scheme sale lines in the quarter. */
  count: number
}

export interface VatReturn {
  period: string
  from: string
  to: string
  /** Whether any of the quarter is inside the registration. */
  registered: boolean
  /** `settings.vat_registered_from` as a day, "" when none. */
  registered_from: string
  standard_rate: number
  /** Said under the boxes when some or all of the quarter is outside the registration. */
  note: string
  boxes: VatBoxes
  /** True when box 4 is more than box 3: HMRC owes the shop. */
  box5_reclaim: boolean
  /** Box 6 with its pence. */
  sales_ex_vat: number
  by_rate: VatRateRow[]
  margin: VatMarginWorking
  purchases: VatPurchases
  rows: VatReturnLine[]
}

/** Pence with the pence dropped, as boxes 6 to 9 are written: 123456 is 123400. */
export function wholePounds(pence: number): number {
  return Math.trunc(pence / 100) * 100
}

/** The by-rate row a line is counted in, and its label. */
function groupOf(
  treatment: VatTreatment,
  rate: number,
  standardRate: number
): { key: string; label: string; order: number } {
  switch (treatment) {
    case "standard":
      return rate > 0
        ? { key: `standard:${rate}`, label: `Standard ${rate}%`, order: 1000 - rate }
        : { key: "standard:0", label: "Standard, no VAT charged", order: 1000 }
    case "reduced":
      return { key: `reduced:${rate}`, label: `Reduced ${rate}%`, order: 2000 }
    case "zero":
      return { key: "zero", label: "Zero 0%", order: 3000 }
    case "exempt":
      return { key: "exempt", label: "Exempt", order: 4000 }
    default:
      return { key: "margin", label: `Margin scheme, ${standardRate}% of the margin`, order: 5000 }
  }
}

const EMPTY_BOXES: VatBoxes = { box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0, box7: 0, box8: 0, box9: 0 }

/**
 * The return for a quarter from its rows. Every row must already be inside
 * the registration: the route and the demo only gather sales made on or
 * after `vat_registered_from` (`vatScopeStart`). A quarter none of which is
 * inside it answers every box 0 with the note saying why.
 */
export function buildVatReturn(input: {
  quarter: VatQuarter
  registration: VatRegistration
  standardRate: number
  rows: readonly VatReturnRow[]
  purchases: VatPurchases
}): VatReturn {
  const standardRate = standardRateOf(input.standardRate)
  const start = vatScopeStart(input.quarter, input.registration)
  const base = {
    period: input.quarter.period,
    from: input.quarter.from,
    to: input.quarter.to,
    registered_from: registeredFromDay(input.registration.from),
    standard_rate: standardRate,
    note: vatScopeNote(input.quarter, input.registration),
  }

  if (start === null) {
    return {
      ...base,
      registered: false,
      boxes: { ...EMPTY_BOXES },
      box5_reclaim: false,
      sales_ex_vat: 0,
      by_rate: [],
      margin: { sales: 0, cost: 0, margin: 0, vat: 0, count: 0 },
      purchases: input.purchases,
      rows: [],
    }
  }

  const groups = new Map<string, VatRateRow & { order: number }>()
  const margin: VatMarginWorking = { sales: 0, cost: 0, margin: 0, vat: 0, count: 0 }
  const rows: VatReturnLine[] = []
  let vat = 0
  let net = 0

  for (const row of input.rows) {
    const treatment = treatmentOf(row.scheme, row.rate) ?? "margin"
    const rate = treatment === "margin" ? standardRate : treatment === "standard" || treatment === "reduced" ? row.rate : 0
    const group = groupOf(treatment, rate, standardRate)
    const rowNet = row.gross - row.vat
    let entry = groups.get(group.key)
    if (!entry) {
      entry = { key: group.key, label: group.label, treatment, rate, gross: 0, net: 0, vat: 0, count: 0, order: group.order }
      groups.set(group.key, entry)
    }
    entry.gross += row.gross
    entry.net += rowNet
    entry.vat += row.vat
    if (row.kind === "sale") entry.count += 1

    // Only a margin scheme line's cost means anything to the return.
    if (treatment === "margin") {
      margin.sales += row.gross
      margin.cost += row.cost
      margin.vat += row.vat
      if (row.kind === "sale") margin.count += 1
    }

    vat += row.vat
    net += rowNet
    rows.push({ ...row, treatment, rate, net: rowNet, cost: treatment === "margin" ? row.cost : 0, group: group.key })
  }
  margin.margin = margin.sales - margin.cost

  const box4 = input.purchases.vat
  const box3 = vat
  return {
    ...base,
    registered: true,
    boxes: {
      box1: vat,
      box2: 0,
      box3,
      box4,
      box5: Math.abs(box3 - box4),
      box6: wholePounds(net),
      box7: wholePounds(input.purchases.net),
      box8: 0,
      box9: 0,
    },
    box5_reclaim: box4 > box3,
    sales_ex_vat: net,
    by_rate: [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map((row) => ({
        key: row.key,
        label: row.label,
        treatment: row.treatment,
        rate: row.rate,
        gross: row.gross,
        net: row.net,
        vat: row.vat,
        count: row.count,
      })),
    margin,
    purchases: input.purchases,
    rows,
  }
}
