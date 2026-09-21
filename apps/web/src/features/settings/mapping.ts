/**
 * The Settings form, and the two directions it maps in.
 *
 * Every amount on screen is pounds and pence, and every amount stored is an
 * integer of pence (CLAUDE.md, "Money"), so the pound fields are text until
 * they are saved and `parseDecimalToMinor` is the only thing that turns one
 * into a number. Percentages are whole numbers on screen; the multipliers
 * and markups the shared evaluators want are worked out here, once.
 *
 * Nothing in this module touches a secret: `settings.api_keys`, the mail key
 * and the VAPID keys are not fields of the form and are not written by a
 * save.
 */
import {
  DEFAULT_RETRO_PRIORITY,
  DEFAULT_TCG_PRIORITY,
  formatGBP,
  parseDecimalToMinor,
  type PriceSource,
  type PricingRule,
  type RoundingStep,
} from "@gg/shared"

import type { PricingRuleRow, PricingRuleWrite, SettingsRecord } from "@/lib/api/types"
import { formatPercent } from "@/lib/format"

// ---------------------------------------------------------------------------
// Money and percentages
// ---------------------------------------------------------------------------

/** 32499 becomes "324.99". An unset field is empty, not "0.00". */
export function penceToPounds(pence: number | undefined | null): string {
  if (pence === undefined || pence === null) return ""
  const negative = pence < 0
  const abs = Math.abs(pence)
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`
}

/** "324.99", "£324.99" and "324" all become 32499. Anything else is null. */
export function poundsToPence(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === "") return null
  return parseDecimalToMinor(trimmed)
}

/** A whole percent from the form, or null when it is not one. */
export function parsePercent(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  return Number(trimmed)
}

/** A whole count (retention months, quote days, priority), or null. */
export function parseCount(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,6}$/.test(trimmed)) return null
  return Number(trimmed)
}

/** 85 percent of market becomes the 0.85 multiplier the evaluator applies. */
export function percentToMultiplier(percent: number): number {
  return percent / 100
}

export function multiplierToPercent(multiplier: number | undefined, fallback: number): string {
  if (multiplier === undefined || Number.isNaN(multiplier)) return String(fallback)
  return String(Math.round(multiplier * 100))
}

/** A 10 percent markup is the 1.1 multiplier `suggestSellPrice` takes. */
export function markupToMultiplier(percent: number): number {
  return 1 + percent / 100
}

export function multiplierToMarkup(multiplier: number | undefined): string {
  if (multiplier === undefined || Number.isNaN(multiplier)) return "0"
  return String(Math.round((multiplier - 1) * 100))
}

// ---------------------------------------------------------------------------
// Pricing rules
// ---------------------------------------------------------------------------

export const RULE_KINDS = [
  "single",
  "graded",
  "retro",
  "sealed",
  "accessory",
  "other",
] as const

/**
 * What a rule's condition can be. `pricing_rules.condition` is free text
 * rather than the `items.condition` select, because a retro line keys on
 * completeness instead (pb_migrations/1789819560_ops_collections.js), so
 * both sets are offered and the menu says which is which.
 */
export const RULE_CARD_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const
export const RULE_RETRO_CONDITIONS = ["loose", "boxed", "cib"] as const
export const RULE_CONDITIONS = [
  ...RULE_CARD_CONDITIONS,
  ...RULE_RETRO_CONDITIONS,
] as const

export const ROUNDING_STEPS: RoundingStep[] = [25, 50, 100]

export interface RuleForm {
  /** Stable across a render, whether or not the row has been saved. */
  key: string
  /** The record id, or "" for a row that has never been saved. */
  id: string
  /** A `games` record id, or "" for any game. */
  game: string
  kind: string
  condition: string
  finish: string
  rarity: string
  /** Pounds. */
  bandMin: string
  /** Pounds; empty means the band has no top. */
  bandMax: string
  cashPct: string
  creditPct: string
  rounding: RoundingStep
  priority: string
  active: boolean
}

/** "" , null and undefined all mean "any", and the matrix prints "Any". */
export function wildcardLabel(value: string | null | undefined): string {
  return value ? value : "Any"
}

/** "£0.00 to £5.00", or "£50.00 and up" for an open-ended band. */
export function bandLabel(minPence: number, maxPence: number | null): string {
  if (maxPence === null || maxPence === 0) return `${formatGBP(minPence)} and up`
  return `${formatGBP(minPence)} to ${formatGBP(maxPence)}`
}

/** A rule's band, in the words the row shows: "£0.00 to £30.00". */
export function ruleBandLabel(rule: RuleForm): string {
  const min = poundsToPence(rule.bandMin) ?? 0
  const max = poundsToPence(rule.bandMax)
  return bandLabel(min, max)
}

/**
 * The band and its two payout shares, for the row a phone shows instead of
 * the table. `cashPct` and `creditPct` are live form fields, so a rule being
 * retyped can hold "" or "5o": `parsePercent` gives null for those and the
 * share is left out rather than coerced into a confident "0% cash", which
 * would tell an admin the shop pays nothing for that band.
 */
export function rulePayoutLine(rule: RuleForm): string {
  const cash = formatPercent(parsePercent(rule.cashPct))
  const credit = formatPercent(parsePercent(rule.creditPct))
  const shares = [cash ? `${cash} cash` : "", credit ? `${credit} credit` : ""].filter(
    Boolean
  )
  return [ruleBandLabel(rule), ...shares].join(" · ")
}

function step(value: number | undefined): RoundingStep {
  return value === 50 || value === 100 ? value : 25
}

export function ruleRowToForm(row: PricingRuleRow, index = 0): RuleForm {
  return {
    key: row.id || `new-${index}`,
    id: row.id ?? "",
    game: row.game ?? "",
    kind: row.kind ?? "",
    condition: row.condition ?? "",
    finish: row.finish ?? "",
    rarity: row.rarity ?? "",
    bandMin: penceToPounds(row.band_min ?? 0),
    // Stored as 0 rather than null: PocketBase's number field has no null
    // state, and the shared `isOpenEndedBand` reads 0 as "no top".
    bandMax: row.band_max ? penceToPounds(row.band_max) : "",
    cashPct: String(Math.round(row.cash_pct ?? 0)),
    creditPct: String(Math.round(row.credit_pct ?? 0)),
    rounding: step(row.rounding),
    priority: String(row.priority ?? 0),
    active: row.active !== false,
  }
}

/** A blank row, at the bottom of the matrix by priority. */
export function emptyRuleForm(key: string): RuleForm {
  return {
    key,
    id: "",
    game: "",
    kind: "single",
    condition: "",
    finish: "",
    rarity: "",
    bandMin: "0.00",
    bandMax: "",
    cashPct: "50",
    creditPct: "65",
    rounding: 50,
    priority: "0",
    active: true,
  }
}

/** The row as the collection API takes it. Money is pence, percents are whole. */
export function formToRuleWrite(form: RuleForm): PricingRuleWrite {
  const write: PricingRuleWrite = {
    game: form.game,
    kind: form.kind,
    condition: form.condition,
    finish: form.finish,
    rarity: form.rarity,
    band_min: poundsToPence(form.bandMin) ?? 0,
    band_max: poundsToPence(form.bandMax) ?? 0,
    cash_pct: parsePercent(form.cashPct) ?? 0,
    credit_pct: parsePercent(form.creditPct) ?? 0,
    rounding: form.rounding,
    priority: parseCount(form.priority) ?? 0,
    active: form.active,
  }
  if (form.id) write.id = form.id
  return write
}

/**
 * The rule in the shape the shared evaluator takes, so the preview runs the
 * very arithmetic the counter will run, on the rules as they stand in the
 * form rather than as they were last saved.
 */
export function formToPricingRule(form: RuleForm): PricingRule {
  const bandMax = poundsToPence(form.bandMax)
  return {
    id: form.id || form.key,
    game: form.game || null,
    kind: form.kind || null,
    condition: form.condition || null,
    finish: form.finish || null,
    rarity: form.rarity || null,
    bandMin: poundsToPence(form.bandMin) ?? 0,
    bandMax: bandMax === null || bandMax === 0 ? null : bandMax,
    cashPct: parsePercent(form.cashPct) ?? 0,
    creditPct: parsePercent(form.creditPct) ?? 0,
    rounding: form.rounding,
    priority: parseCount(form.priority) ?? 0,
    active: form.active,
  }
}

/** True when the row differs from the one the server sent. */
export function ruleChanged(form: RuleForm, original: RuleForm | undefined): boolean {
  if (!original) return true
  return (
    form.game !== original.game ||
    form.kind !== original.kind ||
    form.condition !== original.condition ||
    form.finish !== original.finish ||
    form.rarity !== original.rarity ||
    form.bandMin !== original.bandMin ||
    form.bandMax !== original.bandMax ||
    form.cashPct !== original.cashPct ||
    form.creditPct !== original.creditPct ||
    form.rounding !== original.rounding ||
    form.priority !== original.priority ||
    form.active !== original.active
  )
}

// ---------------------------------------------------------------------------
// The settings form
// ---------------------------------------------------------------------------

export const CONDITION_KEYS = ["LP", "MP", "HP", "DMG"] as const
export type ConditionKey = (typeof CONDITION_KEYS)[number]

export const RETENTION_MONTHS = [6, 12, 24] as const

export const SOURCE_LABELS: Record<PriceSource, string> = {
  uk_sold_manual: "UK sold comp",
  ebay_uk_asking: "eBay UK asking",
  cardmarket: "Cardmarket, EUR",
  tcgplayer: "TCGplayer, USD",
  pricecharting_pal: "PriceCharting PAL",
  pricecharting_ntsc: "PriceCharting NTSC",
}

/**
 * The asking-to-sold haircut lives inside `settings.offer` rather than in a
 * column of its own: the settings collection has no field for it and the
 * migrations are not this package's to change. `offerSettingsFrom` reads the
 * four keys it knows and leaves this one alone, so it round-trips safely.
 * Give it a column the next time the schema moves.
 */
export const HAIRCUT_KEY = "ebayHaircutPct"

export const DEFAULT_HAIRCUT_PCT = 15

/** `settings.email`, minus anything secret. */
export interface EmailSettingsForm {
  from_name?: string
  from_address?: string
  reply_to?: string
  test_mode: boolean
}

export interface MarkupBandForm {
  key: string
  /** Pounds, the bottom of the band. */
  from: string
  /** Whole percent added to market. */
  markupPct: string
}

export interface SettingsForm {
  id: string
  // Buy-in defaults
  minimumOffer: string
  bulkThreshold: string
  bulkCash: string
  bulkCredit: string
  bulkRatePct: string
  conditionPct: Record<ConditionKey, string>
  // Sell price
  markupBands: MarkupBandForm[]
  // Limits
  cashCap: string
  cashVarianceAlert: string
  retentionMonths: number
  // Notifications
  quoteExpiryDays: string
  holdHours: string
  /**
   * The addressing block as it stands on the record, with the test-mode
   * switch folded into it. Carried whole so a save cannot drop the from
   * name, the from address or the reply-to, none of which this screen
   * shows. The mail API key is a column of its own and is never read.
   */
  email: EmailSettingsForm
  // The customer-facing display
  displayEnabled: boolean
  displayTicker: string
  displaySignupUrl: string
  // Shop
  shopName: string
  shopAddress: string
  shopTown: string
  shopPostcode: string
  shopPhone: string
  shopEmail: string
  vatRegistered: boolean
  receiptTerms: string
  // Price sources
  sourcePriority: PriceSource[]
  retroSourcePriority: PriceSource[]
  haircutPct: string
}

function sourceOrder(
  stored: string[] | undefined,
  fallback: PriceSource[]
): PriceSource[] {
  const known = new Set<string>(fallback)
  const kept = (stored ?? []).filter((source): source is PriceSource => known.has(source))
  // Anything the shop has not ordered keeps its place at the bottom rather
  // than disappearing from the list.
  return [...kept, ...fallback.filter((source) => !kept.includes(source))]
}

export function recordToForm(record: SettingsRecord): SettingsForm {
  const offer = record.offer ?? {}
  const multipliers = record.condition_multipliers ?? {}
  const bands = record.markup_bands?.length
    ? record.markup_bands
    : [
        { from: 0, multiplier: 1.1 },
        { from: 500, multiplier: 1.05 },
        { from: 5000, multiplier: 1 },
      ]
  const haircut = (record.offer as Record<string, number> | undefined)?.[HAIRCUT_KEY]

  return {
    id: record.id,
    minimumOffer: penceToPounds(offer.minimumOffer ?? record.min_single_offer ?? 0),
    bulkThreshold: penceToPounds(offer.bulkThreshold ?? 0),
    bulkCash: penceToPounds(offer.bulkCash ?? 0),
    bulkCredit: penceToPounds(offer.bulkCredit ?? 0),
    bulkRatePct: String(Math.round(record.bulk_rate_pct ?? 0)),
    conditionPct: {
      LP: multiplierToPercent(multipliers.LP, 85),
      MP: multiplierToPercent(multipliers.MP, 70),
      HP: multiplierToPercent(multipliers.HP, 50),
      DMG: multiplierToPercent(multipliers.DMG, 30),
    },
    markupBands: bands.map((band, index) => ({
      key: `band-${index}`,
      from: penceToPounds(band.from),
      markupPct: multiplierToMarkup(band.multiplier),
    })),
    cashCap: penceToPounds(record.cash_cap ?? 0),
    cashVarianceAlert: penceToPounds(record.cash_variance_alert ?? 0),
    retentionMonths: record.id_photo_retention_months ?? 12,
    quoteExpiryDays: String(record.quote_expiry_days ?? 0),
    // The server's own default: 48 hours when the shop has not set one.
    holdHours: String(record.holds?.hours ?? 48),
    email: {
      ...(record.email ?? {}),
      // Anything but an explicit false keeps test mode on, which is how the
      // server reads it: a half-filled settings row never starts emailing.
      test_mode: record.email?.test_mode === false ? false : true,
    },
    shopName: record.shop_name ?? "",
    shopAddress: record.shop_address ?? "",
    shopTown: record.shop_town ?? "",
    shopPostcode: record.shop_postcode ?? "",
    shopPhone: record.shop_phone ?? "",
    displayEnabled: record.display?.enabled === true,
    displayTicker: record.display?.ticker ?? "Game · Trade · Play",
    displaySignupUrl: record.display?.signup_url ?? "/estimate",
    shopEmail: record.shop_email ?? "",
    vatRegistered: record.vat_registered === true,
    receiptTerms: record.receipt_terms ?? "",
    sourcePriority: sourceOrder(record.source_priority, DEFAULT_TCG_PRIORITY),
    retroSourcePriority: sourceOrder(record.retro_source_priority, DEFAULT_RETRO_PRIORITY),
    haircutPct: String(haircut ?? DEFAULT_HAIRCUT_PCT),
  }
}

/** Everything the form owns, as the collection API takes it. */
export function formToPatch(form: SettingsForm): Partial<SettingsRecord> {
  const minimumOffer = poundsToPence(form.minimumOffer) ?? 0
  return {
    offer: {
      bulkThreshold: poundsToPence(form.bulkThreshold) ?? 0,
      bulkCash: poundsToPence(form.bulkCash) ?? 0,
      bulkCredit: poundsToPence(form.bulkCredit) ?? 0,
      minimumOffer,
      [HAIRCUT_KEY]: parsePercent(form.haircutPct) ?? DEFAULT_HAIRCUT_PCT,
    } as SettingsRecord["offer"],
    // The same figure under its own column, so the two cannot drift: the
    // evaluator reads `offer.minimumOffer` and the seed also holds
    // `min_single_offer`.
    min_single_offer: minimumOffer,
    bulk_rate_pct: parsePercent(form.bulkRatePct) ?? 0,
    condition_multipliers: {
      NM: 1,
      LP: percentToMultiplier(parsePercent(form.conditionPct.LP) ?? 85),
      MP: percentToMultiplier(parsePercent(form.conditionPct.MP) ?? 70),
      HP: percentToMultiplier(parsePercent(form.conditionPct.HP) ?? 50),
      DMG: percentToMultiplier(parsePercent(form.conditionPct.DMG) ?? 30),
    },
    markup_bands: form.markupBands.map((band) => ({
      from: poundsToPence(band.from) ?? 0,
      multiplier: markupToMultiplier(parsePercent(band.markupPct) ?? 0),
    })),
    sell_rounding: "49_99",
    cash_cap: poundsToPence(form.cashCap) ?? 0,
    cash_variance_alert: poundsToPence(form.cashVarianceAlert) ?? 0,
    id_photo_retention_months: form.retentionMonths,
    quote_expiry_days: parseCount(form.quoteExpiryDays) ?? 0,
    // Written back whole, so the addressing this screen does not show
    // survives a save of the switch that it does.
    email: { ...form.email },
    holds: { hours: parseCount(form.holdHours) ?? 48 },
    display: {
      enabled: form.displayEnabled,
      ticker: form.displayTicker.trim(),
      signup_url: form.displaySignupUrl.trim(),
    },
    shop_name: form.shopName.trim(),
    shop_address: form.shopAddress.trim(),
    shop_town: form.shopTown.trim(),
    shop_postcode: form.shopPostcode.trim(),
    shop_phone: form.shopPhone.trim(),
    shop_email: form.shopEmail.trim(),
    vat_registered: form.vatRegistered,
    receipt_terms: form.receiptTerms,
    source_priority: form.sourcePriority,
    retro_source_priority: form.retroSourcePriority,
  }
}

/** The offer settings the preview computes with, from the unsaved form. */
export function formToOfferSettings(form: SettingsForm) {
  return {
    bulkThreshold: poundsToPence(form.bulkThreshold) ?? 0,
    bulkCash: poundsToPence(form.bulkCash) ?? 0,
    bulkCredit: poundsToPence(form.bulkCredit) ?? 0,
    minimumOffer: poundsToPence(form.minimumOffer) ?? 0,
  }
}

/** The condition multipliers the preview computes with, from the unsaved form. */
export function formToMultipliers(form: SettingsForm) {
  return {
    NM: 1,
    LP: percentToMultiplier(parsePercent(form.conditionPct.LP) ?? 85),
    MP: percentToMultiplier(parsePercent(form.conditionPct.MP) ?? 70),
    HP: percentToMultiplier(parsePercent(form.conditionPct.HP) ?? 50),
    DMG: percentToMultiplier(parsePercent(form.conditionPct.DMG) ?? 30),
  }
}

/** The markup bands the sell-price preview computes with. */
export function formToMarkupBands(form: SettingsForm) {
  return form.markupBands.map((band) => ({
    from: poundsToPence(band.from) ?? 0,
    multiplier: markupToMultiplier(parsePercent(band.markupPct) ?? 0),
  }))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type FormErrors = Record<string, string>

const POUNDS = "Enter an amount in pounds and pence, for example 12.50."
const PERCENT = "Enter a whole percent between 0 and 100."

function requirePounds(errors: FormErrors, field: string, value: string) {
  const pence = poundsToPence(value)
  // Nothing on this page is ever owed the other way: a minus sign is a typo.
  if (pence === null || pence < 0) errors[field] = POUNDS
}

function requirePercent(errors: FormErrors, field: string, value: string) {
  const percent = parsePercent(value)
  if (percent === null || percent > 100) errors[field] = PERCENT
}

/** Every message says what happened and what to do about it. */
export function validateSettings(form: SettingsForm): FormErrors {
  const errors: FormErrors = {}
  requirePounds(errors, "minimumOffer", form.minimumOffer)
  requirePounds(errors, "bulkThreshold", form.bulkThreshold)
  requirePounds(errors, "bulkCash", form.bulkCash)
  requirePounds(errors, "bulkCredit", form.bulkCredit)
  requirePercent(errors, "bulkRatePct", form.bulkRatePct)
  for (const key of CONDITION_KEYS) {
    requirePercent(errors, `conditionPct.${key}`, form.conditionPct[key])
  }
  form.markupBands.forEach((band, index) => {
    requirePounds(errors, `markupBands.${index}.from`, band.from)
    const markup = parsePercent(band.markupPct)
    if (markup === null) {
      errors[`markupBands.${index}.markupPct`] =
        "Enter the markup as a whole percent, for example 10."
    }
  })
  requirePounds(errors, "cashCap", form.cashCap)
  requirePounds(errors, "cashVarianceAlert", form.cashVarianceAlert)
  const quoteDays = parseCount(form.quoteExpiryDays)
  // Zero is not "no expiry": the server substitutes fourteen days for it,
  // so a shop that typed 0 would be quoting a fortnight without knowing.
  if (quoteDays === null || quoteDays < 1) {
    errors.quoteExpiryDays = "Enter the number of days a quote stands for, for example 7."
  }
  const holdHours = parseCount(form.holdHours)
  if (holdHours === null || holdHours < 1) {
    errors.holdHours = "Enter the number of hours a hold lasts, for example 48."
  }
  if (form.displayEnabled && !form.displayTicker.trim()) {
    errors.displayTicker = "The display scrolls this line. Write one, or switch the display off."
  }
  if (form.displayEnabled && !form.displaySignupUrl.trim()) {
    errors.displaySignupUrl =
      "The sign-up QR needs somewhere to point, for example /estimate."
  }
  if (!form.shopName.trim()) {
    errors.shopName = "The shop needs a name: it prints on every receipt."
  }
  if (form.shopEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.shopEmail.trim())) {
    errors.shopEmail = "That is not an email address. Check it and try again."
  }
  requirePercent(errors, "haircutPct", form.haircutPct)
  return errors
}

/** The rules matrix, row by row. Keys are `rules.<key>.<field>`. */
export function validateRules(rules: RuleForm[]): FormErrors {
  const errors: FormErrors = {}
  for (const rule of rules) {
    const min = poundsToPence(rule.bandMin)
    if (min === null || min < 0) errors[`rules.${rule.key}.bandMin`] = POUNDS
    if (rule.bandMax.trim() !== "") {
      const max = poundsToPence(rule.bandMax)
      if (max === null || max < 0) errors[`rules.${rule.key}.bandMax`] = POUNDS
      else if (min !== null && max <= min) {
        errors[`rules.${rule.key}.bandMax`] =
          "The top of the band has to be above the bottom. Leave it empty for no top."
      }
    }
    const cash = parsePercent(rule.cashPct)
    if (cash === null || cash > 100) errors[`rules.${rule.key}.cashPct`] = PERCENT
    const credit = parsePercent(rule.creditPct)
    if (credit === null || credit > 100) errors[`rules.${rule.key}.creditPct`] = PERCENT
    if (parseCount(rule.priority) === null) {
      errors[`rules.${rule.key}.priority`] =
        "Enter a whole number. The higher one wins when two rules match."
    }
  }
  return errors
}
