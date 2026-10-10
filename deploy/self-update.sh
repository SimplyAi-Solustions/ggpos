#!/usr/bin/env bash
# GG Vault - deploy the newest finished, tested commit on the deploy branch.
#
# Installed on the server by deploy/bootstrap.sh as a cron line every ten
# minutes, under flock, so two runs never overlap. A commit reaches the shop
# only when all of these hold:
#
#   1. It is the newest commit on the deploy branch's own line (named in
#      /etc/ggvault/deploy-branch; first parents only, so nothing that came
#      in through a merge) whose subject does not start with "WIP".
#      Work-in-progress snapshots are pushed while a feature is being built;
#      they never reach the till.
#   2. GitHub CI passed on that exact commit: every check named in
#      REQUIRED_CHECKS completed with success. A commit still under test is
#      tried again on the next run; a failed one is never deployed.
#   3. A PocketBase backup of the live database was taken first, so a bad
#      migration can be undone from /_/ > Settings > Backups.
#
# If the build fails or the new stack does not answer its health check, the
# previously deployed commit is checked out and rebuilt, and that target is
# not tried again until a newer finished commit appears.
#
# The web build writes the commit it was built from to /version.json, so
# what is live can be checked from anywhere:
#   curl -s https://ggpos.ggentertainment.co.uk/version.json
set -euo pipefail

DEST="${GG_PATH:-/opt/ggpos}"
BRANCH="$(cat /etc/ggvault/deploy-branch 2>/dev/null || echo main)"
REPO_API="${GG_REPO_API:-https://api.github.com/repos/SimplyAi-Solustions/ggpos}"
REQUIRED_CHECKS="${GG_REQUIRED_CHECKS:-Lint, typecheck, test, build|PocketBase checks}"
KEEP_BACKUPS="${GG_KEEP_PREDEPLOY_BACKUPS:-7}"
STATE_DIR=/var/lib/ggvault
export PATH="/opt/ggvault-node/bin:$PATH"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p "$STATE_DIR"

log() { echo "== $(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"; }
# The same waiting message every ten minutes is noise: say it once.
note() {
  if [ "$(cat "$STATE_DIR/last-note" 2>/dev/null || true)" != "$*" ]; then
    log "$*"
    printf '%s' "$*" > "$STATE_DIR/last-note"
  fi
}

cd "$DEST"
git fetch -q origin "$BRANCH"

# --- 1. The newest finished commit ------------------------------------------
# --first-parent: only the branch's own commits are candidates. A commit
# that came in through a merge (a package built on its own branch) holds
# that package alone, never the whole app, so it is never deployed by
# itself; the merge commit that brings it in is.
# awk reads to the end rather than stopping at the first match: if it
# stopped, git log would be killed by SIGPIPE mid-write, pipefail would make
# the pipeline fail with 141, and set -e would end this script before it
# logged a word, every run, whenever the target is near the top.
TARGET="$(git log --first-parent -n 300 --format='%H%x09%s' "origin/$BRANCH" | awk -F'\t' '!found && $2 !~ /^WIP/ { print $1; found = 1 }')"
if [ -z "$TARGET" ]; then exit 0; fi
LOCAL="$(git rev-parse HEAD)"
if [ "$LOCAL" = "$TARGET" ]; then exit 0; fi
if [ "$(cat "$STATE_DIR/failed-target" 2>/dev/null || true)" = "$TARGET" ]; then exit 0; fi

# --- 2. CI must have passed on it -------------------------------------------
CHECKS_JSON="$(curl -fsS -m 30 -H 'Accept: application/vnd.github+json' \
  "$REPO_API/commits/$TARGET/check-runs?per_page=100" 2>/dev/null || true)"
VERDICT="$(printf '%s' "$CHECKS_JSON" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  let runs;
  try { runs = JSON.parse(d).check_runs; } catch (e) { console.log("unreadable"); return; }
  if (!Array.isArray(runs)) { console.log("unreadable"); return; }
  let state = "green";
  for (const name of process.argv[1].split("|")) {
    const mine = runs.filter((r) => r.name === name);
    if (!mine.length) { if (state === "green") state = "pending"; continue; }
    // A re-run supersedes the earlier attempt: the newest one decides.
    mine.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const r = mine[0];
    if (r.status !== "completed") { if (state === "green") state = "pending"; continue; }
    if (r.conclusion !== "success") { state = "red"; break; }
  }
  console.log(state);
});' "$REQUIRED_CHECKS")"
case "$VERDICT" in
  green) ;;
  pending) note "waiting for CI on ${TARGET:0:7}"; exit 0 ;;
  red) note "CI failed on ${TARGET:0:7}; it will not be deployed"; exit 0 ;;
  *) note "could not read the CI results for ${TARGET:0:7}; trying again next run"; exit 0 ;;
esac

# --- 3. Back up the live database ------------------------------------------
cd "$DEST/deploy"
set -a; . ./.env; set +a
STAMP="$(date -u +'%Y%m%d%H%M%S')"
if curl -fsS -m 5 http://127.0.0.1:8091/api/health >/dev/null 2>&1; then
  TOKEN="$(curl -fsS -m 20 -X POST http://127.0.0.1:8091/api/collections/_superusers/auth-with-password \
    -H 'Content-Type: application/json' \
    --data-binary "$(printf '{"identity":"%s","password":"%s"}' "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD")" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [ -z "$TOKEN" ]; then
    note "could not sign in to PocketBase to back it up; not deploying ${TARGET:0:7}"
    exit 1
  fi
  BACKUP="predeploy_${TARGET:0:7}_${STAMP}.zip"
  if ! curl -fsS -m 600 -o /dev/null -X POST http://127.0.0.1:8091/api/backups \
      -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
      --data-binary "{\"name\":\"$BACKUP\"}"; then
    note "the pre-deploy backup failed; not deploying ${TARGET:0:7}"
    exit 1
  fi
  log "backed up the database to $BACKUP"
  # Keep the newest few pre-deploy backups; the nightly restic backup keeps
  # the long history off this server.
  curl -fsS -m 20 http://127.0.0.1:8091/api/backups -H "Authorization: $TOKEN" \
    | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  let list = [];
  try { list = JSON.parse(d); } catch (e) { return; }
  list
    .filter((b) => String(b.key).startsWith("predeploy_"))
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
    .slice(Number(process.argv[1]))
    .forEach((b) => console.log(b.key));
});' "$KEEP_BACKUPS" \
    | while read -r OLD; do
        curl -fsS -m 20 -o /dev/null -X DELETE "http://127.0.0.1:8091/api/backups/$OLD" -H "Authorization: $TOKEN" || true
      done
else
  # PocketBase is already down, so the files are not being written to and
  # a plain copy is consistent. A fix still has to be able to go out.
  mkdir -p data/predeploy
  tar -czf "data/predeploy/pb_data_${TARGET:0:7}_${STAMP}.tar.gz" -C data pb_data
  ls -1t data/predeploy/*.tar.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
  log "PocketBase was not answering; copied pb_data to data/predeploy instead"
fi

# --- 4. Deploy, and roll back if it does not come up -----------------------
build_and_start() {
  cd "$DEST"
  pnpm install --frozen-lockfile
  pnpm --filter web build
  rm -rf pb/pb_public && mkdir -p pb/pb_public && cp -r apps/web/dist/. pb/pb_public/
  cd "$DEST/deploy"
  docker compose up -d --build
  for _ in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:8091/api/health >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

log "deploying ${TARGET:0:7} on $BRANCH (was ${LOCAL:0:7})"
cd "$DEST"
git reset -q --hard "$TARGET"
if build_and_start; then
  rm -f "$STATE_DIR/failed-target" "$STATE_DIR/last-note"
  log "healthy on ${TARGET:0:7}"
  exit 0
fi

log "${TARGET:0:7} did not come up healthy; rolling back to ${LOCAL:0:7}" >&2
(cd "$DEST/deploy" && docker compose ps >&2 && docker compose logs --tail=60 pocketbase >&2) || true
printf '%s' "$TARGET" > "$STATE_DIR/failed-target"
cd "$DEST"
git reset -q --hard "$LOCAL"
if build_and_start; then
  log "rolled back; healthy on ${LOCAL:0:7}. If the database was migrated, restore $([ -n "${BACKUP:-}" ] && echo "$BACKUP" || echo "the pre-deploy copy") from /_/ > Settings > Backups." >&2
else
  log "the roll-back did not come up healthy either; see the logs above" >&2
fi
exit 1
