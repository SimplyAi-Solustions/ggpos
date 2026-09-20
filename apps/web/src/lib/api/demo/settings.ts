/**
 * The demo shop's settings and pricing rules.
 *
 * The figures are the seed's (pb_migrations/1789819620_seed.js and
 * 1789819680_phase2_fields.js), so the Settings screen in demo mode opens on
 * exactly what a fresh shop has. Edits live in memory for the tab, like every
 * other demo store, and are read back by `getVaultConfig` so a saved change
 * shows up on the counter screens straight away.
 */
import type { PricingRuleRow, PricingRuleWrite, SettingsRecord } from "@/lib/api/types"

export const DEMO_SETTINGS_RECORD: SettingsRecord = {
  id: "settings_demo",
  cash_cap: 800_000,
  cash_variance_alert: 1000,
  min_single_offer: 0,
  bulk_rate_pct: 0,
  offer: { bulkThreshold: 100, bulkCash: 5, bulkCredit: 10, minimumOffer: 25 },
  source_priority: ["uk_sold_manual", "ebay_uk_asking", "cardmarket", "tcgplayer"],
  retro_source_priority: [
    "uk_sold_manual",
    "pricecharting_pal",
    "ebay_uk_asking",
    "pricecharting_ntsc",
  ],
  condition_multipliers: { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 },
  markup_bands: [
    { from: 0, multiplier: 1.1 },
    { from: 500, multiplier: 1.05 },
    { from: 5000, multiplier: 1 },
  ],
  sell_rounding: "49_99",
  quote_expiry_days: 7,
  // Phase 5's notification settings, as the migration seeds them: email in
  // test mode with no provider, no VAPID key until the deploy sets one, and
  // a 48-hour want-list hold.
  email: { from_name: "", from_address: "", reply_to: "", test_mode: true },
  email_provider: "none",
  push: { vapid_public_key: "" },
  holds: { hours: 48 },
  id_photo_retention_months: 12,
  vat_registered: false,
  shop_name: "GG Entertainment",
  shop_address: "Market Place",
  shop_town: "Bolsover",
  shop_postcode: "S44 6PN",
  shop_phone: "01246 000000",
  shop_email: "hello@ggentertainment.co.uk",
  receipt_terms:
    "Items are bought as seen. Proof of identity and address is required for cash purchases. We keep a record of this purchase for six years.",
}

/** The seeded bands: under £5, £5 to £50, £50 and over, plus retro and sealed. */
export const DEMO_RULE_ROWS: PricingRuleRow[] = [
  {
    id: "rule_single_low",
    kind: "single",
    condition: "",
    band_min: 0,
    band_max: 500,
    cash_pct: 40,
    credit_pct: 55,
    rounding: 25,
    priority: 10,
    active: true,
  },
  {
    id: "rule_single_mid",
    kind: "single",
    condition: "",
    band_min: 500,
    band_max: 5000,
    cash_pct: 50,
    credit_pct: 65,
    rounding: 50,
    priority: 20,
    active: true,
  },
  {
    id: "rule_single_high",
    kind: "single",
    condition: "",
    band_min: 5000,
    band_max: 0,
    cash_pct: 60,
    credit_pct: 75,
    rounding: 50,
    priority: 30,
    active: true,
  },
  {
    id: "rule_retro",
    kind: "retro",
    condition: "",
    band_min: 0,
    band_max: 0,
    cash_pct: 45,
    credit_pct: 60,
    rounding: 50,
    priority: 40,
    active: true,
  },
  {
    id: "rule_sealed",
    kind: "sealed",
    condition: "",
    band_min: 0,
    band_max: 0,
    cash_pct: 55,
    credit_pct: 70,
    rounding: 50,
    priority: 50,
    active: true,
  },
]

const settings: SettingsRecord = { ...DEMO_SETTINGS_RECORD }
const rules: PricingRuleRow[] = DEMO_RULE_ROWS.map((row) => ({ ...row }))

let sequence = 0

export function demoSettings(): SettingsRecord {
  return { ...settings }
}

export function demoSaveSettings(patch: Partial<SettingsRecord>): SettingsRecord {
  Object.assign(settings, patch)
  return { ...settings }
}

export function demoRules(): PricingRuleRow[] {
  return rules.map((row) => ({ ...row }))
}

export function demoSaveRules(changes: PricingRuleWrite[]): PricingRuleRow[] {
  for (const change of changes) {
    if (change.id) {
      const existing = rules.find((row) => row.id === change.id)
      if (existing) Object.assign(existing, change)
      continue
    }
    sequence += 1
    const { id: _id, ...fields } = change
    void _id
    rules.push({ id: `rule_demo_${sequence}`, ...fields })
  }
  return demoRules()
}
