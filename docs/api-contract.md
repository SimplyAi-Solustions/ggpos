# GG Vault custom API contract (Phase 2)

The counter app talks to PocketBase's collection API for reads, drafts and simple writes, and to these custom routes for anything that must be transactional, gated or audited. The routes live in `pb/pb_hooks/` and are mounted under `/api/vault/`. Backend and frontend packages are built against this document in parallel; change it here first when a shape has to change.

Conventions
- Every route requires a `staff` token in `Authorization`. Routes marked **admin** require `role = "admin"`. Routes marked **step-up** also require the `X-Step-Up` header (see step-up below).
- Money is an integer of GBP pence everywhere. Dates and timestamps are ISO 8601 strings in UTC.
- Errors use PocketBase's shape: `{ "code": 400, "message": "...", "data": { "field": { "message": "..." } } }`. Codes: 400 validation, 401 no auth, 403 wrong role or missing step-up, 404 not found, 409 state conflict (already sold, session already open), 422 business rule refused (ID gate, cash cap, under 18). The `message` is written for staff to read on screen and says what to do next.
- Every route writes one `audit_log` row (identifiers and changed field names only, never values from customers, customer_private, id_documents, staff or settings).

## Step-up

`POST /api/vault/step-up` with `{ "password": "..." }` re-checks the signed-in staff member's password and returns `{ "token": "<jwt>", "expires_at": "..." }`, valid for 10 minutes, signed with `$security.createJWT`. Sensitive routes verify it with `$security.parseJWT` and refuse with 403 and the message "Confirm your password to continue." when it is missing or expired.

## Trade-ins

Drafts and lines are created and edited through the collection API (`trade_ins` with `status = "draft"`, `trade_in_lines`, batch for multi-line edits). Completion is the custom route.

`POST /api/vault/trade-ins/:id/complete`

Request
```json
{
  "payout_type": "cash" | "credit" | "mixed",
  "payout_cash": 0,
  "payout_credit": 0,
  "terms_accepted": true,
  "signature": "data:image/png;base64,...",
  "cash_session": "<id or null>",
  "id_check": null | {
    "id_type": "passport" | "driving_licence" | "other",
    "id_expiry": "2028-06-30",
    "id_ref_last4": "1234",
    "dob": "1990-01-31",
    "address": "1 High Street, Bolsover, S44 6AA",
    "id_document": "<id_documents id from the id-check route, or null>"
  }
}
```

Server checks, in order: the trade-in belongs to a customer and is `draft`, `offered` or `accepted` with at least one accepted line; `payout_cash + payout_credit` equals the sum of accepted `offer_price × qty`; when `payout_cash > 0`: an open cash session is supplied and matches, `payout_cash <= settings.cash_cap`, the customer's `customer_private.address` is present (or supplied in `id_check`), `id_status = "verified"` with an unexpired `id_expiry` (or a full `id_check` is supplied in the same call, which sets it), the customer is 18 or over when `dob` is known; `terms_accepted` is true.

Inside one transaction: assign `number` from `counters.trade_in` (`GG-BI-000123`), write the seller snapshot onto the trade-in, create `items` for every accepted line (one row per unit for single, graded and retro with `qty = 1`; one row with `qty` for sealed and accessory), each with `status = "in_stock"`, `cost = offer_price`, `market_at_intake = market_price`, `source = "trade_in"`, `trade_in_line` set, `acquired_at = now`, `tax_scheme = "margin"`; link each line's `item`; write `credit_ledger` (`+payout_credit`, reason `trade_in`) and recompute `customer_private.credit_balance`; write `cash_movements` (type `payout`, amount `payout_cash`) against the session; write `points_ledger` for the credit portion using the shared loyalty evaluator; create one `label_jobs` row per item using the template for its kind; set `status = "completed"`, `completed_at`, `staff`, `signature`; audit.

Response 200
```json
{
  "trade_in": { "id": "...", "number": "GG-BI-000123", "status": "completed", "payout_cash": 0, "payout_credit": 0 },
  "items": [ { "id": "...", "sku": "GGS7F3K2Q", "title": "Charizard ex #199" } ],
  "labels_queued": 3,
  "points_earned": 150,
  "credit_balance": 4500
}
```

## ID check

`POST /api/vault/customers/:id/id-check` (multipart form) with fields `photo` (image file, already downscaled by the client), `id_type`, `id_expiry`, `id_ref_last4`, `dob`, `address`.

Server: reads the photo bytes, encrypts them with `$security.encrypt` and the `GG_ID_PHOTO_KEY` environment variable (refuses with 500 "ID photo key is not configured" when the variable is missing), stores the ciphertext as the `photo` file on a new `id_documents` row with `taken_by`, `taken_at`, `expires_at = now + settings.id_photo_retention_months`; updates `customer_private` (`id_status = "verified"`, `id_type`, `id_expiry`, `id_ref_last4`, `dob`, `address`, `id_verified_by`, `id_verified_at`); audit.

The MIME type is sniffed from the file's first bytes (JPEG, PNG, WebP, HEIC/HEIF); a `mime` form field is ignored. Anything else is 400 "That file is not a photo. Take a JPEG or PNG photo of the ID." The upload is capped at 8 MB: 400 "That photo is over 8 MB. Take it again at a lower resolution."

Response 200: `{ "id_document": "<id>", "id_status": "verified", "id_expiry": "2028-06-30", "expires_at": "2027-09-20T..." }`.

`GET /api/vault/id-photo/:id` (**admin**, **step-up**): writes the audit row first, decrypts, and streams the image with `Content-Type` from the stored MIME, `Cache-Control: no-store`, `Content-Disposition: inline`. 404 when purged.

`GET /api/vault/customers/:id/id-document` (staff): the newest `id_documents` row for that customer whose photo file is still on disk, so the buy-in screen can tell whether the ID gate will pass without being able to read `id_documents` itself (its API rules are all null). Never returns the photo or anything else off the row.

Response 200: `{ "document": { "id": "...", "taken_at": "...", "expires_at": "...", "taken_by": "<staff id>" } | null }`. 404 when the customer does not exist.

## Sales

`POST /api/vault/sales/complete`

Request
```json
{
  "lines": [ { "item": "<id>", "qty": 1, "unit_price": 32499, "discount": 0 } ],
  "customer": "<id or null>",
  "payment": "sumup_card" | "cash" | "store_credit" | "points" | "mixed",
  "payment_split": { "sumup_card": 0, "cash": 0, "store_credit": 0, "points": 0 },
  "discount": 0,
  "discount_source": "manual" | "tier_perk" | "reward" | null,
  "reward_code": "GGV...." | null,
  "cash_session": "<id or null>",
  "sumup_ref": "" 
}
```

Server checks: every item is `in_stock` (or `reserved` for this customer) with enough `qty`; `payment_split` sums to the total after discount (for a single payment method the split may be omitted); cash requires an open session; store credit requires balance; points pass `checkPointsRedemption` from the shared evaluator; a reward code must be an unused, unexpired `reward_redemptions` row for this customer.

Inside one transaction: assign `number` from `counters.sale` (`GG-S-000456`); set singles to `sold`, decrement multi-quantity lines and set `sold` at zero; write `sale_lines` with `vat_rate` and `tax_scheme` from the item; write `credit_ledger` (`-store_credit`, reason `sale`); write `points_ledger` (`-points`, reason `redeem`) and then the points earned (`earn_sale`, computed with the shared `evaluateSalePoints` over live `loyalty_rules` and the customer's tier); mark the reward redemption `used`; write `cash_movements` (type `cash_sale`); recompute cached balances; audit any `unit_price` that differs from `items.price` as a price override.

Response 200
```json
{
  "sale": { "id": "...", "number": "GG-S-000456", "total": 32499, "status": "complete" },
  "sumup_amount": 32499,
  "points_earned": 325,
  "credit_balance": 0,
  "points_balance": 1240
}
```

A `reward_code` needs a customer on the sale and must belong to them; `discount_source` must be `"reward"`; the reward's type must be `money_off` and `discount` must equal its value in pence. Each of those is a 422.

`POST /api/vault/sales/:id/refund` (**step-up**)

Request: `{ "lines": [ { "sale_line": "<id>", "qty": 1 } ], "reason": "...", "refund_method": "cash" | "store_credit" | "sumup_card" }`.

Server, in one transaction: items back to `in_stock` (or `qty` incremented), `sale_lines.refunded_qty` moved up and `status = "refunded"` once it reaches `qty`, `sales.refunded_total` moved up and `sales.status` set to `refunded` or `part_refunded`, reversing `credit_ledger` and `cash_movements` rows, a `points_ledger` row with reason `refund_reverse` for the points that sale earned on those units, the reason saved as a `notes` row against the sale, audit.

Amounts come from the as-sold figures, cumulatively, so any sequence of partial refunds adds back up to exactly what was charged. 409 when the line is already refunded, when fewer units are still sold than asked for, or when the item has since been deleted.

Response 200: `{ "sale": { "id": "...", "status": "part_refunded" }, "refunded": 32499, "refunded_total": 32499, "points_reversed": 325, "credit_balance": 0, "points_balance": 915 }`.

## Cash sessions

- `POST /api/vault/cash-sessions/open` with `{ "float": 10000 }`: 409 when a session is already open. Returns the session.
- `GET /api/vault/cash-sessions/current`: `{ "session": {...} | null, "expected": 0, "movements": [...] }`. `cash_movements.amount` is signed (cash sales and float_in positive; payouts, refunds and bank drops negative; adjustments carry their own sign), so `expected = float + sum(amount)`. `open` returns the same `{ session, expected, movements }` shape.
- `POST /api/vault/cash-sessions/:id/close` with `{ "counted": 12345, "notes": "" }`: sets `expected`, `counted`, `variance = counted - expected`, `closed_by`, `closed_at`; a variance over `settings.cash_variance_alert` (pence) is audited. Returns the closed session.

## Labels

Label jobs are ordinary `label_jobs` rows (staff create rule). The print page is client-side: `/labels/print?jobs=<id>,<id>` renders one label per page with `@page` sized from the job's template and marks each job `printed` after `window.print()` resolves. No custom route.

## Receipts

- `GET /api/vault/trade-ins/:id/receipt`: JSON with everything the receipt page needs (shop details from `settings`, seller snapshot, lines with titles and offers, payout, signature URL through a short-lived file token, terms text). The app renders it at `/counter/trade/:id/receipt` for A4 print.
- `POST /api/vault/trade-ins/:id/receipt/email`: sends the receipt to the customer's email through `$mails` with the provider configured in `settings`; `{ "sent": true }` or 422 "This customer has no email on file."

## Exports

`GET /api/vault/exports/stock-book?from=YYYY-MM-DD&to=YYYY-MM-DD` (**admin**): CSV of margin scheme items acquired in the range with the columns in `docs/csv-formats.md` (stock number, purchase date and ref, seller name and address, description, cost, sale date and ref, sale price, margin). `Content-Disposition: attachment`.

## Config

`GET /api/vault/config` (staff): the read-only window onto the admin-only reference collections, so an ordinary staff member at the counter can price an item, see the cash variance threshold and show a customer their tier.

Response 200
```json
{
  "settings": { "cash_cap": 800000, "offer": { "bulkThreshold": 100, "...": 0 }, "...": "" },
  "pricing_rules": [ { "id": "...", "kind": "single", "band_min": 0, "...": 0 } ],
  "loyalty": {
    "programme": { "id": "...", "enabled": true, "...": 0 },
    "rules": [ { "id": "...", "type": "multiplier", "...": 0 } ],
    "tiers": [ { "id": "...", "name": "Member", "...": 0 } ]
  }
}
```

`settings` is every field of the settings record except `api_keys`, `email` and anything whose name contains "key" or "secret", so the third-party API keys, the mail key and the VAPID keys never leave the server. `pricing_rules` and `loyalty.rules` are the active rows, highest priority first (the order the evaluators break ties in); `loyalty.tiers` is every tier by `sort`. 401 without a staff token. No audit row: every counter screen loads this.

## Customer records

`POST /api/vault/customers/:id/merge` (**step-up**) with `{ "into": "<id>" }`, where `:id` is the duplicate to fold in and `into` is the record to keep.

In one transaction every relation is re-pointed at the record being kept (`trade_ins`, `sales`, `credit_ledger`, `points_ledger`, `quotes`, `want_list`, `notifications`, `push_subscriptions`, `reward_redemptions`, `referrals` at both ends, `memberships`, `id_documents`, `items.reserved_for`, `customers.referred_by`, and `notes` rows targeting the duplicate). `perk_usage` is the one exception: it carries a unique index on `(customer, perk_type, period)`, so a row that clashes with one the kept record already has is added into it by `used_count` and then deleted, and a row with no counterpart is re-pointed as normal. On `customer_private`, fields that are empty on the record being kept are filled from the duplicate (address, date of birth), flags are unioned, notes are appended on a new line, and the ID fields move over only when the record being kept has no verified ID and the duplicate has one. Both cached balances are then recomputed from the ledgers, and the duplicate's `customer_private` and `customers` rows are deleted.

Response 200: `{ "customer": { ...the kept record... }, "moved": { "trade_ins": 2, "credit_ledger": 5 } }`. 400 with no `into`, 409 when the two ids are the same, 404 when either is missing. Audit carries the two ids and the counts.

`POST /api/vault/customers/:id/erase` (**admin**, **step-up**), no body. The UK GDPR Article 17 erasure.

422 when the customer still holds store credit: "This customer still has £15.00 store credit. Pay it out or write it off first."

In one transaction: `customers` keeps its `code` and gets `name = "Erased customer"`, an empty email and phone, `marketing_consent = false`, no birthday month and a fresh `qr_token`; `customer_private` has its address, date of birth, notes, flags and every ID field cleared and `id_status = "none"`; the customer's `id_documents` rows are deleted with their files; open (`issued`) `reward_redemptions` become `cancelled`; their `want_list`, `notifications`, `push_subscriptions` and `quotes` rows are deleted, quote photos included. Trade-ins, sales and both ledgers stay untouched, seller snapshot and all: Article 17(3)(b) keeps the record the shop is required by law to hold.

Response 200: `{ "erased": true, "customer": { ...the anonymised record... } }`. Audit carries the customer id and the counts.

## Demo mode

The web app's `src/lib/api/` layer exposes the same functions for demo mode (in-memory fixtures) and live mode (these routes), so screens never branch on the mode.

## Implementation notes (as built in Phase 2)

Where the routes differ from the text above, the built behaviour is the truth and this list records it.

- `POST /api/vault/step-up` returns 400 for a wrong password (403 is only for a missing or expired token on a protected route). The signing key is derived from the app settings and peppered with `GG_ID_PHOTO_KEY`.
- `trade_ins.number` is optional with a partial unique index, so drafts can be created through the collection API; the number is assigned at completion.
- `trade_in_lines` carry `kind`, `game` and `completeness` (items need a kind and a game, and sealed or accessory lines have no card to derive them from). The completion route still falls back to the linked card or retro title when they are empty.
- `trade_in_lines` also carry `override_reason`, `override_cash`, `override_credit` and `cosmetic_grade`. **A line is overridden when `override_reason` is non-empty**; `override_cash` and `override_credit` are what the staff member typed for each payout type, and `offer_price` stays the figure actually paid for the type chosen, so the payout arithmetic is unchanged. Completion copies `cosmetic_grade` (A, B or C) onto `items.cosmetic_grade` for retro lines only, and lists the overridden line ids in the audit meta as `overridden_lines`. The reason stays on the line row and never reaches `audit_log`.
- **A bulk lot is one ordinary line**, not a special shape: `kind: "other"`, `qty: 1`, the flat figure in both `offer_price` and `market_price`, `market_source: "Bulk lot"` and a title such as "Bulk lot, 400 cards". It becomes a single `items` row of kind `other` and `qty` 1 with one label job, and the receipt and the stock book read it like any other line.
- Receipt JSON takes its terms from `settings.receipt_terms`; the signature is served through a short-lived PocketBase file token, never as a data URL. Email goes through PocketBase's own SMTP settings (`$app.newMailClient()`), so the admin UI's mail settings must be filled in; `settings.email` holds only the from name, from address, reply-to and `test_mode`.
- Response supersets: `cash-sessions/close` adds `expected`, `variance` and `variance_alert`; `sales/:id/refund` adds `refunded_total`, `points_reversed`, `credit_balance` and `points_balance`.
- **A refund never rewrites what was sold.** `sale_lines.qty` and `.discount` are the as-sold figures for good; a refund moves `sale_lines.refunded_qty` and `sales.refunded_total`, and sets `sale_lines.status = "refunded"` once `refunded_qty` reaches `qty`. Amounts are worked out from the immutable figures: `lineGross = unit_price * qty - discount`, the sale-level discount is allocated across the lines pro rata with the last line (by created, then id) absorbing the rounding remainder, `lineNet = lineGross - allocation`, and refunding `r` more units of a line pays `roundHalfUp(lineNet * (refunded_qty + r) / qty) - roundHalfUp(lineNet * refunded_qty / qty)`. Any sequence of partial refunds therefore sums to exactly `sales.total`. Points reverse the same way, cumulatively over `refunded_total`, and the points ledger is allowed to go negative.
- **The refund reason is a `notes` row** against the sale (`target_collection = "sales"`), not audit meta; the audit row carries only the note's id. `audit_log` is permanent and superuser-only, and a refund reason is free text about a named customer.
- **`trade_ins.signature` and `quotes.photos` are protected files.** They are only served with a short-lived PocketBase file token, and that token is minted from the **calling staff auth record** (`e.auth.newFileToken()`): `record.newFileToken()` throws "not an auth collection record" on an ordinary record. The receipt route mints one and appends it to `signature.url`. `items.photos` stays public: that is product imagery.
- **The cash ID gate needs a photo, not just fields.** A cash payout requires an `id_documents` row for that customer whose photo file is still present, or an `id_check.id_document` in the same call belonging to them; otherwise 422 "Take a photo of the customer's ID before paying cash." The document's id goes on `trade_ins.id_document`, and its `expires_at` is pushed out to now plus `settings.id_photo_retention_months` on every cash completion, so a photo lives twelve months from the last cash buy-in rather than from the day it was taken. `customer_private.flags` is honoured first: `no_cash` is 422 "This customer is marked no cash. Pay as store credit." and `under_18` is 422 "This customer is recorded as under 18, so we cannot buy for cash."
- **`settings.cash_cap` of 0 means no cash at all**, not "no limit": 422 "Cash payouts are switched off in settings." on a buy-in and "Cash sales are switched off in settings." on a sale.
- Completion also validates before it writes: `id_check.id_ref_last4` must be 1 to 4 characters, and a supplied signature must be a PNG under 2 MB.
- **Points earned spread the sale-level discount across the lines** before the evaluator sees them, so the gross it earns on is the amount actually charged. A sale with no customer has `points_earned` 0.
- **One open cash session is enforced by a partial unique index**, not just by a read: `cash_sessions (closed_at) WHERE closed_at = ''`. Opening runs in a transaction and a collision on that index comes back as the same 409.
- Every CSV cell that opens with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with a single quote and quoted, so a seller called `=HYPERLINK("x")` reads as text in a spreadsheet. Money columns stay numeric, negative margins included.
- The stock book is **one row per sale line** for the quantity still sold (cost is the unit cost times that quantity, sale price is the line's net less what has been refunded off it, margin is the difference), plus one row for the quantity still on the shelf with the sale columns blank. A fully refunded line produces no row. The purchase columns repeat on every row of an item.
- `GET /api/vault/config` and `GET /api/vault/customers/:id/id-document` write no audit row: both are loaded by ordinary counter screens and neither returns anything sensitive.
- The retention cron purges expired `id_documents` (file included, audited by id) and notifications older than 12 months; quote photos are not purged yet because `quotes` has no closed-at timestamp (lands with the portal phase). Its cutoffs are formatted the way PocketBase stores a date (a space, not a `T`), so they compare correctly as text.
- `GG_ID_PHOTO_KEY` (exactly 32 characters) is required in production; without it the ID check route refuses with 500 and photos cannot be stored.
- ID photo bytes go into `$security.encrypt` as an array of numbers and come back through `toBytes($security.decrypt(...))`, so nothing on that path is base64'd. `pb_hooks/lib/base64.js` is now only the signature data URL's codec.
- The refund route and the stock book both price through the shared `saleline` evaluator (`packages/shared/src/saleline.ts`, built into `pb_hooks/lib/shared/saleline.js`), so the server and the counter's refund sheet cannot drift. The lines are always read in `created,id` order before the breakdown, via `vaultutil.saleLineRows`: lines written in one transaction share a `created` timestamp to the millisecond, and the rounding remainder has to land on the same line every time.
- The seeded `pricing_rules` single bands are condition wildcards. Condition is applied by `adjustForCondition` before a rule is picked, so a condition on the band would leave every non-NM single matching no rule at all.

## Phase 3: lookup, prices and FX

The catalogue and price adapters (`pb_hooks/adapters/*.js`), driving `cards`, `card_sets`, `retro_titles`, `price_snapshots` and `fx_rates`. Every route below needs a `staff` token; none needs admin or step-up. Money and error conventions are as above.

`GET /api/vault/lookup?game=<key>&q=<text>`

`game` is one of `pokemon`, `mtg`, `yugioh`, `onepiece`, `lorcana`. Searches that game's adapter (name, or the "set number" forms `sv151 199` / `blb 223` for Pokemon/MTG/Lorcana, `OP01-001` / `CT13-EN003` for One Piece/Yu-Gi-Oh!), writes every match through to `cards` (and `card_sets` when the set is new), and returns at most 25 rows:

```json
{ "cards": [ { "id": "...", "game": "...", "set": "...", "set_code": "sv03.5", "set_name": "151", "number": "199", "name": "Charizard ex", "rarity": "Special illustration rare", "image_small": "...", "image_large": "...", "finishes_available": ["holo"], "external_ids": { "tcgdex": "sv03.5-199" }, "last_synced": "..." } ] }
```

A "set number" query is treated as an exact lookup and gets the same cache as the dedicated exact route below: a `cards` row whose `last_synced` is under 30 days old is returned straight from the database, with no adapter call at all. A plain name search always asks the adapter (discovering a card that is not in the database yet is the point of it), so it is never itself served from cache.

`GET /api/vault/lookup/:game/:set/:number`

The exact card, same row shape as above, wrapped in `{ "cards": [ ... ] }` (one row, for the same shape every lookup response uses). 30-day cache as above. 404 `"Card not found in <set name>. Check the number or add it manually."` (the set's own name once known, its code otherwise) when the adapter has nothing either.

`GET /api/vault/cards/:id/prices?finish=<finish>&condition=<NM|LP|MP|HP|DMG>`

Reads `price_snapshots` only - **never calls an adapter**, so a routine price check makes no outbound call at all; only `refresh-prices` and `uk-comp` below write anything.

```json
{
  "chosen": { "source": "cardmarket", "gbp_market": 31674, "native_currency": "EUR", "native_market": 36830, "fx_rate": 0.86, "fx_date": "2026-09-20", "fetched_at": "...", "stale": false, "evidence_url": "" } ,
  "sources": [ /* same shape, one row per source that has a value, in settings.source_priority order, every stale one flagged rather than hidden */ ],
  "condition_adjusted": 26923
}
```

`chosen` is `null` and `condition_adjusted` is `null` when there is no snapshot at all for that card and finish. `native_market` and `native_low`/`native_mid`/`native_trend` (on each `sources` row) are minor units of `native_currency`, exactly as stored; `gbp_market` sits beside them on the same row, per CLAUDE.md's "Pricing" (a foreign amount is never returned on its own). Freshness (`stale`) is UK sold comp 30 days, eBay asking 24 hours, Cardmarket and TCGplayer 3 days, either PriceCharting region 3 days - a stricter eBay window than `packages/shared/src/pricing.ts`'s own `DEFAULT_FRESHNESS` (48 hours), passed as this route's own policy to the shared `chooseMarketPrice` rather than its default. `condition_adjusted` is `chosen.gbp_market` after `settings.condition_multipliers` for `condition` (default `NM`).

`POST /api/vault/cards/:id/refresh-prices` with `{ "finish": "..." }`

Bypasses the price cache: calls the card's game adapter's `getPrices` plus eBay (when `settings.api_keys.ebay` is set), converts every candidate to GBP pence at the latest `fx_rates` row, writes one `price_snapshots` row per source that returned a usable figure, and returns the same body as the GET, freshly recomputed. A foreign candidate is silently skipped (not written, not chosen) when no `fx_rates` row exists yet to convert it - "never returned on its own" applies to a rate-less conversion too, not just to the response shape.

`POST /api/vault/cards/:id/uk-comp` with `{ "finish", "condition", "price": <pence>, "url": "https://www.ebay.co.uk/itm/...", "sold_at": "YYYY-MM-DD" }`

Writes a `price_snapshots` row (`source: "uk_sold_manual"`, native and GBP both `price`, `fx_rate: 1`, `evidence_url: url`, `fetched_at` set to `sold_at`), audits it (the card id, finish, condition and price - no customer data is ever involved), and returns the same `{ chosen, sources, condition_adjusted }` body as the GET, so the UI can confirm the new comp was actually chosen. 400 `"That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...)."` when the URL is not `https://(www.)ebay.co.uk/itm/...`; 400 `"That sale date is in the future."`; 400 `"That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days."`.

`GET /api/vault/retro/lookup?q=<text>&platform=<key>`

IGDB search (`platform` is one of `platforms.key`, mapped to IGDB's own numeric platform id) writing through to `retro_titles` (name, platform, cover; `external_ids.igdb`) when a `platform` is given - `platform` is a required field on `retro_titles`, so a search with no platform is preview-only (`id: ""` on every row, nothing written). 422 `"Retro title search needs an IGDB key. Add settings.api_keys.igdb first."` when that key is not configured.

```json
{ "titles": [ { "id": "...", "platform": "...", "name": "Super Mario Kart", "region": "", "cover": "...", "external_ids": { "igdb": "1074" } } ] }
```

`GET /api/vault/retro/:id/prices?completeness=<loose|boxed|cib>`

Same shape as the cards GET above (`chosen`, `sources`, and `condition_adjusted: null` - condition multipliers are a TCG-card concept, not a retro one). `retro_source_priority` order (UK sold comp, PriceCharting PAL, eBay UK asking, PriceCharting NTSC). `completeness` is read off `price_snapshots.finish` - PLAN.md's data model gives `price_snapshots` one such column, shared by a card's finish and a retro item's completeness, rather than adding a second that would mean the same thing.

`GET /api/vault/fx`

```json
{ "base": "GBP", "rates": { "EUR": 0.8606, "USD": 0.75 }, "fetched_at": "...", "stale": false }
```

Reads the latest `fx_rates` row only - the daily 07:00 cron (`crons.pb.js`) is the only thing that ever calls Frankfurter. `rates[code]` is **GBP per one unit of `code`** (so `£1 = €1 / 0.8606`), the same direction as every helper in `packages/shared/src/money.ts`. Stale after 3 days. With no `fx_rates` row at all (a fresh install before the first 07:00 run), returns `{ "base": "GBP", "rates": {}, "fetched_at": null, "stale": true }` rather than an error.

### Implementation notes (as built in Phase 3)

- **The GET price routes never call an adapter.** Only `POST .../refresh-prices` (cards) does; there is no retro equivalent of `refresh-prices` or `uk-comp` in this phase - only `GET /api/vault/retro/lookup` and `GET /api/vault/retro/:id/prices` were built, matching this document. A retro `refresh-prices`/`uk-comp` pair (wiring `pb_hooks/adapters/pricecharting.js` and `.../ebay.js` into a live route for `retro_titles`) is a natural follow-up, not yet scheduled.
- **`price_snapshots.source` has no `"optcg"` value** (its enum is fixed by `packages/shared/src/pricing.ts`'s `PriceSource` union, which this package does not own). One Piece's own `market_price` fallback (PLAN.md: "OPTCG `market_price` as fallback") is therefore written under `source: "tcgplayer"`, alongside whatever `services/pricesync` also writes there from the TCGCSV One Piece file - `chooseMarketPrice` already takes the freshest row per source, so the two coexist correctly without a schema change.
- **eBay and PriceCharting cache their own OAuth tokens and, for eBay, the computed candidate itself** in the new `adapter_state` collection (superuser-only; see the Phase 3 migration), keyed by `card+finish+condition` for eBay's 24-hour "asking price" cache (docs/PLAN.md). This is separate from, and in addition to, `price_snapshots`' own freshness windows above.
- **Every adapter re-hosts an image it must not hotlink before writing anything.** YGOPRODeck and OPTCG images are fetched into `cards.image_file` (a new file field - see the Phase 3 migration) the moment an exact lookup resolves them, never as a bare URL, even transiently; a name search against either game therefore returns `image_small`/`image_large` empty for a card the database has not resolved exactly yet, rather than a hotlinked URL a picker would render. TCGdex, Scryfall and Lorcast images may be linked directly, and are lazily re-hosted the first time an item is created against that card (`items.pb.js`'s `onRecordCreate`, `pb_hooks/adapters/images.js`) - a failed fetch there never blocks the item create.
- **`GET /api/vault/retro/lookup`'s IGDB platform ids are hand-derived**, not confirmed against a live key (nobody on this build has one - see `pb_hooks/adapters/fixtures/igdb_HANDWRITTEN_*.json`). Confirm `pb_hooks/adapters/igdb.js`'s `PLATFORM_IGDB_IDS` against IGDB's own `/platforms` once a key exists. The same caveat applies to `pb_hooks/adapters/pricecharting.js`'s PAL/NTSC console-category slugs.
