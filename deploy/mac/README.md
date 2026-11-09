# Shop Mac: Epos Now store-credit sync

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
