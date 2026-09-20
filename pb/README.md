# GG Vault PocketBase backend

The backend for GG Vault: a single PocketBase v0.40.4 instance holding every
collection in `docs/PLAN.md`'s data model, with server-side logic in
`pb_hooks` and schema/seed data in `pb_migrations`. See `docs/PLAN.md` for
the full product and architecture picture; this file is the how-to for this
directory.

## Running locally

1. Get the PocketBase binary. Two ways:
   - Run `pnpm pb` (or `bash pb/scripts/dev.sh`) once: if `pb/pocketbase`
     is missing it downloads the pinned version (`PB_VERSION`, default
     `0.40.4`) for your OS and architecture and starts the server.
   - Or copy/build a `pocketbase` binary yourself to `pb/pocketbase` and
     `chmod +x` it (git-ignored, never committed).
2. `pnpm pb` starts the server at `http://127.0.0.1:8091` (override with
   `PB_PORT`), serving `pb_hooks`, `pb_migrations` and `pb_public` from
   this repo. `--automigrate` is on by default, so every migration under
   `pb_migrations/` applies automatically on first start.
3. Open `http://127.0.0.1:8091/_/` and follow the prompt to create your
   PocketBase **superuser** (the platform admin account, separate from
   the app's own `staff` collection). MFA for superusers is a Caddy/VPS
   concern in production (`docs/PLAN.md`, "Security, GDPR and record
   keeping"), not something this repo configures.
4. Everything the app itself needs (games, platforms, locations, label
   templates, default pricing rules, the loyalty programme and its
   starter tiers, settings, the three counters) is seeded automatically
   the first time migrations run - see "Migrations and seeds" below.

Environment variables:
| Variable | Purpose |
|---|---|
| `PB_VERSION` | Pins the binary `pb/scripts/dev.sh` downloads (default `0.40.4`). Also the version baked into `pb/Dockerfile`'s `PB_VERSION` build arg and the literal in `pb_hooks/routes.pb.js`'s `/api/vault/health` response - keep the three in step if it ever changes. |
| `PB_PORT` | Local dev port for `pb/scripts/dev.sh` (default `8091`). |
| `GG_ADMIN_EMAIL`, `GG_ADMIN_PASSWORD` | See "Creating the first admin" below. |
| `GG_ID_PHOTO_KEY` | **Required in production.** Exactly 32 characters (`$security.encrypt` is AES-256-GCM and rejects any other length). Encrypts every ID photo before it is written, and peppers the step-up token signing key. `POST /api/vault/customers/:id/id-check` refuses with 500 rather than storing a photo in the clear without it, and `GET /api/vault/id-photo/:id` cannot decrypt without it. It lives in the environment, never in `pb_data`, so a stolen database backup has no readable ID photos in it. Add it to `deploy/.env.example` and generate one per install, for example `openssl rand -base64 24 \| cut -c1-32`. **Changing it makes every stored photo undecryptable** - rotate only alongside a purge. |
| `GG_ADAPTER_TRANSPORT_MODE` | `offline_fail` makes every adapter in `pb_hooks/adapters/*.js` throw the instant it tries to reach the real network, instead of calling out. `fixture` instead hands the call to `pb_hooks/adapters/fixture_transport.js`, which answers a known set of calls from `pb_hooks/adapters/fixtures/` and throws for anything else - the same safety net as `offline_fail`, but able to serve a real (fixture) response for the calls it knows. `pb/scripts/check.sh` runs its whole throwaway server under `fixture`, so its route-level Phase 3 checks exercise the real routes end to end with no live network call, and still fail loudly rather than silently passing on a call this build never intended to make. Unset (the default) in dev and production - adapters call out normally. |

## Migrations and seeds

`pb_migrations/*.js` run in filename order (PocketBase sorts them, hence
the timestamp prefixes) and are split the way the brief asked, one
concern per file:
| File | Collections |
|---|---|
| `..._auth_collections.js` | `staff`, `customers`, `customer_private`, `id_documents` |
| `..._catalogue_collections.js` | `games`, `platforms`, `card_sets`, `cards`, `retro_titles`, `price_snapshots`, `fx_rates` |
| `..._stock_collections.js` | `locations`, `items`, `want_list`, `stock_counts`, `stock_count_lines` |
| `..._trading_collections.js` | `quotes`, `trade_ins`, `trade_in_lines`, `notes`, `credit_ledger` |
| `..._selling_cash_collections.js` | `cash_sessions`, `cash_movements`, `sales`, `sale_lines`, `counters` |
| `..._loyalty_collections.js` | `loyalty_programme`, `loyalty_rules`, `loyalty_tiers`, `memberships`, `loyalty_rewards`, `reward_redemptions`, `points_ledger`, `perk_usage`, `referrals` |
| `..._ops_collections.js` | `pricing_rules`, `label_templates`, `label_jobs`, `sumup_transactions`, `csv_imports`, `daily_stats`, `saved_reports`, `notifications`, `push_subscriptions`, `audit_log`, `settings` |
| `..._seed.js` | Row data: `games`, `platforms`, `locations`, `label_templates`, `pricing_rules`, `loyalty_programme`, `loyalty_tiers`, `settings`, `counters`, and the first admin `staff` account (see below) |
| `..._phase2_fields.js` | Appends what the custom routes need: `id_documents.mime`; `settings.cash_variance_alert`, `.offer`, `.default_intake_location`, `.email`, `.receipt_terms` (and their defaults on the seeded row); `trade_in_lines.kind`, `.game`, `.completeness`; and it makes `trade_ins.number` optional with a partial unique index (see below) |
| `..._phase2_refunds_and_protection.js` | `sale_lines.refunded_qty`, `sales.refunded_total` and `trade_ins.id_document`; makes `trade_ins.signature` and `quotes.photos` `protected`; and adds the partial unique index that allows only one open `cash_sessions` row (`WHERE closed_at = ''`) |
| `..._single_bands_any_condition.js` | Data fix: the seeded single `pricing_rules` bands were NM-only, so every other condition matched no rule. Condition is applied by `adjustForCondition` before a rule is chosen, so the bands are condition wildcards |
| `..._trade_in_line_overrides.js` | `trade_in_lines.override_reason` (which is also the override flag), `.override_cash`, `.override_credit` and `.cosmetic_grade` |
| `..._phase3_adapter_state.js` | `adapter_state` (new, superuser-only: OAuth tokens and small caches the catalogue and price adapters need between requests); `cards.image_file` (a cached local copy of a card's artwork, re-hosted by `pb_hooks/adapters/images.js`); merges `ebayHaircutPct: 15` into the existing seeded `settings.offer` JSON |
| `..._batch_api_settings.js` | Turns on PocketBase's own Batch API (app-level `settings.batch`, not this app's `settings` collection): `enabled: true`, `maxRequests: 200`, `maxBodySize` 128 MB, `timeout` 60s, so `services/pricesync`'s nightly sync needs no manual dashboard step on a fresh install. |
| `..._sales_client_id.js` | `sales.client_id` (the offline queue's idempotency key) with a partial unique index, same shape as `trade_ins.number` |
| `..._stock_counts_close_rule.js` | `stock_counts.updateRule` gains `&& @request.body.status:isset = false`, so `status` can only ever be set at create time or by `stockcounts.pb.js`'s close route |
| `..._image_limits_and_fx_date.js` | `cards.image_file` / `retro_titles.cover` gain `mimeTypes` (`image/jpeg`, `.png`, `.webp`, `.avif`) and a 2 MB `maxSize`, matching `pb_hooks/adapters/images.js`'s own `MAX_IMAGE_BYTES`; `fx_rates.date`, the ECB rate's own date (see "Card and price adapters" below) |
| `..._stock_counts_one_open.js` | A partial unique index, `stock_counts (location) WHERE status = 'open'` - only one count may be open per location at once, same shape as `cash_sessions`' one-open-session index. The unique violation this can raise on create is mapped to a plain 409 by `stockcounts.pb.js`'s own `onRecordCreateRequest` hook |
| `..._phase4_exports_imports_sumup.js` | `sales.channel` (`counter` \| `ebay`) and `sales.external_ref`; `settings.import_mappings` (seeded with the Card Uploader and eBay orders mapping skeletons from `docs/csv-formats.md`) and `settings.sumup` (`{ merchant_code }`); merges an empty `api_keys.sumup` into the existing `api_keys` blob, same pattern as `..._phase3_adapter_state.js`'s `offer.ebayHaircutPct` |
| `..._phase4_stats_reports_hardening.js` | `daily_stats.sales_refunded` (the net-of-refunds field every report's revenue reads - `docs/api-contract.md`'s Phase 4 section); `items.listed_at` (set by `items.pb.js`'s own hook, backfilled here to `updated` for every row already `listed_ebay`); tightens `saved_reports`' rules - a staff member may only touch their own rows, and setting `recipients` or `schedule` needs `role = "admin"` regardless of whose row it is |

`trade_ins.number` starts life empty. Drafts and their lines are created
through the collection API and the number is only assigned from
`counters.trade_in` at completion, so a required `number` would make a
draft impossible to create and would burn a number on every abandoned
one. `..._phase2_fields.js` therefore drops `required` and rebuilds the
unique index as a partial one (`WHERE number != ''`), which keeps the
numbers that do exist unique while any number of drafts sit at `""`.

A few collections need a relation to one that is defined in a *later*
file (`customers.referred_by` to itself, `customer_private.tier` to
`loyalty_tiers`, `items.trade_in_line` to `trade_in_lines`,
`trade_ins.cash_session` to `cash_sessions`). Each of those is created
without that one field, then the later file that owns the target
collection patches it on with `collection.fields.add(new Field({...}))`
once `app.findCollectionByNameOrId(...)` can resolve a real id for it.
The matching `down()` removes the patched field before deleting its own
collections, so `migrate down` unwinds cleanly.

Every collection gets `created`/`updated` `autodate` fields, and every
money amount is an integer number field in GBP pence with `onlyInt: true`
(`docs/PLAN.md`, "Currency: GBP everywhere"). Percentages, FX rates and
VAT rates are plain (non-`onlyInt`) numbers, since they are not money.

Re-running `pnpm pb` against an already-migrated `pb_data` is a no-op for
schema; to start over, stop the server and delete `pb/pb_data` (it is
git-ignored).

### Creating the first admin

Set `GG_ADMIN_EMAIL` and `GG_ADMIN_PASSWORD` before the seed migration
runs (i.e. before the first `pnpm pb`, or before deleting `pb_data` and
starting again):

```sh
GG_ADMIN_EMAIL=you@ggentertainment.co.uk GG_ADMIN_PASSWORD='a-strong-password' pnpm pb
```

The seed migration then creates a `staff` row with `role: "admin"`,
`active: true` and that password. If neither variable is set, the
migration logs a one-line hint and skips this step - so a fresh clone
never ships a guessable default login. If you have already migrated
without them, either delete `pb_data` and start again with the variables
set, or add the first admin by hand from the PocketBase superuser
dashboard (`/_/`, the **staff** collection, "New record") or with a
one-off script that calls `app.save(new Record(...))`.

## Hooks (`pb_hooks/`)

Each `.pb.js` file registers one or more hooks with the globals
PocketBase injects (`onRecordCreate`, `routerAdd`, `cronAdd`, `$app`,
`$security`, `$os`, ...). **Every hook handler is executed in its own
isolated goja context** - confirmed while building this backend: a plain
top-level `const` referenced from inside a `routerAdd` handler threw
`ReferenceError: ... is not defined` at request time, even though the
file loaded and registered without complaint at startup. Two rules
follow from that, applied throughout:

- `require()` a shared module *inside* the handler that uses it, never
  once at the top of the file.
- Likewise, define any helper function or constant a handler needs
  *inside* that handler's own function body, not at file top level.

The other empirical finding worth knowing: **a handler must call
`e.next()` at most once.** A test registering an `onRecordCreate` handler
that retried a failed `e.next()` by mutating the record and calling
`e.next()` again a second time returned an HTTP 200 with a record body
that was never actually written to the database. Every hook here that
needs a unique random value (SKUs, customer codes, voucher codes)
therefore checks uniqueness itself with `findFirstRecordByFilter` in a
retry loop *before* calling `e.next()` exactly once, rather than
retrying `e.next()` on a unique-constraint failure.
| File | What it does |
|---|---|
| `lib/shared/{sku,money,pricing,loyalty,saleline}.js` | **Generated, do not edit.** A CommonJS build of `packages/shared/src/{sku,money,pricing,loyalty,saleline}.ts` via `pnpm --filter @gg/shared build:hooks`, so the hooks, the frontend and the admin loyalty-rule preview all share one implementation. `sku.js` is the one used here: `generateCode(kind, randomByte)`, `parseCode`, `buildCode`, `CROCKFORD_ALPHABET`, `CODE_KINDS`. |
| `lib/audit.js` | `writeAuditLog(app, { actor, action, collection, record, meta, ip })` - one row in `audit_log`. |
| `lib/counters.js` | `nextNumber(app, "trade_in" \| "sale" \| "redemption")` - atomically bumps the matching row in `counters` and returns `GG-BI-000123` / `GG-S-000456` / `GG-V-000012`. Transaction-agnostic: pass `$app`, `e.app`, or a `txApp` from `$app.runInTransaction`. |
| `lib/balances.js` | `recompute(app, customerId)`, `creditBalance`, `pointsBalance` - the cached `customer_private.credit_balance` / `.points_balance` recomputed by **summing the ledgers**, never by adding a delta, so a cache that has drifted repairs itself on the next write. |
| `lib/vaultutil.js` | Route plumbing: request body and query reading (`body`, `asInt`, `asStr`, `asBool`, `jsonField`), `requireAdmin`, `saleLineRows` / `asSoldLines` (a sale's lines in the one `created,id` order the shared `saleline` breakdown may be worked out in, and as the shape it reads), the `settings` / `offerSettings` / `emailSettings` / `programme` / `loyaltyRules` / `tier` loaders in the shapes `packages/shared`'s evaluators expect, `openCashSession` / `sessionMovements` / `sessionExpected`, date helpers (`addMonths`, `ageAt`, `isPast`) and CSV escaping. |
| `lib/stepup.js` | `issue(staff)` and `requireStepUp(e)` - see "Step-up" below. |
| `lib/base64.js` | `encode`, `decode`, `fromDataUrl`. goja has no `atob`/`btoa` and PocketBase exposes no base64 binding, so the signature data URL carries its own codec. Both directions are linear (accumulate into an array, join once). ID photos no longer come through here at all - see "ID photos" below. |
| `lib/receipts.js` | `build(app, tradeIn, settings, fileToken)` (the receipt JSON) and `render(receipt)` (the plain-text and HTML email bodies), so the print page and the email can never drift. |
| `lib/csv.js` | The one place every Phase 4 export or import route builds or reads a CSV through. `row()`/`cell()`/`pounds()` wrap `lib/vaultutil.js`'s own `csvRow`/`csvCell`/`poundsCell`; `parse()` is a small RFC 4180 reader (quoted fields, embedded commas and newlines, CRLF or LF); `mapRows()` resolves a parsed file's header row against a mapping config's own header-name aliases (`docs/csv-formats.md`); `queryParam()`/`dateParam()` read a GET route's own query string - kept here rather than in `lib/vaultutil.js` because a `routerAdd` handler cannot see a plain function declared at the top of its own `.pb.js` file (see above), and `exports.pb.js` now has six handlers that all need one. |
| `lib/imports.js` | Row-level matching and writes for the two CSV importers in `imports.pb.js`: the seeded default mapping for each (a fallback for the settings row's own `import_mappings`), `readCsvUpload(e)` and `declaredType(e)` (the shared multipart plumbing, required rather than duplicated across the two routes for the same isolation reason as `lib/csv.js` above), and `processCardUploaderRows` / `processEbayOrdersRows`, the row-by-row logic `docs/api-contract.md`'s Phase 4 section documents. |
| `lib/sumup.js` | PocketBase-specific glue behind `sumup.pb.js` and `crons_sumup.pb.js`: `pull(app, actorId, ip)` upserts `sumup_transactions` from `adapters/sumup.js` and matches each to a sale (by a SKU-prefixed product name, then by amount and a three-minute time window), and `reconcile(app, date)` builds the Cash screen's day-by-day comparison. See `docs/api-contract.md`'s Phase 4 section for the matching rules and response shapes. |
| `lib/reports/{dates,query,daily,csv,registry,scheduled,digest,sales,buyins,margin,stock,channels,customers,loyalty,cash,compliance}.js` | Every real handler behind `reports.pb.js`, `stats.pb.js` and `crons.pb.js`'s three reporting crons, kept out of the `.pb.js` files themselves per CLAUDE.md's "keep hooks small". `dates.js` is the pure UTC day/range/week/month math (no PocketBase calls of its own) plus `toLondon`/`isBst`/`lastSundayUtc`, a hand-rolled Europe/London civil-clock conversion for the sales heatmap only (goja has no reliable timezone database); `query.js` a memoising `findRecordById` lookup, the finish-aware "what is this stock item currently worth" figure `daily.js` and `stock.js` both read, `roundPct`/`roundRatio` (the one shared half-up rounding to 1dp/3dp every percentage/ratio in this package goes through), `queryByIds`/`findAllByFilter` (a batched-by-id query and a paged unbounded-list read, replacing what used to be one query per parent id or one single unbounded read), `saleBreakdownsByLine` (every sale referenced by a batch of `sale_lines`, fetched once and broken down with the shared `saleline` evaluator), and a small `by=<dimension>` table accumulator; `daily.js` is `daily_stats`'s pure builder (`buildDayRow`), its stock-valuation half (`currentStockValuation`, computed once and shared across a whole batch rather than once per day), its find-or-create upserts (`upsertDayRow` / `upsertDayRows`, the latter tolerating one bad day without failing the rest) and the read-through the reports use (`rowForDate` / `rowsForEachDay`, live for any day the nightly cron has not reached yet, `rowsForEachDay` batching a whole range in one query); `csv.js` renders a report's `table` through `lib/vaultutil.js`'s own `csvRow`/`csvCell`; `registry.js` is the one place all nine report keys (and which are admin-only) are named; `sales.js` through `compliance.js` are the nine reports themselves, one file each, each declaring its own `MONEY_FIELDS` (which `totals` keys are pence, for `scheduled.js`'s emailed totals) and `PERIOD_SCOPED_TOTALS` (which `totals` keys `compare=previous` may show); `scheduled.js` sends due `saved_reports` rows - re-checking at send time that an admin-only report's owner is still a current admin, and re-validating `recipients` (shape, dedup, capped at 10) rather than trusting what was saved - `digest.js` the Monday admin digest. See `docs/api-contract.md`'s Phase 4 section. |
| `items.pb.js` | On create: assigns `sku` when empty (kind to letter, then a 5-character body drawn uniformly with `$security.randomStringWithAlphabet` and turned into a code with `sku.buildCode`, retried on collision - see above); derives `title` from the linked `card` or `retro_title` when empty; after the item is saved, opportunistically re-hosts its card's image through `adapters/images.js` if it is still a bare third-party URL - never blocks the create on a failure. A separate `onRecordUpdate` hook sets `listed_at` to now the moment `status` most recently became `listed_ebay`, and clears it the moment `status` leaves `listed_ebay` again - the channels report's listing-age figure reads this (falling back to `acquired_at` when blank), `docs/api-contract.md`'s Phase 4 section. |
| `customers.pb.js` | `onRecordCreateRequest`: sets a random password (customers are OTP-only, but the field still exists - `docs/PLAN.md`'s Auth section). `onRecordCreate`: assigns `code` (`GGC…`, same uniform body generation as `items.pb.js`) and `qr_token` when empty. `onRecordAfterCreateSuccess`: creates the paired `customer_private` row. |
| `redemptions.pb.js` | On create: assigns `reward_redemptions.number` (`GG-V-000012`, via `lib/counters.js`) and `.code` (`GGV…`, same uniform body generation as `items.pb.js`) when empty. |
| `staff.pb.js` | `onRecordAuthRequest` on `staff`: refuses to authenticate (issue a token, refresh one, ...) an account with `active: false`, with "This account is inactive. Ask an admin to reactivate it." A deactivated staff member keeps their row (for `audit_log` actor references and historic sales/trade-ins) but cannot sign in again. |
| `singletons.pb.js` | Refuses a second `settings` or `loyalty_programme` record. |
| `audit.pb.js` | Logs deletes on `staff`, `customers`, `customer_private`, `id_documents`, `items`, `trade_ins`, `sales`, `credit_ledger`, `points_ledger` (a judgement call - PLAN.md says "sensitive collections" without naming them; revisit if Richard wants a different list), and updates to `pricing_rules` and every `loyalty_*`/`settings` collection. Uses the `*Request` hook variants because only those carry `e.auth` and `e.realIP()`; logs only after `e.next()` returns without throwing. `meta` never carries a field's *value*, only identifiers: for an update, the names of the fields that changed (`e.record.fieldsData()` diffed against `e.record.original()`, taken before `e.next()`); for a delete, one label from a short list of fields already known to be safe (`items.sku`, `trade_ins.number`, `sales.number`) or nothing at all for every other audited collection - `staff`, `customers`, `customer_private` and `id_documents` above all never contribute a label, since every field on those could be a password hash, `pin_hash`, an ID photo path or other PII. This keeps a password, `pin_hash`, ID photo or API key out of this permanent, superuser-only table, so erasing the original record actually erases it. |
| `routes.pb.js` | `GET /api/vault/health` (staff-authenticated: status, PocketBase version, a few record counts) and `GET /api/vault/me` (the caller's own `staff` fields, hand-picked so `pin_hash` can never leak). |
| `ledgers.pb.js` | `credit_ledger` and `points_ledger`: `onRecordCreate` stamps `balance_after` before the row is written (computed from the ledger as it stands plus this row, never from the cache); `onRecordAfterCreateSuccess` recomputes both cached balances through `lib/balances.js`. Both fire inside whatever transaction the caller is in, so a correction row added straight through the collection API gets the same treatment a custom route's write does. |
| `stepup.pb.js` | `POST /api/vault/step-up` - see "Custom API routes" below. |
| `tradeins.pb.js` | Buy-in completion and receipts. |
| `idphotos.pb.js` | The ID check and the ID photo view. |
| `config.pb.js` | `GET /api/vault/config`: the read-only staff window onto the admin-only `settings`, `pricing_rules` and `loyalty_*` rows, with every secret-looking settings field stripped. |
| `customerops.pb.js` | The latest ID document lookup, the duplicate-customer merge and the GDPR erasure. |
| `sales.pb.js` | Sale completion and refunds, and the `onRecordCreate` hook that defaults a new sale's `channel` to `"counter"` and `occurred_at` to now. |
| `cash.pb.js` | Cash sessions. |
| `exports.pb.js` | The stock book CSV (Phase 2), plus Phase 4's SumUp, eBay listing, inventory, sales, buy-in register and end-listings CSVs, and `POST /api/vault/items/end-listings`. |
| `imports.pb.js` | Phase 4: `POST /api/vault/imports/card-uploader`, `POST /api/vault/imports/ebay-orders`, `GET /api/vault/imports/:id`. |
| `sumup.pb.js` | Phase 4: `POST /api/vault/sumup/pull` (admin) and `GET /api/vault/sumup/reconcile` (staff), both thin wrappers over `lib/sumup.js`. |
| `crons.pb.js` | Registers `fx`, `prices`, `retention`, `stats`, `scheduled_reports_weekly`, `scheduled_reports_monthly` and `weekly_digest`. `fx` (daily 07:00) fetches today's GBP rate from Frankfurter and writes it to `fx_rates` - `GET /api/vault/fx` only ever reads that row. `prices` (weekly, Sunday 03:00, despite its name) syncs `card_sets` from TCGdex, Scryfall, Lorcast and OPTCG's own set listings; day-to-day *price* ingestion still runs in `services/pricesync`, not here (hooks cannot stream the 15-26 MB Cardmarket files). `retention` does real work (see below). `stats` (00:30 UTC) rebuilds the last 7 UTC days' `daily_stats` rows (never today) through `lib/reports/daily.js`'s `upsertDayRows`, sharing one stock valuation across the whole batch and tolerating one bad day without failing the rest - not just yesterday, so a day's row self-heals once data that arrived late (an eBay import after 00:30, a next-morning refund) is on file. `scheduled_reports_weekly` (`0 8 * * 1`) and `scheduled_reports_monthly` (`0 8 1 * *`) send every due `saved_reports` row through `lib/reports/scheduled.js`; `weekly_digest` (`0 8 * * 1`) emails the admin digest through `lib/reports/digest.js` - see `docs/api-contract.md`'s Phase 4 section. |
| `crons_sumup.pb.js` | Registers `sumup_pull` (`:15` past every hour, 08:00-22:00 UTC): `lib/sumup.js`'s `pull($app, "system", "")`. Kept separate from `crons.pb.js` (another package's file this round) - see `docs/api-contract.md`'s Phase 4 section. |
| `lookup.pb.js` | `GET /api/vault/lookup`, `GET /api/vault/lookup/:game/:set/:number`, `GET /api/vault/retro/lookup` - see "Card and price adapters" below and `docs/api-contract.md`'s Phase 3 section. |
| `prices.pb.js` | `GET`/`POST /api/vault/cards/:id/prices` and `:id/refresh-prices` and `:id/uk-comp`, `GET /api/vault/retro/:id/prices`. |
| `fx.pb.js` | `GET /api/vault/fx` - reads the latest `fx_rates` row; never calls Frankfurter itself. |
| `stockcounts.pb.js` | `POST /api/vault/stock-counts/:id/close` (admin) - see "Custom API routes" below. |
| `reports.pb.js` | `GET /api/vault/reports/:key` (and its `.csv` variant, and the separate `audit.csv` export) - the nine reports of `docs/PLAN.md`'s "Reporting" table. Resolves the key (`hasOwnProperty` plus a `typeof` check, so a prototype-chain name like `constructor` 404s cleanly rather than resolving to something inherited off `Object.prototype`) and gates admin-only keys **before** validating the date range, so a caller who cannot see a report learns nothing about whether their range would have passed either; then wires the request to the matching `lib/reports/*.js` builder, every real computation lives there. `compare=previous` only recomputes and returns each builder's own declared `PERIOD_SCOPED_TOTALS`, skipping the second `build()` call entirely when that list is empty. Every CSV export (a report's own `.csv` and `audit.csv`) is audited. See `docs/api-contract.md`'s Phase 4 section. |
| `stats.pb.js` | `POST /api/vault/stats/rebuild?from&to` (admin): rebuilds `daily_stats` for a range on demand, through `lib/reports/daily.js`'s `upsertDayRows` (one shared stock valuation for the whole range, one day's failure never sinking the rest), bounded to 400 days. Response and audit row both carry `{ days, failed }` - how many rows were written and which dates were not. |

## Custom API routes (`/api/vault/*`)

`docs/api-contract.md` is the contract these implement and is the source
of truth for the request and response shapes; this section is the
server-side notes that go with them. Every route needs a `staff` token;
**admin** also needs `role = "admin"`, **step-up** also needs a live
`X-Step-Up` header.
| Route | Notes |
|---|---|
| `POST /api/vault/step-up` | Re-checks the caller's own password, returns `{ token, expires_at }` good for 10 minutes. |
| `POST /api/vault/trade-ins/{id}/complete` | The whole buy-in in one transaction: number from `counters.trade_in`, seller snapshot, `items` (one row per unit for single/graded/retro, one row of qty n for sealed/accessory), `credit_ledger`, `cash_movements`, `points_ledger` through the shared `evaluateTradeInPoints`, one `label_jobs` row per item, and the audit row. |
| `GET /api/vault/trade-ins/{id}/receipt` | The receipt JSON, signature included as a `/api/files/...?token=` URL from `record.newFileToken()`. |
| `POST /api/vault/trade-ins/{id}/receipt/email` | Sends through PocketBase's own SMTP settings. `{ sent: false, test_mode: true }` while `settings.email.test_mode` is on. |
| `POST /api/vault/customers/{id}/id-check` | Multipart. Encrypts the photo, writes `id_documents`, verifies `customer_private`. |
| `GET /api/vault/id-photo/{id}` | **admin**, **step-up**. Audits, then decrypts and streams. |
| `POST /api/vault/sales/complete` | Stock checks, the payment split, `checkPointsRedemption` and `evaluateSalePoints`, both ledgers, the cash movement, the reward redemption and a `price_override` audit row per overridden line. |
| `POST /api/vault/sales/{id}/refund` | **step-up**. Items back into stock, lines and sale restatused, the money back by the chosen method, and the points that sale earned on those lines reversed. |
| `POST /api/vault/cash-sessions/open` | 409 when one is already open. |
| `GET /api/vault/cash-sessions/current` | `{ session, expected, movements }`, `null` session when none is open. |
| `POST /api/vault/cash-sessions/{id}/close` | Expected, counted, variance; audited as `cash_session_variance` when the variance is over `settings.cash_variance_alert`. |
| `GET /api/vault/exports/stock-book?from&to` | **admin**. The margin scheme CSV, as an attachment. One row per sale line for what is still sold, plus one for what is still on the shelf. |
| `GET /api/vault/exports/sumup.csv?since&dry_run` | SumUp's own item-import layout for `retro`/`sealed`/`accessory`/`other` stock, and sets `items.sumup_synced_at` unless `dry_run=1`. |
| `GET /api/vault/exports/ebay-listings.csv?ids` | A listing file for the given in-stock items; marks nothing. |
| `GET /api/vault/exports/inventory.csv?status&game&kind`, `/sales.csv?from&to` | Plain CSV listings of `items` and of `sales`/`sale_lines`. |
| `GET /api/vault/exports/buy-in-register.csv?from&to` | **admin**. Seller snapshots included. |
| `GET /api/vault/exports/end-listings.csv` | Sold items that still carry an `ebay_listing_id`. |
| `POST /api/vault/items/end-listings` | `{ ids }` - clears `ebay_listing_id`/`ebay_sku` on each and audits. |
| `POST /api/vault/imports/card-uploader`, `/imports/ebay-orders` | Multipart CSV imports; one `$app.runInTransaction` per file. See `imports.pb.js`, `docs/api-contract.md`'s Phase 4 section. |
| `GET /api/vault/imports/:id` | The `csv_imports` row with its `errors`, for the review screen. |
| `POST /api/vault/sumup/pull` | **admin**. Also runs hourly - see `crons_sumup.pb.js`. |
| `GET /api/vault/sumup/reconcile?date` | The day's SumUp transactions beside the day's card sales, for the Cash screen. |
| `GET /api/vault/lookup`, `/lookup/:game/:set/:number`, `/retro/lookup` | Catalogue and retro-title search, writing through to `cards`/`card_sets`/`retro_titles`. See "Card and price adapters" below. |
| `GET`/`POST /api/vault/cards/:id/prices`, `/refresh-prices`, `/uk-comp`; `GET /api/vault/retro/:id/prices` | Valuation, reading (GET) or writing (POST) `price_snapshots`. See "Card and price adapters" below. |
| `GET /api/vault/fx` | The latest `fx_rates` row. |
| `POST /api/vault/stock-counts/:id/close` | **admin**. Variance per line, an optional move of unexpected stock, `status = "closed"`. The only way `status` ever reaches `"closed"` - see "API rules" below. |
| `GET /api/vault/config` | The read-only window onto `settings`, `pricing_rules` and the `loyalty_*` rows, which are admin-only collections an ordinary staff member still has to price against. Every settings field named `api_keys`, `email`, or containing "key" or "secret", is dropped. No audit row: every counter screen loads it. |
| `GET /api/vault/customers/{id}/id-document` | The newest `id_documents` row for that customer whose photo file is still present, as ids and timestamps only. `id_documents` has every rule null, so this is the app's only way to know whether the cash ID gate will pass. |
| `POST /api/vault/customers/{id}/merge` | **step-up**. Folds a duplicate customer into the one being kept: every relation re-pointed, `perk_usage` counts summed where the two records clash on its unique `(customer, perk_type, period)` index, `customer_private` gaps filled, balances recomputed from the moved ledgers, the duplicate deleted. |
| `POST /api/vault/customers/{id}/erase` | **admin**, **step-up**. The Article 17 erasure. Refuses with 422 while the customer still holds store credit. Trade-ins, sales and the ledgers stay, seller snapshot included (Article 17(3)(b)). |
| `GET /api/vault/reports/:key` (and `:key.csv`, `audit.csv`) | The nine reports (`sales`, `buyins`, `margin`, `stock`, `channels`, `customers`, `loyalty`, `cash`, `compliance`) plus the audit log CSV export - `compliance` and `audit.csv` are **admin**. `?from&to&group=day\|week\|month&by=<dimension>&compare=previous\|none`, bounded to 400 days. No audit row for the plain reads; `audit.csv` and every `.csv` variant are. See `docs/api-contract.md`'s Phase 4 section. |
| `POST /api/vault/stats/rebuild` | **admin**. `?from&to`, bounded to 400 days. Upserts `daily_stats` for the range, one row per date, never a duplicate. |

Three patterns run through all of them.

**Validate first, write second.** Every staff-facing refusal is raised
before `$app.runInTransaction` opens, so the transaction holds writes plus
only the re-checks that have to be atomic (the trade-in is still open, the
item is still in stock, the cash session is still open). Those
re-checks record themselves in a `halt` object, throw to roll back, and
are turned into the right status code after the catch: an `ApiError`
thrown through the Go transaction boundary does **not** arrive back in JS
as itself, so throwing one from inside the callback would surface as a
bare 400.

**`cash_movements.amount` is signed.** Money out of the drawer (a payout,
a refund, a bank drop) is stored negative and money in is positive, so a
session's expected total is `float + sum(amount)` and the `adjustment`
type can say which way it went. The contract writes the same sum as
"float + cash sales + float_in - payouts - refunds - bank drops"; the
figure is identical, the sign lives on the row rather than in the reader.

**Audit meta stays to identifiers, counts and the shop's own money** -
a trade-in number, how many items and labels, a payout total, a variance.
Never a customer's name, address, ID number or photo path, for the same
reason `audit.pb.js` withholds them.

### Step-up

`POST /api/vault/step-up` takes `{ password }`, re-checks it against the
signed-in staff record and returns a JWT with `{ staffId, scope:
"step_up" }` and a 10 minute expiry. `lib/stepup.js`'s `requireStepUp(e)`
reads it from `X-Step-Up` and refuses with 403 "Confirm your password to
continue." when it is missing, expired, tampered with, or issued to
somebody else.

The signing key is `hs256("<staff id>:<staff tokenKey>", pepper)`, where
`pepper` is `GG_ID_PHOTO_KEY` when set and a fixed fallback string
otherwise. PocketBase exposes no app-wide secret to JS, and an auth
record's `tokenKey` is a 50-character random value it already keeps per
row, so this needs no secret of its own. Two consequences, both wanted: a
token only ever works for the staff member it was issued to (verification
derives the key from `e.auth`, then checks the `staffId` claim matches),
and changing that member's password or email rotates their `tokenKey`, so
every step-up token they hold stops working at once.

### ID photos

The photo bytes go straight into `$security.encrypt` as an
`Array<number>` (its `data` parameter takes one, and `$security.decrypt`'s
result goes back to bytes through `toBytes()`, byte-exact both ways), and
the ciphertext is written as a `.enc` file on `id_documents.photo`. The
MIME type is **sniffed from the first bytes** (JPEG, PNG, WebP,
HEIC/HEIF) and stored in `id_documents.mime`, so a client-supplied `mime`
field and the file's own extension are both ignored and a page of HTML
named `photo.jpg` cannot be stored and later served back as an image.
Uploads are capped at 8 MB, read with `toBytes(reader, cap + 1)` so an
upload that lies about its size is still refused. Without the key the
upload route refuses with 500 rather than storing a photo in the clear.
The view route writes its `id_photo_view` audit row **before** decrypting
anything, so a view that then fails is still on the record as an attempt,
and serves the bytes with `Cache-Control: no-store`,
`Content-Disposition: inline` and `X-Content-Type-Options: nosniff`.

Nothing on the photo path is base64'd. It was, and `lib/base64.js`'s
`encode` built its result one character at a time, which goja turns into a
fresh string allocation per character: 200 KB took about 15 seconds.
Encoding and decoding are both linear now (accumulate into an array, join
once), but the photo does not go near them either way; a 320 KB photo
encrypts in about 20 ms. `lib/base64.js` is still needed for the
signature on a trade-in, which arrives as a `data:image/png;base64,...`
data URL.

`trade_ins.signature` and `quotes.photos` are **protected** file fields,
so PocketBase only serves them with a short-lived file token. That token
has to be minted from the **calling staff auth record**
(`e.auth.newFileToken()`): `record.newFileToken()` throws "not an auth
collection record" on an ordinary record, which is how the receipt's
signature URL came to be served bare. `items.photos` is left public: it is
product imagery for the shop front.

### The retention cron

`cronAdd("retention", "30 3 * * *")` deletes `id_documents` whose
`expires_at` has passed (the encrypted file goes with the record) and
`notifications` older than twelve months. Each ID photo deletion writes an
audit row carrying the collection and the record id and nothing else: an
erased record whose identifying fields survive in a permanent,
superuser-only table is not really erased. Quote photos ninety days after
their quote closes still wait on a "closed at" field on `quotes`.

### The image queue cron

`cronAdd("image_queue", "*/5 * * * *")` drains `adapter_state`'s
`image_queue` entry, an array of card ids `items.pb.js`'s `onRecordCreate`
pushes onto (never fetches from) the first time an item is created against a
card whose image is still a bare third-party URL. A buy-in creates every
item inside one `$app.runInTransaction`, so `e.app` there can be that
transaction's own `txApp`; a network call at that point would hold the
whole transaction open for as long as the image host takes to answer, so
the item-create hook only ever does the one fast, local write and the
actual fetch happens later, off that path entirely, when this cron runs.
Every queued card gets one attempt with a short per-image timeout and the
queue is cleared regardless of outcome - a card whose image keeps failing
is not worth retrying every five minutes forever; the lazy cache tries
again on the next item created against that same card anyway.

### Card and price adapters

`pb_hooks/adapters/*.js` are plain CommonJS modules, not `.pb.js` hook
files: `lookup.pb.js`, `prices.pb.js`, `fx.pb.js`, `items.pb.js` and
`crons.pb.js` `require()` them, same as any other `lib/` module (see
"Hooks" above on why every `require()` lives inside a handler body).

| Module | What it talks to |
|---|---|
| `tcgdex.js` | Pokemon: TCGdex, no key. |
| `scryfall.js` | Magic: Scryfall, no key, real User-Agent required. |
| `ygoprodeck.js` | Yu-Gi-Oh!: YGOPRODeck, no key. Images **must be re-hosted** (hotlinking gets IPs banned) - every result comes back with `rehostImage: true` and `imageSmall`/`imageLarge` left blank until re-hosted. |
| `optcg.js` | One Piece: OPTCG API, no key. Images are cached locally, same reasoning as YGOPRODeck. |
| `lorcast.js` | Disney Lorcana: Lorcast, no key, under 10 req/s. |
| `igdb.js` | Retro titles: IGDB v4 over Twitch client-credentials auth. Behind `settings.api_keys.igdb` being set. |
| `pricecharting.js` | Retro prices: PriceCharting, a paid API ($49/month). PAL category searched first, NTSC only when PAL has no entry; prices are integer US cents, never a string. Behind `settings.api_keys.pricecharting` being set. |
| `ebay.js` | UK asking prices: the Browse API, application (client-credentials) auth. UK-located, GBP, fixed-price listings only; median of the five lowest, then a haircut off (`haircutPctFromSettings(app)` reads `settings.offer.ebayHaircutPct`, default 15 - the one home for this figure). Behind `settings.api_keys.ebay` being set. |
| `frankfurter.js` | FX: the ECB reference rate, base GBP. No key. Inverts Frankfurter's own "units of X per GBP" into "GBP per unit of X" once, here - see `docs/api-contract.md`'s Phase 3 section. |
| `sumup.js` | SumUp Transactions API: `GET .../transactions/history` (paged via the response's own `links`) then `GET .../transactions?id=` per transaction for `products[]`. A plain `Authorization: Bearer <key>` - a merchant API key, not OAuth, so unlike `ebay.js`/`igdb.js` there is no token to cache. Behind `settings.api_keys.sumup` and `settings.sumup.merchant_code` both being set; used by `lib/sumup.js`, not called directly from any route. |
| `http.js` | The shared `request(req, transport)` every adapter above calls out through, plus a small `pause(ms)` for a source's rate limit, a `qs(params)` query-string builder and `stripQuery(url)` (never let a key or a token reach a log line or an error message). Overridable for tests two ways: an explicit `transport` argument, or `globalThis.__adapterTransport` when no argument is given (a real request, inside PocketBase, always falls through to `$http.send` - see `pb/scripts/check-adapters.mjs`). `GG_ADAPTER_TRANSPORT_MODE` (see "Environment variables" above) changes this: `offline_fail` throws immediately, naming the call; `fixture` hands the call to `fixture_transport.js` instead. |
| `fixture_transport.js` | Answers a fixed set of known adapter calls from `pb_hooks/adapters/fixtures/` - the same files `pb/scripts/check-adapters.mjs` unit-tests each adapter against - and throws for anything it has no mapping for, same as `offline_fail`. This is what `pb/scripts/check.sh` runs its whole throwaway server under, so its route-level checks exercise a real search, an exact lookup, `refresh-prices` and the image queue end to end with no live network call. Goja-only (`$os.readFile` to load a fixture's JSON off disk) - never required under plain Node. |
| `statestore.js` | A tiny key/value store with an optional expiry, backed by `adapter_state` - `igdb.js` and `ebay.js`'s own OAuth tokens, eBay's 24-hour price cache, and `images.js`'s image queue. `forApp(app)` for PocketBase, `memory()` for tests. |
| `registry.js` | Which adapter answers for which `games.key`; recognises the "set number" query forms (`docs/api-contract.md`'s Phase 3 section), including the small per-game alias table (`sv151` for TCGdex's own `sv03.5`) and running a game's set sync once inline the first time it is needed on an install with no `card_sets` rows for it yet. |
| `storage.js` | Write-through: one adapter search result into `card_sets`/`cards`, and a `cards` row back out as the row shape the contract promises. `isFresh()` is the whole 30-day lookup cache. Refuses (rather than crashing on a later required-field validation error) to write through a result with no set code at all. |
| `pricing_policy.js` | The valuation policy behind the prices routes: this build's freshness windows (stricter than `packages/shared/src/pricing.ts`'s own default - see the contract), an adapter candidate's decimal-string-or-cents figure converted to GBP pence exactly once, condition validation and adjustment, and `price_snapshots` reads and writes. Every write goes through `writeSnapshotSafely`, which logs and skips rather than failing a whole `refresh-prices` batch over one bad candidate. |
| `images.js` | Re-hosts a URL (or bytes an adapter already fetched) into a record's file field and rewrites its `image_*` text fields to the resulting local URL, after validating the response is under 2 MB and sniffing its real type from its own first bytes (never a `Content-Type` header or a URL's extension alone). Never throws - a failed fetch must never block whatever is happening (an item create, a lookup). `enqueueImageCache(app, cardId)` / `drainImageQueue(app, timeoutSeconds)` are the queue `items.pb.js`'s `onRecordCreate` and `crons.pb.js`'s `image_queue` cron use to keep a network call off the item-create path entirely - see "The image queue cron" below. |

Every adapter's outbound call carries `User-Agent: GGVault/1.0
(+https://vault.ggentertainment.co.uk)` and a timeout (`http.js`), and API
keys are read from `settings.api_keys` only, straight off the record
server-side - never returned by any route, logged, or written to
`audit_log` (matching `config.pb.js`'s existing rule for the same
collection).

`pb/scripts/check-adapters.mjs` (`node --test pb/scripts/check-adapters.mjs`,
no PocketBase, no network) unit-tests every adapter against fixtures in
`pb_hooks/adapters/fixtures/` - recorded live where a source needs no key
(TCGdex, Scryfall, YGOPRODeck, OPTCG, Lorcast, Frankfurter), hand-written
from each API's documented shape where one does (IGDB, PriceCharting,
eBay - every such fixture's filename says `HANDWRITTEN`). `pb` is not a
pnpm workspace package (`pnpm-workspace.yaml` only covers `apps/*`,
`packages/*`, `services/*`), so this runs as a plain `node` invocation
rather than through `pnpm --filter`; `.github/workflows/ci.yml`'s
`pocketbase` job runs it straight after `pb/scripts/check.sh`.
`GG_ADAPTER_SMOKE=1 node pb/scripts/check-adapters.mjs` additionally calls
every keyless source for real, for the exact cards named above, and prints
the image URL and the price shape each one returned - it registers no
tests at all, so it skips cleanly, without the flag.

## API rules

Applied per `docs/PLAN.md`'s "API rules in short" and the brief's
conventions:

- **Staff-only**: `@request.auth.collectionName = "staff"`.
- **Admin-only**: staff-only *and* `@request.auth.role = "admin"`. Used
  for `staff`, `settings`, `pricing_rules` and every `loyalty_*`
  collection (`loyalty_programme`, `loyalty_rules`, `loyalty_tiers`,
  `loyalty_rewards`) - literally, for every rule on those collections,
  including list/view. That also blocks a plain (non-admin) staff
  member's or a customer's own read of, say, their tier's name today;
  see "Known follow-ups" below.
- **Customer-own**: `customer = @request.auth.id` (or `id =
  @request.auth.id` on `customers` itself), OR'd with staff-only so
  staff keep full access.
- **Superuser-only** (`null`): `id_documents`, `audit_log`.
- Customers can only ever **create** `quotes`, `want_list` and
  `push_subscriptions` (`customer = @request.auth.id` in each
  `createRule`), and can never delete anything. `quotes` and
  `notifications` also let the owning customer **update** their own row
  (accepting/declining a quote, marking a notification read) - that is
  an update, not a create or delete, so it does not conflict with the
  brief's "never create or delete" rule for customers.
- **Append-only** ledgers (`credit_ledger`, `points_ledger`): `create` is
  staff-only, `update` and `delete` are `null` (nobody edits history).
- `items` is never public, matching PLAN.md.

A PocketBase-specific wrinkle worth knowing when testing rules (and the
reason `check.sh` checks a *view* rather than a *list* against
`customer_private`): a plain string rule like staff-only is applied as a
query filter, so a **list** call that matches no rows under that filter
still returns `200` with zero items, not `403`. **Viewing one specific
record by id** is where a rule mismatch surfaces as `404` (PocketBase
treats it as "no such record" from that auth's point of view). A `null`
rule (superuser-only) is different again: any call at all, list or view,
is rejected up front with `403`.

## `pb/Dockerfile`

Alpine base; downloads the pinned PocketBase binary for the build
platform's architecture (`ARG PB_VERSION`, default `0.40.4`); copies
`pb_hooks`, `pb_migrations` and `pb_public` in; exposes `8090`; runs
`serve --http 0.0.0.0:8090 --dir /pb/pb_data --hooksDir /pb/pb_hooks
--migrationsDir /pb/pb_migrations --publicDir /pb/pb_public`; declares
`/pb/pb_data` as a volume. Build from the repo root so `pb_public` (the
built PWA, not part of this phase) is whatever is currently there:

```sh
docker build -t gg-vault-pb -f pb/Dockerfile .
docker run -p 8090:8090 -v gg_pb_data:/pb/pb_data gg-vault-pb
```

## Running `pb/scripts/check.sh`

```sh
bash pb/scripts/check.sh
```

Starts PocketBase on a fresh temp directory and a free port with this
repo's real hooks and migrations, creates a throwaway superuser, waits
for `/api/health`, then as that superuser: asserts every collection in
`docs/PLAN.md`'s data model exists; creates a `staff` admin and confirms
it can authenticate; creates an `items` row and checks the assigned SKU
both matches `^GG[SGRPAX][0-9A-HJKMNP-TV-Z]{6}$` and parses successfully
through `packages/shared/src/sku.ts` (run via `node
--experimental-strip-types`, so the check is against the real TypeScript
source, not a hand-copied regex); creates a `customers` row and checks
its `code` the same way, and that a matching `customer_private` row
appeared; confirms `GET /api/vault/health` returns `401` unauthenticated
and `200` with a staff token; and, impersonating that customer,
confirms it cannot view `customer_private` or list `audit_log`, cannot
rewrite fields a customer must not touch on their own `customers`,
`quotes` or `notifications` row (only accepting/declining a quote and
marking a notification read go through), and can read the loyalty
tiers. It also loads the seeded `pricing_rules`, `settings` and
`loyalty_tiers` rows back through `pb_hooks/lib/shared/{pricing,loyalty}.js`
(`pb/scripts/check-pricing-loyalty.js`) and confirms a card and a retro
item both price to a non-zero offer, `suggestSellPrice` marks a price up,
and the Legend tier's perks all parse; generates 40 item SKUs to confirm
their bodies are drawn uniformly rather than from the old biased
construct (see "Hooks" above); confirms an `active: false` staff record
cannot authenticate; and confirms updating `settings.email_api_key`
never leaves that value, only the field's name, in `audit_log`.

Section 14 then runs one full Phase 2 round trip through the custom
routes over HTTP, exactly as the counter app will:

- opens a cash session with a float, confirms a second one is refused
  with 409, and that `cash-sessions/current` reports the float;
- creates a customer, a draft trade-in (which proves `trade_ins.number`
  is no longer required) and two accepted lines;
- confirms completing it for cash with no ID check is refused with 422;
- posts an ID check as real multipart with a PNG the script generates,
  confirms `customer_private.id_status` becomes `verified`, and reads the
  file back **off disk** to confirm it is not a readable PNG any more;
- completes the buy-in as 4000p cash plus 2500p credit and asserts the
  number is `GG-BI-000001`, that three items exist (two singles one row
  per unit, one sealed line) with valid SKUs and `status = in_stock`,
  that three label jobs are queued, that the `credit_ledger` row and the
  cached `customer_private.credit_balance` both read 2500, that the
  drawer moved to 6000p, and that 125 points were earned on the credit;
- confirms a cash payout over `settings.cash_cap` is refused with 422;
- sells one of those items for store credit and asserts the sale number,
  the item going `sold`, the credit debited and the points earned;
- takes a step-up token (and confirms a wrong password is refused with
  400, and a refund without a token with 403), refunds the sale, and
  asserts the item is back `in_stock` with both balances reversed;
- confirms the ID photo is 403 without step-up and, as an admin with one,
  comes back 200 with `Cache-Control: no-store`, `Content-Disposition:
  inline` and bytes that compare byte-for-byte with the PNG that went in,
  with an `id_photo_view` audit row behind it;
- closes the session and checks the expected total and the variance;
- fetches the stock book CSV and checks its header row, its
  `Content-Disposition: attachment` filename and that the buy-in's number
  is in it;
- fetches the receipt JSON and confirms the receipt email route reports
  `{ sent: false, test_mode: true }` while `settings.email.test_mode` is
  on.

Section 15 is the money and security round, added after the Phase 2
review:

- a 320 KB ID photo through the ID check and back out of the admin view
  route, byte-for-byte and in well under three seconds (the base64 photo
  path it replaced took about 15 seconds for 200 KB);
- an HTML file named `photo.jpg` refused with 400, and a 9 MB photo too;
- the receipt's signature URL served with its file token and refused
  without one;
- a seller called `=HYPERLINK("x")` coming out of the stock book prefixed
  and quoted;
- a trade-in completed twice (409), a payout that does not match its
  lines (400), a completion with no `terms_accepted` (422), a signature
  that is not a PNG and an over-long `id_ref_last4` (400);
- `no_cash` and `under_18` flags, an expired stored `id_expiry`, and
  verified ID fields with no photo behind them, each refusing a cash
  payout with 422, then the same buy-in going through once a photo exists,
  recording it on `trade_ins.id_document` and pushing its expiry out;
- a two-line sale with a line discount and a sale-level discount refunded
  one unit at a time, whose five refunds sum to exactly what was charged,
  with `qty` and `discount` unmoved and a second refund of a finished line
  refused with 409;
- the refund reason landing in `notes` with only its id in `audit_log`;
- a cash sale writing a positive `cash_movements` row and its cash refund
  a negative one;
- a sale part-paid with points, and points refused when they would cover
  more than their share;
- the reward code rules: no customer, another customer's voucher, the
  wrong discount source, a discount that does not match, a reward that is
  not money off, then the happy path marking the redemption `used`;
- `settings.cash_cap` of 0 switching cash sales and cash payouts off;
- a non-admin staff account refused the stock book and the ID photo, and
  a step-up token minted for one staff member refused for another;
- the ID check refusing with 500 and storing nothing on a second,
  throwaway server started with no `GG_ID_PHOTO_KEY`;
- the stock book writing one row per sale line plus one for the remaining
  stock, and no sold row at all for a fully refunded line.

Section 16 covers the routes the counter packages asked for: the config
window (an ordinary staff token gets the pricing rules and no key or
secret), the ID document lookup, a customer merge (its refusals, the
re-pointed relations, the filled gaps and the recomputed balances) and an
erasure (refused while credit is outstanding, then anonymising the record,
deleting the ID photo and leaving the buy-in register's seller snapshot
alone).

Section 19 is Phase 3's, added with the lookup, prices and FX routes: the
server for this whole script runs under `GG_ADAPTER_TRANSPORT_MODE=fixture`
(see "Environment variables" above), so any call that reaches
`pb_hooks/adapters/fixture_transport.js`'s own mapping gets a real (fixture)
answer and anything else still throws and is caught here immediately,
rather than the check silently passing because a live call happened to
succeed. It confirms `GET /api/vault/fx` reports stale with an empty
`rates` object before any `fx_rates` row exists; that a `cards` row with a
fresh `last_synced` is served by the exact lookup route, and by a "set
number" search query, with no outbound call at all; that `uk-comp` refuses
a non-`ebay.co.uk` URL and a sale older than 30 days (both 400), then
writes a `price_snapshots` row that is chosen ahead of every other source
and audited; that the prices route puts a converted GBP figure beside a
snapshot's native amount; that a snapshot past its source's freshness
window is flagged stale rather than hidden; the Batch API settings and the
eBay haircut's one seeded home; that retro `refresh-prices` refuses cleanly
with no PriceCharting key; retro `uk-comp`; the offline queue's
`client_id` idempotency; and, at the end, `stockcounts.pb.js`'s close
route (variance, a move, roles, and refusing to close twice) plus the new
"a second open count on the same location is refused with 409" case.

Section 20, added with the adapter review that introduced fixture mode
itself, exercises what section 19 could not while every call threw: a name
search per game against each adapter's own search fixture (Yu-Gi-Oh!,
Pokemon - proving `charizard ex` reads as a name search and not a bogus
exact lookup for a set called "charizard" - and MTG); the `fx` cron
(`POST /api/crons/fx`, PocketBase's own "run this job now" route) storing
the rate's own `date`, distinct from `fetched_at`; the `sv151` alias
resolving with no outbound call against a pre-seeded, fresh `cards` row,
and that same row correctly triggering a real call-out once its
`last_synced` is over 30 days old, refreshing it from the fixture;
condition validation on `GET .../prices` (lowercase accepted, `EX`
refused with 400); a full `refresh-prices` round trip against a brand new
card with fixture-sourced snapshots, the GBP figure shown correctly beside
the native amount, and an audit row; `retro/lookup` against a mapped IGDB
fixture, and the 502 path for a source that is configured but whose
particular call has no fixture (a distinct IGDB "Client-ID" the fixture
transport refuses on purpose); and the `image_queue` cron
(`POST /api/crons/image_queue`) caching a real fixture image locally while
refusing one over the 2 MB cap and one that answers 200 with bytes that
are not a recognised image format, in both refusal cases leaving the
card's `image_large` exactly as it was.

Section 21 is reserved for another package this round (`daily_stats` and
the reports suite); its own agent adds it in place of the placeholder
comment.

Section 22 is Phase 4's: the SumUp export's header row, its SKU-prefixed
item name, 0% tax on a margin-scheme item, and `sumup_synced_at` set on
export but not under `dry_run=1`; the eBay listing CSV for two ids; the
inventory, sales and buy-in register exports' header rows, the last being
admin only; `end-listings.csv` listing a sold, still-listed item and
`POST /api/vault/items/end-listings` clearing it with an audit row; a
Card Uploader file with one id-matched row (creating one `listed_ebay`
item) and one name-only row (one review entry), read back through
`GET /api/vault/imports/:id`; a malformed file and the wrong declared
`type` both refused with 400; an eBay orders file selling a listed item
into a `channel: "ebay"` sale with `external_ref` set, a second run of
the same file reporting `"already sold"` rather than selling it twice, and
an ordinary counter sale still defaulting `channel` to `"counter"`; and
the SumUp pull (still under `GG_ADAPTER_TRANSPORT_MODE=fixture`, against
hand-written `sumup_HANDWRITTEN_*.json` fixtures) matching one transaction
by a SKU-prefixed product name and another by amount and a three-minute
time window, a second pull (run as the `sumup_pull` cron,
`POST /api/crons/sumup_pull`) upserting in place rather than duplicating
either, `GET /api/vault/sumup/reconcile` returning matched and unmatched
lists with totals, and a non-admin refused the pull but not the reconcile.

Prints `OK:`/`FAIL:` per step, exits non-zero on the first failure, and
always tears the server and temp directory down again (a `trap ... EXIT`),
even if a check fails.

Requires `pb/pocketbase` (see "Running locally"), `curl`, and `node`
(for the JSON glue, the `sku.ts` check and the test PNG). It starts its
own server with a throwaway `GG_ID_PHOTO_KEY`, so nothing needs to be set
in your shell.

## Regenerating `packages/shared/src/pb-types.ts`

```sh
pnpm pb           # once, so pb_data/data.db has every migration applied
pnpm typegen      # bash pb/scripts/typegen.sh
```

`typegen.sh` reads `pb/pb_data/data.db` directly (PocketBase does not
need to be running) via `pocketbase-typegen`, with two flags worth
knowing about if this ever needs debugging:

- `--allow-build=better-sqlite3`: `pocketbase-typegen` reads SQLite
  through `better-sqlite3`'s native addon, and pnpm 10 blocks install
  scripts by default - without this the addon is never built and the CLI
  fails with "Could not locate the bindings file".
- `--no-sdk`: emits only the plain per-collection data interfaces, not a
  typed-PocketBase-SDK wrapper. That wrapper's generated code imports the
  `pocketbase` npm package, which `@gg/shared` does not depend on (and,
  per its brief, must not gain a new dependency for this); a package that
  already depends on `pocketbase`, such as `apps/web`, can combine that
  package's own types with these interfaces itself.

The output is committed (it is generated, but read directly by the rest
of the workspace, the same way `pnpm-lock.yaml` is committed).

## Known follow-ups

- **`loyalty_tiers` and `loyalty_rewards` are admin-only end to end.**
  That is the literal reading of PLAN.md's "admin role for ... loyalty_*"
  applied to every collection whose name starts with `loyalty_`, but it
  also means the portal's own tier badge and rewards catalogue (Phase 6)
  cannot read them directly yet. Give the portal a read-only custom route
  (server-side, bypassing the collection rule, the same pattern already
  used for trade-in and sale completion) rather than loosening the rule,
  when that phase starts.
- **`perk_usage` and `referrals`** are staff-only, since PLAN.md's
  customer-readable list does not name them and a customer's own
  referral code is really just their `customers.code`. Revisit if the
  portal's Guild page ends up needing perk-usage counts directly.
- **`settings.min_single_offer` and `.bulk_rate_pct`** seed to `0`
  (no floor, no bulk discount): PLAN.md and the seed brief describe these
  fields but neither gives a concrete figure, and this is a real pricing
  decision for Richard rather than one to invent.
- **Staff MFA is off, not "optional".** PocketBase's MFA is "pass two of
  your enabled auth methods in sequence", so it refuses `enabled: true`
  while only one method (password) is on. Turn it on once `staff` gains
  a genuine second method (OTP or OAuth2).
- **`pb_public` is currently empty.** It is served as-is and copied
  as-is into the Docker image; the PWA lands there once `apps/web` has a
  production build step wired to it.
- **Email goes through PocketBase's own SMTP settings, not a provider
  API.** v0.40.4's `$mails` binding only exposes the built-in auth emails
  (`sendRecordVerification`, `sendRecordOTP`, ...); a generic send is
  `$app.newMailClient().send(new MailerMessage({...}))`, which uses the
  SMTP host configured in the dashboard. `settings.email_provider` and
  `settings.email_api_key` are therefore unused for now: wiring Resend,
  Postmark or Brevo means an HTTP call from the hook rather than
  `$mails`. `settings.email` (`from_name`, `from_address`, `reply_to`,
  `test_mode`) holds the addressing either way, and seeds with
  `test_mode: true` so a fresh install cannot email a customer by
  accident.
- **A refund pays out by the method the staff member picks**, not by
  unwinding the original payment split. That matches the contract, but it
  means a sale paid half on card and half on credit can be refunded
  wholly to credit. Revisit if Richard wants the split honoured.
- **`trade_in_lines.item` is a single relation**, so a line for two
  singles (which becomes two `items` rows) points at the first of them.
  Every unit points back at its line through `items.trade_in_line`, so
  nothing is lost, but a query from the line's side only sees one.
- **The trade-in route trusts the line's `offer_price`.** It checks the
  payout matches the accepted lines, not that each `offer_price` is what
  `computeOffer` would produce, because staff may override an offer with
  a reason. `offer_price` stays the figure actually paid for the payout
  type chosen, overridden or not, so the payout arithmetic reads it alone;
  `override_cash` and `override_credit` are the record of what the staff
  member typed for each type. A line is overridden when
  `override_reason` is non-empty, and the completion route lists those
  line ids in its audit meta as `overridden_lines`. The reason itself
  stays on the line: `audit_log` is permanent and superuser-only.
- **A bulk lot is an ordinary line.** The buy-in wizard sends a lot as one
  `kind: "other"` line of `qty: 1` with the flat figure in both
  `offer_price` and `market_price`, `market_source` "Bulk lot" and a title
  like "Bulk lot, 400 cards". "other" is not one of the per-unit kinds, so
  it becomes a single `items` row of `qty` 1 with one label job, and the
  receipt and the stock book need no special case for it.
