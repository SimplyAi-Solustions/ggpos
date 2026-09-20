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
  /**
   * Who signed the ID off, by name. Null when the relation could not be
   * expanded, which is what an ordinary staff token gets: `staff` is
   * admin-only, so the profile says "by a staff member" rather than
   * printing a record id at somebody.
   */
  verifiedByName: string | null
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
  /** Retro only: A, B or C. Copied onto `items.cosmetic_grade`. */
  cosmetic_grade?: string
  qty?: number
  market_price?: number
  market_currency?: "GBP" | "EUR" | "USD"
  market_source?: string
  offer_pct?: number
  offer_price?: number
  /** Integer GBP pence; 0 means no override was made. */
  override_cash?: number
  override_credit?: number
  override_reason?: string
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
  /** Retro only: how the box and label look, A, B or C. */
  cosmeticGrade?: string
  qty: number
  /** Integer GBP pence, per unit. */
  marketPrice: number
  marketSource?: string
  offerPct?: number
  /** Integer GBP pence, per unit. */
  offerPrice: number
  /**
   * What a staff member put in place of the band's figure, and why. Kept
   * beside the price so the audit row says why, and so reopening a draft
   * does not reprice a line somebody had to justify. Integer GBP pence.
   */
  overrideCash?: number
  overrideCredit?: number
  overrideReason?: string
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

/**
 * What the A4 receipt page prints.
 *
 * Matches `pb/pb_hooks/lib/receipts.js` exactly, display strings included:
 * the server formats the money so the printed page and the emailed copy can
 * never round differently.
 */
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
    status: string
    completed_at: string
    date_display: string
    payout_type: PayoutType | ""
    payout_cash: number
    payout_credit: number
    payout_total: number
    payout_cash_display: string
    payout_credit_display: string
    payout_total_display: string
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
  staff: { id: string; name: string }
  lines: {
    id: string
    title: string
    condition: string
    finish: string
    qty: number
    market_price: number
    offer_price: number
    line_total: number
    offer_price_display: string
    line_total_display: string
  }[]
  /** A short-lived PocketBase file token URL, never a data URL. */
  signature: { file: string; url: string; token: string } | null
  terms: string
  retention_note: string
}

/** What the receipt email route answers; `test_mode` holds it back. */
export interface ReceiptEmailResult {
  sent: boolean
  test_mode?: boolean
}

/** `settings` fields the buy-in wizard reads. */
export interface OfferLimits {
  /** Integer GBP pence. A single cash payout may not exceed it. */
  cashCap: number
}

// ---------------------------------------------------------------------------
// Selling, cash, labels and the item page (Phase 2)
//
// Field names read off pb/pb_migrations/1789819440_selling_cash_collections.js
// and 1789819560_ops_collections.js; payload shapes off docs/api-contract.md
// ("Sales", "Cash sessions", "Step-up", "Labels").
//
// The import sits here rather than at the top of the file so this block stays
// one self-contained append while three packages are being written in
// parallel; ES modules hoist it either way.
// ---------------------------------------------------------------------------

import type {
  LoyaltyProgramme,
  LoyaltyRule,
  LoyaltyTier,
  TierPerk,
} from "@gg/shared"

export type PaymentMethod =
  | "sumup_card"
  | "cash"
  | "store_credit"
  | "points"
  | "mixed"

/** Everything but `mixed`: the methods a split is made of. */
export type SplitMethod = Exclude<PaymentMethod, "mixed">

export type RefundMethod = "cash" | "store_credit" | "sumup_card"

export type DiscountSource = "manual" | "tier_perk" | "reward"

export type SaleStatus = "complete" | "refunded" | "part_refunded"

/** `sales`. Money is integer GBP pence. */
export interface SaleRecord extends BaseRecord {
  number: string
  staff?: string
  customer?: string
  subtotal?: number
  discount?: number
  discount_source?: DiscountSource | ""
  total?: number
  payment?: PaymentMethod
  payment_split?: Partial<Record<SplitMethod, number>>
  sumup_ref?: string
  cash_session?: string
  points_earned?: number
  /** Pence refunded so far. A refund never rewrites the original total. */
  refunded_total?: number
  status?: SaleStatus
}

/** `sale_lines`. */
export interface SaleLineRecord extends BaseRecord {
  sale: string
  item: string
  qty?: number
  /**
   * How many of `qty` have gone back. `qty` and `discount` are never
   * rewritten, so a line with `refunded_qty` above zero and a status still
   * "sold" is part refunded.
   */
  refunded_qty?: number
  unit_price?: number
  discount?: number
  vat_rate?: number
  tax_scheme?: "margin" | "standard"
  status?: "sold" | "refunded"
}

/** A sale line with the item's own words joined on, for the refund sheet. */
export interface SaleLineDetail extends SaleLineRecord {
  sku: string
  title: string
  condition?: string
}

/** One row in the "Today" sales list. */
export interface SaleSummary {
  id: string
  number: string
  total: number
  payment: PaymentMethod
  status: SaleStatus
  customerName: string | null
  /** ISO timestamp. */
  at: string
  lineCount: number
}

/** A sale with its lines, for the refund sheet and the undo. */
export interface SaleDetail extends SaleRecord {
  lines: SaleLineDetail[]
  customerName: string | null
}

/** docs/api-contract.md, POST /api/vault/sales/complete. */
export interface CompleteSalePayload {
  lines: { item: string; qty: number; unit_price: number; discount: number }[]
  customer: string | null
  payment: PaymentMethod
  payment_split: Partial<Record<SplitMethod, number>>
  discount: number
  discount_source: DiscountSource | null
  reward_code: string | null
  cash_session: string | null
  sumup_ref: string
}

export interface CompleteSaleResult {
  sale: { id: string; number: string; total: number; status: SaleStatus }
  sumup_amount: number
  points_earned: number
  credit_balance: number
  points_balance: number
}

/** docs/api-contract.md, POST /api/vault/sales/:id/refund (step-up). */
export interface RefundSalePayload {
  lines: { sale_line: string; qty: number }[]
  reason: string
  refund_method: RefundMethod
}

export interface RefundSaleResult {
  sale: { id: string; status: SaleStatus }
  refunded: number
}

// ---- Cash -----------------------------------------------------------------

export type CashMovementType =
  | "float_in"
  | "payout"
  | "cash_sale"
  | "refund"
  | "bank_drop"
  | "adjustment"

/** `cash_sessions`. Money is integer GBP pence. */
export interface CashSessionRecord extends BaseRecord {
  opened_by?: string
  opened_at?: string
  float?: number
  closed_by?: string
  closed_at?: string
  expected?: number
  counted?: number
  variance?: number
  notes?: string
  /** Joined for the table, never stored. */
  openedByName?: string
  closedByName?: string
}

/** `cash_movements`. `amount` is signed pence. */
export interface CashMovementRecord extends BaseRecord {
  session: string
  type: CashMovementType
  amount?: number
  ref?: string
  staff?: string
  /** Joined for the table, never stored. */
  staffName?: string
}

/**
 * POST /api/vault/cash-sessions/:id/close. The route answers with the closed
 * session plus its own copy of the sums, and `variance_alert` is a flag
 * saying the variance cleared `settings.cash_variance_alert`, not the
 * threshold itself.
 */
export interface CashCloseResult {
  session: CashSessionRecord
  expected: number
  variance: number
  overAlert: boolean
}

/** GET /api/vault/cash-sessions/current. */
export interface CashSessionState {
  session: CashSessionRecord | null
  /** float + cash sales + float_in - payouts - refunds - bank drops. */
  expected: number
  movements: CashMovementRecord[]
}

// ---- Step-up --------------------------------------------------------------

/** POST /api/vault/step-up. Valid for ten minutes. */
export interface StepUpToken {
  token: string
  expiresAt: string
}

// ---- The customer on a sale ----------------------------------------------

/** Everything the Sell screen's customer strip shows, already joined. */
export interface SaleCustomer {
  id: string
  name: string
  code: string
  tierId: string | null
  tierName: string | null
  /** Parsed `loyalty_tiers.perks`, unknown shapes dropped. */
  perks: TierPerk[]
  /** Integer GBP pence. */
  creditBalance: number
  pointsBalance: number
}

/** The live loyalty programme, its rules and its tiers, for the preview. */
export interface LoyaltySetup {
  programme: LoyaltyProgramme
  rules: LoyaltyRule[]
  tiers: LoyaltyTier[]
}

/** An issued `reward_redemptions` row, scanned or typed as GGV-xxxxxx. */
export interface RewardVoucher {
  id: string
  code: string
  customer: string
  rewardName: string
  type: "money_off" | "store_credit" | "free_item" | "event_entry" | "custom"
  /** Pence for money_off and store_credit; otherwise not money. */
  value: number
  expiresAt: string | null
}

// ---- Stock ----------------------------------------------------------------

/**
 * The rest of `items`, read off 1789819320_stock_collections.js: the fields
 * the item page and the label templates show that Add stock never sets.
 */
export interface StockItemRecord extends ItemRecord {
  region?: "PAL" | "NTSC" | "JP"
  cosmetic_grade?: "A" | "B" | "C"
  tested?: boolean
  grade_company?: string
  grade?: string
  cert_no?: string
  supplier_ref?: string
  trade_in_line?: string
  reserved_for?: string
  reserved_until?: string
  ebay_listing_id?: string
  label_printed_at?: string
  photos?: string[]
}

export interface ItemFilters {
  /** Blank means every status the list shows. */
  status?: ItemStatus
  /** Free text over title, code, set and number. */
  search?: string
  locationId?: string
}

export interface ItemListPage {
  items: ItemSummary[]
  page: number
  perPage: number
  totalItems: number
  totalPages: number
}

/** One row of the stock table: everything the row draws, already joined. */
export interface ItemSummary {
  id: string
  sku: string
  kind: ItemKind
  title: string
  detail: string
  condition: string
  price: number
  status: ItemStatus
  locationName: string
  image?: string
  /** A `PlatformKey` from src/design/platforms.ts. */
  platform: string
  qty: number
  /** The `games` id, which the points preview needs on a basket line. */
  game: string | null
}

export type ItemEventKind =
  | "created"
  | "sold"
  | "refunded"
  | "reserved"
  | "written_off"
  | "label"

/** One line of the item page's history list. */
export interface ItemEvent {
  kind: ItemEventKind
  at: string
  detail: string
}

/** The item page: the record plus everything it shows about where it came from. */
export interface ItemDetail extends StockItemRecord {
  image?: string
  /** A `PlatformKey` from src/design/platforms.ts. */
  platform: string
  gameName: string
  locationName: string
  /** Provenance: a trade-in number and its seller, or a supplier reference. */
  tradeInNumber: string | null
  sellerName: string | null
  sellerCode: string | null
  reservedForName: string | null
  reservedUntil: string | null
  history: ItemEvent[]
}

/** What the item page's edit sheets send back. */
export interface ItemPatch {
  price?: number
  locationId?: string
  status?: ItemStatus
  notes?: string
}

// ---- Labels ---------------------------------------------------------------

export type LabelTemplateKey =
  | "toploader_40x20"
  | "sleeve_25x15"
  | "retro_50x30"
  | "customer_card_80x50"

export type LabelJobStatus = "queued" | "printed" | "cancelled"

/** A queued label with the words the print page puts on it. */
export interface LabelJobDetail {
  id: string
  status: LabelJobStatus
  copies: number
  template: LabelTemplateKey
  itemId: string
  /** The bare code the QR encodes, for example GGS7F3K2Q. */
  code: string
  title: string
  /** Set code, number and finish, or platform and region for retro. */
  detail: string
  condition: string
  /** Integer GBP pence. */
  price: number
  requestedAt: string
}

// ---- Today ----------------------------------------------------------------

/** The four tiles and the recent list on Home. Money is integer GBP pence. */
export interface TodayStats {
  salesCount: number
  salesTotal: number
  salesByPayment: Partial<Record<SplitMethod, number>>
  buyInCount: number
  buyInTotal: number
  cashOut: number
  creditIssued: number
  itemsIn: number
  itemsOut: number
  recent: RecentActivity[]
}

/** One line of Home's "Recent" list: a sale or a buy-in. */
export interface RecentActivity {
  id: string
  kind: "sale" | "buy_in"
  number: string
  total: number
  detail: string
  at: string
}

// ---------------------------------------------------------------------------
// The shop's own configuration, and the customer routes that need a step-up
//
// `GET /api/vault/config` hands every staff member the settings, the offer
// bands and the loyalty programme in one read, so the counter no longer has
// to touch the admin-only collections behind them.
// ---------------------------------------------------------------------------

/** One row of `pricing_rules`, as the config route serves it. */
export interface PricingRuleRow {
  id: string
  game?: string
  kind?: string
  condition?: string
  finish?: string
  rarity?: string
  band_min?: number
  band_max?: number
  cash_pct?: number
  credit_pct?: number
  rounding?: number
  priority?: number
  active?: boolean
}

/** `loyalty_programme`, as the config route serves it. */
export interface LoyaltyProgrammeRow {
  id?: string
  enabled?: boolean
  earn_per_pound_sales?: number
  earn_on_trade_in_credit?: number
  points_per_pound_redemption?: number
  min_redeem_points?: number
  max_points_share_of_sale?: number
  expiry_months_inactive?: number
  tier_window_months?: number
  welcome_bonus?: number
  referral_bonus_referrer?: number
  referral_bonus_referee?: number
}

/** One row of `loyalty_rules`. */
export interface LoyaltyRuleRow {
  id: string
  name?: string
  type?: string
  conditions?: Record<string, unknown>
  value?: number
  active?: boolean
  priority?: number
  starts_at?: string
  ends_at?: string
}

/** One row of `loyalty_tiers`. */
export interface LoyaltyTierRow {
  id: string
  name?: string
  threshold_points?: number
  sort?: number
  perks?: unknown[]
  paid_plan?: boolean
}

/**
 * The settings the counter may read. Secrets (`api_keys`, the mail and push
 * keys) never leave the server, so they are not in this shape at all.
 */
export interface VaultSettingsRow {
  cash_cap?: number
  cash_variance_alert?: number
  offer?: Partial<{
    bulkThreshold: number
    bulkCash: number
    bulkCredit: number
    minimumOffer: number
  }>
  min_single_offer?: number
  bulk_rate_pct?: number
  source_priority?: string[]
  retro_source_priority?: string[]
  condition_multipliers?: Record<string, number>
  markup_bands?: { from: number; multiplier: number }[]
  sell_rounding?: string
  label_default_template?: string
  default_intake_location?: string
  quote_expiry_days?: number
  id_photo_retention_months?: number
  vat_registered?: boolean
  shop_name?: string
  shop_address?: string
  shop_town?: string
  shop_postcode?: string
  shop_phone?: string
  shop_email?: string
  receipt_terms?: string
}

export interface VaultConfig {
  settings: VaultSettingsRow
  pricing_rules: PricingRuleRow[]
  loyalty: {
    programme: LoyaltyProgrammeRow | null
    rules: LoyaltyRuleRow[]
    tiers: LoyaltyTierRow[]
  }
}

/** The newest ID document whose photo is still on disk, or null. */
export interface IdDocumentSummary {
  id: string
  taken_at: string
  expires_at: string
  taken_by: string
}

/** What a merge moved, by collection, so the counter can say what happened. */
export interface MergeResult {
  profile: CustomerProfile
  moved: Record<string, number>
}

// ---------------------------------------------------------------------------
// What the counter reads out of GET /api/vault/config
//
// The wire shape (`VaultConfig` above) and the fetch itself live with the
// buy-in wizard's helpers; this is the slice the Sell and Cash screens use,
// already in the shared evaluator's shapes so no screen parses a row.
// ---------------------------------------------------------------------------

export interface CounterConfig {
  /**
   * `settings.cash_variance_alert` in integer GBP pence. Zero means no alert
   * is configured, which is exactly how the close route reads it, so there is
   * no invented default anywhere on the client.
   */
  cashVarianceAlert: number
  /** `settings.cash_cap` in integer GBP pence. */
  cashCap: number
  /** The programme, its live rules and its tiers. */
  loyalty: LoyaltySetup
}

// ---------------------------------------------------------------------------
// Settings and stock counts (Phase 3)
//
// Field names read off pb/pb_migrations/1789819560_ops_collections.js
// (`settings`, `pricing_rules`) and 1789819320_stock_collections.js
// (`stock_counts`, `stock_count_lines`). `settings` and `pricing_rules` are
// admin-only collections written straight through the collection API with an
// admin token; every other screen reads them through GET /api/vault/config.
// ---------------------------------------------------------------------------

/**
 * The whole `settings` row as an admin edits it. The secrets on the record
 * (`api_keys`, the mail key, the VAPID keys) are deliberately absent: they
 * are never read into the browser and never written from it.
 */
export interface SettingsRecord extends BaseRecord, VaultSettingsRow {
  id: string
}

/** One `pricing_rules` row on its way to the server. No id means create. */
export interface PricingRuleWrite {
  id?: string
  game?: string
  kind?: string
  condition?: string
  finish?: string
  rarity?: string
  band_min: number
  band_max: number
  cash_pct: number
  credit_pct: number
  rounding: number
  priority: number
  active: boolean
}

export type StockCountStatus = "open" | "closed"

/** One line of a count: what the shelf should hold, and what was found. */
export interface StockCountLine {
  id: string
  itemId: string
  sku: string
  title: string
  /** "SV151 199/165 Holo", from the shared item-shape helper. */
  detail: string
  expectedQty: number
  scannedQty: number
  /** Where the item is recorded now, which is not always where it turned up. */
  locationName: string
}

/** A count with its lines, which is everything the count screen draws. */
export interface StockCountDetail {
  id: string
  locationId: string
  locationName: string
  status: StockCountStatus
  startedAt: string
  startedByName: string
  closedAt: string | null
  lines: StockCountLine[]
}

/** One row of the past counts list. */
export interface StockCountSummary {
  id: string
  locationName: string
  status: StockCountStatus
  startedAt: string
  closedAt: string | null
  expected: number
  scanned: number
  missing: number
  unexpected: number
}

// ---------------------------------------------------------------------------
// Lookup, prices and FX (Phase 3)
//
// The wire shapes of docs/api-contract.md's "Phase 3: lookup, prices and FX"
// routes, read off pb/pb_hooks/lookup.pb.js, prices.pb.js, fx.pb.js and
// pb/pb_hooks/adapters/pricing_policy.js so they match what the server
// actually sends. Money is integer GBP pence; `native_*` figures are minor
// units of `native_currency` and never appear on screen without the GBP
// figure beside them (CLAUDE.md, "Pricing").
//
// The import sits here rather than at the top of the file so this block stays
// one self-contained append while three packages are being written in
// parallel; ES modules hoist it either way.
// ---------------------------------------------------------------------------

import type { PriceSource } from "@gg/shared/pricing"

/** The five games with a card catalogue behind them. `retro` is not one. */
export type LookupGame = "pokemon" | "mtg" | "yugioh" | "onepiece" | "lorcana"

/** One row of `GET /api/vault/lookup`, straight off `cards` + `card_sets`. */
export interface CardLookupRow {
  id: string
  /** The `games` record id, not its key. */
  game: string
  /** The `card_sets` record id. */
  set: string
  set_code: string
  set_name: string
  number: string
  name: string
  rarity: string
  image_small: string
  image_large: string
  finishes_available: string[]
  external_ids: Record<string, string>
  last_synced: string
}

/** One row of `GET /api/vault/retro/lookup`. `id` is "" for a preview-only hit. */
export interface RetroTitleRow {
  id: string
  /** The `platforms` record id. */
  platform: string
  name: string
  region: string
  /** A PocketBase file name on `retro_titles`, not a URL. */
  cover: string
  external_ids: Record<string, string>
}

/** A retro title with its platform resolved, as the screens use it. */
export interface RetroHit {
  id: string
  name: string
  /** The `platforms` record id, or "" on a preview-only hit. */
  platformId: string
  /** The platform's `key`, for example "snes_pal_box". */
  platformKey: string
  platformName: string
  region: string
  /** A URL the browser can load, built from the file name. */
  image?: string
}

/**
 * One source's valuation. `gbp_market` is the only figure a screen shows on
 * its own; `native_market` only ever appears beside it as supporting detail.
 */
export interface PriceSourceRow {
  source: PriceSource
  gbp_market: number
  native_currency: "GBP" | "EUR" | "USD"
  native_market: number
  /** GBP per one unit of `native_currency`, or null for a GBP source. */
  fx_rate: number | null
  fx_date: string | null
  fetched_at: string
  stale: boolean
  /** The ebay.co.uk listing behind a staff-entered UK sold comp. */
  evidence_url: string
}

/** The body every price route answers with, GET and POST alike. */
export interface PriceView {
  chosen: PriceSourceRow | null
  /** One row per source that has a value, in the shop's priority order. */
  sources: PriceSourceRow[]
  /** `chosen.gbp_market` after the condition multiplier; null for retro. */
  condition_adjusted: number | null
}

/** What the "Add UK comp" sheet sends. `price` is integer GBP pence. */
export interface UkCompInput {
  finish?: string
  condition?: string
  price: number
  url: string
  /** YYYY-MM-DD. */
  sold_at: string
}

/** `GET /api/vault/fx`. `rates[code]` is GBP per one unit of `code`. */
export interface FxRatesView {
  base: string
  rates: Record<string, number>
  fetched_at: string | null
  stale: boolean
}
