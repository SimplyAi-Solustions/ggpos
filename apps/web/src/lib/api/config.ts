/**
 * The shop's configuration, as the counter reads it.
 *
 * `settings`, `pricing_rules` and the `loyalty_*` collections are admin-only,
 * so an ordinary staff token is refused when it reads any of them directly.
 * `GET /api/vault/config` is the one staff-readable route that carries what
 * the counter needs out of them, with the keys and secrets left behind.
 *
 * The fetch and the row mappers belong to the buy-in wizard's helpers; this
 * module adds the tiers it does not need, and one TanStack query so the Sell
 * and Cash screens share a single read for the session.
 */
import { parseTierPerk, type LoyaltyTier, type TierPerk } from "@gg/shared"
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
import type { CounterConfig, LoyaltyTierRow, VaultConfig } from "@/lib/api/types"

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

/** Everything the Sell and Cash screens read from the admin-only collections. */
export async function getCounterConfig(): Promise<CounterConfig> {
  const config = await wireConfig()
  return {
    // Zero when the shop has not set one, which is how the close route reads
    // it too. Nothing here invents a threshold of its own.
    cashVarianceAlert: config.settings.cash_variance_alert ?? 0,
    cashCap: config.settings.cash_cap ?? 0,
    loyalty: {
      programme: programmeFrom(config),
      rules: loyaltyRulesFrom(config),
      tiers: tiersFrom(config),
    },
  }
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
