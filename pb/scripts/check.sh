#!/usr/bin/env bash
# End-to-end smoke test for the GG Vault PocketBase backend.
#
# Starts PocketBase on a throwaway data directory and a free port, using
# the real hooks and migrations from this repo; creates a superuser and
# waits for /api/health; then exercises the schema, the SKU/customer-code
# hooks, the custom /api/vault routes and the customer-facing API rules
# through plain HTTP calls, exactly as a real client would. Always tears
# the server and temp dir down again, even on failure.
#
# Exits non-zero on the first failure. Requires: the repo's pb/pocketbase
# binary (pb/scripts/dev.sh explains how to get one), curl, node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PB="$ROOT/pb/pocketbase"
HOOKS_DIR="$ROOT/pb/pb_hooks"
MIGRATIONS_DIR="$ROOT/pb/pb_migrations"
PUBLIC_DIR="$ROOT/pb/pb_public"
SKU_TS="$ROOT/packages/shared/src/sku.ts"

TMP_DIR="$(mktemp -d)"
PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
BASE="http://127.0.0.1:$PORT"

SUPER_EMAIL="check@local.test"
SUPER_PASSWORD="checkpassword123456"
STAFF_EMAIL="admin-check@local.test"
STAFF_PASSWORD="staffcheckpassword123"

SERVER_PID=""
PASS_COUNT=0

# --- small helpers ----------------------------------------------------

# Read JSON from stdin, print the value at a dot-separated path (numbers
# index arrays), or an empty string if any part of the path is missing.
jval() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      let v;
      try { v = JSON.parse(d || "{}"); } catch (e) { v = null; }
      for (const key of process.argv[1].split(".")) {
        if (v == null) break;
        v = v[key];
      }
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });
  ' "$1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

ok() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "OK: $1"
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "== pb/scripts/check.sh =="
echo "temp dir: $TMP_DIR"
echo "port:     $PORT"
echo

[ -x "$PB" ] || fail "pb/pocketbase not found or not executable - see pb/README.md ('Running locally')"

# -----------------------------------------------------------------------
# 1. Superuser, server, health
# -----------------------------------------------------------------------
"$PB" --dir "$TMP_DIR" superuser upsert "$SUPER_EMAIL" "$SUPER_PASSWORD" >/dev/null
ok "superuser created"

"$PB" serve \
  --dir "$TMP_DIR" \
  --hooksDir "$HOOKS_DIR" \
  --migrationsDir "$MIGRATIONS_DIR" \
  --publicDir "$PUBLIC_DIR" \
  --http "127.0.0.1:$PORT" \
  >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

echo "waiting for /api/health..."
healthy=""
for _ in $(seq 1 100); do
  if curl -s -o /dev/null "$BASE/api/health"; then
    healthy=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "--- server.log ---" >&2
    cat "$TMP_DIR/server.log" >&2
    fail "server exited before becoming healthy"
  fi
  sleep 0.2
done
[ -n "$healthy" ] || fail "/api/health never responded within 20s"

HEALTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
[ "$HEALTH_STATUS" = "200" ] || fail "/api/health returned $HEALTH_STATUS, expected 200"
ok "server healthy"

SUPER_TOKEN="$(curl -s -X POST "$BASE/api/collections/_superusers/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$SUPER_EMAIL\",\"password\":\"$SUPER_PASSWORD\"}" | jval token)"
[ -n "$SUPER_TOKEN" ] || fail "could not obtain a superuser token"
ok "superuser authenticated"

# -----------------------------------------------------------------------
# 2. Every collection from docs/PLAN.md's data model exists
# -----------------------------------------------------------------------
EXPECTED_COLLECTIONS=(
  # Auth
  staff customers customer_private id_documents
  # Catalogue
  games platforms card_sets cards price_snapshots retro_titles fx_rates
  # Stock
  items locations stock_counts stock_count_lines want_list
  # Trading
  trade_ins trade_in_lines quotes notes credit_ledger
  # Selling and cash
  sales sale_lines cash_sessions cash_movements counters
  # Loyalty (GG Guild)
  loyalty_programme loyalty_rules loyalty_tiers memberships loyalty_rewards
  reward_redemptions points_ledger perk_usage referrals
  # Ops and reporting
  pricing_rules label_templates label_jobs sumup_transactions csv_imports
  daily_stats saved_reports notifications push_subscriptions audit_log settings
)

ACTUAL_COLLECTIONS="$(curl -s "$BASE/api/collections?perPage=200" -H "Authorization: $SUPER_TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).items.map(i=>i.name).join("\n"));})')"

for name in "${EXPECTED_COLLECTIONS[@]}"; do
  echo "$ACTUAL_COLLECTIONS" | grep -qx "$name" || fail "collection missing: $name"
done
ok "all ${#EXPECTED_COLLECTIONS[@]} collections from the plan exist"

# -----------------------------------------------------------------------
# 3. Staff admin
# -----------------------------------------------------------------------
STAFF_CREATE_STATUS="$(curl -s -o "$TMP_DIR/staff.json" -w '%{http_code}' -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$STAFF_PASSWORD\",\"passwordConfirm\":\"$STAFF_PASSWORD\",\"name\":\"Check Admin\",\"role\":\"admin\",\"active\":true}")"
[ "$STAFF_CREATE_STATUS" = "200" ] || fail "could not create staff admin ($STAFF_CREATE_STATUS): $(cat "$TMP_DIR/staff.json")"
ok "staff admin created"

STAFF_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$STAFF_EMAIL\",\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
[ -n "$STAFF_TOKEN" ] || fail "could not obtain a staff token"
ok "staff admin authenticated"

# -----------------------------------------------------------------------
# 4. Item creation assigns a valid SKU
# -----------------------------------------------------------------------
GAME_ID="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$GAME_ID" ] || fail "seeded game 'pokemon' not found"

ITEM_JSON="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\"}")"
ITEM_SKU="$(echo "$ITEM_JSON" | jval sku)"
[ -n "$ITEM_SKU" ] || fail "item created without a sku: $ITEM_JSON"

echo "$ITEM_SKU" | grep -Eq '^GG[SGRPAX][0-9A-HJKMNP-TV-Z]{6}$' || fail "sku '$ITEM_SKU' does not match ^GG[SGRPAX][0-9A-HJKMNP-TV-Z]{6}\$"
ok "item sku '$ITEM_SKU' matches the expected shape"

node --experimental-strip-types -e "
const { parseCode } = require('$SKU_TS');
if (!parseCode('$ITEM_SKU')) { console.error('sku.ts rejected $ITEM_SKU'); process.exit(1); }
" || fail "sku '$ITEM_SKU' failed packages/shared/src/sku.ts's check-character rule"
ok "item sku '$ITEM_SKU' passes the sku.ts check-character rule"

# -----------------------------------------------------------------------
# 5. Customer creation assigns a code and a customer_private row
# -----------------------------------------------------------------------
CUSTOMER_JSON="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Check Customer","email":"check-customer@local.test","source":"counter"}')"
CUSTOMER_ID="$(echo "$CUSTOMER_JSON" | jval id)"
CUSTOMER_CODE="$(echo "$CUSTOMER_JSON" | jval code)"
[ -n "$CUSTOMER_ID" ] || fail "customer not created: $CUSTOMER_JSON"

echo "$CUSTOMER_CODE" | grep -Eq '^GGC[0-9A-HJKMNP-TV-Z]{6}$' || fail "customer code '$CUSTOMER_CODE' does not match the expected GGC shape"
ok "customer code '$CUSTOMER_CODE' matches the expected shape"

node --experimental-strip-types -e "
const { parseCode } = require('$SKU_TS');
if (!parseCode('$CUSTOMER_CODE')) { console.error('sku.ts rejected $CUSTOMER_CODE'); process.exit(1); }
" || fail "customer code '$CUSTOMER_CODE' failed sku.ts's check-character rule"
ok "customer code '$CUSTOMER_CODE' passes the sku.ts check-character rule"

CUSTOMER_PRIVATE_JSON="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN")"
CUSTOMER_PRIVATE_COUNT="$(echo "$CUSTOMER_PRIVATE_JSON" | jval totalItems)"
[ "$CUSTOMER_PRIVATE_COUNT" = "1" ] || fail "expected exactly one customer_private row for the new customer, got '$CUSTOMER_PRIVATE_COUNT'"
CUSTOMER_PRIVATE_ID="$(echo "$CUSTOMER_PRIVATE_JSON" | jval "items.0.id")"
ok "a customer_private row appeared for the new customer"

# -----------------------------------------------------------------------
# 6. Custom routes
# -----------------------------------------------------------------------
HEALTH_NOAUTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/health")"
[ "$HEALTH_NOAUTH_STATUS" = "401" ] || fail "/api/vault/health without auth returned $HEALTH_NOAUTH_STATUS, expected 401"
ok "/api/vault/health returns 401 without auth"

HEALTH_AUTH_STATUS="$(curl -s -o "$TMP_DIR/vault-health.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/health")"
[ "$HEALTH_AUTH_STATUS" = "200" ] || fail "/api/vault/health with a staff token returned $HEALTH_AUTH_STATUS: $(cat "$TMP_DIR/vault-health.json")"
ok "/api/vault/health returns 200 with a staff token"

# -----------------------------------------------------------------------
# 7. A customer token cannot read customer_private or audit_log
#
# customer_private carries a plain "staff only" rule, and PocketBase
# applies list/view rules as a query filter: a *list* call that matches
# no rows under that filter still returns 200 with zero items, while
# *viewing one specific record by id* is where a rule mismatch surfaces
# as 404 (the id "doesn't exist" from this auth's point of view). See
# pb/README.md. audit_log's rules are all null (superuser only), so any
# call at all - list or view - is rejected with 403 regardless.
# -----------------------------------------------------------------------
CUSTOMER_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$CUSTOMER_ID" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$CUSTOMER_TOKEN" ] || fail "could not impersonate the check customer"

CP_VIEW_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $CUSTOMER_TOKEN" "$BASE/api/collections/customer_private/records/$CUSTOMER_PRIVATE_ID")"
[ "$CP_VIEW_STATUS" = "403" ] || [ "$CP_VIEW_STATUS" = "404" ] || fail "customer viewing their own customer_private row returned $CP_VIEW_STATUS, expected 403 or 404"
ok "customer token cannot view customer_private (got $CP_VIEW_STATUS)"

AUDIT_LIST_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $CUSTOMER_TOKEN" "$BASE/api/collections/audit_log/records")"
[ "$AUDIT_LIST_STATUS" = "403" ] || [ "$AUDIT_LIST_STATUS" = "404" ] || fail "customer listing audit_log returned $AUDIT_LIST_STATUS, expected 403 or 404"
ok "customer token cannot list audit_log (got $AUDIT_LIST_STATUS)"

# -----------------------------------------------------------------------
# 8. Customer self-update guards and portal reads
# -----------------------------------------------------------------------
CU_CODE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"GGCAAAAAA"}' "$BASE/api/collections/customers/records/$CUSTOMER_ID")"
[ "$CU_CODE_STATUS" != "200" ] || fail "a customer was able to change their own code"
ok "customer cannot change their own code (got $CU_CODE_STATUS)"

CU_CONSENT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"marketing_consent":true}' "$BASE/api/collections/customers/records/$CUSTOMER_ID")"
[ "$CU_CONSENT_STATUS" = "200" ] || fail "customer updating marketing_consent returned $CU_CONSENT_STATUS, expected 200"
ok "customer can update their own marketing consent"

QUOTE_JSON="$(curl -s -X POST "$BASE/api/collections/quotes/records" \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$CUSTOMER_ID\",\"status\":\"submitted\",\"message\":\"Loft box of cards\"}")"
QUOTE_ID="$(echo "$QUOTE_JSON" | jval id)"
[ -n "$QUOTE_ID" ] || fail "customer could not create a quote: $QUOTE_JSON"
QUOTE_OFFER_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"offer_total":999999}' "$BASE/api/collections/quotes/records/$QUOTE_ID")"
[ "$QUOTE_OFFER_STATUS" != "200" ] || fail "a customer was able to set offer_total on their quote"
ok "customer cannot set the offer on their own quote (got $QUOTE_OFFER_STATUS)"
QUOTE_REPLY_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_reply":"Can I drop it in Saturday?"}' "$BASE/api/collections/quotes/records/$QUOTE_ID")"
[ "$QUOTE_REPLY_STATUS" = "200" ] || fail "customer replying on their quote returned $QUOTE_REPLY_STATUS, expected 200"
ok "customer can reply on their own quote"

# List rules act as a filter: a signed-in customer sees the seeded tiers,
# an anonymous caller gets 200 with no rows at all.
TIERS_COUNT="$(curl -s -H "Authorization: $CUSTOMER_TOKEN" "$BASE/api/collections/loyalty_tiers/records" | jval totalItems)"
[ "${TIERS_COUNT:-0}" -ge 1 ] || fail "customer listing loyalty_tiers saw '$TIERS_COUNT' rows, expected the seeded tiers"
ok "customer can read the loyalty tiers ($TIERS_COUNT rows)"
TIERS_ANON_COUNT="$(curl -s "$BASE/api/collections/loyalty_tiers/records" | jval totalItems)"
[ "${TIERS_ANON_COUNT:-0}" = "0" ] || fail "loyalty_tiers is readable without signing in ($TIERS_ANON_COUNT rows)"
ok "loyalty tiers are hidden from anonymous callers"

echo
echo "All checks passed ($PASS_COUNT)."
