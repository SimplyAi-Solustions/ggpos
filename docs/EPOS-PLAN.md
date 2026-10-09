# GG Vault EPOS: the till, cashing up, stock, bookings and membership

This extends `docs/PLAN.md` (Phases 1 to 7). Read both. Where they disagree, this file wins for anything it covers. The design system in `DESIGN.md` still governs every screen, including the till's own section there.

## Context

GG Entertainment has stopped using SumUp and is leaving EPOS Now. GG Vault becomes the shop's only EPOS, used every day: the till, cashing up, stock, bookings and the GG Guild.

Decisions confirmed with Richard (9 October 2026):

- **Card payments: Tide Card Reader, keyed by hand.** Tide has no card-acceptance API, so the till cannot push an amount to the reader. The till shows the amount, staff key it on the reader, then confirm it was approved and enter the card's last four digits. Card totals are checked against Tide's figures at cashing up. The card step is an adapter (`card_provider`), so an integrated reader can be added later without touching the till.
- **Runs on the existing VPS** (`ggpos.ggentertainment.co.uk`). In store: a Mac and an Android tablet, both running the installed PWA in Chrome. Phones work too.
- **Tenders:** cash, card (Tide), store credit, part-exchange, loyalty points, vouchers, and any split of them. Gift cards follow in Phase 11.
- **Trade sales mean part-exchange at the till and paying with store credit.** Trade-customer pricing is out of scope.
- **Bookings:** events and tournaments with tickets, tables or stations by the hour, private room or party hire, all bookable at the counter and online by customers in My Vault.
- **Guild Membership** is sold at the till and online, at a price set in the app (default £24 a year).
- **Employee accounts** with roles, a 4 or 6 digit PIN to lock and switch user quickly, and manager overrides.
- **X and Z reports** for cashing up.

Design decisions made in this plan (each can be changed):

1. **Receipts and the cash drawer use a network receipt printer that collects its own jobs from the server (Star CloudPRNT).** The Mac and the tablet both print to the one counter printer and both open the same drawer, with no drivers or cables to either device. Receipts are drawn in the browser as a 576 pixel wide image in the app's own fonts and sent to the printer through the server; a response header opens the drawer. A browser print page at 80 mm is the fallback when there is no network printer.
2. **Online payment for bookings and membership uses Stripe** (online card payments only; Stripe pays out into the Tide account). It stays switched off until a Stripe key is entered. Until then, online bookings are "reserve now, pay at the till" and online membership purchase is hidden.
3. **One register to start, "Counter".** The Mac and the tablet are both devices on it and share its drawer and its cash session. More registers can be added later; everything is keyed by register from day one.
4. **PIN unlock needs a registered device.** A manager or admin signs in with a password once on each device and registers it to a till. After that, staff on that device unlock and switch with their PIN. A PIN on its own, from an unregistered browser, opens nothing.
5. **Part-exchange earns points once.** The sale earns points on its whole value. The part of the trade-in that pays for the sale earns no trade-in points; only a surplus taken as store credit earns them, as today.
6. **SumUp is removed from the app** (routes, crons, settings, screens, exports, tests), but its collections and historical data stay. Historic sales keep `sumup_card` as their tender and reports label it "Card (SumUp)".

## What already exists and is reused

From the code inventory (`docs/` is the record; the inventory itself was taken on 9 October 2026):

- `staff` (roles admin and staff, an unused `pin_hash`), step-up auth, the idle lock (password only), `/api/vault/me`.
- Sale completion with idempotency by client id, perks, vouchers, points, store credit, stock decrement, cash movement, audit; per-line refunds with step-up; shared sale arithmetic in `packages/shared/src/saleline.ts`.
- Cash sessions (one open shop-wide), cash movements, the cash cap, variance alerts.
- Trade-in completion with the ID gate and cash cap; the offer calculator; the buy-in wizard.
- Stock (`items` with singles and stock lines), locations, stock counts, label printing (two paths and the cross-device queue).
- Memberships, tiers with perks (`lounge_hours`, `free_event_entries`), perk usage counters.
- The offline queue for sales, the customer display, the reports suite and `daily_stats`.

Gaps the inventory confirmed, each closed in Phase 8 unless noted: no PIN switching and no staff management screen; no X or Z reports and no per-tender totals; no sale receipts, receipt printer or drawer; no cash tendered or change; no parked tickets; discounts and price overrides trusted from the client; no VAT totals on a sale; one cash session shop-wide; sales, sale lines, cash sessions and cash movements editable and deletable by any staff token through the raw collection API; memberships not linked to a sale (Phase 10); no stock adjustments, suppliers or purchase orders (Phase 9); the display has no paid or change state.

## Phases

Each phase ends deployed. The server deploys only finished commits that passed CI (`deploy/self-update.sh`), with a database backup before each deploy.

### Phase 8: the till (ships first; the shop can trade on it)

**Staff, roles and PIN**
- Roles: `admin`, `manager`, `staff`. A permissions table in settings maps each capability to the lowest role allowed: open the till, X report, Z report, no sale, paid in and out, refund, discount over the limit, price override, void a line, reprint, manage stock, manage bookings, see reports, settings. Defaults are sensible and editable by an admin.
- When a staff member lacks a capability, the till asks for a manager's PIN on the spot. The server issues a single-use override token for that one action and logs both names.
- PINs: 4 or 6 digits, set by the staff member (with their password) or by an admin. Stored as a keyed hash (server pepper derived from `GG_ID_PHOTO_KEY`), never the PIN. Five wrong PINs lock that person's PIN until an admin resets it or they sign in with their password.
- Registered devices: a manager or admin registers a device to a register once. The device keeps a secret; PIN unlock requires it.
- Lock screen: the register's staff as a grid of initials, tap a name, enter the PIN on a large keypad. A lock button sits in the till header; the idle lock uses the same screen. Switching user keeps the open ticket.
- Staff management for admins: add, edit role, deactivate, reset password, set or clear PIN. Every staff member can change their own password and PIN.
- The raw collection API is closed for money records: `sales`, `sale_lines`, `sale_tenders`, `cash_sessions`, `cash_movements` and `till_reports` cannot be updated or deleted by a staff token. Changes go through routes that audit them.

**The till screen** (`/counter/till`, replacing `/counter/sell`)
- Touch first, full width. Left: category rail, quick-key tiles with product images, search and scan. Right: the ticket. Phones get the same as two tabs.
- What can be sold: serialised stock (singles, graded, retro) by scan or search; stock lines (sealed, accessories) by scan, EAN, search or quick key; till products, which are non-stock items such as table time, event entry, Guild Membership (Phase 10 links it), a deposit, and open-price keys like "Single card" where staff key the price.
- The ticket: lines with quantity steppers, line discount and price override (permission-checked on the server), notes, void a line (logged), a ticket discount (percent or pounds, limit in settings), customer attach by scan or search, tier perks and points preview, vouchers.
- Park and recall tickets by name, stored on the server so the other device can pick one up.
- Pay: the amount due is the screen's one Anton line. Tenders: cash (quick note buttons, keypad, change due shown large, drawer opens), card (key this amount on the Tide reader, then "Approved" and the last four digits, or "Declined"), store credit, points, vouchers. Any split; the remaining amount is always on screen.
- Done: the done seal, change due, points earned, and receipt choices: print, email, gift receipt, no receipt. The customer display shows the total, then "Pay £X on the card reader" or the change due, then a thank you with points earned.
- Part-exchange in the same ticket: a "Trade in" panel adds trade lines priced by the existing offer calculator; their value comes off the bill as a `part_exchange` tender. If the trade is worth more, the surplus is paid out in cash (the ID gate and cash cap apply as for any buy-in) or as store credit. One transaction creates the trade-in and the sale and links them.
- Returns and exchanges in the same ticket: find any sale by receipt number or by scanning the receipt, choose lines and quantities, give a reason, choose to restock, refund to the original tender or to store credit, with a manager override where the role requires one.
- No sale (opens the drawer, needs a reason) and paid in and out (petty cash with a reason), each logged and on the X and Z.

**Cashing up**
- Open the till: count the float by denomination (£50 to 1p) or accept the suggested float; one open session per register.
- X report at any time: sales by tender, refunds by tender, discounts, voids, no sales, paid in and out, part-exchange and buy-in payouts, expected cash in the drawer, VAT (when registered), sales by category and by staff, transaction count, average basket. Numbered, stored, printable.
- Z report closes the day: a blind count by denomination, the cash variance, the Tide card total for the day keyed from the Tide app and the card variance, an optional bank drop, notes. Numbered in sequence, stored, cannot be changed, printed, and the session closes. A history of X and Z reports with reprint.

**Receipts and printing**
- Sale receipt: shop details, VAT number when registered, receipt number as text and as a barcode for returns, date, till, staff first name, lines, discounts, totals, a VAT breakdown for standard-rated lines (margin scheme lines never show VAT), tenders, change, customer code with points earned and balance, the returns policy, and a QR code to My Vault. Gift receipts drop the prices.
- Email receipts through the existing mail settings. Reprint from the sale.
- Printers in settings: name, the printer's MAC address, the URL to type into the printer, paper width, which register it serves, last seen. A test print. The drawer opens on cash sales, no sales and paid in or out.

**Tide**
- The card tender records `card_tide` with the last four digits and an optional auth code.
- At the Z report the Tide total for the day is entered and compared with the till's card total.

**SumUp removed** as above.

### Phase 9: inventory

- A product catalogue for everything that is not a serialised single: sealed product, accessories, drinks and snacks, services. Products have an EAN, SKU, category, price, cost, VAT treatment, stock tracking on or off, a reorder point and quantity, a preferred supplier and images. The existing stock lines move under it; serialised singles stay as they are.
- Category and quick-key editor with drag to reorder (touch friendly).
- Suppliers; purchase orders; goods in against a purchase order or without one, updating cost, quantity and queueing labels.
- Stock adjustments with a reason (damaged, lost, used in store, correction, found), audited; stock counts that update quantities when closed; transfers between locations.
- Low stock alerts on Home and a reorder list built from reorder points and sales velocity.
- EPOS Now import: products, stock levels and customers from EPOS Now's CSV exports, with a mapping preview and a review queue for rows that do not match.

### Phase 10: bookings and Guild Membership

- Resources: tables, stations, rooms; capacity, opening hours, slot length, price per slot or hour, deposit rule, online bookable.
- Events: game, format, start and end, capacity, entry fee and members' price, online sales, weekly repeats, waitlist, check-in by QR at the till.
- Bookings: a touch day view by resource and a week view; create, move and cancel; deposits and balances; no-shows; reminders by email and push. Paying a booking's balance or an event entry at the till settles the booking.
- Perks applied automatically: lounge hours and free event entries from the customer's tier.
- My Vault: browse events and buy tickets, book a table slot, request a party booking; pay online through Stripe when it is on, otherwise reserve and pay at the till; confirmation email with a calendar file.
- Guild Membership: plans with a price (default £24 a year), sold at the till as a product and online, creating or renewing the membership and recorded as a sale; renewal reminders.
- The Stripe adapter: Checkout Sessions created server-side, a signed webhook, idempotent; off until keys are set.

### Phase 11: hardening and extras

- Offline selling: cash and Tide card sales complete offline from the cached catalogue and replay when the connection returns, with conflicts shown (an item already sold). Receipts print and the drawer opens again once the connection is back; the drawer key is the fallback.
- Gift cards: sell, redeem as a tender, check balance.
- Staff clock in and out from the lock screen, with an hours report.
- Reports: exceptions (voids, no sales, overrides, refunds and discounts by staff), tender reconciliation against Tide (including a Tide CSV import once a real export is seen), booking use and event attendance, membership sales and renewals, staff hours, stock movement.
- Impeccable polish on every new screen, end-to-end coverage, a hardware shopping list and setup guide in the runbook.

## Hardware

- Receipt printer: **Star TSP143IV LAN** (TSP143IV UE, Ethernet) or **Star mC-Print3**, both with CloudPRNT and a cash drawer port. 80 mm rolls.
- Cash drawer: any 24 V drawer with an RJ12 cable for Star printers, plugged into the printer.
- Barcode scanner: USB 2D scanner on the Mac (works as a keyboard), Bluetooth 2D scanner for the tablet, or the tablet's camera.
- The ORGSTA T003 label printer stays on WebUSB from the Mac.
- Optional: a second tablet for the customer display at `/display`.
- Printer setup: in the printer's web settings, turn on CloudPRNT, set the server URL shown in GG Vault's printer settings, and a polling time of 2 seconds.
- If the shop's internet drops: Tide still works on its own 4G; the till keeps a ticket going and Phase 11 adds offline completion; receipts and the drawer wait for the connection, and the drawer key opens it meanwhile.

## Data model changes (Phase 8)

New collections:

| Collection | Purpose | Key fields |
| --- | --- | --- |
| `registers` | A till and its drawer | name, location, printer, active, sort |
| `register_devices` | A browser registered to a register | register, label, secret_hash (hidden), created_by, last_seen, revoked_at |
| `till_reports` | X and Z reports | type (x, z), number, register, session, period_start, period_end, data (json), created_by |
| `sale_tenders` | One row per payment on a sale or refund | sale, refund_ref, method, amount, tendered, change, card_last4, reference, register, session, staff |
| `parked_tickets` | Held tickets | register, label, customer, staff, payload (json), total |
| `till_products` | Non-stock things the till sells | name, kind, price (empty for open price), category, image, tax_scheme, vat_rate, active, sort, barcode |
| `till_categories` | The category rail | name, sort, active, filter (json for dynamic stock lists) |
| `till_keys` | Quick-key tiles | category, position, item or till_product, label |
| `printers` | CloudPRNT printers | name, model, mac, token_hash (hidden), register, paper_width, active, last_poll_at, last_status, encodings |
| `print_jobs` | Receipts, reports, drawer kicks | printer, kind, ref, file (png), drawer, cut, status, attempts, error, created_by, printed_at |

Changed: `staff` (role `manager`; `pin_failures`, `pin_locked`, `pin_set_at`), `cash_sessions` (register; opening and closing counts by denomination; card till total, card reported total, card variance; Z report link; one open per register), `cash_movements` (types `paid_in`, `paid_out`, `no_sale`), `sales` (register; tenders replace `payment_split` for new sales; `vat_total`; `trade_in` link; new payment values `card_tide`, `card_other`, `part_exchange`, `gift_card`), `sale_lines` (till product link, title snapshot, VAT amount), `settings` (`epos`: permissions, discount limit, card last four required, auto-lock minutes, quick cash notes, default float, receipt header and footer, returns policy, card provider), `counters` (`x_report`, `z_report`).

## Verification (every phase)

The same gate as Phases 1 to 7: lint, typecheck, unit tests, build, the full e2e suite in isolation, `pb/scripts/check.sh` with the new sections, typegen in step, a high-effort review of every package with every finding fixed, the design and copy gates against `DESIGN.md`, screenshots in both colour modes at 1440 and 390 and on a 1180 x 820 tablet, and the PR description updated. Money, auth, PIN and the Z report get the hardest review.
