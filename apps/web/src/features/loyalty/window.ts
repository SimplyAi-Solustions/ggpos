/**
 * The tier helpers the counter shares with the server: the rolling window
 * total, a tier's monthly perk allowance, the tier a customer actually
 * holds (a paid plan pins one) and what is left to the next one.
 *
 * They live in `@gg/shared/loyalty` so the hook and this app can never
 * disagree about who is a Legend. This module only re-exports them, and adds
 * the one shape conversion the counter needs, so a screen imports the tier
 * rules from one place.
 */
export {
  perkAllowance,
  pointsToNextTier,
  resolveTier,
  tierForPoints,
  tierWindowPoints,
} from "@gg/shared"

import type { PointsLedgerRow } from "@/lib/api/types"

/** The `points_ledger` rows a window total is taken over. */
export function ledgerForWindow(
  rows: PointsLedgerRow[]
): { delta: number; reason: string; created: string }[] {
  return rows.map((row) => ({
    delta: row.delta,
    reason: row.reason,
    created: row.created,
  }))
}
