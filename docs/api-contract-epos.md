# API contract: the EPOS (Phase 8 onwards)

Companion to `docs/api-contract.md` and `docs/EPOS-PLAN.md`. Conventions are unchanged: money is integer GBP pence, dates ISO 8601, every refusal is `{ "message": "<a sentence that says what happened and what to do>" }`, no em-dashes, no exclamation marks. Shared shapes are TypeScript in `packages/shared/src/epos-types.ts` and `packages/shared/src/permissions.ts`; the hooks use the generated copies in `pb/pb_hooks/lib/shared/`.

Callers:

- **staff**: any active staff token. **manager**: role `manager` or `admin`. **admin**: role `admin`.
- **device**: no token, but the header `X-GG-Device: <device id>.<device secret>` from a browser registered to a register (`register_devices`). A revoked or unknown device is 401 "This device is not registered as a till. Sign in with a password and register it under Settings."
- **printer**: no token; a per-printer secret in the URL path.
- **step-up**: the existing `X-Step-Up` header (a password confirmed in the last ten minutes).
- **capability**: the caller's role holds the capability under `settings.epos.permissions` (`packages/shared/src/permissions.ts`), or the request carries a valid manager override for it (below).

Package ownership (Phase 8, wave 1): **B1** staff, PIN, devices, overrides, staff management; **B2** till sessions, X and Z, tenders, the sale and refund routes, parked tickets, the till catalogue, receipts data, VAT, the raw API lockdown, SumUp removal on the server; **P** printers, print jobs, CloudPRNT, the receipt image renderer, Settings > Printers. **F1** the till screen; **F2** the lock screen, device setup, cashing up screens, staff screens, EPOS settings screens and SumUp removal in the web app.

---

## 1. Foundation (already in `pb/pb_migrations/1789820800_epos_foundation.js`)

- `staff.role`: `admin` | `manager` | `staff`. `staff.pin_hash` is hidden. New: `pin_failures` (int), `pin_locked` (bool), `pin_set_at` (date).
- `registers`: `name` (unique), `location`, `active`, `sort`. Seeded: "Counter". Staff list and view; admin create and update; nobody deletes.
- `register_devices`: `register`, `label`, `secret_hash` (hidden), `created_by`, `last_seen`, `revoked_at`. Manager list and view; all writes through routes.
- `settings.epos` (json, defaults set): `permissions` {}, `discount_limit_pct` 10, `require_card_last4` true, `auto_lock_minutes` 5, `quick_cash` [500,1000,2000,5000], `default_float` 10000, `z_requires_card_total` true, `card_provider` "manual_tide", `receipt` { header, footer, returns_policy, show_portal_qr }. `settings.vat_number` (text). Both reach the counter through `GET /api/vault/config` like every other non-secret setting.
- **The default register** is the active register with the lowest `sort`. Any route that takes `register` and is called without one uses it, so older callers keep working.

**The rest of the Phase 8 schema is laid too**, in `pb/pb_migrations/1789820860_epos_schema.js`: `till_events`, `till_reports`, `sale_tenders`, `parked_tickets`, `till_categories`, `till_products`, `till_keys` (all seeded as section 4 says), `printers`, `print_jobs`, `till_overrides`; the new fields on `cash_sessions` (with the one-open-per-register index; existing rows moved to the default register), `cash_movements` (`paid_in`, `paid_out`, `reason`, `approver`), `sales` (`register`, `vat_total`, `trade_in`, `refund_count`, the new payment values), `sale_lines` (`item` optional, `product`, `title`, `vat_amount`, `note`, scheme `exempt`) and `trade_ins.sale`. The field lists in sections 3, 4 and 6 describe those collections; the migration is the source of truth where they differ. **No package adds or changes a collection or field without asking the orchestrator**, so the five packages build against one schema. The one schema change a package owns is B2's lockdown migration (section 4, "Locked down"), timestamped after `1789820860`.

---

## 2. Staff, PIN, devices and overrides (B1: `pb_hooks/till_auth.pb.js`, `pb_hooks/staff_admin.pb.js`, `pb_hooks/lib/pins.js`; `pb_hooks/lib/permissions.js` is already written)

### PIN hashing

`pin_hash = "v1$" + hs256(staffId + ":" + pin, pepper)`, where `pepper = hs256("gg-pin-pepper-v1", GG_ID_PHOTO_KEY)`, using `$security.hs256`, compared with `$security.equal`. Never logged, never returned. With `GG_ID_PHOTO_KEY` unset, every PIN route is 500 "PINs are not available because the server key is not set." PIN rules are `pinProblem()` from `permissions.ts` (400 with its sentence).

A successful password sign-in by a staff member (`onRecordAuthRequest` with the password method) clears their `pin_failures` and `pin_locked`.

### Devices

`POST /api/vault/till/devices` (manager + step-up): `{ "register": "<id>", "label": "Counter Mac" }` -> 201 `{ "device": { id, register, register_name, label, created }, "secret": "<64 hex>" }`. The secret is returned once and stored only as `sha256`. The browser keeps `{ id, secret, register, register_name, label }` in `localStorage["gg.till.device"]` (`apps/web/src/lib/till-device.ts`). Audited `till_device_registered`. 400 for a missing label; 404 "That register was not found."; 409 "That register is switched off. Switch it on under Settings first."

`GET /api/vault/till/devices` (manager): `{ "devices": [{ id, register, register_name, label, created_by_name, last_seen, revoked_at }] }`, newest first.

`DELETE /api/vault/till/devices/{id}` (manager): sets `revoked_at`, 204, audited `till_device_revoked`. The device's next request is 401.

`GET /api/vault/till/device` (device): `{ "device": { id, label, register, register_name }, "register": { id, name, active } }`. Updates `last_seen` at most once a minute. This is how a till checks it is still registered at start-up.

### The roster and unlocking

`GET /api/vault/till/roster` (device): `{ "register": { id, name }, "staff": [{ id, name, initials, role, pin_set, pin_length, pin_locked }] }`. `pin_length` (4 or 6) is `staff.pin_length`, set with the hash, so the lock screen draws that many dots and unlocks on the last digit. Active staff only, sorted by name. `initials` is the first letter of the first and last word of the name, uppercase.

`POST /api/vault/till/unlock` (device): `{ "staff": "<id>", "pin": "2580" }` -> 200, the same body PocketBase returns for a password sign-in (`{ token, record }`, built with `$apis.recordAuthResponse` with the auth method `"pin"`), so the counter stores it exactly as it stores a password sign-in. Refusals:
- 401 "That PIN is not right. 3 tries left." (`pin_failures` goes up; the count is what is left of 5)
- 423 "Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN." (the fifth failure sets `pin_locked`; while locked every attempt is 423 and counts nothing)
- 409 "Sam Bell has no PIN yet. Sign in with a password to set one."
- 403 "This account is inactive. Ask an admin to reactivate it."
- A staff member with `must_change_password` gets the token like anyone; the counter's existing guard then holds them on the password screen.
Audited `pin_unlock`, `pin_failed`, `pin_locked` with the device and register. Rate limited to 30 a minute per IP.

### Setting a PIN

`POST /api/vault/staff/me/pin` (staff + step-up): `{ "pin": "2580" }` -> 204. Sets the hash, `pin_length` and `pin_set_at`, clears the failures and the lock. Clearing a PIN sets `pin_length` to 0. Audited `pin_set` (no PIN in the row).

`DELETE /api/vault/staff/me/pin` (staff + step-up) -> 204, clears it.

`POST /api/vault/staff/{id}/pin` (admin + step-up): same body, for somebody else; also clears their lock. `DELETE /api/vault/staff/{id}/pin` (admin + step-up).

### Overrides

`POST /api/vault/till/override` (staff + device): `{ "capability": "refund", "approver": "<staff id>", "pin": "2580", "context"?: { "sale"?: "<id>", "amount"?: 1500, "reason"?: "..." } }` -> 200 `{ "token": "<opaque>", "capability": "refund", "approver": { id, name }, "expires_at": "..." }`. The approver must be active, must not be the caller, and must hold the capability; their PIN is checked exactly as unlock checks it and counts toward their own failures. The token is single use and lasts five minutes. Stored in `till_overrides` (`token_hash`, `capability`, `requested_by`, `approver`, `context`, `expires_at`, `used_at`; every rule null). Audited `override_granted`. Refusals: 403 "Mo Khan cannot approve that. Ask somebody who can give a refund." and the unlock refusals for the PIN.

Using one: any protected route reads `X-GG-Override: <token>[,<token>...]`. `pb_hooks/lib/permissions.js` is **already written and tested** (it is part of the schema commit, not B1's package); its header comment shows the usage. It exports:

```js
check(e, capability)        // { ok: true, by, capability, approver|null, override|null } or { ok: false, status: 403, body }
checkAll(e, [capabilities]) // { ok: true, by, grants, approvers } or the first refusal
refuse(e, result)           // return perms.refuse(e, result) sends the 403 body below
consume(txApp, result, usedFor)        // marks the overrides used inside the action's transaction; throws if one was raced
logOverrides(txApp, result, { register, session, amount, detail, used_for })  // one `override` till event per approval
auditMeta(result)           // [{ capability, approver, approver_name }] for the action's audit row
table(app), holds(staffRecord, capability, table), hashToken(token), caller(e)
```

`check` throws a 401 or 403 itself only when there is no active staff caller. When the caller's role lacks the capability and no valid unused override for it is present, `check` returns the refusal and the route answers **403** `{ "message": "A manager needs to approve this.", "needs_override": true, "capability": "<capability>" }`. The counter asks for a manager's PIN, gets a token, and retries the same request with the header. An override is marked used inside the same transaction as the action it approved, and the action's audit row names both people. B1's override route stores `token_hash = hashToken(token)` so `check` finds it.

### Staff management (admin)

`GET /api/vault/staff` (admin): `{ "staff": [{ id, name, email, role, active, pin_set, pin_locked, must_change_password, created }] }`.

`POST /api/vault/staff` (admin + step-up): `{ "name", "email", "role", "password" }` -> 201 `{ "staff": {...} }`. The password follows the 12 character rule; `must_change_password` is set so they choose their own at first sign-in. 409 "Somebody already uses that email."

`PATCH /api/vault/staff/{id}` (admin + step-up): `{ "name"?, "role"?, "active"? }` -> 200. 409 "There has to be at least one active admin." when the change would leave none. Audited `staff_updated` with the changed field names.

`POST /api/vault/staff/{id}/password` (admin + step-up): `{ "password" }` -> 204. Sets a temporary password and `must_change_password`. Audited `staff_password_set`.

`POST /api/vault/staff/me/password` (staff): `{ "old_password", "password" }` -> 204. For every role, so a member of staff can change their own password without the admin-only collection rule; the same rules as the first sign-in screen. 400 "That is not your current password." Signs the caller in again is the client's job (the token rotates).

---

## 3. Till sessions, cashing up and the drawer (B2: `pb_hooks/till.pb.js`, `pb_hooks/lib/till.js`, `packages/shared/src/till.ts`)

`cash_sessions` gains `register` (required on new rows; existing rows set to the default register), `opening_counts` and `closing_counts` (json, `DenominationCounts`), `card_till_total`, `card_reported_total`, `card_variance` (int), `z_report` (relation). The shop-wide "one open session" index becomes one open session **per register**. `cash_movements.type` gains `paid_in`, `paid_out` and `drawer_open`.

`till_events` (new; staff list and view; every write null): `register`, `session`, `kind` (`void_line` | `void_ticket` | `no_sale` | `override` | `reprint`), `amount`, `detail` (json), `staff`, `approver`, `created`.

`till_reports` (new; staff list and view; every write null): `type` (`x` | `z`), `number` (int), `register`, `session`, `period_start`, `period_end`, `data` (json, a `TillReport`), `created_by`, `created`. Unique on (type, number). Numbers come from `counters` keys `x_report` and `z_report`, bumped in the same transaction.

`POST /api/vault/till/open` (capability `till_open`): `{ "register"?: "<id>", "counts"?: DenominationCounts, "float"?: <pence> }` -> 201 `{ "session": TillSession }`. With `counts`, the float is their total and `float` is ignored. 409 "The till is already open. Close it with a Z report first."

`TillSession` is `{ id, register: { id, name }, opened_at, opened_by: { id, name }, float, opening_counts }`.

`GET /api/vault/till/current?register=` (staff) -> `{ "register": { id, name }, "session": TillSession | null, "running": TillReport | null }`. `running` is what an X report would say right now, unnumbered and unsaved, so the cashing-up screen can show it before anything is committed.

`POST /api/vault/till/x` (capability `x_report`): `{ "register"? }` -> 201 `{ "report": TillReport }`. Saved and numbered. 409 "Open the till first."

`POST /api/vault/till/z` (capability `z_report`): `{ "register"?, "counts": DenominationCounts, "card_reported_total": <pence> | null, "bank_drop"?: <pence>, "notes"?: "..." }` -> 201 `{ "report": TillReport, "session": TillSession }`. One transaction: write the bank drop as a movement when given, compute the report from the session's records, save it numbered, close the session with the counted total, the variance, the card totals and the report link. Refusals: 409 "Open the till first."; 400 "Count the drawer before closing the till." (no counts); 400 "Enter the Tide card total for today from the Tide app." when `settings.epos.z_requires_card_total` and the session took card; 409 "Two tickets are parked on Counter. Complete or delete them before closing the till." when parked tickets exist for the register. A Z report cannot be changed or deleted by anybody.

`GET /api/vault/till/reports?register=&type=&page=&per_page=` (capability `x_report`) -> `{ "items": [{ id, type, number, register_name, created, created_by_name, net, cash_variance, card_variance }], "page", "per_page", "total" }`.

`GET /api/vault/till/reports/{id}` (capability `x_report`) -> `{ "report": TillReport }`.

`POST /api/vault/till/movement` (staff + device optional): `{ "register"?, "type": "paid_in" | "paid_out" | "bank_drop" | "adjustment", "amount": <pence above 0>, "reason": "..." }` -> 201 `{ "movement": {...}, "print_job": PrintJob | null }`. Capability `paid_in_out` for `paid_in`, `paid_out` and `bank_drop`; `z_report` for `adjustment` (which may be negative). A reason is required (400 "Say what the money was for."). `paid_out` and `bank_drop` cannot take the drawer below zero (409 "That is more than the £82.40 the drawer should hold."). Opens the drawer through the register's printer when there is one (section 6).

`POST /api/vault/till/no-sale` (capability `no_sale`): `{ "register"?, "reason": "..." }` -> 201 `{ "event": {...}, "print_job": PrintJob | null }`. Records a `no_sale` event and opens the drawer.

`POST /api/vault/till/void` (capability `void_line`): `{ "register"?, "ticket": true|false, "lines": [{ "title", "qty", "amount" }] }` -> 201. Records `void_line` or `void_ticket` events for lines that were on a ticket and removed before payment. Counted on the X and Z.

Every route here needs an open session for the register except `open` and the reads.

**The report** is built by `buildTillReport()` in `packages/shared/src/till.ts` from the session's sales, sale tenders, refunds, cash movements, trade-ins and till events, so the server's number and the counter's preview cannot disagree. Expected cash = float + cash tenders taken - change given... (stored as net cash per tender) - cash refunds + paid in - paid out - buy-in cash payouts - bank drops + adjustments.

---

## 4. Selling (B2: `pb_hooks/sales.pb.js`, `pb_hooks/lib/tenders.js`)

### `sale_tenders` (new; staff list and view; every write null)

`sale` (relation), `refund_ref` (text, empty for a sale), `method` (`TenderMethod`), `amount` (signed pence: positive taken, negative given back), `tendered`, `change`, `card_last4`, `reference`, `register`, `session`, `staff`, `created`. Written only by the sale, refund and part-exchange routes, in their own transactions.

### `POST /api/vault/sales/complete`, extended

New body fields (everything already accepted still works):

```
{
  "client_id": "...",
  "register": "<id>",                          // optional: the default register
  "lines": [
    { "item": "<id>", "qty": 1, "unit_price"?: 1250, "discount"?: 0 },
    { "product": "<till_products id>", "qty": 1, "unit_price"?: 400, "discount"?: 0, "title"?: "Single card: Charizard ex" }
  ],
  "discount"?: 0, "discount_source"?: "manual" | "tier_perk" | "reward",
  "reward_code"?: "GGV-...",
  "customer"?: "<id>",
  "tenders": [ TenderInput, ... ],             // replaces payment / payment_split for new callers
  "voided"?: [{ "title", "qty", "amount" }]   // lines removed from this ticket before payment
}
```

Rules, in addition to today's:
- **A session must be open** on the register for every till sale, whatever the tender (409 "Open the till first."). eBay-channel sales from imports are untouched.
- **Tenders** must sum exactly to the total after discounts (400 "The payments come to £38.00 but the total is £40.00."). At most one cash tender; `tendered` must be at least `amount` and change is `tendered - amount`; only cash gives change. `card_tide` needs `card_last4` as four digits when `settings.epos.require_card_last4` (400 "Key the last four digits of the card."). `store_credit` and `points` need a customer and the balance, as today. `part_exchange` arrives in wave 2.
- **Legacy callers** sending `payment` and `payment_split` are mapped to tenders (`sumup_card` is refused for new sales: 400 "SumUp is no longer used. Take card payments on the Tide reader."). New sales store `payment` as the single method, or `mixed`, and `payment_split` mirrored for old reports.
- **Products**: a `till_products` line takes its price from the product unless the product is open-price, where `unit_price` is required (400 "Key a price for Single card."). Its title is the product name, or `title` when given for an open-price product. Membership products need a customer and create or renew the membership inside the transaction (`kind: "membership"`, `membership_tier`, `membership_months`; 400 "Attach the customer to sell a Guild Membership.").
- **Discounts and prices are checked on the server.** A line or ticket discount above `settings.epos.discount_limit_pct` of what it applies to needs `discount_over_limit`. A `unit_price` that differs from an item's or a priced product's own price needs `price_override`. Both are 403 `needs_override` without the capability or an override; the override's approver is written on the sale's audit row and as an `override` till event.
- **VAT**: each line stores `vat_rate` and `vat_amount` (VAT inside the line's net, rounded half-up per line); the sale stores `vat_total`. Only standard-rated lines when `settings.vat_registered`; margin-scheme lines are always 0.
- **Voids** listed in `voided` are written as `void_line` till events in the same transaction.
- Writes one `sale_tenders` row per tender, the cash movement for the cash tender's amount (not what was handed over), and links the sale to the register and session.

Response adds `"tenders": [Tender], "change": <pence>, "vat_total": <pence>, "receipt": { "number": "GG-S-000456" }`. A replayed `client_id` returns the first sale's body, as today.

### `GET /api/vault/sales/lookup?number=GG-S-000456` (staff)

Also accepts the barcode form without dashes. -> `{ "sale": { id, number, occurred_at, total, status, customer: { id, name, code } | null, register_name, staff_name, lines: [{ id, title, detail, sku, qty, refunded_qty, unit_price, discount, net, refundable_qty, refundable_amount, tax_scheme }], tenders: [Tender] } }`. 404 "No sale has the number GG-S-000999."

### `POST /api/vault/sales/{id}/refund`, extended

```
{
  "register"?: "<id>",
  "lines": [{ "sale_line": "<id>", "qty": 1, "restock"?: true }],
  "reason": "...",
  "tenders": [{ "method": "cash" | "card_tide" | "store_credit", "amount": <pence>, "card_last4"? }]
}
```

- Needs capability `refund` (an override when the role lacks it). **Step-up is no longer required**; the legacy `refund_method` still works for old callers.
- The tenders must sum to the refund amount the shared `breakdown` gives for those lines. A cash refund needs the register's open session and enough cash expected in the drawer (409 "The drawer should only hold £12.40. Refund the rest to card or store credit."). A card refund is done on the Tide reader by hand; the till records it.
- `restock: false` leaves the item as it is (damaged returns); the default puts it back in stock as today.
- Writes negative `sale_tenders` rows with `refund_ref` = `<sale number>-R<n>` (n counts this sale's refunds), the cash movement, and audits `sale_refund` with the approver.
- Response: `{ "sale": {...}, "refund": { "ref": "GG-S-000456-R1", "amount", "tenders": [Tender] } }`.

### Parked tickets (`parked_tickets`; staff list, view, create, update, delete through the collection API)

`register`, `label` (required, 60), `customer` (relation), `staff`, `payload` (json up to 200 kB: the ticket exactly as the counter holds it), `total`, `item_ids` (json array), `created`, `updated`. The counter warns when an item on the ticket it is building is also on a parked ticket. Parked tickets block the Z report (above).

### The till catalogue

`till_categories`: `name`, `sort`, `active`, `filter` (json, optional: `{ "kinds"?: [...], "games"?: [...] }` makes it a dynamic category listing in-stock stock lines that match). Staff list and view; manager create, update and delete.

`till_products`: `name`, `kind` (`service` | `open_price` | `membership` | `deposit`), `price` (pence; ignored for `open_price`), `category`, `image` (file), `tax_scheme` (`standard` | `margin` | `exempt`), `vat_rate` (default 20), `barcode` (unique where set), `membership_tier`, `membership_months`, `active`, `sort`. Staff list and view; manager writes. Seeded: "Single card" (open price, margin), "Table time, 1 hour" (service, £5.00, standard), "Event entry" (open price, standard), "Deposit" (deposit, open price, exempt), "Guild Membership, 12 months" (membership, £24.00, standard, the paid-plan tier, 12 months).

`till_keys`: `category`, `position` (int), `item` (relation, a stock line) or `product` (relation), `label` (optional override). Staff list and view; manager writes. Seeded quick keys: the five products on a "Quick" category.

`GET /api/vault/till/catalogue` (staff) -> `{ "categories": [{ id, name, sort, dynamic, keys: [{ id, position, label, product?: { id, name, kind, price, open_price, image_url, tax_scheme }, item?: { id, sku, title, price, qty, image_url, kind, status } }] }] }`. One call loads the till; it is added to the service worker's read-through caches for offline reading.

`GET /api/vault/till/category/{id}/items?q=&page=` (staff) -> `{ "items": [...], "page", "total" }` for a dynamic category.

### Receipts data

`GET /api/vault/sales/{id}/receipt?refund=<ref>&gift=1` (staff) -> `{ "receipt": ReceiptData }`. With `refund`, the refund's receipt. With `gift`, the same data; the renderer hides prices. Reprinting is capability `reprint` and writes a `reprint` till event (the counter sends `?reprint=1`).

`POST /api/vault/sales/{id}/receipt/email` (staff): `{ "email"?: "..." }` -> 202 `{ "sent_to": "s***@example.com" }`. Defaults to the customer's email. 400 "There is no email address for this sale. Type one in." Uses the existing mail settings and `test_mode`.

### Customer display (B2 server, F1 counter)

The sale payload gains `stage` (`"basket"` | `"card"` | `"cash"` | `"done"`), `amount_due`, `change` and `points_earned`. `lib/display.js` `sanitise` allows exactly those, as numbers or that one enum.

### Locked down

`sales`, `sale_lines`, `sale_tenders`, `cash_sessions`, `cash_movements`, `till_reports`, `till_events` and `till_overrides`: no create, update or delete by any staff token through the collection API (`null`), so a sale, a drawer or a Z report can only change through a route that audits it. Admin and superuser repairs go through `/_/`.

---

## 5. SumUp removed (B2 server, F2 web)

Removed: `pb_hooks/sumup.pb.js`, `pb_hooks/crons_sumup.pb.js`, `pb_hooks/sumup_readers.pb.js`, `pb_hooks/lib/sumup.js`, `pb_hooks/lib/readers.js`, `pb_hooks/adapters/sumup.js` and its fixtures and fixture routes, the SumUp export, the SumUp parts of the sale route, the check.sh sections that exercised them and the adapter tests. Kept: the `sumup_checkouts` and `sumup_transactions` collections and their data, `sales.sumup_ref`, `sales.sumup_checkout`, and `sumup_card` as a historic tender. Reports label historic SumUp card sales "Card (SumUp)".

---

## 6. Printing (P: `pb_hooks/printing.pb.js`, `pb_hooks/lib/printing.js`, `apps/web/src/features/printing/receipt/`)

### Collections

`printers` (staff list and view without `token_hash`; writes through routes): `name`, `model`, `mac` (unique, lowercase `aa:bb:cc:dd:ee:ff`), `token_hash` (hidden), `register` (relation), `paper_width` (80 | 58), `active`, `last_poll_at`, `last_status`, `encodings`.

`print_jobs` (staff list and view; writes through routes): `printer`, `kind` (`receipt` | `gift_receipt` | `refund_receipt` | `x_report` | `z_report` | `drawer` | `test`), `ref` (the sale, report or event id), `format` (`image/png` | `text/plain` | `application/vnd.star.line`), `file` (png), `text`, `drawer` (bool), `cut` (bool), `status` (`queued` | `printing` | `done` | `failed` | `cancelled`), `attempts`, `error`, `created_by`, `claimed_at`, `printed_at`.

### Routes

`POST /api/vault/printers` (admin): `{ "name", "mac", "register", "paper_width"?: 80, "model"? }` -> 201 `{ "printer": Printer, "url": "https://<appURL>/api/vault/cloudprnt/<token>" }`. The URL is shown once (the token is stored as a sha256); type it into the printer's CloudPRNT settings.

`PATCH /api/vault/printers/{id}` (admin), `POST /api/vault/printers/{id}/rotate` (admin, a new URL), `DELETE /api/vault/printers/{id}` (admin).

`GET /api/vault/printers` (staff) -> `{ "printers": [{ id, name, model, mac, register, register_name, paper_width, active, last_poll_at, last_status, online }] }`, `online` when it polled in the last 30 seconds.

`POST /api/vault/print/jobs` (staff; multipart with `file` for a PNG, or JSON with `text`): fields `register` or `printer`, `kind`, `ref`, `drawer`, `cut` (default true), `copies` (1 to 3) -> 201 `{ "job": PrintJob }`. A PNG must be the printer's width (576 px at 80 mm, 384 px at 58 mm) and at most 2 MB. 409 "No receipt printer is set up for Counter. Add one under Settings, Printers." 

`POST /api/vault/print/drawer` (staff): `{ "register"? }` -> 201 `{ "job": PrintJob }`. Opens the drawer with no paper: a `application/vnd.star.line` job holding only the drawer command when the printer lists that encoding, otherwise a one-pixel PNG with the drawer header and no cut. Used by the counter after a cash sale with no receipt. The server routes in section 3 call the same `lib/printing.js` function.

`GET /api/vault/print/jobs?register=&status=&page=` (staff), `POST /api/vault/print/jobs/{id}/retry` (staff).

CloudPRNT (`/api/vault/cloudprnt/{token}`, printer; the protocol notes are in `pb_hooks/lib/printing.js`):
- `POST`: the printer's poll. Records `last_poll_at`, `last_status` and the MAC (404 with no body when the token or the MAC does not match). Answers `{ "jobReady": true, "mediaTypes": ["<job format>"] }` when a job is queued for it, otherwise `{ "jobReady": false }`, plus `{"request": "Encodings"}` as a `clientAction` once until the printer has reported them.
- `GET ?uid=&type=&mac=`: the oldest queued (or still printing) job: marks it `printing`, sets `claimed_at` and `attempts`, returns the body with its `Content-Type` and the headers `X-Star-CashDrawer: start` (or `none`), `X-Star-Cut: full; feed=true` (or `none`) and `X-Star-ImageDitherPattern: none`. 404 when there is none; 415 for a type the job is not in.
- `DELETE ?uid=&mac=&code=`, or `GET` with `delete`: `code=OK` marks the job done; anything else marks it failed with the code, and it is queued again until its third attempt.
Rate limited to 120 a minute per token. Cron `print_jobs_tidy` (every 5 minutes): a job `printing` for over two minutes goes back to `queued`; files of jobs done more than seven days ago are deleted.

### The renderer (web)

`apps/web/src/features/printing/receipt/index.ts` exports:

```ts
renderReceiptImage(receipt: ReceiptData, opts: { width: 576 | 384; gift?: boolean }): Promise<Blob>
renderTillReportImage(report: TillReport, opts: { width: 576 | 384 }): Promise<Blob>
printReceipt(input: { saleId: string; register?: string; gift?: boolean; refundRef?: string; drawer?: boolean; reprint?: boolean }): Promise<PrintOutcome>
printTillReport(input: { reportId: string; register?: string }): Promise<PrintOutcome>
openDrawer(register?: string): Promise<PrintOutcome>
type PrintOutcome = { ok: true; jobId: string } | { ok: false; message: string }
```

Receipts are drawn on a canvas in the app's own fonts (Anton for the total, Space Mono for codes and labels, Jost for lines), black on white, thresholded to one bit, at the printer's width, with the receipt number as a Code 128 barcode and the My Vault QR (bwip-js). With no printer for the register, `printReceipt` falls back to the browser print page `/print/receipt/$id` at 80 mm.

`apps/web/src/features/settings/PrintersSection.tsx` is the Settings section (admin): the printers, online or not, add (MAC and register) with the URL shown once and copy, rotate, test print, remove.

---

## 7. Wave 2: part-exchange and exchanges in one ticket

Schema (already in `pb/pb_migrations/1789820960_epos_part_exchange.js`): `trade_ins.part_exchange_value` (pence), `trade_ins.payout_type` gains `part_exchange`; `sale_tenders.method` and `sales.payment` gain `exchange`; `TENDER_METHODS` and `TENDER_LABELS` in `epos-types.ts` carry `exchange` ("Exchange"). `sales.trade_in` and `trade_ins.sale` link a part-exchange's two halves.

### Part-exchange (EPOS-PLAN decision 5)

The customer brings items in and puts their value towards what they are buying. The trade is valued at **credit** rates (the value stays in the shop), with the shared offer calculator, exactly as a buy-in's credit offer.

At the till, the Trade-in panel builds a **draft trade-in** for the ticket's customer through the collection API, as the buy-in wizard does today (`trade_ins` with `status: "draft"`, `channel: "counter"`; its `trade_in_lines` with market price, offers and `accepted`), with each accepted line's `offer_price` set to its **credit** offer. A trade-in needs a customer: the panel asks for one first.

`POST /api/vault/sales/complete` gains:

```
{
  "trade_in": "<draft trade-in id>",
  "trade_settlement": {
    "surplus": "credit" | "cash",          // only when the trade is worth more than the sale
    "surplus_cash"?: <pence>,              // cash: what the customer is paid, at most the surplus
    "terms_accepted": true,
    "signature"?: "data:image/png;base64,...",
    "id_check"?: { ...exactly the buy-in's id_check... }
  }
}
```

The server, inside the sale's own transaction:

1. Checks the trade-in: draft, offered or accepted; the sale's customer; at least one accepted line. Its value `V` is the sum of accepted `offer_price x qty`.
2. Works out the sale total `S` after discounts, perks and rewards, then `A = min(V, S)`: what the trade pays towards the sale, written as one `part_exchange` tender of `A`. The other tenders must add up to `S - A` (they may be none).
3. The surplus `U = V - A`:
   - `credit`: paid as store credit, `payout_credit = U`;
   - `cash`: `payout_cash = surplus_cash` (1 to `U`; staff key the cash-rate figure, the till suggests it from the lines' cash offers) and any of `U` not paid in cash is lost to the shop by agreement, so the till shows both figures before Complete. The buy-in rules apply to that cash exactly as they do to a buy-in's: the open session, the cash cap, the customer's address and a verified, unexpired ID (or `id_check` in the same call), 18 or over; the cash is a `payout` movement on the session.
4. Completes the trade-in with the same steps as `POST /api/vault/trade-ins/{id}/complete` (number, seller snapshot, items in stock at `cost = offer_price`, labels queued, the signature, audit), with `part_exchange_value = A`, `payout_type` `part_exchange` when there is no surplus (otherwise `credit` or `cash`), and `sale` set. That route's logic moves into `pb_hooks/lib/tradeincomplete.js` so the route and the sale share it; the route's behaviour does not change.
5. **Points once**: the sale earns its points on its whole value as any sale does; the trade-in earns trade-in credit points only on a credit surplus `U`, never on `A`.
6. Links `sales.trade_in` and `trade_ins.sale`; the sale's response adds `"trade_in": { "id", "number", "value": V, "applied": A, "payout_cash", "payout_credit" }`; the receipt's `trade_in` block carries the same, and the trade lines appear on it as `kind: "trade"` lines with negative totals.

Refusals: 400 "Add the customer before taking a trade-in." (no customer); 409 "That trade-in has already been completed." ; 400 "The payments come to £8.00 but £10.00 is left after the trade-in." ; the buy-in's own sentences for the ID gate and the cash cap; 400 "Pay the surplus as credit or cash." when `U > 0` and no `surplus`.

On the X and Z: `trade_ins.part_exchange_value` sums the `A`s; `cash_paid` and `credit_issued` count only surpluses; the `part_exchange` tender row shows what trade took.

### Exchanges and returns in the ticket

`POST /api/vault/sales/complete` gains `"returns": { "sale": "<original sale id>", "lines": [{ "sale_line", "qty", "restock"? }], "reason": "...", "tenders"?: [...] }`.

Inside the same transaction, the server refunds those lines of the original sale exactly as `POST /api/vault/sales/{id}/refund` does (the shared `breakdown`, `refund_count` and the `-Rn` reference, restock, points reversed, capability `refund` with an override when the role lacks it), for a refund value `R`. Then `E = min(R, S)` is applied to the new sale as one `exchange` tender, and written on the refund as a negative `exchange` tender of `E` under its reference, so nothing moves in the drawer for that part. When `R > S`, the rest `R - S` goes back through `returns.tenders` (cash, card or store credit, as a refund) and the new sale takes no other tender. A ticket may hold returns and no new lines at all: then it is simply a refund.

The response adds `"refund": { "ref", "amount": R, "exchange": E }`; the new sale's receipt shows the returned lines as `kind: "return"` with negative totals and an `Exchange` tender; the refund's own receipt still prints from `?refund=`.

### Packages

**B3** (server): `lib/tradeincomplete.js` (moved out of `tradeins.pb.js`), the sale route's `trade_in`, `trade_settlement` and `returns`, the receipt's trade and return lines, the till report's part-exchange figures, `pb/scripts/checks/31-part-exchange.sh`. **F3** (web): the till's Trade-in panel (the buy-in wizard's line entry and offers, the surplus choice, the ID step and the signature, inside the till) and returns into the ticket as negative lines with the Exchange tender; demo mode; e2e.

---

## 8. As built (wave 1)

Where the build settled something the sections above left open, or changed it on review:

- **The Z count is the whole drawer.** `counts` on `POST /api/vault/till/z` is everything counted before any bank drop; `bank_drop` is taken from what was counted (400 "You cannot bank more than the £312.40 you counted." above the count). The report keeps `counts` as keyed and gives `cash.counted` and `cash.expected` both after the drop, so `variance` is the same either way.
- **`GET /api/vault/till/current?running=0`** skips the unsaved running report; the till polls it every 30 seconds just to know whether it is open.
- **A refund needs the register's open session whatever the tender**, not only for cash, so every refund lands on an X and a Z.
- **A sale's tenders read back in `TENDER_METHODS` order** (cash, then card, then the rest), because rows written in one transaction share their `created` time.
- **Line notes**: a sale line may carry `note` (200 characters), kept on `sale_lines.note`.
- **Per-refund lines** are in the `sale_refund` audit row's `meta.lines`; the refund receipt reads them from there.
- **A Z report cannot be changed or deleted by anybody**, a superuser included: a record hook refuses it beneath the null collection rules.
- **Approvals are single use whatever they approve**, a read included (`GET /api/vault/till/reports` spends an override it was given).
- **Overrides for `settings_manage` and `staff_manage` are refused at issue** (403 "That needs an admin signed in.").
- **Unlock and the roster answer a staff member still on `must_change_password`**, as does `POST /api/vault/staff/me/password`, which is how such a member leaves the lock; deactivating somebody rotates their token key.
- **Printers**: an encodings request is repeated until the printer answers; a job's attempts count when the printer takes it; the drawer-only `application/vnd.star.line` job is a single BEL byte.
- Every refusal sentence the routes added beyond the ones above is in the route's own file and its `pb/scripts/checks/` section.
