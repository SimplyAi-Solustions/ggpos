/**
 * The live points preview on the Loyalty screen.
 *
 * Pure: the controls become an `EarnContext`, the shared `evaluateSalePoints`
 * answers it over the rules exactly as they are being edited, and the
 * breakdown becomes the rows on screen. The admin sees the same arithmetic
 * the server will run, before saving anything.
 */
import {
  formatGBP,
  type EarnBreakdown,
  type EarnContext,
  type LoyaltyProgramme,
  type LoyaltyTier,
} from "@gg/shared"

/** Sunday first, the way `Date.getDay` counts and the rules store weekdays. */
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const

export const PREVIEW_KINDS = [
  "single",
  "graded",
  "retro",
  "sealed",
  "accessory",
  "other",
] as const

export const KIND_LABEL: Record<string, string> = {
  single: "single",
  graded: "graded",
  retro: "retro",
  sealed: "sealed",
  accessory: "accessory",
  other: "other",
}

export interface PreviewInput {
  /** Integer GBP pence. */
  amount: number
  /** A `games` record id, or null for a sale with no game on it. */
  game: string | null
  kind: string
  /** 0 is Sunday, 6 is Saturday. */
  weekday: number
  tierId: string | null
  firstPurchase: boolean
  birthdayMonth: boolean
}

export const EMPTY_PREVIEW: PreviewInput = {
  amount: 3000,
  game: null,
  kind: "sealed",
  weekday: 6,
  tierId: null,
  firstPurchase: false,
  birthdayMonth: false,
}

/**
 * The date the preview evaluates at: this week's chosen weekday, at midday.
 *
 * It has to be a real date near today, because a rule can carry a start and
 * an end, and a preview run in 1970 would quietly drop every dated rule.
 */
export function previewDate(weekday: number, now: Date = new Date()): Date {
  const at = new Date(now.getTime())
  at.setHours(12, 0, 0, 0)
  at.setDate(at.getDate() + ((weekday - at.getDay() + 7) % 7))
  return at
}

export function previewContext(
  input: PreviewInput,
  tiers: LoyaltyTier[],
  now: Date = new Date()
): EarnContext {
  return {
    lines: [{ game: input.game, kind: input.kind, total: input.amount }],
    at: previewDate(input.weekday, now),
    isFirstPurchase: input.firstPurchase,
    isBirthdayMonth: input.birthdayMonth,
    tier: tiers.find((tier) => tier.id === input.tierId) ?? null,
    paidWithPoints: 0,
  }
}

export interface PreviewRow {
  key: string
  label: string
  /** The grey line under the label: what the rule is, or how base is worked out. */
  detail: string
  /** Already signed and localised, for example "+250" or "x 1.25". */
  points: string
}

/** A signed, grouped points figure: 1250 becomes "+1,250". */
export function signedPoints(points: number): string {
  const rounded = Math.round(points)
  return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded).toLocaleString("en-GB")}`
}

/**
 * The breakdown as rows: base, one per rule that changed anything, and the
 * tier multiplier. The total is shown on its own beside the sentence, so it
 * is not repeated here.
 */
export function previewRows(
  breakdown: EarnBreakdown,
  programme: LoyaltyProgramme,
  input: PreviewInput
): PreviewRow[] {
  const rows: PreviewRow[] = [
    {
      key: "base",
      label: "Base",
      detail: `${programme.earnPerPoundSales.toLocaleString("en-GB")} points per £1 on ${formatGBP(input.amount)}`,
      points: signedPoints(breakdown.base),
    },
  ]

  for (const adjustment of breakdown.ruleAdjustments) {
    rows.push({
      key: adjustment.rule.id,
      label: adjustment.rule.name || "Rule",
      detail: ruleDetail(adjustment.rule.type, adjustment.rule.value),
      points: signedPoints(adjustment.delta),
    })
  }

  if (breakdown.tierMultiplier !== 1) {
    rows.push({
      key: "tier",
      label: "Tier multiplier",
      detail: "Applied to everything above",
      points: `x ${breakdown.tierMultiplier}`,
    })
  }

  return rows
}

function ruleDetail(type: string, value: number): string {
  switch (type) {
    case "multiplier":
    case "day_of_week":
      return `Multiplies matching lines by ${value}`
    case "fixed_bonus":
      return "A flat bonus on a matching sale"
    case "first_purchase":
      return "Their first purchase"
    case "birthday_month":
      return "Their birthday month"
    default:
      return "Applied to this sale"
  }
}

export interface PreviewNames {
  gameName: string | null
  tierName: string | null
}

/**
 * The one sentence over the breakdown: "A £30.00 Pokemon sealed sale on a
 * Saturday for a Regular earns 600 points."
 */
export function previewSentence(
  input: PreviewInput,
  names: PreviewNames,
  points: number
): string {
  const game = names.gameName ? `${names.gameName} ` : ""
  const kind = KIND_LABEL[input.kind] ?? input.kind
  const who = names.tierName ? `for a ${names.tierName}` : "for a customer with no tier"
  const extras: string[] = []
  if (input.firstPurchase) extras.push("on their first purchase")
  if (input.birthdayMonth) extras.push("in their birthday month")
  const tail = extras.length > 0 ? `, ${extras.join(" and ")},` : ""
  return `A ${formatGBP(input.amount)} ${game}${kind} sale on a ${WEEKDAYS[input.weekday]} ${who}${tail} earns ${Math.round(points).toLocaleString("en-GB")} points.`
}
