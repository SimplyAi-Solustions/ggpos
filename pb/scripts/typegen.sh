#!/usr/bin/env bash
# Generate TypeScript types for every collection into packages/shared/src/pb-types.ts.
# Reads the local SQLite database directly, so PocketBase does not need to be running.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="$DIR/pb/pb_data/data.db"
if [ ! -f "$DB" ]; then
  echo "No database at $DB. Run 'pnpm pb' once so migrations apply, then retry." >&2
  exit 1
fi
# --allow-build=better-sqlite3: pocketbase-typegen reads the SQLite file
# directly through better-sqlite3's native addon; pnpm 10 blocks install
# scripts by default, so without this flag the build is silently skipped
# and the CLI fails with "Could not locate the bindings file".
# --no-sdk: emit only the plain per-collection data interfaces, not a
# typed PocketBase-SDK wrapper. That wrapper's generated code imports the
# "pocketbase" npm package, which @gg/shared does not (and, per its brief,
# must not) depend on; consumers that already depend on "pocketbase"
# (such as apps/web) can combine it with these interfaces themselves.
pnpm dlx --allow-build=better-sqlite3 pocketbase-typegen@1 --no-sdk \
  --db "$DB" --out "$DIR/packages/shared/src/pb-types.ts"
echo "Types written to packages/shared/src/pb-types.ts"
