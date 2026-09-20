/**
 * The demo counter's selling, cash and label state.
 *
 * Everything here lives in memory for the tab, exactly like the item store
 * `createItem` writes to in `src/lib/api/index.ts`: a demo till is for
 * exploring, screenshotting and end-to-end testing, never for keeping a
 * record. Nothing is persisted and nothing leaves the page.
 *
 * `itemStore()` reaches the same array Add stock appends to, so an item added
 * on one screen is sellable on the next.
 */
import { buildCode } from "@gg/shared"
import type {
  LoyaltyProgramme,
  LoyaltyRule,
  LoyaltyTier,
} from "@gg/shared"

import { DEMO_CARDS } from "@/lib/api/fixtures"
import { demoItemStore } from "@/lib/api/index"
import { itemDetailLine, templateForItem } from "@/lib/api/item-shape"
import type {
  CashMovementRecord,
  CashSessionRecord,
  LabelJobDetail,
  RewardVoucher,
  SaleCustomer,
  SaleLineDetail,
  SaleRecord,
  StockItemRecord,
} from "@/lib/api/types"

/** Add stock's array. Reached through a function so the import stays lazy. */
export function itemStore(): StockItemRecord[] {
  return demoItemStore
}

/** The art the catalogue holds for a card, when it holds any. */
export function demoCardImage(cardId?: string): string | undefined {
  if (!cardId) return undefined
  return DEMO_CARDS.find((card) => card.id === cardId)?.image
}

// ---------------------------------------------------------------------------
// Loyalty: the seed in pb_migrations/1789819620_seed.js, in the shapes the
// shared evaluator takes.
// ---------------------------------------------------------------------------

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

export const DEMO_TIERS: LoyaltyTier[] = [
  { id: "tier_member", name: "Member", thresholdPoints: 0, sort: 10, perks: [], paidPlan: false },
  {
    id: "tier_regular",
    name: "Regular",
    thresholdPoints: 2500,
    sort: 20,
    perks: [
      { type: "percent_off", value: 5, scope: ["sealed"] },
      { type: "points_multiplier", value: 1.25 },
    ],
    paidPlan: false,
  },
  {
    id: "tier_legend",
    name: "Legend",
    thresholdPoints: 10000,
    sort: 30,
    perks: [
      {
        type: "percent_off",
        value: 10,
        scope: ["single", "graded", "retro", "sealed", "accessory", "other"],
      },
      { type: "points_multiplier", value: 1.5 },
      { type: "free_event_entries", value: 2, perMonth: true },
    ],
    paidPlan: false,
  },
]

/** No live rules in the demo, so the points preview is plain base earning. */
export const DEMO_RULES: LoyaltyRule[] = []

/**
 * The slice of `settings` the counter reads, at the seed's figures
 * (pb_migrations/1789819620_seed.js and 1789819680_phase2_fields.js). The
 * demo stands in for `GET /api/vault/config`, so these are the same numbers
 * a fresh shop has.
 */
export const DEMO_SETTINGS = {
  /** £8,000. */
  cash_cap: 800000,
  /** £10.00. */
  cash_variance_alert: 1000,
}

/** The tiers as the config route serves them, straight off `loyalty_tiers`. */
export const DEMO_TIER_ROWS = DEMO_TIERS.map((tier) => ({
  id: tier.id,
  name: tier.name,
  threshold_points: tier.thresholdPoints,
  sort: tier.sort,
  perks: tier.perks as unknown[],
  paid_plan: tier.paidPlan,
}))

// ---------------------------------------------------------------------------
// Customers a demo sale can be attached to
// ---------------------------------------------------------------------------

function perksFor(tierId: string) {
  return DEMO_TIERS.find((tier) => tier.id === tierId)?.perks ?? []
}

export const DEMO_SALE_CUSTOMERS: SaleCustomer[] = [
  {
    id: "cust_demo_1",
    name: "Ash Ketchum",
    code: buildCode("customer", "4K7M2").encoded,
    tierId: "tier_regular",
    tierName: "Regular",
    perks: perksFor("tier_regular"),
    creditBalance: 1250,
    pointsBalance: 3120,
  },
  {
    id: "cust_demo_2",
    name: "Misty Waterflower",
    code: buildCode("customer", "9P3T6").encoded,
    tierId: "tier_member",
    tierName: "Member",
    perks: perksFor("tier_member"),
    creditBalance: 0,
    pointsBalance: 240,
  },
  {
    id: "cust_demo_3",
    name: "Brock Harrison",
    code: buildCode("customer", "2X5N8").encoded,
    tierId: "tier_legend",
    tierName: "Legend",
    perks: perksFor("tier_legend"),
    creditBalance: 4500,
    pointsBalance: 11400,
  },
]

/** One issued voucher, so scanning a GGV code on the Sell screen does something. */
export const DEMO_VOUCHERS: RewardVoucher[] = [
  {
    id: "redemption_demo_1",
    code: buildCode("voucher", "3H7K9").encoded,
    customer: "cust_demo_1",
    rewardName: "£5 off a single",
    type: "money_off",
    value: 500,
    expiresAt: null,
  },
]

/** Vouchers already spent this session. */
export const usedVoucherIds = new Set<string>()

// ---------------------------------------------------------------------------
// Sales, cash and labels
// ---------------------------------------------------------------------------

export interface DemoSale extends SaleRecord {
  lines: SaleLineDetail[]
  customerName: string | null
}

export const demoSales: DemoSale[] = []
export const demoCashSessions: CashSessionRecord[] = []
export const demoCashMovements: CashMovementRecord[] = []
export const demoLabelJobs: LabelJobDetail[] = []

/** Buy-ins the demo day already saw, so Home's tiles are not all zero. */
export interface DemoBuyIn {
  id: string
  number: string
  customerName: string
  payoutCash: number
  payoutCredit: number
  itemCount: number
  at: string
}

export const demoBuyIns: DemoBuyIn[] = []

let nextSale = 456
let nextSession = 12
let sequence = 1

export function demoId(prefix: string): string {
  sequence += 1
  return `${prefix}_${sequence.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function nextSaleNumber(): string {
  nextSale += 1
  return `GG-S-${String(nextSale).padStart(6, "0")}`
}

export function nextSessionRef(): string {
  nextSession += 1
  return `GG-CS-${String(nextSession).padStart(4, "0")}`
}

/** Today at a given hour and minute, as an ISO timestamp. */
function todayAt(hour: number, minute: number): string {
  const when = new Date()
  when.setHours(hour, minute, 0, 0)
  return when.toISOString()
}

function yesterdayAt(hour: number, minute: number): string {
  const when = new Date()
  when.setDate(when.getDate() - 1)
  when.setHours(hour, minute, 0, 0)
  return when.toISOString()
}

let seeded = false

/**
 * One shop morning: two sales already rung up, yesterday's closed drawer, a
 * buy-in and two labels waiting to print. Seeded on the first demo call
 * rather than at import, so the item store is fully built before it is read.
 */
export function ensureSeeded() {
  if (seeded) return
  seeded = true

  const items = itemStore()

  const soldCharizard: StockItemRecord = {
    id: "item_demo_sold_1",
    sku: buildCode("sealed", "5N2W8").encoded,
    kind: "sealed",
    game: "game_pokemon",
    title: "Surging Sparks Elite Trainer Box",
    qty: 0,
    cost: 3200,
    market_at_intake: 4995,
    price: 4995,
    status: "sold",
    location: "loc_showcase",
    source: "supplier",
    created: todayAt(9, 41),
  }
  const soldLlanowar: StockItemRecord = {
    id: "item_demo_sold_2",
    sku: buildCode("single", "W8Q4R").encoded,
    kind: "single",
    game: "game_mtg",
    card: "card_fdn_179",
    title: "Llanowar Elves",
    set_code: "fdn",
    number: "0179",
    finish: "foil",
    condition: "NM",
    qty: 1,
    cost: 120,
    market_at_intake: 240,
    price: 249,
    status: "sold",
    location: "loc_binder_b",
    source: "trade_in",
    created: todayAt(10, 12),
  }
  items.push(soldCharizard, soldLlanowar)

  demoSales.push(
    {
      id: "sale_demo_1",
      number: "GG-S-000455",
      customer: "cust_demo_1",
      customerName: "Ash Ketchum",
      subtotal: 4995,
      discount: 250,
      discount_source: "tier_perk",
      total: 4745,
      payment: "sumup_card",
      payment_split: { sumup_card: 4745 },
      points_earned: 593,
      status: "complete",
      created: todayAt(9, 41),
      lines: [
        {
          id: "sale_line_demo_1",
          sale: "sale_demo_1",
          item: soldCharizard.id,
          qty: 1,
          unit_price: 4995,
          // The Regular tier's 5 percent came off the whole sale, so it is
          // recorded once, on the sale. A line discount would count it twice.
          discount: 0,
          tax_scheme: "standard",
          status: "sold",
          sku: soldCharizard.sku,
          title: soldCharizard.title ?? "",
          condition: "",
        },
      ],
    },
    {
      id: "sale_demo_2",
      number: "GG-S-000456",
      customerName: null,
      subtotal: 249,
      discount: 0,
      total: 249,
      payment: "cash",
      payment_split: { cash: 249 },
      points_earned: 0,
      status: "complete",
      created: todayAt(10, 12),
      lines: [
        {
          id: "sale_line_demo_2",
          sale: "sale_demo_2",
          item: soldLlanowar.id,
          qty: 1,
          unit_price: 249,
          discount: 0,
          tax_scheme: "margin",
          status: "sold",
          sku: soldLlanowar.sku,
          title: soldLlanowar.title ?? "",
          condition: "NM",
        },
      ],
    }
  )

  demoBuyIns.push({
    id: "trade_demo_1",
    number: "GG-BI-000122",
    customerName: "Brock Harrison",
    payoutCash: 6500,
    payoutCredit: 2000,
    itemCount: 4,
    at: todayAt(10, 35),
  })

  demoCashSessions.push({
    id: "cash_session_demo_1",
    opened_by: "staff_demo",
    openedByName: "Demo Counter",
    opened_at: yesterdayAt(9, 2),
    float: 10000,
    closed_by: "staff_demo",
    closedByName: "Demo Counter",
    closed_at: yesterdayAt(17, 30),
    expected: 24850,
    counted: 24850,
    variance: 0,
    notes: "",
  })

  for (const [index, item] of [items[0], items[1]].entries()) {
    if (!item) continue
    demoLabelJobs.push({
      id: `label_demo_${index + 1}`,
      status: "queued",
      copies: 1,
      template: templateForItem(item.kind, item.completeness),
      itemId: item.id,
      code: item.sku,
      title: item.title ?? "",
      detail: itemDetailLine(item),
      condition: item.condition ?? "",
      price: item.price ?? 0,
      requestedAt: todayAt(9, 10),
    })
  }
}
