/**
 * Hand-written mirrors of the PocketBase collections this phase touches.
 *
 * TEMPORARY. `packages/shared/src/pb-types.ts` is the generated truth
 * (`pnpm typegen`, which needs a built pb_data), and these interfaces are
 * replaced by its `GamesRecord`, `CardsRecord`, `LocationsRecord`,
 * `ItemsRecord`, `LabelJobsRecord` and `StaffRecord` the moment the backend
 * agent's migrations settle. Field names and select values below were read
 * off pb/pb_migrations/, not off docs/PLAN.md, so they match what the server
 * will actually accept.
 */

/** Every PocketBase record carries these. */
export interface BaseRecord {
  id: string
  created?: string
  updated?: string
}

/** `games`: pokemon, mtg, yugioh, onepiece, lorcana, retro. */
export interface GameRecord extends BaseRecord {
  key: string
  name: string
  adapter?: string
  enabled?: boolean
}

/** `card_sets`: unique on (game, code). */
export interface CardSetRecord extends BaseRecord {
  game: string
  code: string
  name: string
  series?: string
  release_date?: string
  total?: number
}

/** `cards`: unique on (game, set, number). */
export interface CardRecord extends BaseRecord {
  game: string
  set: string
  number: string
  name: string
  rarity?: string
  type?: string
  /** json: the printings this card exists in, when the adapter knows. */
  finishes_available?: string[]
  image_small?: string
  image_large?: string
  tcgplayer_id?: string
  cardmarket_id?: string
  source?: "api" | "manual"
  search_text?: string
}

/** `locations`. */
export interface LocationRecord extends BaseRecord {
  name: string
  type?: string
  sort?: number
}

export type ItemKind =
  | "single"
  | "graded"
  | "retro"
  | "sealed"
  | "accessory"
  | "other"

export type Condition = "NM" | "LP" | "MP" | "HP" | "DMG"
export type Completeness = "loose" | "boxed" | "cib"

export type ItemStatus =
  | "in_stock"
  | "reserved"
  | "listed_ebay"
  | "sold"
  | "returned"
  | "written_off"

/** `items`. Money fields are integer GBP pence, never decimals. */
export interface ItemRecord extends BaseRecord {
  sku: string
  kind: ItemKind
  game: string
  card?: string
  retro_title?: string
  title?: string
  set_code?: string
  number?: string
  finish?: string
  language?: string
  condition?: Condition | ""
  completeness?: Completeness | ""
  ean?: string
  qty?: number
  cost?: number
  market_at_intake?: number
  price?: number
  tax_scheme?: "margin" | "standard"
  status?: ItemStatus
  location?: string
  source?: "trade_in" | "supplier" | "opening_stock"
  notes?: string
  created_by?: string
  acquired_at?: string
}

/** `label_jobs`. `template` is required by the migration, so queueLabel resolves one. */
export interface LabelJobRecord extends BaseRecord {
  item: string
  template: string
  copies?: number
  status?: "queued" | "printed" | "cancelled"
  requested_by?: string
  printed_at?: string
}

/** `staff` (auth). Ordinary staff read their own record via GET /api/vault/me. */
export interface StaffRecord extends BaseRecord {
  email: string
  name: string
  role: "admin" | "staff"
  active?: boolean
}

/**
 * A card with everything a row needs already joined, so the search dropdown
 * and the Add stock preview never wait on a second request.
 */
export interface CardHit {
  id: string
  name: string
  number: string
  /** The game's `key`, for example "pokemon". */
  gameKey: string
  gameId: string
  setCode: string
  setName: string
  image?: string
  rarity?: string
  finishes: string[]
  /** Market value in GBP pence, or null while Phase 2 is unwired. */
  marketPence: number | null
}

/** What Add stock sends to `createItem`. */
export interface NewItemInput {
  kind: ItemKind
  gameId: string
  cardId?: string
  title?: string
  setCode?: string
  number?: string
  finish?: string
  condition?: Condition
  completeness?: Completeness
  qty: number
  /** Integer GBP pence. */
  cost: number
  /** Integer GBP pence. */
  price: number
  locationId?: string
  ean?: string
  notes?: string
}
