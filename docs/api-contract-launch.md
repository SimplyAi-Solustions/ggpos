# Launch contract (the week before opening)

What has to work on opening day, 16 October 2026, beyond the till (`docs/api-contract-epos.md`) and the category tree (`docs/api-contract-inventory.md`, section 1). The shop asked for: simple loyalty offers and a free Guild with a paid upgrade; advanced reporting with sales, cost and profit, Excel downloads and VAT; bookings for tables, PC gaming sessions and tournaments; Gandalf (the shop's Hermes agent on Buzz) with full admin access; eBay sold research by staff and agents; and stock on the website. Every rule of the earlier contracts applies: money in pence, capabilities through `lib/permissions.js`, refusals as `{ message }` with the status given, transactions through `txApp`, no em-dashes or exclamation marks in any sentence.

Packages: **GO** (Guild and offers), **RV** (reports, Excel and VAT), **BK** (bookings on the server) and **BW** (bookings in the web), **AG** (agents, MCP and research), **WS** (stock online and photos). Section 1 is laid before any of them starts.

---

## 1. Already laid: `pb/pb_migrations/1789821120_launch_schema.js`

- **Guild**: `customers.guild_joined_at` (date). Existing customers are members from the day they were created. Only members earn points.
- **VAT**: `items.vat_rate` (percent, 0 to 100; empty means the shop's standard rate), `items.tax_scheme` gains `exempt`, `categories.default_vat_rate`; `settings.vat_registered_from` (date), `settings.vat_period_start_month` (1 to 12: the first month of a VAT quarter, default 1), `settings.vat_standard_rate` (default 20).
- **Online**: `items.show_online` (bool), `categories.show_online` (bool: new stock filed here starts shown online), `settings.online` (json: `{ enabled, min_price, hide_qty }`).
- **Agents**: `staff.kind` (`person` or `agent`; every existing member is `person`), `staff.agent_note` (text).
- **Research**: `research_requests`: `query` (the search words), `card`, `retro_title`, `item`, `trade_in_line` (each optional), `condition`, `finish`, `status` (`open`, `claimed`, `done`, `cancelled`), `requested_by` (staff), `claimed_by` (staff, an agent or a person), `claimed_at`, `result` (text, 2,000), `comps` (json: `[{ price, currency, sold_at, url, title, condition }]`), `done_at`. Staff read and create; updates through the routes in section 5.
- **Bookings**: `resources`, `booking_events` and `bookings`, as section 4 describes; `sale_lines.booking` (relation), and the till product kind `booking`.

---

## 2. GO: the Guild and loyalty offers

### Joining

- **`POST /api/vault/guild/join`** (staff): `{ "customer"?: id, "name"?: string, "email"?: string, "phone"?: string, "marketing_consent": bool, "birthday_month"?: 1-12 }`. With `customer`, that customer joins. Without, a new customer is created and joins; a name and an email or a phone are needed (400 "Add a name and an email or a phone number."). An email or phone already on another customer is refused, 409 `{ message: "Jo Bloggs already has that email. Open their record instead.", customer: { id, name, code } }`. Joining sets `guild_joined_at`, posts the programme's welcome bonus once (never twice for one customer), and emails the Guild card when there is an email. A member joining again is 409 "Jo Bloggs is already in the Guild." Answers `{ customer: { id, name, code }, points_balance, welcome_points }`.
- **My Vault**: signing up online (the existing OTP claim and the `portal` source) asks for the Guild's terms and joins on acceptance. Customers created without joining (a seller at a cash buy-in) are not members until they join.
- **Points belong to members**: a sale earns points only when its customer is a member; the till offers "Join the Guild" on the attached customer when they are not, one tap with consent.
- **The Guild card**: the customer's existing QR and code, printable on the 80 x 50 label and emailed as a PDF. The paid upgrade is the Guild Membership till product (price set in Settings, default £24 a year) granting the paid-plan tier; GO seeds a paid-plan tier "Guild+" if none exists, switches the product on, and puts its price in Settings, Guild.

### Offers

An **offer** is a `loyalty_rules` row the shop sets up in plain words. `LoyaltyRuleConditions` gains `categories` (branch ids: a line matches when its branch is that branch or beneath it), `items` (stock ids) and `products` (till product ids), alongside `games`, `kinds`, `minSpend` and `weekdays`. `EarnLine` gains `lineage`, `item` and `product`; the sale route passes them. The evaluator in `packages/shared/src/loyalty.ts` is the only place they are matched, so the editor's preview and the till agree.

The editor ("Offers" in Loyalty) starts from templates, each a sentence with blanks: "Earn N points for every £1" (the programme), "N times points on [branches, items or products]", "N bonus points when they buy [branches, items or products]", "N times points on [days]", "N bonus points on their first purchase", "N bonus points in their birthday month", each with optional dates and a members-only switch for paid-plan members. Every offer shows a live example ("A £30 Pokémon ETB on Saturday earns 600 points").

---

## 3. RV: reports, Excel and VAT

- **`GET /api/vault/reports/dashboard?from=&to=&compare=previous`** (`reports_view`): `{ sales: { gross, discounts, refunds, net, vat, count, average }, cost, profit, margin_pct, buy_ins: { spend, count }, stock: { cost, retail, items }, series: [{ date, net, cost, profit }], by_category: [{ id, label, net, cost, profit, margin_pct }] (top-level branches), top_items: [{ title, sku, net, profit, count }] (10), payments: [{ method, label, net }], compare?: { ...the same headline figures for the previous period } }`. Cost is what the shop paid for the stock sold (`items.cost` x quantity, net of refunds); a till product has no cost. Profit is net sales less VAT less cost.
- **The dashboard screen** (Reports, first): the headline figures with their change against the previous period, sales and profit by day, by category with a drill into the Sales report, top items, payment mix, buy-in spend and stock value.
- **Excel**: every report, the dashboard and every export can be downloaded as `.xlsx` as well as CSV, built in the browser from the report's own rows: money as numbers formatted £#,##0.00, dates as dates, one sheet per table plus a cover sheet with the range and when it was made.
- **VAT settings** (Settings, VAT; admin): registered or not, the VAT number, the date registered from, the quarter's first month, the standard rate. Per branch, per till product and per item: the treatment, margin, standard at 20%, reduced at 5%, zero at 0%, or exempt, with the branch's default filling new stock. Nothing is charged as VAT until registered, and a sale before `vat_registered_from` never is.
- **`GET /api/vault/reports/vat?period=2026-Q4`** (`reports_view`): the nine boxes of a VAT return for the quarter (box 1: VAT on standard and reduced sales plus the margin scheme's VAT; box 6: sales excluding VAT; boxes 4 and 7 from purchases, entered by hand on the screen until purchases are recorded), the margin scheme working (margin goods bought and sold in the period, the margin, its VAT at 1/6 for 20%), by rate, with the sales behind each figure as a drill-down and an Excel download. A quarter before registration answers with every box 0 and a note.

---

## 4. BK and BW: bookings

### Schema (laid)

- **`resources`**: `name`, `kind` (`table`, `pc`, `console`, `room`), `capacity` (players), `slot_minutes` (default 60), `price` (pence a slot), `member_price` (pence a slot, or empty), `deposit` (pence a booking, or empty), `online` (bookable from My Vault), `hours` (json: `{ "mon": [["10:00","20:00"]], ... }`, empty means the shop's hours in `settings.opening_hours`), `active`, `sort`, `image`, `note`.
- **`booking_events`** (tournaments and events): `name`, `game`, `format`, `starts_at`, `ends_at`, `capacity`, `entry_fee`, `member_fee` (pence), `online`, `status` (`draft`, `published`, `cancelled`, `finished`), `repeat_weekly` (bool; a repeat is its own row, made ahead by a cron), `resources` (relation, many: what it takes up), `description`, `image`.
- **`bookings`**: `kind` (`resource`, `event`), `resource`, `event`, `customer` (optional), `name`, `phone`, `email` (for a booking with no customer record), `starts_at`, `ends_at`, `party_size`, `status` (`held`, `confirmed`, `checked_in`, `completed`, `cancelled`, `no_show`), `price`, `deposit`, `paid` (pence), `source` (`till`, `online`, `phone`), `checked_in_at`, `checked_out_at`, `notes`, `created_by`. Indexes on (`resource`, `starts_at`) and (`event`).
- `sale_lines.booking`; `till_products.kind` gains `booking`; `settings.opening_hours` (json).

### Server (BK)

- **Availability**: `GET /api/vault/bookings/availability?date=&kind=&party=` (staff) and `GET /api/public/availability?...` (anyone, for My Vault and the website): per resource, the free slots that day within its hours, never overlapping a `held`, `confirmed` or `checked_in` booking or an event that takes the resource.
- **Book**: `POST /api/vault/bookings` (staff, `bookings_manage`; or the customer themselves from My Vault for an `online` resource or event): checks capacity, overlap, hours and that the time is in the future (staff may book into the past for a walk-in), prices it (member price for a member, the slots x price), and answers the booking. A clash is 409 "Table 2 is booked from 18:00 to 19:00. Pick another time or another table." Moving, cancelling (with the deposit kept or refunded by choice), no-show, check-in and check-out are routes on the booking; every change is audited.
- **Walk-in sessions** (the PC and console stations): check in now with no booking, the clock runs, check out charges by the slots used (a part slot rounds up after 10 minutes), and the charge goes to the till.
- **Paying**: a booking's price, deposit or balance, and an event entry, sell at the till as a `booking` line (`sale_lines.booking`), through the existing sale route, which marks `paid` and confirms a `held` booking in the same transaction. A refund of the line takes it off `paid`.
- **Events**: entries are bookings of kind `event`; capacity counts party sizes; a waitlist is a booking `held` past capacity, offered in order when a place frees. Free entries from a tier's `free_event_entries` perk apply at the till.
- **Reminders**: email (and push where subscribed) the day before; a cron makes the next four weeks of weekly events.
- Stripe stays off: online bookings are held and paid at the till.

### Web (BW)

- **Bookings** in the counter nav: a day view by resource (columns) and time (rows), touch first, drag to move, tap a free slot to book, tap a booking to check in, out, move, cancel or take payment; a week view; an events list with entries, waitlist and check-in by QR.
- **The till**: "Bookings" in the till menu and a quick key; a booking's payment lands on the ticket as a line; walk-in PC sessions start and stop from the till with the running time and charge shown.
- **My Vault**: book a table or a PC slot and enter an event (members' prices for members), see and cancel their own bookings.
- **Settings, Bookings**: resources (kinds, capacity, slot length, prices, deposits, hours, online), the shop's opening hours.

---

## 5. AG: agents, MCP and research

- **Agents** (Settings, Agents; admin): an agent is a `staff` row of `kind: agent` with role `admin` (the shop chose full admin access), no password and no PIN, which never appears on the lock screen's roster. `POST /api/vault/agents` (`staff_manage`) `{ name, note }` creates one and answers a long-lived token once (a year); `POST /api/vault/agents/{id}/token` issues a new one and invalidates the old; switching the agent off stops it at once. Every action an agent takes is audited under its own name, and the Agents screen lists each agent's last 50 actions. ID photos stay behind the step-up a person does (a password or MFA in the last ten minutes), so an agent cannot open one.
- **MCP**: `POST /api/vault/mcp` speaks the Model Context Protocol's JSON-RPC over HTTP (`initialize`, `tools/list`, `tools/call`) with the agent's token as the bearer, so Gandalf's Hermes config can point at it directly; `services/mcp/stdio.mjs` (no dependencies) bridges it to stdio for clients that only run local MCP servers. The tools call GG Vault's own routes with the agent's token, so every rule, capability and audit row applies: stock (search, get, update price, branch, `show_online`), price check (the card and retro lookups with every source), UK sold comps (add one with its evidence URL), research requests (list, claim, complete), customers (search, get, join the Guild), sales and reports (the dashboard, any report by key and range, the X running now), bookings (availability, list, create, move, cancel), events (list, create), trade-ins and quotes (list, get, draft an offer), and `vault_api` for any other route.
- **Research**: `POST /api/vault/research` (staff) from a trade-in line, the item page or price check creates a request with the search words; `GET /api/vault/research?status=` lists; `POST /api/vault/research/{id}/claim`, `.../complete` `{ result, comps }` and `.../cancel`. Completing writes each comp in pounds as a UK sold comp (`price_snapshots` source `uk_sold_manual` with the evidence URL), so it becomes the line's first price source, as a staff-entered comp does. A webhook (`settings.agent_webhook`: `{ url, secret }`) is called on a new request, signed with HMAC-SHA256, so an agent can be woken rather than poll.
- **Search eBay sold**: one action beside every price source (trade-in line, price check, item page) opens ebay.co.uk's sold and completed listings for the card's name, set and number in a new tab; "Ask an agent" beside it creates the research request.

---

## 6. WS: stock online and photos

- **Showing stock online**: `show_online` on the item page and as a Stock bulk action; a branch's `show_online` starts new stock there shown; nothing below `settings.online.min_price` shows; sold or reserved stock leaves the feed at once.
- **`GET /api/public/stock?category=&q=&page=`** (anyone; rate limited; CORS for `https://ggentertainment.co.uk`): items in stock with `show_online`, 24 a page: `{ sku, title, price, condition, finish, game, category: { id, path }, image: { small, large, ratio }, qty (unless hidden), updated }`. Never a cost, a supplier, a customer, a location or a note. **`GET /api/public/categories`**: the visible branches with how many are online in each subtree. **`GET /api/public/stock/{sku}`**: one item.
- **Photos**: Take photo on the item page and in Add stock: the camera on the tablet (`capture`), the webcam or a file on the Mac, cropped to the item's platform ratio with the capture guide, saved to `items.photos`; the first photo is the one the website shows, else the catalogue image.
- **The website** (`SimplyAi-Solustions/ggentertainment-site`, Astro): a Shop section (`/shop`): the category tree as navigation, search, item cards in the site's own style, an item page with photos and "Ask about this" (phone, email, or the existing interest form), all from the public feed in the browser so it is always current; a stock strip on the home page. A runbook entry for building and deploying the site.
- **Scanning**: confirm the camera scanner works on the Android tablet (Chrome) and the Mac (Safari and Chrome) and a USB or Bluetooth scanner works as a keyboard on both; fix what does not.
