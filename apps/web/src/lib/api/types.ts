/**
 * Hand-written mirrors of the PocketBase collections this phase touches.
 *
 * TEMPORARY. `packages/shared/src/pb-types.ts` is the generated truth
 * (`pnpm typegen`), and these interfaces are replaced by its `GamesRecord`,
 * `CardsRecord`, `LocationsRecord`, `ItemsRecord`, `LabelJobsRecord` and
 * `StaffRecord` as soon as the backend agent's migrations settle: the
 * generated file already exists, but it is regenerated on every migration
 * change, so Phase 1 does not pin itself to a moving target. Field names and
 * select values below were read off pb/pb_migrations/, not off docs/PLAN.md,
 * so they match what the server will actually accept.
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

// ---------------------------------------------------------------------------
// Customers, trade-ins and receipts (Phase 2)
//
// Field names read off pb/pb_migrations/1789819200_auth_collections.js,
// 1789819380_trading_collections.js and 1789819680_phase2_fields.js, and the
// payload shapes off docs/api-contract.md.
// ---------------------------------------------------------------------------

export type IdStatus = "none" | "verified" | "expired" | "rejected"
export type CustomerFlag = "no_cash" | "watchlist" | "under_18"
export type IdType = "passport" | "driving_licence" | "other"

/** `customers` (auth). Only what the customer themself may see lives here. */
export interface CustomerRecord extends BaseRecord {
  name: string
  email?: string
  phone?: string
  code: string
  qr_token?: string
  marketing_consent?: boolean
  birthday_month?: number
  source?: "counter" | "portal"
  referred_by?: string
}

/** `customer_private`: the staff-only half. Balances are pence. */
export interface CustomerPrivateRecord extends BaseRecord {
  customer: string
  address?: string
  dob?: string
  notes?: string
  flags?: CustomerFlag[]
  id_status?: IdStatus
  id_type?: string
  id_expiry?: string
  id_ref_last4?: string
  id_verified_by?: string
  id_verified_at?: string
  credit_balance?: number
  points_balance?: number
  tier?: string
}

/** One row in the customers table: everything a row shows, already joined. */
export interface CustomerSummary {
  id: string
  name: string
  code: string
  phone: string
  email: string
  idStatus: IdStatus
  /** Integer GBP pence. */
  creditBalance: number
  /** ISO date of the last completed trade-in, or null. */
  lastVisit: string | null
  flags: CustomerFlag[]
}

/** A customer with their staff-only row and the duplicates they may have. */
export interface CustomerProfile {
  customer: CustomerRecord
  private: CustomerPrivateRecord | null
  lastVisit: string | null
  /** Other customers sharing this phone or email. */
  duplicates: CustomerSummary[]
}

export interface NewCustomerInput {
  name: string
  phone?: string
  email?: string
  marketingConsent?: boolean
}

export interface CustomerPatch {
  name?: string
  phone?: string
  email?: string
  marketingConsent?: boolean
  /** Written to `customer_private`. */
  address?: string
  notes?: string
  flags?: CustomerFlag[]
}

/** `credit_ledger`: append-only, signed pence. */
export interface CreditLedgerRecord extends BaseRecord {
  customer: string
  amount: number
  reason: "trade_in" | "sale" | "adjustment" | "expiry" | "reward"
  ref?: string
  balance_after?: number
  staff?: string
}

// ---- Trade-ins ------------------------------------------------------------

export type TradeInStatus =
  | "draft"
  | "offered"
  | "accepted"
  | "completed"
  | "declined"
  | "cancelled"

export type PayoutType = "cash" | "credit" | "mixed"

/** `trade_ins`. Money is integer GBP pence. */
export interface TradeInRecord extends BaseRecord {
  number: string
  customer: string
  channel?: "counter" | "remote"
  status?: TradeInStatus
  payout_type?: PayoutType
  total_market?: number
  total_offer?: number
  payout_cash?: number
  payout_credit?: number
  id_checked?: boolean
  staff?: string
  completed_at?: string
  seller_name?: string
  seller_address?: string
}

/** `trade_in_lines`. */
export interface TradeInLineRecord extends BaseRecord {
  trade_in: string
  kind?: ItemKind
  game?: string
  card?: string
  retro_title?: string
  free_text_title?: string
  finish?: string
  condition?: Condition | ""
  completeness?: Completeness | ""
  qty?: number
  market_price?: number
  market_currency?: "GBP" | "EUR" | "USD"
  market_source?: string
  offer_pct?: number
  offer_price?: number
  accepted?: boolean
  item?: string
}

/** What the wizard sends for one line on every save. */
export interface TradeInLineInput {
  /** Set once the line has been written; absent means create. */
  id?: string
  kind: ItemKind
  gameId?: string
  cardId?: string
  title?: string
  finish?: string
  condition?: string
  completeness?: string
  qty: number
  /** Integer GBP pence. */
  marketPrice: number
  marketSource?: string
  offerPct?: number
  /** Integer GBP pence, for the whole line. */
  offerPrice: number
  accepted: boolean
}

/** A trade-in with its customer's name, for the recent list. */
export interface TradeInSummary {
  id: string
  number: string
  status: TradeInStatus
  customerId: string
  customerName: string
  customerCode: string
  payoutType: PayoutType | null
  totalMarket: number
  totalOffer: number
  payoutCash: number
  payoutCredit: number
  staffName: string
  /** ISO timestamp: completed when there is one, else created. */
  at: string
}

export interface IdCheckPayload {
  id_type: IdType
  id_expiry: string
  id_ref_last4: string
  dob: string
  address: string
  id_document: string | null
}

/** docs/api-contract.md, POST /api/vault/trade-ins/:id/complete. */
export interface CompleteTradeInPayload {
  payout_type: PayoutType
  payout_cash: number
  payout_credit: number
  terms_accepted: boolean
  signature: string | null
  cash_session: string | null
  id_check: IdCheckPayload | null
}

export interface CompleteTradeInResult {
  trade_in: {
    id: string
    number: string
    status: string
    payout_cash: number
    payout_credit: number
  }
  items: { id: string; sku: string; title: string }[]
  labels_queued: number
  points_earned: number
  credit_balance: number
}

export interface IdCheckResult {
  id_document: string
  id_status: IdStatus
  id_expiry: string
  expires_at: string
}

/** What the A4 receipt page prints. See "Receipts" in docs/api-contract.md. */
export interface ReceiptPayload {
  shop: {
    name: string
    address: string
    town: string
    postcode: string
    phone: string
    email: string
  }
  trade_in: {
    id: string
    number: string
    completed_at: string
    payout_type: PayoutType | null
    payout_cash: number
    payout_credit: number
    total_market: number
    total_offer: number
  }
  seller: {
    name: string
    address: string
    id_type: string
    id_last4: string
    id_expiry: string
  }
  lines: {
    title: string
    detail: string
    condition: string
    qty: number
    market_price: number
    offer_price: number
  }[]
  signature_url: string | null
  staff: string
  terms: string
  retention: string
}

/** `settings` fields the buy-in wizard reads. */
export interface OfferLimits {
  /** Integer GBP pence. A single cash payout may not exceed it. */
  cashCap: number
}
