import type { DealOverrides, DealPayout, DealPayoutType, DealRates } from "@gg/shared/deal"

export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const
export type Condition = (typeof CONDITIONS)[number]

export const GAMES = [
  { key: "pokemon", label: "Pokemon" },
  { key: "mtg", label: "Magic" },
  { key: "yugioh", label: "Yu-Gi-Oh!" },
  { key: "onepiece", label: "One Piece" },
  { key: "lorcana", label: "Lorcana" },
] as const
export type GameKey = (typeof GAMES)[number]["key"]

/** One condition's market value per unit, in pence, and where it came from. */
export interface ConditionPrice {
  pence: number | null
  /**
   * "comp": priced from that condition's own sold comps.
   * "estimated": NM scaled by the shop's condition multipliers, used only
   * until the server returns a per-condition comp.
   */
  basis: "comp" | "estimated"
  source?: string
}

export type ConditionPrices = Partial<Record<Condition, ConditionPrice>>

/** A card from the catalogue search. */
export interface CardHit {
  id: string
  game: string
  name: string
  setName: string
  setCode: string
  number: string
  rarity: string
  image: string
  finishes: string[]
}

export type CustomCategory = "retro" | "comic" | "sealed" | "other"

export const CUSTOM_CATEGORIES: ReadonlyArray<{ value: CustomCategory; label: string }> = [
  { value: "retro", label: "Retro" },
  { value: "comic", label: "Comic" },
  { value: "sealed", label: "Sealed" },
  { value: "other", label: "Other" },
]

interface LineBase {
  id: string
  name: string
  qty: number
  /** This line's own rates; absent follows the deal's sweep. */
  tradePct?: number
  cashPct?: number
}

export interface CardLine extends LineBase {
  kind: "card"
  cardId: string
  /** A `games` record id, or a game key ("pokemon") that the api resolves. */
  game: string
  setName: string
  setCode: string
  number: string
  image: string
  /** The finish or variant, for example "holo" or "reverse". */
  variant: string
  condition: Condition
  prices: ConditionPrices
  /** "loading" while the price call runs, "error" if it failed. */
  priceStatus: "loading" | "ready" | "error"
  /**
   * A value typed by staff when the condition has no price, or the value the
   * server stored, used until fresh prices load. Per unit.
   */
  manualMarket: number | null
}

export interface CustomLine extends LineBase {
  kind: "custom"
  category: CustomCategory
  /** The game key the item is stocked under: "retro", "other" or a TCG for sealed. */
  game: string
  /** Typed by staff. Per unit, pence. */
  manualMarket: number | null
}

export type DraftLine = CardLine | CustomLine

export interface DealPayoutChoice {
  type: DealPayoutType
  /** Cash the customer wants, for a split. Pence. */
  cashTaken: number
}

/** The seller on a deal: a `customers` record. */
export interface Seller {
  id: string
  name: string
  code: string
  phone: string
  email: string
}

export interface CompletedSnapshot {
  at: string
  /** GG-BI-000123, assigned by the server on completion. */
  number: string
  payout: DealPayout
  market: number
  trade: number
  cash: number
  calculatedTrade: number
  calculatedCash: number
  tradeOverridden: boolean
  cashOverridden: boolean
}

export interface DealDraft {
  id: string
  name: string
  status: "open" | "completed"
  createdAt: string
  updatedAt: string
  rates: DealRates
  lines: DraftLine[]
  overrides: DealOverrides
  payout: DealPayoutChoice
  note: string
  seller: Seller | null
  completed: CompletedSnapshot | null
}

/** What POST /api/vault/deals/{id}/complete gives back. */
export interface CompletionResult {
  tradeIn: {
    id: string
    number: string
    payoutType: "cash" | "credit" | "mixed"
    cashTaken: number
    creditGiven: number
  }
  items: Array<{ id: string; sku: string; title: string }>
  labelsQueued: number
}
