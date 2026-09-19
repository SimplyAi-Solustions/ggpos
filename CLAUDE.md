# GG Vault development guide

Guidance for coding sessions working in this repository. Read `docs/PLAN.md` in full before starting; it is the approved plan and the source of truth for scope, data model, screens and phasing. Read `DESIGN.md` before touching anything a user sees.

## What this is

GG Vault is the inventory, trade-in, loyalty and customer system for GG Entertainment, a games shop in Bolsover, Chesterfield. It runs alongside SumUp: SumUp takes payment, GG Vault is the record of truth for stock, trade-ins, customers and the GG Guild loyalty programme. See `PRODUCT.md` for who uses it and why, `docs/PLAN.md` for the full build plan.

## Monorepo layout

```
ggpos/
  apps/web/            React 19 + Vite PWA: the staff counter, customer portal and display screens
  pb/                  PocketBase backend
    pb_hooks/           server logic (goja JS): adapters, pricing, loyalty, trade-ins, sales, ID photos, labels, exports, reports, crons, audit
    pb_migrations/       collections, API rules, indexes, seed data
    pb_data/             SQLite and uploaded files (gitignored, never commit)
    scripts/             dev.sh, typegen.sh, check.sh
  packages/shared/      types and pure logic shared by the frontend and the hooks: SKU, money, pricing and loyalty evaluators
  services/pricesync/   Node script that streams the Cardmarket and TCGCSV price files nightly
  deploy/               docker-compose.yml, Caddyfile snippet, backup and restore scripts, runbook
  docs/                 PLAN.md and the documents this file points to
  PRODUCT.md            product truth: audience, jobs to be done, constraints
  DESIGN.md             the design system and copy rules
```

## Commands

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | Installs every workspace package. |
| `pnpm dev` | Starts the web app's Vite dev server. Run `pnpm pb` first, in another terminal; the app expects PocketBase at `127.0.0.1:8091`. |
| `pnpm build` | Builds every package that has a build script. |
| `pnpm lint` | Lints every package that has a lint script. |
| `pnpm typecheck` | Type-checks every package that has a typecheck script. |
| `pnpm test` | Runs every package's own test script (currently Vitest for `packages/shared`, `node --test` for `services/pricesync`; wire in `apps/web`'s suites here as they land). |
| `pnpm pb` | Runs `pb/scripts/dev.sh`: downloads the pinned PocketBase binary on first use and serves it from `pb/pb_data` with the repo's hooks and migrations, on `127.0.0.1:8091`. |
| `pnpm typegen` | Runs `pb/scripts/typegen.sh`: generates TypeScript types for every collection into `packages/shared/src/pb-types.ts`. Needs `pnpm pb` to have run at least once so the database exists. |
| `bash pb/scripts/check.sh` | Starts a throwaway PocketBase on a temporary data directory with the repo's hooks and migrations, then asserts every collection exists, the SKU and customer-code hooks work, and the API rules hold for staff and customer tokens. Run it whenever hooks or migrations change. |

## Rules

**Before UI work**: read `docs/PLAN.md` and `DESIGN.md`. Do not restyle or lay out a screen from memory or habit; match the reference screens in `docs/design-references/` and the system `DESIGN.md` records from them.

**Money**: every amount is an integer of GBP pence, never a float and never a decimal string once it is stored. Every amount on screen displays as £1,234.56 (sub-pound values show £0.45, never 45p). Use the helpers in `packages/shared/src/money.ts` (`formatGBP`, `roundHalfUp`, `parseDecimalToMinor`, `convertMinorToGbpPence`) rather than writing new rounding or formatting logic.

**Pricing**: UK sources first, always. For cards: a UK sold comp entered by staff (fresh within 30 days), then eBay UK asking (after the haircut), then Cardmarket (EUR, converted), then TCGplayer (USD, converted). For retro: UK sold comp, then PriceCharting PAL (converted), then eBay UK asking, then PriceCharting NTSC (converted). A foreign amount is only ever shown as supporting detail next to its GBP conversion, never on its own.

**Text**: no em-dashes anywhere, in code, commits or docs; use a comma or a hyphen instead.

**Copy**: short, specific labels. No exclamation marks. No emoji. An error says what happened and what to do about it, for example "Card not found in Scarlet & Violet 151. Check the number or add it manually." Not "Oops, something went wrong."

**Dependencies**: do not add a dependency without noting it in your report back. Say what you added and why.

**Hooks**: keep `pb_hooks/*.pb.js` handlers small. Put logic that both the server and the frontend need (SKU generation, money, pricing rules, the loyalty evaluator) in `packages/shared`; the hooks cannot load TypeScript, so `pnpm --filter @gg/shared build:hooks` emits a CommonJS copy into `pb/pb_hooks/lib/shared/` that handlers `require()` inside the handler body. Never hand-edit the generated copy.

**Never commit**: `pb/pb_data`, any `.env` file, or any API key or secret. `settings` holds third-party API keys server-side only; they are never sent to the browser.

**Commit messages**: imperative mood, one line ("Add trade-in completion route", not "Added" or "Adds"). Add a body only when the change needs explaining beyond the summary line.

## Model delegation

From `docs/PLAN.md`, "Build execution and model delegation":

- **Sonnet** takes well-specified, pattern-following packages: repo scaffolding and tooling, PocketBase migrations and seeds, catalogue and price adapters, the pricesync script, CSV import and export, unit tests, label templates, report queries, deploy files.
- **Opus** takes design-sensitive or correctness-critical work: the GG component variants and `ProductImage`, the Scan, Add stock, Buy-in wizard, Sell and portal screens, the loyalty evaluator and its admin editor, the transactional routes (trade-in completion, sale completion, refunds, redemptions), the ID photo routes, the offline queue.
- **The orchestrating session** reviews every diff before it merges, runs the design and copy gates against the reference screens, owns `DESIGN.md` and `PRODUCT.md` decisions, and does the integration and commits. Anything touching money, auth, ID data or the loyalty ledger gets a review at high effort.
