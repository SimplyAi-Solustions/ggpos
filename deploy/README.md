# GG Vault - VPS runbook

This is the step-by-step for getting GG Vault running on the shop's VPS,
and for running it day to day afterwards. It assumes no prior familiarity
with the codebase - where a step needs a terminal command, the exact
command is given; where it needs a decision, the decision is explained.

GG Vault runs as a **second, separate PocketBase** on the same VPS that
already serves `ggentertainment.co.uk` and its own PocketBase for the
marketing site. GG Vault does not get its own Caddy or its own VPS: it
adds one Docker Compose stack and one new block in the existing Caddy
configuration.

## Before you start

You will need:

- SSH access to the VPS as a user that can run `docker` and edit the
  Caddy configuration.
- Access to the DNS records for `ggentertainment.co.uk`.
- An S3-compatible bucket for backups already created (Cloudflare R2 or
  Backblaze B2 both work - see "Backups" below).
- This repository checked out on the VPS at some path, for example
  `/home/deploy/ggpos`. The rest of this document calls that path
  `<repo>`.

## 1. DNS

Add an `A` record for `vault.ggentertainment.co.uk` pointing at the VPS's
IP address (the same address `ggentertainment.co.uk` itself already
resolves to). DNS changes can take a little while to spread; there is no
need to wait for it before doing the next steps, but Caddy will not be
able to get a certificate for the site until this record is live.

## 2. Caddy

The VPS already runs Caddy for the marketing site. GG Vault adds one more
site block to that same Caddy configuration - it does not run its own
Caddy.

1. Open the existing Caddyfile on the VPS (commonly
   `/etc/caddy/Caddyfile`).
2. Paste in the whole contents of `deploy/Caddyfile.snippet` as a new
   site block, alongside the existing one for `ggentertainment.co.uk`.
3. Replace `203.0.113.10` (marked `SHOP_IP_PLACEHOLDER` in the file) with
   the shop's real public IP address. You can find this by opening
   `https://www.whatismyip.com` on a device connected to the shop's own
   internet connection. Until this is replaced, the admin dashboard is
   unreachable from anywhere at all, including the shop - that is the
   safe default, not a bug.
4. Check the file is valid before reloading:
   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   ```
5. Reload Caddy:
   ```bash
   sudo systemctl reload caddy
   ```

Reloading does not drop any connections to the marketing site - Caddy
reloads its configuration without restarting.

## 3. First deploy

From `<repo>/deploy`:

```bash
cd <repo>/deploy
cp .env.example .env
```

Now open `.env` in an editor and fill in every value - each one has a
comment above it explaining what it is and, where relevant, how to
generate it. Take particular care with `GG_ID_PHOTO_KEY` and
`RESTIC_PASSWORD`: both are explained in `.env.example`, and both need a
copy kept in a password manager, off the VPS.

Then build and start the stack:

```bash
docker compose up -d --build
```

The first build takes a few minutes (it compiles the PocketBase image,
the pricesync image and the notify image). Check all three containers
came up:

```bash
docker compose ps
```

`pocketbase` and `notify` should both show as `running` (`pocketbase`
also `healthy` after about 15-45 seconds; `notify` has no healthcheck of
its own - "running" is enough, see "Push notifications" below for how to
confirm it is actually sending anything). `pricesync` is expected to show
as `Exited (0)` - it is a run-once script, not a server; see the comment
in `docker-compose.yml` if that looks surprising.

## 4. Creating the superuser

This is the PocketBase platform administrator account - the one used to
sign in at `/_/`, PocketBase's own dashboard (not the shop's staff login
inside the app itself; see the next step for that).

```bash
docker compose exec pocketbase /pb/pocketbase superuser upsert EMAIL PASS --dir /pb/pb_data
```

Replace `EMAIL` and `PASS` with real values (you can reuse
`GG_ADMIN_EMAIL` / `GG_ADMIN_PASSWORD` from `.env`, or choose different
ones - either is fine, nothing else depends on them matching). Running
this command again later with the same email updates that account's
password, which is the easiest way to reset it if it's ever forgotten.

## 5. Seeding the first admin

This is different from the step above: it is the first **staff** account
inside the app itself (the `staff` collection, role `admin`) - the
account used to actually sign in to The Counter and set everything else
up (pricing rules, the loyalty programme, other staff logins). The
migrations that run automatically on first start read `GG_ADMIN_EMAIL`
and `GG_ADMIN_PASSWORD` from `.env` and create this account for you, so
there is nothing to run by hand here: sign in to the app with
those same credentials once it's up, and change the password on first
login.

## 6. Enabling MFA on superusers

Multi-factor authentication for the PocketBase superuser account (from
step 4) is turned on from inside `/_/` itself, not from the command line:

1. Sign in at `https://vault.ggentertainment.co.uk/_/` (only reachable
   from the shop's own connection, per the Caddy block above).
2. Open the superuser's own account settings.
3. Turn on two-factor authentication and follow the prompts (an
   authenticator app such as Google Authenticator, Authy or 1Password
   works).
4. Store the recovery codes somewhere safe and separate from the device
   running the authenticator app - if that device is lost, the recovery
   codes are the only way back in.

Do this for every superuser account that gets created later, too.

## 7. Backups and the cron lines

Backups run through `deploy/backup.sh` (restic, encrypted client-side,
uploaded to an S3-compatible bucket). Full detail on how the script
works is in the comments at the top of `backup.sh` itself; this section
covers the one-time setup and the cron lines.

**One-time setup**, after `.env` has real values in it:

```bash
cd <repo>/deploy
set -a; source .env; set +a
restic init
```

This creates the (empty) backup repository. Run it once, ever, per
bucket - running it again on an already-initialised repository is
harmless (restic says so and does nothing).

**Cron lines** (edit with `crontab -e`; use `sudo crontab -e` if
`deploy/data/pb_data` ends up owned by `root`, which is the default
unless `pb/Dockerfile` sets a different user):

```cron
# GG Vault: nightly backup, 03:00
0 3 * * * /path/to/ggpos/deploy/backup.sh

# GG Vault: nightly price sync, 04:00
0 4 * * * mkdir -p /path/to/ggpos/deploy/logs && cd /path/to/ggpos/deploy && docker compose run --rm pricesync >> /path/to/ggpos/deploy/logs/pricesync.log 2>&1
```

Backup runs before pricesync so the previous day's prices are what gets
backed up, and so the two jobs' load on the box doesn't overlap. The
output redirect on the pricesync line is not optional the way it might
look: `docker compose run --rm` deletes the container the instant it
exits, taking `docker compose logs pricesync`'s only copy of what it
printed with it (see "Logs" below), so without a redirect a run's own
counts and exit code are gone by the time anyone looks. `backup.sh`
does not need the same treatment because it writes `deploy/logs/backup.log`
itself, from inside the script; pricesync has no such wrapper, so the
cron line does the redirecting instead.

There is deliberately no third cron line for currency conversion: the
daily FX rate fetch (from Frankfurter) is a PocketBase cron job defined
inside `pb_hooks`, so it runs automatically inside the `pocketbase`
container itself and needs nothing set up here.

**pricesync configuration.** Its environment comes from `.env` (see the
"pricesync" section of `.env.example`: `PB_SUPERUSER_EMAIL` and
`PB_SUPERUSER_PASSWORD`) plus one variable `docker-compose.yml` sets
itself and that never needs editing (`PB_URL`, always the in-network
`http://pocketbase:8090`). It also reads `CACHE_DIR`, which defaults to
`/app/cache` - the path both the Dockerfile's `VOLUME` and
`docker-compose.yml`'s `./data/pricesync-cache:/app/cache` bind mount
point at - so there is nothing to set for that either unless you are
changing the image's layout. That cache is what makes an unchanged
Cardmarket or TCGCSV file skip re-downloading on the next run; if prices
ever look stuck, clear it with (pricesync is a `run --rm` service, so
there is no running container for `docker compose exec` to reach - this
runs the image fresh, the same way the cron line does):

```bash
docker compose run --rm pricesync sh -c 'rm -rf /app/cache/*'
```

This is safe to run any time - the next real run just re-downloads
everything.

**Verify PocketBase's Batch API is on** the first time you bring this
stack up: `pb_migrations/1789819980_batch_api_settings.js` turns it on
(200 requests per call, a 60 second transaction timeout) as part of the
schema migrations `docker compose up` already applies, so this is a
confirmation step, not something to configure by hand. Sign in at `/_/`,
open Settings > Application, and check "Batch requests" is enabled with
Max requests at 200 or more. pricesync copes even if it somehow is not
(it detects this and falls back to writing one record at a time, logging
a line saying so), but that is far slower for no benefit - if you ever
see that fallback message in the log, something reverted or skipped that
migration and is worth tracking down rather than leaving as is. This is
also on the go-live checklist below.

Check a run went well by reading `deploy/logs/pricesync.log` (see "Logs"
below - not `docker compose logs pricesync`, which shows nothing once a
`--rm` run has exited): it logs one line per game with counts (entries
seen, matched, written) and a final summary line, and exits non-zero on
any hard failure. Two exit codes mean something specific:

- **exit 2**: the latest `fx_rates` row is missing or more than 3 days
  old. Check the FX cron ran (`docker compose logs pocketbase | grep
  '\[cron:fx\]'`) rather than re-running pricesync - it will keep
  refusing until a fresh rate exists.
- **exit 1**: anything else (cannot reach or authenticate to PocketBase,
  a Cardmarket/TCGCSV fetch failed, or some rows failed to write). The
  log line right before the summary names what failed.

Rehearse a full restore before go-live and every quarter after that -
see `deploy/restore.md`.

## 8. Push notifications (the notify service)

Unlike pricesync, `notify` is a persistent container, not a cron-scheduled
one-off: `docker compose up -d` starts it once and it stays running,
polling PocketBase for unpushed `notifications` rows every 60 seconds (see
the comment on the `notify` service in `docker-compose.yml`). There is no
cron line to add for it.

**One-time setup, before the first `docker compose up`:**

1. Generate a VAPID keypair:

   ```bash
   npx web-push generate-vapid-keys
   ```

   This prints a public key and a private key. Neither is secret in the
   way `RESTIC_PASSWORD` or `GG_ID_PHOTO_KEY` are - the public key is
   handed to every visitor's browser on purpose - but the private key
   should still not be pasted anywhere outside `.env` and a password
   manager, since anyone holding it could send push messages that appear
   to come from this shop's own installation.

2. Put the private key, and the subject, into `.env` (see the "notify"
   section of `.env.example`): `GG_VAPID_PRIVATE_KEY` and
   `GG_VAPID_SUBJECT` (a `mailto:` address the push services can contact
   about this VAPID identity if they ever need to, for example
   `mailto:admin@ggentertainment.co.uk`).

3. Put the **public** key into `settings.push.vapid_public_key` - this is
   an application record, not an environment variable, because
   `GET /api/vault/config` (read by both the counter app and the customer
   portal) serves it from there to whichever browser is about to
   subscribe. Set it once, from `/_/`:

   ```
   Collections > settings > (the one row) > push > { "vapid_public_key": "PASTE_THE_PUBLIC_KEY_HERE" }
   ```

   or with a single authenticated API call if you would rather script it
   (replace `SUPERUSER_TOKEN` with a fresh token from
   `POST /api/collections/_superusers/auth-with-password`):

   ```bash
   curl -X PATCH https://vault.ggentertainment.co.uk/api/collections/settings/records/SETTINGS_ROW_ID \
     -H "Authorization: SUPERUSER_TOKEN" -H "Content-Type: application/json" \
     -d '{"push":{"vapid_public_key":"PASTE_THE_PUBLIC_KEY_HERE"}}'
   ```

4. `notify` also needs a PocketBase superuser to authenticate as
   (`PB_SUPERUSER_EMAIL`/`PB_SUPERUSER_PASSWORD`) - the same two variables
   `.env.example`'s "pricesync and notify" section already covers; reuse
   the same account pricesync uses, or point it at a different superuser,
   either is fine.

Rotating the keypair later (if the private key is ever exposed) means
generating a new one, updating both halves as above, and accepting that
every browser subscription created under the old public key stops
working - `services/notify` deletes each one the next time it tries to
push to it and gets a 404/410 back, and the portal re-subscribes on its
next visit; there is no bulk migration step to run.

**Checking it is working:**

```bash
docker compose ps notify              # should show "running", not "Exited"
docker compose logs -f notify         # one summary line per pass, e.g.
                                       # "[notify] pass complete: 2 unpushed, 2 marked pushed, 0 dead subscription(s) removed, 0 skipped (no subscription yet)"
```

A notification stuck with an empty `pushed_at` for longer than a couple of
minutes, with `push_subscriptions` rows on file, usually means the VAPID
keys in `.env` do not match the public key in `settings.push` any more
(mismatched keypairs fail every send) - check both were updated together
in step 2 and 3 above. `services/notify` never logs a subscription's own
endpoint or keys, by design (see `services/notify/src/lib/push.mjs`'s own
doc comment), so a "pushed failed" log line names only the notification
id, not which device or browser it was.

## 9. Updating

**Automatic** (the normal way, once this is set up): pushing to `main`
runs `.github/workflows/deploy.yml`, which builds the web app, copies it
into `pb_public`, rsyncs everything over SSH, and runs
`docker compose up -d --build` on the VPS for you. This needs four
GitHub repository secrets set once, under the repository's Settings >
Secrets and variables > Actions:

| Secret        | What it is                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| `VPS_HOST`    | the VPS's hostname or IP address                                                      |
| `VPS_USER`    | the SSH user to deploy as                                                             |
| `VPS_SSH_KEY` | the private half of an SSH key that user accepts (paste the whole file, including the `-----BEGIN`/`-----END` lines) |
| `VPS_PATH`    | the absolute path to this repository on the VPS, i.e. `<repo>`                        |

The `VPS_USER` account needs to be able to run `docker` without a
password prompt (normally: it's a member of the `docker` group), and its
matching public key needs to already be in that user's
`~/.ssh/authorized_keys` on the VPS.

**Manual** (for troubleshooting, or before the secrets above are set
up), run on your own machine or on the VPS itself if the code is already
there:

```bash
git pull
pnpm install --frozen-lockfile
pnpm --filter web build
rm -rf pb/pb_public && cp -r apps/web/dist/. pb/pb_public/
# copy pb/ and deploy/ to the VPS if you built this somewhere else, then:
cd <repo>/deploy
docker compose up -d --build
```

**Never set `VITE_DEMO` or `VITE_DEMO_SWITCH` on a shop build.** A plain
`pnpm --filter web build`, which is what the deploy workflow runs, produces
an app that ignores `?demo=1` entirely: the query switch only exists in a
Vite dev server or in a build made with `VITE_DEMO_SWITCH=1`, which is how
the end-to-end suite and the screenshot scripts drive a real build onto
fixtures. With the flag on, anyone who pastes `?demo=1` into the address bar
gets in-memory demo data on a real till or on a customer's own portal, which
looks exactly like the shop's own and saves nothing.

## 10. Logs

```bash
docker compose logs -f pocketbase   # the app and API
docker compose logs -f notify       # the push sidecar - a persistent container, so `docker compose logs` works for it the normal way
tail -f deploy/logs/pricesync.log   # the nightly price sync's own log (see "pricesync configuration")
tail -f deploy/logs/backup.log      # the nightly backup's own log
```

`docker compose logs pricesync` only shows anything in the few moments
between a manual `docker compose run pricesync` (without `--rm`) and
removing that container yourself - the cron-scheduled run always uses
`--rm`, which deletes the container, and its logs with it, the instant
it exits. `deploy/logs/pricesync.log` is what the cron line itself
redirects to, so it is the one place that log survives.

## 11. Health checks

```bash
curl https://vault.ggentertainment.co.uk/api/health
docker compose ps
```

The first should return a small JSON response with `"code": 200`. The
second shows `healthy`/`unhealthy` for the `pocketbase` container - see
the comment on its `healthcheck` in `docker-compose.yml` if it never goes
healthy (it assumes the PocketBase image has `wget` available).

## 12. Counter PC setup

This is the shared till PC. It needs: the label printer driver, a Chrome
shortcut that prints without a dialog, the barcode scanner configured,
and the app installed as a PWA.

1. **ORGSTA T003 label printer driver.** Install the Windows driver that
   comes with the printer (from the included disc or download, per
   ORGSTA's own instructions) and connect it over USB. Print a test label
   from Windows first, before touching the app, to confirm the printer
   itself is working.
2. **Chrome shortcut for silent printing.** Labels print from the app's
   own label pages, sized to the label exactly, with no print dialog in
   the way. Create a desktop shortcut with this as the target (adjust the
   path to Chrome if it's installed somewhere else):
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing
   ```
   Staff open the app through this shortcut rather than a normal Chrome
   window. `--kiosk-printing` makes every print from this Chrome window
   go straight to the default printer with no confirmation dialog, so set
   the T003 as the default printer in Windows too.
3. **USB barcode scanner.** Any USB 2D scanner works (for example a
   Zebra DS2208, or a cheaper Eyoyo/NETUM 2D model) as long as it can be
   configured as a "keyboard wedge" (it types the scanned code followed
   by a key, exactly as if someone had typed it and pressed a key
   themselves). Using the scanner's own configuration guide (usually a
   small booklet of barcodes to scan in sequence, sometimes a piece of
   software), set:
   - a **prefix character** before the scanned text (this is how the app
     tells "someone typed this" apart from "a scanner produced this"),
   - **Enter** as the **suffix** after the scanned text (so the app
     receives the code and acts on it immediately, the same as pressing
     Enter after typing it).
   Test it by opening a plain text editor and scanning any barcode: you
   should see the prefix character, then the code, then the cursor drop
   to a new line.
4. **Install the PWA.** Open `https://vault.ggentertainment.co.uk` in
   Chrome, then use Chrome's install icon in the address bar (or the
   three-dot menu > "Install GG Vault..."). This gives the counter its
   own app window and its own taskbar icon, separate from a browser tab
   that might get closed by accident.

An optional tablet running `/display` in Chrome's kiosk mode
(`chrome --kiosk https://vault.ggentertainment.co.uk/display`) can sit
on the counter facing the customer; it is not required for the shop to
trade.

## 13. Phones

Staff phones and the shop's own phone/tablet for the customer portal
need only the PWA installed from the browser, the same as any website
that supports "install as app":

- **Android (Chrome):** open `https://vault.ggentertainment.co.uk`, tap
  the three-dot menu, then "Install app" (or "Add to Home screen").
- **iPhone/iPad (Safari):** open `https://vault.ggentertainment.co.uk`,
  tap the Share icon, then "Add to Home Screen". Safari does not offer
  the same automatic install prompt Chrome does, so this manual step is
  the normal way to install any PWA on iOS.

## Before go-live checklist

- [ ] A full restore rehearsal (`deploy/restore.md`) has been completed
      successfully, not just the backup job running
- [ ] The ICO data protection fee has been paid (tier 1, about £52/year -
      register at ico.org.uk if this business hasn't already)
- [ ] The privacy notice (`docs/privacy-notice.md`) is printed and
      actually sitting at the counter, not just in the repository
- [ ] `/_/` is confirmed unreachable from outside the shop - ask someone
      away from the shop (on mobile data, not the shop wifi) to run
      `curl -i https://vault.ggentertainment.co.uk/_/` and confirm they
      get a plain `404`, then confirm it loads normally from inside the
      shop
- [ ] PocketBase's Batch API is confirmed on with Max requests at least
      200 (Settings > Application in `/_/`) - `pb_migrations/
      1789819980_batch_api_settings.js` turns this on for you as part of
      the schema migrations, so this is a check, not a step; see
      "pricesync configuration" above
- [ ] VAPID keys are generated, the private key and subject are in `.env`,
      the public key is in `settings.push.vapid_public_key`, and
      `docker compose logs notify` shows a pass completing rather than a
      missing-environment-variable error - see "Push notifications
      (the notify service)" above
