/**
 * The demo till: its register, cash session, the day behind the session,
 * X and Z reports, registers and till devices, in memory for the tab.
 *
 * It starts open, so the demo till can sell straight away the way the demo
 * counter always has, on a morning's worth of sales, a refund, a buy-in
 * payout and a voided line, so an X report has something to say. The
 * figures go through one builder (`buildDemoReport`) in the shape of the
 * server's `TillReport`, with expected cash worked exactly as
 * docs/api-contract-epos.md section 3 defines it: the float, plus cash
 * taken, minus cash refunded, plus paid in, minus paid out, buy-in payouts
 * and bank drops, plus adjustments.
 *
 * `demoTill.session`, `DEMO_REGISTER` and `getDemoTillCurrent()` keep the
 * names and shapes the till reads. Capabilities are checked the way the
 * server checks them (`demo/overrides.ts`), so a member of staff is asked
 * for a manager's approval here too.
 */
import { ClientResponseError } from "pocketbase"
import {
  TENDER_LABELS,
  formatGBP,
  roundHalfUp,
  type DenominationCounts,
  type NamedRef,
  type TenderMethod,
  type TillCurrent,
  type TillReport,
  type TillReportTender,
  type TillSession,
} from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import { countsTotal } from "@/features/cash/count"
import { demoRequire } from "@/lib/api/demo/overrides"
import type { StoredTillDevice } from "@/lib/till-device"
import type {
  DeviceRow,
  MovementInput,
  MovementResult,
  NoSaleResult,
  RegisteredDevice,
  RegisterRow,
  ReportPage,
  ZInput,
} from "@/lib/api/tillops"

export const DEMO_REGISTER: NamedRef = { id: "register_demo", name: "Counter" }

function todayAt(hours: number, minutes = 0): string {
  const at = new Date()
  at.setHours(hours, minutes, 0, 0)
  return at.toISOString()
}

function yesterdayAt(hours: number, minutes = 0): string {
  const at = new Date()
  at.setDate(at.getDate() - 1)
  at.setHours(hours, minutes, 0, 0)
  return at.toISOString()
}

function openedThisMorning(): string {
  return todayAt(9, 0)
}

export const demoTill: { session: TillSession | null } = {
  session: {
    id: "till_session_demo",
    register: DEMO_REGISTER,
    opened_at: openedThisMorning(),
    opened_by: { id: DEMO_STAFF.id, name: DEMO_STAFF.name },
    float: 10000,
    opening_counts: null,
  },
}

// ---------------------------------------------------------------------------
// The day behind the session
// ---------------------------------------------------------------------------

type Headers = Record<string, string>

interface DemoTender {
  method: TenderMethod
  /** Pence, positive: what was taken, or on a refund what was given back. */
  amount: number
}

/** A sale on a demo session. `gross` is before discount. */
export interface DemoTillSale {
  session: string
  number: string
  at: string
  staff: NamedRef
  category: string
  gross: number
  discount: number
  tenders: DemoTender[]
}

interface DemoRefund {
  session: string
  ref: string
  at: string
  tenders: DemoTender[]
}

type DemoMovementType = "paid_in" | "paid_out" | "bank_drop" | "adjustment" | "payout"

interface DemoMovement {
  id: string
  session: string
  type: DemoMovementType
  /** Signed, as `cash_movements.amount` is: money out of the drawer is negative. */
  amount: number
  reason: string
  at: string
  staff: NamedRef
}

interface DemoEvent {
  id: string
  session: string
  kind: "void_line" | "no_sale" | "override"
  amount: number
  reason: string
  at: string
}

interface DemoTradeIn {
  session: string
  cash_paid: number
  credit_issued: number
}

interface Book {
  sales: DemoTillSale[]
  refunds: DemoRefund[]
  movements: DemoMovement[]
  events: DemoEvent[]
  tradeIns: DemoTradeIn[]
  reports: TillReport[]
  /** The last numbers used. */
  lastX: number
  lastZ: number
  /** Sessions this tab has seen, for the report periods. */
  sessions: TillSession[]
}

let book: Book | null = null
let sequence = 0

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}_${sequence}`
}

const MO: NamedRef = { id: "staff_demo_manager", name: "Mo Khan" }
const SAM: NamedRef = { id: "staff_demo_member", name: "Sam Bell" }
const DEMO: NamedRef = { id: DEMO_STAFF.id, name: DEMO_STAFF.name }

function seed(): Book {
  const today = demoTill.session?.id ?? "till_session_demo"
  const yesterday: TillSession = {
    id: "till_session_demo_yesterday",
    register: DEMO_REGISTER,
    opened_at: yesterdayAt(9, 2),
    opened_by: DEMO,
    float: 10000,
    opening_counts: null,
  }

  const fresh: Book = {
    sales: [
      // Yesterday, behind the Z the history opens on.
      sale(yesterday.id, "GG-S-000441", yesterdayAt(10, 4), DEMO, "Sealed", 5499, 0, [
        { method: "card_tide", amount: 5499 },
      ]),
      sale(yesterday.id, "GG-S-000442", yesterdayAt(13, 26), SAM, "Singles", 1850, 0, [
        { method: "cash", amount: 1850 },
      ]),
      sale(yesterday.id, "GG-S-000443", yesterdayAt(16, 48), MO, "Retro", 3200, 200, [
        { method: "card_tide", amount: 3000 },
      ]),
      // This morning.
      sale(today, "GG-S-000455", todayAt(9, 14), DEMO, "Singles", 1249, 0, [
        { method: "cash", amount: 1249 },
      ]),
      sale(today, "GG-S-000456", todayAt(9, 41), DEMO, "Singles", 4995, 250, [
        { method: "card_tide", amount: 4745 },
      ]),
      sale(today, "GG-S-000457", todayAt(10, 12), SAM, "Singles", 249, 0, [
        { method: "cash", amount: 249 },
      ]),
      sale(today, "GG-S-000458", todayAt(10, 55), SAM, "Sealed", 5499, 0, [
        { method: "card_tide", amount: 5499 },
      ]),
      sale(today, "GG-S-000459", todayAt(11, 30), DEMO, "Accessories", 999, 0, [
        { method: "store_credit", amount: 500 },
        { method: "cash", amount: 499 },
      ]),
      sale(today, "GG-S-000460", todayAt(12, 2), MO, "Retro", 2999, 0, [
        { method: "card_tide", amount: 2999 },
      ]),
    ],
    refunds: [
      {
        session: today,
        ref: "GG-S-000457-R1",
        at: todayAt(12, 20),
        tenders: [{ method: "cash", amount: 249 }],
      },
    ],
    movements: [
      {
        id: "till_move_seed_1",
        session: today,
        type: "payout",
        amount: -6500,
        reason: "Buy-in GG-BI-000122",
        at: todayAt(10, 35),
        staff: DEMO,
      },
    ],
    events: [
      {
        id: "till_event_seed_1",
        session: today,
        kind: "void_line",
        amount: 499,
        reason: "",
        at: todayAt(11, 28),
      },
    ],
    tradeIns: [{ session: today, cash_paid: 6500, credit_issued: 2000 }],
    reports: [],
    lastX: 86,
    lastZ: 41,
    sessions: [yesterday],
  }
  if (demoTill.session) fresh.sessions.push(demoTill.session)

  // Yesterday's X at two, and its Z at close, so the history has both kinds.
  book = fresh
  const x = buildDemoReport("x", 86, yesterday, { at: yesterdayAt(14, 0), by: SAM })
  // £118.90 counted against £118.50 expected: forty pence over.
  const counts: DenominationCounts = {
    "2000": 3,
    "1000": 2,
    "500": 3,
    "200": 5,
    "100": 8,
    "50": 6,
    "20": 10,
    "10": 5,
    "5": 8,
  }
  const z = buildDemoReport("z", 41, yesterday, {
    at: yesterdayAt(17, 31),
    by: MO,
    z: { counts, counted: countsTotal(counts), card_reported_total: 8499, notes: "" },
  })
  fresh.reports.push(z, x)
  return fresh
}

function sale(
  session: string,
  number: string,
  at: string,
  staff: NamedRef,
  category: string,
  gross: number,
  discount: number,
  tenders: DemoTender[]
): DemoTillSale {
  return { session, number, at, staff, category, gross, discount, tenders }
}

function ensureBook(): Book {
  if (!book) book = seed()
  return book
}

/** Puts the demo till back to its opening state. Tests only. */
export function resetDemoTill() {
  book = null
  sequence = 0
  DEMO_REGISTER.name = "Counter"
  demoTill.session = {
    id: "till_session_demo",
    register: DEMO_REGISTER,
    opened_at: openedThisMorning(),
    opened_by: { id: DEMO_STAFF.id, name: DEMO_STAFF.name },
    float: 10000,
    opening_counts: null,
  }
  registers = null
  devices = null
}

/**
 * A sale the demo till has just taken, so the next X report counts it. The
 * till's own demo store can call this when it completes a sale; nothing
 * else needs it.
 */
export function noteDemoTillSale(input: Omit<DemoTillSale, "session" | "at"> & { at?: string }) {
  const session = demoTill.session
  if (!session) return
  ensureBook().sales.push({ ...input, session: session.id, at: input.at ?? new Date().toISOString() })
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function refuse(status: number, message: string): never {
  throw new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

/** Whoever the demo session says is signed in. */
function signedIn(): NamedRef {
  try {
    const raw = localStorage.getItem("gg-demo-staff")
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: string; name?: string }
      if (parsed.id && parsed.name) return { id: parsed.id, name: parsed.name }
    }
  } catch {
    // Fall through to the demo admin.
  }
  return DEMO
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/** What the drawer of a session should hold now. */
function expectedFor(session: TillSession): number {
  return buildDemoReport("x", 0, session).cash.expected
}

/**
 * Every figure on an X or a Z from the session's records. Stands in for the
 * shared `buildTillReport` the server uses, in the same shape.
 */
function buildDemoReport(
  type: "x" | "z",
  number: number,
  session: TillSession,
  options: {
    at?: string
    by?: NamedRef
    z?: {
      counts: DenominationCounts
      /** What is left in the drawer: the count less any bank drop taken from it. */
      counted: number
      card_reported_total: number | null
      notes: string
    }
  } = {}
): TillReport {
  const data = ensureBook()
  const sid = session.id
  const sales = data.sales.filter((row) => row.session === sid)
  const refunds = data.refunds.filter((row) => row.session === sid)
  const movements = data.movements.filter((row) => row.session === sid)
  const events = data.events.filter((row) => row.session === sid)
  const tradeIns = data.tradeIns.filter((row) => row.session === sid)
  const at = options.at ?? new Date().toISOString()
  const by = options.by ?? signedIn()

  const tenderMap = new Map<TenderMethod, TillReportTender>()
  const tender = (method: TenderMethod) => {
    let row = tenderMap.get(method)
    if (!row) {
      row = { method, label: TENDER_LABELS[method], taken: 0, refunded: 0, net: 0, count: 0 }
      tenderMap.set(method, row)
    }
    return row
  }
  for (const row of sales) {
    for (const part of row.tenders) {
      const entry = tender(part.method)
      entry.taken += part.amount
      entry.count += 1
    }
  }
  for (const row of refunds) {
    for (const part of row.tenders) tender(part.method).refunded += part.amount
  }
  const tenders = [...tenderMap.values()].map((row) => ({ ...row, net: row.taken - row.refunded }))

  const byType = (kind: DemoMovementType) =>
    sum(movements.filter((row) => row.type === kind).map((row) => row.amount))
  const cashTender = tenderMap.get("cash")
  const cashSales = cashTender?.taken ?? 0
  const cashRefunds = cashTender?.refunded ?? 0
  const paidIn = byType("paid_in")
  const paidOut = -byType("paid_out")
  const payouts = -byType("payout")
  const bankDrops = -byType("bank_drop")
  const adjustments = byType("adjustment")
  const expected =
    session.float + cashSales - cashRefunds + paidIn - paidOut - payouts - bankDrops + adjustments

  const cardTill = sum(
    tenders
      .filter((row) => row.method === "card_tide" || row.method === "card_other")
      .map((row) => row.net)
  )

  const gross = sum(sales.map((row) => row.gross))
  const discounts = sum(sales.map((row) => row.discount))
  const refundTotal = sum(refunds.flatMap((row) => row.tenders.map((part) => part.amount)))
  const net = gross - discounts - refundTotal

  const category = new Map<string, { net: number; count: number }>()
  const staff = new Map<string, { name: string; net: number; count: number }>()
  for (const row of sales) {
    const value = row.gross - row.discount
    const c = category.get(row.category) ?? { net: 0, count: 0 }
    category.set(row.category, { net: c.net + value, count: c.count + 1 })
    const s = staff.get(row.staff.id) ?? { name: row.staff.name, net: 0, count: 0 }
    staff.set(row.staff.id, { name: s.name, net: s.net + value, count: s.count + 1 })
  }
  const voids = events.filter((row) => row.kind === "void_line")
  const times = sales.map((row) => row.at).sort()

  const counted = options.z ? options.z.counted : null
  const reported = options.z ? options.z.card_reported_total : null

  return {
    id: number ? nextId(`till_report_${type}`) : "",
    type,
    number,
    register: { id: session.register.id, name: session.register.name },
    session_id: sid,
    period_start: session.opened_at,
    period_end: at,
    created: at,
    created_by: by,
    sales: {
      count: sales.length,
      gross,
      discounts,
      net,
      average_basket: sales.length ? roundHalfUp(net / sales.length) : 0,
      vat: [],
    },
    refunds: { count: new Set(refunds.map((row) => row.ref)).size, total: refundTotal },
    tenders,
    cash: {
      opening_float: session.float,
      cash_sales: cashSales,
      cash_refunds: cashRefunds,
      paid_in: paidIn,
      paid_out: paidOut,
      buy_in_payouts: payouts,
      bank_drops: bankDrops,
      adjustments,
      expected,
      counted,
      variance: counted === null ? null : counted - expected,
    },
    card: {
      till_total: cardTill,
      reported_total: reported,
      variance: reported === null || reported === undefined ? null : reported - cardTill,
    },
    voids: { count: voids.length, total: sum(voids.map((row) => row.amount)) },
    no_sales: { count: events.filter((row) => row.kind === "no_sale").length },
    overrides: { count: events.filter((row) => row.kind === "override").length },
    discounts: {
      count: sales.filter((row) => row.discount > 0).length,
      total: discounts,
    },
    trade_ins: {
      count: tradeIns.length,
      cash_paid: sum(tradeIns.map((row) => row.cash_paid)),
      credit_issued: sum(tradeIns.map((row) => row.credit_issued)),
      part_exchange_value: 0,
    },
    by_category: [...category.entries()]
      .map(([name, row]) => ({ category: name, net: row.net, count: row.count }))
      .sort((a, b) => b.net - a.net),
    by_staff: [...staff.entries()]
      .map(([id, row]) => ({ staff_id: id, name: row.name, net: row.net, count: row.count }))
      .sort((a, b) => b.net - a.net),
    first_sale_at: times[0] ?? null,
    last_sale_at: times[times.length - 1] ?? null,
    counts: options.z ? options.z.counts : null,
    notes: options.z?.notes ?? "",
  }
}

export function getDemoTillCurrent(): TillCurrent {
  const session = demoTill.session
  return {
    register: DEMO_REGISTER,
    session,
    running: session ? buildDemoReport("x", 0, session) : null,
  }
}

function openSession(): TillSession {
  const session = demoTill.session
  if (!session) refuse(409, "Open the till first.")
  return session
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export function demoOpenTill(
  input: { counts?: DenominationCounts; float?: number },
  headers: Headers = {}
): TillSession {
  const data = ensureBook()
  if (demoTill.session) refuse(409, "The till is already open. Close it with a Z report first.")
  demoRequire("till_open", headers)
  const float = input.counts ? countsTotal(input.counts) : Math.max(0, input.float ?? 0)
  const session: TillSession = {
    id: nextId("till_session"),
    register: DEMO_REGISTER,
    opened_at: new Date().toISOString(),
    opened_by: signedIn(),
    float,
    opening_counts: input.counts ?? null,
  }
  demoTill.session = session
  data.sessions.push(session)
  return session
}

export function demoRunX(headers: Headers = {}): TillReport {
  const data = ensureBook()
  const session = openSession()
  demoRequire("x_report", headers)
  data.lastX += 1
  const report = buildDemoReport("x", data.lastX, session)
  data.reports.unshift(report)
  return report
}

export function demoRunZ(
  input: ZInput,
  headers: Headers = {}
): { report: TillReport; session: TillSession } {
  const data = ensureBook()
  const session = openSession()
  demoRequire("z_report", headers)
  // The count is the whole drawer, before any bank drop is taken out of it
  // (the cashing-up contract, as the Z route reads it).
  const full = countsTotal(input.counts)
  if (!full) refuse(400, "Count the drawer before closing the till.")
  const running = buildDemoReport("x", 0, session)
  if (running.card.till_total !== 0 && input.card_reported_total === null) {
    refuse(400, "Enter the Tide card total for today from the Tide app.")
  }
  const drop = input.bank_drop && input.bank_drop > 0 ? input.bank_drop : 0
  if (drop > full) {
    refuse(400, `The bank drop cannot be more than the ${formatGBP(full)} counted.`)
  }
  if (drop) {
    data.movements.push({
      id: nextId("till_move"),
      session: session.id,
      type: "bank_drop",
      amount: -drop,
      reason: "Bank drop at close",
      at: new Date().toISOString(),
      staff: signedIn(),
    })
  }
  data.lastZ += 1
  const report = buildDemoReport("z", data.lastZ, session, {
    z: {
      counts: input.counts,
      counted: full - drop,
      card_reported_total: input.card_reported_total,
      notes: input.notes ?? "",
    },
  })
  data.reports.unshift(report)
  demoTill.session = null
  return { report, session }
}

export function demoMovement(input: MovementInput, headers: Headers = {}): MovementResult {
  const data = ensureBook()
  const session = openSession()
  demoRequire(input.type === "adjustment" ? "z_report" : "paid_in_out", headers)
  if (!input.reason.trim()) refuse(400, "Say what the money was for.")
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    refuse(400, "Enter an amount in pounds and pence, for example 5.00.")
  }
  if (input.type !== "adjustment" && input.amount < 0) {
    refuse(400, "Enter an amount in pounds and pence, for example 5.00.")
  }
  if (input.type === "paid_out" || input.type === "bank_drop") {
    const expected = expectedFor(session)
    if (input.amount > expected) {
      refuse(409, `That is more than the ${formatGBP(expected)} the drawer should hold.`)
    }
  }
  const signed = input.type === "paid_out" || input.type === "bank_drop" ? -input.amount : input.amount
  const movement: DemoMovement = {
    id: nextId("till_move"),
    session: session.id,
    type: input.type,
    amount: signed,
    reason: input.reason.trim(),
    at: new Date().toISOString(),
    staff: signedIn(),
  }
  data.movements.push(movement)
  // The demo shop has no receipt printer, so nothing opened the drawer.
  return {
    movement: { id: movement.id, type: movement.type, amount: movement.amount, reason: movement.reason },
    print_job: null,
  }
}

export function demoNoSale(reason: string, headers: Headers = {}): NoSaleResult {
  const data = ensureBook()
  const session = openSession()
  demoRequire("no_sale", headers)
  if (!reason.trim()) refuse(400, "Say why the drawer is being opened.")
  const event: DemoEvent = {
    id: nextId("till_event"),
    session: session.id,
    kind: "no_sale",
    amount: 0,
    reason: reason.trim(),
    at: new Date().toISOString(),
  }
  data.events.push(event)
  return { event: { id: event.id, kind: event.kind }, print_job: null }
}

export function demoListReports(options: {
  type?: "x" | "z"
  page?: number
  perPage?: number
}): ReportPage {
  const data = ensureBook()
  const page = options.page ?? 1
  const perPage = options.perPage ?? 20
  const rows = data.reports
    .filter((report) => !options.type || report.type === options.type)
    .sort((a, b) => b.created.localeCompare(a.created))
  return {
    items: rows.slice((page - 1) * perPage, page * perPage).map((report) => ({
      id: report.id,
      type: report.type,
      number: report.number,
      register_name: report.register.name,
      created: report.created,
      created_by_name: report.created_by.name,
      net: report.sales.net,
      cash_variance: report.cash.variance,
      card_variance: report.card.variance,
    })),
    page,
    per_page: perPage,
    total: rows.length,
  }
}

export function demoGetReport(id: string): TillReport {
  const report = ensureBook().reports.find((row) => row.id === id)
  if (!report) refuse(404, "That report was not found.")
  return report
}

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

let registers: RegisterRow[] | null = null

function registerRows(): RegisterRow[] {
  if (!registers) {
    registers = [{ id: DEMO_REGISTER.id, name: DEMO_REGISTER.name, active: true, sort: 1 }]
  }
  return registers
}

export function demoListRegisters(): RegisterRow[] {
  return registerRows()
    .map((row) => ({ ...row }))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}

function nameTaken(name: string, except?: string): boolean {
  const clean = name.trim().toLowerCase()
  return registerRows().some((row) => row.id !== except && row.name.toLowerCase() === clean)
}

export function demoCreateRegister(name: string): RegisterRow {
  const clean = name.trim()
  if (!clean) refuse(400, "Give the register a name.")
  if (nameTaken(clean)) refuse(400, `There is already a register called ${clean}.`)
  const rows = registerRows()
  const row: RegisterRow = {
    id: nextId("register_demo"),
    name: clean,
    active: true,
    sort: Math.max(0, ...rows.map((entry) => entry.sort)) + 1,
  }
  rows.push(row)
  return { ...row }
}

export function demoUpdateRegister(
  id: string,
  patch: { name?: string; active?: boolean }
): RegisterRow {
  const row = registerRows().find((entry) => entry.id === id)
  if (!row) refuse(404, "That register was not found.")
  if (patch.name !== undefined) {
    const clean = patch.name.trim()
    if (!clean) refuse(400, "Give the register a name.")
    if (nameTaken(clean, id)) refuse(400, `There is already a register called ${clean}.`)
    row.name = clean
    if (id === DEMO_REGISTER.id) DEMO_REGISTER.name = clean
  }
  if (patch.active !== undefined) row.active = patch.active
  return { ...row }
}

// ---------------------------------------------------------------------------
// Till devices, and this browser's registration
// ---------------------------------------------------------------------------

/** The demo browser is a till from the start (the lock package's brief). */
export const DEMO_DEVICE: StoredTillDevice = {
  id: "device_demo",
  secret: "demo",
  register: DEMO_REGISTER.id,
  register_name: DEMO_REGISTER.name,
  label: "Demo till",
}

let devices: DeviceRow[] | null = null

function deviceRows(): DeviceRow[] {
  if (!devices) {
    devices = [
      {
        id: DEMO_DEVICE.id,
        register: DEMO_REGISTER.id,
        register_name: DEMO_REGISTER.name,
        label: DEMO_DEVICE.label,
        created_by_name: DEMO_STAFF.name,
        last_seen: new Date().toISOString(),
        revoked_at: "",
      },
    ]
  }
  return devices
}

/**
 * This browser's demo registration lives in sessionStorage, beside the demo
 * flag itself, rather than in the real `gg.till.device` key: a demo tab must
 * never leave a made-up device behind for the live counter to send.
 */
const THIS_DEVICE_KEY = "gg-demo-device"
const thisDeviceListeners = new Set<() => void>()
let thisDeviceCache: { raw: string | null; value: StoredTillDevice | null } | null = null

function readThisDevice(): StoredTillDevice | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(THIS_DEVICE_KEY)
  } catch {
    raw = null
  }
  if (thisDeviceCache && thisDeviceCache.raw === raw) return thisDeviceCache.value
  let value: StoredTillDevice | null
  if (raw === null) value = { ...DEMO_DEVICE, register_name: DEMO_REGISTER.name }
  else if (raw === "none") value = null
  else {
    try {
      value = JSON.parse(raw) as StoredTillDevice
    } catch {
      value = null
    }
  }
  thisDeviceCache = { raw, value }
  return value
}

/** The demo browser's till registration, or null once it has been forgotten. */
export function getDemoThisDevice(): StoredTillDevice | null {
  return readThisDevice()
}

export function setDemoThisDevice(device: StoredTillDevice | null): void {
  try {
    sessionStorage.setItem(THIS_DEVICE_KEY, device ? JSON.stringify(device) : "none")
  } catch {
    // Private browsing: the demo forgets with the page.
  }
  for (const listener of thisDeviceListeners) listener()
}

export function subscribeDemoThisDevice(listener: () => void): () => void {
  thisDeviceListeners.add(listener)
  return () => thisDeviceListeners.delete(listener)
}

export function demoListDevices(): DeviceRow[] {
  return deviceRows()
    .map((row) => ({ ...row }))
    .sort((a, b) => (b.revoked_at ? 0 : 1) - (a.revoked_at ? 0 : 1))
}

export function demoRegisterDevice(input: { register: string; label: string }): RegisteredDevice {
  const label = input.label.trim()
  if (!label) refuse(400, "Give this device a name, for example Counter Mac.")
  const register = registerRows().find((row) => row.id === input.register)
  if (!register) refuse(404, "That register was not found.")
  if (!register.active) {
    refuse(409, "That register is switched off. Switch it on under Settings first.")
  }
  const id = nextId("device_demo")
  const row: DeviceRow = {
    id,
    register: register.id,
    register_name: register.name,
    label,
    created_by_name: signedIn().name,
    last_seen: new Date().toISOString(),
    revoked_at: "",
  }
  deviceRows().unshift(row)
  const secret = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")
  return {
    device: { id, register: register.id, register_name: register.name, label, created: row.last_seen },
    secret,
  }
}

export function demoRevokeDevice(id: string): void {
  const row = deviceRows().find((entry) => entry.id === id)
  if (!row) refuse(404, "That device was not found.")
  if (!row.revoked_at) row.revoked_at = new Date().toISOString()
}

export function demoCheckDevice() {
  const device = readThisDevice()
  const row = device ? deviceRows().find((entry) => entry.id === device.id) : undefined
  if (!device || !row || row.revoked_at) {
    refuse(
      401,
      "This device is not registered as a till. Sign in with a password and register it under Settings."
    )
  }
  row.last_seen = new Date().toISOString()
  const register = registerRows().find((entry) => entry.id === row.register)
  return {
    device: {
      id: row.id,
      label: row.label,
      register: row.register,
      register_name: register?.name ?? row.register_name,
    },
    register: {
      id: row.register,
      name: register?.name ?? row.register_name,
      active: register?.active ?? true,
    },
  }
}
