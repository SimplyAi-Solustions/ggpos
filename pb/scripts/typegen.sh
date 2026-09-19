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
pnpm dlx pocketbase-typegen@1 --db "$DB" --out "$DIR/packages/shared/src/pb-types.ts"
echo "Types written to packages/shared/src/pb-types.ts"
