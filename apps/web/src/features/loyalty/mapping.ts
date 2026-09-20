/**
 * The Loyalty screen's forms, and the two directions each one maps in.
 *
 * Every amount on screen is pounds and pence and every amount stored is an
 * integer of pence (CLAUDE.md, "Money"); points are whole numbers. The
 * validators say what the server will refuse before it is asked, in the
 * same words, so an admin is never sent a shape the route would bounce.
 *
 * Pure: no React, no network. `packages/shared`'s evaluator owns what a rule
 * means; this module only ever moves one between a record and a form.
 */
import { formatGBP, parseTierPerk, type LoyaltyTier, type TierPerk } from "@gg/shared"

import {
  parseCount,
  penceToPounds,
  poundsToPence,
} from "@/features/settings/mapping"
import type {
  LoyaltyProgrammeRecord,
  LoyaltyRewardRecord,
  LoyaltyRewardWrite,
  LoyaltyRuleRecord,
  LoyaltyRuleWrite,
  LoyaltyTierRecord,
  LoyaltyTierWrite,
  RewardType,
} from "@/lib/api/types"

export type Errors = Record<string, string>

/** A whole number, positive or negative, or null when it is not one. */
export function parseSigned(text: string): number | null {
  const trimmed = text.trim()
  if (!/^-?\d{1,9}$/.test(trimmed)) return null
  return Number(trimmed)
}

/** A decimal like 1.25, for a multiplier. Up to two decimal places. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null
  return Number(trimmed)
}

// ---------------------------------------------------------------------------
// Programme
// ---------------------------------------------------------------------------

export interface ProgrammeForm {
  id: string
  enabled: boolean
  name: string
  pointsName: string
  earnPerPoundSales: string
  earnOnTradeInCredit: string
  pointsPerPoundRedemption: string
  minRedeemPoints: string
  maxPointsShareOfSale: string
  expiryMonthsInactive: string
  tierWindowMonths: string
  welcomeBonus: string
  referralBonusReferrer: string
  referralBonusReferee: string
  terms: string
}

export function programmeToForm(record: LoyaltyProgrammeRecord): ProgrammeForm {
  return {
    id: record.id,
    enabled: record.enabled !== false,
    name: record.name ?? "GG Guild",
    pointsName: record.points_name ?? "GG Points",
    earnPerPoundSales: String(record.earn_per_pound_sales ?? 0),
    earnOnTradeInCredit: String(record.earn_on_trade_in_credit ?? 0),
    pointsPerPoundRedemption: String(record.points_per_pound_redemption ?? 0),
    minRedeemPoints: String(record.min_redeem_points ?? 0),
    maxPointsShareOfSale: String(Math.round(record.max_points_share_of_sale ?? 0)),
    expiryMonthsInactive: String(record.expiry_months_inactive ?? 0),
    tierWindowMonths: String(record.tier_window_months ?? 0),
    welcomeBonus: String(record.welcome_bonus ?? 0),
    referralBonusReferrer: String(record.referral_bonus_referrer ?? 0),
    referralBonusReferee: String(record.referral_bonus_referee ?? 0),
    terms: record.terms ?? "",
  }
}

export function validateProgramme(form: ProgrammeForm): Errors {
  const errors: Errors = {}
  if (!form.name.trim()) {
    errors.name = "Give the programme a name. It is on the customer's card."
  }
  if (!form.pointsName.trim()) {
    errors.pointsName = "Give the points a name, for example GG Points."
  }
  const counts: [keyof ProgrammeForm, string][] = [
    ["earnPerPoundSales", "Points earned per pound"],
    ["earnOnTradeInCredit", "Points earned per pound of credit"],
    ["pointsPerPoundRedemption", "Points a pound is worth"],
    ["minRedeemPoints", "The minimum redemption"],
    ["expiryMonthsInactive", "The expiry"],
    ["tierWindowMonths", "The tier window"],
    ["welcomeBonus", "The welcome bonus"],
    ["referralBonusReferrer", "The referrer's bonus"],
    ["referralBonusReferee", "The referee's bonus"],
  ]
  for (const [key, label] of counts) {
    if (parseCount(String(form[key])) === null) {
      errors[key] = `${label} is a whole number of points or months.`
    }
  }
  if (parseCount(form.pointsPerPoundRedemption) === 0) {
    errors.pointsPerPoundRedemption =
      "Points have to be worth something. Set how many make a pound."
  }
  const share = parseCount(form.maxPointsShareOfSale)
  if (share === null || share > 100) {
    errors.maxPointsShareOfSale = "A share of a sale is 0 to 100 percent."
  }
  return errors
}

export function formToProgramme(
  form: ProgrammeForm
): Partial<LoyaltyProgrammeRecord> {
  return {
    enabled: form.enabled,
    name: form.name.trim(),
    points_name: form.pointsName.trim(),
    earn_per_pound_sales: parseCount(form.earnPerPoundSales) ?? 0,
    earn_on_trade_in_credit: parseCount(form.earnOnTradeInCredit) ?? 0,
    points_per_pound_redemption: parseCount(form.pointsPerPoundRedemption) ?? 0,
    min_redeem_points: parseCount(form.minRedeemPoints) ?? 0,
    max_points_share_of_sale: parseCount(form.maxPointsShareOfSale) ?? 0,
    expiry_months_inactive: parseCount(form.expiryMonthsInactive) ?? 0,
    tier_window_months: parseCount(form.tierWindowMonths) ?? 0,
    welcome_bonus: parseCount(form.welcomeBonus) ?? 0,
    referral_bonus_referrer: parseCount(form.referralBonusReferrer) ?? 0,
    referral_bonus_referee: parseCount(form.referralBonusReferee) ?? 0,
    terms: form.terms,
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const RULE_TYPES = [
  "multiplier",
  "fixed_bonus",
  "first_purchase",
  "birthday_month",
  "trade_in_credit_bonus",
  "event_checkin",
  "day_of_week",
] as const

export type RuleType = (typeof RULE_TYPES)[number]

export const RULE_TYPE_LABEL: Record<RuleType, string> = {
  multiplier: "Multiplier",
  fixed_bonus: "Fixed bonus",
  first_purchase: "First purchase",
  birthday_month: "Birthday month",
  trade_in_credit_bonus: "Trade-in credit bonus",
  event_checkin: "Event check-in",
  day_of_week: "Day of the week",
}

/** The types whose `value` multiplies rather than adds. */
export function isMultiplierType(type: string): boolean {
  return type === "multiplier" || type === "day_of_week"
}

export interface RuleForm {
  /** Stable across a render, whether or not the row has been saved. */
  key: string
  id: string
  name: string
  type: RuleType
  /** `games` record ids. Empty means every game. */
  games: string[]
  /** Item kinds. Empty means every kind. */
  kinds: string[]
  /** Pounds, empty for no minimum. */
  minSpend: string
  /** 0 is Sunday. Empty means every day. */
  weekdays: number[]
  value: string
  active: boolean
  priority: string
  /** `YYYY-MM-DD`, or empty. */
  startsAt: string
  endsAt: string
}

function isoDay(value: string | undefined): string {
  if (!value) return ""
  return value.slice(0, 10)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : []
}

export function ruleToForm(record: LoyaltyRuleRecord, index = 0): RuleForm {
  const conditions = (record.conditions ?? {}) as Record<string, unknown>
  const minSpend = conditions.minSpend
  return {
    key: record.id || `new-${index}`,
    id: record.id ?? "",
    name: record.name ?? "",
    type: (RULE_TYPES as readonly string[]).includes(record.type ?? "")
      ? (record.type as RuleType)
      : "multiplier",
    games: stringList(conditions.games),
    kinds: stringList(conditions.kinds),
    minSpend: typeof minSpend === "number" ? penceToPounds(minSpend) : "",
    weekdays: numberList(conditions.weekdays),
    value: String(record.value ?? 0),
    active: record.active !== false,
    priority: String(record.priority ?? 0),
    startsAt: isoDay(record.starts_at),
    endsAt: isoDay(record.ends_at),
  }
}

export function emptyRule(key: string): RuleForm {
  return {
    key,
    id: "",
    name: "",
    type: "multiplier",
    games: [],
    kinds: [],
    minSpend: "",
    weekdays: [],
    value: "2",
    active: true,
    priority: "10",
    startsAt: "",
    endsAt: "",
  }
}

export function validateRule(form: RuleForm): Errors {
  const errors: Errors = {}
  if (!form.name.trim()) {
    errors.name = "Name the rule so the ledger can say which one paid."
  }
  const value = isMultiplierType(form.type)
    ? parseDecimal(form.value)
    : parseCount(form.value)
  if (value === null || value <= 0) {
    errors.value = isMultiplierType(form.type)
      ? "A multiplier is a number above 0, for example 2 or 1.5."
      : "A bonus is a whole number of points above 0."
  } else if (isMultiplierType(form.type) && value > 10) {
    errors.value = "A multiplier of more than 10 is refused. Check the figure."
  }
  if (form.minSpend.trim() && poundsToPence(form.minSpend) === null) {
    errors.minSpend = "A minimum spend is pounds and pence, for example 20.00."
  }
  if (parseSigned(form.priority) === null) {
    errors.priority = "Priority is a whole number. The highest runs first."
  }
  if (form.startsAt && form.endsAt && form.endsAt < form.startsAt) {
    errors.endsAt = "The end date is before the start. Swap them over."
  }
  return errors
}

export function ruleConditions(form: RuleForm): Record<string, unknown> {
  const conditions: Record<string, unknown> = {}
  if (form.games.length > 0) conditions.games = form.games
  if (form.kinds.length > 0) conditions.kinds = form.kinds
  const minSpend = form.minSpend.trim() ? poundsToPence(form.minSpend) : null
  if (minSpend !== null && minSpend > 0) conditions.minSpend = minSpend
  if (form.weekdays.length > 0) {
    conditions.weekdays = [...form.weekdays].sort((a, b) => a - b)
  }
  return conditions
}

export function formToRule(form: RuleForm): LoyaltyRuleWrite {
  const value = isMultiplierType(form.type)
    ? (parseDecimal(form.value) ?? 0)
    : (parseCount(form.value) ?? 0)
  return {
    id: form.id || undefined,
    name: form.name.trim(),
    type: form.type,
    conditions: ruleConditions(form),
    value,
    active: form.active,
    priority: parseSigned(form.priority) ?? 0,
    starts_at: form.startsAt,
    ends_at: form.endsAt,
  }
}

/** The form as the shared evaluator reads it, for the live preview. */
export function formToEvaluatorRule(form: RuleForm) {
  const write = formToRule(form)
  return {
    id: form.id || form.key,
    name: write.name,
    type: write.type as RuleType,
    conditions: write.conditions as {
      games?: string[]
      kinds?: string[]
      minSpend?: number
      weekdays?: number[]
    },
    value: write.value,
    active: write.active,
    priority: write.priority,
    startsAt: write.starts_at || null,
    endsAt: write.ends_at || null,
  }
}

/** "Every game, sealed, Saturdays, over £20.00" for the list row. */
export function ruleSummary(
  form: RuleForm,
  gameNames: Record<string, string>,
  weekdayNames: readonly string[]
): string {
  const parts: string[] = []
  parts.push(
    form.games.length > 0
      ? form.games.map((id) => gameNames[id] ?? "A game").join(", ")
      : "Every game"
  )
  if (form.kinds.length > 0) parts.push(form.kinds.join(", "))
  if (form.weekdays.length > 0) {
    parts.push(form.weekdays.map((day) => weekdayNames[day] ?? "").filter(Boolean).join(", "))
  }
  const minSpend = form.minSpend.trim() ? poundsToPence(form.minSpend) : null
  if (minSpend) parts.push(`over ${formatGBP(minSpend)}`)
  return parts.join(" · ")
}

// ---------------------------------------------------------------------------
// Tiers and their perks
// ---------------------------------------------------------------------------

export const PERK_SCOPES = [
  "single",
  "graded",
  "retro",
  "sealed",
  "accessory",
  "other",
] as const

export interface TierForm {
  key: string
  id: string
  name: string
  thresholdPoints: string
  sort: string
  paidPlan: boolean
  percentOff: boolean
  percentOffValue: string
  percentOffScope: string[]
  multiplier: boolean
  multiplierValue: string
  freeEntries: boolean
  freeEntriesValue: string
  loungeHours: boolean
  loungeHoursValue: string
  priorityBooking: boolean
  memberEventPricing: boolean
}

export function tierToForm(record: LoyaltyTierRecord, index = 0): TierForm {
  const perks = (Array.isArray(record.perks) ? record.perks : [])
    .map(parseTierPerk)
    .filter((perk): perk is TierPerk => perk !== null)
  const percent = perks.find((perk) => perk.type === "percent_off")
  const multiplier = perks.find((perk) => perk.type === "points_multiplier")
  const entries = perks.find((perk) => perk.type === "free_event_entries")
  const lounge = perks.find((perk) => perk.type === "lounge_hours")
  return {
    key: record.id || `new-${index}`,
    id: record.id ?? "",
    name: record.name ?? "",
    thresholdPoints: String(record.threshold_points ?? 0),
    sort: String(record.sort ?? (index + 1) * 10),
    paidPlan: record.paid_plan === true,
    percentOff: Boolean(percent),
    percentOffValue: percent && "value" in percent ? String(percent.value) : "5",
    percentOffScope: percent && "scope" in percent ? percent.scope : ["sealed"],
    multiplier: Boolean(multiplier),
    multiplierValue:
      multiplier && "value" in multiplier ? String(multiplier.value) : "1.25",
    freeEntries: Boolean(entries),
    freeEntriesValue: entries && "value" in entries ? String(entries.value) : "2",
    loungeHours: Boolean(lounge),
    loungeHoursValue: lounge && "value" in lounge ? String(lounge.value) : "4",
    priorityBooking: perks.some((perk) => perk.type === "priority_release_booking"),
    memberEventPricing: perks.some((perk) => perk.type === "member_event_pricing"),
  }
}

export function emptyTier(key: string, sort: number): TierForm {
  return {
    key,
    id: "",
    name: "",
    thresholdPoints: "0",
    sort: String(sort),
    paidPlan: false,
    percentOff: false,
    percentOffValue: "5",
    percentOffScope: ["sealed"],
    multiplier: false,
    multiplierValue: "1.25",
    freeEntries: false,
    freeEntriesValue: "2",
    loungeHours: false,
    loungeHoursValue: "4",
    priorityBooking: false,
    memberEventPricing: false,
  }
}

export function tierPerks(form: TierForm): TierPerk[] {
  const perks: TierPerk[] = []
  if (form.percentOff) {
    perks.push({
      type: "percent_off",
      value: parseCount(form.percentOffValue) ?? 0,
      scope: form.percentOffScope,
    })
  }
  if (form.multiplier) {
    perks.push({
      type: "points_multiplier",
      value: parseDecimal(form.multiplierValue) ?? 1,
    })
  }
  if (form.freeEntries) {
    perks.push({
      type: "free_event_entries",
      value: parseCount(form.freeEntriesValue) ?? 0,
      perMonth: true,
    })
  }
  if (form.loungeHours) {
    perks.push({
      type: "lounge_hours",
      value: parseCount(form.loungeHoursValue) ?? 0,
      perMonth: true,
    })
  }
  if (form.priorityBooking) perks.push({ type: "priority_release_booking" })
  if (form.memberEventPricing) perks.push({ type: "member_event_pricing" })
  return perks
}

export function validateTier(form: TierForm, others: TierForm[]): Errors {
  const errors: Errors = {}
  if (!form.name.trim()) errors.name = "Name the tier. The badge shows this name."
  const threshold = parseCount(form.thresholdPoints)
  if (threshold === null) {
    errors.thresholdPoints = "A threshold is a whole number of points."
  } else if (!form.paidPlan) {
    const clash = others.find(
      (other) =>
        other.key !== form.key &&
        !other.paidPlan &&
        parseCount(other.thresholdPoints) === threshold
    )
    if (clash) {
      errors.thresholdPoints = `${clash.name || "Another tier"} already starts at ${threshold.toLocaleString("en-GB")} points. Pick a different threshold.`
    }
  }
  if (parseSigned(form.sort) === null) {
    errors.sort = "Sort is a whole number. The lowest shows first."
  }
  if (form.percentOff) {
    const percent = parseCount(form.percentOffValue)
    if (percent === null || percent <= 0 || percent > 100) {
      errors.percentOffValue = "A percent off is 1 to 100."
    }
    if (form.percentOffScope.length === 0) {
      errors.percentOffScope = "Pick what the discount applies to."
    }
  }
  if (form.multiplier) {
    const value = parseDecimal(form.multiplierValue)
    if (value === null || value <= 0 || value > 10) {
      errors.multiplierValue = "A multiplier is a number above 0 and at most 10."
    }
  }
  if (form.freeEntries && (parseCount(form.freeEntriesValue) ?? 0) <= 0) {
    errors.freeEntriesValue = "Free entries are a whole number a month."
  }
  if (form.loungeHours && (parseCount(form.loungeHoursValue) ?? 0) <= 0) {
    errors.loungeHoursValue = "Lounge hours are a whole number a month."
  }
  return errors
}

export function formToTier(form: TierForm): LoyaltyTierWrite {
  return {
    id: form.id || undefined,
    name: form.name.trim(),
    threshold_points: parseCount(form.thresholdPoints) ?? 0,
    sort: parseSigned(form.sort) ?? 0,
    perks: tierPerks(form) as unknown[],
    paid_plan: form.paidPlan,
  }
}

/** A tier form as the shared evaluator reads it, for the live preview. */
export function formToEvaluatorTier(form: TierForm): LoyaltyTier {
  return {
    id: form.id || form.key,
    name: form.name,
    thresholdPoints: parseCount(form.thresholdPoints) ?? 0,
    sort: parseSigned(form.sort) ?? 0,
    perks: tierPerks(form),
    paidPlan: form.paidPlan,
  }
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export const REWARD_TYPES: RewardType[] = [
  "money_off",
  "store_credit",
  "free_item",
  "event_entry",
  "custom",
]

export const REWARD_TYPE_LABEL: Record<RewardType, string> = {
  money_off: "Money off",
  store_credit: "Store credit",
  free_item: "Free item",
  event_entry: "Event entry",
  custom: "Custom",
}

/** The two types whose `value` is money rather than a count. */
export function rewardValueIsMoney(type: RewardType): boolean {
  return type === "money_off" || type === "store_credit"
}

export interface RewardForm {
  key: string
  id: string
  name: string
  description: string
  costPoints: string
  type: RewardType
  /** Pounds when the type is money, a plain count otherwise. */
  value: string
  stockLimit: string
  perCustomerLimit: string
  active: boolean
  startsAt: string
  endsAt: string
  image: File | null
  imageUrl: string
}

export function rewardToForm(record: LoyaltyRewardRecord, index = 0): RewardForm {
  const type = record.type
  return {
    key: record.id || `new-${index}`,
    id: record.id ?? "",
    name: record.name ?? "",
    description: record.description ?? "",
    costPoints: String(record.cost_points ?? 0),
    type,
    value: rewardValueIsMoney(type)
      ? penceToPounds(record.value ?? 0)
      : String(record.value ?? 0),
    stockLimit: record.stock_limit ? String(record.stock_limit) : "",
    perCustomerLimit: record.per_customer_limit
      ? String(record.per_customer_limit)
      : "",
    active: record.active !== false,
    startsAt: isoDay(record.starts_at),
    endsAt: isoDay(record.ends_at),
    image: null,
    imageUrl: record.imageUrl ?? "",
  }
}

export function emptyReward(key: string): RewardForm {
  return {
    key,
    id: "",
    name: "",
    description: "",
    costPoints: "500",
    type: "money_off",
    value: "5.00",
    stockLimit: "",
    perCustomerLimit: "",
    active: true,
    startsAt: "",
    endsAt: "",
    image: null,
    imageUrl: "",
  }
}

export function validateReward(form: RewardForm): Errors {
  const errors: Errors = {}
  if (!form.name.trim()) errors.name = "Name the reward. The customer sees this."
  if (parseCount(form.costPoints) === null) {
    errors.costPoints = "A cost is a whole number of points."
  }
  if (rewardValueIsMoney(form.type)) {
    const pence = poundsToPence(form.value)
    if (pence === null || pence <= 0) {
      errors.value = "Enter what it is worth in pounds and pence, for example 5.00."
    }
  } else if (parseCount(form.value) === null) {
    errors.value = "A value is a whole number, or 0 when it is not counted."
  }
  if (form.stockLimit.trim() && parseCount(form.stockLimit) === null) {
    errors.stockLimit = "A stock limit is a whole number, or empty for no limit."
  }
  if (form.perCustomerLimit.trim() && parseCount(form.perCustomerLimit) === null) {
    errors.perCustomerLimit =
      "A per-customer limit is a whole number, or empty for no limit."
  }
  if (form.startsAt && form.endsAt && form.endsAt < form.startsAt) {
    errors.endsAt = "The end date is before the start. Swap them over."
  }
  return errors
}

export function formToReward(form: RewardForm): LoyaltyRewardWrite {
  return {
    id: form.id || undefined,
    name: form.name.trim(),
    description: form.description.trim(),
    cost_points: parseCount(form.costPoints) ?? 0,
    type: form.type,
    value: rewardValueIsMoney(form.type)
      ? (poundsToPence(form.value) ?? 0)
      : (parseCount(form.value) ?? 0),
    stock_limit: parseCount(form.stockLimit) ?? 0,
    per_customer_limit: parseCount(form.perCustomerLimit) ?? 0,
    active: form.active,
    starts_at: form.startsAt,
    ends_at: form.endsAt,
    image: form.image,
  }
}

// ---------------------------------------------------------------------------
// Memberships and adjustments
// ---------------------------------------------------------------------------

export interface MembershipForm {
  customer: string
  customerName: string
  tier: string
  months: string
  price: string
  note: string
}

export const EMPTY_MEMBERSHIP: MembershipForm = {
  customer: "",
  customerName: "",
  tier: "",
  months: "12",
  price: "",
  note: "",
}

export function validateMembership(form: MembershipForm): Errors {
  const errors: Errors = {}
  if (!form.customer) errors.customer = "Find the customer this plan is for."
  if (!form.tier) errors.tier = "Pick the tier the plan grants."
  const months = parseCount(form.months)
  if (months === null || months < 1 || months > 24) {
    errors.months = "A plan runs for 1 to 24 months."
  }
  const price = poundsToPence(form.price)
  if (price === null || price < 0) {
    errors.price = "Enter what they paid, in pounds and pence."
  }
  return errors
}

export interface AdjustForm {
  customer: string
  customerName: string
  /** Signed whole points. */
  delta: string
  reason: string
}

export const EMPTY_ADJUST: AdjustForm = {
  customer: "",
  customerName: "",
  delta: "",
  reason: "",
}

export function validateAdjust(form: AdjustForm, balance: number): Errors {
  const errors: Errors = {}
  if (!form.customer) errors.customer = "Find the customer whose points change."
  const delta = parseSigned(form.delta)
  if (delta === null || delta === 0) {
    errors.delta = "Enter the points to add, or a minus figure to take away."
  } else if (delta < 0 && balance + delta < 0) {
    errors.delta = `That would take them to ${(balance + delta).toLocaleString("en-GB")} points. The most you can remove is ${balance.toLocaleString("en-GB")}.`
  }
  const reason = form.reason.trim()
  if (reason.length < 5) {
    errors.reason = "Say why, in a few words. It goes on their record."
  } else if (reason.length > 500) {
    errors.reason = "That reason is too long. Keep it under 500 characters."
  }
  return errors
}
