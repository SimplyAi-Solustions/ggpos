/** The bulk Change price sheet's maths. Pence in, pence out. */
import { applyPercent } from "@gg/shared/money"

import type { InventoryItem } from "../types"
import { applyRounding, type RuleRounding } from "./rules"

export type BulkMode = "set" | "market" | "adjust"

export const ROUNDING_OPTIONS: { value: RuleRounding; label: string }[] = [
  { value: "charm_99", label: "Charm, .99" },
  { value: "charm_49_99", label: "Up to .49 or .99" },
  { value: "round_to", label: "Nearest 50p" },
  { value: "none", label: "No rounding" },
]

/** The new price for one item under the sheet's choice, or null to leave it. */
export function bulkPrice(item: Pick<InventoryItem, "price" | "market">, mode: BulkMode, value: number | null, pct: number, rounding: RuleRounding): number | null {
  let next: number | null
  if (mode === "set") next = value
  else if (mode === "market") next = item.market === null ? null : applyPercent(item.market, pct)
  else next = item.price > 0 ? applyPercent(item.price, 100 + pct) : null
  if (next === null) return null
  if (mode !== "set") next = applyRounding(next, { rounding, round_step: 50 })
  return Math.max(0, next)
}
