/**
 * The inventory list's pure logic: tabs, search, filters, sort, the summary
 * tiles and margins. Integer pence throughout.
 */
import { roundHalfUp, roundToRetailEnding } from "@gg/shared/money"
import { suggestSellPrice } from "@gg/shared/pricing"

import type { InventoryItem } from "../types"

export const STOCK_TABS = [
  { value: "all", label: "All" },
  { value: "cards", label: "Cards" },
  { value: "graded", label: "Graded" },
  { value: "sealed", label: "Sealed" },
  { value: "retro", label: "Retro" },
  { value: "comics", label: "Comics" },
  { value: "other", label: "Other" },
] as const

export type StockTab = (typeof STOCK_TABS)[number]["value"]

const COMIC = /\bcomics?\b/i

export function isComic(item: Pick<InventoryItem, "title" | "category_path">): boolean {
  return COMIC.test(item.category_path) || COMIC.test(item.title)
}

export function tabOf(item: InventoryItem): Exclude<StockTab, "all"> {
  if (isComic(item)) return "comics"
  switch (item.kind) {
    case "single":
      return "cards"
    case "graded":
      return "graded"
    case "sealed":
      return "sealed"
    case "retro":
      return "retro"
    default:
      return "other"
  }
}

export type SortKey = "newest" | "oldest" | "name" | "price_desc" | "price_asc" | "margin_asc" | "market_desc"

export const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name" },
  { value: "price_desc", label: "Price, high" },
  { value: "price_asc", label: "Price, low" },
  { value: "margin_asc", label: "Margin, low" },
  { value: "market_desc", label: "Market, high" },
]

export interface StockFilters {
  tab: StockTab
  q: string
  game: string
  condition: string
  location: string
  sort: SortKey
}

export const DEFAULT_FILTERS: StockFilters = {
  tab: "all",
  q: "",
  game: "",
  condition: "",
  location: "",
  sort: "newest",
}

/**
 * Margin on the sticker as a whole percent of the sticker, half-up, or null
 * when there is no sticker or no cost to measure against.
 */
export function marginPct(price: number, cost: number): number | null {
  if (!(price > 0) || !(cost > 0)) return null
  return roundHalfUp(((price - cost) * 100) / price)
}

function haystack(item: InventoryItem): string {
  return [item.title, item.sku, item.set_code, item.number, item.game_name, item.location_name, item.category_path]
    .join(" ")
    .toLowerCase()
}

export function filterItems(items: readonly InventoryItem[], f: StockFilters): InventoryItem[] {
  const words = f.q.trim().toLowerCase().replace(/-/g, "").split(/\s+/).filter(Boolean)
  const rows = items.filter((item) => {
    if (f.tab !== "all" && tabOf(item) !== f.tab) return false
    if (f.game && item.game !== f.game) return false
    if (f.condition && item.condition !== f.condition) return false
    if (f.location && item.location !== f.location) return false
    if (words.length) {
      const text = haystack(item)
      if (!words.every((word) => text.includes(word))) return false
    }
    return true
  })
  return sortItems(rows, f.sort)
}

export function sortItems(rows: InventoryItem[], sort: SortKey): InventoryItem[] {
  const by = [...rows]
  const margin = (item: InventoryItem) => marginPct(item.price, item.cost) ?? Number.POSITIVE_INFINITY
  switch (sort) {
    case "oldest":
      return by.sort((a, b) => a.created.localeCompare(b.created))
    case "name":
      return by.sort((a, b) => a.title.localeCompare(b.title))
    case "price_desc":
      return by.sort((a, b) => b.price - a.price)
    case "price_asc":
      return by.sort((a, b) => a.price - b.price)
    case "margin_asc":
      return by.sort((a, b) => margin(a) - margin(b))
    case "market_desc":
      return by.sort((a, b) => (b.market ?? -1) - (a.market ?? -1))
    default:
      return by.sort((a, b) => b.created.localeCompare(a.created))
  }
}

export interface StockSummary {
  /** Units, not rows. */
  units: number
  rows: number
  market: number
  sticker: number
  cost: number
  /** Units with no market value, left out of `market`. */
  unpriced: number
}

export function summarise(items: readonly InventoryItem[]): StockSummary {
  const out: StockSummary = { units: 0, rows: items.length, market: 0, sticker: 0, cost: 0, unpriced: 0 }
  for (const item of items) {
    const qty = Math.max(0, item.qty)
    out.units += qty
    out.sticker += item.price * qty
    out.cost += item.cost * qty
    if (item.market === null) out.unpriced += qty
    else out.market += item.market * qty
  }
  return out
}

/** "SV3PT5 199 · NM" style detail line. */
export function detailLine(item: InventoryItem): string {
  const parts: string[] = []
  if (item.kind === "graded") parts.push([item.grade_company, item.grade].filter(Boolean).join(" "))
  if (item.set_code) parts.push(item.set_code.toUpperCase())
  if (item.number) parts.push(`#${item.number}`)
  if (!item.set_code && item.game_name && item.kind !== "graded") parts.push(item.game_name)
  return parts.filter(Boolean).join(" ")
}

/** Add stock's suggested sticker: market through the shared markup bands, up to .49 or .99. */
export function suggestedSticker(market: number | null): number | null {
  if (market === null || market <= 0) return null
  return suggestSellPrice(market, undefined, roundToRetailEnding)
}
