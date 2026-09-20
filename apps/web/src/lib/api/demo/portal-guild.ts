import { buildCode } from "@gg/shared"

import { boxArt } from "@/kit/placeholder-art"
import {
  demoAddPoints,
  demoCreditLedger,
  findDemoCustomer,
} from "@/lib/api/demo/customers"
import { demoPortalCustomerId } from "@/lib/api/demo/portal-seed"
import { DEMO_TIERS } from "@/lib/api/demo/store"
import type {
  GuildSummary,
  PortalReward,
  PortalVoucher,
  RewardReason,
} from "@/lib/api/guild"
import type {
  CountedPerkType,
  PerkWalletEntry,
  PointsLedgerRow,
  RewardType,
} from "@/lib/api/types"
import type { LoyaltyTier, TierPerk } from "@gg/shared"

/**
 * GG Guild in the demo shop: the tier, the perks, the rewards catalogue, the
 * vouchers and the points ledger behind them.
 *
 * Seeded so every state a screen can be in is reachable without a server: a
 * reward the demo customer can afford, one they cannot, one that has sold
 * out, one they have already had, a store-credit one that pays out on the
 * spot, an open voucher, an expired one and a used one, and a points history
 * with every reason in it.
 *
 * The figures agree with each other on purpose. The ledger's deltas add up
 * to the balance the counter's own demo book holds for Jasmine Okafor
 * (2,180), the rows inside the rolling window add up to the tier points the
 * Guild screen shows (4,080), and every `redeem` row has a voucher beside
 * it. Nothing is persisted: a reload starts the demo shop over.
 */

const DAY = 86_400_000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString()
}

/** The programme's own name for its points, as the seed sets it. */
const POINTS_NAME = "GG Points"

/** `loyalty_programme.tier_window_months` in the seed. */
const TIER_WINDOW_MONTHS = 12

/** `referral_bonus_referrer` and `referral_bonus_referee` in the seed. */
const REFERRAL_BONUS = 250

/** `settings.rewards.voucher_days`, the default the route uses. */
const VOUCHER_DAYS = 90

/** Reward art: a plain 4:3 frame, which is what the portal renders them in. */
const REWARD_ART = boxArt([200, 150])

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * The counted perks the demo shop hands out on top of the seed's own.
 *
 * `DEMO_TIERS` in `store.ts` is the demo shop's one tier table, the seed's
 * figures in the shared evaluator's shapes, and it stays the source for
 * every perk a sale actually applies. Free event entries and lounge hours
 * are not applied by a sale at all: staff mark one used at the counter. So
 * the demo adds them here, where the only thing they change is that the
 * portal's wallet shows a monthly counter, rather than editing a table the
 * Sell screen prices against.
 */
const EXTRA_COUNTED: Record<string, { type: CountedPerkType; allowed: number }[]> = {
  tier_regular: [
    { type: "free_event_entries", allowed: 2 },
    { type: "lounge_hours", allowed: 12 },
  ],
}

/** What the headline demo card has used of this month's allowances. */
const USED_THIS_MONTH: Record<CountedPerkType, number> = {
  free_event_entries: 1,
  lounge_hours: 3,
}

/** `YYYY-MM` in Europe/London, the period `perk_usage` is keyed on. */
function currentPeriod(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  const year = parts.find((part) => part.type === "year")?.value ?? "0000"
  const month = parts.find((part) => part.type === "month")?.value ?? "01"
  return `${year}-${month}`
}

function toWalletEntry(
  perk: TierPerk,
  period: string,
  used: Record<CountedPerkType, number>
): PerkWalletEntry {
  switch (perk.type) {
    case "free_event_entries":
    case "lounge_hours":
      return {
        type: perk.type,
        value: perk.value,
        allowed: perk.value,
        used: used[perk.type] ?? 0,
        period,
      }
    case "percent_off":
      return { type: perk.type, value: perk.value, scope: perk.scope }
    case "points_multiplier":
      return { type: perk.type, value: perk.value }
    default:
      return { type: perk.type }
  }
}

// ---------------------------------------------------------------------------
// The points ledger
// ---------------------------------------------------------------------------

interface DemoPointsRow extends PointsLedgerRow {
  customer: string
}

/**
 * Jasmine's ledger, oldest first, so the running balance is readable.
 *
 * Every `note` is written the way the route writes one, because the portal
 * shows the server's sentence when there is one and only falls back to its
 * own wording when there is not.
 */
const demoPointsRows: DemoPointsRow[] = [
  {
    id: "pts_demo_1",
    customer: "cust_demo_1",
    delta: 100,
    reason: "welcome",
    note: "Welcome bonus",
    balance_after: 100,
    created: daysAgo(412),
  },
  {
    id: "pts_demo_2",
    customer: "cust_demo_1",
    delta: 1240,
    reason: "earn_sale",
    ref: "GG-S-000118",
    note: "Earned on a £124.00 sale",
    balance_after: 1340,
    created: daysAgo(300),
  },
  {
    id: "pts_demo_3",
    customer: "cust_demo_1",
    delta: 250,
    reason: "referral",
    note: "Referral bonus",
    balance_after: 1590,
    created: daysAgo(210),
  },
  {
    id: "pts_demo_4",
    customer: "cust_demo_1",
    delta: 680,
    reason: "earn_sale",
    ref: "GG-S-000143",
    note: "Earned on a £68.00 sale",
    balance_after: 2270,
    created: daysAgo(160),
  },
  {
    id: "pts_demo_5",
    customer: "cust_demo_1",
    delta: -1200,
    reason: "redeem",
    ref: "GG-V-000004",
    note: "Redeemed for Tournament entry",
    balance_after: 1070,
    created: daysAgo(140),
  },
  {
    id: "pts_demo_6",
    customer: "cust_demo_1",
    delta: 920,
    reason: "earn_sale",
    ref: "GG-S-000176",
    note: "Earned on a £92.00 sale",
    balance_after: 1990,
    created: daysAgo(96),
  },
  {
    id: "pts_demo_7",
    customer: "cust_demo_1",
    delta: -300,
    reason: "redeem",
    ref: "GG-V-000006",
    note: "Redeemed for GG lanyard",
    balance_after: 1690,
    created: daysAgo(60),
  },
  {
    id: "pts_demo_8",
    customer: "cust_demo_1",
    delta: 210,
    reason: "earn_trade_in",
    ref: "GG-BI-000061",
    note: "Earned on £42.00 taken as credit",
    balance_after: 1900,
    created: daysAgo(38),
  },
  {
    id: "pts_demo_9",
    customer: "cust_demo_1",
    delta: 300,
    reason: "earn_sale",
    ref: "GG-S-000201",
    note: "Earned on a £30.00 sale",
    balance_after: 2200,
    created: daysAgo(16),
  },
  {
    id: "pts_demo_10",
    customer: "cust_demo_1",
    delta: 150,
    reason: "rule_bonus",
    ref: "GG-S-000201",
    note: "Weekend bonus on a £30.00 sale",
    balance_after: 2350,
    created: daysAgo(16),
  },
  {
    id: "pts_demo_11",
    customer: "cust_demo_1",
    delta: -500,
    reason: "redeem",
    ref: "GG-V-000007",
    note: "Redeemed for Free booster pack",
    balance_after: 1850,
    created: daysAgo(9),
  },
  {
    id: "pts_demo_12",
    customer: "cust_demo_1",
    delta: 330,
    reason: "earn_sale",
    ref: "GG-S-000212",
    note: "Earned on a £33.00 sale",
    balance_after: 2180,
    created: daysAgo(2),
  },
]

/**
 * The same rule `tierWindowPoints` applies on the server: everything inside
 * the rolling window except the rows that spend or expire points, because
 * spending points never costs a tier.
 */
function windowPointsFor(customerId: string, now = new Date()): number {
  const from = new Date(now.getTime())
  from.setMonth(from.getMonth() - TIER_WINDOW_MONTHS)
  return demoPointsRows
    .filter((row) => row.customer === customerId)
    .filter((row) => row.reason !== "redeem" && row.reason !== "expire")
    .filter((row) => new Date(row.created).getTime() >= from.getTime())
    .reduce((sum, row) => sum + row.delta, 0)
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

interface DemoRewardSeed {
  id: string
  name: string
  description_html: string
  cost_points: number
  type: RewardType
  value: number
  /** null when the shop has not capped it. */
  stock_limit: number | null
  per_customer_limit: number | null
  /** Redemptions by everybody else, which the demo does not carry rows for. */
  redeemed_elsewhere: number
  /** Set in the future for a reward whose window has not opened yet. */
  starts_at?: string
}

const DEMO_REWARDS: DemoRewardSeed[] = [
  {
    id: "reward_booster",
    name: "Free booster pack",
    description_html:
      "<p>Any current Pokémon or Lorcana booster from the counter display.</p><p>Ask for it when you are next in. One pack per voucher.</p>",
    cost_points: 500,
    type: "free_item",
    value: 0,
    stock_limit: null,
    per_customer_limit: null,
    redeemed_elsewhere: 34,
  },
  {
    id: "reward_credit",
    name: "£5 store credit",
    description_html:
      "<p>Five pounds on your account, to spend on anything in the shop.</p>",
    cost_points: 750,
    type: "store_credit",
    value: 500,
    stock_limit: null,
    per_customer_limit: null,
    redeemed_elsewhere: 21,
  },
  {
    id: "reward_money_off",
    name: "£10 off a purchase",
    description_html:
      "<p>Ten pounds off one purchase of £30 or more. Scanned at the till.</p>",
    cost_points: 1000,
    type: "money_off",
    value: 1000,
    stock_limit: null,
    per_customer_limit: 2,
    redeemed_elsewhere: 12,
  },
  {
    id: "reward_entry",
    name: "Tournament entry",
    description_html:
      "<p>Entry to one Friday Night Pokémon or Lorcana tournament.</p><p>Tell us which week when you book.</p>",
    cost_points: 1200,
    type: "event_entry",
    value: 0,
    stock_limit: 12,
    per_customer_limit: null,
    redeemed_elsewhere: 8,
  },
  {
    id: "reward_etb",
    name: "Elite Trainer Box",
    description_html:
      "<p>A sealed Elite Trainer Box from the current set, while they last.</p>",
    cost_points: 2000,
    type: "free_item",
    value: 0,
    stock_limit: 6,
    per_customer_limit: 1,
    redeemed_elsewhere: 6,
  },
  {
    id: "reward_lanyard",
    name: "GG lanyard",
    description_html: "<p>A shop lanyard for your deck box keys. One each.</p>",
    cost_points: 300,
    type: "free_item",
    value: 0,
    stock_limit: null,
    per_customer_limit: 1,
    redeemed_elsewhere: 48,
  },
  {
    id: "reward_retro",
    name: "Retro shelf pick",
    description_html:
      "<p>Any boxed retro game on the shelf up to £25, yours.</p><p>Complete in box, our pick of stock on the day.</p>",
    cost_points: 5000,
    type: "custom",
    value: 0,
    stock_limit: null,
    per_customer_limit: null,
    redeemed_elsewhere: 3,
  },
  {
    id: "reward_xmas",
    name: "Christmas mystery box",
    description_html: "<p>A mixed box of singles, sealed and one retro title.</p>",
    cost_points: 1000,
    type: "free_item",
    value: 0,
    stock_limit: 20,
    per_customer_limit: 1,
    redeemed_elsewhere: 0,
    // Not open yet, so it is not in the catalogue at all; redeeming it by id
    // is the race the route refuses with `not_yet`.
    starts_at: daysAhead(40),
  },
]

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

interface DemoVoucher extends PortalVoucher {
  customer: string
  rewardId: string
}

function voucherCode(body: string): string {
  return buildCode("voucher", body).encoded
}

const demoVoucherRows: DemoVoucher[] = [
  {
    id: "vch_demo_1",
    customer: "cust_demo_1",
    rewardId: "reward_booster",
    number: "GG-V-000007",
    code: voucherCode("7QB2M"),
    reward: { name: "Free booster pack", type: "free_item", value: 0 },
    status: "issued",
    expires_at: daysAhead(VOUCHER_DAYS - 9),
    created: daysAgo(9),
  },
  {
    id: "vch_demo_2",
    customer: "cust_demo_1",
    rewardId: "reward_entry",
    number: "GG-V-000004",
    code: voucherCode("3HJ9T"),
    reward: { name: "Tournament entry", type: "event_entry", value: 0 },
    status: "expired",
    expires_at: daysAgo(50),
    created: daysAgo(140),
  },
  {
    id: "vch_demo_3",
    customer: "cust_demo_1",
    rewardId: "reward_lanyard",
    number: "GG-V-000006",
    code: voucherCode("Q2X6N"),
    reward: { name: "GG lanyard", type: "free_item", value: 0 },
    status: "used",
    expires_at: daysAhead(VOUCHER_DAYS - 60),
    created: daysAgo(60),
  },
]

/** The next `GG-V-` number, carrying on from the seeded ones. */
let nextRedemption = 8

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function me() {
  const id = demoPortalCustomerId()
  const entry = findDemoCustomer(id)
  if (!entry) throw new Error("The demo shop has no customers.")
  return entry
}

function pointsBalanceFor(customerId: string): number {
  return findDemoCustomer(customerId)?.private.points_balance ?? 0
}

function tierFor(customerId: string): LoyaltyTier | null {
  const held = findDemoCustomer(customerId)?.private.tier
  return DEMO_TIERS.find((tier) => tier.id === held) ?? null
}

/** The next tier up from where the window points stand, or null at the top. */
function nextTierFor(windowPoints: number): LoyaltyTier | null {
  return (
    [...DEMO_TIERS]
      .sort((a, b) => a.thresholdPoints - b.thresholdPoints)
      .find((tier) => tier.thresholdPoints > windowPoints) ?? null
  )
}

function wallet(tier: LoyaltyTier | null, headline: boolean): PerkWalletEntry[] {
  if (!tier) return []
  const period = currentPeriod()
  const used = headline
    ? USED_THIS_MONTH
    : { free_event_entries: 0, lounge_hours: 0 }
  const entries = tier.perks.map((perk) => toWalletEntry(perk, period, used))
  for (const extra of EXTRA_COUNTED[tier.id] ?? []) {
    if (entries.some((entry) => entry.type === extra.type)) continue
    entries.push({
      type: extra.type,
      value: extra.allowed,
      allowed: extra.allowed,
      used: used[extra.type] ?? 0,
      period,
    })
  }
  return entries
}

function liveVouchersFor(customerId: string): DemoVoucher[] {
  const now = Date.now()
  return demoVoucherRows.filter(
    (voucher) =>
      voucher.customer === customerId &&
      voucher.status === "issued" &&
      (!voucher.expires_at || new Date(voucher.expires_at).getTime() >= now)
  )
}

export function demoGuild(): GuildSummary {
  const entry = me()
  const customerId = entry.customer.id
  const windowPoints = windowPointsFor(customerId)
  const tier = tierFor(customerId)
  const next = nextTierFor(windowPoints)
  const headline = customerId === "cust_demo_1"

  return {
    points_name: POINTS_NAME,
    tier: tier ? { id: tier.id, name: tier.name } : null,
    window_points: windowPoints,
    next: next
      ? { name: next.name, points_needed: next.thresholdPoints - windowPoints }
      : null,
    // Only the headline demo card holds a paid plan, so both the membership
    // line and the screen without one are reachable in the demo.
    membership: headline
      ? { tier_name: tier?.name ?? "Regular", renews_at: daysAhead(152) }
      : null,
    perks: wallet(tier, headline),
    referral: {
      code: entry.customer.code,
      bonus_referrer: REFERRAL_BONUS,
      bonus_referee: REFERRAL_BONUS,
      earned: headline ? 2 : 0,
      pending: headline ? 1 : 0,
    },
    vouchers_open: liveVouchersFor(customerId).length,
  }
}

export function demoPoints(): PointsLedgerRow[] {
  const customerId = me().customer.id
  return demoPointsRows
    .filter((row) => row.customer === customerId)
    .map(({ customer, ...row }) => {
      void customer
      return { ...row }
    })
    .reverse()
}

export function demoVouchers(): PortalVoucher[] {
  const customerId = me().customer.id
  return demoVoucherRows
    .filter((voucher) => voucher.customer === customerId)
    .map(({ customer, rewardId, ...voucher }) => {
      void customer
      void rewardId
      return { ...voucher }
    })
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
}

/** Stock left on a reward, counting every voucher the demo shop has issued. */
function remainingFor(seed: DemoRewardSeed): number | null {
  if (seed.stock_limit === null) return null
  const issued = demoVoucherRows.filter(
    (voucher) => voucher.rewardId === seed.id && voucher.status !== "cancelled"
  ).length
  return Math.max(0, seed.stock_limit - seed.redeemed_elsewhere - issued)
}

function perCustomerRemainingFor(
  seed: DemoRewardSeed,
  customerId: string
): number | null {
  if (seed.per_customer_limit === null) return null
  const mine = demoVoucherRows.filter(
    (voucher) =>
      voucher.rewardId === seed.id &&
      voucher.customer === customerId &&
      voucher.status !== "cancelled"
  ).length
  return Math.max(0, seed.per_customer_limit - mine)
}

/** The same order of checks the route makes, so the words never disagree. */
function reasonFor(
  seed: DemoRewardSeed,
  customerId: string,
  balance: number
): RewardReason {
  if (seed.starts_at && new Date(seed.starts_at).getTime() > Date.now()) {
    return "not_yet"
  }
  if (remainingFor(seed) === 0) return "sold_out"
  if (perCustomerRemainingFor(seed, customerId) === 0) return "limit_reached"
  if (balance < seed.cost_points) return "insufficient"
  return "ok"
}

function toReward(seed: DemoRewardSeed, customerId: string): PortalReward {
  const balance = pointsBalanceFor(customerId)
  const reason = reasonFor(seed, customerId, balance)
  return {
    id: seed.id,
    name: seed.name,
    description_html: seed.description_html,
    cost_points: seed.cost_points,
    type: seed.type,
    value: seed.value,
    image_url: REWARD_ART,
    remaining: remainingFor(seed),
    per_customer_remaining: perCustomerRemainingFor(seed, customerId),
    can_redeem: reason === "ok",
    reason,
  }
}

/** The catalogue: active rewards inside their window, as the route sends it. */
export function demoRewards(): PortalReward[] {
  const customerId = me().customer.id
  return DEMO_REWARDS.filter(
    (seed) => !seed.starts_at || new Date(seed.starts_at).getTime() <= Date.now()
  ).map((seed) => toReward(seed, customerId))
}

// ---------------------------------------------------------------------------
// Redeeming
// ---------------------------------------------------------------------------

/** The route's own 422 sentences, so the demo refuses in the same words. */
function refusal(reason: RewardReason, seed: DemoRewardSeed, balance: number): string {
  switch (reason) {
    case "insufficient":
      return `You need ${seed.cost_points.toLocaleString("en-GB")} points for this and have ${balance.toLocaleString("en-GB")}.`
    case "sold_out":
      return "That one has gone. Pick another reward."
    case "limit_reached":
      return "You have had this one already. Pick another reward."
    case "not_yet":
      return "That reward is not open yet. Try again when it starts."
    default:
      return "That could not be redeemed. Try again in a moment."
  }
}

export function demoRedeem(id: string): PortalVoucher {
  const entry = me()
  const customerId = entry.customer.id
  const seed = DEMO_REWARDS.find((reward) => reward.id === id)
  if (!seed) throw new Error("That reward is not in the catalogue any more.")

  const balance = pointsBalanceFor(customerId)
  const reason = reasonFor(seed, customerId, balance)
  if (reason !== "ok") throw new Error(refusal(reason, seed, balance))

  const number = `GG-V-${String(nextRedemption).padStart(6, "0")}`
  const voucher: DemoVoucher = {
    id: `vch_demo_${nextRedemption}`,
    customer: customerId,
    rewardId: seed.id,
    number,
    code: voucherCode(`V${String(nextRedemption).padStart(4, "0")}`),
    reward: { name: seed.name, type: seed.type, value: seed.value },
    status: "issued",
    expires_at: daysAhead(VOUCHER_DAYS),
    created: new Date().toISOString(),
  }
  nextRedemption += 1
  demoVoucherRows.push(voucher)

  const after = demoAddPoints(customerId, -seed.cost_points)
  demoPointsRows.push({
    id: `pts_demo_${demoPointsRows.length + 1}`,
    customer: customerId,
    delta: -seed.cost_points,
    reason: "redeem",
    ref: number,
    note: `Redeemed for ${seed.name}`,
    balance_after: after,
    created: new Date().toISOString(),
  })

  // Store credit is paid out by the redemption itself, so the voucher is
  // spent the moment it is issued and the money is already on the account.
  if (seed.type === "store_credit") {
    postRewardCredit(customerId, seed.value, number)
    voucher.status = "used"
  }

  const { customer, rewardId, ...body } = voucher
  void customer
  void rewardId
  return { ...body }
}

/**
 * The credit row a store-credit reward writes.
 *
 * `demoPostCredit` in the customers fixtures writes a `trade_in` row, which
 * is not what this is: the Credit screen names the reason, and a reward has
 * to read as a reward there.
 */
function postRewardCredit(customerId: string, amount: number, ref: string) {
  const entry = findDemoCustomer(customerId)
  if (!entry) return
  const balance = (entry.private.credit_balance ?? 0) + amount
  entry.private.credit_balance = balance
  demoCreditLedger.unshift({
    id: `credit_reward_${ref}`,
    customer: customerId,
    amount,
    reason: "reward",
    ref,
    balance_after: balance,
    created: new Date().toISOString(),
  })
}
