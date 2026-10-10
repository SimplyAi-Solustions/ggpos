/**
 * Stock on the website (docs/EPOS-PLAN.md, decision 13;
 * docs/api-contract-launch.md, section 6).
 *
 * The shop's website reads GG Vault's public feed in the browser: items in
 * stock that staff have marked `show_online`, never a cost, a supplier, a
 * customer, a location or a note. This module is the one place the rule
 * for "is it on the website" lives, so the feed on the server
 * (pb/pb_hooks/lib/publicstock.js) and the line on the item page agree,
 * and the shapes the feed answers with.
 *
 * Pure and shared: no PocketBase, no DOM.
 */
import { formatGBP } from "./money"

/** `settings.online`: the website switch, the price floor and whether quantities show. */
export interface OnlineSettings {
  enabled: boolean
  /** Integer GBP pence. Nothing priced below it shows online. */
  min_price: number
  /** When on, the feed leaves `qty` out of every item. */
  hide_qty: boolean
}

export const DEFAULT_ONLINE_SETTINGS: OnlineSettings = {
  enabled: true,
  min_price: 0,
  hide_qty: false,
}

/** Items on one page of `GET /api/public/stock`. */
export const PUBLIC_STOCK_PER_PAGE = 24

/** Longest search the feed takes; anything past it is cut. */
export const PUBLIC_SEARCH_MAX = 80

/** The website's two origins: the only ones `/api/public/` answers cross-origin reads for. */
export const PUBLIC_ORIGINS = [
  "https://ggentertainment.co.uk",
  "https://www.ggentertainment.co.uk",
] as const

/** `settings.online` as stored (json, possibly empty or partial), made whole. */
export function readOnlineSettings(raw: unknown): OnlineSettings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const min = Number(value.min_price)
  return {
    enabled: value.enabled === undefined ? DEFAULT_ONLINE_SETTINGS.enabled : value.enabled === true,
    min_price: Number.isFinite(min) && min > 0 ? Math.round(min) : 0,
    hide_qty: value.hide_qty === true,
  }
}

/** The fields of an `items` row the rule reads. */
export interface OnlineCandidate {
  show_online?: boolean | null
  status?: string | null
  qty?: number | null
  /** Integer GBP pence. */
  price?: number | null
}

/**
 * Why an item is not on the website, or null when it is. In this order: the
 * feed switched off, not marked, not on the shelf (sold, reserved, written
 * off), none left, priced under the floor.
 */
export function onlineProblem(item: OnlineCandidate, settings: OnlineSettings): string | null {
  if (!settings.enabled) return "The website feed is switched off in Settings, Website."
  if (!item.show_online) return "Not shown on the website."
  const status = item.status || "in_stock"
  if (status === "sold") return "Sold, so it is off the website."
  if (status === "reserved") return "Reserved, so it is off the website until the hold ends."
  if (status !== "in_stock") return "Only stock on the shelf shows on the website."
  if (!((item.qty ?? 0) > 0)) return "None left on the shelf, so it is off the website."
  if ((item.price ?? 0) < settings.min_price) {
    return `Under the website's minimum price of ${formatGBP(settings.min_price)}.`
  }
  return null
}

/** Whether the item is in the public feed right now. */
export function isOnline(item: OnlineCandidate, settings: OnlineSettings): boolean {
  return onlineProblem(item, settings) === null
}

/** The fields of an `items` row its condition is read from. */
export interface ConditionSource {
  kind?: string | null
  condition?: string | null
  completeness?: string | null
  grade_company?: string | null
  grade?: string | null
}

const CARD_CONDITIONS: Record<string, string> = {
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
}

const COMPLETENESS: Record<string, string> = {
  loose: "Loose",
  boxed: "Boxed",
  cib: "Complete in box",
}

/**
 * The condition in words a customer reads: a card's grade spelled out, a
 * slab's company and grade, a retro game's completeness, "Sealed" for
 * sealed product, and "" when nothing is recorded.
 */
export function conditionLabel(item: ConditionSource): string {
  if (item.kind === "graded") {
    const graded = [item.grade_company, item.grade].filter((part) => part && String(part).trim()).join(" ")
    return graded || "Graded"
  }
  if (item.kind === "retro") return COMPLETENESS[item.completeness ?? ""] ?? ""
  if (item.kind === "sealed") return "Sealed"
  return CARD_CONDITIONS[item.condition ?? ""] ?? ""
}

/**
 * A frame's ratio as one number, width over height to four places
 * (63:88 is 0.7159), so a page can set `aspect-ratio` straight from it.
 * A missing or broken ratio is the table's 3:4 fallback.
 */
export function ratioOf(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0.75
  return Math.round((width / height) * 10000) / 10000
}

// ---------------------------------------------------------------------
// The feed's shapes (section 6). Nothing else is ever in them.
// ---------------------------------------------------------------------

export interface PublicStockImage {
  /** Absolute URLs, or "" when the item has no picture at all. */
  small: string
  large: string
  /** The frame, width over height (`ratioOf`). */
  ratio: number
}

export interface PublicStockItem {
  sku: string
  title: string
  /** Integer GBP pence. */
  price: number
  condition: string
  finish: string
  /** The game's name, "Pokémon", or "". */
  game: string
  category: { id: string; path: string } | null
  image: PublicStockImage
  /** Left out when Settings, Website hides quantities. */
  qty?: number
  updated: string
}

/** `GET /api/public/stock/{sku}`: one item, with every photo in order. */
export interface PublicStockDetail extends PublicStockItem {
  photos: { small: string; large: string }[]
}

/** `GET /api/public/stock`. */
export interface PublicStockPage {
  items: PublicStockItem[]
  page: number
  per_page: number
  total: number
}

/** One branch of `GET /api/public/categories`, depth first. */
export interface PublicCategory {
  id: string
  name: string
  parent: string
  path: string
  depth: number
  /** Items online in this branch and everything beneath it. */
  count: number
}

export interface PublicCategories {
  categories: PublicCategory[]
}
