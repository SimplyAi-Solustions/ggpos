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
import {
  ledgerForWindow,
  pointsToNextTier,
  resolveTier,
  tierWindowPoints,
} from "@/features/loyalty/window"
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
  PerkWallet,
  PerkWalletEntry,
  PointsAdjustment,
  PointsLedgerPage,
  PointsLedgerRow,
  ReferralSummary,
  VoucherDetail,
  VoucherStatus,
  VoucherSummary,
} from "@/lib/api/types"

const STEP_UP_HEADER = "X-Step-Up"

/** One page of the points ledger, which is also the window's whole input. */
const LEDGER_PAGE = 100

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

/**
 * A refusal from one row of a save that writes several.
 *
 * The rows go one at a time, so a refused rule leaves the rules before it
 * written: the screen has to be able to say which row was refused and to
 * re-read what landed, which is what `index` and the kept `cause` are for.
 */
export class RowWriteError extends Error {
  /** Which of the two lists the refused row came from. */
  collection: "loyalty_rules" | "loyalty_tiers"
  /** The position in the array that was handed to the save. */
  index: number
  /** The server's own error, so its sentence still reaches the screen. */
  cause: unknown

  constructor(
    collection: "loyalty_rules" | "loyalty_tiers",
    index: number,
    cause: unknown
  ) {
    super("One row was refused.")
    this.name = "RowWriteError"
    this.collection = collection
    this.index = index
    this.cause = cause
  }
}

/** A rule with an id is updated; one without is created. Nothing is deleted. */
export async function saveRules(
  writes: LoyaltyRuleWrite[]
): Promise<LoyaltyRuleRecord[]> {
  if (isDemo()) return demo.demoSaveRules(writes)
  for (const [index, write] of writes.entries()) {
    const { id, ...fields } = write
    try {
      if (id) await pb.collection("loyalty_rules").update(id, fields)
      else await pb.collection("loyalty_rules").create(fields)
    } catch (error) {
      throw new RowWriteError("loyalty_rules", index, error)
    }
  }
  return pb
    .collection("loyalty_rules")
    .getFullList<LoyaltyRuleRecord>({ sort: "-priority,name" })
}

export async function saveTiers(
  writes: LoyaltyTierWrite[]
): Promise<LoyaltyTierRecord[]> {
  if (isDemo()) return demo.demoSaveTiers(writes)
  for (const [index, write] of writes.entries()) {
    const { id, ...fields } = write
    try {
      if (id) await pb.collection("loyalty_tiers").update(id, fields)
      else await pb.collection("loyalty_tiers").create(fields)
    } catch (error) {
      throw new RowWriteError("loyalty_tiers", index, error)
    }
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

interface PerkWalletResponse {
  tier?: { id: string; name: string } | null
  window_points?: number | null
  next?: { name: string; points_needed: number } | null
  perks?: PerkWalletEntry[]
}

/**
 * `GET /api/vault/customers/:id/perks`: the tier the server holds for this
 * customer (`customer_private.tier`, which it re-evaluates after every
 * points row and every membership change), the window total it adds up
 * from the whole ledger with the next tier above it, and what the tier
 * gives them this month. The counter never works any of that out for
 * itself from a page of the ledger: two answers on one screen is how a
 * badge starts lying.
 */
export async function getPerksWallet(customerId: string): Promise<PerkWallet> {
  if (isDemo()) return demo.demoPerksWallet(customerId)
  const result = await pb.send<PerkWalletResponse>(
    `/api/vault/customers/${customerId}/perks`,
    { method: "GET" }
  )
  const windowPoints =
    typeof result.window_points === "number" && Number.isFinite(result.window_points)
      ? result.window_points
      : null
  return {
    tier: result.tier ?? null,
    windowPoints,
    next:
      windowPoints !== null && result.next
        ? { name: result.next.name, points: result.next.points_needed }
        : null,
    perks: result.perks ?? [],
  }
}

/** One entry or one hour off a monthly allowance. Refused when it is spent. */
export async function recordPerkUse(
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

/**
 * The last hundred rows, newest first, with a sentence for each, and
 * whether that is the whole history: a window total taken over one page of
 * a longer ledger is a wrong number, so the caller is told rather than
 * shown one.
 */
export async function getPointsLedgerPage(
  customerId: string
): Promise<PointsLedgerPage> {
  if (isDemo()) return demo.demoPointsLedgerPage(customerId)
  const page = await pb.collection("points_ledger").getList<LedgerRow>(1, LEDGER_PAGE, {
    filter: `customer = "${escapeFilter(customerId)}"`,
    sort: "-created",
  })
  return {
    rows: page.items.map((row) => ({
      id: row.id,
      delta: row.delta ?? 0,
      reason: row.reason ?? "adjust",
      balance_after: row.balance_after ?? 0,
      created: row.created ?? "",
      ref: row.ref,
      note: pointsNote({ reason: row.reason ?? "adjust" }),
    })),
    complete: page.totalItems <= LEDGER_PAGE,
  }
}

export async function getPointsLedger(
  customerId: string
): Promise<PointsLedgerRow[]> {
  return (await getPointsLedgerPage(customerId)).rows
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
export async function markVoucherUsed(code: string): Promise<VoucherDetail> {
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
 * Everything the Guild section shows.
 *
 * The tier, the window total and the next tier are the server's own (the
 * perks route answers with all three: `customer_private.tier`, which it
 * re-evaluates after every points row, every membership change and
 * nightly, and a window total added up from the whole ledger), so the
 * badge here and the badge on the customer header are the same fact
 * rather than two guesses. Only when that route cannot be reached does the
 * counter fall back to the ledger page it read, and then only if that page
 * is the whole history; `resolveTier` fills the tier in for a customer the
 * server has not written one for yet.
 */
export async function getCustomerGuild(customerId: string): Promise<CustomerGuild> {
  if (isDemo()) return demo.demoGuild(customerId)

  const [config, ledger, membership, wallet, vouchers, referral] = await Promise.all([
    getCounterConfig(),
    getPointsLedgerPage(customerId),
    membershipFor(customerId),
    getPerksWallet(customerId).catch(
      (): PerkWallet => ({ tier: null, windowPoints: null, next: null, perks: [] })
    ),
    listCustomerVouchers(customerId).catch(() => [] as VoucherSummary[]),
    referralsFor(customerId).catch(
      (): ReferralSummary => ({ referredBy: null, earned: 0, pending: 0 })
    ),
  ])

  const tiers = config.loyalty.tiers
  const windowPoints =
    wallet.windowPoints ??
    (ledger.complete
      ? tierWindowPoints(
          ledgerForWindow(ledger.rows),
          new Date(),
          config.loyalty.programme.tierWindowMonths
        )
      : null)
  const held =
    wallet.tier ??
    (windowPoints === null
      ? null
      : (resolveTier(tiers, windowPoints, membership?.tier ?? null) ?? null))
  const computedNext = windowPoints === null ? null : pointsToNextTier(tiers, windowPoints)
  const next =
    wallet.windowPoints !== null
      ? wallet.next
      : computedNext
        ? { name: computedNext.tier.name, points: computedNext.points }
        : null

  return {
    tier: held ? { id: held.id, name: held.name } : null,
    windowPoints,
    pointsBalance: ledger.rows[0]?.balance_after ?? 0,
    next,
    perks: wallet.perks,
    membership,
    referral,
    vouchers,
  }
}
