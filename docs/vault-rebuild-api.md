# Vault rebuild: the backend contract for apps/vault

The new staff app (apps/vault) does five jobs: scan or search a card, see its UK-first prices per condition, build a buy-in deal (80% trade credit / 70% cash sweep, per-card rate overrides, part cash and part credit, a final total override), complete it into stock, and manage stock. There is no till, no bookings and no loyalty in it.

This document maps what the PocketBase backend already offers for each job, what was added for the deal calculator (migration `1789821460_vault_deal.js`, `pb_hooks/vaultdeal.pb.js` and `lib/vaultdeal.js`, on top of the canonical `packages/shared/src/deal.ts`), and the gaps that are still open. Older, fuller contracts: `docs/api-contract.md`, `docs/api-contract-launch.md`, `docs/api-contract-inventory.md`.

## Conventions

- **Base**: every custom route is under `/api/vault/...`; collections use PocketBase's own `/api/collections/{name}/records`.
- **Auth**: a staff token from `POST /api/collections/staff/auth-with-password` (`{identity, password}` -> `{token, record}`), sent as `Authorization: <token>`. Custom routes use `$apis.requireAuth("staff")`: a superuser token is **not** accepted on them. An inactive staff account cannot get a token. No route in this document checks a role (admin or manager); any staff record, agent records included (`staff.kind = "agent"`), can call them. Collection rules use `STAFF_ONLY = @request.auth.collectionName = "staff"`.
- **Money**: integer GBP pence everywhere. A foreign amount (`native_*`) is supporting detail beside its `gbp_*` conversion, never shown alone.
- **Errors**: `{ "status": 422, "message": "...", "data": {} }`. 400 validation, 401 no token, 403 wrong role, 404 not found, 409 state conflict, 422 business rule (ID gate, cash cap), 502 an upstream API failed. `message` is written to be shown to staff as-is.
- **Text**: no em-dashes, no exclamation marks.

---

## 1. Card search (Pokémon, Magic, One Piece, Lorcana, Yu-Gi-Oh!)

Source: `pb/pb_hooks/lookup.pb.js`, `pb/pb_hooks/adapters/registry.js` and one adapter per game.

| game key | adapter | external API |
|---|---|---|
| `pokemon` | `adapters/tcgdex.js` | api.tcgdex.net |
| `mtg` | `adapters/scryfall.js` | api.scryfall.com |
| `onepiece` | `adapters/optcg.js` | optcgapi.com |
| `lorcana` | `adapters/lorcast.js` | api.lorcast.com |
| `yugioh` | `adapters/ygoprodeck.js` | db.ygoprodeck.com |

Search calls the game's API and writes every result through to the local `cards` and `card_sets` collections, so a result always has a local `id` for prices and stock.

### `GET /api/vault/lookup?game=<key>&q=<text>` (staff)

- `game` is required, one of the five keys. Otherwise 400 `Unknown game "x". Pick one of pokemon, mtg, yugioh, onepiece, lorcana.`
- `q` is either a name or a set and number:
  - Pokémon, Magic and Lorcana take `"<set> <number>"`, for example `sv151 199`, `mh3 241`, `1 207`. The number matches `^\d+[A-Za-z]?$`; Lorcana also takes `n/total`. The set must match `card_sets.code` (case-insensitive) or an alias (only `pokemon: sv151 -> sv03.5` so far).
  - One Piece and Yu-Gi-Oh! take one hyphenated code, for example `OP01-001` or `CT13-EN003`.
  - Anything else is a name search.
- At most 25 rows.
- A set-and-number match whose local row was synced in the last 30 days is served with no outbound call.

Response 200:
```json
{
  "cards": [
    {
      "id": "k3j2a8sd0f1q2w3",
      "game": "g_pokemon_id",
      "set": "s_sv035_id",
      "set_code": "sv03.5",
      "set_name": "151",
      "number": "199",
      "name": "Charizard ex",
      "rarity": "Special Illustration Rare",
      "image_small": "https://assets.tcgdex.net/en/sv/sv03.5/199/low.webp",
      "image_large": "https://assets.tcgdex.net/en/sv/sv03.5/199/high.webp",
      "finishes_available": ["holo"],
      "external_ids": { "tcgdex": "sv03.5-199" },
      "last_synced": "2026-11-09 10:00:00.000Z"
    }
  ]
}
```

### `GET /api/vault/lookup/{game}/{set}/{number}` (staff)

The same response shape with one card. 404 `Card not found in <set name>. Check the number or add it manually.`

### Other ways to read the catalogue

- `GET /api/collections/cards/records?filter=...` is public. Use it for a local-only search, for example `filter=name~"charizard" && set.code="sv03.5"&expand=set`. `cards.prices` is a JSON summary written by the nightly pricesync job.
- `GET /api/vault/estimate/search?q=` is public and searches the local catalogue. It returns a slimmer shape, `{id, name, set, number, image, finishes}`.

### Gaps

- **One game per call.** There is no cross-game search, and no set filter on a name search.
- **Every name search calls the external API.** Staff have no route that searches the local catalogue only; use the collection API above.
- **One Piece by name** returns 422 `One Piece search needs a card code, for example OP01-001.`
- **Pokémon name results are sparse.** `set_name`, `rarity` and `finishes_available` are empty until the exact lookup fills them.
- **An upstream failure looks like "no results".** It returns 200 `{cards: []}`, so the app cannot say "the Pokémon API is down".

---

## 2. Card detail and prices

Source: `pb/pb_hooks/prices.pb.js`, `pb/pb_hooks/adapters/pricing_policy.js`, `packages/shared/src/pricing.ts` and `money.ts`.

Card fields come from `GET /api/collections/cards/records/{id}?expand=set,game`, which is public.

### Price sources

Every price, from every source, is a row in `price_snapshots`. Anyone can read them; only staff can write them.

| field | meaning |
|---|---|
| `card` or `retro_title` | what the price is for |
| `finish` | the card's finish |
| `source` | where the price came from (table below) |
| `native_currency` | `GBP`, `EUR` or `USD` |
| `native_low`, `native_mid`, `native_market`, `native_trend` | the original figures, in minor units |
| `fx_rate`, `fx_date` | the conversion used |
| `gbp_market` | pence |
| `fetched_at` | when it was fetched; for a comp, the sale date |
| `evidence_url` | link to the listing |

Card priority comes from `settings.source_priority`. The first fresh source wins:

| source | currency | fresh for | what it is |
|---|---|---|---|
| `uk_sold_manual` | GBP | 30 days | An eBay UK **sold** comp entered by staff or an agent. This is the only UK sold data; eBay has no sold API for us. |
| `ebay_uk_asking` | GBP | 24 h | eBay Browse API, UK-located fixed-price listings: the median of the 5 cheapest asks, minus `settings.offer.ebayHaircutPct` (default 15%). Asking prices, not sold. Only fetched when `settings.api_keys.ebay` is set. |
| `cardmarket` | EUR | 72 h | From the adapters and the nightly `services/pricesync`. |
| `tcgplayer` | USD | 72 h | From the adapters and pricesync. |

If no source is fresh, the freshest stale row is chosen and flagged `stale: true`.

**Conditions** are `NM`, `LP`, `MP`, `HP` and `DMG`; an empty condition means NM, and any other value is 400. Multipliers come from `settings.condition_multipliers`, default `{NM:1, LP:0.85, MP:0.7, HP:0.5, DMG:0.3}`. They are applied to the chosen price only: `condition_adjusted = roundHalfUp(gbp_market x multiplier)`.

**GBP conversion** happens once, when the snapshot is written:
- The rate is the latest `fx_rates` row, `quotes` in GBP per unit, for example `{"EUR":0.8606,"USD":0.79}`. A daily cron fetches it from Frankfurter (ECB).
- `convertMinorToGbpPence(minor, currency, rate)` is `roundHalfUp(minor x rate)`.
- A foreign price is never stored without a rate. With no rate, the snapshot is silently skipped.

### `GET /api/vault/cards/{id}/prices?finish=holo&condition=LP` (staff)

Reads snapshots only, with no outbound calls. `finish` must match exactly.

```json
{
  "chosen": {
    "source": "uk_sold_manual", "gbp_market": 21500, "native_currency": "GBP", "native_market": 21500,
    "fx_rate": 1, "fx_date": "2026-11-01", "fetched_at": "2026-11-01T00:00:00.000Z", "stale": false,
    "evidence_url": "https://www.ebay.co.uk/itm/1234567890"
  },
  "sources": [
    { "source": "uk_sold_manual", "gbp_market": 21500, "native_currency": "GBP", "native_market": 21500, "fx_rate": 1, "stale": false },
    { "source": "ebay_uk_asking", "gbp_market": 22100, "native_currency": "GBP", "native_market": 22100, "fx_rate": 1, "stale": true },
    { "source": "cardmarket", "gbp_market": 19800, "native_currency": "EUR", "native_market": 23007, "fx_rate": 0.8606, "fx_date": "2026-11-07", "stale": false }
  ],
  "condition_adjusted": 18275
}
```

404 `Card not found. Check the id or add it manually.`

### Other price routes (staff)

- **`POST /api/vault/cards/{id}/refresh-prices`** with body `{finish?, condition?}`. Calls the game adapter, plus eBay UK when a key is set, writes the snapshots and returns the same body as the GET. Audited.
- **`POST /api/vault/cards/{id}/uk-comp`** records a UK sold comp.
  - Body: `{finish?, condition?, price, url, sold_at}`. `price` is pence, 1 to 5,000,000.
  - `url` must be an `ebay.co.uk/itm/...` link.
  - `sold_at` is `YYYY-MM-DD`, not in the future and at most 30 days old.
  - Writes a `uk_sold_manual` snapshot and returns the GET body.
- **`GET /api/vault/fx`** returns `{"base":"GBP","rates":{"EUR":0.8606,"USD":0.79},"date":"2026-11-07","fetched_at":"...","stale":false}`. `stale` means older than 72 hours.

### Gaps

- **No per-condition comps.** `uk-comp` validates `condition` but does not store it. An LP comp becomes the market price and is then discounted again by the LP multiplier. The deal calculator should treat `chosen.gbp_market` as the NM figure, or the app should send `condition` blank for comps until this is fixed.
- **One comp per source.** Only the newest row per source counts; several UK comps are not averaged.
- **No single card-detail route.** Combine the collection read with `/prices`.
- **eBay UK figures are asking prices**, after a haircut, not sold prices.

---

## 3. Photo scan and identification

**Nothing exists on the server.** There is no Anthropic, Haiku, Sonnet or other vision call anywhere in `pb/pb_hooks`, `services` or `apps/web/src`, and no AI SDK in any package.

What does exist:
- `apps/web/src/lib/scanning/camera.ts`: barcode and QR scanning through `BarcodeDetector`, or `zxing-wasm` where that is missing.
- `route-code.ts`: routes a scanned GG SKU, customer code, voucher or EAN.
- `capture-quality.ts`: a client-side frame-quality check (brightness, blur, glare, tilt) that "goes green when the frame is worth sending to the card ID model". Nothing imports it yet. It refers to a model bake-off held outside this repo (`~/.buzz/REPOS/cardid-bakeoff`, `RESEARCH/CARD_ID_BAKEOFF_RESULTS.md`).

**Gap, to build next.** This is a proposed contract, not implemented:

`POST /api/vault/identify` (staff), with body `{ "image": "data:image/jpeg;base64,...", "game"?: "pokemon", "deep"?: false }`.
- The server calls Haiku first. If confidence is low or `deep` is true, it calls Sonnet.
- The API key stays in `settings.api_keys` and never reaches the browser.
- Each candidate is resolved through the lookup above, so it carries a real `cards.id`.
- Response: `{ "candidates": [ { "card": CardRow, "confidence": 0.93, "reason": "set symbol and number 199/165 legible" } ], "model": "haiku", "escalated": false }`.

Rate-limit it per staff member, and do not store the image.

---

## 4. Retro (and comics)

Source: `lookup.pb.js` and `prices.pb.js`.

### `GET /api/vault/retro/lookup?q=zelda&platform=n64_box` (staff)

- Searches IGDB. It needs `settings.api_keys.igdb.{client_id, client_secret}`, otherwise 422; an IGDB failure is 502.
- Returns `{ "titles": [ { "id", "platform", "name", "region", "cover", "external_ids" } ] }`, up to 25.
- `platform` is a `platforms.key`, for example `gameboy_cart`, `snes_pal_box`, `n64_box`, `megadrive_box`, `ps1_case`, `ps2_case` or `gamecube_case`. A title is only saved to `retro_titles`, and so only gets an `id`, when `platform` is given.

### Retro price routes (staff)

- **`GET /api/vault/retro/{id}/prices?completeness=loose|boxed|cib`** returns the same `{chosen, sources, condition_adjusted: null}` shape as cards.
  - Priority comes from `settings.retro_source_priority`: `uk_sold_manual`, then `pricecharting_pal` (USD cents, converted), then `ebay_uk_asking`, then `pricecharting_ntsc`.
- **`POST /api/vault/retro/{id}/refresh-prices`** with body `{completeness}`. It needs `settings.api_keys.pricecharting`, otherwise 422.
- **`POST /api/vault/retro/{id}/uk-comp`** with body `{completeness, price, url, sold_at}`, under the same rules as cards.

### Gaps

- **Unchecked mappings.** The PriceCharting category slugs and IGDB platform ids have never been checked against a live key.
- **Comics: nothing exists.** There is no collection, adapter or route; "comic" appears nowhere in the code.

---

## 5. Research queue (ask for a UK sold-price check)

Source: `research.pb.js`, `lib/research.js`, collection `research_requests`. Staff can list and view through the collection API; every write goes through these routes.

| Method and path | Body or query | Response |
|---|---|---|
| `POST /api/vault/research` | `{query?, card?, retro_title?, item?, trade_in_line?, condition?, finish?}` | 201 `{request}`, or 200 `{request, existing: true}` when an open one already exists for the same subject |
| `GET /api/vault/research` | `?status=open,claimed&card=&retro_title=&item=&trade_in_line=&page=` | `{requests, page, per_page: 50, total}`, newest first |
| `GET /api/vault/research/{id}` | | `{request}` |
| `POST /api/vault/research/{id}/claim` | | `{request}`; 409 if someone else holds it or it is closed |
| `POST /api/vault/research/{id}/complete` | `{result?, comps?: [{price, currency: "GBP", sold_at, url, title?, condition?}]}` (at most 20 comps, each validated like `uk-comp`) | `{request, written}` |
| `POST /api/vault/research/{id}/cancel` | | `{request}` |

Request shape:
```json
{
  "id": "r1", "query": "Charizard ex 151 199 holo NM", "status": "open",
  "card": "k3j2a8sd0f1q2w3", "retro_title": "", "item": "", "trade_in_line": "",
  "condition": "NM", "finish": "holo", "title": "Charizard ex · 151 · 199",
  "requested_by": { "id": "st1", "name": "Sam", "kind": "person" },
  "claimed_by": null, "claimed_at": "", "result": "", "comps": [], "done_at": "",
  "created": "2026-11-09 10:00:00.000Z", "updated": "2026-11-09 10:00:00.000Z",
  "ebay_url": "https://www.ebay.co.uk/sch/i.html?_nkw=Charizard+ex+151+199+holo+NM&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1"
}
```

**From a deal line**, send `{ "trade_in_line": "<line id>" }`; it takes the finish and condition from the line. Creating a request calls the agent webhook (Gandalf). Completing it writes each comp as a `uk_sold_manual` snapshot on the card or retro title, so the card then prices from it for 30 days.

### Gaps

- **Query-only or item-only requests write no snapshot.** A request with no card or retro title keeps its comps on the request itself.
- **There is no "unclaim".**

---

## 6. Stock items

There are no custom CRUD routes; stock uses the collection API on `items`. All five rules (list, view, create, update and delete) are `STAFF_ONLY`.

### Key fields

| field | type and values |
|---|---|
| `sku` | Unique. Generated when blank. |
| `kind` | Required: `single`, `graded`, `retro`, `sealed`, `accessory`, `other`. |
| `game` | Relation, required. |
| `card` | Relation. |
| `retro_title` | Relation. |
| `title` | Derived from the card or retro title when blank. |
| `set_code`, `number`, `finish`, `language` | Text. |
| `condition` | `NM`, `LP`, `MP`, `HP`, `DMG`. |
| `completeness` | `loose`, `boxed`, `cib`. |
| `cosmetic_grade` | `A`, `B`, `C`. |
| `region` | `PAL`, `NTSC`, `JP`. |
| `tested` | Bool. |
| `grade_company`, `grade`, `cert_no`, `ean` | Text. |
| `qty`, `cost`, `market_at_intake`, `price` | Integers; the money ones are pence. |
| `tax_scheme`, `vat_rate` | `tax_scheme` is `margin`, `standard`, `exempt` or `zero`. |
| `status` | `in_stock`, `reserved`, `listed_ebay`, `sold`, `returned`, `written_off`. |
| `location` | Relation to `locations` (`name`, `type`, `sort`). |
| `category` | Relation to `categories`. Auto-filed when blank. |
| `photos` | Up to 12 files, with thumbs `160x0`, `320x0`, `640x0`. |
| `source` | `trade_in`, `supplier`, `opening_stock`. |
| `trade_in_line` | Relation. |
| Dates | `acquired_at`, `reserved_until`, `listed_at`, `label_printed_at`. |
| Other | `ebay_listing_id`, `ebay_sku`, `notes`, `reserved_for`, `created_by`, `supplier`, `shelf_target`, `show_online`. |

**SKU** (`packages/shared/src/sku.ts`) is `GG` + a kind letter + 5 Crockford base32 characters + a check character. The kind letters are S single, G graded, R retro, P sealed, A accessory, X other. It is displayed as `GGS-7F3K2Q` and encoded in QR codes without the hyphen.

**Create:**
```
POST /api/collections/items/records
{"kind":"single","game":"<games id>","card":"k3j2a8sd0f1q2w3","finish":"holo","condition":"NM","qty":1,
 "cost":12000,"market_at_intake":21500,"price":22999,"location":"<locations id>","status":"in_stock",
 "source":"supplier","tax_scheme":"margin"}
-> 200 { ...record, "sku": "GGS7F3K2Q", "title": "Charizard ex #199" }
```

**List and filter:**
```
GET /api/collections/items/records?filter=status="in_stock" && location="<id>" && category.lineage~"|<catId>|"
  && (title~"char" || sku~"char" || set_code~"char" || number~"char" || ean~"char")
  &expand=card,location,category&sort=-created
```

**Detail:**
```
filter=sku="GGS7F3K2Q"
expand=card,game,location,category,trade_in_line.trade_in,trade_in_line.trade_in.customer
```

**Update** is a `PATCH` on the record: reserve with `{status:"reserved", reserved_for, reserved_until}`, write off with `{status:"written_off", notes}`.

### Imports (staff)

- **`POST /api/vault/imports/card-uploader`**
  - Multipart `file` (CSV, at most 10 MB).
  - Headers are mapped by `settings.import_mappings.card_uploader`.
  - Returns `{import, matched, review}`.
- **`POST /api/vault/imports/ebay-orders`** returns `{import, sold, already_sold}`.
- **`GET /api/vault/imports/{id}`** returns the import record.
- **`POST /api/vault/imports/{id}/link`** with body `{row, card}` or `{row, skip: true}`. Returns `{import, item, path}`.

Formats are in `docs/csv-formats.md`. There is **no generic stock CSV import**, for example an opening stock sheet.

### Labels (staff)

- **`POST /api/vault/labels/queue`**
  - Body: `{items?: [ids], trade_in?, acquired_from?, acquired_to?, location?, kind?, game?, template?, copies?: 1..20, include_queued?}`.
  - Returns `{queued, skipped, job_ids}`. At most 500 labels.
- **`POST /api/vault/labels/claim`** with body `{printer, limit?, templates?}`. Returns `{jobs}` for the print agent.
- **`POST /api/vault/labels/{id}/printed`**, **`/failed`** and **`/requeue`**.
- The `label_jobs` and `label_templates` collections are `STAFF_ONLY`.

### Gaps

- **No role checks or audit on stock.** Any staff member can delete an item or change its `cost` or `price` through the collection API, and nothing is audited.
- **A client-supplied `sku` is not validated** against the check character.

---

## 7. Trade-ins today (`tradeins.pb.js`, `lib/tradeincomplete.js`)

### Collections

- **`trade_ins`** fields:
  - `number`: `GG-BI-000123`, set on completion.
  - `customer`: required.
  - `channel`: `counter` or `remote`.
  - `status`: `draft`, `offered`, `accepted`, `completed`, `declined`, `cancelled`.
  - Payout: `payout_type` (`cash`, `credit`, `mixed`, `part_exchange`), `payout_cash`, `payout_credit`.
  - Totals: `total_market`, `total_offer`.
  - ID: `id_checked`, `id_checked_by`, `id_document`.
  - Seller snapshot: `seller_name`, `seller_address`, `seller_id_type`, `seller_id_last4`, `seller_id_expiry`.
  - Record: `signature` (a protected file), `staff`, `completed_at`.
  - Links: `cash_session`, `quote`, `sale`, `part_exchange_value`.
  - Rules: staff for everything; a customer can list and view their own.
- **`trade_in_lines`** fields:
  - What it is: `trade_in`, `card`, `retro_title`, `free_text_title`, `kind`, `game`, `finish`, `condition`, `completeness`, `cosmetic_grade`, `qty`.
  - Pricing: `market_price` (pence, GBP in practice), `market_currency`, `fx_rate`, `market_source`, `offer_pct`, `offer_price` (pence per unit, what is paid).
  - State: `accepted`, `item`.
  - Overrides: `override_reason`, `override_cash`, `override_credit`.
  - Rules: staff for everything; a customer can read lines on their own trade-ins.

Drafts and lines are created and edited through the collection API; completion is a custom route.

### `POST /api/vault/trade-ins/{id}/complete` (staff), unchanged

```json
{ "payout_type": "mixed", "payout_cash": 4000, "payout_credit": 2500, "terms_accepted": true,
  "signature": "data:image/png;base64,...", "cash_session": "<cash_sessions id>",
  "id_check": null }
```

It requires `payout_cash + payout_credit = sum(offer_price x qty)` over the accepted lines, which assumes one rate per line, not a cash rate and a credit rate. Response:

```json
{ "trade_in": { "id", "number", "status": "completed", "payout_cash", "payout_credit" },
  "items": [ { "id", "sku", "title" } ], "labels_queued": 3, "points_earned": 150, "credit_balance": 4500 }
```

### How the cards are booked into stock (shared by both completion routes)

Each accepted line becomes items:
- `single`, `graded` and `retro` get one row per unit, each with `qty` 1.
- `sealed`, `accessory` and `other` get one row with `qty` n.
- Every item gets `status: in_stock`, `source: trade_in`, `trade_in_line`, `acquired_at`, `tax_scheme: margin`, `market_at_intake = market_price`, and `location = settings.default_intake_location`.
- `cost` is what was paid, spread pro rata when less than the offer was paid.
- Every item gets one `label_jobs` row, using the template for its kind.

Each line's `item` points at its first unit. The SKU is generated by the items hook.

### The ID check before cash (`prepare()` in `lib/tradeincomplete.js`)

When `payout_cash > 0`, these checks run in this order:
1. A cap of 0 refuses cash outright. Cash above `settings.cash_cap` (default £8,000) is refused.
2. The seller's address must be on `customer_private`, or supplied in `id_check`.
3. The `no_cash` and `under_18` flags on `customer_private` refuse cash.
4. The customer must have `id_status = verified` with an unexpired `id_expiry`, or a full `id_check` (`id_type`, `id_expiry`) must be sent in the same call.
5. If the date of birth is known, the customer must be 18 or over.
6. There must be an `id_documents` row for the customer with a photo still on disk, or `id_check.id_document` must name one.
7. The photo's retention clock restarts, and the document is linked on `trade_ins.id_document`.

The photo comes from `POST /api/vault/customers/{id}/id-check`. It is multipart: `photo`, `id_type`, `id_expiry`, `id_ref_last4`, `dob`, `address`. The photo is encrypted with `GG_ID_PHOTO_KEY` and kept 12 months from the last cash buy-in. The response is `{id_document, id_status: "verified", id_expiry, expires_at}`.

`GET /api/vault/customers/{id}/id-document` tells the app whether the gate will pass, without exposing the photo. Viewing the photo needs an admin with a step-up: `GET /api/vault/id-photo/{id}`.

### Till, bookings and loyalty couplings in the old path (the new flow avoids all of them)

| Coupling | Where |
|---|---|
| **Cash sessions.** Cash is refused without an open `cash_sessions` id; a closed session is 422. A credit-only buy-in is linked to the default register's open session (`registers.openSession`). | `prepare()` |
| **`cash_movements`.** A `payout` row is written against the session. | `complete()` |
| **`credit_ledger`.** The credit is posted, and `customer_private.credit_balance` is recomputed (`lib/balances.js`). | `complete()` |
| **Guild points.** `points_ledger` gets `earn_trade_in` on the credit portion when the customer is a Guild member, using `loyalty_programme` and `loyalty_rules` (`lib/guild.js`, shared `loyalty.js`). | `complete()` |
| **Referrals.** `referrals.onFirstCompletion` pays out both sides and sends notifications. | `complete()` |
| **Sales and part-exchange.** `POST /api/vault/sales/complete` can complete a trade-in inside a sale (`trade_ins.sale`, `part_exchange_value`, `payout_type: part_exchange`). | `sales.pb.js` |
| **Bookings.** None in the buy-in path. | |
| **Customer display.** `display_state` and `/api/vault/display*` mirror the offer to the counter tablet. This is optional and not needed. | |

---

## 8. Deals: what was added for the calculator

The server prices a deal with the **canonical deal maths** in `packages/shared/src/deal.ts` (commit 1c892eb, `feat/deal-calculator`): `computeDeal`, `dealPayout`, `splitDeal`, `payoutLines` and `effectivePct`, plus `allocatePence` in `money.ts`. The hooks load the generated copy in `pb/pb_hooks/lib/shared/deal.js`. apps/vault uses the same module, so the screen and the server always agree.

Nothing existing changes meaning, and the old completion route behaves exactly as before. A deal is a `trade_ins` row; its lines are `trade_in_lines`.

### Migration `1789821460_vault_deal.js` (all fields optional)

`trade_ins`:

| field | type | canonical input |
|---|---|---|
| `trade_pct`, `cash_pct` | number 0-200 | `DealRates`. 0 or empty means `DEFAULT_DEAL_RATES` (80 / 70). |
| `trade_override_kind` | select `amount`, `pct` | `overrides.trade`. Empty means the trade side is not overridden. |
| `trade_override_pence` | int pence | `{kind: "amount", pence}`: the new trade total. |
| `trade_override_pct` | number 0-200 | `{kind: "pct", pct}`: the new trade total as a percent of market. |
| `cash_override_kind`, `cash_override_pence`, `cash_override_pct` | same | `overrides.cash`. Independent of the trade side. |
| `override_reason` | text 500 | Why. Never copied to the audit log. |
| `override_by`, `override_at` | relation staff, date | **Server-stamped** from the caller's token whenever either side's override changes, and ignored if sent in the body. Clearing a side's kind clears its pence and pct. Clearing both sides clears `override_by` and `override_at`. |
| `calculated_trade`, `calculated_cash` | int pence | `deal.calculatedTrade` / `calculatedCash`: what the rates made before any override. Written on completion. |
| `deal_trade_total`, `deal_cash_total` | int pence | `deal.trade` / `deal.cash`: the final totals. Written on completion. |
| *(existing)* `payout_cash`, `payout_credit` | int pence | **The split**: cash taken and credit given (`DealPayout`). |

`trade_in_lines`:

| field | type | canonical input |
|---|---|---|
| *(existing)* `market_price`, `qty` | int pence per unit, condition-adjusted | `marketPence`, `qty` |
| *(existing)* `market_source` | text | Shown only, for example `uk_sold_manual` or `cardmarket`. |
| `trade_pct`, `cash_pct` | JSON: `null` or a number 0-200 | `tradePct` / `cashPct`. `null` (or absent) follows the deal's sweep. Anything else is 400 `The line's trade rate has to be a percent from 0 to 200, or empty to use the deal's rate.` |
| *(existing)* `override_reason` + `override_credit` / `override_cash` | text, int pence per unit | When the reason is set: `fixedTrade` = `override_credit`, `fixedCash` = `override_cash`. This is a line priced by hand. |
| *(existing)* `accepted` | bool | **Must be true** for the line to count. |

### Building a deal (collection API, staff)

```
POST /api/collections/trade_ins/records
{"customer":"<id>","status":"draft","trade_pct":80,"cash_pct":70}

POST /api/collections/trade_in_lines/records
{"trade_in":"<deal id>","kind":"single","game":"<games id>","card":"<cards id>","condition":"NM","finish":"holo",
 "qty":1,"market_price":10000,"market_source":"uk_sold_manual","market_currency":"GBP","accepted":true,
 "trade_pct":null,"cash_pct":null}

PATCH /api/collections/trade_in_lines/records/<line id>   {"trade_pct":90}          per-card rate
PATCH /api/collections/trade_ins/records/<deal id>
{"trade_override_kind":"amount","trade_override_pence":12000,"override_reason":"Round number"}
{"cash_override_kind":"pct","cash_override_pct":60}                                 cash side, independently
{"cash_override_kind":""}                                                           clear the cash side
-> each response carries "override_by":"<staff id>","override_at":"2026-11-09 14:55:00.000Z"
```

### `GET /api/vault/deals/{id}` (staff)

This is `computeDeal` run on the server over the deal's stored fields and accepted lines. In this example the line market values are £100 x 1 and £25.50 x 2 with a 90% trade rate on the second, and the trade side is overridden to £120:

```json
{
  "deal": {
    "id": "1i4xlegexssc3k0", "status": "draft",
    "trade_pct": 80, "cash_pct": 70,
    "market_total": 15100, "calculated_trade": 12590, "calculated_cash": 10570,
    "trade_total": 12000, "cash_total": 10570,
    "trade_effective_pct": 79.5, "cash_effective_pct": 70,
    "overrides": {
      "trade": { "kind": "amount", "pence": 12000 }, "cash": null,
      "reason": "Round number", "by": "ccum8wdf579x0lj", "at": "2026-11-09 14:55:00.000Z"
    },
    "payout_cash": 0, "payout_credit": 0,
    "lines": [
      { "id": "l1", "market_price": 10000, "market_source": "uk_sold_manual", "qty": 1, "market": 10000,
        "trade_pct": 80, "cash_pct": 70, "trade_custom": false, "cash_custom": false, "fixed": false,
        "calculated_trade": 8000, "calculated_cash": 7000, "trade": 7626, "cash": 7000 },
      { "id": "l2", "market_price": 2550, "market_source": "cardmarket", "qty": 2, "market": 5100,
        "trade_pct": 90, "cash_pct": 70, "trade_custom": true, "cash_custom": false, "fixed": false,
        "calculated_trade": 4590, "calculated_cash": 3570, "trade": 4374, "cash": 3570 }
    ]
  }
}
```

An override rescales the lines pro rata so they still add up to the total. The other side stays as calculated. The all-credit figure is `trade_total`, and the all-cash figure is `cash_total`.

404 `Deal not found. Check the link and try again.`

### `POST /api/vault/deals/{id}/complete` (staff). No till session needed.

Request:
```json
{
  "cash_taken": 5000,
  "credit_given": 6324,
  "terms_accepted": true,
  "signature": "data:image/png;base64,... (optional)",
  "id_check": null
}
```

`id_check` takes the same shape as the old route: `{id_type, id_expiry, id_ref_last4, dob, address, id_document}`.

The server works out what the app should have computed with the same functions:

```
deal    = computeDeal(inputs, rates, overrides)
payout  = dealPayout("mixed", deal, cash_taken)
          (no cash makes it "credit" at deal.trade; all the cash makes it "cash")
lines   = payoutLines(deal, qtys, payout)
          (may give up one penny of credit it cannot place)
require   credit_given === lines.payout.credit
          (exact: splitDeal's half-up penny, after any payoutLines trim)
```

For £120.00 trade and £105.70 cash, £50.00 taken gives £63.24 credit.

The checks, in order:
1. The deal is `draft`, `offered` or `accepted`. Otherwise 409; a completed one is 409 `This trade-in is already completed.`
2. It has a customer and at least one accepted line.
3. `cash_taken` and `credit_given` are whole pence, zero or more. Otherwise 400.
4. `cash_taken` is not above `deal.cash`. Otherwise 400 `The cash taken is more than the cash offer of £105.70. Check the split.`
5. The credit matches. Otherwise 400 `The credit does not match the cash taken. The deal is £105.70 cash or £120.00 credit; £50.00 cash leaves £63.24 credit.`
6. `prepare()` runs, the same function as the old route, with `noSession`. That is the terms check, and for any cash above 0: the cash cap, the address, the flags, verified unexpired ID, 18 or over, and an ID photo on file. These give the same 422 messages, for example `Take a photo of the customer's ID before paying cash.`

Then, in one transaction:
- the number `GG-BI-…` is assigned;
- items and label jobs are created as in section 7, each item costing `payoutLines.perUnit` for its line, so the items add up to cash plus credit exactly;
- each line gets `offer_price` = its per-unit figure and `offer_pct` = `effectivePct` of it against market;
- the ID check and photo retention are handled as before;
- the seller snapshot is taken;
- the trade-in gets `status: completed`, `payout_type` (`cash`, `credit` or `mixed`, from `dealPayout`), `payout_cash`, `payout_credit`, `trade_pct`, `cash_pct`, `calculated_trade`, `calculated_cash`, `deal_trade_total` and `deal_cash_total`;
- the audit row is `vault_deal_complete`, with the totals, `trade_overridden`, `cash_overridden` and `custom_lines` (the ids of lines with their own rate or a fixed figure).

It does **not** write `cash_movements`, `credit_ledger`, `points_ledger` or referrals, does not recompute balances, and does not link `cash_session`. The credit lives on the trade-in only, pending the owner's decision.

Response 200:
```json
{
  "trade_in": { "id": "1i4xlegexssc3k0", "number": "GG-BI-000002", "status": "completed", "payout_type": "mixed",
                "cash_taken": 5000, "credit_given": 6324, "deal_trade_total": 12000, "deal_cash_total": 10570 },
  "items": [ { "id": "...", "sku": "GGS7F3K2Q", "title": "Deal card A" } ],
  "labels_queued": 3
}
```

Receipts work on a completed deal as for any trade-in: `GET /api/vault/trade-ins/{id}/receipt` and `POST .../receipt/email`.

---

## 9. Open gaps and decisions for Richard

1. **Store credit given is not on any ledger yet.** The new route records `payout_credit` on the trade-in only, because `credit_ledger` belongs to the till and loyalty side. This is with the owner to decide; adding a ledger write later is one flag in `complete()`.
2. **Staff can PATCH `trade_ins.status` to `completed`** through the collection API and skip both completion routes. Tighten `trade_ins.updateRule` (for example `@request.body.status != "completed"`) once the old app is retired.
3. **Card identification from a photo** does not exist; see section 3 for a proposed route.
4. **Per-condition UK comps** are not stored, which double-discounts an LP comp; see section 2.
5. **Comics** have no catalogue or prices.
6. **Stock writes have no role check or audit**; see section 6.
7. **No generic stock CSV import.**
8. **Hook check suite on macOS.** `pb/scripts/check.sh` assumes GNU `head -n -1` and bash 4+. On the shop Mac's bash 3.2, sections 31, 32, 35, 36 and 38 fail at HEAD as well. The heatmap check in section 21 assumes British Summer Time and fails in winter.
