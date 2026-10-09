/**
 * The shop's configuration, as the counter reads it.
 *
 * `settings`, `pricing_rules` and the `loyalty_*` collections are admin-only,
 * so an ordinary staff token is refused when it reads any of them directly.
 * `GET /api/vault/config` is the one staff-readable route that carries what
 * the counter needs out of them, with the keys and secrets left behind.
 *
 * The fetch and the row mappers belong to the buy-in wizard's helpers; this
 * module adds the tiers it does not need, the till's EPOS settings, and one
 * TanStack query so the till, cashing up and the lock share a single read
 * for the session.
 */
import {
  parseTierPerk,
  resolvePermissions,
  type LoyaltyTier,
  type TierPerk,
} from "@gg/shared"
import { useQuery } from "@tanstack/react-query"

import { isDemo } from "@/lib/api/mode"
import {
  getVaultConfig,
  loyaltyRulesFrom,
  programmeFrom,
} from "@/lib/api/tradeins"
import {
  DEMO_RULES,
  DEMO_SETTINGS,
  DEMO_TIER_ROWS,
} from "@/lib/api/demo/store"
import { demoSettings } from "@/lib/api/demo/settings"
import type {
  CounterConfig,
  DisplaySettings,
  EposConfig,
  EposSettingsRow,
  LoyaltyTierRow,
  VaultConfig,
} from "@/lib/api/types"

/** Five minutes: a shop changes its settings between customers, not between sales. */
export const CONFIG_STALE_MS = 5 * 60_000

/**
 * The tiers, with any perk shape the shared evaluator does not know dropped
 * rather than half-read: a perk nobody can apply must not look applied.
 */
export function tiersFrom(config: VaultConfig): LoyaltyTier[] {
  return [...config.loyalty.tiers]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((row: LoyaltyTierRow) => ({
      id: row.id,
      name: row.name ?? "",
      thresholdPoints: row.threshold_points ?? 0,
      sort: row.sort ?? 0,
      perks: (Array.isArray(row.perks) ? row.perks : [])
        .map(parseTierPerk)
        .filter((perk): perk is TierPerk => perk !== null),
      paidPlan: row.paid_plan === true,
    }))
}

/**
 * The demo config the buy-in wizard serves carries no tiers and no variance
 * alert, because the wizard needs neither. The Sell and Cash screens do, so
 * they come from the same seed figures rather than a second demo config.
 */
async function wireConfig(): Promise<VaultConfig> {
  const config = await getVaultConfig()
  if (!isDemo()) return config
  return {
    ...config,
    settings: {
      ...config.settings,
      cash_cap: config.settings.cash_cap ?? DEMO_SETTINGS.cash_cap,
      cash_variance_alert: DEMO_SETTINGS.cash_variance_alert,
      // The demo Settings screen writes `display`, `epos` and the VAT
      // fields to its own settings record, so an admin can switch the
      // customer screen on, change the auto-lock or the quick cash notes and
      // watch the counter follow without a server.
      display: demoSettings().display,
      epos: demoSettings().epos,
      vat_number: demoSettings().vat_number,
      vat_registered: demoSettings().vat_registered,
      vat_registered_from: demoSettings().vat_registered_from,
      vat_period_start_month: demoSettings().vat_period_start_month,
      vat_standard_rate: demoSettings().vat_standard_rate,
    },
    loyalty: {
      ...config.loyalty,
      rules: DEMO_RULES.map((rule) => ({
        id: rule.id,
        name: rule.name,
        type: rule.type,
        conditions: rule.conditions as Record<string, unknown>,
        value: rule.value,
        active: rule.active,
        priority: rule.priority,
        starts_at: rule.startsAt ?? undefined,
        ends_at: rule.endsAt ?? undefined,
      })),
      tiers: DEMO_TIER_ROWS,
    },
  }
}

/**
 * `settings.display`, with the seed's own defaults filling in anything a
 * shop has not set. The ticker is the marketing site's line, and the QR
 * points at the public estimate page, which is what drives sign-ups.
 */
export function displayFrom(config: VaultConfig): DisplaySettings {
  const display = config.settings.display ?? {}
  return {
    enabled: display.enabled === true,
    ticker: display.ticker ?? "Game · Trade · Play",
    signup_url: display.signup_url ?? "/estimate",
  }
}

/**
 * The seed's EPOS defaults (pb_migrations/1789820800_epos_foundation.js).
 * Kept in step with the migration by hand: they are what a fresh shop has,
 * and what fills any gap a hand-edited settings row leaves.
 */
export const EPOS_DEFAULTS: Omit<EposConfig, "permissions"> = {
  discount_limit_pct: 10,
  require_card_last4: true,
  auto_lock_minutes: 5,
  quick_cash: [500, 1000, 2000, 5000],
  default_float: 10000,
  z_requires_card_total: true,
  card_provider: "manual_tide",
  receipt: {
    header: "",
    footer: "Thank you for shopping with GG Entertainment.",
    returns_policy: "",
    show_portal_qr: true,
  },
}

function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/**
 * `settings.epos` with every gap filled. The permissions go through the
 * shared `resolvePermissions`, so an unknown capability or role in the
 * stored table is dropped rather than trusted, and the two admin-only
 * capabilities stay at admin whatever the row says.
 */
export function eposFrom(stored: EposSettingsRow | null | undefined): EposConfig {
  const epos = stored ?? {}
  const receipt = epos.receipt ?? {}
  const notes = Array.isArray(epos.quick_cash)
    ? epos.quick_cash.filter((pence) => Number.isInteger(pence) && pence > 0)
    : null
  return {
    permissions: resolvePermissions(epos.permissions),
    discount_limit_pct: wholeNumber(epos.discount_limit_pct, EPOS_DEFAULTS.discount_limit_pct),
    require_card_last4: flag(epos.require_card_last4, EPOS_DEFAULTS.require_card_last4),
    auto_lock_minutes: wholeNumber(epos.auto_lock_minutes, EPOS_DEFAULTS.auto_lock_minutes),
    quick_cash: notes ? [...notes].sort((a, b) => a - b) : [...EPOS_DEFAULTS.quick_cash],
    default_float: wholeNumber(epos.default_float, EPOS_DEFAULTS.default_float),
    z_requires_card_total: flag(epos.z_requires_card_total, EPOS_DEFAULTS.z_requires_card_total),
    card_provider: epos.card_provider || EPOS_DEFAULTS.card_provider,
    receipt: {
      header: receipt.header ?? EPOS_DEFAULTS.receipt.header,
      footer: receipt.footer ?? EPOS_DEFAULTS.receipt.footer,
      returns_policy: receipt.returns_policy ?? EPOS_DEFAULTS.receipt.returns_policy,
      show_portal_qr: flag(receipt.show_portal_qr, EPOS_DEFAULTS.receipt.show_portal_qr),
    },
  }
}

/** Everything the counter screens read from the admin-only collections. */
export async function getCounterConfig(): Promise<CounterConfig> {
  const config = await wireConfig()
  return {
    // Zero when the shop has not set one, which is how the close route reads
    // it too. Nothing here invents a threshold of its own.
    cashVarianceAlert: config.settings.cash_variance_alert ?? 0,
    cashCap: config.settings.cash_cap ?? 0,
    epos: eposFrom(config.settings.epos),
    vatNumber: config.settings.vat_number ?? "",
    vatRegistered: config.settings.vat_registered === true,
    loyalty: {
      programme: programmeFrom(config),
      rules: loyaltyRulesFrom(config),
      tiers: tiersFrom(config),
    },
    display: displayFrom(config),
  }
}

/**
 * The same read, unmapped, for the buy-in wizard: it wants the offer bands
 * and the settings rather than the tiers, and mapping them twice on one
 * screen would be work for nothing. Its own key, so the two screens each
 * hold one answer for the session rather than sharing a half-used one.
 */
export const vaultConfigQuery = {
  queryKey: ["vault-config"] as const,
  queryFn: wireConfig,
  staleTime: CONFIG_STALE_MS,
}

export function useVaultConfig() {
  return useQuery(vaultConfigQuery)
}

export const counterConfigQuery = {
  queryKey: ["counter-config"] as const,
  queryFn: getCounterConfig,
  staleTime: CONFIG_STALE_MS,
}

/**
 * One query for the session, shared by every screen that asks: TanStack keys
 * on `counter-config`, so the second caller reads the first one's answer.
 */
export function useCounterConfig() {
  return useQuery(counterConfigQuery)
}
