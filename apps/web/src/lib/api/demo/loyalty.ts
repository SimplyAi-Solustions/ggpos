/**
 * The demo shop's GG Guild: the programme, its rules, tiers and rewards, the
 * vouchers on the counter, the paid plans, the perks used this month, the
 * referrals and every points row behind the balances.
 *
 * In memory for the tab, like every other demo store. It refuses exactly
 * what the routes refuse, in the same sentences, so the end-to-end suite
 * proves the screens rather than a lenient fixture: a money-off voucher
 * cannot be marked used at the counter, a second active plan is refused, a
 * spent perk allowance says when the next one comes, and an adjustment can
 * never take a balance below zero.
 */
import {
  buildCode,
  displayCode,
  normaliseCode,
  parseTierPerk,
  resolveTier,
} from "@gg/shared"
import type { LoyaltyTier, TierPerk } from "@gg/shared"

import { boxArt } from "@/kit/placeholder-art"
import {
  currentPeriod,
  perkRefusal,
  walletFromPerks,
} from "@/features/loyalty/perks"
import { pointsNote } from "@/features/loyalty/ledger"
import {
  perkAllowance,
  pointsToNextTier,
  tierWindowPoints,
} from "@/features/loyalty/window"
import { findDemoCustomer, demoCustomers } from "@/lib/api/demo/customers"
import { DEMO_PROGRAMME, DEMO_TIERS, usedVoucherIds } from "@/lib/api/demo/store"
import type {
  CountedPerkType,
  CustomerGuild,
  LoyaltyProgrammeRecord,
  LoyaltyRewardRecord,
  LoyaltyRewardWrite,
  LoyaltyRuleRecord,
  LoyaltyRuleWrite,
  LoyaltyTierRecord,
  LoyaltyTierWrite,
  MembershipInput,
  MembershipRecord,
  MembershipRenewal,
  MembershipStatus,
  PerkWallet,
  PerkWalletEntry,
  PointsAdjustment,
  PointsLedgerPage,
  PointsLedgerRow,
  ReferralSummary,
  RewardType,
  VoucherDetail,
  VoucherStatus,
  VoucherSummary,
} from "@/lib/api/types"

const DAY = 86_400_000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString()
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

/** A refusal written for the counter, the way the routes write theirs. */
function refuse(message: string): never {
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// The programme, its rules, tiers and rewards
// ---------------------------------------------------------------------------

export const programme: LoyaltyProgrammeRecord = {
  id: "loyalty_programme_demo",
  enabled: true,
  name: "GG Guild",
  points_name: "GG Points",
  earn_per_pound_sales: DEMO_PROGRAMME.earnPerPoundSales,
  earn_on_trade_in_credit: DEMO_PROGRAMME.earnPerPoundTradeInCredit,
  points_per_pound_redemption: DEMO_PROGRAMME.pointsPerPoundRedemption,
  min_redeem_points: DEMO_PROGRAMME.minRedeemPoints,
  max_points_share_of_sale: DEMO_PROGRAMME.maxPointsShareOfSale,
  expiry_months_inactive: DEMO_PROGRAMME.expiryMonthsInactive,
  tier_window_months: DEMO_PROGRAMME.tierWindowMonths,
  welcome_bonus: DEMO_PROGRAMME.welcomeBonus,
  referral_bonus_referrer: DEMO_PROGRAMME.referralBonusReferrer,
  referral_bonus_referee: DEMO_PROGRAMME.referralBonusReferee,
  terms:
    "Points are earned on what you pay and are not transferable. The shop can change the programme with notice at the counter.",
}

/**
 * Two live rules, so the preview has something to stack and the list has a
 * live row and a dated one.
 */
export const rules: LoyaltyRuleRecord[] = [
  {
    id: "rule_saturday",
    name: "Saturday double points",
    type: "day_of_week",
    conditions: { weekdays: [6] },
    value: 2,
    active: true,
    priority: 20,
  },
  {
    id: "rule_sealed_bonus",
    name: "Sealed over £30",
    type: "fixed_bonus",
    conditions: { kinds: ["sealed"], minSpend: 3000 },
    value: 250,
    active: true,
    priority: 10,
  },
  {
    id: "rule_first_buy",
    name: "First purchase bonus",
    type: "first_purchase",
    conditions: {},
    value: 500,
    active: false,
    priority: 5,
  },
]

/**
 * The shop's tiers, the seed's own four: three earned on points and the one
 * paid plan. They are the rows `demo/store.ts` already serves as
 * `config.loyalty.tiers`, so the admin screen, the till's perk lookup and
 * the portal are all reading one list rather than three copies of it.
 */
export const tiers: LoyaltyTierRecord[] = DEMO_TIERS.map((tier) => ({
  id: tier.id,
  name: tier.name,
  threshold_points: tier.thresholdPoints,
  sort: tier.sort,
  perks: tier.perks as unknown[],
  paid_plan: tier.paidPlan,
  colour_token: `tier-${tier.name.toLowerCase().replace(/\s+/g, "-")}`,
}))

/** Five rewards with the kit's placeholder art, in a 4:3 frame. */
export const rewards: LoyaltyRewardRecord[] = [
  {
    id: "reward_five_off",
    name: "£5 off a single",
    description: "Five pounds off any single card.",
    cost_points: 500,
    type: "money_off",
    value: 500,
    stock_limit: 0,
    per_customer_limit: 0,
    active: true,
    imageUrl: boxArt([400, 300]),
  },
  {
    id: "reward_ten_credit",
    name: "£10 store credit",
    description: "Ten pounds of credit on the account, ready to spend.",
    cost_points: 1200,
    type: "store_credit",
    value: 1000,
    stock_limit: 0,
    per_customer_limit: 2,
    active: true,
    imageUrl: boxArt([400, 300]),
  },
  {
    id: "reward_sleeve_pack",
    name: "Sleeve pack",
    description: "A pack of 100 matte sleeves.",
    cost_points: 800,
    type: "free_item",
    value: 0,
    stock_limit: 20,
    per_customer_limit: 1,
    active: true,
    imageUrl: boxArt([400, 300]),
  },
  {
    id: "reward_friday_entry",
    name: "Friday night entry",
    description: "One entry to a Friday night tournament.",
    cost_points: 600,
    type: "event_entry",
    value: 1,
    stock_limit: 0,
    per_customer_limit: 0,
    active: true,
    imageUrl: boxArt([400, 300]),
  },
  {
    id: "reward_booster",
    name: "Free booster",
    description: "One booster from the current set.",
    cost_points: 450,
    type: "free_item",
    value: 0,
    stock_limit: 0,
    per_customer_limit: 0,
    active: false,
    starts_at: daysAhead(14).slice(0, 10),
    imageUrl: boxArt([400, 300]),
  },
]

export function demoLoyaltyAdmin() {
  return {
    programme: { ...programme },
    rules: rules.map((rule) => ({ ...rule })),
    tiers: tiers.map((tier) => ({ ...tier })),
    rewards: rewards.map((reward) => ({ ...reward })),
  }
}

export function demoSaveProgramme(
  patch: Partial<LoyaltyProgrammeRecord>
): LoyaltyProgrammeRecord {
  Object.assign(programme, patch)
  return { ...programme }
}

export function demoSaveRules(writes: LoyaltyRuleWrite[]): LoyaltyRuleRecord[] {
  for (const write of writes) {
    const { id: ruleId, ...fields } = write
    const existing = ruleId ? rules.find((row) => row.id === ruleId) : null
    if (existing) {
      Object.assign(existing, fields)
    } else {
      rules.push({ id: id("rule"), ...fields })
    }
  }
  return rules.map((rule) => ({ ...rule }))
}

export function demoSaveTiers(writes: LoyaltyTierWrite[]): LoyaltyTierRecord[] {
  for (const write of writes) {
    const { id: tierId, ...fields } = write
    const existing = tierId ? tiers.find((row) => row.id === tierId) : null
    if (existing) {
      Object.assign(existing, fields)
    } else {
      tiers.push({ id: id("tier"), ...fields })
    }
  }
  return tiers.map((tier) => ({ ...tier }))
}

export function demoSaveReward(write: LoyaltyRewardWrite): LoyaltyRewardRecord {
  const { id: rewardId, image, ...fields } = write
  const existing = rewardId ? rewards.find((row) => row.id === rewardId) : null
  const imageUrl = image ? URL.createObjectURL(image) : undefined
  if (existing) {
    Object.assign(existing, fields)
    if (imageUrl) existing.imageUrl = imageUrl
    return { ...existing }
  }
  const created: LoyaltyRewardRecord = {
    id: id("reward"),
    ...fields,
    imageUrl: imageUrl ?? boxArt([400, 300]),
  }
  rewards.push(created)
  return { ...created }
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

interface DemoLedgerRow extends PointsLedgerRow {
  customer: string
}

/**
 * Enough history for every branch of the profile: a welcome bonus outside
 * the twelve-month window, earnings inside it, a referral and a redemption.
 * Jasmine's rows add up to the 2,180 balance her record carries and to 2,580
 * inside the window, which is what makes her a Regular.
 */
export const ledger: DemoLedgerRow[] = [
  {
    id: "points_demo_1",
    customer: "cust_demo_1",
    delta: 100,
    reason: "welcome",
    balance_after: 100,
    created: daysAgo(412),
  },
  {
    id: "points_demo_2",
    customer: "cust_demo_1",
    delta: 300,
    reason: "earn_trade_in",
    balance_after: 400,
    created: daysAgo(96),
    ref: "GG-BI-000042",
  },
  {
    id: "points_demo_3",
    customer: "cust_demo_1",
    delta: 593,
    reason: "earn_sale",
    balance_after: 993,
    created: daysAgo(31),
    ref: "GG-S-000310",
  },
  {
    id: "points_demo_4",
    customer: "cust_demo_1",
    delta: 250,
    reason: "referral",
    balance_after: 1243,
    created: daysAgo(24),
  },
  {
    id: "points_demo_5",
    customer: "cust_demo_1",
    delta: 1437,
    reason: "earn_sale",
    balance_after: 2680,
    created: daysAgo(12),
    ref: "GG-S-000431",
  },
  {
    id: "points_demo_6",
    customer: "cust_demo_1",
    delta: -500,
    reason: "redeem",
    balance_after: 2180,
    created: daysAgo(6),
    note: "Redeemed for £5 off a single",
  },
  {
    id: "points_demo_7",
    customer: "cust_demo_2",
    delta: 100,
    reason: "welcome",
    balance_after: 100,
    created: daysAgo(203),
  },
  {
    id: "points_demo_8",
    customer: "cust_demo_2",
    delta: 240,
    reason: "earn_sale",
    balance_after: 340,
    created: daysAgo(200),
    ref: "GG-S-000188",
  },
  {
    id: "points_demo_9",
    customer: "cust_demo_3",
    delta: 100,
    reason: "welcome",
    balance_after: 100,
    created: daysAgo(61),
  },
  {
    id: "points_demo_10",
    customer: "cust_demo_3",
    delta: -10,
    reason: "adjust",
    balance_after: 90,
    created: daysAgo(40),
    note: "Rounding fix after a mis-keyed sale",
  },
]

export function demoPointsLedger(customerId: string): PointsLedgerRow[] {
  return ledger
    .filter((row) => row.customer === customerId)
    .sort((a, b) => b.created.localeCompare(a.created))
    .map((row) => ({
      id: row.id,
      delta: row.delta,
      reason: row.reason,
      balance_after: row.balance_after,
      created: row.created,
      ref: row.ref,
      note: pointsNote(row, { expiryMonths: programme.expiry_months_inactive }),
    }))
}

/** The same page the route serves, and whether it is the whole history. */
export function demoPointsLedgerPage(customerId: string): PointsLedgerPage {
  const rows = demoPointsLedger(customerId)
  return { rows: rows.slice(0, 100), complete: rows.length <= 100 }
}

/** The tiers in the shared evaluator's shape, perks parsed. */
function evaluatorTiers(): LoyaltyTier[] {
  return tiers.map((tier) => ({
    id: tier.id,
    name: tier.name ?? "",
    thresholdPoints: tier.threshold_points ?? 0,
    sort: tier.sort ?? 0,
    perks: (Array.isArray(tier.perks) ? tier.perks : [])
      .map(parseTierPerk)
      .filter((perk): perk is TierPerk => perk !== null),
    paidPlan: tier.paid_plan === true,
  }))
}

function windowPointsFor(customerId: string): number {
  return tierWindowPoints(
    ledger.filter((row) => row.customer === customerId),
    new Date(),
    programme.tier_window_months ?? 0
  )
}

/**
 * The tier a customer holds now: an active plan pins one, otherwise the
 * rolling window decides. Written back onto the demo customer, exactly as
 * the server writes `customer_private.tier`.
 */
export function recomputeTier(customerId: string): string | null {
  const entry = findDemoCustomer(customerId)
  if (!entry) return null
  const active = memberships.find(
    (row) => row.customer === customerId && row.status === "active"
  )
  // The shared helper, so the demo shop and the server can never disagree
  // about who holds what: a paid plan pins the tier, otherwise the rolling
  // window decides it.
  const tier = resolveTier(
    evaluatorTiers(),
    windowPointsFor(customerId),
    active?.tier ?? null
  )
  entry.private.tier = tier?.id ?? undefined
  return tier?.id ?? null
}

function postPoints(
  customerId: string,
  delta: number,
  reason: string,
  note?: string
): number {
  const entry = findDemoCustomer(customerId)
  if (!entry) refuse("That customer is not in the demo shop.")
  const balance = (entry.private.points_balance ?? 0) + delta
  entry.private.points_balance = balance
  ledger.push({
    id: id("points"),
    customer: customerId,
    delta,
    reason,
    balance_after: balance,
    created: new Date().toISOString(),
    note,
  })
  recomputeTier(customerId)
  return balance
}

export function demoAdjustPoints(input: PointsAdjustment): { balance: number } {
  const entry = findDemoCustomer(input.customer)
  if (!entry) refuse("That customer is not in the demo shop.")
  const balance = entry.private.points_balance ?? 0
  if (input.delta === 0) refuse("Enter the points to add or take away.")
  if (balance + input.delta < 0) {
    refuse(
      `That would take them to ${(balance + input.delta).toLocaleString("en-GB")} points. The most you can remove is ${balance.toLocaleString("en-GB")}.`
    )
  }
  return { balance: postPoints(input.customer, input.delta, "adjust", input.reason) }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

interface DemoMembership {
  id: string
  customer: string
  tier: string
  status: MembershipStatus
  started_at: string
  renews_at: string
  price: number
  payment_note: string
}

export const memberships: DemoMembership[] = [
  {
    id: "membership_demo_1",
    customer: "cust_demo_3",
    tier: "tier_pass",
    status: "active",
    started_at: daysAgo(48),
    renews_at: daysAhead(317),
    price: 6000,
    payment_note: "Paid by card at the counter",
  },
]

function tierName(tierId: string): string {
  return tiers.find((tier) => tier.id === tierId)?.name ?? "Tier"
}

function toMembership(row: DemoMembership): MembershipRecord {
  const entry = findDemoCustomer(row.customer)
  return {
    id: row.id,
    customer: row.customer,
    customerName: entry?.customer.name ?? "A customer",
    customerCode: entry?.customer.code ?? "",
    tier: row.tier,
    tierName: tierName(row.tier),
    status: row.status,
    started_at: row.started_at,
    renews_at: row.renews_at,
    price: row.price,
    payment_note: row.payment_note,
  }
}

export function demoMemberships(status?: MembershipStatus): MembershipRecord[] {
  return memberships
    .filter((row) => !status || row.status === status)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map(toMembership)
}

export function demoMembershipFor(customerId: string): MembershipRecord | null {
  const row = memberships.find(
    (entry) => entry.customer === customerId && entry.status === "active"
  )
  return row ? toMembership(row) : null
}

/** Now plus `months` calendar months, the way the route works it out. */
function monthsAhead(from: Date, months: number): string {
  const at = new Date(from.getTime())
  const day = at.getDate()
  at.setDate(1)
  at.setMonth(at.getMonth() + months)
  const lastDay = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate()
  at.setDate(Math.min(day, lastDay))
  return at.toISOString()
}

export function demoRecordMembership(input: MembershipInput): MembershipRecord {
  const entry = findDemoCustomer(input.customer)
  if (!entry) refuse("That customer is not in the demo shop.")
  const tier = tiers.find((row) => row.id === input.tier)
  if (!tier) refuse("That tier is not in the programme any more. Pick another.")
  if (tier.paid_plan !== true) {
    refuse(`${tier.name} is not a paid plan. Pick a tier that is.`)
  }
  if (memberships.some((row) => row.customer === input.customer && row.status === "active")) {
    refuse("That customer already has an active plan. Renew it instead.")
  }
  const row: DemoMembership = {
    id: id("membership"),
    customer: input.customer,
    tier: input.tier,
    status: "active",
    started_at: new Date().toISOString(),
    renews_at: monthsAhead(new Date(), input.months),
    price: input.price,
    payment_note: input.payment_note ?? "",
  }
  memberships.unshift(row)
  recomputeTier(input.customer)
  return toMembership(row)
}

export function demoRenewMembership(
  membershipId: string,
  input: MembershipRenewal
): MembershipRecord {
  const row = memberships.find((entry) => entry.id === membershipId)
  if (!row) refuse("That plan is not on file any more.")
  if (row.status === "cancelled") {
    refuse("That plan was cancelled. Record a new one instead.")
  }
  const from = new Date(row.renews_at) > new Date() ? new Date(row.renews_at) : new Date()
  row.renews_at = monthsAhead(from, input.months)
  row.status = "active"
  row.price = input.price
  if (input.payment_note) row.payment_note = input.payment_note
  recomputeTier(row.customer)
  return toMembership(row)
}

export function demoCancelMembership(membershipId: string): MembershipRecord {
  const row = memberships.find((entry) => entry.id === membershipId)
  if (!row) refuse("That plan is not on file any more.")
  row.status = "cancelled"
  recomputeTier(row.customer)
  return toMembership(row)
}

// ---------------------------------------------------------------------------
// Perks
// ---------------------------------------------------------------------------

interface DemoPerkUsage {
  customer: string
  perk_type: CountedPerkType
  period: string
  used_count: number
}

export const perkUsage: DemoPerkUsage[] = [
  {
    customer: "cust_demo_3",
    perk_type: "free_event_entries",
    period: currentPeriod(),
    used_count: 1,
  },
]

function tierFor(customerId: string): LoyaltyTier | null {
  const entry = findDemoCustomer(customerId)
  const tierId = entry?.private.tier
  if (!tierId) return null
  return evaluatorTiers().find((tier) => tier.id === tierId) ?? null
}

/**
 * `GET /api/vault/customers/:id/perks`: the tier the demo shop holds for
 * this customer, recomputed first the way the server recomputes it, and the
 * wallet that tier gives them this month.
 */
export function demoPerksWallet(customerId: string): PerkWallet {
  recomputeTier(customerId)
  const tier = tierFor(customerId)
  return {
    tier: tier ? { id: tier.id, name: tier.name } : null,
    perks: demoPerks(customerId),
  }
}

export function demoPerks(customerId: string): PerkWalletEntry[] {
  const tier = tierFor(customerId)
  if (!tier) return []
  const period = currentPeriod()
  const used: Partial<Record<CountedPerkType, number>> = {}
  for (const row of perkUsage) {
    if (row.customer === customerId && row.period === period) {
      used[row.perk_type] = row.used_count
    }
  }
  return walletFromPerks(tier.perks, used, period)
}

export function demoUsePerk(
  customerId: string,
  type: CountedPerkType,
  count = 1
): PerkWalletEntry {
  const allowed = perkAllowance(tierFor(customerId), type)
  if (allowed <= 0) refuse(perkRefusal(type, 0))
  const period = currentPeriod()
  let row = perkUsage.find(
    (entry) =>
      entry.customer === customerId &&
      entry.perk_type === type &&
      entry.period === period
  )
  if (!row) {
    row = { customer: customerId, perk_type: type, period, used_count: 0 }
    perkUsage.push(row)
  }
  if (row.used_count + count > allowed) refuse(perkRefusal(type, allowed))
  row.used_count += count
  return { type, value: allowed, allowed, used: row.used_count, period }
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

interface DemoVoucher {
  id: string
  number: string
  code: string
  customer: string
  /** The `loyalty_rewards` row it came from, as the real redemption has. */
  reward: string
  rewardName: string
  type: RewardType
  value: number
  status: VoucherStatus
  expiresAt: string | null
  created: string
}

/**
 * Two vouchers on the counter: Jasmine's money-off one, which is spent on a
 * basket at Sell, and Tom's free item, which is marked used at the counter.
 * `redemption_demo_1` is the same row `demo/store.ts` hands the Sell screen.
 */
export const vouchers: DemoVoucher[] = [
  {
    id: "redemption_demo_1",
    number: "GG-V-000012",
    code: buildCode("voucher", "3H7K9").encoded,
    customer: "cust_demo_1",
    reward: "reward_five_off",
    rewardName: "£5 off a single",
    type: "money_off",
    value: 500,
    status: "issued",
    expiresAt: daysAhead(84),
    created: daysAgo(6),
  },
  {
    id: "redemption_demo_2",
    number: "GG-V-000013",
    code: buildCode("voucher", "8P2RT").encoded,
    customer: "cust_demo_2",
    reward: "reward_sleeve_pack",
    rewardName: "Sleeve pack",
    type: "free_item",
    value: 0,
    status: "issued",
    expiresAt: daysAhead(61),
    created: daysAgo(3),
  },
]

function statusOf(row: DemoVoucher): VoucherStatus {
  if (row.status === "issued" && usedVoucherIds.has(row.id)) return "used"
  return row.status
}

function toSummary(row: DemoVoucher): VoucherSummary {
  return {
    id: row.id,
    code: row.code,
    number: row.number,
    status: statusOf(row),
    rewardName: row.rewardName,
    type: row.type,
    value: row.value,
    expiresAt: row.expiresAt,
    created: row.created,
  }
}

function toDetail(row: DemoVoucher): VoucherDetail {
  const entry = findDemoCustomer(row.customer)
  return {
    ...toSummary(row),
    customer: {
      id: row.customer,
      code: entry?.customer.code ?? "",
      name: entry?.customer.name ?? "A customer",
    },
  }
}

export function demoVoucherByCode(code: string): VoucherDetail | null {
  const needle = normaliseCode(code)
  const row = vouchers.find((entry) => entry.code === needle)
  return row ? toDetail(row) : null
}

export function demoOpenVouchers(customerId: string): VoucherSummary[] {
  return vouchers
    .filter((row) => row.customer === customerId)
    .map(toSummary)
    .sort((a, b) => b.created.localeCompare(a.created))
}

export function demoUseVoucher(code: string): VoucherDetail {
  const needle = normaliseCode(code)
  const row = vouchers.find((entry) => entry.code === needle)
  if (!row) refuse(`No voucher has the code ${displayCode(needle)}. Check it and try again.`)
  const status = statusOf(row)
  if (row.type === "money_off") {
    refuse("Use this one on the sale: scan it at Sell.")
  }
  if (status !== "issued") {
    refuse(
      status === "used"
        ? "That voucher has already been used."
        : status === "expired"
          ? "That voucher has expired. The points are not coming back."
          : "That voucher was cancelled."
    )
  }
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    refuse("That voucher is past its expiry date.")
  }
  row.status = "used"
  return toDetail(row)
}

export function demoCancelVoucher(code: string): VoucherDetail {
  const needle = normaliseCode(code)
  const row = vouchers.find((entry) => entry.code === needle)
  if (!row) refuse(`No voucher has the code ${displayCode(needle)}. Check it and try again.`)
  if (statusOf(row) !== "issued") {
    refuse("Only an open voucher can be cancelled.")
  }
  row.status = "cancelled"
  // What the customer actually paid for it, off the reward it came from,
  // never a figure this store made up.
  const spent = rewards.find((reward) => reward.id === row.reward)?.cost_points ?? 0
  postPoints(row.customer, spent, "adjust", `Cancelled voucher ${row.number}`)
  return toDetail(row)
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

interface DemoReferral {
  referrer: string
  referee: string
  status: "pending" | "earned"
}

export const referrals: DemoReferral[] = [
  { referrer: "cust_demo_1", referee: "cust_demo_2", status: "earned" },
  { referrer: "cust_demo_1", referee: "cust_demo_4", status: "pending" },
]

export function demoReferrals(customerId: string): ReferralSummary {
  const referredBy = referrals.find((row) => row.referee === customerId)
  const by = referredBy ? findDemoCustomer(referredBy.referrer) : null
  return {
    referredBy: by
      ? { id: by.customer.id, name: by.customer.name, code: by.customer.code }
      : null,
    earned: referrals.filter(
      (row) => row.referrer === customerId && row.status === "earned"
    ).length,
    pending: referrals.filter(
      (row) => row.referrer === customerId && row.status === "pending"
    ).length,
  }
}

/**
 * The create route's own check on a referral code: it has to be a customer,
 * and it cannot be the customer being created.
 */
export function demoResolveReferral(code: string, selfId?: string): string {
  const entry = findDemoCustomer(code)
  if (!entry) {
    refuse(`No customer has the code ${displayCode(normaliseCode(code))}. Check it with them.`)
  }
  if (selfId && entry.customer.id === selfId) {
    refuse("That is this customer's own code. Ask who sent them in.")
  }
  return entry.customer.id
}

/** A new customer's referral, recorded pending until their first purchase. */
export function demoRecordReferral(referrerId: string, refereeId: string) {
  referrals.push({ referrer: referrerId, referee: refereeId, status: "pending" })
}

// ---------------------------------------------------------------------------
// The Guild block on a customer profile
// ---------------------------------------------------------------------------

export function demoGuild(customerId: string): CustomerGuild {
  const entry = findDemoCustomer(customerId)
  if (!entry) refuse("That customer is not in the demo shop.")
  // The server re-evaluates a tier after every points row and every
  // membership change; the demo shop does it as the wallet is read, which
  // is what makes a seeded plan pin a seeded customer's tier.
  const wallet = demoPerksWallet(customerId)
  const page = demoPointsLedgerPage(customerId)
  const windowPoints = page.complete ? windowPointsFor(customerId) : null
  const next =
    windowPoints === null ? null : pointsToNextTier(evaluatorTiers(), windowPoints)
  return {
    tier: wallet.tier,
    windowPoints,
    pointsBalance: entry.private.points_balance ?? 0,
    next: next ? { name: next.tier.name, points: next.points } : null,
    perks: wallet.perks,
    membership: demoMembershipFor(customerId),
    referral: demoReferrals(customerId),
    vouchers: demoOpenVouchers(customerId),
  }
}

/** Every demo customer starts on the tier their own ledger earns them. */
export function ensureTiers() {
  for (const entry of demoCustomers) recomputeTier(entry.customer.id)
}

/**
 * The welcome bonus a new card earns, written once, exactly as the create
 * hook writes it on the server.
 */
export function demoWelcomeBonus(customerId: string): number {
  const bonus = programme.welcome_bonus ?? 0
  if (programme.enabled === false || bonus <= 0) return 0
  if (ledger.some((row) => row.customer === customerId && row.reason === "welcome")) {
    return 0
  }
  postPoints(customerId, bonus, "welcome")
  return bonus
}
