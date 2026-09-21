/**
 * GG Guild loyalty evaluator. Pure functions so the admin preview in the app and
 * the PocketBase hook produce the same points for the same sale.
 */
import { roundHalfUp } from "./money"

export interface LoyaltyProgramme {
  enabled: boolean
  earnPerPoundSales: number
  earnPerPoundTradeInCredit: number
  /** Points per one pound of redemption value, for example 100. */
  pointsPerPoundRedemption: number
  minRedeemPoints: number
  /** Max share of a sale payable with points, 0 to 100. */
  maxPointsShareOfSale: number
  expiryMonthsInactive: number
  tierWindowMonths: number
  welcomeBonus: number
  referralBonusReferrer: number
  referralBonusReferee: number
}

export type LoyaltyRuleType =
  | "multiplier"
  | "fixed_bonus"
  | "first_purchase"
  | "birthday_month"
  | "trade_in_credit_bonus"
  | "event_checkin"
  | "day_of_week"

export interface LoyaltyRuleConditions {
  games?: string[]
  kinds?: string[]
  /** Minimum spend in pence for the rule to apply. */
  minSpend?: number
  /** 0 = Sunday ... 6 = Saturday */
  weekdays?: number[]
}

export interface LoyaltyRule {
  id: string
  name: string
  type: LoyaltyRuleType
  conditions: LoyaltyRuleConditions
  /** Multiplier for multiplier and day_of_week types (2 = double), points for bonuses. */
  value: number
  active: boolean
  priority: number
  startsAt: string | null
  endsAt: string | null
}

export interface LoyaltyTier {
  id: string
  name: string
  thresholdPoints: number
  sort: number
  perks: TierPerk[]
  paidPlan: boolean
}

export type TierPerk =
  | { type: "percent_off"; value: number; scope: string[] }
  | { type: "points_multiplier"; value: number }
  | { type: "free_event_entries"; value: number; perMonth: true }
  | { type: "lounge_hours"; value: number; perMonth: true }
  | { type: "priority_release_booking" }
  | { type: "member_event_pricing" }

/**
 * Runtime shape check for one loyalty_tiers.perks entry loaded from
 * PocketBase (plain JSON, so nothing guarantees it matches TierPerk).
 * Returns null when the shape does not match a known perk exactly - for
 * example the pre-fix seed's snake_case "per_month" or an "all"/string
 * scope instead of a string array - rather than silently misreading it.
 */
export function parseTierPerk(value: unknown): TierPerk | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  switch (v.type) {
    case "percent_off":
      return typeof v.value === "number" &&
        Array.isArray(v.scope) &&
        v.scope.every((s) => typeof s === "string")
        ? { type: "percent_off", value: v.value, scope: v.scope as string[] }
        : null
    case "points_multiplier":
      return typeof v.value === "number" ? { type: "points_multiplier", value: v.value } : null
    case "free_event_entries":
      return typeof v.value === "number" && v.perMonth === true
        ? { type: "free_event_entries", value: v.value, perMonth: true }
        : null
    case "lounge_hours":
      return typeof v.value === "number" && v.perMonth === true
        ? { type: "lounge_hours", value: v.value, perMonth: true }
        : null
    case "priority_release_booking":
      return { type: "priority_release_booking" }
    case "member_event_pricing":
      return { type: "member_event_pricing" }
    default:
      return null
  }
}

export interface SaleLineForPoints {
  game: string | null
  kind: string
  /** Line total in pence after discounts. */
  total: number
}

export interface EarnContext {
  lines: SaleLineForPoints[]
  /** Sale timestamp. */
  at: Date
  isFirstPurchase: boolean
  isBirthdayMonth: boolean
  tier: LoyaltyTier | null
  /** Pence paid with points (never earns points). */
  paidWithPoints: number
}

export interface EarnBreakdown {
  base: number
  ruleAdjustments: { rule: LoyaltyRule; delta: number }[]
  tierMultiplier: number
  total: number
}

function ruleIsLive(rule: LoyaltyRule, at: Date): boolean {
  if (!rule.active) return false
  if (rule.startsAt && new Date(rule.startsAt) > at) return false
  if (rule.endsAt && new Date(rule.endsAt) < at) return false
  return true
}

function lineMatches(line: SaleLineForPoints, c: LoyaltyRuleConditions): boolean {
  if (c.games && c.games.length > 0 && (!line.game || !c.games.includes(line.game))) return false
  if (c.kinds && c.kinds.length > 0 && !c.kinds.includes(line.kind)) return false
  return true
}

/**
 * Points earned on a sale: base points per pound on the eligible spend (spend
 * paid with points earns nothing), then rules in priority order (multipliers
 * stack multiplicatively on matching lines, bonuses add once), then the tier
 * multiplier. Result is rounded half-up.
 */
export function evaluateSalePoints(
  programme: LoyaltyProgramme,
  rules: LoyaltyRule[],
  ctx: EarnContext
): EarnBreakdown {
  if (!programme.enabled) return { base: 0, ruleAdjustments: [], tierMultiplier: 1, total: 0 }
  const gross = ctx.lines.reduce((s, l) => s + l.total, 0)
  const eligibleShare = gross > 0 ? Math.max(0, gross - ctx.paidWithPoints) / gross : 0
  const live = rules.filter((r) => ruleIsLive(r, ctx.at)).sort((a, b) => b.priority - a.priority)

  let base = 0
  const perLine = ctx.lines.map((line) => {
    const pounds = (line.total * eligibleShare) / 100
    let points = pounds * programme.earnPerPoundSales
    base += points
    return { line, points }
  })

  const ruleAdjustments: EarnBreakdown["ruleAdjustments"] = []
  for (const rule of live) {
    const c = rule.conditions
    if (c.minSpend !== undefined && gross < c.minSpend) continue
    switch (rule.type) {
      case "multiplier":
      case "day_of_week": {
        if (rule.type === "day_of_week" && c.weekdays && !c.weekdays.includes(ctx.at.getDay())) break
        if (rule.type === "multiplier" && c.weekdays && c.weekdays.length > 0 && !c.weekdays.includes(ctx.at.getDay())) break
        let delta = 0
        for (const entry of perLine) {
          if (!lineMatches(entry.line, c)) continue
          const before = entry.points
          entry.points = before * rule.value
          delta += entry.points - before
        }
        if (delta !== 0) ruleAdjustments.push({ rule, delta })
        break
      }
      case "fixed_bonus": {
        if (ctx.lines.some((l) => lineMatches(l, c))) ruleAdjustments.push({ rule, delta: rule.value })
        break
      }
      case "first_purchase": {
        if (ctx.isFirstPurchase) ruleAdjustments.push({ rule, delta: rule.value })
        break
      }
      case "birthday_month": {
        if (ctx.isBirthdayMonth) ruleAdjustments.push({ rule, delta: rule.value })
        break
      }
      case "trade_in_credit_bonus":
      case "event_checkin":
        // Not sale rules; handled by evaluateTradeInPoints and check-in flows.
        break
    }
  }

  const afterRules =
    perLine.reduce((s, e) => s + e.points, 0) +
    ruleAdjustments.filter((a) => a.rule.type !== "multiplier" && a.rule.type !== "day_of_week").reduce((s, a) => s + a.delta, 0)
  const tierMultiplier =
    ctx.tier?.perks.find((p): p is Extract<TierPerk, { type: "points_multiplier" }> => p.type === "points_multiplier")?.value ?? 1
  const total = roundHalfUp(afterRules * tierMultiplier)
  return { base: roundHalfUp(base), ruleAdjustments, tierMultiplier, total }
}

/** Points earned on the credit portion of a trade-in, plus any credit bonus rules. */
export function evaluateTradeInPoints(
  programme: LoyaltyProgramme,
  rules: LoyaltyRule[],
  creditPence: number,
  at: Date
): number {
  if (!programme.enabled || creditPence <= 0) return 0
  let points = (creditPence / 100) * programme.earnPerPoundTradeInCredit
  for (const rule of rules.filter((r) => ruleIsLive(r, at) && r.type === "trade_in_credit_bonus")) {
    if (rule.conditions.minSpend !== undefined && creditPence < rule.conditions.minSpend) continue
    points += rule.value
  }
  return roundHalfUp(points)
}

/** Value of points in pence at the programme rate. */
export function pointsToPence(points: number, programme: LoyaltyProgramme): number {
  return roundHalfUp((points / programme.pointsPerPoundRedemption) * 100)
}

/** Points needed to cover a pence amount (rounded up to whole points). */
export function penceToPoints(pence: number, programme: LoyaltyProgramme): number {
  return Math.ceil((pence / 100) * programme.pointsPerPoundRedemption)
}

export interface RedemptionCheck {
  ok: boolean
  reason: "ok" | "disabled" | "below_minimum" | "insufficient" | "over_share"
  maxPointsForSale: number
}

/** Can this customer pay `points` towards a sale of `saleTotal` pence? */
export function checkPointsRedemption(
  programme: LoyaltyProgramme,
  balance: number,
  points: number,
  saleTotal: number
): RedemptionCheck {
  const maxPence = roundHalfUp((saleTotal * programme.maxPointsShareOfSale) / 100)
  const maxPointsForSale = Math.min(balance, penceToPoints(maxPence, programme))
  if (!programme.enabled) return { ok: false, reason: "disabled", maxPointsForSale: 0 }
  if (points < programme.minRedeemPoints) return { ok: false, reason: "below_minimum", maxPointsForSale }
  if (points > balance) return { ok: false, reason: "insufficient", maxPointsForSale }
  if (points > maxPointsForSale) return { ok: false, reason: "over_share", maxPointsForSale }
  return { ok: true, reason: "ok", maxPointsForSale }
}

/** Tier for a rolling-window points total; paid plans are pinned by the caller. */
export function tierForPoints(tiers: LoyaltyTier[], windowPoints: number): LoyaltyTier | null {
  const earned = tiers.filter((t) => !t.paidPlan).sort((a, b) => b.thresholdPoints - a.thresholdPoints)
  return earned.find((t) => windowPoints >= t.thresholdPoints) ?? null
}

/** Points to the next tier, or null at the top. */
export function pointsToNextTier(tiers: LoyaltyTier[], windowPoints: number): { tier: LoyaltyTier; points: number } | null {
  const next = tiers
    .filter((t) => !t.paidPlan && t.thresholdPoints > windowPoints)
    .sort((a, b) => a.thresholdPoints - b.thresholdPoints)[0]
  return next ? { tier: next, points: next.thresholdPoints - windowPoints } : null
}

/** One `points_ledger` row, as much of it as the rolling window cares about. */
export interface PointsLedgerWindowRow {
  delta: number
  reason: string
  /** ISO 8601, or PocketBase's own stored form ("2026-09-20 12:00:00.000Z"). */
  created: string
}

/** Reasons that never count towards a tier: spending points must not cost a tier. */
const TIER_WINDOW_EXCLUDED_REASONS = ["redeem", "expire"]

/**
 * PocketBase stores a date as "2026-09-20 12:00:00.000Z" (a space, not the
 * ISO "T"), which not every JS engine parses. Normalising the separator
 * first means the same row reads the same in the browser, in Vitest and in
 * goja.
 */
function parseLedgerDate(value: string): Date | null {
  if (!value) return null
  const parsed = new Date(String(value).trim().replace(" ", "T"))
  return isNaN(parsed.getTime()) ? null : parsed
}

/** `at` minus `months` calendar months, clamped to the end of the target month. */
function monthsBefore(at: Date, months: number): Date {
  const d = new Date(at.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

/**
 * Points counted towards a tier: every ledger row created inside the last
 * `windowMonths` calendar months, except the rows that only ever move points
 * out again (`redeem`, `expire`). Spending points, or letting them expire,
 * never costs a tier; a `refund_reverse` or a negative `adjust` does count
 * against it, because both undo something that earned the tier in the first
 * place. `windowMonths` of 0 (or less) means all time.
 */
export function tierWindowPoints(
  rows: PointsLedgerWindowRow[],
  now: Date,
  windowMonths: number
): number {
  const start = windowMonths > 0 ? monthsBefore(now, windowMonths) : null
  let total = 0
  for (const row of rows || []) {
    if (!row) continue
    if (TIER_WINDOW_EXCLUDED_REASONS.indexOf(row.reason) >= 0) continue
    if (start) {
      const at = parseLedgerDate(row.created)
      if (!at || at.getTime() < start.getTime()) continue
    }
    total += Math.round(row.delta || 0)
  }
  return total
}

/** A tier's monthly allowance for a counted perk, 0 when the tier has none. */
export function perkAllowance(
  tier: LoyaltyTier | null,
  type: "free_event_entries" | "lounge_hours"
): number {
  if (!tier) return 0
  for (const perk of tier.perks || []) {
    if (perk && perk.type === type) return perk.value || 0
  }
  return 0
}

/**
 * The tier a customer is actually on: a paid plan grants its own tier for as
 * long as the membership is active, and the window's points earn one on their
 * own. The customer gets whichever of the two sits higher up the ladder
 * (`sort`), so buying a pass can only ever add to what somebody has already
 * earned, never take a tier off a long-standing customer whose points have
 * carried them past it. A tie goes to the membership, which is the one they
 * are paying for.
 *
 * An `activeMembershipTierId` naming a tier that no longer exists falls back
 * to the earned tier rather than leaving the customer with none.
 */
export function resolveTier(
  tiers: LoyaltyTier[],
  windowPoints: number,
  activeMembershipTierId: string | null
): LoyaltyTier | null {
  const earned = tierForPoints(tiers, windowPoints)
  if (!activeMembershipTierId) return earned
  const pinned = (tiers || []).find((t) => t && t.id === activeMembershipTierId) ?? null
  if (!pinned) return earned
  if (!earned) return pinned
  return earned.sort > pinned.sort ? earned : pinned
}
