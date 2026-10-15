# Supplier reorder API contract

Richard's weekly call with Games Workshop: the top-selling Warhammer products (the seller's rack, about 50) must stay stocked while Games Workshop has them. Before the call he needs, in one place: what of theirs is in stock, what sold since last week, what is out, what to order to fill the shelf back up, and what customers have asked for. The same report works for any supplier; Games Workshop is first.

Decisions taken with Richard (15 Oct 2026):

- A product belongs to a supplier through a **Supplier** field on the stock row, with a **Keep on shelf** target (shelf target) and the supplier's own **product code**. Set on Add stock and the item page, and the target is editable straight from the report.
- **To order** tops the shelf back up: target less in stock, never below 0, nothing for a product with no target.
- **Customer requests** are logged at the counter and move Waiting, Asked the rep, Ordered, Arrived, Collected (or Cancelled). Open ones show on the report.
- **Any supplier**, with a one-tap Games Workshop entry on Reports.

The rules of `docs/api-contract-epos.md` apply: money in integer pence, capabilities through `lib/permissions.js`, refusal bodies `{ message }` in plain sentences, no em-dashes or exclamation marks in any sentence, UK English.

---

## 1. Already laid

**`packages/shared/src/reorder.ts`** (tested in `packages/shared/test/reorder.test.ts`, copied to `pb/pb_hooks/lib/shared/reorder.js` by `pnpm --filter @gg/shared build:hooks`): the whole adding up. Both the route and the demo call it, so they agree.

- Types: `ReorderItem` (one stock row as the route reads it), `ReorderSold` (units kept of one row in the range), `ReorderLine` (one product), `ReorderTotals`, `ReorderSupplier`, `StockRequestView`, `ReorderReport` (the route's answer), `ReorderStatus` (`out`, `low`, `ok`, `untracked`) with `REORDER_STATUS_LABELS`, `RequestStatus` (`waiting`, `asked`, `ordered`, `arrived`, `collected`, `cancelled`) with `REQUEST_STATUSES`, `REQUEST_STATUS_LABELS` and `OPEN_REQUEST_STATUSES`.
- `productKey(item)`: rows are one product when they share a supplier code, else a barcode, else a title (restocking adds a new row; there is no goods-in yet).
- `buildReorderLines(items, sold)`: one line per product, sorted most to order first, then out of stock, below target, stocked, no target, then title.
- `reorderTotals(lines, requests)`, `reorderStatus`, `unitsToOrder`, `isOpenRequest`, `defaultReorderPeriod(today)` (the last seven days, both ends counted).

---

## 2. Schema (backend)

One migration, `pb/pb_migrations/1789821300_supplier_reorder.js`, with a working `down`.

### 2.1 Games for stock that is not a card game

Today every stock row must name a game from the six card and retro games, so a Warhammer box can only be filed under the wrong one.

- Seed two `games` rows: `warhammer` ("Warhammer", no adapter, enabled) and `other` ("Other", no adapter, enabled). Skip a row whose key already exists.
- In `packages/shared/src/categories.ts`: the starter tree's `minis` branch and its Warhammer 40,000, Age of Sigmar, Paints and Tools and hobby branches default to game `warhammer`; Other miniatures, and the `boardgames`, `pc`, `accessories`, `food` and `services` subtrees, default to `other` where they set no game today. `fileItem` files a row of game `warhammer` under `minis` (its kind's branch inside it where there is one) and a row of game `other` by its kind, as it does for a row with no game it knows.
- The migration sets `default_game` on the live tree's branches by `key` to match, **only where `default_game` is empty**, so nothing an admin chose is overwritten.
- Anywhere that lists games for a **card search** (the Add stock "Set and number" chips, price check, the trade-in Card line, the adapters and lookup routes) must leave out games with no adapter, so Warhammer and Other never offer a card search. Pricing-rule selection must fall back to the general rule for a game with no rules of its own, exactly as for any game without rules.

### 2.2 `suppliers`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | text, required, 1 to 80 | unique, case-insensitive |
| `account_number` | text, 40 | the shop's account with them |
| `rep_name` | text, 80 | |
| `rep_email` | text, 120 | |
| `rep_phone` | text, 40 | |
| `notes` | text, 500 | |
| `active` | bool | |
| `sort` | number | |

Rules: list and view for any staff; create, update and delete for manager and admin (`MANAGER_UP`, as `categories`). Customers: nothing. Seed one row, **Games Workshop**, active, sort 10.

Hook (create and update): `name` trimmed, required ("Give the supplier a name."), unique ("There is already a supplier called Games Workshop."). A supplier any stock row or request points at cannot be deleted: 400 "Games Workshop still has stock or requests. Switch it off instead."

### 2.3 `items`

Three optional fields, indexed on `supplier`:

| Field | Type | Notes |
| --- | --- | --- |
| `supplier` | relation to `suppliers`, max 1 | |
| `shelf_target` | number, integer, min 0 | keep this many on the shelf; 0 or empty is no target |
| `supplier_code` | text, 40 | the supplier's own product code, for the order |

Staff already update `items` through the collection API; these three are written the same way (the web PATCHes them). Whatever guards `items` today (protected fields, validation) must let these through and refuse a negative or non-integer `shelf_target` with 400 "Keep on shelf is a whole number, 0 or more.".

### 2.4 `stock_requests`

| Field | Type | Notes |
| --- | --- | --- |
| `supplier` | relation to `suppliers`, max 1 | the supplier to ask; may be empty |
| `title` | text, required, 1 to 200 | what the customer is after, in their words |
| `qty` | number, integer, min 1 | |
| `customer` | relation to `customers`, max 1 | when they are a Guild member |
| `contact_name` | text, 100 | when they are not, or to say who |
| `contact_phone` | text, 40 | |
| `notes` | text, 500 | |
| `status` | select, required | `waiting`, `asked`, `ordered`, `arrived`, `collected`, `cancelled` |
| `status_changed_at` | date | |
| `created_by` | relation to `staff`, max 1 | |
| `item` | relation to `items`, max 1 | the stock row it was met from, when known |

Rules: list, view, create and update for any staff; delete for nobody (a request is cancelled, not deleted). Customers: nothing. Index on (`supplier`, `status`).

Hook:
- On create: `title` trimmed, required ("Say what the customer is after."); `qty` 1 when empty, else a whole number 1 or more ("The quantity is a whole number, 1 or more."); a `customer` or a `contact_name` is required ("Add the customer, or a name to contact, so they can be told when it comes in."); `status` `waiting` when empty; `created_by` the signed-in staff member, whatever was sent; `status_changed_at` now.
- On update: `created_by` cannot change; a change of `status` stamps `status_changed_at`; the same validation as create.

### 2.5 Typegen

Run `pnpm typegen` after the migration so `packages/shared/src/pb-types.ts` carries `SuppliersRecord`, `StockRequestsRecord` and the new `items` fields.

---

## 3. The report route (backend)

`GET /api/vault/reorder?supplier=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`, in `pb/pb_hooks/reorder.pb.js` with its logic in `pb/pb_hooks/lib/reorder.js`.

- Any signed-in staff member (it shows prices, never cost). 401 without a staff token.
- `supplier` required: 400 "Choose a supplier."; unknown: 404 "That supplier was not found."
- `from` and `to` default to `defaultReorderPeriod(today)` with today as the shop's date; both are checked as every report's dates are (`lib/reports/query.js`): 400 "The dates do not make sense. Check the from and to dates." when from is after to, more than 400 days apart, or malformed.
- **Rows:** every `items` row with `supplier = <id>`, whatever its status, expanded with its category. `onHand` is `qty` when the status is `in_stock`, `reserved` or `listed_ebay` (`STOCK_STATUS_FILTER`), else 0. `categoryPath` is the branch's `path`. `shelfTarget` is `shelf_target`. `updated` is the record's `updated`.
- **Sold:** the units kept (`qty` less `refunded_qty`) of sale lines whose `item` is one of those rows, on sales in the range by `sale.occurred_at`, counted the way the margin report counts them (`lib/reports/margin.js` `soldLines`), so the two never disagree.
- **Requests:** the supplier's requests with an open status (`OPEN_REQUEST_STATUSES`), oldest first, as `StockRequestView` (customer name and display code from the expanded customer, `createdByName` from the expanded staff member).
- Answer: `ReorderReport`, built with `buildReorderLines` and `reorderTotals`.

### 3.1 The agent tools

`pb/pb_hooks/lib/mcp.js` (Gandalf's MCP endpoint): where an item tool creates or updates a stock row, it also takes `supplier` (a supplier's name or id), `shelf_target` and `supplier_code`; add a read-only `reorder_report` tool (`supplier` by name or id, optional `from` and `to`) answering the route's JSON, and a `stock_request` tool that logs a request as §2.4 (the agent as `created_by` is empty; the request's notes say "Logged by <agent name>."). Give each tool a one-line description in the existing style, and keep the agent's existing permission checks.

### 3.2 Checks

`pb/scripts/checks/38-reorder.sh`, wired into `pb/scripts/check.sh` in its numbered place:

- the two games and the seeded supplier exist; the minis branches carry `warhammer` as their default game and a branch an admin had already set is untouched;
- staff can list suppliers but not create one; a manager can; the duplicate-name and in-use-delete refusals;
- staff set `supplier`, `shelf_target` and `supplier_code` on an item; a negative target is refused;
- a rack of three products (one restocked over two rows, one out with a target, one with no target), two sales and a part refund in the range and one sale outside it: the route's lines, statuses, units sold, to-order figures and totals equal the shared test's hand-worked figures;
- requests: a customer token is refused; the three create refusals; `created_by` is the caller whatever is sent and cannot be changed; a status change stamps `status_changed_at`; delete is refused; only open requests reach the report;
- the route's 400, 401 and 404 refusals.

---

## 4. The web

### 4.1 API (`apps/web/src/lib/api/reorder.ts`, demo in `lib/api/demo/reorder.ts`)

- `listSuppliers({ activeOnly })`, `saveSupplier(input)`, `getReorderReport({ supplierId, from, to })`.
- `listRequests({ supplierId, open })`, `createRequest(input)`, `updateRequest(id, patch)` (status, notes, qty).
- `setShelfTarget(itemIds, target)`: PATCHes `shelf_target` on every row of the product.
- `ItemPatch` and `NewItemInput` gain `supplierId`, `shelfTarget`, `supplierCode`; `ItemDetail` carries `supplierId`, `supplierName`, `shelfTarget`, `supplierCode`.
- Demo: suppliers Games Workshop (rep "Dan", a phone and an email, account "GW-48213") and one more; about twelve Warhammer stock lines with targets, codes and barcodes, filed under the minis branches with game Warhammer; sales of them in the last seven days; three open requests and one collected. The demo adds up through `buildReorderLines` and `reorderTotals`.

### 4.2 Reports

- **Reports index:** a "Supplier calls" section above "Every report", one row per active supplier ("Games Workshop", "Stock, sales, orders and requests for the weekly call."), linking to the report. Games Workshop is first by `sort`.
- **`/counter/reports/reorder?supplier=<id>&from&to&view`** (`routes/counter.reports.reorder.tsx`, `features/reorder/ReorderScreen.tsx`):
  - The one Anton line is the supplier's name. The lede: "The weekly call: what sold, what is out, what to order and what customers asked for." Under it, in 13px grey, the rep and the account: "Rep: Dan, 07700 900456, dan@... Account GW-48213" (only what is set).
  - The period: "Last 7 days" by default, with from and to date fields like every report's.
  - Five figures across the top in the dashboard's KPI style: In stock (units), Sold (units in the period), Out of stock (products), To order (units), Requests (open).
  - **The rack**: chips To order (default), Out of stock, Sold, Everything. A hairline table: Product (title, then the supplier code and barcode in Space Mono 13px), In stock, Keep on shelf, Sold, To order, and the status in words. Numbers right-aligned, `tnum`. The product opens its item page. In Everything, Keep on shelf is a small underline number field: Enter or leaving the field saves it on every row of the product, and the line moves to its new place.
  - Actions as `text` buttons: **Copy order** (the to-order lines as "code, title, quantity", one per line, to paste into an email or read out), **Excel** (sheets To order, Rack and Requests, through the existing Excel helper) and **Print** (a print stylesheet: the figures, the to-order table and the open requests, on A4).
  - **Customer requests**: the open requests oldest first, a hairline row each: what, how many, who (name and Guild code, or contact name) and their phone, when asked and by whom, notes, and the status as a select that saves on change. **Add a request** opens a sheet: What are they after (required), Quantity (stepper, 1), the customer (search Guild members by name, code or phone, as the till's Add customer does) or a name and phone, Notes. The supplier is the report's.
  - Empty states: no products yet ("No Games Workshop stock yet. Set the supplier and Keep on shelf on an item to put it on this list."), nothing to order ("Nothing to order. Every product with a target is at or above it."), no requests.
- Command palette: "Supplier call: Games Workshop" (one per active supplier).

### 4.3 Stock

- **Item page**: in Details, Supplier (a select of active suppliers and None), Keep on shelf (a number field, empty is none) and Supplier code, each saving as Location and VAT do. **Add more of this** (a `text` action) opens Add stock filled from this item: kind, game, branch, title, barcode, price, cost, VAT, supplier, keep on shelf, supplier code and location; quantity empty.
- **Add stock**: Supplier, Keep on shelf and Supplier code, shown for every kind except card singles and graded cards, saved with the item. `?from=<sku>` prefills as above.
- **Game**: Warhammer and Other appear in the Game select from the `games` collection; the card search chips leave out games with no adapter.

### 4.4 Settings

A **Suppliers** section for managers and admins: the suppliers as hairline rows (name, rep, active), **Add a supplier** and editing in a sheet (name, account number, rep name, email and phone, notes, active).

### 4.5 Tests

- Unit tests for anything pure the web adds.
- `e2e/reorder.spec.ts` at both widths: Reports to Games Workshop; the five figures and the To order list against the demo; set a target in Everything and see the line move; add a request with a contact name and move it to Asked the rep; Copy order puts the expected text on the clipboard; the item page's supplier fields save; Add more of this prefills Add stock.

### 4.6 Design

`DESIGN.md` gains a "Supplier calls" subsection in section 11 recording the screen as built. One Anton line; volt only where section 1 allows; statuses in words, never colour alone.
