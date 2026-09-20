import { buildCode, formatGBP } from "@gg/shared"
// `packages/shared/src/index.ts` re-exports money, sku and pb-types only, so
// the pricing and loyalty evaluators come in through their own subpaths.
import { DEFAULT_OFFER_SETTINGS, type OfferSettings, type PricingRule } from "@gg/shared/pricing"
import { evaluateTradeInPoints, type LoyaltyProgramme } from "@gg/shared/loyalty"

import {
  demoAddPoints,
  demoCreateCustomer,
  demoPostCredit,
  demoRecordVisit,
  demoVerifyId,
  findDemoCustomer,
} from "@/lib/api/demo/customers"
import type {
  CompleteTradeInPayload,
  CompleteTradeInResult,
  IdCheckResult,
  ItemKind,
  OfferLimits,
  ReceiptPayload,
  TradeInLineInput,
  TradeInLineRecord,
  TradeInRecord,
  TradeInSummary,
} from "@/lib/api/types"

/**
 * The demo buy-in book.
 *
 * Demo mode runs the whole wizard end to end: a draft is created, lines are
 * saved as they change, completion assigns the next `GG-BI-000001`, creates
 * items with real SKUs through the shared `buildCode`, posts store credit and
 * points, and marks an ID check verified. The only thing it cannot do is
 * print, so `labels_queued` is a count like the server's.
 */

const DAY = 86_400_000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

/** 20 September 2026, the same shape the server's receipt builder writes. */
function ukDate(value: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function randomBody(): string {
  return Array.from(
    { length: 5 },
    () => CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)]
  ).join("")
}

/** `pricing_rules` as the seed writes them (pb_migrations/1789819620_seed.js). */
export const DEMO_PRICING_RULES: PricingRule[] = [
  {
    id: "rule_single_low",
    game: null,
    kind: "single",
    condition: "NM",
    finish: null,
    rarity: null,
    bandMin: 0,
    bandMax: 500,
    cashPct: 40,
    creditPct: 55,
    rounding: 25,
    priority: 10,
    active: true,
  },
  {
    id: "rule_single_mid",
    game: null,
    kind: "single",
    condition: "NM",
    finish: null,
    rarity: null,
    bandMin: 500,
    bandMax: 5000,
    cashPct: 50,
    creditPct: 65,
    rounding: 50,
    priority: 20,
    active: true,
  },
  {
    id: "rule_single_high",
    game: null,
    kind: "single",
    condition: "NM",
    finish: null,
    rarity: null,
    bandMin: 5000,
    bandMax: null,
    cashPct: 60,
    creditPct: 75,
    rounding: 50,
    priority: 30,
    active: true,
  },
  {
    id: "rule_retro",
    game: null,
    kind: "retro",
    condition: "",
    finish: null,
    rarity: null,
    bandMin: 0,
    bandMax: null,
    cashPct: 45,
    creditPct: 60,
    rounding: 50,
    priority: 40,
    active: true,
  },
  {
    id: "rule_sealed",
    game: null,
    kind: "sealed",
    condition: "",
    finish: null,
    rarity: null,
    bandMin: 0,
    bandMax: null,
    cashPct: 55,
    creditPct: 70,
    rounding: 50,
    priority: 50,
    active: true,
  },
]

export const DEMO_OFFER_SETTINGS: OfferSettings = { ...DEFAULT_OFFER_SETTINGS }

/** `settings.cash_cap` in the seed: £8,000. */
export const DEMO_OFFER_LIMITS: OfferLimits = { cashCap: 800_000 }

/** `loyalty_programme` in the seed, in the shared evaluator's shape. */
export const DEMO_PROGRAMME: LoyaltyProgramme = {
  enabled: true,
  earnPerPoundSales: 10,
  earnPerPoundTradeInCredit: 5,
  pointsPerPoundRedemption: 100,
  minRedeemPoints: 500,
  maxPointsShareOfSale: 50,
  expiryMonthsInactive: 18,
  tierWindowMonths: 12,
  welcomeBonus: 100,
  referralBonusReferrer: 250,
  referralBonusReferee: 250,
}

export const DEMO_SHOP = {
  name: "GG Entertainment",
  address: "Market Place",
  town: "Bolsover",
  postcode: "S44 6PN",
  phone: "01246 000000",
  email: "hello@ggentertainment.co.uk",
}

export const DEMO_RECEIPT_TERMS =
  "Items bought outright. We check every item before it goes on sale. " +
  "By signing you confirm the items are yours to sell and that the details above are correct. " +
  "We keep this record, and the seller details on it, for six years."

export const DEMO_RETENTION_NOTE =
  "We keep this record and the seller details on it for six years, as tax law requires. " +
  "Any ID photo taken with it is deleted after twelve months."

interface DemoTradeIn {
  record: TradeInRecord
  lines: TradeInLineRecord[]
  signature: string | null
  staffName: string
}

const NUMBER_PREFIX = "GG-BI-"
let nextNumber = 3

function formatNumber(value: number): string {
  return `${NUMBER_PREFIX}${String(value).padStart(6, "0")}`
}

/** Two finished buy-ins so the recent list is not empty on a fresh demo. */
export const demoTradeIns: DemoTradeIn[] = [
  {
    record: {
      id: "trade_demo_1",
      number: formatNumber(1),
      customer: "cust_demo_1",
      channel: "counter",
      status: "completed",
      payout_type: "credit",
      total_market: 11000,
      total_offer: 6000,
      payout_cash: 0,
      payout_credit: 6000,
      id_checked: true,
      completed_at: daysAgo(96),
      created: daysAgo(96),
      seller_name: "Jasmine Okafor",
      seller_address: "12 Castle Street, Bolsover, S44 6PP",
    },
    lines: [
      {
        id: "trade_demo_1_l1",
        trade_in: "trade_demo_1",
        kind: "single",
        free_text_title: "Alakazam ex 201/165",
        condition: "NM",
        qty: 1,
        market_price: 11000,
        market_source: "Manual",
        offer_price: 6000,
        accepted: true,
      },
    ],
    signature: null,
    staffName: "Demo Counter",
  },
  {
    record: {
      id: "trade_demo_2",
      number: formatNumber(2),
      customer: "cust_demo_3",
      channel: "counter",
      status: "completed",
      payout_type: "credit",
      total_market: 2500,
      total_offer: 1250,
      payout_cash: 0,
      payout_credit: 1250,
      id_checked: false,
      completed_at: daysAgo(61),
      created: daysAgo(61),
      seller_name: "Callum Reeve",
      seller_address: "",
    },
    lines: [
      {
        id: "trade_demo_2_l1",
        trade_in: "trade_demo_2",
        kind: "retro",
        free_text_title: "Mario Kart 64, boxed",
        completeness: "boxed",
        qty: 1,
        market_price: 2500,
        market_source: "Manual",
        offer_price: 1250,
        accepted: true,
      },
    ],
    signature: null,
    staffName: "Demo Counter",
  },
]

function find(id: string): DemoTradeIn | null {
  return demoTradeIns.find((entry) => entry.record.id === id) ?? null
}

export function demoCreateDraft(customerId: string): TradeInRecord {
  const id = randomId("trade")
  const entry: DemoTradeIn = {
    record: {
      id,
      // A draft has no number: the server draws one from counters.trade_in
      // inside the completion transaction, so an abandoned draft burns none.
      number: "",
      customer: customerId,
      channel: "counter",
      status: "draft",
      total_market: 0,
      total_offer: 0,
      payout_cash: 0,
      payout_credit: 0,
      created: new Date().toISOString(),
    },
    lines: [],
    signature: null,
    staffName: "Demo Counter",
  }
  demoTradeIns.unshift(entry)
  return { ...entry.record }
}

export function demoGetTradeIn(id: string): TradeInRecord | null {
  const entry = find(id)
  return entry ? { ...entry.record } : null
}

export function demoGetLines(id: string): TradeInLineRecord[] {
  const entry = find(id)
  return entry ? entry.lines.map((line) => ({ ...line })) : []
}

export function demoSaveLines(
  id: string,
  lines: TradeInLineInput[]
): TradeInLineRecord[] {
  const entry = find(id)
  if (!entry) throw new Error("Trade-in not found in the demo shop.")

  entry.lines = lines.map((line) => ({
    id: line.id ?? randomId("line"),
    trade_in: id,
    kind: line.kind,
    game: line.gameId,
    card: line.cardId,
    free_text_title: line.title,
    finish: line.finish,
    condition: (line.condition ?? "") as TradeInLineRecord["condition"],
    completeness: (line.completeness ?? "") as TradeInLineRecord["completeness"],
    qty: line.qty,
    market_price: line.marketPrice,
    market_currency: "GBP",
    market_source: line.marketSource,
    offer_pct: line.offerPct,
    offer_price: line.offerPrice,
    accepted: line.accepted,
  }))

  entry.record.total_market = entry.lines.reduce(
    (sum, line) => sum + (line.market_price ?? 0) * (line.qty ?? 1),
    0
  )
  entry.record.total_offer = entry.lines
    .filter((line) => line.accepted)
    .reduce((sum, line) => sum + (line.offer_price ?? 0) * (line.qty ?? 1), 0)

  return entry.lines.map((line) => ({ ...line }))
}

export function demoSubmitIdCheck(
  customerId: string,
  form: FormData
): IdCheckResult {
  const read = (key: string) => String(form.get(key) ?? "")
  const check = {
    id_type: read("id_type") as "passport" | "driving_licence" | "other",
    id_expiry: read("id_expiry"),
    id_ref_last4: read("id_ref_last4"),
    dob: read("dob"),
    address: read("address"),
    id_document: null,
  }
  demoVerifyId(customerId, check)
  const expires = new Date()
  expires.setMonth(expires.getMonth() + 12)
  return {
    id_document: randomId("iddoc"),
    id_status: "verified",
    id_expiry: check.id_expiry,
    expires_at: expires.toISOString(),
  }
}

/** SKU kind letters follow the line's kind, as items.pb.js does on the server. */
function skuFor(kind: ItemKind): string {
  return buildCode(kind, randomBody()).encoded
}

export function demoCompleteTradeIn(
  id: string,
  payload: CompleteTradeInPayload
): CompleteTradeInResult {
  const entry = find(id)
  if (!entry) throw new Error("Trade-in not found in the demo shop.")

  if (payload.id_check) {
    demoVerifyId(entry.record.customer, payload.id_check)
  }

  const accepted = entry.lines.filter((line) => line.accepted)
  const items: CompleteTradeInResult["items"] = []
  for (const line of accepted) {
    // Singles, graded cards and retro are one row per unit; sealed and
    // accessories are one row carrying the quantity.
    const perUnit = line.kind === "sealed" || line.kind === "accessory"
    const copies = perUnit ? 1 : (line.qty ?? 1)
    for (let index = 0; index < copies; index += 1) {
      items.push({
        id: randomId("item"),
        sku: skuFor((line.kind ?? "other") as ItemKind),
        title: line.free_text_title || "Item",
      })
    }
  }

  const now = new Date()
  const number = formatNumber(nextNumber)
  nextNumber += 1

  const customer = findDemoCustomer(entry.record.customer)
  entry.record.number = number
  entry.record.status = "completed"
  entry.record.payout_type = payload.payout_type
  entry.record.payout_cash = payload.payout_cash
  entry.record.payout_credit = payload.payout_credit
  entry.record.completed_at = now.toISOString()
  entry.record.id_checked = Boolean(
    payload.id_check || customer?.private.id_status === "verified"
  )
  entry.record.seller_name = customer?.customer.name ?? ""
  entry.record.seller_address =
    payload.id_check?.address || customer?.private.address || ""
  entry.signature = payload.signature

  let creditBalance = customer?.private.credit_balance ?? 0
  if (payload.payout_credit > 0) {
    creditBalance = demoPostCredit(
      entry.record.customer,
      payload.payout_credit,
      number
    )
  }
  const pointsEarned = evaluateTradeInPoints(
    DEMO_PROGRAMME,
    [],
    payload.payout_credit,
    now
  )
  if (pointsEarned > 0) demoAddPoints(entry.record.customer, pointsEarned)
  demoRecordVisit(entry.record.customer, now.toISOString())

  return {
    trade_in: {
      id: entry.record.id,
      number,
      status: "completed",
      payout_cash: payload.payout_cash,
      payout_credit: payload.payout_credit,
    },
    items,
    labels_queued: items.length,
    points_earned: pointsEarned,
    credit_balance: creditBalance,
  }
}

export function demoListTradeIns(): TradeInSummary[] {
  return demoTradeIns
    .map((entry) => {
      const customer = findDemoCustomer(entry.record.customer)
      return {
        id: entry.record.id,
        number: entry.record.number,
        status: entry.record.status ?? "draft",
        customerId: entry.record.customer,
        customerName: customer?.customer.name ?? entry.record.seller_name ?? "",
        customerCode: customer?.customer.code ?? "",
        payoutType: entry.record.payout_type ?? null,
        totalMarket: entry.record.total_market ?? 0,
        totalOffer: entry.record.total_offer ?? 0,
        payoutCash: entry.record.payout_cash ?? 0,
        payoutCredit: entry.record.payout_credit ?? 0,
        staffName: entry.staffName,
        at: entry.record.completed_at ?? entry.record.created ?? "",
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
}

export function demoTradeInsFor(customerId: string): TradeInSummary[] {
  return demoListTradeIns().filter((entry) => entry.customerId === customerId)
}

export function demoReceipt(id: string): ReceiptPayload {
  const entry = find(id)
  if (!entry) throw new Error("Trade-in not found in the demo shop.")
  const customer = findDemoCustomer(entry.record.customer)
  const priv = customer?.private
  const cash = entry.record.payout_cash ?? 0
  const credit = entry.record.payout_credit ?? 0
  const when = entry.record.completed_at ?? entry.record.created ?? ""

  return {
    shop: { ...DEMO_SHOP },
    trade_in: {
      id: entry.record.id,
      number: entry.record.number,
      status: entry.record.status ?? "draft",
      completed_at: entry.record.completed_at ?? "",
      date_display: ukDate(when),
      payout_type: entry.record.payout_type ?? "",
      payout_cash: cash,
      payout_credit: credit,
      payout_total: cash + credit,
      payout_cash_display: formatGBP(cash),
      payout_credit_display: formatGBP(credit),
      payout_total_display: formatGBP(cash + credit),
      total_market: entry.record.total_market ?? 0,
      total_offer: entry.record.total_offer ?? 0,
    },
    seller: {
      name: entry.record.seller_name ?? "",
      address: entry.record.seller_address ?? "",
      id_type: priv?.id_type ?? "",
      id_last4: priv?.id_ref_last4 ?? "",
      id_expiry: priv?.id_expiry ?? "",
    },
    staff: { id: "staff_demo", name: entry.staffName },
    lines: entry.lines
      .filter((line) => line.accepted)
      .map((line) => {
        const qty = line.qty ?? 1
        const offer = line.offer_price ?? 0
        return {
          id: line.id,
          title: line.free_text_title || "Item",
          condition: line.condition || line.completeness || "",
          finish: line.finish ?? "",
          qty,
          market_price: line.market_price ?? 0,
          offer_price: offer,
          line_total: offer * qty,
          offer_price_display: formatGBP(offer),
          line_total_display: formatGBP(offer * qty),
        }
      }),
    // Demo mode has no file store, so the signature stays as the data URL the
    // pad produced; the live route serves a short-lived file token URL.
    signature: entry.signature
      ? { file: "signature.png", url: entry.signature, token: "" }
      : null,
    terms: DEMO_RECEIPT_TERMS,
    retention_note: DEMO_RETENTION_NOTE,
  }
}

/** The wizard's "New customer" step, so a demo buy-in never needs the list. */
export function demoQuickCustomer(name: string, phone?: string, email?: string) {
  return demoCreateCustomer({ name, phone, email })
}
