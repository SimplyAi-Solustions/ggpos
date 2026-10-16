#!/usr/bin/env bash
# GG Vault - nightly backup of pb_data to S3-compatible storage via restic.
#
# What this does, in order:
#   1. Makes a crash-consistent copy of PocketBase's SQLite database(s)
#      while PocketBase keeps running - no downtime for the shop.
#   2. Copies the rest of pb_data alongside it (every uploaded file: ID
#      photos, product photos, quote photos) into the same staging copy.
#   3. Runs `restic backup` on that staging copy, tagged "ggvault".
#   4. Prunes old snapshots (keeps 30 daily, 12 monthly) and removes the
#      staging copy.
#
# One-time setup, before this script is ever run: the restic repository
# must exist first.
#   set -a; source deploy/.env; set +a; restic init
#
# Host cron (edit with `crontab -e`; use root's crontab if pb_data ends up
# owned by root, which is the default unless pb/Dockerfile sets a
# non-root user):
#   0 3 * * * /path/to/ggpos/deploy/backup.sh
#
# No output redirect is needed on that cron line: this script logs
# everything itself to deploy/logs/backup.log. If you also want cron to
# catch a catastrophic failure that happens before this script can log
# anything (for example, the file losing its execute bit), redirect to a
# SEPARATE file so the two logs don't overlap:
#   0 3 * * * /path/to/ggpos/deploy/backup.sh >> /path/to/ggpos/deploy/logs/backup.cron.log 2>&1

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
PB_DATA_DIR="$DEPLOY_DIR/data/pb_data"
LOG_DIR="$DEPLOY_DIR/logs"
LOG_FILE="$LOG_DIR/backup.log"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG_FILE"
}

fail() {
  log "FAILED: $1"
  exit 1
}

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ggvault-backup.XXXXXX")"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

log "=== ggvault backup starting ==="

[ -f "$ENV_FILE" ] || fail ".env not found at $ENV_FILE - copy .env.example and fill it in first"

# Load every setting in .env (RESTIC_REPOSITORY, RESTIC_PASSWORD, the
# AWS_* S3 credentials, and anything else) as real environment variables,
# the same way docker compose's env_file loads them for the containers.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[ -n "${RESTIC_REPOSITORY:-}" ] || fail "RESTIC_REPOSITORY is not set in $ENV_FILE"
[ -n "${RESTIC_PASSWORD:-}" ] || fail "RESTIC_PASSWORD is not set in $ENV_FILE"
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || fail "AWS_ACCESS_KEY_ID is not set in $ENV_FILE"
[ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || fail "AWS_SECRET_ACCESS_KEY is not set in $ENV_FILE"

[ -d "$PB_DATA_DIR" ] || fail "no pb_data directory at $PB_DATA_DIR - is the stack running?"
command -v restic >/dev/null 2>&1 || fail "restic is not installed - see deploy/README.md"
command -v rsync >/dev/null 2>&1 || fail "rsync is not installed - see deploy/README.md"

log "staging a consistent copy in $STAGING_DIR"
mkdir -p "$STAGING_DIR/pb_data"

# Copy everything except the live SQLite files first (uploaded files, and
# anything else PocketBase keeps under pb_data). The excludes are
# anchored to the top of pb_data (leading /) so a customer-uploaded file
# that happens to be named e.g. "receipt.db" inside storage/ is never
# mistaken for one of PocketBase's own database files.
rsync -a \
  --exclude '/*.db' \
  --exclude '/*.db-wal' \
  --exclude '/*.db-shm' \
  --exclude '/*.db-journal' \
  "$PB_DATA_DIR/" "$STAGING_DIR/pb_data/"

# Now the database(s) themselves. PocketBase runs SQLite in WAL mode, and
# this script never stops the container to take a backup, so a plain file
# copy of data.db could land mid-write. Prefer SQLite's own online-backup
# command, which is safe to run against a live database; only fall back
# to a raw copy if the sqlite3 CLI isn't available on this host.
shopt -s nullglob
db_files=("$PB_DATA_DIR"/*.db)
shopt -u nullglob

if [ ${#db_files[@]} -eq 0 ]; then
  log "NOTE: no *.db files found in $PB_DATA_DIR yet - is this the first run, before PocketBase has started once?"
fi

if command -v sqlite3 >/dev/null 2>&1; then
  for db in "${db_files[@]}"; do
    name="$(basename "$db")"
    log "sqlite3 .backup for $name"
    sqlite3 "$db" ".backup '$STAGING_DIR/pb_data/$name'"
  done
else
  log "NOTE: sqlite3 is not installed on this host. Falling back to a plain copy of each"
  log "NOTE: database file together with its -wal file, which is not guaranteed to be"
  log "NOTE: perfectly consistent if a write lands mid-copy. Install sqlite3"
  log "NOTE: (apt-get install -y sqlite3) so future runs use the proper online backup."
  for db in "${db_files[@]}"; do
    name="$(basename "$db")"
    cp -p "$db" "$STAGING_DIR/pb_data/$name"
    [ -f "$db-wal" ] && cp -p "$db-wal" "$STAGING_DIR/pb_data/$name-wal"
    [ -f "$db-shm" ] && cp -p "$db-shm" "$STAGING_DIR/pb_data/$name-shm"
  done
fi

log "running restic backup"
restic backup "$STAGING_DIR/pb_data" --tag ggvault >>"$LOG_FILE" 2>&1 \
  || fail "restic backup failed - see $LOG_FILE for restic's own error output"

log "pruning old snapshots (keep 30 daily, 12 monthly)"
restic forget --tag ggvault --keep-daily 30 --keep-monthly 12 --prune >>"$LOG_FILE" 2>&1 \
  || fail "restic forget/prune failed - see $LOG_FILE for restic's own error output"

log "=== ggvault backup finished OK ==="
