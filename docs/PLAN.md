# GG Vault: inventory, trade-in, loyalty and customer system for GG Entertainment

> Working name "GG Vault". Staff side is "The Counter", customer side is "My Vault", the loyalty programme keeps the site's name "GG Guild". Rename any of them.

## Context

GG Entertainment (Bolsover, Chesterfield; "Game · Trade · Play") is opening a games shop selling trading card singles, sealed product, retro consoles and cartridges, board games, minis and PC parts. SumUp takes payment, but listing every single card in SumUp is impractical: singles go through SumUp as a generic "single card" line with a keyed price. eBay listings come from Card Uploader, which also produces a CSV.

The shop needs a second system that owns every individual item: what came in, from whom (with ID on file for cash buy-ins), what it is worth, what it sold for, where it went. It prints mini barcodes for top loaders, sleeves and unboxed retro, pulls card images and market prices from free APIs, prices buy-ins as a percentage of market value, gives every customer a QR code and a portal (trade-ins, store credit, loyalty, remote quotes from photos), runs a loyalty programme Richard can reshape without code, reports on the business, and exports CSVs for SumUp and eBay. It runs on the GG VPS on PocketBase, is mobile-first, and uses a clean 2026 shadcn theme in GG's colours and type.

The repo `ggpos` is empty (one README): greenfield build on branch `claude/gg-inventory-trading-system-no0gln`.

Decisions confirmed with Richard:
- Launch scope: Pokémon, MTG, Yu-Gi-Oh!, One Piece, Lorcana singles; retro games and consoles; sealed product and accessories.
- Sales flow: scan-to-sell in our app is the record of truth; SumUp takes the money. CSV export pushes retro and sealed lines into SumUp.
- Cash buy-ins: photo of ID stored encrypted, admin-only, auto-purged after a set period; ID details stay on the customer record.
- Label printer: ORGSTA T003 (20 to 80 mm labels, 203 dpi, TSPL2, USB and Bluetooth).
- Second round: feature-rich but simple to use, clean modern minimalist shadcn theme on brand, reporting, admin-customisable customer loyalty, Impeccable and stop-slop applied to the UI and copy.
- Third round: three reference screens (Atlas / Nova style inventory forms) define the look across the whole app: monochrome, paper grain, underline inputs, tracked micro-labels, one black button, whitespace. Product images shown in the correct aspect ratio per platform with a subtle shadow or a left-and-bottom edge stroke.
- Fourth round: the type must flatter the existing GG design system the way the Atlas scan screen does, and no Poppins. Every price on screen is in GBP with a £ sign. UK pricing is the first source in every valuation; US dollar sources (PriceCharting, TCGplayer) are converted at the day's rate, never shown raw.

## Brand inputs (pulled from ggentertainment.co.uk, 19 Sep 2026)

The marketing site is an Astro build with these `:root` tokens:

```css
--paper: #ffffff; --paper-2: #f3f3ef; --paper-3: #e8e8e2;
--ink: #0b0b0b;   --ink-2: #3d3d3a;   --ink-3: #7a7a74;
--volt: #fedf01;  --volt-deep: #e3c700;   /* brand yellow */
--pop: #ff2e6b;                            /* pink accent */
--display: "Anton"; --sans: "Poppins"; --mono: "Space Mono";
--r: 4px; --shadow: 6px 6px 0 var(--ink);
--ease: cubic-bezier(.16, 1, .3, 1);
```

Site character: light theme, paper surfaces, thick ink borders, hard offset shadows, Anton uppercase headings, Poppins body, Space Mono for eyebrows and tags, yellow tickers with ◆ separators, pink scribbles and stickers, dry plain-spoken copy ("Bring the loft box in. Fair prices, no haggling theatre."). Logos: `logo-light` for paper, `logo-dark` (white + volt G) for ink backgrounds. The app keeps Anton and Space Mono and replaces Poppins with Jost (Richard's call; see Type below).

## UI system: minimal, on brand

Richard supplied three reference screens (inventory "scan item" and "add item" forms in the Atlas / Nova style). They set the look for every screen. What they do, read closely:
- Off-white canvas with a faint paper grain; nothing else in the background. Content sits in a narrow column with large top and side margins.
- No boxes. Inputs are a single hairline underline with a light-grey placeholder; the focused field shows only a text caret and a darker underline. Selects are the same underline with a thin chevron. Switches are small pills, black when on.
- Labels are tracked uppercase micro-text (11px, 0.18em) above or to the left of fields; helper text sits right-aligned in the same micro-text ("PRESS ENTER →", "REQUIRED", "0 / 200", "USE CAMERA").
- Sections are introduced by a tracked uppercase heading ("SCAN ITEM", "DETAILS", "ADDITIONAL") and divided by whitespace, not rules or cards.
- One page title in a large light typeface with a one-line grey subtitle. One black primary button (a black block with tracked uppercase text and an arrow, or a black circle with an arrow beside a label). Secondary actions are plain tracked text ("CLEAR ALL", "Cancel").
- Thin line icons (barcode glyph, tag, hash, person, pin) sit to the left of fields at 1.25px stroke.
- Wordmark top-left in wide-tracked uppercase; three text links and an avatar top-right. Micro-copy footer.
- Monochrome throughout. No colour fills, no shadows on surfaces, no borders except hairlines.

The app follows this closely, with two deliberate swaps so it reads as GG rather than as the reference: the page title is set in Anton instead of the reference's light sans, and the tracked micro-labels are Space Mono. GG's yellow is the only colour:

Canvas and colour
- Canvas `#fbfbfa` (between the site's `--paper` and `--paper-2`) with an SVG noise grain at 3 percent opacity, fixed so it does not scroll. Text ink `#0b0b0b`; greys are ink-tinted (`#3d3d3a`, `#7a7a74`, and ink at 24 / 12 / 6 percent for hairlines and dividers). No pure grey.
- Volt yellow `#fedf01` is the single accent, used in five places only: the GG logo mark, the focused field's underline and caret, the active nav underline, points and tier badges, and the done seal. Pop pink `#ff2e6b` marks errors and expiring offers. Nothing else is coloured; charts use ink, greys and one volt series.
- Dark mode ("counter night mode"): ink canvas with the same grain, paper text, greys inverted, yellow unchanged. Both modes ship from day one; light is the default.

Type (fonts that flatter the GG system the way the Atlas scan screen does; no Poppins)
- **Anton** for the one page title and the numbers that matter: "ADD STOCK", "NEW BUY-IN", the offer total, KPI figures. Uppercase, 28 to 36px, letter-spacing .01em, ink, once per page. One Anton line is what makes a monochrome screen read as GG rather than as a template.
- **Space Mono** for every tracked uppercase micro-label: section headings ("SCAN ITEM", "DETAILS"), field labels, helper text ("PRESS ENTER →", "REQUIRED", "0 / 200"), button labels, table column headings, footer micro-copy, and for SKUs, customer codes, set numbers and timestamps. 700 at 11px with .16em tracking for labels (the site's eyebrow spec), 400 for codes. This is the label treatment in the second reference screen and the site's own eyebrow and ticker voice.
- **Jost** for body, inputs, placeholders, descriptions and table cells: 300 for large placeholders (the 28px scan field), 400 for text, 500 for emphasis, with `font-feature-settings: "tnum"` for money and counts. A geometric sans in the Futura line, so it sits with Space Mono's geometry and Anton's weight without competing, and its light weights match the reference inputs. Fallback if it does not read well on the component kit page: Manrope.
- Poppins, the marketing site's body face, does not appear in the app.
- Fonts self-hosted through Fontsource (`@fontsource/anton`, `@fontsource/space-mono`, `@fontsource-variable/jost`).

Layout
- Content column 1,040px max on desktop, 96px top margin, 40px gutters; forms use the two-column label-left layout from the Nova reference at 900px and above, and stack to label-above (the Atlas reference) below. On phones the column is full width with 20px gutters and the primary button docks to the bottom in the thumb zone.
- Navigation: wordmark "GG VAULT" (or the yellow G mark at 24px) top-left; Stock, Trade, Customers, Reports as text links with a 2px volt underline on the active one; avatar with initials top-right. On phones: a bottom bar with five thin icons and labels. No sidebar.
- Data tables follow the same rules: hairline row dividers, tracked uppercase column headings, no zebra stripes, no borders, row hover tints to `#f3f3ef`, numbers right-aligned in tabular figures, product image at 40px tall in the first column. Sticky header, column pinning, saved views, inline edit on price and location.
- Sheets and dialogs are paper panels with a 1px hairline edge and one soft shadow (`0 1px 2px rgba(11,11,11,.04), 0 24px 48px rgba(11,11,11,.08)`); on phones every secondary action is a bottom sheet.

Controls
- Inputs: underline only (1px ink at 24 percent; focus 1.5px volt; error 1.5px pop with a one-line pop message below); placeholder in `#7a7a74`; the scan field is the largest input on the page (28px placeholder text) with the barcode glyph to its left and "PRESS ENTER →" to its right, exactly as the reference.
- Primary button: black block, 56px tall, white tracked uppercase label with a trailing arrow; the "circle arrow + label" form for wizard steps. Secondary: tracked uppercase text link. Destructive: same text link in pop. Loading state swaps the arrow for a thin ring.
- Chips (condition NM / LP / MP, finish): hairline pills that fill ink with paper text when selected; never yellow.
- Switch, chevron select, stepper for quantity and price with thin plus and minus.
- Icons: Lucide at 1.25px stroke, 20px, ink; never filled.

Product imagery (the part that has to look expensive)
- One `ProductImage` component renders every card, cartridge, box, console and sealed product across the app: rows, item pages, buy-in lines, autocomplete, the customer display, the portal, receipts and reports.
- Every image sits in a frame with the correct aspect ratio for what it is, so a row of items lines up and nothing is squashed. Ratios come from a `platforms` seed table Richard can edit: TCG card 63:88, graded slab 82:135 (PSA), Game Boy cartridge 57:65, SNES PAL box 190:135 (landscape), N64 box 195:135, Mega Drive box 130:180 (portrait), PlayStation jewel case 142:125, PS2 and Xbox DVD case 135:190, GameCube case 135:190, Switch case 105:170, Game Boy box 90:130, ETB 1:1.15, booster box 4:3, booster pack 63:105, console default 4:3. Unknown platforms fall back to 3:4.
- The image is `object-fit: contain` inside the frame on the canvas colour, never on a grey tile and never cropped. Two finishes, chosen per item kind in settings: **shadow** (default for cut-out card and slab images with transparent corners): `filter: drop-shadow(0 1px 1px rgba(11,11,11,.05)) drop-shadow(0 12px 24px rgba(11,11,11,.10))`, which follows the card's rounded corners; **edge** (default for rectangular box art and photos): a 1px ink-at-12-percent stroke plus a 1px offset line along the left and bottom edges at 20 percent, giving a printed-card edge. Item pages show the image large (up to 420px tall) centred in whitespace with the title and price beneath in the reference's label style.
- Image pipeline: the adapter fetches the best source image, the hook stores it in the record's file field, and PocketBase thumbs serve fixed widths (`?thumb=160x0`, `320x0`, `640x0`) as WebP. Sources with transparent corners (Scryfall PNG, TCGdex WebP, Lorcast) keep them; sources with a white background (YGOPRODeck, OPTCG, IGDB covers, staff photos) get a white-fringe trim in the client photo tool so the edge finish reads cleanly. Every `<img>` carries width and height from the ratio table (no layout shift), lazy-loads, and fades in from a silhouette of the right shape drawn in ink at 4 percent.
- Staff photos of retro items follow a capture guide in the app (plain background, straight on, fill the frame) with an auto-crop to the platform ratio, so a photographed cartridge sits in the grid as neatly as an API image.

Motion: the `motion` library (the marketing site already uses it). 150 to 200 ms with the site's out-expo easing, no bounce or elastic curves. Page transitions fade and rise 8px; rows settle in with a 20 ms stagger; the underline on a focused field grows from the left; KPI numbers count up once; a completed buy-in fans the item images out under the done seal; a successful scan pulses the target row's underline in volt. `prefers-reduced-motion` turns it all off.

Feel on the counter: optimistic updates with undo (mark sold, move, reprice: 8 seconds); a haptic tick (`navigator.vibrate(30)`) and an optional short sound on scan; skeletons drawn as hairlines, not spinners; keyboard-first on desktop (S scan, B new buy-in, N add stock, / search, ⌘K palette, Esc closes any sheet); the scan field takes focus on every counter screen so a wedge scanner works without a click; 48px targets on phones; sticky totals bar in wizards; pull-to-refresh on lists.

Accessibility: WCAG AA contrast (ink on yellow passes, white on yellow never appears; placeholder grey passes at 4.6:1), visible focus (volt underline plus a 2px outline for keyboard users), labels on every control, tables navigable by keyboard, screen-reader text for status chips, no colour-only meaning.

Foundation under the surface
- **shadcn/ui, CLI v4, Base UI primitives** (the default since July 2026), **Tailwind v4**, React 19, Vite. Init: `pnpm dlx shadcn@latest init -t vite --base base-ui`, starting from the roomy **Luma** style, then a "GG Minimal" preset saved with `shadcn/create` so every contributor gets the same theme. shadcn supplies the accessible primitives (Combobox, Command, Dialog, Sheet, Drawer, Toast, Calendar, Chart, Data Table, Form); the visual layer above them is the spec above, written once as component variants (`Input` gains an `underline` variant, `Button` gains `block` and `circle`, and so on) so no screen restyles anything.
- Theme as oklch CSS variables with `@theme inline`, light and dark; `--radius` 4px (used by chips, sheets and images only).
- Brand stickers (the site's SVG doodles) appear in empty states, the done seal and the customer card, and nowhere else.

### Impeccable and stop-slop in the workflow

Impeccable (pbakaus/impeccable, 24 commands and 61 detector rules) is not installed in this session. Phase 1 adds it to the repo so every session has it: `/plugin marketplace add pbakaus/impeccable` for the machine, plus `cp -r dist/claude-code/.claude ./` from the release into the project so the commands travel with the code.

- `/impeccable init` writes `PRODUCT.md` (who uses it, the jobs to be done, the tone). `DESIGN.md` records the theme above, the do and don't list, component usage and copy rules; `/impeccable document` keeps it current. The three reference screens Richard supplied are committed to `docs/design-references/` as `nova-add-item.png`, `atlas-scan-item.png` and `atlas-details.png` (copied from this session's uploads: `/root/.claude/uploads/2d55b959-462d-5cbc-b6f9-d2ac284ce1b7/be2eb2e1-image.png`, `d5dcbb7c-image.png`, `026507c3-image.png`; the same three also exist as `796c13da-image.png`, `15af0823-image.png`, `24e91b1f-image.png`) and linked from `DESIGN.md` as the visual target; every critique pass compares against them.
- Every screen: `/impeccable shape` before code, `/impeccable craft` to build with live browser iteration, `/impeccable critique` and `/impeccable audit` (accessibility, responsive, performance) before merge, `/impeccable polish` at the end of each phase. `/impeccable animate`, `/impeccable delight` and `/impeccable onboard` (first-run and empty states) run once the flows work. `/impeccable harden` covers errors and edge cases; `/impeccable clarify` rewrites UX copy.
- Anti-patterns enforced from Impeccable's rules: no gradient text, no glassmorphism, no purple-to-blue gradients, no untinted grey, no grey text on coloured backgrounds, no nested cards, no bounce easing, no default Inter or Arial.
- Stop-slop applies to every string in the UI and every email: short specific labels, no exclamation marks, no emoji, no "Oops" or "Awesome", errors say what happened and what to do next ("Card not found in Scarlet & Violet 151. Check the number or add it manually."). Copy review is a checklist item on each pull request.

## What already exists on the VPS (verified)

- `ggentertainment.co.uk` resolves to 13.140.163.200 behind **Caddy** (HTTP/2 + HTTP/3, HSTS).
- A **PocketBase instance already runs** there: the site's "Register interest" form posts to `/pb/api/collections/interest/records`, and a GET on that path returns a live JSON list. `/pb/api/health` and `/pb/_/` return Caddy's "Not found", so the admin UI is not exposed.
- To fix during the build: the `interest` collection's List rule allows an unauthenticated list request (200 with an empty page, not 403). Lock List and View to superusers.
- No `vault.`, `pb.`, `api.`, `hub.`, `trade.` or `pos.` subdomains exist yet.

GG Vault runs as a **second, separate PocketBase process** on the same VPS (own data directory, backups and upgrade cadence) at `vault.ggentertainment.co.uk`. The existing Caddy gains one site block.

## Architecture

```
vault.ggentertainment.co.uk  (Caddy: auto-HTTPS, CSP, rate limits, /_/ restricted by IP)
        |
        v
PocketBase v0.40.x (single Go binary, SQLite)  127.0.0.1:8091
  |- /api/*            REST + realtime for all collections
  |- /api/vault/*      custom routes from pb_hooks (lookup, offer, complete trade-in, complete sale,
  |                    redeem reward, ID photo, labels, exports, push)
  |- pb_hooks/         server logic in JS (adapters, loyalty engine, validation, audit, crons)
  |- pb_migrations/    schema, API rules, indexes, seeds
  |- pb_data/          SQLite + uploaded files
  `- pb_public/        the built React PWA, served by PocketBase

pricesync (Node, same compose file, runs nightly then exits)
  streams the Cardmarket and TCGCSV price files, writes price_snapshots via the REST batch API
```

- **Frontend**: Vite + React 19 + TypeScript PWA (`vite-plugin-pwa`), code-split into `/counter`, `/account` and `/display`. TanStack Router, TanStack Query over the `pocketbase` JS SDK 0.28.x with realtime subscriptions (a sale on a phone updates the counter PC at once). Scanning with the `BarcodeDetector` API and a `zxing-wasm` fallback for iOS Safari. Barcodes rendered with `bwip-js`.
- **Backend**: PocketBase with request-time logic in `pb_hooks` (goja: ES5 with most of ES6, synchronous, no `setTimeout`, CommonJS only; globals `$app`, `$http.send`, `$filesystem`, `$os`, `$security`, `$mails`, `routerAdd`, `cronAdd`, record hooks). Third-party APIs are called server-side only; keys stay out of the browser.
- **pricesync sidecar**: hooks cannot stream 15 to 26 MB JSON files (`$http.send` buffers whole bodies, goja has no streaming parser). A ~200-line Node script with `stream-json` streams each file, keeps only ids present in `cards`, and upserts `price_snapshots` through `POST /api/batch` with a superuser impersonation token.
- **Auth**: `staff` (email + password, MFA optional, roles `admin` and `staff`) and `customers` (email OTP only; `passwordAuth` off, `otp` on). Staff create customer records at the counter; an `onRecordCreateRequest` hook calls `e.record.setRandomPassword()`. The customer's first OTP login with the same email claims the account. A customer with no email on file has no portal until one is added.
- **Deployment**: Docker Compose (`pocketbase`, `pricesync`, and `caddy` if not already present), bind-mounted `pb_data`, nightly restic backups to S3-compatible storage (encrypted client-side, key off the VPS), GitHub Actions build and rsync deploy.
- **FX**: Frankfurter (`https://api.frankfurter.dev/v2/rates?base=gbp&quotes=eur,usd`; free, keyless, ECB daily, commercial use allowed) cached daily in `fx_rates`.
- **Email and push**: transactional email through Resend, Postmark or Brevo (one API key in settings); Web Push through the PWA service worker (VAPID keys in settings) for quote offers, want-list matches and reward messages.

## Repository layout

```
ggpos/
  .claude/                  Impeccable commands and skills (project-level copy)
  PRODUCT.md  DESIGN.md     product truth and design system (Impeccable-maintained)
  apps/web/                 React PWA (Vite, shadcn, Tailwind v4)
    src/app/                router, providers, auth guards, idle lock, shortcuts, command palette
    src/components/ui/      shadcn components (generated) plus the GG variants (underline Input, block and circle Button, hairline Table)
    src/components/product-image/   ProductImage: ratio frame, shadow or edge finish, silhouette placeholder, thumb sizes
    src/design/             theme.css (oklch tokens light and dark), grain.svg, fonts, brand stickers, motion presets
    src/features/           home, scan, stock, intake, tradein, sell, cash, customers, loyalty, quotes,
                            labels, reports, exports, settings, portal, display
    src/lib/                pb client, scanning, barcode render, money, sku, csv, offline-queue, push
  pb/
    pb_hooks/               *.pb.js: adapters/, pricing/, loyalty/, tradein/, sales/, idphoto/, labels/,
                            exports/, reports/, crons/, audit/
    pb_migrations/          collections, rules, indexes, seed data
    Dockerfile
  services/pricesync/       Node script + Dockerfile
  packages/shared/          generated types (pocketbase-typegen 1.5.x), SKU, money, pricing and loyalty rule evaluators
  deploy/                   docker-compose.yml, Caddyfile snippet, backup.sh, restore.md, .env.example, README (runbook)
  docs/                     this plan, label spec, privacy notice, retention schedule, DPIA, csv-formats.md, loyalty guide
```

## Data model (PocketBase collections)

Auth
- `staff` (auth): name, role (`admin` | `staff`), active, `pin_hash` (4 to 6 digits for quick switching on the counter PC).
- `customers` (auth, OTP only): name, phone (E.164), `code` (unique, `GGC-7F3K2`, printed on the QR card), `qr_token` (rotatable), marketing_consent, birthday_month (optional, for the birthday rule), `source` (`counter` | `portal`), `referred_by` (rel). Only fields the customer may see and edit live here. Rules: view and update `id = @request.auth.id`; create through a custom route; list for staff.
- `customer_private` (1:1, staff-only): address (required before any cash buy-in), dob, notes, `flags` (`no_cash`, `watchlist`, `under_18`), `id_status` (`none` | `verified` | `expired` | `rejected`), `id_type`, `id_expiry`, `id_ref_last4`, `id_verified_by`, `id_verified_at`, `credit_balance` (cached; `credit_ledger` is the truth), `points_balance` (cached; `points_ledger` is the truth), `tier` (rel). PocketBase rules are per record, not per field, so PII and staff notes live apart from the auth record.
- `id_documents` (all rules `null`): customer, `photo` (file, encrypted), `taken_by`, `taken_at`, `expires_at`. Read and written only by custom routes.

Catalogue (cached copies of external data, never the truth for stock)
- `games`: key (`pokemon`, `mtg`, `yugioh`, `onepiece`, `lorcana`, `retro`), name, adapter, enabled.
- `platforms` (admin-editable seed): key (`tcg_card`, `graded_slab`, `snes_pal`, `n64`, `megadrive`, `ps1`, `ps2`, `gamecube`, `switch`, `gameboy_cart`, `gameboy_box`, `etb`, `booster_box`, `booster_pack`, `console`, and so on), name, `aspect_w`, `aspect_h`, `image_finish` (`shadow` | `edge`), region_note, sort. Drives the `ProductImage` frame for everything that is not a card.
- `card_sets`: game, code, name, series, release_date, total, symbol (file), external_ids (json).
- `cards`: game, set (rel), number, name, rarity, type, finishes_available (json), image_small, image_large (URL or cached file), `tcgplayer_id`, `cardmarket_id` (indexed: Card Uploader exports and the free price files key on them), external_ids (json), `source` (`api` | `manual`), search_text (indexed), last_synced, `prices` (json, latest per source). Unique on (game, set, number).
- `price_snapshots`: card or retro_title, finish, source (`uk_sold_manual` | `ebay_uk_asking` | `cardmarket` | `tcgplayer` | `pricecharting_pal` | `pricecharting_ntsc`), `native_currency` (`GBP` | `EUR` | `USD`), native low, mid, market, trend, `fx_rate`, `fx_date`, `gbp_market` (pence, the only value the UI ever shows), fetched_at, evidence_url. Index on (card, finish, source, fetched_at); rows older than 90 days roll up to weekly.
- `retro_titles`: platform, name, region, cover, external_ids (IGDB, PriceCharting).
- `fx_rates`: base GBP, quotes json, fetched_at.

Stock
- `items`: `sku` (unique), kind (`single` | `graded` | `retro` | `sealed` | `accessory` | `other`), game, card, retro_title, title, set_code, number, finish, language, condition (`NM` | `LP` | `MP` | `HP` | `DMG`), retro `completeness` (`loose` | `boxed` | `cib`), `cosmetic_grade` (`A` | `B` | `C`), `tested`, `region` (`PAL` | `NTSC` | `JP`), grade_company, grade, cert_no, `ean`, `qty` (1 for singles, graded and retro; n for sealed and accessories, which share one SKU per stock line), `cost`, `market_at_intake`, `price`, `tax_scheme` (`margin` | `standard`), `status` (`in_stock` | `reserved` | `listed_ebay` | `sold` | `returned` | `written_off`), location, photos, `source` (`trade_in` | `supplier` | `opening_stock`), `trade_in_line`, `acquired_at`, `supplier_ref`, `reserved_for`, `reserved_until`, `ebay_listing_id`, `ebay_sku`, `sumup_synced_at`, `label_printed_at`, notes, created_by. Indexed on sku, status, game, title, ebay_sku, ean.
- `locations`: name, type, sort.
- `stock_counts` and `stock_count_lines`: location, started_by, expected vs scanned, variance, closed_at.
- `want_list`: customer, card (rel) or free text, max_price, status (`open` | `matched` | `fulfilled` | `closed`), matched_item, notified_at.

Trading
- `trade_ins`: `number` (`GG-BI-000123`), customer, channel (`counter` | `remote`), status (`draft` | `offered` | `accepted` | `completed` | `declined` | `cancelled`), payout_type, total_market, total_offer, payout_cash, payout_credit, `id_checked`, id_checked_by, signature (file), staff, completed_at, quote (rel), `cash_session`, seller snapshot (name, address, ID type, last four, expiry) taken at completion so the 6-year register survives a later erasure.
- `trade_in_lines`: trade_in, card or retro_title or free-text title, finish, condition, qty, market_price, market_currency, fx_rate, market_source, offer_pct, offer_price, accepted, item (rel).
- `quotes`: customer, status (`submitted` | `reviewing` | `offered` | `accepted` | `declined` | `expired` | `received` | `completed`), photos (up to 20), message, lines (json), offer_total, offer_expires_at, customer_reply, drop_off (`in_store` | `post`). Customer-readable.
- `notes` (staff-only): target collection and record, body, author. Quote notes, override reasons, customer notes.
- `credit_ledger`: customer, amount (signed pence), reason (`trade_in` | `sale` | `adjustment` | `expiry` | `reward`), ref, balance_after, staff. Append-only.

Selling and cash
- `sales`: `number` (`GG-S-000456`), staff, customer, subtotal, discount, discount_source (`manual` | `tier_perk` | `reward`), total, payment (`sumup_card` | `cash` | `store_credit` | `points` | `mixed`), payment_split (json), sumup_ref, `cash_session`, points_earned, status (`complete` | `refunded` | `part_refunded`).
- `sale_lines`: sale, item, qty, unit_price, discount, `vat_rate`, `tax_scheme`, status (`sold` | `refunded`).
- `cash_sessions`: opened_by, opened_at, float, closed_by, closed_at, expected, counted, variance, notes. Every cash payout and cash sale links to the open session.
- `cash_movements`: session, type (`float_in` | `payout` | `cash_sale` | `refund` | `bank_drop` | `adjustment`), amount, ref, staff.
- `counters`: key (`trade_in`, `sale`, `redemption`), value; bumped inside the same transaction as the record it numbers.

Loyalty (GG Guild)
- `loyalty_programme` (single record, admin-editable): enabled, name, points_name, earn_per_pound_sales, earn_on_trade_in_credit (points per £ of credit taken), points_per_pound_redemption (e.g. 100 points = £1), min_redeem_points, max_points_share_of_sale (percent), expiry_months_inactive, tier_window_months (rolling 12), welcome_bonus, referral_bonus_referrer, referral_bonus_referee, terms text.
- `loyalty_rules` (ordered, stackable): name, type (`multiplier` | `fixed_bonus` | `first_purchase` | `birthday_month` | `trade_in_credit_bonus` | `event_checkin` | `day_of_week`), conditions (json: games, kinds, min_spend, weekdays, date range), value, active, priority, starts_at, ends_at.
- `loyalty_tiers`: name (defaults: Member, Regular, Legend), threshold_points (rolling window), colour token, sort, perks (json list of `{type, value, scope, per_month}`: `percent_off` on categories, `points_multiplier`, `free_event_entries`, `lounge_hours`, `priority_release_booking`, `member_event_pricing`), `paid_plan` (bool, for Guild Pass style memberships that grant a tier regardless of points).
- `memberships` (paid plans, recorded by staff or by Stripe later): customer, tier, status (`active` | `lapsed` | `cancelled`), started_at, renews_at, price, payment_note.
- `loyalty_rewards`: name, description, cost_points, type (`money_off` | `store_credit` | `free_item` | `event_entry` | `custom`), value, stock_limit, per_customer_limit, active, starts_at, ends_at, image.
- `reward_redemptions`: `number`, customer, reward, points_spent, code (short, shown as QR in the portal), status (`issued` | `used` | `expired` | `cancelled`), used_in_sale (rel), used_by (staff), expires_at.
- `points_ledger`: customer, delta, reason (`earn_sale` | `earn_trade_in` | `rule_bonus` | `welcome` | `referral` | `redeem` | `adjust` | `expire` | `refund_reverse`), ref, rule (rel), balance_after, staff. Append-only; a hook recomputes `customer_private.points_balance` and re-evaluates the tier.
- `perk_usage`: customer, perk_type, period (`2026-09`), used_count. Enforces monthly counters (two free event entries a month, twelve lounge hours).
- `referrals`: referrer, referee, status (`pending` | `earned`), earned_at.

Ops and reporting
- `pricing_rules`: game, kind, condition, finish, rarity, band_min, band_max, cash_pct, credit_pct, rounding, priority, active.
- `label_templates`, `label_jobs` (item, template, copies, status, requested_by, printed_at).
- `sumup_transactions`: sumup_id, transaction_code, timestamp, amount, payment_type, status, products (json), matched_sale, fetched_at.
- `csv_imports`: type (`card_uploader` | `ebay_orders` | `sumup_sales`), file, status, rows_total, rows_ok, errors, staff.
- `daily_stats`: date, sales_count, sales_total by payment (json), buy_in_count, buy_in_total by payout (json), items_in, items_out, stock_value_cost, stock_value_market, credit_issued, credit_redeemed, points_earned, points_redeemed, cash_variance, new_customers, returning_customers. Built nightly and on demand.
- `saved_reports`: owner, report key, filters (json), name, schedule (`none` | `weekly` | `monthly`), recipients.
- `notifications`: customer or staff, type, title, body, link, read_at, pushed_at. `push_subscriptions`: user, endpoint, keys.
- `audit_log` (superuser-only): actor, action, collection, record, meta, ip. Written for ID photo views, price overrides, refunds, credit and points adjustments, PII exports, deletions, loyalty rule changes.
- `settings` (single record): buy-in defaults, minimum single offer, bulk rate, source priority, condition multipliers, sell-price markup bands and rounding (.49 / .99), label defaults, quote expiry days, ID photo retention months, cash cap, VAT registration, shop details, email and push keys, API keys (server-side only).

API rules in short: staff-facing collections require `@request.auth.collectionName = "staff"`; admin role for `settings`, `pricing_rules`, `loyalty_*`, `staff`, refunds and PII exports; `customers`, `quotes`, `trade_ins`, `credit_ledger`, `points_ledger`, `reward_redemptions`, `want_list`, `notifications` readable by their owning customer; `customer_private`, `id_documents`, `notes`, `audit_log` never readable by customers; `items` never public. Trade-in completion, sale completion and redemptions are custom routes, not direct writes.

## Screens

Staff, "The Counter" (`/counter`; phone, tablet and desktop)
1. **Home**: today in numbers (sales, buy-ins, cash out, credit issued, points issued, stock value at market with the day's change), open cash session, quotes waiting, want-list matches, price movers, low sealed stock. Quick actions: Scan, Sell, Buy-in, Add stock.
2. **Scan** (one tap, and the global wedge listener): decodes item SKUs (`GGS…`), customer codes (`GGC…`), reward codes (`GGR…`) and EANs, and routes by prefix. Price-check mode shows market value, our offer band and our stock for any card without creating anything.
3. **Stock**: data table with saved views ("Pokémon over £20", "Listed on eBay", "Older than 90 days"), filters, search-as-you-type, bulk actions (print labels, reprice to market, move, mark listed, end eBay listing, write off). Item page: image, provenance (trade-in, seller, cost), market history sparkline, label reprint, sell, reserve, photos for eBay with auto-crop.
4. **Add stock**: game, set and number or name autocomplete with thumbnails, finish, condition, qty, market and suggested sell price, location, save and print. Binder mode keeps the set sticky and accepts number, Enter, condition key, Enter. EAN scan for sealed. "Not in catalogue" creates a manual card and queues it for matching.
5. **Buy-in wizard** (one-handed on a phone):
   - Customer: scan QR, type code, search name or phone (duplicate warning), or create. Shows ID status, flags, credit, tier.
   - Items: fast add, condition and finish chips, qty; each line shows market in GBP with source and age, the cash offer and the credit offer; overrides need a reason; retro lines take completeness, cosmetic grade, tested, region; bulk lot line for low-value cards.
   - Offer: cash vs credit totals with the credit bonus points shown, customer's choice, terms, signature pad. "Show customer" mirrors this step to the customer-facing display.
   - ID gate (cash only): capture photo (downscaled, EXIF stripped), record type, expiry, last four, DOB, address; staff attests. Blocked without it. Cash above the cap is refused with the reason.
   - Done: items created with SKUs, labels queued, purchase receipt sent, credit and points posted, done seal with the item cards fanning out.
6. **Sell**: scan items into a basket; scanning the customer applies tier perks (percent off on eligible categories) and shows points to be earned; rewards redeemable by code; payment (SumUp card, cash, store credit, points, split); "Mark sold" with an 8-second undo; shows the total to key into SumUp or sends it to the Solo reader (later phase); refund per line.
7. **Cash**: open with float, movements, close with count and variance, reconciliation against SumUp transactions.
8. **Customers**: search, profile (trade-ins, purchases, credit, points, tier, perks used, want list, referrals, ID status with step-up photo view), print or email the QR card, rotate QR, notes and flags, merge duplicates, GDPR export and erasure.
9. **Loyalty** (admin): programme settings, rules editor with a live "a £30 Pokémon sealed sale on Saturday earns 600 points" preview, tiers and perks editor, rewards catalogue with images, memberships, points adjustments with reason, programme stats.
10. **Quotes**: queue, photo viewer, identify cards into lines, offer, message thread, convert to a draft buy-in on arrival.
11. **Labels**: print queue, template preview, reprint by range.
12. **Reports**: see the reporting section.
13. **Exports and imports**: SumUp CSV, eBay listing CSV, Card Uploader import, eBay orders import, inventory, sales, buy-in register, stock book.
14. **Settings** (admin): pricing rules matrix with a live preview, sell-price markup bands, staff and PINs, label defaults, price sources, retention, cash cap, VAT, shop details, email and push keys, theme (light, dark, auto).

Customer-facing display (`/display`, a tablet on the counter, optional): idle state with the yellow ticker and the sign-up QR; during a sale shows the basket, perks applied and points earned; during a buy-in shows the offer lines and totals with a large "Accept" for the customer to tap before signing.

Customers, "My Vault" (`/account`; phone-first)
1. **Sign in** with an emailed code; first login claims the counter-created record.
2. **My card**: full-screen QR and code in the playing-card format, tier badge, points balance, progress to the next tier ("£42 more to Regular"). Works as a screenshot offline. "Add to home screen" prompt.
3. **Guild**: perks wallet with monthly counters, rewards catalogue with "Redeem" (produces a QR code for the counter), referral code with a share sheet, points history.
4. **My trade-ins**: list and detail with items and payouts. **Store credit**: balance and ledger.
5. **Get a quote**: multi-photo upload, description, submit; status timeline; accept or decline; drop-off or post. **Estimate**: pick a card (set and number) and condition to see an indicative offer band before visiting, with a "subject to inspection" note.
6. **Want list**: cards they are after with a max price; push notification and a 48-hour hold when one comes in.
7. **Profile and privacy**: contact details, ID status, consent, notifications, download my data, delete my account.

Public: `/` (sign-in), `/c/:token` (QR landing: the customer's own card after login; opens the customer in the counter for logged-in staff; never shows PII without login), `/estimate` (public indicative offer calculator; drives sign-ups).

## Core flows and rules

- **SKU**: `GG` + kind letter + 6 Crockford base32 characters (no I, L, O, U) + 1 check character computed mod 32 within the same alphabet (Crockford's own check symbols fall outside QR alphanumeric mode and confuse wedge scanners). Display `GGS-7F3K2Q`, encode `GGS7F3K2Q`. Generated in an `onRecordCreate` hook with retry on unique violation. Customer codes `GGC-…`, reward codes `GGR-…`, so the scan listener routes by prefix. Customer QR encodes `https://vault.ggentertainment.co.uk/c/<qr_token>`.
- **Quantity model**: singles, graded cards and retro are one row per unit with one label each. Sealed and accessories are stock lines (qty n, one SKU, label optional, EAN scan to sell); a sale decrements qty.
- **Market value, UK first, always in GBP**: adapters return every candidate price with its native currency; the pricing service converts each to GBP pence at the day's ECB rate and picks the first source that has a fresh value in this order: (1) a UK sold comp entered by staff in the last 30 days, (2) eBay UK asking price (GBP, live, with the asking-to-sold haircut), (3) Cardmarket EUR converted, (4) TCGplayer USD converted, and for retro (1) UK sold comp, (2) PriceCharting PAL category USD converted, (3) eBay UK asking, (4) PriceCharting NTSC converted. Admins can reorder this in settings. Condition multipliers (LP 0.85, MP 0.70, HP 0.50, DMG 0.30, configurable) apply after conversion. Every line shows the source, the native amount, the rate and its date ("£14.20 from Cardmarket €16.50 at 0.8606, 19 Sep"), and the freshness.
- **Offer**: `pricing_rules` by game, kind, condition, finish or rarity and price band gives cash and credit percentages, rounded to the band's step; a minimum single-card offer and a bulk rate stop pennies. Overrides need a reason and hit the audit log.
- **Suggested sell price**: market times a markup band from settings (for example 1.10 under £5, 1.05 £5 to £50, 1.00 above), rounded to .49 or .99. "Reprice to market" bulk action recomputes it.
- **Trade-in completion**: custom route inside `$app.runInTransaction(txApp => …)` with all writes through `txApp`: validate ID gate and cash cap, bump `counters.trade_in`, snapshot seller details, create items, write `credit_ledger`, `cash_movements` and `points_ledger` (credit bonus rule), link lines to items, queue labels, match want lists, send the receipt. The batch API only edits draft lines.
- **Sale completion**: same pattern: items must be in stock or reserved for this customer; apply tier perks and any reward; set sold or decrement qty; write lines with VAT scheme and rate; debit credit or points; record the cash movement; post points earned through the loyalty engine; audit price changes. Refund reverses per line, including points and perk counters.
- **Loyalty engine** (`pb_hooks/loyalty/`): pure evaluator in `packages/shared` (so the admin preview and the server produce the same answer): base points from the programme, then rules in priority order (multipliers stack multiplicatively, bonuses add), then tier multiplier; tier re-evaluated on every ledger change from the rolling window; paid memberships pin a tier. Expiry cron posts `expire` rows for inactive customers after the configured months with a 30-day warning notification. Referral: the referee's first completed sale or buy-in earns both sides.
- **VAT**: `settings.vat_registered` off by default; second-hand goods from the public are `margin` lines, new supplier stock is `standard`. The stock book export (stock number, purchase date and ref, seller name and address, description, cost, sale date and ref, sale price, margin) is the margin scheme record.
- **Cash**: no cash payout or cash sale without an open `cash_session`; single cash payout and cash sale capped at `settings.cash_cap` (default £8,000).
- **Card not found**: staff create a manual `cards` row (name, set, number, photo) with `source: manual`; a "needs catalogue match" queue lets an admin link it later; the label prints the title.
- **Want lists**: on item creation a hook matches open want lists by card and max price, reserves the item for 48 hours, and pushes a notification.
- **Remote quote to buy-in**: an accepted quote becomes a draft trade-in with its lines; staff verify condition on arrival and complete as normal.
- **Offline**: the PWA caches the stock list, customer lookups, pricing rules and loyalty tiers read-only, and queues "mark sold" and label jobs locally for replay on reconnect, with conflicts (already sold) surfaced. Buy-ins need the server. Runbook: 4G tethering first.
- **Realtime**: the counter PC subscribes to `label_jobs`, `sales`, `cash_movements` and `notifications`; the customer-facing display subscribes to the active basket or buy-in.

## Currency: GBP everywhere

- Every amount the app stores for its own records (costs, prices, offers, credit, points value, sales, cash) is an integer of GBP pence. Every amount the app shows is formatted `£1,234.56` with tabular figures; sub-pound values show as `£0.45`, never `45p`.
- Foreign prices exist only inside `price_snapshots` as native values next to their GBP conversion. Screens, labels, receipts, exports and reports never show a € or $ figure on its own; the native amount appears only in the source detail ("from Cardmarket €16.50 at 0.8606").
- Conversion uses the ECB reference rate from Frankfurter fetched daily at 07:00 and stored with its date; a valuation records the rate it used so a price from last week reproduces exactly. Rounding is half-up to the penny after conversion, never before. PriceCharting's integer cents are divided by 100 before conversion; TCGplayer and Cardmarket decimals are parsed as strings, not floats.
- Labels print `£` prices; the SumUp CSV writes GBP with two decimals; the eBay listing CSV targets ebay.co.uk in GBP.
- A stale rate (older than 3 days) shows a warning on every converted price and blocks nothing.

## Reporting

Built on `daily_stats` (nightly plus on-demand refresh) and direct queries for drill-down. Every report has a date range, comparison to the previous period, a chart and a table, CSV and PDF export, saved filters, and an optional weekly or monthly email schedule. Charts use shadcn Chart (Recharts) with a brand palette validated with the dataviz skill when the charts are built.

| Report | What it answers |
|---|---|
| Sales | Revenue by day, week, month; by game, kind, staff, payment method; average basket; hour-of-day heatmap for staffing |
| Buy-ins | Spend by game and staff; average offer as a percent of market; cash vs credit mix; items bought vs sold ratio; top sellers to us |
| Margin | Gross margin per item, game, kind and staff; margin scheme VAT estimate; markdowns |
| Stock | Value at cost vs market (unrealised gain); ageing buckets (0 to 30, 31 to 90, 91 to 180, 180+ days); sell-through by game and set; dead stock; price movers over 15 percent with a "reprice" action |
| Channels | In-store vs eBay sales, listing age, items ended |
| Customers | New vs returning, top by spend and by trade-in, credit liability outstanding, want-list demand (which cards people want and we don't have) |
| Loyalty | Points issued and redeemed, tier distribution, perk usage, reward take-up, referral conversions, programme cost as a percent of revenue |
| Cash | Sessions, variance history, cash in and out per day |
| Compliance | Buy-in register with seller snapshots, stock book, audit log export |

Home shows the headline tiles with sparklines; a Monday 8am digest emails the admin the week's numbers and the three biggest movers.

## Card images and market prices (verified live, 19 Sep 2026)

Two findings that change the usual advice:
- **pokemontcg.io is deprecated**: no new keys, existing keys stop on 1 March 2027, and it returned 5xx errors on several requests today with stale Cardmarket data. Not used.
- **Cardmarket's official API is closed to new applicants, but Cardmarket publishes its daily price guide and product catalogue as public JSON with no login**: `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_{gameId}.json` (`avg`, `low`, `trend`, `avg1`, `avg7`, `avg30`, `-holo` variants, EUR) and `.../productList/products_singles_{gameId}.json`. Game ids: Magic 1, Yu-Gi-Oh! 3, Pokémon 6, One Piece 18, Lorcana 19 (also Digimon 17, Star Wars Unlimited 21, Riftbound 22, Gundam 24). 15 to 26 MB each, refreshed around 02:40 UTC. This is the best legitimate European price source and our UK proxy, converted to GBP.

| Game | Identify + images | Market price (priority order) | Join key |
|---|---|---|---|
| Pokémon | **TCGdex** `GET https://api.tcgdex.net/v2/en/sets/{setId}/{localId}`, no key, MIT; images `https://assets.tcgdex.net/en/{serie}/{set}/{localId}/high.webp` (600×825) | TCGdex embeds `pricing.cardmarket` (EUR, daily, with `idProduct`) and `pricing.tcgplayer` (USD); nightly Cardmarket file 6 by `idProduct` | set id + local number; `idProduct` |
| MTG | **Scryfall** `GET /cards/{set}/{collector_number}`, images `image_uris.normal` (488×680); real `User-Agent` required; 10 req/s | Scryfall `prices.eur` / `eur_foil` and `usd`; nightly Cardmarket file 1 by `cardmarket_id` | set + collector number; `cardmarket_id` |
| Yu-Gi-Oh! | **YGOPRODeck** `cardinfo.php` (20 req/s); images **must be re-hosted** (hotlinking gets IPs banned): saved into the `cards` file field on first lookup | YGOPRODeck `card_prices.cardmarket_price` (EUR) and per-printing `card_sets[].set_price` (USD); Cardmarket file 3 by name | passcode; `set_code` such as `CT13-EN003` |
| One Piece | **OPTCG API** `https://optcgapi.com/api/sets/card/{OP01-001}/`, no key; `card_image` cached locally | Cardmarket file 18 (names embed the code, "Roronoa Zoro (OP01-001)"); OPTCG `market_price` as fallback | card code |
| Lorcana | **Lorcast** `GET https://api.lorcast.com/v0/cards/{set}/{number}`, no key, AVIF images (488×681), under 10 req/s, cache 24 h | Lorcast `prices.usd` / `usd_foil`; Cardmarket file 19 by name + version | set code + collector number |
| Retro games | **IGDB** (Twitch client credentials, 4 req/s) for titles, platforms, covers; free for non-commercial, email `partner@igdb.com` for the commercial OK; **TheGamesDB** box art as fallback | **PriceCharting API, paid, $49 / month "Legendary"**: the adapter queries the **PAL** category first (`pal-super-nintendo`, `pal-playstation-2` and so on) and NTSC only when no PAL entry exists; values arrive as integer US cents (`1732` means $17.32) and are converted to GBP pence at the day's rate before anything sees them. No free structured source exists; manual UK comps otherwise | PriceCharting product id |
| Sealed / accessories | Manual entry with EAN scan; optional TCGCSV product lookup for images | Manual sell price | EAN |

Supporting sources:
- **TCGCSV** (`https://tcgcsv.com/tcgplayer/{category}/{group}/prices`; Magic 1, Yu-Gi-Oh! 2, Pokémon 3, One Piece 68, Lorcana 71): free daily TCGplayer dumps, USD second opinion keyed by `tcgplayer_id`. Needs an identifiable `User-Agent`.
- **eBay UK (the first automated GBP source)**: sold-item data (Marketplace Insights) is closed to new users and the website's sold filter now needs a login, so no automated UK sold comp exists. The free **Browse API** (`item_summary/search` with `X-EBAY-C-MARKETPLACE-ID: EBAY_GB`, 5,000 calls a day, free developer account) returns live ebay.co.uk fixed-price listings in GBP. The adapter searches the exact card (name, set, number, finish, and condition words), keeps UK-located listings, takes the median of the five lowest asking prices, and applies a configurable asking-to-sold haircut (default 15 percent) because asking prices sit above what sells. Cached 24 hours per card. If eBay declines production access to the Browse API, this source is switched off in settings and Cardmarket becomes first; the rest of the order stands.
- **UK sold comps entered by staff**: for high-value cards a staff member records a recent ebay.co.uk sold price with the listing URL; it becomes the top source for 30 days.

Valuation order (UK first): 1. UK sold comp entered by staff (GBP, fresh within 30 days). 2. eBay UK asking after the haircut (GBP). 3. Cardmarket (EUR converted; the European market including UK sellers). 4. TCGplayer (USD converted; US market, last resort). Retro: 1. UK sold comp. 2. PriceCharting PAL (USD converted). 3. eBay UK asking. 4. PriceCharting NTSC (USD converted). Staff see all available sources side by side on the line with the chosen one marked, and can pick another with a reason.

Do we have to pay? For TCG singles, no: TCGdex, Scryfall, YGOPRODeck, OPTCG, Lorcast and the Cardmarket public files cover images and EUR / USD prices for every game in scope. The one paid feed worth having is **PriceCharting at $49 a month** for retro values, if retro trade-in volume justifies it. Not needed: Scrydex (from $29 a month, no Cardmarket), JustTCG ($19 to $49 a month, USD, UK region "later"), PokemonPriceTracker ($99 a month for commercial use).

Adapter layer:
- `pb/pb_hooks/adapters/{game}.pb.js` each export `search(query)`, `getBySetNumber(set, number)`, `getImage(card)`, `getPrices(card)` returning `{ source, currency, low, mid, market, trend, fetchedAt }[]`. Lookups write through to `cards` and `price_snapshots`; the frontend only queries PocketBase. Cache: metadata 30 days, prices 24 hours, "refresh now" bypasses.
- `services/pricesync` (04:00 nightly): streams Cardmarket guides 1, 3, 6, 18, 19 and the matching TCGCSV files, filters to ids in `cards`, upserts `price_snapshots` in batches of 200, updates `cards.prices`, flags prices older than 3 days.
- Weekly cron syncs `card_sets` from TCGdex, Scryfall, Lorcast and OPTCG.
- Images from sources that forbid hotlinking (YGOPRODeck, OPTCG) are stored in PocketBase; TCGdex, Scryfall and Lorcast images are linked, with a local copy saved when an item is created so labels and receipts never depend on a third party.

## SumUp integration (verified against developer.sumup.com)

- **No catalogue API** on Free POS or POS Plus (£39 a month); only POS Pro (£49 a month + £19 stock module, iPad-only) has one. Pushing products is CSV only.
- **CSV import** columns: Item name, Description, Category, Price, SKU, Barcode, Quantity, Tax rate (%), Variations, Option set 1 to 4, Modifiers, Display colour. Our export writes this layout, puts our SKU in `SKU` and `Barcode`, and prefixes item names with the SKU so SumUp sales match back.
- **Transactions API** (`GET /v2.1/merchants/{code}/transactions/history` with `changes_since`, then `GET .../transactions?id=` for `products[]`) covers card and cash sales rung through the SumUp app with an ordinary merchant API key. Products carry no SKU, hence the prefix.
- **No webhooks** for sales taken in the SumUp app.
- **Reader (Solo) Cloud API**: our app can create a checkout on a Solo with an amount and a `return_url`; SumUp calls back when paid. Optional "Take card payment" on the Sell screen so nobody keys a price twice.

Plan: Phase 4 ships the CSV export and the transactions pull feeding the cash reconciliation screen; Phase 7 adds Solo checkouts with a `/api/vault/sumup/callback` route.

## Card Uploader and the eBay round trip

carduploader.com photographs a card, identifies it, prices it (TCGplayer with a multiplier) and exports eBay (ebay.co.uk in GBP), TCGplayer, Cardmarket and Shopify files plus a per-card CSV. Its guides confirm cards are matched on the **TCGplayer product SKU** and carry the **Cardmarket product id**, the two keys our `cards` rows index, so imported rows price without name matching. With Managed Inventory it writes a `CS-XXXXXX` SKU into eBay's custom label, stored on our item as `ebay_sku`.

The per-card CSV headers are only visible inside a logged-in account, so one real export is a Phase 1 prerequisite; the importer reads a mapping config (`docs/csv-formats.md`). Rows with ids match `cards` directly; name-only rows go through search with a review queue. Round trip: import marks items `listed_ebay`; an eBay orders CSV import marks them sold with the order ref; selling a listed item in the shop adds it to an "end these listings" list.

## Labels (ORGSTA T003)

- Stock: die-cut thermal labels, 25 mm core. **40 × 20 mm** for top loaders and unboxed retro, **25 × 15 mm** for sleeves and small accessories, **50 × 30 mm** for boxed retro, **80 × 50 mm** for the customer QR card (wallet PDF as the alternative). Removable adhesive so labels peel off top loaders.
- Symbology: **QR everywhere** (phone cameras and every 2D scanner read it; Data Matrix is not read by native camera apps). 40 × 20 at 203 dpi is 320 × 160 px: QR about 110 px on the left; title, set + number + finish in mono, condition badge and price on the right; a small "GG" mark. The 25 × 15 label carries an 11 mm QR for the in-app scanner or a USB 2D scanner at close range.
- Printing path 1 (day one): `/labels/print?job=…` renders `@page { size: 40mm 20mm; margin: 0 }`, one label per page; the counter PC has the T003 driver and Chrome runs with `--kiosk-printing`, so a print is one click with no dialog.
- Printing path 2 (later): WebUSB TSPL2 sender in the counter PC's Chrome (`SIZE`, `GAP`, `DENSITY`, `CLS`, `QRCODE`, `TEXT`, `PRINT`) driven by `label_jobs`, so phones print to the counter printer. Windows needs the WinUSB binding through Zadig (runbook); macOS, Linux and ChromeOS work as is. Bluetooth from the browser is not viable.
- Scanners: a USB 2D keyboard-wedge scanner (Zebra DS2208 at about £80, or a £30 to £45 Eyoyo / NETUM 2D) with a prefix character and Enter suffix. No 1D-only laser scanners.
- Library: `bwip-js` for on-screen, print and TSPL rendering.

## Security, GDPR and record keeping

- **ID photos**: encrypted in the upload route with `$security.encrypt` and a key from the environment (not `pb_data`) before saving to `id_documents.photo`. Viewing goes through `/api/vault/id-photo/:id`: admin role plus a step-up (password or MFA in the last 10 minutes), audit row written before streaming, decrypted blob served with `Cache-Control: no-store`, shown through a blob URL revoked on close. Client-side downscale to 1600 px and EXIF strip. Purge cron deletes photos at `expires_at` (default 12 months after the last cash buy-in; admin can set 6, 12 or 24) while ID fields stay on `customer_private`.
- **Lawful basis**: the Data (Use and Access) Act 2025 (in force June 2026) makes "detecting, investigating or preventing crime" a recognised legitimate interest, so the ID check needs no balancing test; marketing consent stays separate. Loyalty data processing rests on the programme terms the customer accepts. Privacy notice in `docs/privacy-notice.md`, shown in the wizard and portal; DPIA and retention schedule in `docs/`.
- **Local dealer rules**: England has no national second-hand dealer registration, but some areas have local Acts (Kent, Greater Manchester, Merseyside, Lancashire) requiring purchase records with the seller's name and address kept 2 to 3 years. Action for the shop: ask Bolsover District Council and Derbyshire Trading Standards. The seller snapshot on every cash buy-in satisfies any of them.
- **High value dealer**: the Money Laundering Regulations 2017 make cash of €10,000 or more per transaction (reported as moving to £10,000 in mid-2026; confirm with HMRC) require registration, covering cash received as well as paid. The cap (default £8,000) applies to cash payouts and cash sales.
- **Retention**: ID photo 12 months; ID fields, seller snapshot, trade-ins, sales, stock book and audit log 6 years (HMRC); quote photos 90 days after the quote closes; points and credit ledgers as long as the customer exists.
- **Erasure**: anonymises `customers` and `customer_private`, deletes the photo, voids open rewards, and keeps numbered trade-in and sale records with their seller snapshot (UK GDPR Article 17(3)(b)).
- **Shared counter PC**: staff tokens 12 hours with a UI idle lock; PIN switching through a custom route (hashed PIN, only valid on a device with a full password login that day, 5 failures then password). Step-up for photo view, refunds, credit and points adjustments, PII exports.
- **Platform**: MFA on `_superusers`; `/_/` restricted to the shop IP or a VPN in Caddy; PocketBase rate limits on `*:auth`, `*:authRefresh`, `customers:requestOTP` and `/api/vault/*`; CSP `default-src 'self'; connect-src 'self'; img-src 'self' assets.tcgdex.net cards.scryfall.io cards.lorcast.com blob: data:; frame-ancestors 'none'`; HSTS; restic backups nightly with a quarterly restore test in `deploy/restore.md`.
- **ICO**: data protection fee (tier 1, about £52 a year) and a complaints procedure with acknowledgement within 30 days (DUAA requirement); both in the runbook.

## Notifications and receipts

Email (Resend, Postmark or Brevo) and Web Push: OTP codes, quote received, offer made, offer expiring, trade-in purchase receipt (seller details, items, prices, signature, terms), credit issued, points earned summary, tier reached, reward ready, want-list match with the 48-hour hold, ID expiring soon, points expiring in 30 days. Receipts print as A4 or PDF from the counter PC; a 58 mm receipt printer can be added later. The customer QR card prints on an 80 × 50 mm label or as a wallet PDF.

## Deployment (VPS runbook, `deploy/README.md`)

1. DNS: `vault.ggentertainment.co.uk` A record to the VPS.
2. Caddy: `vault.ggentertainment.co.uk { reverse_proxy 127.0.0.1:8091 }` plus the CSP, rate-limit and `/_/` IP snippets.
3. `docker compose up -d` from `deploy/` (PocketBase image with hooks, migrations and `pb_public` baked in; `pb_data` bind-mounted; `pricesync` scheduled).
4. First run: superuser with MFA, migrations apply, seeds for `games`, `pricing_rules`, `loyalty_programme`, default tiers and rewards, `label_templates`, `settings`, first admin.
5. Backups: `backup.sh` (restic to R2 or B2, encrypted, key off-box) at 03:00, keep 30 daily and 12 monthly; rehearse `restore.md` before go-live.
6. GitHub Actions: on push to `main`, build the PWA, rsync `pb_public`, `pb_hooks`, `pb_migrations`, restart the container.
7. Counter PC: T003 driver, Chrome shortcut with `--kiosk-printing`, USB scanner with prefix + Enter, PWA installed; optional tablet in `/display` kiosk mode. Phones: PWA installed from the address bar.

## Phases

Ordered so the counter is usable early. ID on file, labels, selling and the stock book are day-one needs; catalogue pricing, loyalty and the portal follow.

1. **Foundation and design system**: repo scaffold, shadcn init with the GG Minimal preset and both colour modes, Impeccable installed with `PRODUCT.md`, `DESIGN.md` and the reference screens, component kit page (every variant in both modes, next to the references), `ProductImage` with the platform ratio table and both finishes, PocketBase schema, rules and seeds, staff auth, deploy pipeline, the counter shell (top nav, bottom bar, command palette) live on the VPS. Gate: the Scan and Add stock screens built first and put side by side with the references until they match in weight, spacing and type. Prerequisites from the shop: one Card Uploader per-card CSV, one SumUp sales export, an email provider account, VPS OS and Caddy layout confirmed.
2. **Counter MVP**: customers (create, search, merge, QR card), ID gate with encrypted photo, buy-in wizard with manual pricing, items and SKUs, labels with printing path 1, scan-to-sell with basket, undo and refunds, cash sessions, purchase receipt, home tiles, audit log, retention cron, stock book export. The shop can trade on this.
3. **Pricing**: adapters for all five games and retro (IGDB, PriceCharting PAL-first behind a setting), the eBay UK asking adapter with its haircut, UK sold comps, the UK-first valuation order with the side-by-side source view, FX cron and conversion tests, pricing rules and offer calculator with the settings editor, suggested sell prices, `pricesync`, stale flags, price-check mode, eBay advisory range, offline queue and PWA shell, stock counts.
4. **Reporting, exports and imports**: `daily_stats`, the reports suite with charts, saved and scheduled reports, weekly digest; SumUp CSV export, transactions pull and reconciliation; Card Uploader import; eBay orders import and "end listings"; inventory, sales and register exports.
5. **Portal and quotes**: OTP login and claim, my card, trade-ins, credit, quotes with photos, staff quote queue, offer accept and decline, quote to buy-in, want lists with holds, public estimate calculator, email and push notifications.
6. **Loyalty**: programme settings, rules and tiers editors with live preview, perks applied at the Sell screen, rewards catalogue and redemptions by QR, referrals, memberships, portal Guild pages, loyalty reports, customer-facing display.
7. **Polish and extras**: `/impeccable polish`, `animate` and `delight` passes across the app, WebUSB printing and the cross-device print queue, Solo reader checkouts, reservation expiry, snapshot roll-up, keyboard shortcut overlay, bulk label reprint, Stripe subscriptions for paid memberships (optional).

Each phase ends deployed to the VPS.

## Build execution and model delegation

Richard asked for Opus 5 and Sonnet 5 to take any part of the build they can, to save tokens. The Agent tool in this environment accepts a `model` override (`sonnet`, `opus`, `fable`) and worktree isolation, so each phase is split into work packages and dispatched by model. Fable stays the orchestrator: it writes the package briefs, reviews every returned diff against this plan and the reference screens, runs the design and copy gates, and does the integration commits.

| Goes to | Work packages | Why |
|---|---|---|
| **Sonnet 5** (bulk of the code) | Repo scaffold and tooling; shadcn init and generated components; PocketBase migrations, API rules, seeds and typegen; every catalogue and price adapter (the APIs are documented in this plan with endpoints and fields); the `pricesync` script; CSV importers and exporters with fixtures; unit tests; label templates and print pages; report queries and `daily_stats`; deploy files, Caddy snippet, backup and restore scripts; runbook and docs; the platform ratio seed table | Well-specified, pattern-following work with clear acceptance tests; cheapest per token |
| **Opus 5** (judgement inside a clear spec) | The GG variants of shadcn components (underline Input, block and circle Button, hairline Table) and `ProductImage`; the Scan, Add stock, Buy-in wizard, Sell and portal screens; the loyalty evaluator and its admin editor with live preview; the transactional routes (trade-in and sale completion, refunds, redemptions); the ID photo encrypt and view routes; the offline queue; motion and the customer-facing display; `/impeccable` passes on finished screens | Design-sensitive or correctness-critical, but bounded by this plan and the references |
| **Fable** (this session) | Phase briefs and package splitting; review of every subagent diff (`/code-review` at high effort on anything touching money, auth, ID data or loyalty); the side-by-side gate against the reference screens; DESIGN.md and PRODUCT.md decisions; resolving conflicts between packages; final integration, commits, pull requests and the CI loop | Where a wrong call costs the most |

Rules for the dispatch:
- One package per subagent, with the relevant plan sections pasted into the brief, the files it may touch, the acceptance tests it must add, and "no design decisions outside DESIGN.md". Parallel packages run in separate worktrees on the same branch family and Fable merges them.
- Sonnet 5 packages carry a Fable review before merge; Opus 5 packages carry a Fable review plus the Impeccable critique on any screen.
- A package that comes back off-plan is re-briefed once with the diff annotated; on a second miss Fable does it.
- Haiku is not used for code; it may run log and fixture housekeeping.
- Expected split by effort: about 60 percent Sonnet 5, 30 percent Opus 5, 10 percent Fable.

## Verification

- Unit tests (Vitest): SKU generation and check character, money rounding, currency conversion (US cents and EUR decimals to GBP pence at a fixed rate, half-up rounding, stored rate reproduces the same figure), £ formatting, the UK-first source selection with stale and missing sources, the eBay asking haircut, pricing-rule selection, condition multipliers, sell-price bands, VAT scheme assignment, loyalty evaluator (rules stacking, tier thresholds, expiry, referral), CSV builders and parsers with fixtures from the real Card Uploader and SumUp files.
- Hook and rule tests: PocketBase on a throwaway `pb_data`; custom routes exercised with `curl` (lookup, offer, trade-in completion with cash cap and ID gate, sale completion with perks and points, refund reversal, redemption, ID photo route with and without step-up); API rules asserted by attempting forbidden reads and writes as a customer.
- pricesync test against a saved 1 MB slice of a Cardmarket file.
- End-to-end (Playwright, Chromium preinstalled): staff login, open cash session, add stock, label page renders at 40 × 20 mm, scan-to-sell posts the sale, cash movement and points; new customer, cash buy-in blocked until ID and address captured, items appear with labels queued, receipt email sent; customer OTP login, redeem a reward, show the QR, staff scan it in a sale; submit a quote with photos, staff offer, customer accepts, draft buy-in exists; offline: disconnect, queue a sale, reconnect, sale appears.
- Design gate per phase: `/impeccable audit` and `/impeccable critique` clean, both colour modes checked, 360 px viewport for every screen, camera scanning on Android Chrome and iOS Safari, copy reviewed against stop-slop.
- Adapter smoke tests behind a flag: a known card per game returns an image URL and a price shape.
- Deployment: `curl https://vault.ggentertainment.co.uk/api/health`, backup present and a restore rehearsed, a label prints on the T003, `/_/` unreachable from outside the shop.

## Open questions and assumptions

- Subdomain assumed `vault.ggentertainment.co.uk`.
- The marketing site's Caddy and PocketBase are assumed to be on the VPS the app will use; otherwise the app gets its own Caddyfile.
- One shared counter PC (Windows) with the T003 on USB, staff phones, and an optional tablet for the customer display.
- Loyalty defaults (10 points per £1, 100 points = £1 credit, tiers Member / Regular / Legend at 0 / 2,500 / 10,000 points in a rolling year, welcome bonus 100, referral 250 each way) are seeds for Richard to change in the admin editor, not decisions.
- PriceCharting at $49 a month is a business decision; the adapter is built either way with manual pricing as the fallback.
- VAT registration status is unknown; scheme fields exist from day one so it can be switched on without a migration.
- Partial refunds and a receipt printer are out of scope for v1; the data model allows both.
