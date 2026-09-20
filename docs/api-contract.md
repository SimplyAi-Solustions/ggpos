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

Response 200: `{ "id_document": "<id>", "id_status": "verified", "id_expiry": "2028-06-30", "expires_at": "2027-09-20T..." }`.

`GET /api/vault/id-photo/:id` (**admin**, **step-up**): writes the audit row first, decrypts, and streams the image with `Content-Type` from the stored MIME, `Cache-Control: no-store`, `Content-Disposition: inline`. 404 when purged.

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

`POST /api/vault/sales/:id/refund` (**step-up**)

Request: `{ "lines": [ { "sale_line": "<id>", "qty": 1 } ], "reason": "...", "refund_method": "cash" | "store_credit" | "sumup_card" }`.

Server, in one transaction: items back to `in_stock` (or `qty` incremented), `sale_lines.status = "refunded"`, `sales.status` to `refunded` or `part_refunded`, reversing `credit_ledger` and `cash_movements` rows, a `points_ledger` row with reason `refund_reverse` for the points that sale earned on those lines, audit with the reason.

Response 200: `{ "sale": { "id": "...", "status": "part_refunded" }, "refunded": 32499 }`.

## Cash sessions

- `POST /api/vault/cash-sessions/open` with `{ "float": 10000 }`: 409 when a session is already open. Returns the session.
- `GET /api/vault/cash-sessions/current`: `{ "session": {...} | null, "expected": 0, "movements": [...] }` where `expected = float + cash sales + float_in - payouts - refunds - bank drops`.
- `POST /api/vault/cash-sessions/:id/close` with `{ "counted": 12345, "notes": "" }`: sets `expected`, `counted`, `variance = counted - expected`, `closed_by`, `closed_at`; a variance over `settings.cash_variance_alert` (pence) is audited. Returns the closed session.

## Labels

Label jobs are ordinary `label_jobs` rows (staff create rule). The print page is client-side: `/labels/print?jobs=<id>,<id>` renders one label per page with `@page` sized from the job's template and marks each job `printed` after `window.print()` resolves. No custom route.

## Receipts

- `GET /api/vault/trade-ins/:id/receipt`: JSON with everything the receipt page needs (shop details from `settings`, seller snapshot, lines with titles and offers, payout, signature URL through a short-lived file token, terms text). The app renders it at `/counter/trade/:id/receipt` for A4 print.
- `POST /api/vault/trade-ins/:id/receipt/email`: sends the receipt to the customer's email through `$mails` with the provider configured in `settings`; `{ "sent": true }` or 422 "This customer has no email on file."

## Exports

`GET /api/vault/exports/stock-book?from=YYYY-MM-DD&to=YYYY-MM-DD` (**admin**): CSV of margin scheme items acquired in the range with the columns in `docs/csv-formats.md` (stock number, purchase date and ref, seller name and address, description, cost, sale date and ref, sale price, margin). `Content-Disposition: attachment`.

## Demo mode

The web app's `src/lib/api/` layer exposes the same functions for demo mode (in-memory fixtures) and live mode (these routes), so screens never branch on the mode.
