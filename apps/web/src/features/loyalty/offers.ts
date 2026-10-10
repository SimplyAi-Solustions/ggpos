/**
 * Loyalty offers as the shop reads and writes them
 * (docs/api-contract-launch.md, section 2): a `loyalty_rules` row set up in
 * plain words. Each offer is one of the contract's templates, a sentence
 * with blanks, and reads back as one sentence ("2 times points on Trading
 * cards / Pokémon, Saturdays, until 31 October") with a live example beside
 * it ("A £30.00 Pokémon sale on a Saturday earns 600 points").
 *
 * Pure: no React, no network. The example is the shared `evaluateSalePoints`
 * over this one offer, the same arithmetic the till's preview and the sale
 * route run, so the three cannot disagree.
 */
import {
  evaluateSalePoints,
  formatGBP,
  type EarnLine,
  type LoyaltyProgramme,
  type LoyaltyRule,
  type LoyaltyRuleType,
} from "@gg/shared"

import { endOfDayLondon, parseDecimal, type Errors } from "@/features/loyalty/mapping"
import { parseCount } from "@/features/settings/mapping"
import type { LoyaltyRuleRecord, LoyaltyRuleWrite } from "@/lib/api/types"

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type OfferTemplate =
  | "times_things"
  | "bonus_things"
  | "times_days"
  | "first_purchase"
  | "birthday"

export interface OfferTemplateInfo {
  template: OfferTemplate
  type: LoyaltyRuleType
  /** The sentence with its blanks, as the "New offer" list shows it. */
  sentence: string
}

/**
 * The contract's templates after the first, which is the programme's own
 * rate ("Earn N points for every £1") and is edited on its own row.
 */
export const OFFER_TEMPLATES: readonly OfferTemplateInfo[] = [
  { template: "times_things", type: "multiplier", sentence: "N times points on branches, items or products" },
  { template: "bonus_things", type: "fixed_bonus", sentence: "N bonus points when they buy branches, items or products" },
  { template: "times_days", type: "day_of_week", sentence: "N times points on days" },
  { template: "first_purchase", type: "first_purchase", sentence: "N bonus points on their first purchase" },
  { template: "birthday", type: "birthday_month", sentence: "N bonus points in their birthday month" },
]

/** The types whose value multiplies rather than adds. */
export function multiplies(type: string): boolean {
  return type === "multiplier" || type === "day_of_week"
}

/** The types an offer can name branches, items, products and days on. */
export function takesThings(type: string): boolean {
  return type === "multiplier" || type === "day_of_week" || type === "fixed_bonus"
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface OfferForm {
  /** Stable across renders, saved or not. */
  key: string
  id: string
  type: LoyaltyRuleType
  /** "2" or "1.5" times, or "250" points. */
  value: string
  categories: string[]
  items: string[]
  products: string[]
  /** 0 is Sunday. */
  weekdays: number[]
  paidMembersOnly: boolean
  active: boolean
  /** `YYYY-MM-DD`, or empty. */
  startsAt: string
  endsAt: string
  /** Carried through: the ledger names the rule that paid. */
  name: string
  priority: number
  /** Conditions from before the launch, kept as they are unless removed. */
  games: string[]
  kinds: string[]
  /** Pence, or null for none. */
  minSpend: number | null
}

const RULE_TYPES: readonly LoyaltyRuleType[] = [
  "multiplier",
  "fixed_bonus",
  "first_purchase",
  "birthday_month",
  "trade_in_credit_bonus",
  "event_checkin",
  "day_of_week",
]

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : []
}

export function offerFromRule(record: LoyaltyRuleRecord, index = 0): OfferForm {
  const c = (record.conditions ?? {}) as Record<string, unknown>
  const type = (RULE_TYPES as readonly string[]).includes(record.type ?? "")
    ? (record.type as LoyaltyRuleType)
    : "multiplier"
  return {
    key: record.id || `offer-${index}`,
    id: record.id ?? "",
    type,
    value: String(record.value ?? 0),
    categories: strings(c.categories),
    items: strings(c.items),
    products: strings(c.products),
    weekdays: numbers(c.weekdays),
    paidMembersOnly: c.paidMembersOnly === true,
    active: record.active !== false,
    startsAt: (record.starts_at ?? "").slice(0, 10),
    endsAt: (record.ends_at ?? "").slice(0, 10),
    name: record.name ?? "",
    priority: record.priority ?? 10,
    games: strings(c.games),
    kinds: strings(c.kinds),
    minSpend: typeof c.minSpend === "number" ? c.minSpend : null,
  }
}

export function emptyOffer(template: OfferTemplate, key: string): OfferForm {
  const info = OFFER_TEMPLATES.find((entry) => entry.template === template) ?? OFFER_TEMPLATES[0]!
  return {
    key,
    id: "",
    type: info.type,
    value: multiplies(info.type) ? "2" : "100",
    categories: [],
    items: [],
    products: [],
    weekdays: [],
    paidMembersOnly: false,
    active: true,
    startsAt: "",
    endsAt: "",
    name: "",
    priority: 10,
    games: [],
    kinds: [],
    minSpend: null,
  }
}

/** Whether an offer still carries a condition from before the launch. */
export function hasOlderConditions(form: OfferForm): boolean {
  return form.games.length > 0 || form.kinds.length > 0 || form.minSpend !== null
}

export function validateOffer(form: OfferForm): Errors {
  const errors: Errors = {}
  if (multiplies(form.type)) {
    const value = parseDecimal(form.value)
    if (value === null || value <= 0) {
      errors.value = "Times is a number above 0, for example 2 or 1.5."
    } else if (value > 10) {
      errors.value = "More than 10 times points is refused. Check the figure."
    }
  } else {
    const value = parseCount(form.value)
    if (value === null || value <= 0) errors.value = "Bonus points are a whole number above 0."
  }
  if (form.type === "multiplier" && form.categories.length + form.items.length + form.products.length === 0) {
    errors.things = "Pick at least one branch, item or product."
  }
  if (form.type === "day_of_week" && form.weekdays.length === 0) {
    errors.weekdays = "Pick at least one day."
  }
  if (form.startsAt && form.endsAt && form.endsAt < form.startsAt) {
    errors.endsAt = "The end date is before the start. Swap them over."
  }
  return errors
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** What an offer's ids are called, for its sentence and its example. */
export interface OfferNames {
  branches: Record<string, { name: string; path: string; lineage: string }>
  items: Record<string, { title: string; price: number }>
  products: Record<string, { name: string; price: number }>
  games: Record<string, string>
  /** The paid plan's name, for "Guild+ members only". */
  paidTier: string
}

export const NO_NAMES: OfferNames = { branches: {}, items: {}, products: {}, games: {}, paidTier: "" }

const DAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
const DAY_ONE = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
/** The shop's week starts on a Monday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0]

/** "A", "A and B", "A, B and C". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

/** "Saturdays", "Saturdays and Sundays", "every day". */
export function daysWords(weekdays: number[]): string {
  const days = WEEK.filter((day) => weekdays.includes(day))
  if (days.length === 7) return "every day"
  return listWords(days.map((day) => DAY_PLURAL[day]!))
}

/** The branches, items and products an offer names, by name. */
export function thingsWords(form: OfferForm, names: OfferNames): string {
  const words = [
    ...form.categories.map((id) => names.branches[id]?.path ?? "a branch"),
    ...form.items.map((id) => names.items[id]?.title ?? "an item"),
    ...form.products.map((id) => names.products[id]?.name ?? "a till product"),
  ]
  if (words.length > 4) return `${words.slice(0, 3).join(", ")} and ${words.length - 3} more`
  return listWords(words)
}

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" })
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long" })

function dateOf(day: string): Date | null {
  const at = new Date(`${day}T12:00:00Z`)
  return Number.isNaN(at.getTime()) ? null : at
}

/** "from 1 November", "until 31 October", "1 to 31 October", "25 October to 2 November". */
export function datesWords(startsAt: string, endsAt: string): string {
  const start = startsAt ? dateOf(startsAt) : null
  const end = endsAt ? dateOf(endsAt) : null
  if (start && end) {
    if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()) {
      return `${start.getUTCDate()} to ${end.getUTCDate()} ${MONTH.format(end)}`
    }
    return `${DAY_MONTH.format(start)} to ${DAY_MONTH.format(end)}`
  }
  if (start) return `from ${DAY_MONTH.format(start)}`
  if (end) return `until ${DAY_MONTH.format(end)}`
  return ""
}

function valueWords(form: OfferForm): string {
  if (multiplies(form.type)) return `${parseDecimal(form.value) ?? form.value} times points`
  const points = parseCount(form.value)
  return `${points === null ? form.value : points.toLocaleString("en-GB")} bonus points`
}

/** The offer's head: what it pays and on what, before its qualifiers. */
export function offerHeadline(form: OfferForm, names: OfferNames): string {
  const things = thingsWords(form, names)
  switch (form.type) {
    case "multiplier":
    case "day_of_week":
      if (things) return `${valueWords(form)} on ${things}`
      if (form.weekdays.length > 0) return `${valueWords(form)} on ${daysWords(form.weekdays)}`
      return `${valueWords(form)} on everything`
    case "fixed_bonus":
      return `${valueWords(form)} when they buy ${things || "anything"}`
    case "first_purchase":
      return `${valueWords(form)} on their first purchase`
    case "birthday_month":
      return `${valueWords(form)} in their birthday month`
    case "trade_in_credit_bonus":
      return `${valueWords(form)} on a buy-in taken as store credit`
    case "event_checkin":
      return `${valueWords(form)} at an event check-in`
    default:
      return valueWords(form)
  }
}

/**
 * The offer as one plain sentence: "2 times points on Trading cards /
 * Pokémon, Saturdays, until 31 October".
 */
export function offerSentence(form: OfferForm, names: OfferNames): string {
  const parts = [offerHeadline(form, names)]
  const things = thingsWords(form, names)
  if (things && form.weekdays.length > 0 && takesThings(form.type)) parts.push(daysWords(form.weekdays))
  if (!things && form.type === "fixed_bonus" && form.weekdays.length > 0) parts.push(`on ${daysWords(form.weekdays)}`)
  if (form.games.length > 0) parts.push(`${listWords(form.games.map((id) => names.games[id] ?? "a game"))} only`)
  if (form.kinds.length > 0) parts.push(`${listWords(form.kinds)} only`)
  if (form.minSpend !== null && form.minSpend > 0) parts.push(`on ${formatGBP(form.minSpend)} or more`)
  if (form.paidMembersOnly) parts.push(`${names.paidTier || "paid-plan"} members only`)
  const dates = datesWords(form.startsAt, form.endsAt)
  if (dates) parts.push(dates)
  return parts.join(", ")
}

/** The programme's own rate as its sentence: "Earn 10 points for every £1". */
export function rateSentence(earnPerPound: number): string {
  return `Earn ${earnPerPound.toLocaleString("en-GB")} ${earnPerPound === 1 ? "point" : "points"} for every £1`
}

// ---------------------------------------------------------------------------
// The evaluator's side
// ---------------------------------------------------------------------------

export function offerConditions(form: OfferForm): Record<string, unknown> {
  const conditions: Record<string, unknown> = {}
  if (takesThings(form.type)) {
    if (form.categories.length > 0) conditions.categories = [...form.categories]
    if (form.items.length > 0) conditions.items = [...form.items]
    if (form.products.length > 0) conditions.products = [...form.products]
    if (form.weekdays.length > 0) conditions.weekdays = [...form.weekdays].sort((a, b) => a - b)
  }
  if (form.games.length > 0) conditions.games = [...form.games]
  if (form.kinds.length > 0) conditions.kinds = [...form.kinds]
  if (form.minSpend !== null && form.minSpend > 0) conditions.minSpend = form.minSpend
  if (form.paidMembersOnly) conditions.paidMembersOnly = true
  return conditions
}

function offerValue(form: OfferForm): number {
  return multiplies(form.type) ? (parseDecimal(form.value) ?? 0) : (parseCount(form.value) ?? 0)
}

/** The row the collection API writes. Its name is its sentence, so the ledger says what paid. */
export function offerToRule(form: OfferForm, names: OfferNames): LoyaltyRuleWrite {
  return {
    id: form.id || undefined,
    name: offerHeadline(form, names).slice(0, 200),
    type: form.type,
    conditions: offerConditions(form),
    value: offerValue(form),
    active: form.active,
    priority: form.priority,
    starts_at: form.startsAt,
    // Inclusive: an offer until the 31st runs all day on the 31st.
    ends_at: endOfDayLondon(form.endsAt),
  }
}

/** The offer as the shared evaluator reads it. */
export function offerToEvaluatorRule(form: OfferForm, names: OfferNames = NO_NAMES): LoyaltyRule {
  const write = offerToRule(form, names)
  return {
    id: form.id || form.key,
    name: write.name,
    type: form.type,
    conditions: write.conditions as LoyaltyRule["conditions"],
    value: write.value,
    active: write.active,
    priority: write.priority,
    startsAt: write.starts_at || null,
    endsAt: write.ends_at || null,
  }
}

// ---------------------------------------------------------------------------
// The live example
// ---------------------------------------------------------------------------

export interface OfferExample {
  sentence: string
  points: number
}

/** The day the example falls on: inside the offer's dates, on its first day of the week. */
function exampleDate(form: OfferForm, now: Date): Date {
  const start = form.startsAt ? dateOf(form.startsAt) : null
  const at = new Date((start && start > now ? start : now).getTime())
  at.setHours(12, 0, 0, 0)
  const wanted = WEEK.find((day) => form.weekdays.includes(day))
  if (wanted !== undefined) at.setDate(at.getDate() + ((wanted - at.getDay() + 7) % 7))
  return at
}

/**
 * What one sale earns with this offer, in a sentence: "A £30.00 Pokémon
 * sale on a Saturday earns 600 points." The sale is the first thing the
 * offer names, at its own price (an item or a product) or £30.00 (a branch,
 * or nothing named), on its first day, by somebody it applies to. Base
 * points are in it; a tier's multiplier is not, since the offer is the
 * question.
 */
export function offerExample(
  form: OfferForm,
  programme: LoyaltyProgramme,
  names: OfferNames,
  now: Date = new Date()
): OfferExample {
  const rule: LoyaltyRule = { ...offerToEvaluatorRule(form, names), active: true, startsAt: null, endsAt: null }
  let amount = Math.max(3000, form.minSpend ?? 0)
  let what = "sale"
  const line: EarnLine = {
    game: form.games[0] ?? null,
    kind: form.kinds[0] ?? "other",
    total: amount,
  }
  const branch = form.categories[0] ? names.branches[form.categories[0]] : undefined
  const item = form.items[0] ? names.items[form.items[0]] : undefined
  const product = form.products[0] ? names.products[form.products[0]] : undefined
  let lead = ""
  if (takesThings(form.type) && form.categories[0]) {
    line.lineage = branch?.lineage ?? `|${form.categories[0]}|`
    what = `${branch?.name ?? "branch"} sale`
  } else if (takesThings(form.type) && form.items[0]) {
    line.item = form.items[0]
    if (item && item.price > 0) amount = item.price
    lead = `${item?.title ?? "The item"} at ${formatGBP(amount)}`
  } else if (takesThings(form.type) && form.products[0]) {
    line.product = form.products[0]
    if (product && product.price > 0) amount = product.price
    lead = `${product?.name ?? "The till product"} at ${formatGBP(amount)}`
  }
  line.total = amount

  const at = exampleDate(form, now)
  const breakdown = evaluateSalePoints(programme, [rule], {
    lines: [line],
    at,
    isFirstPurchase: form.type === "first_purchase",
    isBirthdayMonth: form.type === "birthday_month",
    tier: null,
    paidWithPoints: 0,
    paidMember: form.paidMembersOnly,
  })

  const subject = lead || `A ${formatGBP(amount)} ${form.type === "first_purchase" ? "first purchase" : what}`
  const when = form.weekdays.length > 0 && takesThings(form.type) ? ` on a ${DAY_ONE[at.getDay()]}` : ""
  const birthday = form.type === "birthday_month" ? " in their birthday month" : ""
  const who = form.paidMembersOnly ? ` for a ${names.paidTier || "paid-plan"} member` : ""
  return {
    sentence: `${subject}${when}${birthday}${who} earns ${breakdown.total.toLocaleString("en-GB")} points.`,
    points: breakdown.total,
  }
}

/** The rate's example: "A £30.00 sale earns 300 points." */
export function rateExample(programme: LoyaltyProgramme): OfferExample {
  const breakdown = evaluateSalePoints({ ...programme, enabled: true }, [], {
    lines: [{ game: null, kind: "other", total: 3000 }],
    at: new Date(),
    isFirstPurchase: false,
    isBirthdayMonth: false,
    tier: null,
    paidWithPoints: 0,
  })
  return {
    sentence: `A ${formatGBP(3000)} sale earns ${breakdown.total.toLocaleString("en-GB")} points.`,
    points: breakdown.total,
  }
}

/** A rate typed in the rate sheet, or null when it is not a whole number of points. */
export function parseRate(text: string): number | null {
  const value = parseCount(text)
  return value === null || value > 1000 ? null : value
}
