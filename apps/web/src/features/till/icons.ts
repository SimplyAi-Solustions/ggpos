/**
 * The Lucide icon a till product or a stock line shows when it has no
 * picture (DESIGN.md, section 10: "never a grey box"), and the pence-digit
 * helpers the money pad works in.
 */
import type { TillCatalogueItem, TillCatalogueProduct } from "@gg/shared"
import {
  BadgeCheckIcon,
  BoxIcon,
  CalendarClockIcon,
  ClockIcon,
  GamepadIcon,
  LayersIcon,
  PackageIcon,
  PiggyBankIcon,
  TagIcon,
  TicketIcon,
  type LucideIcon,
} from "lucide-react"

export function iconFor(
  thing: { product?: TillCatalogueProduct; item?: TillCatalogueItem } | { kind: string }
): LucideIcon {
  const kind =
    "kind" in thing
      ? thing.kind
      : thing.product
        ? `product:${thing.product.kind}:${thing.product.name.toLowerCase()}`
        : (thing.item?.kind ?? "other")
  if (kind.startsWith("product:")) {
    if (kind.includes(":membership")) return BadgeCheckIcon
    if (kind.includes(":deposit")) return PiggyBankIcon
    if (kind.includes("table") || kind.includes("hour")) return ClockIcon
    if (kind.includes("event") || kind.includes("entry")) return TicketIcon
    if (kind.includes("card")) return LayersIcon
    if (kind.includes(":service")) return CalendarClockIcon
    return TagIcon
  }
  switch (kind) {
    case "single":
    case "graded":
      return LayersIcon
    case "retro":
      return GamepadIcon
    case "sealed":
      return BoxIcon
    default:
      return PackageIcon
  }
}

/** "2000" is £20.00: the money pad's value, which `applyKey` builds. */
export function digitsToPence(digits: string): number {
  const value = Number.parseInt(digits || "0", 10)
  return Number.isFinite(value) ? value : 0
}

export function penceToDigits(pence: number): string {
  return pence > 0 ? String(Math.round(pence)) : ""
}
