/**
 * The till's slice of the shop's settings: `settings.epos` and the VAT
 * switch (docs/api-contract-epos.md, section 1).
 *
 * Read from `GET /api/vault/config` like every other non-secret setting,
 * through the raw config query every counter screen already shares, so the
 * till costs no extra request. The defaults are the migration's own, so a
 * shop that has never opened the EPOS settings tills exactly as a fresh one.
 * The server is still the judge of every limit here: these only let the
 * till say the same thing first.
 */
import { useVaultConfig } from "@/lib/api/config"

export interface EposSettings {
  /** `discount_limit_pct`: a manual discount above this needs a manager. */
  discountLimitPct: number
  /** `require_card_last4`: the card step asks for the last four digits. */
  requireCardLast4: boolean
  /** `quick_cash`: the note keys on the cash step, in pence. */
  quickCash: number[]
  /** `settings.vat_registered`: whether the ticket shows a VAT line. */
  vatRegistered: boolean
}

export const EPOS_DEFAULTS: EposSettings = {
  discountLimitPct: 10,
  requireCardLast4: true,
  quickCash: [500, 1000, 2000, 5000],
  vatRegistered: false,
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The settings row as the config route serves it, read defensively: a value
 * of the wrong shape falls back to the default rather than half-applying.
 */
export function eposSettingsFrom(settings: unknown): EposSettings {
  const row = record(settings)
  const epos = record(row.epos)

  const limit = epos.discount_limit_pct
  const quick = Array.isArray(epos.quick_cash)
    ? epos.quick_cash
        .filter((note): note is number => Number.isInteger(note) && (note as number) > 0)
        .sort((a, b) => a - b)
    : null

  return {
    discountLimitPct:
      typeof limit === "number" && Number.isFinite(limit) && limit >= 0
        ? limit
        : EPOS_DEFAULTS.discountLimitPct,
    requireCardLast4:
      typeof epos.require_card_last4 === "boolean"
        ? epos.require_card_last4
        : EPOS_DEFAULTS.requireCardLast4,
    quickCash: quick && quick.length > 0 ? quick : [...EPOS_DEFAULTS.quickCash],
    vatRegistered: row.vat_registered === true,
  }
}

/** The till's settings for the session, defaults while the config loads. */
export function useEposSettings(): EposSettings {
  const { data } = useVaultConfig()
  return eposSettingsFrom(data?.settings)
}
