/**
 * GG Guild at the counter: the admin's programme, rules, tiers and rewards,
 * the perks wallet, paid plans, points adjustments and vouchers.
 *
 * The four `loyalty_*` collections are edited straight through the
 * collection API under their existing admin-only rules, which `audit.pb.js`
 * already audits. Everything that has to be transactional, gated or counted
 * (a perk being used, a plan, an adjustment, a voucher) goes through the
 * Phase 6 routes instead, so the counter can never write half of one.
 *
 * Demo mode answers the same shapes and refuses in the same sentences.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { escapeFilter } from "@/lib/api/filter"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { getCounterConfig } from "@/lib/api/config"
import { pointsNote } from "@/features/loyalty/ledger"
import { tierWindowPoints } from "@/features/loyalty/window"
import * as demo from "@/lib/api/demo/loyalty"
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
  PerkWalletEntry,
  PointsAdjustment,
  PointsLedgerRow,
  ReferralSummary,
  VoucherDetail,
  VoucherStatus,
  VoucherSummary,
} from "@/lib/api/types"

const STEP_UP_HEADER = "X-Step-Up"

export interface LoyaltyAdmin {
  programme: LoyaltyProgrammeRecord
  rules: LoyaltyRuleRecord[]
  tiers: LoyaltyTierRecord[]
  rewards: LoyaltyRewardRecord[]
}

/** The file URL PocketBase serves a reward's image from. */
function rewardImageUrl(record: { id: string; image?: string }): string {
  if (!record.image) return ""
  return pb.files.getURL(
    { id: record.id, collectionName: "loyalty_rewards" },
    record.image
  )
}

// ---------------------------------------------------------------------------
// The admin's four collections
// ---------------------------------------------------------------------------

export async function getLoyaltyAdmin(): Promise<LoyaltyAdmin> {
  if (isDemo()) return demo.demoLoyaltyAdmin()

  const [programmePage, rules, tiers, rewards] = await Promise.all([
    pb.collection("loyalty_programme").getList<LoyaltyProgrammeRecord>(1, 1),
    pb
      .collection("loyalty_rules")
      .getFullList<LoyaltyRuleRecord>({ sort: "-priority,name" }),
    pb.collection("loyalty_tiers").getFullList<LoyaltyTierRecord>({ sort: "sort" }),
    pb
      .collection("loyalty_rewards")
      .getFullList<LoyaltyRewardRecord & { image?: string }>({ sort: "cost_points" }),
  ])
  noteNetworkSuccess()

  const programme = programmePage.items[0]
  if (!programme) {
    throw new Error("This shop has no loyalty programme record yet. Run the migrations first.")
  }
  return {
    programme,
    rules,
    tiers,
    rewards: rewards.map((reward) => ({
      ...reward,
      imageUrl: rewardImageUrl(reward),
    })),
  }
}

export async function saveProgramme(
  id: string,
  patch: Partial<LoyaltyProgrammeRecord>
): Promise<LoyaltyProgrammeRecord> {
  if (isDemo()) return demo.demoSaveProgramme(patch)
  return pb.collection("loyalty_programme").update<LoyaltyProgrammeRecord>(id, patch)
}

/** A rule with an id is updated; one without is created. Nothing is deleted. */
export async function saveRules(
  writes: LoyaltyRuleWrite[]
): Promise<LoyaltyRuleRecord[]> {
  if (isDemo()) return demo.demoSaveRules(writes)
  for (const write of writes) {
    const { id, ...fields } = write
    if (id) await pb.collection("loyalty_rules").update(id, fields)
    else await pb.collection("loyalty_rules").create(fields)
  }
  return pb
    .collection("loyalty_rules")
    .getFullList<LoyaltyRuleRecord>({ sort: "-priority,name" })
}

export async function saveTiers(
  writes: LoyaltyTierWrite[]
): Promise<LoyaltyTierRecord[]> {
  if (isDemo()) return demo.demoSaveTiers(writes)
  for (const write of writes) {
    const { id, ...fields } = write
    if (id) await pb.collection("loyalty_tiers").update(id, fields)
    else await pb.collection("loyalty_tiers").create(fields)
  }
  return pb.collection("loyalty_tiers").getFullList<LoyaltyTierRecord>({ sort: "sort" })
}

/**
 * A reward, with its picture. The image is sent as multipart only when one
 * has been picked, so saving the rest of the form never clears the stored
 * file.
 */
export async function saveReward(
  write: LoyaltyRewardWrite
): Promise<LoyaltyRewardRecord> {
  if (isDemo()) return demo.demoSaveReward(write)

  const { id, image, ...fields } = write
  let body: FormData | Record<string, unknown> = fields
  if (image) {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value === null || value === undefined ? "" : String(value))
    }
    form.append("image", image)
    body = form
  }

  const record = id
    ? await pb
        .collection("loyalty_rewards")
        .update<LoyaltyRewardRecord & { image?: string }>(id, body)
    : await pb
        .collection("loyalty_rewards")
        .create<LoyaltyRewardRecord & { image?: string }>(body)
  return { ...record, imageUrl: rewardImageUrl(record) }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

interface MembershipRow {
  id: string
  customer: string
  tier: string
  status?: MembershipStatus
  started_at?: string
  renews_at?: string
  price?: number
  payment_note?: string
  expand?: {
    customer?: { id: string; name?: string; code?: string }
    tier?: { id: string; name?: string }
  }
}

function toMembership(row: MembershipRow): MembershipRecord {
  return {
    id: row.id,
    customer: row.customer,
    customerName: row.expand?.customer?.name ?? "A customer",
    customerCode: row.expand?.customer?.code ?? "",
    tier: row.tier,
    tierName: row.expand?.tier?.name ?? "Tier",
    status: row.status ?? "active",
    started_at: row.started_at ?? "",
    renews_at: row.renews_at ?? "",
    price: row.price ?? 0,
    payment_note: row.payment_note ?? "",
  }
}

export async function listMemberships(
  status: MembershipStatus | "all" = "active"
): Promise<MembershipRecord[]> {
  if (isDemo()) {
    return demo.demoMemberships(status === "all" ? undefined : status)
  }
  const rows = await pb.collection("memberships").getFullList<MembershipRow>({
    filter: status === "all" ? "" : `status = "${status}"`,
    expand: "customer,tier",
    sort: "-started_at",
  })
  return rows.map(toMembership)
}

export async function membershipFor(
  customerId: string
): Promise<MembershipRecord | null> {
  if (isDemo()) return demo.demoMembershipFor(customerId)
  const page = await pb.collection("memberships").getList<MembershipRow>(1, 1, {
    filter: `customer = "${escapeFilter(customerId)}" && status = "active"`,
    expand: "customer,tier",
    sort: "-started_at",
  })
  const row = page.items[0]
  return row ? toMembership(row) : null
}

export async function recordMembership(
  input: MembershipInput
): Promise<MembershipRecord> {
  if (isDemo()) return demo.demoRecordMembership(input)
  const result = await pb.send<{ membership: MembershipRow }>(
    "/api/vault/memberships",
    { method: "POST", body: input }
  )
  return toMembership(result.membership)
}

export async function renewMembership(
  id: string,
  input: MembershipRenewal
): Promise<MembershipRecord> {
  if (isDemo()) return demo.demoRenewMembership(id, input)
  const result = await pb.send<{ membership: MembershipRow }>(
    `/api/vault/memberships/${id}/renew`,
    { method: "POST", body: input }
  )
  return toMembership(result.membership)
}

export async function cancelMembership(id: string): Promise<MembershipRecord> {
  if (isDemo()) return demo.demoCancelMembership(id)
  const result = await pb.send<{ membership: MembershipRow }>(
    `/api/vault/memberships/${id}/cancel`,
    { method: "POST", body: {} }
  )
  return toMembership(result.membership)
}

// ---------------------------------------------------------------------------
// Perks
// ---------------------------------------------------------------------------

export async function getPerks(customerId: string): Promise<PerkWalletEntry[]> {
  if (isDemo()) return demo.demoPerks(customerId)
  const result = await pb.send<{ perks: PerkWalletEntry[] }>(
    `/api/vault/customers/${customerId}/perks`,
    { method: "GET" }
  )
  return result.perks ?? []
}

/** One entry or one hour off a monthly allowance. Refused when it is spent. */
export async function usePerk(
  customerId: string,
  type: CountedPerkType,
  count = 1
): Promise<PerkWalletEntry> {
  if (isDemo()) return demo.demoUsePerk(customerId, type, count)
  const result = await pb.send<{ perk: PerkWalletEntry }>(
    `/api/vault/customers/${customerId}/perks/use`,
    { method: "POST", body: { type, count } }
  )
  return result.perk
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

interface LedgerRow {
  id: string
  delta?: number
  reason?: string
  balance_after?: number
  created?: string
  ref?: string
}

/** The last hundred rows, newest first, with a sentence for each. */
export async function getPointsLedger(
  customerId: string
): Promise<PointsLedgerRow[]> {
  if (isDemo()) return demo.demoPointsLedger(customerId)
  const page = await pb.collection("points_ledger").getList<LedgerRow>(1, 100, {
    filter: `customer = "${escapeFilter(customerId)}"`,
    sort: "-created",
  })
  return page.items.map((row) => ({
    id: row.id,
    delta: row.delta ?? 0,
    reason: row.reason ?? "adjust",
    balance_after: row.balance_after ?? 0,
    created: row.created ?? "",
    ref: row.ref,
    note: pointsNote({ reason: row.reason ?? "adjust" }),
  }))
}

/** Admin only, behind a step-up, and never below a zero balance. */
export async function adjustPoints(
  input: PointsAdjustment,
  stepUpToken: string
): Promise<{ balance: number }> {
  if (isDemo()) return demo.demoAdjustPoints(input)
  return pb.send<{ balance: number }>("/api/vault/loyalty/adjust", {
    method: "POST",
    body: input,
    headers: { [STEP_UP_HEADER]: stepUpToken },
  })
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

interface RedemptionRow {
  id: string
  number?: string
  code?: string
  customer: string
  status?: VoucherStatus
  expires_at?: string
  created?: string
  expand?: {
    customer?: { id: string; name?: string; code?: string }
    reward?: { name?: string; type?: VoucherSummary["type"]; value?: number }
  }
}

function toVoucher(row: RedemptionRow): VoucherSummary {
  return {
    id: row.id,
    code: row.code ?? "",
    number: row.number ?? "",
    status: row.status ?? "issued",
    rewardName: row.expand?.reward?.name ?? "Reward",
    type: row.expand?.reward?.type ?? "custom",
    value: row.expand?.reward?.value ?? 0,
    expiresAt: row.expires_at || null,
    created: row.created ?? "",
  }
}

/** The voucher behind a scanned GGV code, whatever state it is in. */
export async function getVoucherByCode(code: string): Promise<VoucherDetail | null> {
  if (isDemo()) return demo.demoVoucherByCode(code)
  try {
    const result = await pb.send<{ voucher: VoucherDetail }>(
      `/api/vault/vouchers/${encodeURIComponent(code)}`,
      { method: "GET" }
    )
    return result.voucher ?? null
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

export async function listCustomerVouchers(
  customerId: string
): Promise<VoucherSummary[]> {
  if (isDemo()) return demo.demoOpenVouchers(customerId)
  const page = await pb.collection("reward_redemptions").getList<RedemptionRow>(1, 20, {
    filter: `customer = "${escapeFilter(customerId)}"`,
    expand: "reward",
    sort: "-created",
  })
  return page.items.map(toVoucher)
}

/** Marks a free item, event entry or custom voucher used at the counter. */
export async function useVoucher(code: string): Promise<VoucherDetail> {
  if (isDemo()) return demo.demoUseVoucher(code)
  const result = await pb.send<{ voucher: VoucherDetail }>(
    `/api/vault/vouchers/${encodeURIComponent(code)}/use`,
    { method: "POST", body: {} }
  )
  return result.voucher
}

/** Admin only: cancels the voucher and puts the points back. */
export async function cancelVoucher(code: string): Promise<VoucherDetail> {
  if (isDemo()) return demo.demoCancelVoucher(code)
  const result = await pb.send<{ voucher: VoucherDetail }>(
    `/api/vault/vouchers/${encodeURIComponent(code)}/cancel`,
    { method: "POST", body: {} }
  )
  return result.voucher
}

// ---------------------------------------------------------------------------
// The Guild block on a customer profile
// ---------------------------------------------------------------------------

interface ReferralRow {
  id: string
  referrer: string
  referee: string
  status?: "pending" | "earned"
  expand?: { referrer?: { id: string; name?: string; code?: string } }
}

async function referralsFor(customerId: string): Promise<ReferralSummary> {
  const quoted = escapeFilter(customerId)
  const rows = await pb.collection("referrals").getFullList<ReferralRow>({
    filter: `referrer = "${quoted}" || referee = "${quoted}"`,
    expand: "referrer",
  })
  const referredBy = rows.find((row) => row.referee === customerId)
  const by = referredBy?.expand?.referrer
  return {
    referredBy: by
      ? { id: by.id, name: by.name ?? "A customer", code: by.code ?? "" }
      : null,
    earned: rows.filter((row) => row.referrer === customerId && row.status === "earned")
      .length,
    pending: rows.filter((row) => row.referrer === customerId && row.status === "pending")
      .length,
  }
}

/**
 * Everything the Guild section shows, composed from the rows a staff member
 * may read: the ledger decides the window total, an active plan pins the
 * tier, and the tiers themselves come from the config route every counter
 * screen already shares.
 */
export async function getCustomerGuild(customerId: string): Promise<CustomerGuild> {
  if (isDemo()) return demo.demoGuild(customerId)

  const [config, ledger, membership, perks, vouchers, referral] = await Promise.all([
    getCounterConfig(),
    getPointsLedger(customerId),
    membershipFor(customerId),
    getPerks(customerId).catch(() => [] as PerkWalletEntry[]),
    listCustomerVouchers(customerId).catch(() => [] as VoucherSummary[]),
    referralsFor(customerId).catch(
      (): ReferralSummary => ({ referredBy: null, earned: 0, pending: 0 })
    ),
  ])

  const tiers = config.loyalty.tiers
  const windowPoints = tierWindowPoints(
    ledger.map((row) => ({
      delta: row.delta,
      reason: row.reason,
      created: row.created,
    })),
    new Date(),
    config.loyalty.programme.tierWindowMonths
  )
  const held = membership
    ? (tiers.find((tier) => tier.id === membership.tier) ?? null)
    : (tiers
        .filter((tier) => !tier.paidPlan && tier.thresholdPoints <= windowPoints)
        .sort((a, b) => b.thresholdPoints - a.thresholdPoints)[0] ?? null)
  const next = tiers
    .filter((tier) => !tier.paidPlan && tier.thresholdPoints > windowPoints)
    .sort((a, b) => a.thresholdPoints - b.thresholdPoints)[0]

  return {
    tier: held ? { id: held.id, name: held.name } : null,
    windowPoints,
    pointsBalance: ledger[0]?.balance_after ?? 0,
    next: next
      ? { name: next.name, points: next.thresholdPoints - windowPoints }
      : null,
    perks,
    membership,
    referral,
    vouchers,
  }
}
