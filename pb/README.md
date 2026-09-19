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
| `lib/shared/{sku,money,pricing,loyalty}.js` | **Generated, do not edit.** A CommonJS build of `packages/shared/src/{sku,money,pricing,loyalty}.ts` via `pnpm --filter @gg/shared build:hooks`, so the hooks, the frontend and the admin loyalty-rule preview all share one implementation. `sku.js` is the one used here: `generateCode(kind, randomByte)`, `parseCode`, `buildCode`, `CROCKFORD_ALPHABET`, `CODE_KINDS`. |
| `lib/audit.js` | `writeAuditLog(app, { actor, action, collection, record, meta, ip })` - one row in `audit_log`. |
| `lib/counters.js` | `nextNumber(app, "trade_in" \| "sale" \| "redemption")` - atomically bumps the matching row in `counters` and returns `GG-BI-000123` / `GG-S-000456` / `GG-V-000012`. Transaction-agnostic: pass `$app`, `e.app`, or a `txApp` from `$app.runInTransaction`. |
| `items.pb.js` | On create: assigns `sku` when empty (kind to letter, then a checked random body, retried on collision - see above); derives `title` from the linked `card` or `retro_title` when empty. |
| `customers.pb.js` | `onRecordCreateRequest`: sets a random password (customers are OTP-only, but the field still exists - `docs/PLAN.md`'s Auth section). `onRecordCreate`: assigns `code` (`GGC…`) and `qr_token` when empty. `onRecordAfterCreateSuccess`: creates the paired `customer_private` row. |
| `redemptions.pb.js` | On create: assigns `reward_redemptions.number` (`GG-V-000012`, via `lib/counters.js`) and `.code` (`GGV…`, via `lib/shared/sku.js`) when empty. |
| `singletons.pb.js` | Refuses a second `settings` or `loyalty_programme` record. |
| `audit.pb.js` | Logs deletes on `staff`, `customers`, `customer_private`, `id_documents`, `items`, `trade_ins`, `sales`, `credit_ledger`, `points_ledger` (a judgement call - PLAN.md says "sensitive collections" without naming them; revisit if Richard wants a different list), and updates to `pricing_rules` and every `loyalty_*`/`settings` collection. Uses the `*Request` hook variants because only those carry `e.auth` and `e.realIP()`; logs only after `e.next()` returns without throwing. |
| `routes.pb.js` | `GET /api/vault/health` (staff-authenticated: status, PocketBase version, a few record counts) and `GET /api/vault/me` (the caller's own `staff` fields, hand-picked so `pin_hash` can never leak). |
| `crons.pb.js` | Registers `fx`, `prices`, `retention` and `stats` - each just logs for now. Real work is a later phase (`docs/PLAN.md`, "Phases"); day-to-day price ingestion runs in `services/pricesync`, not here, because hooks cannot stream the 15-26 MB Cardmarket files. |

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
confirms it cannot view `customer_private` or list `audit_log`. Prints
`OK:`/`FAIL:` per step, exits non-zero on the first failure, and always
tears the server and temp directory down again (a `trap ... EXIT`), even
if a check fails.

Requires `pb/pocketbase` (see "Running locally"), `curl`, and `node`
(for both the JSON glue and the `sku.ts` check).

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
