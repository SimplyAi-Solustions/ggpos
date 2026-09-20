/**
 * GG Guild, as a customer reads it: the tier and its perks, the rewards
 * catalogue, a redemption's voucher, and the points ledger behind the
 * balance.
 *
 * Every call goes through `pbCustomer`, the portal's own PocketBase client,
 * so a staff session open in the same browser is never disturbed. The routes
 * are the Phase 6 customer ones: `GET /api/vault/me/guild`,
 * `GET /api/vault/rewards`, `POST /api/vault/rewards/:id/redeem`,
 * `GET /api/vault/me/vouchers` and `GET /api/vault/me/points`.
 *
 * Money is integer GBP pence and points are integers, both the way the rest
 * of the app carries them.
 */
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  demoGuild,
  demoPoints,
  demoRedeem,
  demoRewards,
  demoVouchers,
} from "@/lib/api/demo/portal-guild"
import type {
  PerkWalletEntry,
  PointsLedgerRow,
  RewardType,
  VoucherStatus,
} from "@/lib/api/types"

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** `GET /api/vault/me/guild`. */
export interface GuildSummary {
  /** What the programme calls its points, for example "GG Points". */
  points_name: string
  tier: { id: string; name: string } | null
  /** Points earned inside the programme's rolling tier window. */
  window_points: number
  next: { name: string; points_needed: number } | null
  /** A paid plan pins the tier while it runs. */
  membership: { tier_name: string; renews_at: string } | null
  perks: PerkWalletEntry[]
  referral: {
    /** The customer's own code: what a friend gives at the counter. */
    code: string
    bonus_referrer: number
    bonus_referee: number
    earned: number
    pending: number
  }
  vouchers_open: number
}

/** Why a reward cannot be redeemed, in the route's own words. */
export type RewardReason =
  | "ok"
  | "insufficient"
  | "sold_out"
  | "limit_reached"
  | "not_yet"

/** One row of `GET /api/vault/rewards`. */
export interface PortalReward {
  id: string
  name: string
  /** The admin's editor field. Rendered as text, never as markup. */
  description_html: string
  cost_points: number
  type: RewardType
  /** Pence for `money_off` and `store_credit`; otherwise not money. */
  value: number
  image_url: string
  /** What is left of a stock limit, or null when there is no limit. */
  remaining: number | null
  per_customer_remaining: number | null
  can_redeem: boolean
  reason: RewardReason
}

/** A `reward_redemptions` row as the customer's own portal reads one. */
export interface PortalVoucher {
  id: string
  /** The sequential GG-V-000012 form. */
  number: string
  /** The short scannable GGV-… code. */
  code: string
  reward: { name: string; type: RewardType; value: number }
  status: VoucherStatus
  expires_at: string | null
  created?: string
}

/**
 * The notification types this phase adds, all written by `lib/notify.js`.
 *
 * `NotificationType` in `lib/api/types.ts` is the Phase 5 set; these are the
 * eight the Guild adds on top of it. Nothing branches on the value, because
 * a row's `link` is what decides where it opens and `portalLinkFrom` is what
 * decides whether that link is followed at all. They are named here so the
 * demo rows and the tests can say which kind of row they are.
 */
export type GuildNotificationType =
  | "tier_up"
  | "referral_earned"
  | "points_expiring"
  | "points_expired"
  | "reward_issued"
  | "reward_used"
  | "membership_started"
  | "membership_lapsed"

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The rows off a list route, whichever wrapper the server used.
 *
 * The contract names one key per route, but a bare array is what a plain
 * collection read would give and costs nothing to accept. A body that
 * carries neither is an empty list rather than a crash: the screens branch
 * on the query's own error state for a failed read, and a shape they cannot
 * read is not a failed read.
 */
function listFrom<T>(result: unknown, key: string): T[] {
  if (Array.isArray(result)) return result as T[]
  const body = (result ?? {}) as Record<string, unknown>
  const named = body[key]
  if (Array.isArray(named)) return named as T[]
  for (const fallback of ["items", "rows"]) {
    const value = body[fallback]
    if (Array.isArray(value)) return value as T[]
  }
  return []
}

export async function getGuild(): Promise<GuildSummary> {
  if (isDemo()) return demoGuild()
  return pbCustomer.send<GuildSummary>("/api/vault/me/guild", { method: "GET" })
}

export async function listRewards(): Promise<PortalReward[]> {
  if (isDemo()) return demoRewards()
  const result = await pbCustomer.send("/api/vault/rewards", { method: "GET" })
  return listFrom<PortalReward>(result, "rewards")
}

export async function listMyVouchers(): Promise<PortalVoucher[]> {
  if (isDemo()) return demoVouchers()
  const result = await pbCustomer.send("/api/vault/me/vouchers", { method: "GET" })
  return listFrom<PortalVoucher>(result, "vouchers")
}

export async function listMyPoints(): Promise<PointsLedgerRow[]> {
  if (isDemo()) return demoPoints()
  const result = await pbCustomer.send("/api/vault/me/points", { method: "GET" })
  return listFrom<PointsLedgerRow>(result, "rows")
}

// ---------------------------------------------------------------------------
// Redeeming
// ---------------------------------------------------------------------------

/**
 * Spends the points and issues the voucher.
 *
 * The server re-checks the cost, the stock and the per-customer limit against
 * live rows inside its own transaction, so the catalogue's `can_redeem` is
 * only ever what the screen shows, never what it relies on: a 422 comes back
 * with the sentence to put in front of the customer.
 */
export async function redeemReward(id: string): Promise<PortalVoucher> {
  if (isDemo()) return demoRedeem(id)
  const result = await pbCustomer.send(
    `/api/vault/rewards/${encodeURIComponent(id)}/redeem`,
    { method: "POST" }
  )
  const body = (result ?? {}) as Record<string, unknown>
  const voucher = (body.voucher ?? body.redemption ?? body) as PortalVoucher
  return voucher
}
