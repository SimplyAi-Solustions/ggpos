/**
 * Stock health: the built-in alerts, each a pure test over one held item.
 * A margin is measured on the sticker (what the customer pays), so 20% on a
 * £10.00 sticker means the item cost £8.00 or less.
 */
import { marginPct } from "../lib/inventory"
import type { InventoryItem } from "../types"

export type HealthKey =
  | "below_cost"
  | "margin_10"
  | "margin_20"
  | "no_market"
  | "no_sticker"
  | "below_market"

export interface HealthRule {
  key: HealthKey
  title: string
  /** What it means and what to do, one line. */
  help: string
  severity: "alert" | "warn" | "info"
  test: (item: InventoryItem) => boolean
}

const hasSticker = (item: InventoryItem) => item.price > 0
const hasCost = (item: InventoryItem) => item.cost > 0

export const HEALTH_RULES: readonly HealthRule[] = [
  {
    key: "below_cost",
    title: "Sticker below cost",
    help: "Selling these loses money. Reprice them above what we paid.",
    severity: "alert",
    test: (item) => hasSticker(item) && hasCost(item) && item.price < item.cost,
  },
  {
    key: "margin_10",
    title: "Margin under 10%",
    help: "Priced at or above cost, but with less than 10% left after cost.",
    severity: "alert",
    test: (item) => {
      const margin = marginPct(item.price, item.cost)
      return margin !== null && item.price >= item.cost && margin < 10
    },
  },
  {
    key: "margin_20",
    title: "Margin under 20%",
    help: "Includes the under 10% items. Worth a look before the next reprice.",
    severity: "warn",
    test: (item) => {
      const margin = marginPct(item.price, item.cost)
      return margin !== null && item.price >= item.cost && margin < 20
    },
  },
  {
    key: "below_market",
    title: "Sticker below market",
    help: "The sticker is under today's UK-first market value.",
    severity: "warn",
    test: (item) => hasSticker(item) && item.market !== null && item.price < item.market,
  },
  {
    key: "no_sticker",
    title: "No sticker price",
    help: "These cannot be sold or labelled until they have a price.",
    severity: "warn",
    test: (item) => !hasSticker(item),
  },
  {
    key: "no_market",
    title: "No market price",
    help: "Nothing to price against. Link a card or add a UK sold comp.",
    severity: "info",
    test: (item) => item.market === null,
  },
]

export function healthRule(key: string): HealthRule | undefined {
  return HEALTH_RULES.find((rule) => rule.key === key)
}

export interface HealthResult {
  rule: HealthRule
  items: InventoryItem[]
}

export function checkHealth(items: readonly InventoryItem[]): HealthResult[] {
  return HEALTH_RULES.map((rule) => ({ rule, items: items.filter(rule.test) }))
}

/** Which alerts one item trips, for its own page. */
export function alertsFor(item: InventoryItem): HealthRule[] {
  return HEALTH_RULES.filter((rule) => rule.test(item))
}
