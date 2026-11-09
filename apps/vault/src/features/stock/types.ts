/** One held item as GET /api/vault/stock/inventory returns it. Money is pence. */
export interface InventoryItem {
  id: string
  sku: string
  kind: ItemKind
  title: string
  card: string
  game: string
  game_name: string
  set_code: string
  number: string
  finish: string
  condition: string
  grade_company: string
  grade: string
  qty: number
  price: number
  cost: number
  /** Condition-adjusted UK-first market value per unit, or null when nothing is known. */
  market: number | null
  market_source: string
  location: string
  location_name: string
  category: string
  category_path: string
  status: string
  image: string
  notes: string
  label_printed_at: string
  /** The latest price change was typed by hand. */
  hand_priced: boolean
  acquired_at: string
  created: string
  updated: string
}

export type ItemKind = "single" | "graded" | "retro" | "sealed" | "accessory" | "other"

export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const
export type Condition = (typeof CONDITIONS)[number]

export interface NamedRecord {
  id: string
  name: string
}

export interface CategoryOption extends NamedRecord {
  path: string
}
