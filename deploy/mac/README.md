# Shop Mac: Epos Now workers

Two launchd workers run on the shop Mac and are the only things that talk to Epos Now: the store-credit sync (this section) and the stock sync (Vault items as Epos Now products, and till sales back into the Vault, further down). Both use the same `epos` command, the same superuser login and the same safety rules.

## Epos Now store-credit sync

When a GG Vault deal completes with trade credit, `POST /api/vault/deals/{id}/complete` queues one row in the `epos_credit_queue` collection. This worker runs on the shop Mac every minute, finds or creates the customer in Epos Now and adds the credit to their Epos Now balance, so they can spend it at the till.

The Epos Now API token never leaves the Mac: every Epos call goes through the `epos` command (`/usr/local/bin/epos`), which reads the token from `EPOSNOW_TOKEN` or the keychain item `eposnow-token`.

Files:

| File | What it is |
|---|---|
| `epos-credit-sync.mjs` | The worker. Node 22 or later, built-ins only. |
| `lib/epos-credit.mjs` | The logic: state changes, pence to pounds, parsing Epos replies. |
| `test/epos-credit.test.mjs` | Unit tests with a mocked `epos`. Run `node --test deploy/mac/test/*.test.mjs`, or `pnpm test:mac`. |
| `uk.co.ggentertainment.epos-credit-sync.plist` | The launchd template. |

The worker loads the shared money helpers from `pb/pb_hooks/lib/shared/money.js`, so run it from a full checkout of the repo.

## Environment

| Variable | Required | What |
|---|---|---|
| `VAULT_PB_URL` | yes | The GG Vault PocketBase URL, for example `https://vault.ggentertainment.co.uk`. |
| `VAULT_PB_EMAIL` | yes | A PocketBase superuser email. The queue is superuser only. |
| `VAULT_PB_KEYCHAIN_SERVICE` | yes | The keychain service name holding that superuser's password. The worker runs `security find-generic-password -s <service> -w`. |
| `EPOS_BIN` | no | Default `/usr/local/bin/epos`. |
| `EPOS_TIMEOUT_MS` | no | Default `60000`. An Epos call still running after this is killed; for the balance call that makes the row `needs_check`. |
| `SECURITY_BIN` | no | Default `/usr/bin/security`. |
| `EPOS_CREDIT_LOCK` | no | Lock file, default `$TMPDIR/uk.co.ggentertainment.epos-credit-sync.lock`. Stops two runs overlapping. |

Nothing secret goes in the plist or the environment: the password is read from the keychain on each run.

## Install

1. Create a PocketBase superuser for the worker (PocketBase dashboard, Superusers), and put its password in the login keychain:
   ```
   security add-generic-password -s gge-vault-epos-sync -a <superuser email> -w
   ```
   (`-w` with no value prompts for it, so it stays out of shell history.)
2. Check `epos GET v4/TokenInfo` works for the user who will run the job.
3. Copy the template and fill in the placeholders:
   ```
   cp deploy/mac/uk.co.ggentertainment.epos-credit-sync.plist ~/Library/LaunchAgents/
   ```
   - `__NODE__`: the full path from `which node` (Node 22 or later).
   - `__REPO__`: the full path of this repo's checkout.
   - `__HOME__`: your home folder, for the log path.
   - `__VAULT_PB_URL__`, `__VAULT_PB_EMAIL__`, `__VAULT_PB_KEYCHAIN_SERVICE__` (for example `gge-vault-epos-sync`).
4. Load it:
   ```
   plutil -lint ~/Library/LaunchAgents/uk.co.ggentertainment.epos-credit-sync.plist
   launchctl load ~/Library/LaunchAgents/uk.co.ggentertainment.epos-credit-sync.plist
   ```
   The first run asks once for keychain access for `security` and for `epos`; choose Always Allow.
5. Watch `~/Library/Logs/epos-credit-sync.log`. A quiet run prints nothing.

To stop it: `launchctl unload ~/Library/LaunchAgents/uk.co.ggentertainment.epos-credit-sync.plist`. To run once by hand, set the same variables and run `node deploy/mac/epos-credit-sync.mjs`.

## What a run does

1. Any row still in `sending` moves to `needs_check`: a previous run stopped mid-call and the credit may already be in Epos Now.
2. Each `pending` row, and each `failed` row with fewer than 5 attempts, oldest first:
   - Finds the Epos customer: the Vault customer's `epos_customer_id` if set; otherwise `GET v4/Customer/GetByEmail` when there is an email; otherwise `POST v4/Customer` (Notes "Created by GG Vault"), and the address from `customer_private.address` with `POST v4/CustomerAddress`. The id is saved on the Vault customer straight away.
   - Sets the row to `sending`, and only once that is saved, calls `PUT v4/Customer/balance` with `{"CustomerId": id, "BalanceToAdd": 63.24}`.
   - HTTP 200: `done`, with `epos_balance_after` (pence) and `sent_at`.
   - A 4xx, or the request never left the Mac: `failed`, tried again next minute, up to 5 attempts.
   - A 5xx, a timeout, a dropped connection or anything else: `needs_check`. The worker never sends these again.
3. If any rows are in `needs_check`, prints a line starting `NEEDS CHECK:` with their ids.

One log line per row, with the row id, the Vault customer id and the amount. No names, emails or phone numbers.

## Resolving a needs_check row

A `needs_check` row means the worker asked Epos Now to add the credit and does not know whether it did. Sending it again could give the customer the credit twice.

1. In the PocketBase dashboard, open `epos_credit_queue` and the row. Note `amount` (pence), `epos_customer_id`, `last_error` and `updated`.
2. In Epos Now Back Office, open that customer (Customers, search by the id or name) and look at their balance and its history around the row's `updated` time.
3. If the credit is there: set the row's `status` to `done`, and `sent_at` to when it went on. Optionally put the balance shown into `epos_balance_after` (pence).
4. If it is not there: set `status` to `pending`. The next run sends it.

The deal's result screen reads this through `GET /api/vault/deals/{id}/epos-credit`, so it updates as soon as the row does.

A `failed` row with 5 attempts has stopped retrying. Read `last_error`, fix the cause (for example set `epos_customer_id` on the Vault customer by hand when several Epos customers share an email), then set `attempts` to 0 and `status` to `pending`. A row whose `last_error` says the customer create "may have gone through" needs the same check for a new customer in Epos Now first, so a second one is not made.

---

## Epos Now stock sync

Staff sell Vault items at the Epos Now till by scanning the label, so every Vault item on the shelf has to exist as an Epos Now product, and a till sale has to mark the Vault item sold. GG Vault queues product changes in `epos_product_queue` (see `docs/vault-rebuild-api.md`, "Epos Now products and till sales"); this worker, every 2 minutes:

1. **Products.** Makes each queued item an Epos Now product, updates it, or archives it when the item leaves the shelf.
2. **Categories.** Every 6 hours, copies the Epos Now category list into PocketBase so the Vault's Stock, Epos Now screen can show names.
3. **Sales.** Every 5 minutes, reads today's completed till transactions (and yesterday's, until it is settled), and applies each line for a Vault product once.

Files:

| File | What it is |
|---|---|
| `epos-stock-sync.mjs` | The worker. Node 22 or later, built-ins only. Reuses the `epos` runner from `epos-credit-sync.mjs`. |
| `lib/epos-stock.mjs` | The logic: queue states, the ownership guard, pence to pounds, reading till lines. |
| `test/epos-stock.test.mjs` | Unit tests with a mocked `epos` and PocketBase. `pnpm test:mac` runs both workers' tests. |
| `uk.co.ggentertainment.epos-stock-sync.plist` | The launchd template. |

### The rules it keeps

- **It only touches products it made.** A Vault product has `Barcode` = the Vault SKU as encoded on the label (`GGS7F3K2Q`) and `Sku` = `GGV-GGS7F3K2Q`. Before an update or archive it reads the product (`GET v4/Product/{id}`) and stops unless the `Sku` is exactly `GGV-` + the item's SKU. The id itself only ever comes from the Vault item (which staff cannot set) or the queue row. Hundreds of other products belong to the shop's other processes; the worker never changes, archives or deletes them.
- **It never deletes.** There is no DELETE call anywhere. Leaving the shelf is `PUT v4/Product` with `IsArchived: true`.
- **No duplicate products.** Before any create it lists every product (`GET v4/Product?page=N`, 200 a page) and, if one already carries the `GGV-` Sku, adopts it instead. If a product it did not make already has the barcode, it stops. The row is set to `sending`, and that write confirmed, before `POST v4/Product`. A create that gets a 5xx, a timeout or a dropped connection goes to `needs_check` and is never sent again by the worker. A row found in `sending` with no product id at the start of a run goes to `needs_check` too.
- **Updates are safe to repeat.** An update or archive sets absolute values, so an unknown outcome there is `failed` and retried (up to 5 attempts), and a row left in `sending` with a product id is retried.
- **A till sale is applied once.** Each Vault line is posted to `POST /api/vault/epos/sales/apply`, which logs it in `epos_sales_log` under a unique (transaction, line) index and changes the item in the same transaction. Pulling the same day again changes nothing.
- **Refunds are never applied.** A line with a `RefundReasonId` or a negative quantity is logged with `refund` and `needs_check`; the item stays as it is for a person to put back.
- **Money.** Pence to Epos pounds through the shared `penceToDecimal`, written into the JSON as a bare decimal; till prices back to pence through `poundsToPence` (the shared `parseDecimalToMinor` on the decimal text). No float maths.

### What it sends

| When | Call |
|---|---|
| A create, once per run with creates due | `GET v4/Product?page=1..n` |
| Create | `POST v4/Product` `[{Name, Barcode, Sku, SalePrice, CostPrice, EatOutPrice, CategoryId, SalePriceTaxGroupId, CostPriceTaxGroupId, IsSalePriceIncTax: true, IsCostPriceIncTax: true, ProductType: 0, SellOnTill: true, IsArchived: false}]` |
| Update | `GET v4/Product/{id}`, then `PUT v4/Product` `[{Id, ...the same fields}]` |
| Archive | `GET v4/Product/{id}`, then `PUT v4/Product` `[{Id, Name, SalePrice, CostPrice, EatOutPrice, IsArchived: true}]` with the values Epos returned |
| Stock level, only with `EPOS_SET_STOCK=1` | `POST v4/Inventory/{id}/Update` `[{LocationId: 14037, ProductId, CurrentStock: qty}]` after a create or update |
| Categories, every 6 hours | `GET v4/Category?page=N` |
| Sales, every 5 minutes | `GET v4/Transaction/GetByDate?startDate=D T00:00:00&endDate=D T23:59:59&status=1&extended=true&page=N` |

`Name` is the item title, plus the grade for a slab ("Charizard ex #199 PSA 10"), at most 100 characters. `CategoryId` comes from Stock, Epos Now in the Vault: the item's kind, else its game, else "Everything else". An item with no category, or no sticker price, waits with a `failed` row saying so; saving the mapping puts category waits back in the queue. `EatOutPrice` is the sale price (the swagger lists it as required).

Request budget: a quiet run costs nothing for products; each create or update is 2 calls plus one product list per run with creates due (a page per 200 products); sales are one call per day per page every 5 minutes, about 300 a day; categories 4 a day.

### Environment

The same `VAULT_PB_URL`, `VAULT_PB_EMAIL`, `VAULT_PB_KEYCHAIN_SERVICE`, `EPOS_BIN`, `EPOS_TIMEOUT_MS` and `SECURITY_BIN` as the credit sync (the same superuser can run both), plus:

| Variable | Required | What |
|---|---|---|
| `EPOS_SALES_EVERY_MIN` | no | Default `5`. How often to pull till sales. |
| `EPOS_CATEGORY_REFRESH_HOURS` | no | Default `6`. |
| `EPOS_SET_STOCK` | no | `1` to set the Epos stock level to the Vault quantity after each create or update. Off by default until checked (see below). |
| `EPOS_LOCATION_ID` | no | Default `14037`, for `EPOS_SET_STOCK`. |
| `EPOS_STOCK_LOCK` | no | Lock file, default `$TMPDIR/uk.co.ggentertainment.epos-stock-sync.lock`. |

### Install

1. Do the credit sync's steps 1 and 2 if they are not done already.
2. `cp deploy/mac/uk.co.ggentertainment.epos-stock-sync.plist ~/Library/LaunchAgents/` and fill in the same placeholders.
3. `plutil -lint` it, then `launchctl load ~/Library/LaunchAgents/uk.co.ggentertainment.epos-stock-sync.plist`.
4. In the Vault, open Stock, Epos Now (admin). Once the first run has read the categories, set a category for each game or kind and Save.
5. Send existing shelf stock once: `POST /api/vault/stock/epos/backfill` as an admin. New and changed items queue themselves.
6. Watch `~/Library/Logs/epos-stock-sync.log`. A quiet run prints nothing.

### Resolving a check

Stock, Epos Now in the Vault lists everything waiting for a person, with **Mark resolved**.

- **A create that may have gone through.** Search Epos Now Back Office for the `GGV-` Sku in the message. Whatever you find, Mark resolved: the row goes back to pending, and the worker adopts the product if it is there or creates it if it is not. If there are two, archive one in Back Office first.
- **A product the Vault did not make** ("does not carry Sku"). The item points at the wrong product. A superuser clears `epos_product_id` on the item in the PocketBase dashboard, then Mark resolved; the worker makes the item its own product.
- **A refund.** Check the item. If it is back on the shelf, set it back to in stock in the Vault (that puts it back on the till). Then Mark resolved.
- **A double sale or a short count** ("already has it as sold", "the till sold 2 but the Vault held 1"). Count it, fix the item, then Mark resolved.

### Assumptions to check on the first supervised run

These come from the brief and the public swagger, not from a real call; check each against the live account before leaving it running.

1. `GET v4/Product?page=N` returns a bare JSON array of up to 200 products with `Id`, `Sku`, `Barcode`, `IsArchived`, **including archived products**. If archived products are left out, a Vault item that comes back into stock after its product was archived would get a second product instead of the old one being unarchived.
2. `GET v4/Product/{id}` returns a single product object (not an array), and 404 for an unknown id.
3. `POST v4/Product` replies 200 or 201 with an array of the created products, each with its new `Id`. PascalCase field names are accepted on input (the swagger shows camelCase; ASP.NET binds both).
4. `PUT v4/Product` accepts `[{Id, Name, SalePrice, CostPrice, EatOutPrice, ...}]` with those required fields and leaves fields it was not sent unchanged, and `IsArchived: true` hides the product from the till. A 200 means applied.
5. The label's scanned value is what the Epos till matches against `Barcode`. The Vault stores and encodes the SKU without its hyphen (`GGS7F3K2Q`); the item labels carry it as a QR code, so the till scanner must read QR (the Niimbot price label has no code at all). Scan one label at the till before relying on it.
6. `GET v4/Transaction/GetByDate` returns a bare array of up to 200 transactions per page, each with `Id`, `DateTime` (UTC, no marker) and `TransactionItems` with `Id`, `ProductId`, `Quantity` (whole), `UnitPrice` (the price actually charged per unit, in pounds) and `RefundReasonId`. A line without an `Id` is keyed by its position, which is only stable if Epos returns lines in the same order every time. Check whether `UnitPrice` is before or after a line discount.
7. `status=1` means completed. The dates in `startDate`/`endDate` are taken as UTC days; the worker reads yesterday as well until 02:00 UTC so a sale near midnight is not missed in either reading.
8. `GET v4/Category?page=N` returns a bare array with `Id`, `Name`, `ParentId`, 200 a page.
9. `POST v4/Inventory/{id}/Update` with `[{LocationId, ProductId, CurrentStock}]` sets the absolute stock level for that location (from the stocks swagger's `InventoryUpdateStockRequest`); it may need stock tracking switched on for the product. That is why `EPOS_SET_STOCK` is off by default. With it off, Epos Now stock levels for Vault products are not managed; the Vault quantity is the record.
10. The request budget: whether "about 5,000 per period" is per day or per hour changes how low `EPOS_SALES_EVERY_MIN` can safely go.
