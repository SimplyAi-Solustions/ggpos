/** Small pure helpers the item page, quick view and binder grid share. */
import { finishKind, FINISH_LABEL } from "@/ui/CardArt"

import type { InventoryItem } from "../types"

export const KIND_LABEL: Record<string, string> = {
  single: "Single card",
  graded: "Graded card",
  sealed: "Sealed",
  retro: "Retro",
  accessory: "Accessory",
  other: "Other",
}

export const CONDITION_LABEL: Record<string, string> = {
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
}

export const MARKET_FROM: Record<string, string> = {
  uk_sold_manual: "UK sold comp",
  ebay_uk_asking: "eBay UK asking",
  cardmarket: "Cardmarket, in GBP",
  tcgplayer: "TCGplayer, in GBP",
  pricecharting_pal: "PriceCharting PAL, in GBP",
  pricecharting_ntsc: "PriceCharting NTSC, in GBP",
  intake: "Value at intake",
}

/** Cards get the foil treatment; everything else is drawn flat. */
export function isCard(item: Pick<InventoryItem, "kind">): boolean {
  return item.kind === "single" || item.kind === "graded"
}

/** "Holo", "Reverse holo", "PSA 10", or "" for a plain finish on a non-card. */
export function variantTag(item: Pick<InventoryItem, "kind" | "finish" | "grade_company" | "grade">): string {
  if (item.kind === "graded") return [item.grade_company, item.grade].filter(Boolean).join(" ")
  if (!isCard(item)) return ""
  const kind = finishKind(item.finish)
  return kind === "normal" && !item.finish ? "" : FINISH_LABEL[kind]
}

/** "SV3PT5 · 199" without the hash, for under a big title. */
export function setLine(item: Pick<InventoryItem, "set_code" | "number" | "game_name">): string {
  const parts = [item.set_code.toUpperCase(), item.number ? `#${item.number}` : ""].filter(Boolean)
  return parts.length ? parts.join(" · ") : item.game_name
}

export function marginTone(margin: number | null): "ok" | "warn" | "pop" | "neutral" {
  if (margin === null) return "neutral"
  if (margin < 10) return "pop"
  if (margin < 20) return "warn"
  return "ok"
}

/** "Market, LP" for a card in less than near mint; "Market, NM" otherwise. */
export function marketLabel(item: Pick<InventoryItem, "kind" | "condition">): string {
  if (item.kind === "single" && item.condition) return `Market, ${item.condition}`
  if (item.kind === "single") return "Market, NM"
  return "Market"
}

export function dateText(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

/** A binder page holds nine. */
export const POCKETS = 9

/** Splits a list into binder pages of nine. Exported for its test. */
export function toPages<T>(items: readonly T[], size = POCKETS): T[][] {
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size))
  return pages
}
