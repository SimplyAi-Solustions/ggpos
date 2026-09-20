/**
 * The admin's own read and write of `settings` and `pricing_rules`.
 *
 * Every other screen reads these through `GET /api/vault/config`, which is
 * staff-readable and leaves the keys behind. The Settings screen is admin
 * only, so it goes at the two collections directly: it needs the record id to
 * write back, and it needs the inactive rules the config route filters out.
 *
 * Nothing here ever reads or writes a secret. `settings.api_keys`, the mail
 * key and the VAPID keys stay on the server: the read below picks the fields
 * the screen shows, one by one, so a key cannot reach the browser by
 * accident, and a save only sends the fields the form owns.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import {
  demoRules,
  demoSaveRules,
  demoSaveSettings,
  demoSettings,
} from "@/lib/api/demo/settings"
import type {
  PricingRuleRow,
  PricingRuleWrite,
  SettingsRecord,
} from "@/lib/api/types"

/**
 * The fields the Settings screen shows, and no others.
 *
 * The same list is sent to PocketBase as `fields`, so `api_keys`, the mail
 * key and the VAPID keys are never put on the wire in the first place;
 * `pick` then drops anything a future column adds. Belt and braces, in that
 * order: a key that never leaves the server cannot leak from the browser.
 */
export const SETTINGS_FIELDS = [
  "id",
  "cash_cap",
  "cash_variance_alert",
  "min_single_offer",
  "bulk_rate_pct",
  "offer",
  "source_priority",
  "retro_source_priority",
  "condition_multipliers",
  "markup_bands",
  "sell_rounding",
  "label_default_template",
  "default_intake_location",
  "quote_expiry_days",
  "id_photo_retention_months",
  "vat_registered",
  "shop_name",
  "shop_address",
  "shop_town",
  "shop_postcode",
  "shop_phone",
  "shop_email",
  "receipt_terms",
].join(",")

function pick(row: SettingsRecord): SettingsRecord {
  return {
    id: row.id,
    cash_cap: row.cash_cap,
    cash_variance_alert: row.cash_variance_alert,
    min_single_offer: row.min_single_offer,
    bulk_rate_pct: row.bulk_rate_pct,
    offer: row.offer,
    source_priority: row.source_priority,
    retro_source_priority: row.retro_source_priority,
    condition_multipliers: row.condition_multipliers,
    markup_bands: row.markup_bands,
    sell_rounding: row.sell_rounding,
    label_default_template: row.label_default_template,
    default_intake_location: row.default_intake_location,
    quote_expiry_days: row.quote_expiry_days,
    id_photo_retention_months: row.id_photo_retention_months,
    vat_registered: row.vat_registered,
    shop_name: row.shop_name,
    shop_address: row.shop_address,
    shop_town: row.shop_town,
    shop_postcode: row.shop_postcode,
    shop_phone: row.shop_phone,
    shop_email: row.shop_email,
    receipt_terms: row.receipt_terms,
  }
}

/** The single `settings` record. Admin only: staff get a 403 and a plain page. */
export async function getSettings(): Promise<SettingsRecord> {
  if (isDemo()) return pick(demoSettings())
  // One row, read as a page of one rather than through a filter: the
  // singleton is enforced by pb_hooks/singletons.pb.js, so there is nothing
  // to filter on.
  const page = await pb
    .collection("settings")
    .getList<SettingsRecord>(1, 1, { fields: SETTINGS_FIELDS })
  noteNetworkSuccess()
  const row = page.items[0]
  if (!row) {
    throw new Error("This shop has no settings record yet. Run the migrations first.")
  }
  return pick(row)
}

/** Writes the fields the form owns, and leaves everything else as it is. */
export async function saveSettings(
  id: string,
  patch: Partial<SettingsRecord>
): Promise<SettingsRecord> {
  if (isDemo()) return pick(demoSaveSettings(patch))
  const row = await pb
    .collection("settings")
    .update<SettingsRecord>(id, patch, { fields: SETTINGS_FIELDS })
  noteNetworkSuccess()
  return pick(row)
}

/** Every rule, active or not, highest priority first: the matrix shows both. */
export async function listPricingRules(): Promise<PricingRuleRow[]> {
  if (isDemo()) return demoRules()
  const rows = await pb
    .collection("pricing_rules")
    .getFullList<PricingRuleRow>({ sort: "-priority,band_min" })
  // Any answer at all means the line is up, whatever it said.
  noteNetworkSuccess()
  return rows
}

/**
 * The changed rows only. A row with an id is updated, a row without one is
 * created, and a rule is never deleted: deactivating it keeps the band that
 * priced yesterday's buy-ins readable.
 */
export async function savePricingRules(
  changes: PricingRuleWrite[]
): Promise<PricingRuleRow[]> {
  if (isDemo()) return demoSaveRules(changes)
  for (const change of changes) {
    const { id, ...fields } = change
    if (id) {
      await pb.collection("pricing_rules").update(id, fields)
    } else {
      await pb.collection("pricing_rules").create(fields)
    }
  }
  return listPricingRules()
}
