/**
* This file was @generated using pocketbase-typegen
*/

export const Collections = {
	Authorigins: "_authOrigins",
	Externalauths: "_externalAuths",
	Mfas: "_mfas",
	Otps: "_otps",
	Superusers: "_superusers",
	AdapterState: "adapter_state",
	AuditLog: "audit_log",
	CardSets: "card_sets",
	Cards: "cards",
	CashMovements: "cash_movements",
	CashSessions: "cash_sessions",
	Counters: "counters",
	CreditLedger: "credit_ledger",
	CsvImports: "csv_imports",
	CustomerPrivate: "customer_private",
	Customers: "customers",
	DailyStats: "daily_stats",
	FxRates: "fx_rates",
	Games: "games",
	IdDocuments: "id_documents",
	Items: "items",
	LabelJobs: "label_jobs",
	LabelTemplates: "label_templates",
	Locations: "locations",
	LoyaltyProgramme: "loyalty_programme",
	LoyaltyRewards: "loyalty_rewards",
	LoyaltyRules: "loyalty_rules",
	LoyaltyTiers: "loyalty_tiers",
	Memberships: "memberships",
	Notes: "notes",
	Notifications: "notifications",
	PerkUsage: "perk_usage",
	Platforms: "platforms",
	PointsLedger: "points_ledger",
	PriceSnapshots: "price_snapshots",
	PricingRules: "pricing_rules",
	PushSubscriptions: "push_subscriptions",
	Quotes: "quotes",
	Referrals: "referrals",
	RetroTitles: "retro_titles",
	RewardRedemptions: "reward_redemptions",
	SaleLines: "sale_lines",
	Sales: "sales",
	SavedReports: "saved_reports",
	Settings: "settings",
	Staff: "staff",
	StockCountLines: "stock_count_lines",
	StockCounts: "stock_counts",
	SumupTransactions: "sumup_transactions",
	TradeInLines: "trade_in_lines",
	TradeIns: "trade_ins",
	Users: "users",
	WantList: "want_list",
} as const
export type Collections = typeof Collections[keyof typeof Collections]

// Alias types for improved usability
export type IsoDateString = string
export type IsoAutoDateString = string & { readonly autodate: unique symbol }
export type RecordIdString = string
export type FileNameString = string & { readonly filename: unique symbol }
export type HTMLString = string

type ExpandType<T> = unknown extends T
	? T extends unknown
		? { expand?: unknown }
		: { expand: T }
	: { expand: T }

// System fields
export type BaseSystemFields<T = unknown> = {
	id: RecordIdString
	collectionId: string
	collectionName: Collections
} & ExpandType<T>

export type AuthSystemFields<T = unknown> = {
	email: string
	emailVisibility: boolean
	username: string
	verified: boolean
} & BaseSystemFields<T>

// Record types for each collection

export type AuthoriginsRecord = {
	collectionRef: string
	created: IsoAutoDateString
	fingerprint: string
	id: string
	recordRef: string
	updated: IsoAutoDateString
}

export type ExternalauthsRecord = {
	collectionRef: string
	created: IsoAutoDateString
	id: string
	provider: string
	providerId: string
	recordRef: string
	updated: IsoAutoDateString
}

export type MfasRecord = {
	collectionRef: string
	created: IsoAutoDateString
	id: string
	method: string
	recordRef: string
	updated: IsoAutoDateString
}

export type OtpsRecord = {
	collectionRef: string
	created: IsoAutoDateString
	id: string
	password: string
	recordRef: string
	sentTo?: string
	updated: IsoAutoDateString
}

export type SuperusersRecord = {
	created: IsoAutoDateString
	email: string
	emailVisibility?: boolean
	id: string
	password: string
	tokenKey: string
	updated: IsoAutoDateString
	verified?: boolean
}

export type AdapterStateRecord<Tvalue = unknown> = {
	created: IsoAutoDateString
	expires_at?: IsoDateString
	id: string
	key: string
	updated: IsoAutoDateString
	value?: null | Tvalue
}

export type AuditLogRecord<Tmeta = unknown> = {
	action?: string
	actor?: string
	collection?: string
	created: IsoAutoDateString
	id: string
	ip?: string
	meta?: null | Tmeta
	record?: string
	updated: IsoAutoDateString
}

export type CardSetsRecord<Texternal_ids = unknown> = {
	code: string
	created: IsoAutoDateString
	external_ids?: null | Texternal_ids
	game: RecordIdString
	id: string
	name: string
	release_date?: IsoDateString
	series?: string
	symbol?: FileNameString
	total?: number
	updated: IsoAutoDateString
}

export const CardsSourceOptions = {
	"api": "api",
	"manual": "manual",
} as const
export type CardsSourceOptions = typeof CardsSourceOptions[keyof typeof CardsSourceOptions]
export type CardsRecord<Texternal_ids = unknown, Tfinishes_available = unknown, Tprices = unknown> = {
	cardmarket_id?: string
	created: IsoAutoDateString
	external_ids?: null | Texternal_ids
	finishes_available?: null | Tfinishes_available
	game: RecordIdString
	id: string
	image_file?: FileNameString
	image_large?: string
	image_small?: string
	last_synced?: IsoDateString
	name: string
	number: string
	prices?: null | Tprices
	rarity?: string
	search_text?: string
	set: RecordIdString
	source?: CardsSourceOptions
	tcgplayer_id?: string
	type?: string
	updated: IsoAutoDateString
}

export const CashMovementsTypeOptions = {
	"float_in": "float_in",
	"payout": "payout",
	"cash_sale": "cash_sale",
	"refund": "refund",
	"bank_drop": "bank_drop",
	"adjustment": "adjustment",
} as const
export type CashMovementsTypeOptions = typeof CashMovementsTypeOptions[keyof typeof CashMovementsTypeOptions]
export type CashMovementsRecord = {
	amount?: number
	created: IsoAutoDateString
	id: string
	ref?: string
	session: RecordIdString
	staff?: RecordIdString
	type: CashMovementsTypeOptions
	updated: IsoAutoDateString
}

export type CashSessionsRecord = {
	closed_at?: IsoDateString
	closed_by?: RecordIdString
	counted?: number
	created: IsoAutoDateString
	expected?: number
	float?: number
	id: string
	notes?: string
	opened_at: IsoAutoDateString
	opened_by?: RecordIdString
	updated: IsoAutoDateString
	variance?: number
}

export type CountersRecord = {
	created: IsoAutoDateString
	id: string
	key: string
	updated: IsoAutoDateString
	value?: number
}

export const CreditLedgerReasonOptions = {
	"trade_in": "trade_in",
	"sale": "sale",
	"adjustment": "adjustment",
	"expiry": "expiry",
	"reward": "reward",
} as const
export type CreditLedgerReasonOptions = typeof CreditLedgerReasonOptions[keyof typeof CreditLedgerReasonOptions]
export type CreditLedgerRecord = {
	amount?: number
	balance_after?: number
	created: IsoAutoDateString
	customer: RecordIdString
	id: string
	reason: CreditLedgerReasonOptions
	ref?: string
	staff?: RecordIdString
	updated: IsoAutoDateString
}

export const CsvImportsTypeOptions = {
	"card_uploader": "card_uploader",
	"ebay_orders": "ebay_orders",
	"sumup_sales": "sumup_sales",
} as const
export type CsvImportsTypeOptions = typeof CsvImportsTypeOptions[keyof typeof CsvImportsTypeOptions]

export const CsvImportsStatusOptions = {
	"pending": "pending",
	"processing": "processing",
	"done": "done",
	"failed": "failed",
} as const
export type CsvImportsStatusOptions = typeof CsvImportsStatusOptions[keyof typeof CsvImportsStatusOptions]
export type CsvImportsRecord<Terrors = unknown, Tresolved_rows = unknown> = {
	created: IsoAutoDateString
	errors?: null | Terrors
	file?: FileNameString
	id: string
	resolved_rows?: null | Tresolved_rows
	rows_ok?: number
	rows_skipped?: number
	rows_total?: number
	staff?: RecordIdString
	status?: CsvImportsStatusOptions
	type: CsvImportsTypeOptions
	updated: IsoAutoDateString
}

export const CustomerPrivateFlagsOptions = {
	"no_cash": "no_cash",
	"watchlist": "watchlist",
	"under_18": "under_18",
} as const
export type CustomerPrivateFlagsOptions = typeof CustomerPrivateFlagsOptions[keyof typeof CustomerPrivateFlagsOptions]

export const CustomerPrivateIdStatusOptions = {
	"none": "none",
	"verified": "verified",
	"expired": "expired",
	"rejected": "rejected",
} as const
export type CustomerPrivateIdStatusOptions = typeof CustomerPrivateIdStatusOptions[keyof typeof CustomerPrivateIdStatusOptions]
export type CustomerPrivateRecord = {
	address?: string
	created: IsoAutoDateString
	credit_balance?: number
	customer: RecordIdString
	dob?: IsoDateString
	flags?: CustomerPrivateFlagsOptions[]
	id: string
	id_expiry?: IsoDateString
	id_ref_last4?: string
	id_status?: CustomerPrivateIdStatusOptions
	id_type?: string
	id_verified_at?: IsoDateString
	id_verified_by?: RecordIdString
	notes?: HTMLString
	points_balance?: number
	tier?: RecordIdString
	updated: IsoAutoDateString
}

export const CustomersSourceOptions = {
	"counter": "counter",
	"portal": "portal",
} as const
export type CustomersSourceOptions = typeof CustomersSourceOptions[keyof typeof CustomersSourceOptions]
export type CustomersRecord = {
	birthday_month?: number
	code?: string
	created: IsoAutoDateString
	email?: string
	emailVisibility?: boolean
	id: string
	marketing_consent?: boolean
	name: string
	password: string
	phone?: string
	qr_token?: string
	referred_by?: RecordIdString
	source?: CustomersSourceOptions
	tokenKey: string
	updated: IsoAutoDateString
	verified?: boolean
}

export type DailyStatsRecord<Tbuy_in_total_by_payout = unknown, Tsales_total_by_payment = unknown> = {
	buy_in_count?: number
	buy_in_total_by_payout?: null | Tbuy_in_total_by_payout
	cash_variance?: number
	created: IsoAutoDateString
	credit_issued?: number
	credit_redeemed?: number
	date: IsoDateString
	id: string
	items_in?: number
	items_out?: number
	new_customers?: number
	points_earned?: number
	points_redeemed?: number
	returning_customers?: number
	sales_count?: number
	sales_refunded?: number
	sales_total_by_payment?: null | Tsales_total_by_payment
	stock_value_cost?: number
	stock_value_market?: number
	updated: IsoAutoDateString
}

export type FxRatesRecord<Tquotes = unknown> = {
	base: string
	created: IsoAutoDateString
	date?: string
	fetched_at: IsoDateString
	id: string
	quotes?: null | Tquotes
	updated: IsoAutoDateString
}

export type GamesRecord = {
	adapter?: string
	created: IsoAutoDateString
	enabled?: boolean
	id: string
	key: string
	name: string
	updated: IsoAutoDateString
}

export type IdDocumentsRecord = {
	created: IsoAutoDateString
	customer: RecordIdString
	expires_at?: IsoDateString
	id: string
	mime?: string
	photo?: FileNameString
	taken_at?: IsoDateString
	taken_by?: RecordIdString
	updated: IsoAutoDateString
}

export const ItemsKindOptions = {
	"single": "single",
	"graded": "graded",
	"retro": "retro",
	"sealed": "sealed",
	"accessory": "accessory",
	"other": "other",
} as const
export type ItemsKindOptions = typeof ItemsKindOptions[keyof typeof ItemsKindOptions]

export const ItemsConditionOptions = {
	"NM": "NM",
	"LP": "LP",
	"MP": "MP",
	"HP": "HP",
	"DMG": "DMG",
} as const
export type ItemsConditionOptions = typeof ItemsConditionOptions[keyof typeof ItemsConditionOptions]

export const ItemsCompletenessOptions = {
	"loose": "loose",
	"boxed": "boxed",
	"cib": "cib",
} as const
export type ItemsCompletenessOptions = typeof ItemsCompletenessOptions[keyof typeof ItemsCompletenessOptions]

export const ItemsCosmeticGradeOptions = {
	"A": "A",
	"B": "B",
	"C": "C",
} as const
export type ItemsCosmeticGradeOptions = typeof ItemsCosmeticGradeOptions[keyof typeof ItemsCosmeticGradeOptions]

export const ItemsRegionOptions = {
	"PAL": "PAL",
	"NTSC": "NTSC",
	"JP": "JP",
} as const
export type ItemsRegionOptions = typeof ItemsRegionOptions[keyof typeof ItemsRegionOptions]

export const ItemsTaxSchemeOptions = {
	"margin": "margin",
	"standard": "standard",
} as const
export type ItemsTaxSchemeOptions = typeof ItemsTaxSchemeOptions[keyof typeof ItemsTaxSchemeOptions]

export const ItemsStatusOptions = {
	"in_stock": "in_stock",
	"reserved": "reserved",
	"listed_ebay": "listed_ebay",
	"sold": "sold",
	"returned": "returned",
	"written_off": "written_off",
} as const
export type ItemsStatusOptions = typeof ItemsStatusOptions[keyof typeof ItemsStatusOptions]

export const ItemsSourceOptions = {
	"trade_in": "trade_in",
	"supplier": "supplier",
	"opening_stock": "opening_stock",
} as const
export type ItemsSourceOptions = typeof ItemsSourceOptions[keyof typeof ItemsSourceOptions]
export type ItemsRecord = {
	acquired_at?: IsoDateString
	card?: RecordIdString
	cert_no?: string
	completeness?: ItemsCompletenessOptions
	condition?: ItemsConditionOptions
	cosmetic_grade?: ItemsCosmeticGradeOptions
	cost?: number
	created: IsoAutoDateString
	created_by?: RecordIdString
	ean?: string
	ebay_listing_id?: string
	ebay_sku?: string
	finish?: string
	game: RecordIdString
	grade?: string
	grade_company?: string
	id: string
	kind: ItemsKindOptions
	label_printed_at?: IsoDateString
	language?: string
	listed_at?: IsoDateString
	location?: RecordIdString
	market_at_intake?: number
	notes?: string
	number?: string
	photos?: FileNameString[]
	price?: number
	qty?: number
	region?: ItemsRegionOptions
	reserved_for?: RecordIdString
	reserved_until?: IsoDateString
	retro_title?: RecordIdString
	set_code?: string
	sku: string
	source?: ItemsSourceOptions
	status?: ItemsStatusOptions
	sumup_synced_at?: IsoDateString
	supplier_ref?: string
	tax_scheme?: ItemsTaxSchemeOptions
	tested?: boolean
	title?: string
	trade_in_line?: RecordIdString
	updated: IsoAutoDateString
}

export const LabelJobsStatusOptions = {
	"queued": "queued",
	"printed": "printed",
	"cancelled": "cancelled",
} as const
export type LabelJobsStatusOptions = typeof LabelJobsStatusOptions[keyof typeof LabelJobsStatusOptions]
export type LabelJobsRecord = {
	copies?: number
	created: IsoAutoDateString
	id: string
	item: RecordIdString
	printed_at?: IsoDateString
	requested_by?: RecordIdString
	status?: LabelJobsStatusOptions
	template: RecordIdString
	updated: IsoAutoDateString
}

export type LabelTemplatesRecord = {
	active?: boolean
	created: IsoAutoDateString
	dpi?: number
	height_mm: number
	id: string
	key: string
	name: string
	updated: IsoAutoDateString
	width_mm: number
}

export type LocationsRecord = {
	created: IsoAutoDateString
	id: string
	name: string
	sort?: number
	type?: string
	updated: IsoAutoDateString
}

export type LoyaltyProgrammeRecord = {
	created: IsoAutoDateString
	earn_on_trade_in_credit?: number
	earn_per_pound_sales?: number
	enabled?: boolean
	expiry_months_inactive?: number
	id: string
	max_points_share_of_sale?: number
	min_redeem_points?: number
	name?: string
	points_name?: string
	points_per_pound_redemption?: number
	referral_bonus_referee?: number
	referral_bonus_referrer?: number
	terms?: HTMLString
	tier_window_months?: number
	updated: IsoAutoDateString
	welcome_bonus?: number
}

export const LoyaltyRewardsTypeOptions = {
	"money_off": "money_off",
	"store_credit": "store_credit",
	"free_item": "free_item",
	"event_entry": "event_entry",
	"custom": "custom",
} as const
export type LoyaltyRewardsTypeOptions = typeof LoyaltyRewardsTypeOptions[keyof typeof LoyaltyRewardsTypeOptions]
export type LoyaltyRewardsRecord = {
	active?: boolean
	cost_points?: number
	created: IsoAutoDateString
	description?: HTMLString
	ends_at?: IsoDateString
	id: string
	image?: FileNameString
	name: string
	per_customer_limit?: number
	starts_at?: IsoDateString
	stock_limit?: number
	type: LoyaltyRewardsTypeOptions
	updated: IsoAutoDateString
	value?: number
}

export const LoyaltyRulesTypeOptions = {
	"multiplier": "multiplier",
	"fixed_bonus": "fixed_bonus",
	"first_purchase": "first_purchase",
	"birthday_month": "birthday_month",
	"trade_in_credit_bonus": "trade_in_credit_bonus",
	"event_checkin": "event_checkin",
	"day_of_week": "day_of_week",
} as const
export type LoyaltyRulesTypeOptions = typeof LoyaltyRulesTypeOptions[keyof typeof LoyaltyRulesTypeOptions]
export type LoyaltyRulesRecord<Tconditions = unknown> = {
	active?: boolean
	conditions?: null | Tconditions
	created: IsoAutoDateString
	ends_at?: IsoDateString
	id: string
	name: string
	priority?: number
	starts_at?: IsoDateString
	type: LoyaltyRulesTypeOptions
	updated: IsoAutoDateString
	value?: number
}

export type LoyaltyTiersRecord<Tperks = unknown> = {
	colour_token?: string
	created: IsoAutoDateString
	id: string
	name: string
	paid_plan?: boolean
	perks?: null | Tperks
	sort?: number
	threshold_points?: number
	updated: IsoAutoDateString
}

export const MembershipsStatusOptions = {
	"active": "active",
	"lapsed": "lapsed",
	"cancelled": "cancelled",
} as const
export type MembershipsStatusOptions = typeof MembershipsStatusOptions[keyof typeof MembershipsStatusOptions]
export type MembershipsRecord = {
	created: IsoAutoDateString
	customer: RecordIdString
	id: string
	payment_note?: string
	price?: number
	renews_at?: IsoDateString
	started_at?: IsoDateString
	status?: MembershipsStatusOptions
	tier: RecordIdString
	updated: IsoAutoDateString
}

export type NotesRecord = {
	author?: RecordIdString
	body?: HTMLString
	created: IsoAutoDateString
	id: string
	target_collection: string
	target_record: string
	updated: IsoAutoDateString
}

export type NotificationsRecord = {
	body?: string
	created: IsoAutoDateString
	customer?: RecordIdString
	id: string
	link?: string
	pushed_at?: IsoDateString
	read_at?: IsoDateString
	staff?: RecordIdString
	title?: string
	type?: string
	updated: IsoAutoDateString
}

export type PerkUsageRecord = {
	created: IsoAutoDateString
	customer: RecordIdString
	id: string
	period: string
	perk_type: string
	updated: IsoAutoDateString
	used_count?: number
}

export const PlatformsImageFinishOptions = {
	"shadow": "shadow",
	"edge": "edge",
} as const
export type PlatformsImageFinishOptions = typeof PlatformsImageFinishOptions[keyof typeof PlatformsImageFinishOptions]
export type PlatformsRecord = {
	aspect_h: number
	aspect_w: number
	created: IsoAutoDateString
	id: string
	image_finish: PlatformsImageFinishOptions
	key: string
	name: string
	region_note?: string
	sort?: number
	updated: IsoAutoDateString
}

export const PointsLedgerReasonOptions = {
	"earn_sale": "earn_sale",
	"earn_trade_in": "earn_trade_in",
	"rule_bonus": "rule_bonus",
	"welcome": "welcome",
	"referral": "referral",
	"redeem": "redeem",
	"adjust": "adjust",
	"expire": "expire",
	"refund_reverse": "refund_reverse",
} as const
export type PointsLedgerReasonOptions = typeof PointsLedgerReasonOptions[keyof typeof PointsLedgerReasonOptions]
export type PointsLedgerRecord = {
	balance_after?: number
	created: IsoAutoDateString
	customer: RecordIdString
	delta?: number
	id: string
	reason: PointsLedgerReasonOptions
	ref?: string
	rule?: RecordIdString
	staff?: RecordIdString
	updated: IsoAutoDateString
}

export const PriceSnapshotsSourceOptions = {
	"uk_sold_manual": "uk_sold_manual",
	"ebay_uk_asking": "ebay_uk_asking",
	"cardmarket": "cardmarket",
	"tcgplayer": "tcgplayer",
	"pricecharting_pal": "pricecharting_pal",
	"pricecharting_ntsc": "pricecharting_ntsc",
} as const
export type PriceSnapshotsSourceOptions = typeof PriceSnapshotsSourceOptions[keyof typeof PriceSnapshotsSourceOptions]

export const PriceSnapshotsNativeCurrencyOptions = {
	"GBP": "GBP",
	"EUR": "EUR",
	"USD": "USD",
} as const
export type PriceSnapshotsNativeCurrencyOptions = typeof PriceSnapshotsNativeCurrencyOptions[keyof typeof PriceSnapshotsNativeCurrencyOptions]
export type PriceSnapshotsRecord = {
	card?: RecordIdString
	created: IsoAutoDateString
	evidence_url?: string
	fetched_at: IsoDateString
	finish?: string
	fx_date?: IsoDateString
	fx_rate?: number
	gbp_market?: number
	id: string
	native_currency: PriceSnapshotsNativeCurrencyOptions
	native_low?: number
	native_market?: number
	native_mid?: number
	native_trend?: number
	retro_title?: RecordIdString
	source: PriceSnapshotsSourceOptions
	updated: IsoAutoDateString
}

export const PricingRulesKindOptions = {
	"single": "single",
	"graded": "graded",
	"retro": "retro",
	"sealed": "sealed",
	"accessory": "accessory",
	"other": "other",
} as const
export type PricingRulesKindOptions = typeof PricingRulesKindOptions[keyof typeof PricingRulesKindOptions]
export type PricingRulesRecord = {
	active?: boolean
	band_max?: number
	band_min?: number
	cash_pct?: number
	condition?: string
	created: IsoAutoDateString
	credit_pct?: number
	finish?: string
	game?: RecordIdString
	id: string
	kind?: PricingRulesKindOptions
	priority?: number
	rarity?: string
	rounding?: number
	updated: IsoAutoDateString
}

export type PushSubscriptionsRecord<Tkeys = unknown> = {
	created: IsoAutoDateString
	customer?: RecordIdString
	endpoint: string
	id: string
	keys?: null | Tkeys
	staff?: RecordIdString
	updated: IsoAutoDateString
}

export const QuotesStatusOptions = {
	"submitted": "submitted",
	"reviewing": "reviewing",
	"offered": "offered",
	"accepted": "accepted",
	"declined": "declined",
	"expired": "expired",
	"received": "received",
	"completed": "completed",
} as const
export type QuotesStatusOptions = typeof QuotesStatusOptions[keyof typeof QuotesStatusOptions]

export const QuotesDropOffOptions = {
	"in_store": "in_store",
	"post": "post",
} as const
export type QuotesDropOffOptions = typeof QuotesDropOffOptions[keyof typeof QuotesDropOffOptions]
export type QuotesRecord<Tlines = unknown> = {
	created: IsoAutoDateString
	customer: RecordIdString
	customer_reply?: string
	drop_off?: QuotesDropOffOptions
	id: string
	lines?: null | Tlines
	message?: string
	offer_expires_at?: IsoDateString
	offer_total?: number
	photos?: FileNameString[]
	status?: QuotesStatusOptions
	updated: IsoAutoDateString
}

export const ReferralsStatusOptions = {
	"pending": "pending",
	"earned": "earned",
} as const
export type ReferralsStatusOptions = typeof ReferralsStatusOptions[keyof typeof ReferralsStatusOptions]
export type ReferralsRecord = {
	created: IsoAutoDateString
	earned_at?: IsoDateString
	id: string
	referee: RecordIdString
	referrer: RecordIdString
	status?: ReferralsStatusOptions
	updated: IsoAutoDateString
}

export const RetroTitlesRegionOptions = {
	"PAL": "PAL",
	"NTSC": "NTSC",
	"JP": "JP",
} as const
export type RetroTitlesRegionOptions = typeof RetroTitlesRegionOptions[keyof typeof RetroTitlesRegionOptions]
export type RetroTitlesRecord<Texternal_ids = unknown> = {
	cover?: FileNameString
	created: IsoAutoDateString
	external_ids?: null | Texternal_ids
	id: string
	name: string
	platform: RecordIdString
	region?: RetroTitlesRegionOptions
	updated: IsoAutoDateString
}

export const RewardRedemptionsStatusOptions = {
	"issued": "issued",
	"used": "used",
	"expired": "expired",
	"cancelled": "cancelled",
} as const
export type RewardRedemptionsStatusOptions = typeof RewardRedemptionsStatusOptions[keyof typeof RewardRedemptionsStatusOptions]
export type RewardRedemptionsRecord = {
	code?: string
	created: IsoAutoDateString
	customer: RecordIdString
	expires_at?: IsoDateString
	id: string
	number: string
	points_spent?: number
	reward: RecordIdString
	status?: RewardRedemptionsStatusOptions
	updated: IsoAutoDateString
	used_by?: RecordIdString
	used_in_sale?: RecordIdString
}

export const SaleLinesTaxSchemeOptions = {
	"margin": "margin",
	"standard": "standard",
} as const
export type SaleLinesTaxSchemeOptions = typeof SaleLinesTaxSchemeOptions[keyof typeof SaleLinesTaxSchemeOptions]

export const SaleLinesStatusOptions = {
	"sold": "sold",
	"refunded": "refunded",
} as const
export type SaleLinesStatusOptions = typeof SaleLinesStatusOptions[keyof typeof SaleLinesStatusOptions]
export type SaleLinesRecord = {
	created: IsoAutoDateString
	discount?: number
	id: string
	item: RecordIdString
	qty?: number
	refunded_qty?: number
	sale: RecordIdString
	status?: SaleLinesStatusOptions
	tax_scheme?: SaleLinesTaxSchemeOptions
	unit_price?: number
	updated: IsoAutoDateString
	vat_rate?: number
}

export const SalesDiscountSourceOptions = {
	"manual": "manual",
	"tier_perk": "tier_perk",
	"reward": "reward",
} as const
export type SalesDiscountSourceOptions = typeof SalesDiscountSourceOptions[keyof typeof SalesDiscountSourceOptions]

export const SalesPaymentOptions = {
	"sumup_card": "sumup_card",
	"cash": "cash",
	"store_credit": "store_credit",
	"points": "points",
	"mixed": "mixed",
} as const
export type SalesPaymentOptions = typeof SalesPaymentOptions[keyof typeof SalesPaymentOptions]

export const SalesStatusOptions = {
	"complete": "complete",
	"refunded": "refunded",
	"part_refunded": "part_refunded",
} as const
export type SalesStatusOptions = typeof SalesStatusOptions[keyof typeof SalesStatusOptions]

export const SalesChannelOptions = {
	"counter": "counter",
	"ebay": "ebay",
} as const
export type SalesChannelOptions = typeof SalesChannelOptions[keyof typeof SalesChannelOptions]
export type SalesRecord<Tpayment_split = unknown> = {
	cash_session?: RecordIdString
	channel?: SalesChannelOptions
	client_id?: string
	created: IsoAutoDateString
	customer?: RecordIdString
	discount?: number
	discount_source?: SalesDiscountSourceOptions
	external_ref?: string
	id: string
	number: string
	occurred_at?: IsoDateString
	payment?: SalesPaymentOptions
	payment_split?: null | Tpayment_split
	points_earned?: number
	refunded_total?: number
	staff?: RecordIdString
	status?: SalesStatusOptions
	subtotal?: number
	sumup_ref?: string
	total?: number
	updated: IsoAutoDateString
}

export const SavedReportsScheduleOptions = {
	"none": "none",
	"weekly": "weekly",
	"monthly": "monthly",
} as const
export type SavedReportsScheduleOptions = typeof SavedReportsScheduleOptions[keyof typeof SavedReportsScheduleOptions]
export type SavedReportsRecord<Tfilters = unknown, Trecipients = unknown> = {
	created: IsoAutoDateString
	filters?: null | Tfilters
	id: string
	name?: string
	owner?: RecordIdString
	recipients?: null | Trecipients
	report_key: string
	schedule?: SavedReportsScheduleOptions
	updated: IsoAutoDateString
}

export const SettingsSellRoundingOptions = {
	"49_99": "49_99",
} as const
export type SettingsSellRoundingOptions = typeof SettingsSellRoundingOptions[keyof typeof SettingsSellRoundingOptions]

export const SettingsEmailProviderOptions = {
	"resend": "resend",
	"postmark": "postmark",
	"brevo": "brevo",
	"none": "none",
} as const
export type SettingsEmailProviderOptions = typeof SettingsEmailProviderOptions[keyof typeof SettingsEmailProviderOptions]
export type SettingsRecord<Tapi_keys = unknown, Tcondition_multipliers = unknown, Temail = unknown, Timport_mappings = unknown, Tmarkup_bands = unknown, Toffer = unknown, Tretro_source_priority = unknown, Tsource_priority = unknown, Tsumup = unknown> = {
	api_keys?: null | Tapi_keys
	bulk_rate_pct?: number
	cash_cap?: number
	cash_variance_alert?: number
	condition_multipliers?: null | Tcondition_multipliers
	created: IsoAutoDateString
	default_intake_location?: RecordIdString
	email?: null | Temail
	email_api_key?: string
	email_provider?: SettingsEmailProviderOptions
	id: string
	id_photo_retention_months?: number
	import_mappings?: null | Timport_mappings
	label_default_template?: RecordIdString
	markup_bands?: null | Tmarkup_bands
	min_single_offer?: number
	offer?: null | Toffer
	push_vapid_private_key?: string
	push_vapid_public_key?: string
	quote_expiry_days?: number
	receipt_terms?: string
	retro_source_priority?: null | Tretro_source_priority
	sell_rounding?: SettingsSellRoundingOptions
	shop_address?: string
	shop_email?: string
	shop_name?: string
	shop_phone?: string
	shop_postcode?: string
	shop_town?: string
	source_priority?: null | Tsource_priority
	sumup?: null | Tsumup
	updated: IsoAutoDateString
	vat_registered?: boolean
}

export const StaffRoleOptions = {
	"admin": "admin",
	"staff": "staff",
} as const
export type StaffRoleOptions = typeof StaffRoleOptions[keyof typeof StaffRoleOptions]
export type StaffRecord = {
	active?: boolean
	created: IsoAutoDateString
	email: string
	emailVisibility?: boolean
	id: string
	name: string
	password: string
	pin_hash?: string
	role: StaffRoleOptions
	tokenKey: string
	updated: IsoAutoDateString
	verified?: boolean
}

export type StockCountLinesRecord = {
	created: IsoAutoDateString
	expected_qty?: number
	id: string
	item: RecordIdString
	scanned_qty?: number
	stock_count: RecordIdString
	updated: IsoAutoDateString
	variance?: number
}

export const StockCountsStatusOptions = {
	"open": "open",
	"closed": "closed",
} as const
export type StockCountsStatusOptions = typeof StockCountsStatusOptions[keyof typeof StockCountsStatusOptions]
export type StockCountsRecord = {
	closed_at?: IsoDateString
	closed_by?: RecordIdString
	created: IsoAutoDateString
	id: string
	location?: RecordIdString
	started_at: IsoAutoDateString
	started_by?: RecordIdString
	status?: StockCountsStatusOptions
	updated: IsoAutoDateString
}

export type SumupTransactionsRecord<Tproducts = unknown> = {
	amount?: number
	created: IsoAutoDateString
	fetched_at?: IsoDateString
	id: string
	matched_sale?: RecordIdString
	payment_type?: string
	products?: null | Tproducts
	status?: string
	sumup_id: string
	timestamp?: IsoDateString
	transaction_code?: string
	updated: IsoAutoDateString
}

export const TradeInLinesConditionOptions = {
	"NM": "NM",
	"LP": "LP",
	"MP": "MP",
	"HP": "HP",
	"DMG": "DMG",
} as const
export type TradeInLinesConditionOptions = typeof TradeInLinesConditionOptions[keyof typeof TradeInLinesConditionOptions]

export const TradeInLinesMarketCurrencyOptions = {
	"GBP": "GBP",
	"EUR": "EUR",
	"USD": "USD",
} as const
export type TradeInLinesMarketCurrencyOptions = typeof TradeInLinesMarketCurrencyOptions[keyof typeof TradeInLinesMarketCurrencyOptions]

export const TradeInLinesKindOptions = {
	"single": "single",
	"graded": "graded",
	"retro": "retro",
	"sealed": "sealed",
	"accessory": "accessory",
	"other": "other",
} as const
export type TradeInLinesKindOptions = typeof TradeInLinesKindOptions[keyof typeof TradeInLinesKindOptions]

export const TradeInLinesCompletenessOptions = {
	"loose": "loose",
	"boxed": "boxed",
	"cib": "cib",
} as const
export type TradeInLinesCompletenessOptions = typeof TradeInLinesCompletenessOptions[keyof typeof TradeInLinesCompletenessOptions]

export const TradeInLinesCosmeticGradeOptions = {
	"A": "A",
	"B": "B",
	"C": "C",
} as const
export type TradeInLinesCosmeticGradeOptions = typeof TradeInLinesCosmeticGradeOptions[keyof typeof TradeInLinesCosmeticGradeOptions]
export type TradeInLinesRecord = {
	accepted?: boolean
	card?: RecordIdString
	completeness?: TradeInLinesCompletenessOptions
	condition?: TradeInLinesConditionOptions
	cosmetic_grade?: TradeInLinesCosmeticGradeOptions
	created: IsoAutoDateString
	finish?: string
	free_text_title?: string
	fx_rate?: number
	game?: RecordIdString
	id: string
	item?: RecordIdString
	kind?: TradeInLinesKindOptions
	market_currency?: TradeInLinesMarketCurrencyOptions
	market_price?: number
	market_source?: string
	offer_pct?: number
	offer_price?: number
	override_cash?: number
	override_credit?: number
	override_reason?: string
	qty?: number
	retro_title?: RecordIdString
	trade_in: RecordIdString
	updated: IsoAutoDateString
}

export const TradeInsChannelOptions = {
	"counter": "counter",
	"remote": "remote",
} as const
export type TradeInsChannelOptions = typeof TradeInsChannelOptions[keyof typeof TradeInsChannelOptions]

export const TradeInsStatusOptions = {
	"draft": "draft",
	"offered": "offered",
	"accepted": "accepted",
	"completed": "completed",
	"declined": "declined",
	"cancelled": "cancelled",
} as const
export type TradeInsStatusOptions = typeof TradeInsStatusOptions[keyof typeof TradeInsStatusOptions]

export const TradeInsPayoutTypeOptions = {
	"cash": "cash",
	"credit": "credit",
	"mixed": "mixed",
} as const
export type TradeInsPayoutTypeOptions = typeof TradeInsPayoutTypeOptions[keyof typeof TradeInsPayoutTypeOptions]
export type TradeInsRecord = {
	cash_session?: RecordIdString
	channel?: TradeInsChannelOptions
	completed_at?: IsoDateString
	created: IsoAutoDateString
	customer: RecordIdString
	id: string
	id_checked?: boolean
	id_checked_by?: RecordIdString
	id_document?: RecordIdString
	number?: string
	payout_cash?: number
	payout_credit?: number
	payout_type?: TradeInsPayoutTypeOptions
	quote?: RecordIdString
	seller_address?: string
	seller_id_expiry?: IsoDateString
	seller_id_last4?: string
	seller_id_type?: string
	seller_name?: string
	signature?: FileNameString
	staff?: RecordIdString
	status?: TradeInsStatusOptions
	total_market?: number
	total_offer?: number
	updated: IsoAutoDateString
}

export type UsersRecord = {
	avatar?: FileNameString
	created: IsoAutoDateString
	email: string
	emailVisibility?: boolean
	id: string
	name?: string
	password: string
	tokenKey: string
	updated: IsoAutoDateString
	verified?: boolean
}

export const WantListStatusOptions = {
	"open": "open",
	"matched": "matched",
	"fulfilled": "fulfilled",
	"closed": "closed",
} as const
export type WantListStatusOptions = typeof WantListStatusOptions[keyof typeof WantListStatusOptions]
export type WantListRecord = {
	card?: RecordIdString
	created: IsoAutoDateString
	customer: RecordIdString
	free_text?: string
	id: string
	matched_item?: RecordIdString
	max_price?: number
	notified_at?: IsoDateString
	status?: WantListStatusOptions
	updated: IsoAutoDateString
}

// Response types include system fields and match responses from the PocketBase API
export type AuthoriginsResponse<Texpand = unknown> = Required<AuthoriginsRecord> & BaseSystemFields<Texpand>
export type ExternalauthsResponse<Texpand = unknown> = Required<ExternalauthsRecord> & BaseSystemFields<Texpand>
export type MfasResponse<Texpand = unknown> = Required<MfasRecord> & BaseSystemFields<Texpand>
export type OtpsResponse<Texpand = unknown> = Required<OtpsRecord> & BaseSystemFields<Texpand>
export type SuperusersResponse<Texpand = unknown> = Required<SuperusersRecord> & AuthSystemFields<Texpand>
export type AdapterStateResponse<Tvalue = unknown, Texpand = unknown> = Required<AdapterStateRecord<Tvalue>> & BaseSystemFields<Texpand>
export type AuditLogResponse<Tmeta = unknown, Texpand = unknown> = Required<AuditLogRecord<Tmeta>> & BaseSystemFields<Texpand>
export type CardSetsResponse<Texternal_ids = unknown, Texpand = unknown> = Required<CardSetsRecord<Texternal_ids>> & BaseSystemFields<Texpand>
export type CardsResponse<Texternal_ids = unknown, Tfinishes_available = unknown, Tprices = unknown, Texpand = unknown> = Required<CardsRecord<Texternal_ids, Tfinishes_available, Tprices>> & BaseSystemFields<Texpand>
export type CashMovementsResponse<Texpand = unknown> = Required<CashMovementsRecord> & BaseSystemFields<Texpand>
export type CashSessionsResponse<Texpand = unknown> = Required<CashSessionsRecord> & BaseSystemFields<Texpand>
export type CountersResponse<Texpand = unknown> = Required<CountersRecord> & BaseSystemFields<Texpand>
export type CreditLedgerResponse<Texpand = unknown> = Required<CreditLedgerRecord> & BaseSystemFields<Texpand>
export type CsvImportsResponse<Terrors = unknown, Tresolved_rows = unknown, Texpand = unknown> = Required<CsvImportsRecord<Terrors, Tresolved_rows>> & BaseSystemFields<Texpand>
export type CustomerPrivateResponse<Texpand = unknown> = Required<CustomerPrivateRecord> & BaseSystemFields<Texpand>
export type CustomersResponse<Texpand = unknown> = Required<CustomersRecord> & AuthSystemFields<Texpand>
export type DailyStatsResponse<Tbuy_in_total_by_payout = unknown, Tsales_total_by_payment = unknown, Texpand = unknown> = Required<DailyStatsRecord<Tbuy_in_total_by_payout, Tsales_total_by_payment>> & BaseSystemFields<Texpand>
export type FxRatesResponse<Tquotes = unknown, Texpand = unknown> = Required<FxRatesRecord<Tquotes>> & BaseSystemFields<Texpand>
export type GamesResponse<Texpand = unknown> = Required<GamesRecord> & BaseSystemFields<Texpand>
export type IdDocumentsResponse<Texpand = unknown> = Required<IdDocumentsRecord> & BaseSystemFields<Texpand>
export type ItemsResponse<Texpand = unknown> = Required<ItemsRecord> & BaseSystemFields<Texpand>
export type LabelJobsResponse<Texpand = unknown> = Required<LabelJobsRecord> & BaseSystemFields<Texpand>
export type LabelTemplatesResponse<Texpand = unknown> = Required<LabelTemplatesRecord> & BaseSystemFields<Texpand>
export type LocationsResponse<Texpand = unknown> = Required<LocationsRecord> & BaseSystemFields<Texpand>
export type LoyaltyProgrammeResponse<Texpand = unknown> = Required<LoyaltyProgrammeRecord> & BaseSystemFields<Texpand>
export type LoyaltyRewardsResponse<Texpand = unknown> = Required<LoyaltyRewardsRecord> & BaseSystemFields<Texpand>
export type LoyaltyRulesResponse<Tconditions = unknown, Texpand = unknown> = Required<LoyaltyRulesRecord<Tconditions>> & BaseSystemFields<Texpand>
export type LoyaltyTiersResponse<Tperks = unknown, Texpand = unknown> = Required<LoyaltyTiersRecord<Tperks>> & BaseSystemFields<Texpand>
export type MembershipsResponse<Texpand = unknown> = Required<MembershipsRecord> & BaseSystemFields<Texpand>
export type NotesResponse<Texpand = unknown> = Required<NotesRecord> & BaseSystemFields<Texpand>
export type NotificationsResponse<Texpand = unknown> = Required<NotificationsRecord> & BaseSystemFields<Texpand>
export type PerkUsageResponse<Texpand = unknown> = Required<PerkUsageRecord> & BaseSystemFields<Texpand>
export type PlatformsResponse<Texpand = unknown> = Required<PlatformsRecord> & BaseSystemFields<Texpand>
export type PointsLedgerResponse<Texpand = unknown> = Required<PointsLedgerRecord> & BaseSystemFields<Texpand>
export type PriceSnapshotsResponse<Texpand = unknown> = Required<PriceSnapshotsRecord> & BaseSystemFields<Texpand>
export type PricingRulesResponse<Texpand = unknown> = Required<PricingRulesRecord> & BaseSystemFields<Texpand>
export type PushSubscriptionsResponse<Tkeys = unknown, Texpand = unknown> = Required<PushSubscriptionsRecord<Tkeys>> & BaseSystemFields<Texpand>
export type QuotesResponse<Tlines = unknown, Texpand = unknown> = Required<QuotesRecord<Tlines>> & BaseSystemFields<Texpand>
export type ReferralsResponse<Texpand = unknown> = Required<ReferralsRecord> & BaseSystemFields<Texpand>
export type RetroTitlesResponse<Texternal_ids = unknown, Texpand = unknown> = Required<RetroTitlesRecord<Texternal_ids>> & BaseSystemFields<Texpand>
export type RewardRedemptionsResponse<Texpand = unknown> = Required<RewardRedemptionsRecord> & BaseSystemFields<Texpand>
export type SaleLinesResponse<Texpand = unknown> = Required<SaleLinesRecord> & BaseSystemFields<Texpand>
export type SalesResponse<Tpayment_split = unknown, Texpand = unknown> = Required<SalesRecord<Tpayment_split>> & BaseSystemFields<Texpand>
export type SavedReportsResponse<Tfilters = unknown, Trecipients = unknown, Texpand = unknown> = Required<SavedReportsRecord<Tfilters, Trecipients>> & BaseSystemFields<Texpand>
export type SettingsResponse<Tapi_keys = unknown, Tcondition_multipliers = unknown, Temail = unknown, Timport_mappings = unknown, Tmarkup_bands = unknown, Toffer = unknown, Tretro_source_priority = unknown, Tsource_priority = unknown, Tsumup = unknown, Texpand = unknown> = Required<SettingsRecord<Tapi_keys, Tcondition_multipliers, Temail, Timport_mappings, Tmarkup_bands, Toffer, Tretro_source_priority, Tsource_priority, Tsumup>> & BaseSystemFields<Texpand>
export type StaffResponse<Texpand = unknown> = Required<StaffRecord> & AuthSystemFields<Texpand>
export type StockCountLinesResponse<Texpand = unknown> = Required<StockCountLinesRecord> & BaseSystemFields<Texpand>
export type StockCountsResponse<Texpand = unknown> = Required<StockCountsRecord> & BaseSystemFields<Texpand>
export type SumupTransactionsResponse<Tproducts = unknown, Texpand = unknown> = Required<SumupTransactionsRecord<Tproducts>> & BaseSystemFields<Texpand>
export type TradeInLinesResponse<Texpand = unknown> = Required<TradeInLinesRecord> & BaseSystemFields<Texpand>
export type TradeInsResponse<Texpand = unknown> = Required<TradeInsRecord> & BaseSystemFields<Texpand>
export type UsersResponse<Texpand = unknown> = Required<UsersRecord> & AuthSystemFields<Texpand>
export type WantListResponse<Texpand = unknown> = Required<WantListRecord> & BaseSystemFields<Texpand>

// Types containing all Records and Responses, useful for creating typing helper functions

export type CollectionRecords = {
	_authOrigins: AuthoriginsRecord
	_externalAuths: ExternalauthsRecord
	_mfas: MfasRecord
	_otps: OtpsRecord
	_superusers: SuperusersRecord
	adapter_state: AdapterStateRecord
	audit_log: AuditLogRecord
	card_sets: CardSetsRecord
	cards: CardsRecord
	cash_movements: CashMovementsRecord
	cash_sessions: CashSessionsRecord
	counters: CountersRecord
	credit_ledger: CreditLedgerRecord
	csv_imports: CsvImportsRecord
	customer_private: CustomerPrivateRecord
	customers: CustomersRecord
	daily_stats: DailyStatsRecord
	fx_rates: FxRatesRecord
	games: GamesRecord
	id_documents: IdDocumentsRecord
	items: ItemsRecord
	label_jobs: LabelJobsRecord
	label_templates: LabelTemplatesRecord
	locations: LocationsRecord
	loyalty_programme: LoyaltyProgrammeRecord
	loyalty_rewards: LoyaltyRewardsRecord
	loyalty_rules: LoyaltyRulesRecord
	loyalty_tiers: LoyaltyTiersRecord
	memberships: MembershipsRecord
	notes: NotesRecord
	notifications: NotificationsRecord
	perk_usage: PerkUsageRecord
	platforms: PlatformsRecord
	points_ledger: PointsLedgerRecord
	price_snapshots: PriceSnapshotsRecord
	pricing_rules: PricingRulesRecord
	push_subscriptions: PushSubscriptionsRecord
	quotes: QuotesRecord
	referrals: ReferralsRecord
	retro_titles: RetroTitlesRecord
	reward_redemptions: RewardRedemptionsRecord
	sale_lines: SaleLinesRecord
	sales: SalesRecord
	saved_reports: SavedReportsRecord
	settings: SettingsRecord
	staff: StaffRecord
	stock_count_lines: StockCountLinesRecord
	stock_counts: StockCountsRecord
	sumup_transactions: SumupTransactionsRecord
	trade_in_lines: TradeInLinesRecord
	trade_ins: TradeInsRecord
	users: UsersRecord
	want_list: WantListRecord
}

export type CollectionResponses = {
	_authOrigins: AuthoriginsResponse
	_externalAuths: ExternalauthsResponse
	_mfas: MfasResponse
	_otps: OtpsResponse
	_superusers: SuperusersResponse
	adapter_state: AdapterStateResponse
	audit_log: AuditLogResponse
	card_sets: CardSetsResponse
	cards: CardsResponse
	cash_movements: CashMovementsResponse
	cash_sessions: CashSessionsResponse
	counters: CountersResponse
	credit_ledger: CreditLedgerResponse
	csv_imports: CsvImportsResponse
	customer_private: CustomerPrivateResponse
	customers: CustomersResponse
	daily_stats: DailyStatsResponse
	fx_rates: FxRatesResponse
	games: GamesResponse
	id_documents: IdDocumentsResponse
	items: ItemsResponse
	label_jobs: LabelJobsResponse
	label_templates: LabelTemplatesResponse
	locations: LocationsResponse
	loyalty_programme: LoyaltyProgrammeResponse
	loyalty_rewards: LoyaltyRewardsResponse
	loyalty_rules: LoyaltyRulesResponse
	loyalty_tiers: LoyaltyTiersResponse
	memberships: MembershipsResponse
	notes: NotesResponse
	notifications: NotificationsResponse
	perk_usage: PerkUsageResponse
	platforms: PlatformsResponse
	points_ledger: PointsLedgerResponse
	price_snapshots: PriceSnapshotsResponse
	pricing_rules: PricingRulesResponse
	push_subscriptions: PushSubscriptionsResponse
	quotes: QuotesResponse
	referrals: ReferralsResponse
	retro_titles: RetroTitlesResponse
	reward_redemptions: RewardRedemptionsResponse
	sale_lines: SaleLinesResponse
	sales: SalesResponse
	saved_reports: SavedReportsResponse
	settings: SettingsResponse
	staff: StaffResponse
	stock_count_lines: StockCountLinesResponse
	stock_counts: StockCountsResponse
	sumup_transactions: SumupTransactionsResponse
	trade_in_lines: TradeInLinesResponse
	trade_ins: TradeInsResponse
	users: UsersResponse
	want_list: WantListResponse
}

// Utility types for create/update operations

type ProcessCreateAndUpdateFields<T> = Omit<{
	// Omit AutoDate fields
	[K in keyof T as Extract<T[K], IsoAutoDateString> extends never ? K : never]: 
		// Convert FileNameString to File
		T[K] extends infer U ? 
			U extends (FileNameString | FileNameString[]) ? 
				U extends any[] ? File[] : File 
			: U
		: never
}, 'id'>

// Create type for Auth collections
export type CreateAuth<T> = {
	id?: RecordIdString
	email: string
	emailVisibility?: boolean
	password: string
	passwordConfirm: string
	verified?: boolean
} & ProcessCreateAndUpdateFields<T>

// Create type for Base collections
export type CreateBase<T> = {
	id?: RecordIdString
} & ProcessCreateAndUpdateFields<T>

// Update type for Auth collections
export type UpdateAuth<T> = Partial<
	Omit<ProcessCreateAndUpdateFields<T>, keyof AuthSystemFields>
> & {
	email?: string
	emailVisibility?: boolean
	oldPassword?: string
	password?: string
	passwordConfirm?: string
	verified?: boolean
}

// Update type for Base collections
export type UpdateBase<T> = Partial<
	Omit<ProcessCreateAndUpdateFields<T>, keyof BaseSystemFields>
>

// Get the correct create type for any collection
export type Create<T extends keyof CollectionResponses> =
	CollectionResponses[T] extends AuthSystemFields
		? CreateAuth<CollectionRecords[T]>
		: CreateBase<CollectionRecords[T]>

// Get the correct update type for any collection
export type Update<T extends keyof CollectionResponses> =
	CollectionResponses[T] extends AuthSystemFields
		? UpdateAuth<CollectionRecords[T]>
		: UpdateBase<CollectionRecords[T]>
