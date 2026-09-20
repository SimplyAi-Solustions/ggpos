/**
 * Selling: the step-up, the loyalty setup the points preview needs, the
 * customer and voucher lookups the scan field makes, sale completion, refunds
 * and the numbers Home counts.
 *
 * Live mode uses the transactional routes in docs/api-contract.md ("Sales",
 * "Step-up"); demo mode answers the same shapes from memory.
 */
import {
  parseTierPerk,
  type LoyaltyProgramme,
  type LoyaltyRule,
  type LoyaltyTier,
  type TierPerk,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import * as demo from "@/lib/api/demo/sales"
import type {
  CompleteSalePayload,
  CompleteSaleResult,
  CustomerPrivateRecord,
  CustomerRecord,
  ItemRecord,
  LoyaltySetup,
  RefundSalePayload,
  RefundSaleResult,
  RewardVoucher,
  SaleCustomer,
  SaleDetail,
  SaleLineRecord,
  SaleRecord,
  SaleSummary,
  StepUpToken,
  TodayStats,
} from "@/lib/api/types"

export { DEMO_STEP_UP_PASSWORD } from "@/lib/api/demo/sales"

const STEP_UP_HEADER = "X-Step-Up"

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

/** Midnight this morning, as PocketBase writes its timestamps. */
function startOfToday(): string {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.toISOString().replace("T", " ").slice(0, 19)
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

/**
 * Re-checks the signed-in staff member's password. The token is good for ten
 * minutes and goes in `X-Step-Up` on the routes that need it.
 */
export async function getStepUp(password: string): Promise<StepUpToken> {
  if (isDemo()) {
    if (password !== demo.DEMO_STEP_UP_PASSWORD) {
      throw new Error("That password is not right. Try again.")
    }
    const expires = new Date()
    expires.setMinutes(expires.getMinutes() + 10)
    return { token: "demo-step-up", expiresAt: expires.toISOString() }
  }
  const result = await pb.send<{ token: string; expires_at: string }>(
    "/api/vault/step-up",
    { method: "POST", body: { password } }
  )
  return { token: result.token, expiresAt: result.expires_at }
}

// ---------------------------------------------------------------------------
// Loyalty, customers and vouchers
// ---------------------------------------------------------------------------

interface ProgrammeRecord {
  enabled?: boolean
  earn_per_pound_sales?: number
  earn_on_trade_in_credit?: number
  points_per_pound_redemption?: number
  min_redeem_points?: number
  max_points_share_of_sale?: number
  expiry_months_inactive?: number
  tier_window_months?: number
  welcome_bonus?: number
  referral_bonus_referrer?: number
  referral_bonus_referee?: number
}

interface TierRecord {
  id: string
  name: string
  threshold_points?: number
  sort?: number
  perks?: unknown
  paid_plan?: boolean
}

function toTier(record: TierRecord): LoyaltyTier {
  const raw = Array.isArray(record.perks) ? record.perks : []
  return {
    id: record.id,
    name: record.name,
    thresholdPoints: record.threshold_points ?? 0,
    sort: record.sort ?? 0,
    perks: raw
      .map(parseTierPerk)
      .filter((perk): perk is TierPerk => perk !== null),
    paidPlan: record.paid_plan === true,
  }
}

/**
 * The live programme, its rules and its tiers, so the points preview on the
 * Sell screen is the same arithmetic the server runs. `loyalty_rules` is
 * admin-only, so ordinary staff get the base rate and no rule bonuses; the
 * server still applies them, and the sale response carries the real figure.
 */
export async function getLoyaltySetup(): Promise<LoyaltySetup> {
  if (isDemo()) return demo.loyaltySetup()

  const [programme, tiers] = await Promise.all([
    pb.collection("loyalty_programme").getFirstListItem<ProgrammeRecord>(""),
    pb.collection("loyalty_tiers").getFullList<TierRecord>({ sort: "sort" }),
  ])
  const rules = await pb
    .collection("loyalty_rules")
    .getFullList<{
      id: string
      name: string
      type: LoyaltyRule["type"]
      conditions?: LoyaltyRule["conditions"]
      value?: number
      active?: boolean
      priority?: number
      starts_at?: string
      ends_at?: string
    }>({ filter: "active = true", sort: "-priority" })
    .catch(() => [])

  return {
    programme: {
      enabled: programme.enabled !== false,
      earnPerPoundSales: programme.earn_per_pound_sales ?? 0,
      earnPerPoundTradeInCredit: programme.earn_on_trade_in_credit ?? 0,
      pointsPerPoundRedemption: programme.points_per_pound_redemption ?? 100,
      minRedeemPoints: programme.min_redeem_points ?? 0,
      maxPointsShareOfSale: programme.max_points_share_of_sale ?? 0,
      expiryMonthsInactive: programme.expiry_months_inactive ?? 0,
      tierWindowMonths: programme.tier_window_months ?? 12,
      welcomeBonus: programme.welcome_bonus ?? 0,
      referralBonusReferrer: programme.referral_bonus_referrer ?? 0,
      referralBonusReferee: programme.referral_bonus_referee ?? 0,
    },
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      type: rule.type,
      conditions: rule.conditions ?? {},
      value: rule.value ?? 0,
      active: rule.active !== false,
      priority: rule.priority ?? 0,
      startsAt: rule.starts_at || null,
      endsAt: rule.ends_at || null,
    })),
    tiers: tiers.map(toTier),
  }
}

/** The programme on its own, for the buy-in wizard's credit bonus preview. */
export async function getLoyaltyProgramme(): Promise<LoyaltyProgramme> {
  const setup = await getLoyaltySetup()
  return setup.programme
}

type PrivateWithCustomer = CustomerPrivateRecord & {
  expand?: { customer?: CustomerRecord; tier?: TierRecord }
}

function toSaleCustomer(row: PrivateWithCustomer): SaleCustomer {
  const customer = row.expand?.customer
  const tier = row.expand?.tier
  return {
    id: row.customer,
    name: customer?.name ?? "",
    code: customer?.code ?? "",
    tierId: tier?.id ?? null,
    tierName: tier?.name ?? null,
    perks: tier ? toTier(tier).perks : [],
    creditBalance: row.credit_balance ?? 0,
    pointsBalance: row.points_balance ?? 0,
  }
}

/** Name or code, for the Sell screen's "Attach customer" sheet. */
export async function findCustomersForSale(query: string): Promise<SaleCustomer[]> {
  if (isDemo()) return demo.findCustomers(query)
  const needle = quote(query.trim())
  const filter = needle
    ? `customer.name ~ "${needle}" || customer.code ~ "${needle}" || customer.phone ~ "${needle}"`
    : ""
  const page = await pb.collection("customer_private").getList<PrivateWithCustomer>(1, 8, {
    filter,
    expand: "customer,tier",
    sort: "-updated",
  })
  return page.items.map(toSaleCustomer)
}

/** The customer behind a scanned GGC code, or null. */
export async function getCustomerForSale(code: string): Promise<SaleCustomer | null> {
  if (isDemo()) return demo.customerByCode(code)
  const rows = await pb.collection("customer_private").getList<PrivateWithCustomer>(1, 1, {
    filter: `customer.code = "${quote(code)}"`,
    expand: "customer,tier",
  })
  const row = rows.items[0]
  return row ? toSaleCustomer(row) : null
}

interface RedemptionRecord {
  id: string
  code?: string
  customer: string
  status?: string
  expires_at?: string
  expand?: {
    reward?: { name?: string; type?: RewardVoucher["type"]; value?: number }
  }
}

/** An issued, unexpired voucher for this code, or null. */
export async function getVoucher(code: string): Promise<RewardVoucher | null> {
  if (isDemo()) return demo.voucherByCode(code)
  const page = await pb.collection("reward_redemptions").getList<RedemptionRecord>(1, 1, {
    filter: `code = "${quote(code)}" && status = "issued"`,
    expand: "reward",
  })
  const row = page.items[0]
  if (!row) return null
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null
  return {
    id: row.id,
    code: row.code ?? code,
    customer: row.customer,
    rewardName: row.expand?.reward?.name ?? "Reward",
    type: row.expand?.reward?.type ?? "money_off",
    value: row.expand?.reward?.value ?? 0,
    expiresAt: row.expires_at || null,
  }
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

/** One transaction on the server: stock, ledgers, cash and points together. */
export async function completeSale(
  payload: CompleteSalePayload
): Promise<CompleteSaleResult> {
  if (isDemo()) return demo.completeSale(payload)
  return pb.send<CompleteSaleResult>("/api/vault/sales/complete", {
    method: "POST",
    body: payload,
  })
}

/** Per line, with a reason, behind a step-up token. */
export async function refundSale(
  id: string,
  payload: RefundSalePayload,
  stepUpToken: string
): Promise<RefundSaleResult> {
  if (isDemo()) return demo.refundSale(id, payload)
  return pb.send<RefundSaleResult>(`/api/vault/sales/${id}/refund`, {
    method: "POST",
    body: payload,
    headers: { [STEP_UP_HEADER]: stepUpToken },
  })
}

type ExpandedSale = SaleRecord & { expand?: { customer?: CustomerRecord } }

/** Today's sales, newest first, for the history sheet and Home. */
export async function listSales(limit = 20): Promise<SaleSummary[]> {
  if (isDemo()) return demo.listSales(limit)
  const page = await pb.collection("sales").getList<ExpandedSale>(1, limit, {
    filter: `created >= "${startOfToday()}"`,
    expand: "customer",
    sort: "-created",
  })
  const counts = await Promise.all(
    page.items.map((sale) =>
      pb
        .collection("sale_lines")
        .getList(1, 1, { filter: `sale = "${quote(sale.id)}"` })
        .then((result) => result.totalItems)
        .catch(() => 0)
    )
  )
  return page.items.map((sale, index) => ({
    id: sale.id,
    number: sale.number,
    total: sale.total ?? 0,
    payment: sale.payment ?? "cash",
    status: sale.status ?? "complete",
    customerName: sale.expand?.customer?.name ?? null,
    at: sale.created ?? "",
    lineCount: counts[index] ?? 0,
  }))
}

type ExpandedSaleLine = SaleLineRecord & { expand?: { item?: ItemRecord } }

/** One sale with its lines, for the refund sheet and the undo. */
export async function getSale(id: string): Promise<SaleDetail | null> {
  if (isDemo()) return demo.getSale(id)
  const sale = await pb
    .collection("sales")
    .getOne<ExpandedSale>(id, { expand: "customer" })
    .catch(() => null)
  if (!sale) return null
  const lines = await pb.collection("sale_lines").getFullList<ExpandedSaleLine>({
    filter: `sale = "${quote(id)}"`,
    expand: "item",
    sort: "created",
  })
  return {
    ...sale,
    customerName: sale.expand?.customer?.name ?? null,
    lines: lines.map((line) => ({
      ...line,
      sku: line.expand?.item?.sku ?? "",
      title: line.expand?.item?.title ?? "",
      condition: line.expand?.item?.condition ?? "",
    })),
  }
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

interface TradeInRow {
  id: string
  number: string
  payout_cash?: number
  payout_credit?: number
  completed_at?: string
  created?: string
  expand?: { customer?: CustomerRecord }
}

/**
 * Home's four tiles and its recent list. Counted from the day's own rows
 * rather than `daily_stats`, which is built nightly and would be a day late
 * on the screen that says "today".
 */
export async function getTodayStats(): Promise<TodayStats> {
  if (isDemo()) return demo.todayStats()

  const since = startOfToday()
  const [sales, tradeIns, movements] = await Promise.all([
    pb.collection("sales").getFullList<SaleRecord & { expand?: { customer?: CustomerRecord } }>({
      filter: `created >= "${since}"`,
      expand: "customer",
      sort: "-created",
    }),
    pb.collection("trade_ins").getFullList<TradeInRow>({
      filter: `status = "completed" && completed_at >= "${since}"`,
      expand: "customer",
      sort: "-completed_at",
    }),
    pb.collection("cash_movements").getFullList<{
      type: string
      amount?: number
      created?: string
    }>({ filter: `created >= "${since}"` }),
  ])

  const salesByPayment: TodayStats["salesByPayment"] = {}
  let salesTotal = 0
  for (const sale of sales) {
    if (sale.status === "refunded") continue
    salesTotal += sale.total ?? 0
    for (const [method, amount] of Object.entries(sale.payment_split ?? {})) {
      const key = method as keyof TodayStats["salesByPayment"]
      salesByPayment[key] = (salesByPayment[key] ?? 0) + (amount ?? 0)
    }
  }

  const soldLines = await pb
    .collection("sale_lines")
    .getFullList<SaleLineRecord>({ filter: `created >= "${since}" && status = "sold"` })
    .catch(() => [] as SaleLineRecord[])

  const cashOut = movements
    .filter(
      (movement) =>
        movement.type === "payout" ||
        movement.type === "bank_drop" ||
        movement.type === "refund"
    )
    .reduce((total, movement) => total + Math.abs(movement.amount ?? 0), 0)

  const itemsIn = await pb
    .collection("items")
    .getList(1, 1, { filter: `created >= "${since}"` })
    .then((page) => page.totalItems)
    .catch(() => 0)

  return {
    salesCount: sales.filter((sale) => sale.status !== "refunded").length,
    salesTotal,
    salesByPayment,
    buyInCount: tradeIns.length,
    buyInTotal: tradeIns.reduce(
      (total, row) => total + (row.payout_cash ?? 0) + (row.payout_credit ?? 0),
      0
    ),
    cashOut,
    creditIssued: tradeIns.reduce((total, row) => total + (row.payout_credit ?? 0), 0),
    itemsIn,
    itemsOut: soldLines.reduce((count, line) => count + (line.qty ?? 0), 0),
    recent: [
      ...sales.map((sale) => ({
        id: sale.id,
        kind: "sale" as const,
        number: sale.number,
        total: sale.total ?? 0,
        detail: sale.expand?.customer?.name ?? "Counter sale",
        at: sale.created ?? "",
      })),
      ...tradeIns.map((row) => ({
        id: row.id,
        kind: "buy_in" as const,
        number: row.number,
        total: (row.payout_cash ?? 0) + (row.payout_credit ?? 0),
        detail: row.expand?.customer?.name ?? "Buy-in",
        at: row.completed_at ?? row.created ?? "",
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10),
  }
}
