# GG Vault - restore rehearsal

This is the step-by-step for restoring a backup, both for a real recovery
and for the quarterly rehearsal in the checklist at the bottom. Rehearsing
this at a quiet moment, before it is ever needed for real, is what makes
it trustworthy - see "before go-live" in `deploy/README.md`.

Nothing here touches the live `deploy/data/pb_data` until the final "swap
in" step, so everything up to that point is safe to run at any time,
including in the middle of a normal trading day, without a customer
noticing.

All commands assume you are in the `deploy/` directory on the VPS, and
that `deploy/.env` is filled in (it holds `RESTIC_REPOSITORY` and
`RESTIC_PASSWORD`, which restic needs for every command below).

```bash
cd /path/to/ggpos/deploy
set -a; source .env; set +a
```

## 1. List snapshots

```bash
restic snapshots --tag ggvault
```

Confirms the backup job has actually been running, and gives you the ID
of the snapshot to restore (or just use `latest`, which every command
below does).

## 2. Restore to a temp directory

Never restore on top of the live data directory directly - always to a
scratch location first, so a bad or old snapshot can't do any damage
before you've looked at it.

```bash
RESTORE_DIR="/tmp/ggvault-restore-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESTORE_DIR"
restic restore latest --tag ggvault --target "$RESTORE_DIR"
```

This creates `$RESTORE_DIR/pb_data` (matching the path backup.sh staged
it from). List it to sanity-check it looks like a real pb_data directory
before going further:

```bash
ls -la "$RESTORE_DIR/pb_data"
# expect to see data.db (and possibly other *.db files) plus a storage/
# directory holding uploaded files
```

## 3. Verify with `pocketbase serve` on a spare port

This step is really just `pocketbase serve` pointed at the restored copy
instead of the real one, on a port nothing else is using, so it can be
checked before it goes anywhere near the live data. On the VPS the
simplest way to run that is the already-built image, which runs that
same `pocketbase serve` command internally:

```bash
docker run --rm -p 127.0.0.1:8099:8090 \
  -v "$RESTORE_DIR/pb_data":/pb/pb_data \
  ggvault-pocketbase
```

(If you're doing this rehearsal somewhere other than the VPS, and a
standalone `pocketbase` binary is more convenient than Docker, this is
equally valid: `pb/scripts/dev.sh` already shows how to download the
matching version. Either way you're checking the same thing: does
PocketBase start cleanly from this data and serve it correctly.)

Leave that running and, in another terminal, check it actually serves:

```bash
curl -sf http://127.0.0.1:8099/api/health
```

A healthy response is JSON with `"code": 200`. Then open
`http://<vps-ip>:8099/_/` in a browser (over an SSH tunnel if the VPS
firewall blocks the port directly - `ssh -L 8099:localhost:8099 <vps>`
from your own machine) and sign in with the superuser account, and spot
check a few real records (a recent sale, a recent trade-in, a customer)
look right. Once you're satisfied, stop the container with Ctrl+C - it
never touched the live data, so there is nothing to undo.

## 4. Swap in

Only do this for a real recovery (data loss, a corrupted database, a
failed upgrade), never as part of the quarterly rehearsal - the
rehearsal stops at step 3.

```bash
cd /path/to/ggpos/deploy
docker compose down
mv data/pb_data "data/pb_data.broken-$(date +%Y%m%d-%H%M%S)"
mv "$RESTORE_DIR/pb_data" data/pb_data
```

## 5. Restart

```bash
docker compose up -d
curl -sf https://vault.ggentertainment.co.uk/api/health
```

Once you've confirmed the shop is trading normally again, remove the
`data/pb_data.broken-*` directory and the `$RESTORE_DIR` scratch copy.

## Quarterly restore test checklist

Run this every quarter (put a recurring reminder in your calendar) and
after any PocketBase version upgrade. Keep the dated results somewhere
you'll find them again, for example a line added to this file or a note
in `docs/`.

- [ ] `restic snapshots --tag ggvault` shows a snapshot from within the
      last 24 hours
- [ ] Steps 1 to 3 above completed without an error
- [ ] The restored copy's admin UI shows today's (or yesterday's) real
      sales and trade-ins, not stale data from weeks ago
- [ ] A couple of uploaded files open correctly (an item photo, or - with
      the appropriate step-up - an ID photo), confirming `storage/` was
      backed up along with the database, not just the database
- [ ] `restic check` run at least once this quarter (a deeper repository
      integrity check, slower than a normal backup - run it as
      `restic check` with `deploy/.env` sourced, on a day this can run
      in the background)
- [ ] Result (pass/fail, date, who ran it) recorded somewhere findable
