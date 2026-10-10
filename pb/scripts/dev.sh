#!/usr/bin/env bash
# Run PocketBase locally with the repo's hooks and migrations.
# Downloads the pinned binary into pb/ on first use (ignored by git).
set -euo pipefail
PB_VERSION="${PB_VERSION:-0.40.4}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$DIR/pocketbase"
if [ ! -x "$BIN" ]; then
  echo "Downloading PocketBase v$PB_VERSION..."
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  curl -sSL -o "$DIR/pocketbase.zip" "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${OS}_${ARCH}.zip"
  (cd "$DIR" && unzip -o -q pocketbase.zip pocketbase && rm -f pocketbase.zip)
  chmod +x "$BIN"
fi
exec "$BIN" serve --dev \
  --dir "$DIR/pb_data" \
  --hooksDir "$DIR/pb_hooks" \
  --migrationsDir "$DIR/pb_migrations" \
  --publicDir "$DIR/pb_public" \
  --http "127.0.0.1:${PB_PORT:-8091}" "$@"
