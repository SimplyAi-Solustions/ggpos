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

# $security.encrypt is AES-256-GCM and wants exactly 32 characters. The ID
# check route refuses with 500 without this, so the server under test gets
# a throwaway one (see pb/README.md, "ID photos").
ID_PHOTO_KEY="check-id-photo-key-0123456789abc"

SERVER_PID=""
PASS_COUNT=0

# A second, short-lived server started with no GG_ID_PHOTO_KEY (section 15q).
KEYLESS_PID=""
KEYLESS_DIR=""

# A third, short-lived server sharing this run's data directory, whose only
# hook backdates a points_ledger row's `created` (section 24).
BACKDATE_PID=""

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

# Read JSON from stdin, print the length of the array at a dot-separated
# path (or of the top-level value itself when the path is ""), or 0 when
# that value is missing or not an array. Complements jval, which cannot
# usefully stringify an array of objects.
jlen() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      let v;
      try { v = JSON.parse(d || "{}"); } catch (e) { v = null; }
      const path = process.argv[1] || "";
      if (path) {
        for (const key of path.split(".")) {
          if (v == null) break;
          v = v[key];
        }
      }
      process.stdout.write(String(Array.isArray(v) ? v.length : 0));
    });
  ' "$1"
}

# True when a curl %{time_total} reading is under `limit` seconds.
under_seconds() {
  awk -v t="$1" -v limit="$2" 'BEGIN { exit !(t + 0 < limit + 0) }'
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$KEYLESS_PID" ] && kill -0 "$KEYLESS_PID" 2>/dev/null; then
    kill "$KEYLESS_PID" 2>/dev/null || true
    wait "$KEYLESS_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKDATE_PID" ] && kill -0 "$BACKDATE_PID" 2>/dev/null; then
    kill "$BACKDATE_PID" 2>/dev/null || true
    wait "$BACKDATE_PID" 2>/dev/null || true
  fi
  if [ -n "$KEYLESS_DIR" ]; then
    rm -rf "$KEYLESS_DIR"
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

GG_ID_PHOTO_KEY="$ID_PHOTO_KEY" GG_ADAPTER_TRANSPORT_MODE="fixture" "$PB" serve \
  --dir "$TMP_DIR" \
  --hooksDir "$HOOKS_DIR" \
  --hooksWatch=false \
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
  # Phase 3 adapters
  adapter_state
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

# adapter_state holds OAuth tokens and sync stamps - every rule null
# (superuser only), the same reasoning that keeps id_documents and
# audit_log off the regular API entirely (1789819920_phase3_adapter_state.js).
ADAPTER_STATE_SCHEMA="$(curl -s "$BASE/api/collections/adapter_state" -H "Authorization: $SUPER_TOKEN")"
for rule in listRule viewRule createRule updateRule deleteRule; do
  [ "$(echo "$ADAPTER_STATE_SCHEMA" | jval "$rule")" = "" ] \
    || fail "adapter_state.$rule is '$(echo "$ADAPTER_STATE_SCHEMA" | jval "$rule")', expected null (superuser only)"
done
ok "adapter_state is superuser-only: every rule is null"

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

# quotes.createRule is staff-only (a customer's own token could otherwise
# forge a row with any status, lines and offer_total it liked, which
# received/complete would then pay out as if staff had priced it) -
# customers submit only through POST /api/vault/quotes (Phase 5's own
# multipart route, exercised in section 23). PocketBase's own record-create
# endpoint answers a failed createRule with a plain 400 "Failed to create
# record.", not the 403/404 a failed list/view rule gives (confirmed
# directly against this binary) - so 400 is what this asserts, not 403.
QUOTE_CUSTOMER_CREATE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/quotes/records" \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$CUSTOMER_ID\",\"status\":\"accepted\",\"offer_total\":999999,\"message\":\"Loft box of cards\"}")"
[ "$QUOTE_CUSTOMER_CREATE_STATUS" = "400" ] || fail "a customer token creating a quotes row directly returned $QUOTE_CUSTOMER_CREATE_STATUS, expected 400 (a forged accepted status with a priced total must be refused outright)"
ok "a customer token cannot create a quotes row directly (400; quotes.createRule is staff-only)"

QUOTE_JSON="$(curl -s -X POST "$BASE/api/collections/quotes/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$CUSTOMER_ID\",\"status\":\"submitted\",\"message\":\"Loft box of cards\"}")"
QUOTE_ID="$(echo "$QUOTE_JSON" | jval id)"
[ -n "$QUOTE_ID" ] || fail "staff could not create a quote: $QUOTE_JSON"
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

# A customer may accept or decline their own quote, but never jump it
# straight to any other status in the timeline (that stays staff-driven).
QUOTE_COMPLETE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"completed"}' "$BASE/api/collections/quotes/records/$QUOTE_ID")"
[ "$QUOTE_COMPLETE_STATUS" != "200" ] || fail "a customer was able to set their quote's status to completed"
ok "customer cannot set their quote's status to completed (got $QUOTE_COMPLETE_STATUS)"
QUOTE_ACCEPT_JSON="$(curl -s -w '\n%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"accepted"}' "$BASE/api/collections/quotes/records/$QUOTE_ID")"
QUOTE_ACCEPT_STATUS="$(echo "$QUOTE_ACCEPT_JSON" | tail -n1)"
[ "$QUOTE_ACCEPT_STATUS" = "200" ] || fail "customer accepting their own quote returned $QUOTE_ACCEPT_STATUS, expected 200: $(echo "$QUOTE_ACCEPT_JSON" | head -n -1)"
ok "customer can set their quote's status to accepted"

# List rules act as a filter: a signed-in customer sees the seeded tiers,
# an anonymous caller gets 200 with no rows at all.
TIERS_COUNT="$(curl -s -H "Authorization: $CUSTOMER_TOKEN" "$BASE/api/collections/loyalty_tiers/records" | jval totalItems)"
[ "${TIERS_COUNT:-0}" -ge 1 ] || fail "customer listing loyalty_tiers saw '$TIERS_COUNT' rows, expected the seeded tiers"
ok "customer can read the loyalty tiers ($TIERS_COUNT rows)"
TIERS_ANON_COUNT="$(curl -s "$BASE/api/collections/loyalty_tiers/records" | jval totalItems)"
[ "${TIERS_ANON_COUNT:-0}" = "0" ] || fail "loyalty_tiers is readable without signing in ($TIERS_ANON_COUNT rows)"
ok "loyalty tiers are hidden from anonymous callers"

# -----------------------------------------------------------------------
# 9. The seeded pricing_rules, settings and loyalty_tiers rows actually
#    work through the shared evaluators once loaded back from the API:
#    band edges, "" wildcards and the settings/tier JSON shapes. Runs the
#    real generated pb_hooks/lib/shared/{pricing,loyalty}.js, not a
#    hand-copied re-implementation, so it catches drift between the seed
#    and packages/shared/src/{pricing,loyalty}.ts - see
#    pb/scripts/check-pricing-loyalty.js.
# -----------------------------------------------------------------------
curl -s "$BASE/api/collections/pricing_rules/records?perPage=200" -H "Authorization: $STAFF_TOKEN" \
  >"$TMP_DIR/pricing_rules.json"
curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $STAFF_TOKEN" \
  >"$TMP_DIR/settings.json"
curl -s "$BASE/api/collections/loyalty_tiers/records?perPage=200" -H "Authorization: $STAFF_TOKEN" \
  >"$TMP_DIR/loyalty_tiers.json"

PRICING_LOYALTY_OUTPUT="$(node "$ROOT/pb/scripts/check-pricing-loyalty.js" "$TMP_DIR" 2>&1)" \
  || fail "$PRICING_LOYALTY_OUTPUT"
ok "seeded pricing_rules, settings and loyalty_tiers evaluate correctly through pb_hooks/lib/shared/{pricing,loyalty}.js"

# -----------------------------------------------------------------------
# 10. SKU bodies are drawn uniformly from the alphabet, not from the old
#     "one random alphabet character's char code, masked with & 31"
#     construct, which could never produce nine of the alphabet's thirty-
#     two symbols (0 9 C F V W X Y Z) and produced nine others twice as
#     often. 40 bodies of 5 characters is 200 draws; the chance a uniform
#     draw never lands on any of those nine symbols is negligible, so
#     seeing one confirms the biased construct is gone.
# -----------------------------------------------------------------------
FOUND_RARE_SYMBOL=""
for _ in $(seq 1 40); do
  RARE_SKU_JSON="$(curl -s -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\"}")"
  RARE_SKU="$(echo "$RARE_SKU_JSON" | jval sku)"
  [ -n "$RARE_SKU" ] || fail "item created without a sku while sampling for uniformity: $RARE_SKU_JSON"
  # The body is the 5 characters between the kind letter (index 2) and the
  # trailing check character, e.g. GGS7F3K2Q -> 7F3K2.
  RARE_BODY="${RARE_SKU:3:5}"
  if echo "$RARE_BODY" | grep -qE '[09CFVWXYZ]'; then
    FOUND_RARE_SYMBOL=1
    break
  fi
done
[ -n "$FOUND_RARE_SYMBOL" ] || fail "generated 40 item SKUs and none of their bodies contained 0, 9, C, F, V, W, X, Y or Z - looks like the biased legacy random construct is back"
ok "SKU bodies are drawn uniformly (found a 0/9/C/F/V/W/X/Y/Z among 40 samples)"

# -----------------------------------------------------------------------
# 11. audit_log never stores a changed field's VALUE, only its name, and
#     never a value from settings.
# -----------------------------------------------------------------------
SETTINGS_ID="$(curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$SETTINGS_ID" ] || fail "could not find the seeded settings row"

SECRET_API_KEY="check-fake-api-key-$$"
SETTINGS_UPDATE_STATUS="$(curl -s -o "$TMP_DIR/settings-update.json" -w '%{http_code}' -X PATCH \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email_api_key\":\"$SECRET_API_KEY\"}" "$BASE/api/collections/settings/records/$SETTINGS_ID")"
[ "$SETTINGS_UPDATE_STATUS" = "200" ] || fail "could not update settings.email_api_key ($SETTINGS_UPDATE_STATUS): $(cat "$TMP_DIR/settings-update.json")"

AUDIT_LOG_JSON="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200" -H "Authorization: $SUPER_TOKEN")"
if echo "$AUDIT_LOG_JSON" | grep -qF "$SECRET_API_KEY"; then
  fail "audit_log recorded the updated email_api_key value - meta must only ever hold field names, never values"
fi
ok "updating settings.email_api_key leaves no trace of its value in audit_log"

AUDIT_SETTINGS_META="$(echo "$AUDIT_LOG_JSON" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  const items = JSON.parse(d || "{}").items || [];
  const row = [...items].reverse().find((r) => r.collection === "settings");
  process.stdout.write(row ? JSON.stringify(row.meta) : "");
});
')"
echo "$AUDIT_SETTINGS_META" | grep -q "email_api_key" \
  || fail "expected an audit_log row for the settings update naming the changed field email_api_key, got: $AUDIT_SETTINGS_META"
ok "audit_log records the changed field name (email_api_key), not its value"

# -----------------------------------------------------------------------
# 12. An inactive staff account cannot authenticate
# -----------------------------------------------------------------------
INACTIVE_EMAIL="inactive-check@local.test"
INACTIVE_PASSWORD="inactivecheckpassword123"
INACTIVE_CREATE_STATUS="$(curl -s -o "$TMP_DIR/inactive-staff.json" -w '%{http_code}' -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$INACTIVE_EMAIL\",\"password\":\"$INACTIVE_PASSWORD\",\"passwordConfirm\":\"$INACTIVE_PASSWORD\",\"name\":\"Inactive Check\",\"role\":\"staff\",\"active\":false}")"
[ "$INACTIVE_CREATE_STATUS" = "200" ] || fail "could not create an inactive staff record ($INACTIVE_CREATE_STATUS): $(cat "$TMP_DIR/inactive-staff.json")"
ok "inactive staff record created"

INACTIVE_AUTH_STATUS="$(curl -s -o "$TMP_DIR/inactive-auth.json" -w '%{http_code}' -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$INACTIVE_EMAIL\",\"password\":\"$INACTIVE_PASSWORD\"}")"
case "$INACTIVE_AUTH_STATUS" in
  4*) ok "inactive staff account cannot authenticate (got $INACTIVE_AUTH_STATUS)" ;;
  *) fail "inactive staff account authenticated with status $INACTIVE_AUTH_STATUS, expected 4xx: $(cat "$TMP_DIR/inactive-auth.json")" ;;
esac

# -----------------------------------------------------------------------
# 13. A customer may mark their own notification read, but not rewrite it
# -----------------------------------------------------------------------
NOTIFICATION_JSON="$(curl -s -X POST "$BASE/api/collections/notifications/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$CUSTOMER_ID\",\"type\":\"quote_offer\",\"title\":\"Your quote is ready\",\"body\":\"Check the app for the offer.\"}")"
NOTIFICATION_ID="$(echo "$NOTIFICATION_JSON" | jval id)"
[ -n "$NOTIFICATION_ID" ] || fail "could not create a notification for the check customer: $NOTIFICATION_JSON"

NOTIFICATION_TITLE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Hijacked title"}' "$BASE/api/collections/notifications/records/$NOTIFICATION_ID")"
[ "$NOTIFICATION_TITLE_STATUS" != "200" ] || fail "a customer was able to change their own notification's title"
ok "customer cannot change their own notification's title (got $NOTIFICATION_TITLE_STATUS)"

NOTIFICATION_READ_JSON="$(curl -s -w '\n%{http_code}' -X PATCH \
  -H "Authorization: $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"read_at":"2026-09-20T12:00:00Z"}' "$BASE/api/collections/notifications/records/$NOTIFICATION_ID")"
NOTIFICATION_READ_STATUS="$(echo "$NOTIFICATION_READ_JSON" | tail -n1)"
[ "$NOTIFICATION_READ_STATUS" = "200" ] || fail "customer marking their own notification read returned $NOTIFICATION_READ_STATUS, expected 200: $(echo "$NOTIFICATION_READ_JSON" | head -n -1)"
ok "customer can mark their own notification read"

# -----------------------------------------------------------------------
# 14. Phase 2 round trip through the custom /api/vault routes: a cash
#     session, an ID check, a mixed cash/credit buy-in, a sale paid with
#     store credit, a stepped-up refund, the ID photo, the stock book and
#     the receipt. Everything below runs against the real routes over HTTP,
#     exactly as the counter app will.
# -----------------------------------------------------------------------

# --- 14a. Cash session -------------------------------------------------
SESSION_JSON="$(curl -s -X POST "$BASE/api/vault/cash-sessions/open" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"float":10000}')"
SESSION_ID="$(echo "$SESSION_JSON" | jval "session.id")"
[ -n "$SESSION_ID" ] || fail "could not open a cash session: $SESSION_JSON"
ok "cash session opened with a 10000p float"

SECOND_SESSION_STATUS="$(curl -s -o "$TMP_DIR/second-session.json" -w '%{http_code}' -X POST "$BASE/api/vault/cash-sessions/open" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"float":5000}')"
[ "$SECOND_SESSION_STATUS" = "409" ] || fail "opening a second cash session returned $SECOND_SESSION_STATUS, expected 409: $(cat "$TMP_DIR/second-session.json")"
ok "a second open cash session is refused with 409"

CURRENT_EXPECTED="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected)"
[ "$CURRENT_EXPECTED" = "10000" ] || fail "cash-sessions/current expected '$CURRENT_EXPECTED', wanted 10000"
ok "cash-sessions/current reports the float as the expected total"

# --- 14b. A seller and a draft buy-in ----------------------------------
SELLER_JSON="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Seller Check","email":"seller-check@local.test","source":"counter"}')"
SELLER_ID="$(echo "$SELLER_JSON" | jval id)"
[ -n "$SELLER_ID" ] || fail "could not create the seller customer: $SELLER_JSON"
SELLER_PRIVATE_ID="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$SELLER_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$SELLER_PRIVATE_ID" ] || fail "no customer_private row for the seller"
ok "seller customer created"

TRADE_JSON="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$SELLER_ID\",\"status\":\"draft\",\"channel\":\"counter\"}")"
TRADE_ID="$(echo "$TRADE_JSON" | jval id)"
[ -n "$TRADE_ID" ] || fail "could not create a draft trade-in (is trade_ins.number still required?): $TRADE_JSON"
ok "draft trade-in created without a number"

# Two accepted lines: two singles at 2500p each, three sealed at 500p each.
# Accepted total 2 x 2500 + 3 x 500 = 6500p.
LINE1_JSON="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$TRADE_ID\",\"kind\":\"single\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Charizard ex #199\",\"condition\":\"NM\",\"qty\":2,\"market_price\":4000,\"market_currency\":\"GBP\",\"offer_price\":2500,\"accepted\":true}")"
LINE1_ID="$(echo "$LINE1_JSON" | jval id)"
[ -n "$LINE1_ID" ] || fail "could not create trade-in line 1: $LINE1_JSON"
LINE2_JSON="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$TRADE_ID\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"151 Booster Bundle\",\"qty\":3,\"market_price\":800,\"market_currency\":\"GBP\",\"offer_price\":500,\"accepted\":true}")"
[ -n "$(echo "$LINE2_JSON" | jval id)" ] || fail "could not create trade-in line 2: $LINE2_JSON"
ok "two accepted trade-in lines created"

# --- 14c. The ID gate refuses a cash payout ----------------------------
NO_ID_STATUS="$(curl -s -o "$TMP_DIR/no-id.json" -w '%{http_code}' -X POST "$BASE/api/vault/trade-ins/$TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"mixed\",\"payout_cash\":4000,\"payout_credit\":2500,\"terms_accepted\":true,\"cash_session\":\"$SESSION_ID\"}")"
[ "$NO_ID_STATUS" = "422" ] || fail "completing a cash buy-in with no ID check returned $NO_ID_STATUS, expected 422: $(cat "$TMP_DIR/no-id.json")"
ok "a cash buy-in without an ID check is refused with 422"

# --- 14d. ID check: multipart in, ciphertext on disk --------------------
node -e '
  require("fs").writeFileSync(
    process.argv[1],
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
' "$TMP_DIR/id.png"
[ -s "$TMP_DIR/id.png" ] || fail "could not write the test PNG"

ID_CHECK_JSON="$(curl -s -X POST "$BASE/api/vault/customers/$SELLER_ID/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/id.png;type=image/png" \
  -F "id_type=passport" \
  -F "id_expiry=2030-06-30" \
  -F "id_ref_last4=1234" \
  -F "dob=1990-01-31" \
  -F "address=1 High Street, Bolsover, S44 6AA")"
ID_DOC_ID="$(echo "$ID_CHECK_JSON" | jval id_document)"
[ -n "$ID_DOC_ID" ] || fail "the id-check route did not return an id_document: $ID_CHECK_JSON"
[ "$(echo "$ID_CHECK_JSON" | jval id_status)" = "verified" ] || fail "id-check did not report verified: $ID_CHECK_JSON"
ok "ID check accepted and returned an id_documents row"

SELLER_ID_STATUS="$(curl -s "$BASE/api/collections/customer_private/records/$SELLER_PRIVATE_ID" \
  -H "Authorization: $STAFF_TOKEN" | jval id_status)"
[ "$SELLER_ID_STATUS" = "verified" ] || fail "customer_private.id_status is '$SELLER_ID_STATUS', expected verified"
ok "customer_private.id_status is verified after the ID check"

STORED_PHOTO="$(find "$TMP_DIR/storage" -name '*.enc' -type f 2>/dev/null | head -n1)"
[ -n "$STORED_PHOTO" ] || fail "no .enc file was written for the ID photo"
node -e '
  const b = require("fs").readFileSync(process.argv[1]);
  // A PNG starts 89 50 4E 47. If the stored bytes do, the photo went in
  // unencrypted, which is the one thing this check exists to catch.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    console.error("the stored ID photo is a readable PNG - it was not encrypted");
    process.exit(1);
  }
' "$STORED_PHOTO" || fail "the stored ID photo is not encrypted"
ok "the stored ID photo is ciphertext, not a readable PNG"

# --- 14e. Complete the buy-in, cash and credit --------------------------
COMPLETE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/trade-ins/$TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"mixed\",\"payout_cash\":4000,\"payout_credit\":2500,\"terms_accepted\":true,\"cash_session\":\"$SESSION_ID\",\"signature\":\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==\"}")"
COMPLETE_STATUS="$(echo "$COMPLETE_JSON" | tail -n1)"
COMPLETE_BODY="$(echo "$COMPLETE_JSON" | head -n -1)"
[ "$COMPLETE_STATUS" = "200" ] || fail "completing the trade-in returned $COMPLETE_STATUS: $COMPLETE_BODY"
echo "$COMPLETE_BODY" >"$TMP_DIR/complete.json"

TRADE_NUMBER="$(jval "trade_in.number" <"$TMP_DIR/complete.json")"
[ "$TRADE_NUMBER" = "GG-BI-000001" ] || fail "trade-in number is '$TRADE_NUMBER', expected GG-BI-000001"
ok "trade-in completed as $TRADE_NUMBER"

# Two singles (one row per unit) plus one sealed stock line = three items.
ITEM_COUNT="$(node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(String((JSON.parse(d).items || []).length)));
' <"$TMP_DIR/complete.json")"
[ "$ITEM_COUNT" = "3" ] || fail "the buy-in created $ITEM_COUNT items, expected 3 (2 singles + 1 sealed line)"
ok "the buy-in created three items"

SOLD_ITEM_ID="$(jval "items.0.id" <"$TMP_DIR/complete.json")"
ITEM_SKU_1="$(jval "items.0.sku" <"$TMP_DIR/complete.json")"
echo "$ITEM_SKU_1" | grep -Eq '^GG[SGRPAX][0-9A-HJKMNP-TV-Z]{6}$' || fail "buy-in item sku '$ITEM_SKU_1' does not match the expected shape"
ITEM_STATUS="$(curl -s "$BASE/api/collections/items/records/$SOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)"
[ "$ITEM_STATUS" = "in_stock" ] || fail "buy-in item status is '$ITEM_STATUS', expected in_stock"
ok "buy-in items carry SKUs and are in_stock"

LABELS_QUEUED="$(jval labels_queued <"$TMP_DIR/complete.json")"
[ "$LABELS_QUEUED" = "3" ] || fail "labels_queued is '$LABELS_QUEUED', expected 3"
LABEL_JOB_COUNT="$(curl -s "$BASE/api/collections/label_jobs/records?perPage=50&filter=status%3D%22queued%22" \
  -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$LABEL_JOB_COUNT" = "3" ] || fail "found $LABEL_JOB_COUNT queued label jobs, expected 3"
ok "three label jobs are queued, one per item"

CREDIT_BALANCE="$(jval credit_balance <"$TMP_DIR/complete.json")"
[ "$CREDIT_BALANCE" = "2500" ] || fail "credit_balance after the buy-in is '$CREDIT_BALANCE', expected 2500"
CREDIT_ROW_AMOUNT="$(curl -s "$BASE/api/collections/credit_ledger/records?filter=customer%3D%22$SELLER_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.amount")"
[ "$CREDIT_ROW_AMOUNT" = "2500" ] || fail "the credit_ledger row is '$CREDIT_ROW_AMOUNT', expected 2500"
CACHED_CREDIT="$(curl -s "$BASE/api/collections/customer_private/records/$SELLER_PRIVATE_ID" \
  -H "Authorization: $STAFF_TOKEN" | jval credit_balance)"
[ "$CACHED_CREDIT" = "2500" ] || fail "customer_private.credit_balance is '$CACHED_CREDIT', expected 2500"
ok "store credit ledger row written and the cached balance recomputed"

CASH_EXPECTED="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected)"
[ "$CASH_EXPECTED" = "6000" ] || fail "expected cash after a 4000p payout is '$CASH_EXPECTED', wanted 6000"
ok "the cash payout moved the drawer to 6000p"

BUYIN_POINTS="$(jval points_earned <"$TMP_DIR/complete.json")"
[ "$BUYIN_POINTS" = "125" ] || fail "points earned on 2500p of credit is '$BUYIN_POINTS', expected 125"
ok "points earned on the credit portion ($BUYIN_POINTS)"

# --- 14f. The cash cap ---------------------------------------------------
BIG_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$SELLER_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$BIG_TRADE_ID\",\"kind\":\"single\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Collection\",\"condition\":\"NM\",\"qty\":1,\"market_price\":1200000,\"market_currency\":\"GBP\",\"offer_price\":900000,\"accepted\":true}"
CAP_STATUS="$(curl -s -o "$TMP_DIR/cap.json" -w '%{http_code}' -X POST "$BASE/api/vault/trade-ins/$BIG_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":900000,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION_ID\"}")"
[ "$CAP_STATUS" = "422" ] || fail "a cash payout over settings.cash_cap returned $CAP_STATUS, expected 422: $(cat "$TMP_DIR/cap.json")"
grep -q "capped" "$TMP_DIR/cap.json" || fail "the cash cap refusal does not mention the cap: $(cat "$TMP_DIR/cap.json")"
ok "a cash payout over settings.cash_cap is refused with 422"

# --- 14g. Sell one of those items for store credit ----------------------
SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SOLD_ITEM_ID\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$SELLER_ID\",\"payment\":\"store_credit\"}")"
SALE_STATUS="$(echo "$SALE_JSON" | tail -n1)"
echo "$SALE_JSON" | head -n -1 >"$TMP_DIR/sale.json"
[ "$SALE_STATUS" = "200" ] || fail "completing the sale returned $SALE_STATUS: $(cat "$TMP_DIR/sale.json")"

SALE_ID="$(jval "sale.id" <"$TMP_DIR/sale.json")"
SALE_NUMBER="$(jval "sale.number" <"$TMP_DIR/sale.json")"
[ "$SALE_NUMBER" = "GG-S-000001" ] || fail "sale number is '$SALE_NUMBER', expected GG-S-000001"
ok "sale completed as $SALE_NUMBER"

SOLD_STATUS="$(curl -s "$BASE/api/collections/items/records/$SOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)"
[ "$SOLD_STATUS" = "sold" ] || fail "the sold item's status is '$SOLD_STATUS', expected sold"
ok "the sold item is marked sold"

SALE_CREDIT="$(jval credit_balance <"$TMP_DIR/sale.json")"
[ "$SALE_CREDIT" = "500" ] || fail "credit after a 2000p store-credit sale is '$SALE_CREDIT', expected 500"
ok "store credit was debited by the sale"

SALE_POINTS="$(jval points_earned <"$TMP_DIR/sale.json")"
[ "$SALE_POINTS" = "200" ] || fail "points earned on a 2000p sale is '$SALE_POINTS', expected 200"
SALE_POINTS_BALANCE="$(jval points_balance <"$TMP_DIR/sale.json")"
# 100 welcome (Phase 6, written when the seller record was created) + 125 on
# the buy-in credit + 200 on this sale.
[ "$SALE_POINTS_BALANCE" = "425" ] || fail "points balance after the sale is '$SALE_POINTS_BALANCE', expected 425"
ok "points earned on the sale and added to the balance"

# --- 14h. Step-up, then refund ------------------------------------------
REFUND_NO_STEPUP="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/sales/$SALE_ID/refund" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"lines":[],"reason":"test","refund_method":"store_credit"}')"
[ "$REFUND_NO_STEPUP" = "403" ] || fail "refunding without a step-up token returned $REFUND_NO_STEPUP, expected 403"
ok "a refund without a step-up token is refused with 403"

STEPUP_JSON="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$STAFF_PASSWORD\"}")"
STEPUP_TOKEN="$(echo "$STEPUP_JSON" | jval token)"
[ -n "$STEPUP_TOKEN" ] || fail "the step-up route returned no token: $STEPUP_JSON"
STEPUP_BAD="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"password":"not-the-password"}')"
[ "$STEPUP_BAD" = "400" ] || fail "a wrong step-up password returned $STEPUP_BAD, expected 400"
ok "step-up issues a token for the right password and refuses the wrong one"

SALE_LINE_ID="$(curl -s "$BASE/api/collections/sale_lines/records?filter=sale%3D%22$SALE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$SALE_LINE_ID" ] || fail "could not find the sale line to refund"

REFUND_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/$SALE_ID/refund" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"sale_line\":\"$SALE_LINE_ID\",\"qty\":1}],\"reason\":\"Customer changed their mind\",\"refund_method\":\"store_credit\"}")"
REFUND_STATUS="$(echo "$REFUND_JSON" | tail -n1)"
echo "$REFUND_JSON" | head -n -1 >"$TMP_DIR/refund.json"
[ "$REFUND_STATUS" = "200" ] || fail "the refund returned $REFUND_STATUS: $(cat "$TMP_DIR/refund.json")"

[ "$(jval refunded <"$TMP_DIR/refund.json")" = "2000" ] || fail "refunded '$(jval refunded <"$TMP_DIR/refund.json")', expected 2000"
[ "$(jval "sale.status" <"$TMP_DIR/refund.json")" = "refunded" ] || fail "sale status after a full refund is '$(jval "sale.status" <"$TMP_DIR/refund.json")', expected refunded"
REFUND_ITEM_STATUS="$(curl -s "$BASE/api/collections/items/records/$SOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)"
[ "$REFUND_ITEM_STATUS" = "in_stock" ] || fail "the refunded item's status is '$REFUND_ITEM_STATUS', expected in_stock"
[ "$(jval credit_balance <"$TMP_DIR/refund.json")" = "2500" ] || fail "credit after the refund is '$(jval credit_balance <"$TMP_DIR/refund.json")', expected 2500"
# 425 less the 200 the refunded sale earned; the 100 welcome bonus stays.
[ "$(jval points_balance <"$TMP_DIR/refund.json")" = "225" ] || fail "points after the refund is '$(jval points_balance <"$TMP_DIR/refund.json")', expected 225"
ok "the refund put the item back in stock and reversed both balances"

# --- 14i. The ID photo, admin plus step-up only -------------------------
PHOTO_NO_STEPUP="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/id-photo/$ID_DOC_ID")"
[ "$PHOTO_NO_STEPUP" = "403" ] || fail "the ID photo without a step-up token returned $PHOTO_NO_STEPUP, expected 403"
ok "the ID photo is refused without a step-up token (403)"

PHOTO_STATUS="$(curl -s -D "$TMP_DIR/idphoto.headers" -o "$TMP_DIR/idphoto.bin" -w '%{http_code}' \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" "$BASE/api/vault/id-photo/$ID_DOC_ID")"
[ "$PHOTO_STATUS" = "200" ] || fail "the ID photo with a step-up token returned $PHOTO_STATUS"
grep -qi '^cache-control: *no-store' "$TMP_DIR/idphoto.headers" || fail "the ID photo response has no 'Cache-Control: no-store' header: $(cat "$TMP_DIR/idphoto.headers")"
grep -qi '^content-disposition: *inline' "$TMP_DIR/idphoto.headers" || fail "the ID photo response has no 'Content-Disposition: inline' header"
grep -qi '^content-type: *image/png' "$TMP_DIR/idphoto.headers" || fail "the ID photo is not served as image/png (is id_documents.mime being stored?): $(grep -i content-type "$TMP_DIR/idphoto.headers")"
cmp -s "$TMP_DIR/id.png" "$TMP_DIR/idphoto.bin" || fail "the decrypted ID photo does not match the PNG that was uploaded"
ok "an admin with a step-up token gets the decrypted PNG back, no-store and inline"

AUDIT_PHOTO_VIEW="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22id_photo_view%22" \
  -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${AUDIT_PHOTO_VIEW:-0}" -ge 1 ] || fail "viewing the ID photo wrote no audit_log row"
ok "viewing the ID photo is audited"

# --- 14j. Close the session and check the variance -----------------------
CLOSE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/cash-sessions/$SESSION_ID/close" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"counted":5900,"notes":"Counted twice."}')"
CLOSE_STATUS="$(echo "$CLOSE_JSON" | tail -n1)"
echo "$CLOSE_JSON" | head -n -1 >"$TMP_DIR/close.json"
[ "$CLOSE_STATUS" = "200" ] || fail "closing the cash session returned $CLOSE_STATUS: $(cat "$TMP_DIR/close.json")"
[ "$(jval expected <"$TMP_DIR/close.json")" = "6000" ] || fail "the closed session expected '$(jval expected <"$TMP_DIR/close.json")', wanted 6000"
[ "$(jval variance <"$TMP_DIR/close.json")" = "-100" ] || fail "the closed session variance is '$(jval variance <"$TMP_DIR/close.json")', wanted -100"
ok "the cash session closed with a -100p variance against an expected 6000p"

CLOSED_CURRENT="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval session)"
[ -z "$CLOSED_CURRENT" ] || fail "cash-sessions/current still reports a session after closing: $CLOSED_CURRENT"
ok "no cash session is open once it is closed"

# --- 14k. The stock book export ------------------------------------------
TODAY="$(date -u +%F)"
STOCK_BOOK_STATUS="$(curl -s -D "$TMP_DIR/stockbook.headers" -o "$TMP_DIR/stockbook.csv" -w '%{http_code}' \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/exports/stock-book?from=$TODAY&to=$TODAY")"
[ "$STOCK_BOOK_STATUS" = "200" ] || fail "the stock book export returned $STOCK_BOOK_STATUS: $(cat "$TMP_DIR/stockbook.csv")"
head -n1 "$TMP_DIR/stockbook.csv" | grep -q '^Stock number,Purchase date,Purchase reference,Seller name,Seller address,Description,Cost,Sale date,Sale reference,Sale price,Margin' \
  || fail "unexpected stock book header row: $(head -n1 "$TMP_DIR/stockbook.csv")"
grep -qi "content-disposition: attachment; filename=\"stock-book-$TODAY-$TODAY.csv\"" "$TMP_DIR/stockbook.headers" \
  || fail "the stock book export is not sent as an attachment: $(cat "$TMP_DIR/stockbook.headers")"
grep -q "$TRADE_NUMBER" "$TMP_DIR/stockbook.csv" || fail "the stock book does not name the buy-in $TRADE_NUMBER"
ok "the stock book export returns the margin-scheme CSV with its header row"

# --- 14l. The receipt -----------------------------------------------------
RECEIPT_STATUS="$(curl -s -o "$TMP_DIR/receipt.json" -w '%{http_code}' \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/trade-ins/$TRADE_ID/receipt")"
[ "$RECEIPT_STATUS" = "200" ] || fail "the receipt route returned $RECEIPT_STATUS: $(cat "$TMP_DIR/receipt.json")"
[ "$(jval "trade_in.number" <"$TMP_DIR/receipt.json")" = "$TRADE_NUMBER" ] || fail "the receipt carries the wrong trade-in number"
[ "$(jval "seller.name" <"$TMP_DIR/receipt.json")" = "Seller Check" ] || fail "the receipt has no seller snapshot name"
# The address, ID type and last four digits can only have reached the
# snapshot through the ID check, so this also proves the multipart text
# fields were read, not just the photo.
[ "$(jval "seller.address" <"$TMP_DIR/receipt.json")" = "1 High Street, Bolsover, S44 6AA" ] || fail "the receipt's seller address is '$(jval "seller.address" <"$TMP_DIR/receipt.json")'"
[ "$(jval "seller.id_type" <"$TMP_DIR/receipt.json")" = "passport" ] || fail "the receipt's seller id_type is '$(jval "seller.id_type" <"$TMP_DIR/receipt.json")'"
[ "$(jval "seller.id_last4" <"$TMP_DIR/receipt.json")" = "1234" ] || fail "the receipt's seller id_last4 is '$(jval "seller.id_last4" <"$TMP_DIR/receipt.json")'"
RECEIPT_LINES="$(node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(String((JSON.parse(d).lines || []).length)));
' <"$TMP_DIR/receipt.json")"
[ "$RECEIPT_LINES" = "2" ] || fail "the receipt lists $RECEIPT_LINES lines, expected 2"
[ -n "$(jval "signature.url" <"$TMP_DIR/receipt.json")" ] || fail "the receipt has no signature url"
[ -n "$(jval terms <"$TMP_DIR/receipt.json")" ] || fail "the receipt has no terms text"
ok "the receipt JSON carries the number, seller snapshot, lines, signature and terms"

RECEIPT_EMAIL_JSON="$(curl -s -X POST "$BASE/api/vault/trade-ins/$TRADE_ID/receipt/email" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$(echo "$RECEIPT_EMAIL_JSON" | jval test_mode)" = "true" ] || fail "the receipt email route did not report test mode: $RECEIPT_EMAIL_JSON"
[ "$(echo "$RECEIPT_EMAIL_JSON" | jval sent)" = "false" ] || fail "the receipt email route reported a send while in test mode: $RECEIPT_EMAIL_JSON"
ok "the receipt email route logs instead of sending while settings.email.test_mode is on"

# -----------------------------------------------------------------------
# 15. The money and security cases the Phase 2 review found uncovered.
#     Everything here runs against the same server as section 14 and
#     carries on from its state.
# -----------------------------------------------------------------------

# A fresh step-up token: section 14's is ten minutes old by now in the worst
# case, and everything below that refunds or reads an ID photo needs one.
STEPUP_TOKEN="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
[ -n "$STEPUP_TOKEN" ] || fail "could not mint a step-up token for section 15"

# --- 15a. A 320 KB ID photo goes through quickly ------------------------
# The photo path used to base64 the bytes one character at a time, which is
# quadratic in goja: 200 KB took about 15 seconds. The bytes now go straight
# into $security.encrypt, so this is milliseconds.
node -e '
  const fs = require("fs");
  const n = 320 * 1024;
  const b = Buffer.alloc(n);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  for (let i = 8; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(process.argv[1], b);
' "$TMP_DIR/big.png"
[ -s "$TMP_DIR/big.png" ] || fail "could not write the 320 KB test photo"

BIG_CUSTOMER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Big Photo Check","email":"big-photo-check@local.test","source":"counter"}' | jval id)"
[ -n "$BIG_CUSTOMER_ID" ] || fail "could not create the big-photo customer"

BIG_UPLOAD_TIME="$(curl -s -o "$TMP_DIR/big-check.json" -w '%{time_total}' \
  -X POST "$BASE/api/vault/customers/$BIG_CUSTOMER_ID/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/big.png;type=image/png" \
  -F "id_type=passport" \
  -F "id_expiry=2030-06-30" \
  -F "id_ref_last4=9876" \
  -F "dob=1988-03-04" \
  -F "address=2 Market Place, Bolsover, S44 6PN")"
BIG_DOC_ID="$(jval id_document <"$TMP_DIR/big-check.json")"
[ -n "$BIG_DOC_ID" ] || fail "the 320 KB ID check was refused: $(cat "$TMP_DIR/big-check.json")"
under_seconds "$BIG_UPLOAD_TIME" 3 \
  || fail "the 320 KB ID check took ${BIG_UPLOAD_TIME}s, expected under 3s (is base64 back on the photo path?)"
ok "a 320 KB ID photo uploads in ${BIG_UPLOAD_TIME}s"

BIG_VIEW_TIME="$(curl -s -o "$TMP_DIR/big-photo.bin" -w '%{time_total}' \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" \
  "$BASE/api/vault/id-photo/$BIG_DOC_ID")"
cmp -s "$TMP_DIR/big.png" "$TMP_DIR/big-photo.bin" \
  || fail "the decrypted 320 KB ID photo does not match the bytes that went in"
under_seconds "$BIG_VIEW_TIME" 3 \
  || fail "viewing the 320 KB ID photo took ${BIG_VIEW_TIME}s, expected under 3s"
ok "the 320 KB ID photo comes back byte-for-byte in ${BIG_VIEW_TIME}s"

# --- 15b. The upload has to actually be a photo -------------------------
printf '<!doctype html><html><body>not a photo</body></html>' >"$TMP_DIR/photo.jpg"
HTML_UPLOAD_STATUS="$(curl -s -o "$TMP_DIR/html-upload.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$BIG_CUSTOMER_ID/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/photo.jpg;type=image/jpeg" \
  -F "mime=image/jpeg" \
  -F "id_type=passport" \
  -F "id_expiry=2030-06-30")"
[ "$HTML_UPLOAD_STATUS" = "400" ] || fail "an HTML file named photo.jpg returned $HTML_UPLOAD_STATUS, expected 400: $(cat "$TMP_DIR/html-upload.json")"
grep -q "not a photo" "$TMP_DIR/html-upload.json" || fail "the refusal does not say the file is not a photo: $(cat "$TMP_DIR/html-upload.json")"
ok "an HTML file named photo.jpg is refused with 400 (the client mime field is ignored)"

# --- 15c. And it has to be under 8 MB -----------------------------------
node -e '
  const fs = require("fs");
  const n = 9 * 1024 * 1024;
  const b = Buffer.alloc(n);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  fs.writeFileSync(process.argv[1], b);
' "$TMP_DIR/huge.png"
HUGE_UPLOAD_STATUS="$(curl -s -o "$TMP_DIR/huge-upload.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$BIG_CUSTOMER_ID/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/huge.png;type=image/png" \
  -F "id_type=passport" \
  -F "id_expiry=2030-06-30")"
[ "$HUGE_UPLOAD_STATUS" = "400" ] || fail "a 9 MB photo returned $HUGE_UPLOAD_STATUS, expected 400: $(cat "$TMP_DIR/huge-upload.json")"
grep -q "8 MB" "$TMP_DIR/huge-upload.json" || fail "the oversize refusal does not mention the 8 MB limit: $(cat "$TMP_DIR/huge-upload.json")"
rm -f "$TMP_DIR/huge.png"
ok "a photo over 8 MB is refused with 400"

# --- 15d. The signature is a protected file -----------------------------
SIGNATURE_URL="$(jval "signature.url" <"$TMP_DIR/receipt.json")"
SIGNATURE_FILE="$(jval "signature.file" <"$TMP_DIR/receipt.json")"
[ -n "$SIGNATURE_FILE" ] || fail "the receipt carries no signature file name"
echo "$SIGNATURE_URL" | grep -q "token=" || fail "the receipt's signature url carries no file token: $SIGNATURE_URL"

SIGNATURE_STATUS="$(curl -s -o "$TMP_DIR/signature.png" -w '%{http_code}' "$BASE$SIGNATURE_URL")"
[ "$SIGNATURE_STATUS" = "200" ] || fail "the signature url with its token returned $SIGNATURE_STATUS, expected 200"
node -e '
  const b = require("fs").readFileSync(process.argv[1]);
  if (!(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)) {
    console.error("the signature came back as something other than a PNG");
    process.exit(1);
  }
' "$TMP_DIR/signature.png" || fail "the signature url did not return a PNG"
ok "the signature url with its file token returns the PNG"

SIGNATURE_BARE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  "$BASE/api/files/trade_ins/$TRADE_ID/$SIGNATURE_FILE")"
[ "$SIGNATURE_BARE_STATUS" != "200" ] || fail "the signature file is served without a token - is trade_ins.signature still unprotected?"
ok "the signature file is refused without a token (got $SIGNATURE_BARE_STATUS)"

# --- 15e. CSV cells that a spreadsheet would run as a formula -----------
FORMULA_SELLER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"=HYPERLINK(\"x\")","email":"formula-check@local.test","source":"counter"}' | jval id)"
[ -n "$FORMULA_SELLER_ID" ] || fail "could not create the formula-named seller"
FORMULA_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$FORMULA_SELLER_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$FORMULA_TRADE_ID\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Spreadsheet Bait\",\"qty\":1,\"market_price\":1000,\"market_currency\":\"GBP\",\"offer_price\":600,\"accepted\":true}"
FORMULA_COMPLETE_STATUS="$(curl -s -o "$TMP_DIR/formula-complete.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$FORMULA_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":600,"terms_accepted":true}')"
[ "$FORMULA_COMPLETE_STATUS" = "200" ] || fail "the credit-only buy-in returned $FORMULA_COMPLETE_STATUS: $(cat "$TMP_DIR/formula-complete.json")"

TODAY="$(date -u +%F)"
curl -s -o "$TMP_DIR/stockbook-formula.csv" \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/exports/stock-book?from=$TODAY&to=$TODAY"
grep -qF '"'"'"'=HYPERLINK' "$TMP_DIR/stockbook-formula.csv" \
  || fail "a seller called =HYPERLINK(\"x\") is not prefixed in the stock book: $(grep -F 'HYPERLINK' "$TMP_DIR/stockbook-formula.csv" || true)"
ok "a seller called =HYPERLINK(\"x\") comes out of the stock book prefixed and quoted"

# --- 15f. A trade-in cannot be completed twice --------------------------
DOUBLE_STATUS="$(curl -s -o "$TMP_DIR/double.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$FORMULA_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":600,"terms_accepted":true}')"
[ "$DOUBLE_STATUS" = "409" ] || fail "completing a trade-in twice returned $DOUBLE_STATUS, expected 409: $(cat "$TMP_DIR/double.json")"
ok "completing a trade-in twice is refused with 409"

# --- 15g/h. Payout arithmetic and the terms -----------------------------
GUARD_SELLER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Guard Check","email":"guard-check@local.test","source":"counter"}' | jval id)"
GUARD_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$GUARD_SELLER_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$GUARD_TRADE_ID\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Guard Bundle\",\"qty\":2,\"market_price\":1000,\"market_currency\":\"GBP\",\"offer_price\":700,\"accepted\":true}"

MISMATCH_STATUS="$(curl -s -o "$TMP_DIR/mismatch.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$GUARD_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":999,"terms_accepted":true}')"
[ "$MISMATCH_STATUS" = "400" ] || fail "a payout that does not match the lines returned $MISMATCH_STATUS, expected 400: $(cat "$TMP_DIR/mismatch.json")"
ok "a payout that does not match the accepted lines is refused with 400"

NO_TERMS_STATUS="$(curl -s -o "$TMP_DIR/no-terms.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$GUARD_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":1400}')"
[ "$NO_TERMS_STATUS" = "422" ] || fail "completing without terms_accepted returned $NO_TERMS_STATUS, expected 422: $(cat "$TMP_DIR/no-terms.json")"
ok "completing a buy-in without terms_accepted is refused with 422"

BAD_SIGNATURE_STATUS="$(curl -s -o "$TMP_DIR/bad-signature.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$GUARD_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":1400,"terms_accepted":true,"signature":"data:image/png;base64,bm90IGEgcG5n"}')"
[ "$BAD_SIGNATURE_STATUS" = "400" ] || fail "a signature that is not a PNG returned $BAD_SIGNATURE_STATUS, expected 400: $(cat "$TMP_DIR/bad-signature.json")"
ok "a signature that is not a PNG is refused with 400"

BAD_LAST4_STATUS="$(curl -s -o "$TMP_DIR/bad-last4.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$GUARD_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":1400,"terms_accepted":true,"id_check":{"id_ref_last4":"123456789"}}')"
[ "$BAD_LAST4_STATUS" = "400" ] || fail "an over-long id_ref_last4 returned $BAD_LAST4_STATUS, expected 400: $(cat "$TMP_DIR/bad-last4.json")"
ok "an id_ref_last4 longer than four characters is refused with 400"

# --- A cash session for everything below --------------------------------
SESSION2_ID="$(curl -s -X POST "$BASE/api/vault/cash-sessions/open" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"float":20000}' | jval "session.id")"
[ -n "$SESSION2_ID" ] || fail "could not open a second cash session after the first was closed"
ok "a new cash session opens once the previous one is closed"

# --- 15i. customer_private flags refuse a cash payout -------------------
# Each of these has an address and an in-date verified ID on file, so the
# only thing standing between them and a cash payout is the flag.
flagged_seller() {
  # $1 name, $2 email, $3 flags JSON array
  local cid pid
  cid="$(curl -s -X POST "$BASE/api/collections/customers/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"source\":\"counter\"}" | jval id)"
  pid="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$cid%22" \
    -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
  curl -s -o /dev/null -X PATCH "$BASE/api/collections/customer_private/records/$pid" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"flags\":$3,\"address\":\"3 Castle Street, Bolsover, S44 6PP\",\"id_status\":\"verified\",\"id_type\":\"passport\",\"id_expiry\":\"2031-01-01\",\"dob\":\"1985-05-05\"}"
  echo "$cid"
}

cash_trade_for() {
  # $1 customer id, $2 offer price -> prints the trade-in id
  local tid
  tid="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"customer\":\"$1\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
  curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"trade_in\":\"$tid\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Cash Gate Bundle\",\"qty\":1,\"market_price\":2000,\"market_currency\":\"GBP\",\"offer_price\":$2,\"accepted\":true}"
  echo "$tid"
}

NO_CASH_ID="$(flagged_seller "No Cash Check" "no-cash-check@local.test" '["no_cash"]')"
NO_CASH_TRADE="$(cash_trade_for "$NO_CASH_ID" 1000)"
NO_CASH_STATUS="$(curl -s -o "$TMP_DIR/no-cash.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$NO_CASH_TRADE/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":1000,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION2_ID\"}")"
[ "$NO_CASH_STATUS" = "422" ] || fail "a no_cash customer's cash payout returned $NO_CASH_STATUS, expected 422: $(cat "$TMP_DIR/no-cash.json")"
grep -q "marked no cash" "$TMP_DIR/no-cash.json" || fail "the no_cash refusal reads: $(cat "$TMP_DIR/no-cash.json")"
ok "a customer flagged no_cash cannot be paid cash (422)"

UNDER18_ID="$(flagged_seller "Under 18 Check" "under18-check@local.test" '["under_18"]')"
UNDER18_TRADE="$(cash_trade_for "$UNDER18_ID" 1000)"
UNDER18_STATUS="$(curl -s -o "$TMP_DIR/under18.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$UNDER18_TRADE/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":1000,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION2_ID\"}")"
[ "$UNDER18_STATUS" = "422" ] || fail "an under_18 customer's cash payout returned $UNDER18_STATUS, expected 422: $(cat "$TMP_DIR/under18.json")"
grep -q "under 18" "$TMP_DIR/under18.json" || fail "the under_18 refusal reads: $(cat "$TMP_DIR/under18.json")"
ok "a customer flagged under_18 cannot be paid cash (422)"

# --- 15j. A stored ID that has expired -----------------------------------
EXPIRED_ID="$(flagged_seller "Expired ID Check" "expired-id-check@local.test" '[]')"
EXPIRED_PRIVATE="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$EXPIRED_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/customer_private/records/$EXPIRED_PRIVATE" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"id_expiry":"2020-01-01"}'
EXPIRED_TRADE="$(cash_trade_for "$EXPIRED_ID" 1000)"
EXPIRED_STATUS="$(curl -s -o "$TMP_DIR/expired-id.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$EXPIRED_TRADE/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":1000,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION2_ID\"}")"
[ "$EXPIRED_STATUS" = "422" ] || fail "an expired stored id_expiry returned $EXPIRED_STATUS, expected 422: $(cat "$TMP_DIR/expired-id.json")"
ok "a stored id_expiry that has passed is refused with 422"

# --- 15k. Verified ID fields with no photo behind them -------------------
NO_PHOTO_ID="$(flagged_seller "No Photo Check" "no-photo-check@local.test" '[]')"
NO_PHOTO_TRADE="$(cash_trade_for "$NO_PHOTO_ID" 1000)"
NO_PHOTO_STATUS="$(curl -s -o "$TMP_DIR/no-photo.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$NO_PHOTO_TRADE/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":1000,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION2_ID\"}")"
[ "$NO_PHOTO_STATUS" = "422" ] || fail "a customer with ID fields but no photo returned $NO_PHOTO_STATUS, expected 422: $(cat "$TMP_DIR/no-photo.json")"
grep -q "photo of the customer" "$TMP_DIR/no-photo.json" || fail "the missing-photo refusal reads: $(cat "$TMP_DIR/no-photo.json")"
ok "verified ID fields with no photo on file cannot be paid cash (422)"

# The same trade-in goes through once a photo exists, and the photo's
# retention clock restarts on it.
NO_PHOTO_DOC="$(curl -s -X POST "$BASE/api/vault/customers/$NO_PHOTO_ID/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/id.png;type=image/png" \
  -F "id_type=passport" -F "id_expiry=2031-01-01" -F "id_ref_last4=4321" \
  -F "dob=1985-05-05" -F "address=3 Castle Street, Bolsover, S44 6PP" | jval id_document)"
[ -n "$NO_PHOTO_DOC" ] || fail "could not take the ID photo for the no-photo seller"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/id_documents/records/$NO_PHOTO_DOC" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d '{"expires_at":"2026-10-01 00:00:00.000Z"}'
WITH_PHOTO_STATUS="$(curl -s -o "$TMP_DIR/with-photo.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$NO_PHOTO_TRADE/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":1000,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION2_ID\"}")"
[ "$WITH_PHOTO_STATUS" = "200" ] || fail "the cash buy-in with a photo on file returned $WITH_PHOTO_STATUS: $(cat "$TMP_DIR/with-photo.json")"
LINKED_DOC="$(curl -s "$BASE/api/collections/trade_ins/records/$NO_PHOTO_TRADE" \
  -H "Authorization: $STAFF_TOKEN" | jval id_document)"
[ "$LINKED_DOC" = "$NO_PHOTO_DOC" ] || fail "trade_ins.id_document is '$LINKED_DOC', expected $NO_PHOTO_DOC"
NEW_EXPIRY="$(curl -s "$BASE/api/collections/id_documents/records/$NO_PHOTO_DOC" \
  -H "Authorization: $SUPER_TOKEN" | jval expires_at)"
case "$NEW_EXPIRY" in
  2026-10-01*) fail "the ID photo's expires_at was not extended by the cash buy-in (still $NEW_EXPIRY)" ;;
  "") fail "could not read the ID photo's expires_at back" ;;
esac
ok "a cash buy-in records the ID document and pushes its expiry out"

# --- 15l. Partial refunds of a discounted two-line sale ------------------
# The refunds have to add back up to exactly what was charged, and neither
# sale_lines.qty nor sale_lines.discount may move while they do.
make_item() {
  # $1 title, $2 qty, $3 cost, $4 price -> prints the item id
  curl -s -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"title\":\"$1\",\"qty\":$2,\"cost\":$3,\"price\":$4,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}" \
    | jval id
}

SPLIT_ITEM_A="$(make_item "Refund Split A" 3 400 1000)"
SPLIT_ITEM_B="$(make_item "Refund Split B" 2 300 777)"
[ -n "$SPLIT_ITEM_A" ] && [ -n "$SPLIT_ITEM_B" ] || fail "could not create the refund-split items"

SPLIT_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SPLIT_ITEM_A\",\"qty\":3,\"unit_price\":1000,\"discount\":1},{\"item\":\"$SPLIT_ITEM_B\",\"qty\":2,\"unit_price\":777,\"discount\":0}],\"payment\":\"sumup_card\",\"discount\":100}")"
SPLIT_SALE_STATUS="$(echo "$SPLIT_SALE_JSON" | tail -n1)"
echo "$SPLIT_SALE_JSON" | head -n -1 >"$TMP_DIR/split-sale.json"
[ "$SPLIT_SALE_STATUS" = "200" ] || fail "the two-line discounted sale returned $SPLIT_SALE_STATUS: $(cat "$TMP_DIR/split-sale.json")"
SPLIT_SALE_ID="$(jval "sale.id" <"$TMP_DIR/split-sale.json")"
SPLIT_SALE_TOTAL="$(jval "sale.total" <"$TMP_DIR/split-sale.json")"
[ "$SPLIT_SALE_TOTAL" = "4453" ] || fail "the two-line discounted sale totals '$SPLIT_SALE_TOTAL', expected 4453"
[ "$(jval points_earned <"$TMP_DIR/split-sale.json")" = "0" ] || fail "a sale with no customer earned points"
ok "a two-line sale with a line discount and a sale discount comes to 4453p and earns no points"

SPLIT_LINES_JSON="$(curl -s "$BASE/api/collections/sale_lines/records?perPage=50&sort=created,id&filter=sale%3D%22$SPLIT_SALE_ID%22" \
  -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SPLIT_LINES_JSON" | jval totalItems)" = "2" ] || fail "the two-line sale has $(echo "$SPLIT_LINES_JSON" | jval totalItems) sale_lines"

REFUND_SUM=0
for idx in 0 1; do
  LINE_ID="$(echo "$SPLIT_LINES_JSON" | jval "items.$idx.id")"
  LINE_QTY="$(echo "$SPLIT_LINES_JSON" | jval "items.$idx.qty")"
  unit=0
  while [ "$unit" -lt "$LINE_QTY" ]; do
    UNIT_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/$SPLIT_SALE_ID/refund" \
      -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
      -d "{\"lines\":[{\"sale_line\":\"$LINE_ID\",\"qty\":1}],\"reason\":\"Unit $unit of line $idx came back\",\"refund_method\":\"sumup_card\"}")"
    UNIT_STATUS="$(echo "$UNIT_JSON" | tail -n1)"
    UNIT_BODY="$(echo "$UNIT_JSON" | head -n -1)"
    [ "$UNIT_STATUS" = "200" ] || fail "refunding unit $unit of line $idx returned $UNIT_STATUS: $UNIT_BODY"
    UNIT_AMOUNT="$(echo "$UNIT_BODY" | jval refunded)"
    [ "${UNIT_AMOUNT:-0}" -gt 0 ] || fail "refunding unit $unit of line $idx refunded '$UNIT_AMOUNT'"
    REFUND_SUM=$((REFUND_SUM + UNIT_AMOUNT))
    unit=$((unit + 1))
  done

  if [ "$idx" = "0" ]; then
    REPEAT_STATUS="$(curl -s -o "$TMP_DIR/repeat-refund.json" -w '%{http_code}' \
      -X POST "$BASE/api/vault/sales/$SPLIT_SALE_ID/refund" \
      -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
      -d "{\"lines\":[{\"sale_line\":\"$LINE_ID\",\"qty\":1}],\"reason\":\"Again\",\"refund_method\":\"sumup_card\"}")"
    [ "$REPEAT_STATUS" = "409" ] || fail "refunding an already refunded line returned $REPEAT_STATUS, expected 409: $(cat "$TMP_DIR/repeat-refund.json")"
    ok "a second refund of a fully refunded line is refused with 409"
  fi
done

[ "$REFUND_SUM" = "$SPLIT_SALE_TOTAL" ] \
  || fail "five one-unit refunds came to ${REFUND_SUM}p but the sale was charged ${SPLIT_SALE_TOTAL}p"
ok "refunding a discounted two-line sale one unit at a time returns exactly ${SPLIT_SALE_TOTAL}p"

SPLIT_SALE_AFTER="$(curl -s "$BASE/api/collections/sales/records/$SPLIT_SALE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SPLIT_SALE_AFTER" | jval status)" = "refunded" ] || fail "the fully refunded sale reads '$(echo "$SPLIT_SALE_AFTER" | jval status)'"
[ "$(echo "$SPLIT_SALE_AFTER" | jval refunded_total)" = "$SPLIT_SALE_TOTAL" ] \
  || fail "sales.refunded_total is '$(echo "$SPLIT_SALE_AFTER" | jval refunded_total)', expected $SPLIT_SALE_TOTAL"

SPLIT_LINES_AFTER="$(curl -s "$BASE/api/collections/sale_lines/records?perPage=50&sort=created,id&filter=sale%3D%22$SPLIT_SALE_ID%22" \
  -H "Authorization: $STAFF_TOKEN")"
for idx in 0 1; do
  BEFORE_QTY="$(echo "$SPLIT_LINES_JSON" | jval "items.$idx.qty")"
  BEFORE_DISCOUNT="$(echo "$SPLIT_LINES_JSON" | jval "items.$idx.discount")"
  AFTER_QTY="$(echo "$SPLIT_LINES_AFTER" | jval "items.$idx.qty")"
  AFTER_DISCOUNT="$(echo "$SPLIT_LINES_AFTER" | jval "items.$idx.discount")"
  AFTER_REFUNDED="$(echo "$SPLIT_LINES_AFTER" | jval "items.$idx.refunded_qty")"
  [ "$AFTER_QTY" = "$BEFORE_QTY" ] || fail "sale_lines.qty moved from $BEFORE_QTY to $AFTER_QTY on a refund"
  [ "$AFTER_DISCOUNT" = "$BEFORE_DISCOUNT" ] || fail "sale_lines.discount moved from $BEFORE_DISCOUNT to $AFTER_DISCOUNT on a refund"
  [ "$AFTER_REFUNDED" = "$BEFORE_QTY" ] || fail "sale_lines.refunded_qty is '$AFTER_REFUNDED', expected $BEFORE_QTY"
  [ "$(echo "$SPLIT_LINES_AFTER" | jval "items.$idx.status")" = "refunded" ] || fail "a fully refunded sale line is not marked refunded"
done
ok "refunds move refunded_qty and refunded_total and never rewrite qty or discount"

# --- 15t. The refund reason is a note, not audit meta --------------------
SPLIT_NOTES="$(curl -s "$BASE/api/collections/notes/records?perPage=50&filter=target_record%3D%22$SPLIT_SALE_ID%22" \
  -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SPLIT_NOTES" | jval totalItems)" = "5" ] || fail "expected five refund notes against the sale, got $(echo "$SPLIT_NOTES" | jval totalItems)"
echo "$SPLIT_NOTES" | grep -q "came back" || fail "the refund reason is not in the note body: $SPLIT_NOTES"
REFUND_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22sale_refund%22" \
  -H "Authorization: $SUPER_TOKEN")"
echo "$REFUND_AUDIT" | grep -qF "came back" && fail "the refund reason is still being written into audit_log meta"
echo "$REFUND_AUDIT" | grep -q '"note"' || fail "the sale_refund audit meta carries no note id: $REFUND_AUDIT"
ok "the refund reason is stored as a note and only its id reaches audit_log"

RECEIPT_VIEW_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22trade_in_receipt_view%22" \
  -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${RECEIPT_VIEW_AUDIT:-0}" -ge 1 ] || fail "fetching the receipt JSON wrote no trade_in_receipt_view audit row"
ok "fetching the receipt JSON is audited"

# --- 15m. A cash sale and a cash refund move the drawer both ways --------
CASH_ITEM="$(make_item "Cash Sale Item" 1 600 1500)"
CASH_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$CASH_ITEM\",\"qty\":1,\"unit_price\":1500,\"discount\":0}],\"payment\":\"cash\",\"cash_session\":\"$SESSION2_ID\"}")"
CASH_SALE_STATUS="$(echo "$CASH_SALE_JSON" | tail -n1)"
echo "$CASH_SALE_JSON" | head -n -1 >"$TMP_DIR/cash-sale.json"
[ "$CASH_SALE_STATUS" = "200" ] || fail "the cash sale returned $CASH_SALE_STATUS: $(cat "$TMP_DIR/cash-sale.json")"
CASH_SALE_ID="$(jval "sale.id" <"$TMP_DIR/cash-sale.json")"
CASH_SALE_NUMBER="$(jval "sale.number" <"$TMP_DIR/cash-sale.json")"

CASH_IN="$(curl -s "$BASE/api/collections/cash_movements/records?perPage=50&filter=session%3D%22$SESSION2_ID%22%26%26type%3D%22cash_sale%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.amount")"
[ "$CASH_IN" = "1500" ] || fail "the cash sale wrote a cash_movement of '$CASH_IN', expected +1500"
ok "a cash sale writes a positive cash_movement"

CASH_LINE_ID="$(curl -s "$BASE/api/collections/sale_lines/records?filter=sale%3D%22$CASH_SALE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
CASH_REFUND_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/$CASH_SALE_ID/refund" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"sale_line\":\"$CASH_LINE_ID\",\"qty\":1}],\"reason\":\"Faulty seal\",\"refund_method\":\"cash\"}")"
CASH_REFUND_STATUS="$(echo "$CASH_REFUND_JSON" | tail -n1)"
echo "$CASH_REFUND_JSON" | head -n -1 >"$TMP_DIR/cash-refund.json"
[ "$CASH_REFUND_STATUS" = "200" ] || fail "the cash refund returned $CASH_REFUND_STATUS: $(cat "$TMP_DIR/cash-refund.json")"
CASH_OUT="$(curl -s "$BASE/api/collections/cash_movements/records?perPage=50&filter=session%3D%22$SESSION2_ID%22%26%26type%3D%22refund%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.amount")"
[ "$CASH_OUT" = "-1500" ] || fail "the cash refund wrote a cash_movement of '$CASH_OUT', expected -1500"
ok "a cash refund writes a negative cash_movement ($CASH_SALE_NUMBER)"

# --- 15n. A sale part-paid with points ----------------------------------
POINTS_CUSTOMER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Points Check","email":"points-check@local.test","source":"counter"}' | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/points_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$POINTS_CUSTOMER_ID\",\"delta\":2000,\"reason\":\"adjust\",\"ref\":\"check seed\"}"
POINTS_ITEM="$(make_item "Points Sale Item" 1 500 2000)"
POINTS_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$POINTS_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$POINTS_CUSTOMER_ID\",\"payment\":\"mixed\",\"payment_split\":{\"points\":500,\"sumup_card\":1500,\"cash\":0,\"store_credit\":0}}")"
POINTS_SALE_STATUS="$(echo "$POINTS_SALE_JSON" | tail -n1)"
echo "$POINTS_SALE_JSON" | head -n -1 >"$TMP_DIR/points-sale.json"
[ "$POINTS_SALE_STATUS" = "200" ] || fail "the points sale returned $POINTS_SALE_STATUS: $(cat "$TMP_DIR/points-sale.json")"
# 2000p gross, 500p of it paid with points, so only 1500p earns: 15 x 10.
[ "$(jval points_earned <"$TMP_DIR/points-sale.json")" = "150" ] \
  || fail "the points sale earned '$(jval points_earned <"$TMP_DIR/points-sale.json")' points, expected 150"
# 100 welcome + 2000 seeded - 500 spent + 150 earned.
[ "$(jval points_balance <"$TMP_DIR/points-sale.json")" = "1750" ] \
  || fail "the points balance after the redemption is '$(jval points_balance <"$TMP_DIR/points-sale.json")', expected 1750"
ok "a sale part-paid with points spends them and earns only on the rest"

OVER_POINTS_ITEM="$(make_item "Over Points Item" 1 100 1000)"
OVER_POINTS_STATUS="$(curl -s -o "$TMP_DIR/over-points.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$OVER_POINTS_ITEM\",\"qty\":1,\"unit_price\":1000,\"discount\":0}],\"customer\":\"$POINTS_CUSTOMER_ID\",\"payment\":\"points\"}")"
[ "$OVER_POINTS_STATUS" = "422" ] || fail "paying a whole sale with points returned $OVER_POINTS_STATUS, expected 422: $(cat "$TMP_DIR/over-points.json")"
ok "points cannot cover more than their share of a sale (422)"

# --- 15r. Reward codes ---------------------------------------------------
MONEY_OFF_REWARD="$(curl -s -X POST "$BASE/api/collections/loyalty_rewards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"£5 off","type":"money_off","value":500,"cost_points":500,"active":true}' | jval id)"
EVENT_REWARD="$(curl -s -X POST "$BASE/api/collections/loyalty_rewards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Tournament entry","type":"event_entry","value":0,"cost_points":400,"active":true}' | jval id)"
[ -n "$MONEY_OFF_REWARD" ] && [ -n "$EVENT_REWARD" ] || fail "could not create the check rewards"

MONEY_OFF_CODE="$(curl -s -X POST "$BASE/api/collections/reward_redemptions/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$POINTS_CUSTOMER_ID\",\"reward\":\"$MONEY_OFF_REWARD\",\"points_spent\":500,\"status\":\"issued\",\"expires_at\":\"2031-01-01 00:00:00.000Z\"}" | jval code)"
EVENT_CODE="$(curl -s -X POST "$BASE/api/collections/reward_redemptions/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$POINTS_CUSTOMER_ID\",\"reward\":\"$EVENT_REWARD\",\"points_spent\":400,\"status\":\"issued\",\"expires_at\":\"2031-01-01 00:00:00.000Z\"}" | jval code)"
[ -n "$MONEY_OFF_CODE" ] && [ -n "$EVENT_CODE" ] || fail "the reward redemptions got no voucher codes"

REWARD_ITEM="$(make_item "Reward Sale Item" 1 500 2000)"
reward_sale_status() {
  # $1 body -> prints the status code, body in $TMP_DIR/reward-sale.json
  curl -s -o "$TMP_DIR/reward-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$1"
}

REWARD_NO_CUSTOMER="$(reward_sale_status "{\"lines\":[{\"item\":\"$REWARD_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"payment\":\"sumup_card\",\"discount\":500,\"discount_source\":\"reward\",\"reward_code\":\"$MONEY_OFF_CODE\"}")"
[ "$REWARD_NO_CUSTOMER" = "422" ] || fail "a reward code on a sale with no customer returned $REWARD_NO_CUSTOMER, expected 422: $(cat "$TMP_DIR/reward-sale.json")"
grep -q "Add the customer to the sale" "$TMP_DIR/reward-sale.json" || fail "wrong message for a reward with no customer: $(cat "$TMP_DIR/reward-sale.json")"
ok "a reward code with no customer on the sale is refused with 422"

REWARD_WRONG_CUSTOMER="$(reward_sale_status "{\"lines\":[{\"item\":\"$REWARD_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$SELLER_ID\",\"payment\":\"sumup_card\",\"discount\":500,\"discount_source\":\"reward\",\"reward_code\":\"$MONEY_OFF_CODE\"}")"
[ "$REWARD_WRONG_CUSTOMER" = "422" ] || fail "a reward code for another customer returned $REWARD_WRONG_CUSTOMER, expected 422: $(cat "$TMP_DIR/reward-sale.json")"
grep -q "different customer" "$TMP_DIR/reward-sale.json" || fail "wrong message for another customer's reward: $(cat "$TMP_DIR/reward-sale.json")"
ok "a reward belonging to another customer is refused with 422"

REWARD_WRONG_SOURCE="$(reward_sale_status "{\"lines\":[{\"item\":\"$REWARD_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$POINTS_CUSTOMER_ID\",\"payment\":\"sumup_card\",\"discount\":500,\"discount_source\":\"manual\",\"reward_code\":\"$MONEY_OFF_CODE\"}")"
[ "$REWARD_WRONG_SOURCE" = "422" ] || fail "a reward code with a manual discount source returned $REWARD_WRONG_SOURCE, expected 422: $(cat "$TMP_DIR/reward-sale.json")"
ok "a reward code with the wrong discount source is refused with 422"

REWARD_WRONG_AMOUNT="$(reward_sale_status "{\"lines\":[{\"item\":\"$REWARD_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$POINTS_CUSTOMER_ID\",\"payment\":\"sumup_card\",\"discount\":300,\"discount_source\":\"reward\",\"reward_code\":\"$MONEY_OFF_CODE\"}")"
[ "$REWARD_WRONG_AMOUNT" = "422" ] || fail "a reward discount that does not match returned $REWARD_WRONG_AMOUNT, expected 422: $(cat "$TMP_DIR/reward-sale.json")"
grep -q "does not match this reward" "$TMP_DIR/reward-sale.json" || fail "wrong message for a mismatched reward discount: $(cat "$TMP_DIR/reward-sale.json")"
ok "a discount that does not match the reward is refused with 422"

REWARD_WRONG_TYPE="$(reward_sale_status "{\"lines\":[{\"item\":\"$REWARD_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$POINTS_CUSTOMER_ID\",\"payment\":\"sumup_card\",\"discount\":0,\"discount_source\":\"reward\",\"reward_code\":\"$EVENT_CODE\"}")"
[ "$REWARD_WRONG_TYPE" = "422" ] || fail "a non-money-off reward returned $REWARD_WRONG_TYPE, expected 422: $(cat "$TMP_DIR/reward-sale.json")"
grep -q "not money off" "$TMP_DIR/reward-sale.json" || fail "wrong message for a non-money-off reward: $(cat "$TMP_DIR/reward-sale.json")"
ok "a reward that is not money off is refused with 422"

REWARD_OK="$(reward_sale_status "{\"lines\":[{\"item\":\"$REWARD_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$POINTS_CUSTOMER_ID\",\"payment\":\"sumup_card\",\"discount\":500,\"discount_source\":\"reward\",\"reward_code\":\"$MONEY_OFF_CODE\"}")"
[ "$REWARD_OK" = "200" ] || fail "a valid reward sale returned $REWARD_OK: $(cat "$TMP_DIR/reward-sale.json")"
REWARD_SALE_ID="$(jval "sale.id" <"$TMP_DIR/reward-sale.json")"
[ "$(jval "sale.total" <"$TMP_DIR/reward-sale.json")" = "1500" ] || fail "the reward sale totals '$(jval "sale.total" <"$TMP_DIR/reward-sale.json")', expected 1500"
REWARD_REDEMPTION_STATUS="$(curl -s "$BASE/api/collections/reward_redemptions/records?filter=code%3D%22$MONEY_OFF_CODE%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.status")"
[ "$REWARD_REDEMPTION_STATUS" = "used" ] || fail "the redemption is '$REWARD_REDEMPTION_STATUS' after the sale, expected used"
REWARD_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22sale_complete%22" \
  -H "Authorization: $SUPER_TOKEN")"
echo "$REWARD_AUDIT" | grep -q "$MONEY_OFF_REWARD" || fail "the sale_complete audit meta does not carry the reward id"
ok "a valid money-off reward discounts the sale, is marked used and reaches the audit meta"

# --- 15s. A cash cap of zero switches cash off ---------------------------
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"cash_cap":0}'

CAP_ZERO_ITEM="$(make_item "Cap Zero Item" 1 100 400)"
CAP_ZERO_SALE="$(curl -s -o "$TMP_DIR/cap-zero-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$CAP_ZERO_ITEM\",\"qty\":1,\"unit_price\":400,\"discount\":0}],\"payment\":\"cash\",\"cash_session\":\"$SESSION2_ID\"}")"
[ "$CAP_ZERO_SALE" = "422" ] || fail "a cash sale with cash_cap 0 returned $CAP_ZERO_SALE, expected 422: $(cat "$TMP_DIR/cap-zero-sale.json")"
grep -q "Cash sales are switched off in settings." "$TMP_DIR/cap-zero-sale.json" || fail "wrong message for a cash sale with cash_cap 0: $(cat "$TMP_DIR/cap-zero-sale.json")"
ok "a cash cap of 0 switches cash sales off (422)"

CAP_ZERO_TRADE="$(cash_trade_for "$NO_PHOTO_ID" 500)"
CAP_ZERO_PAYOUT="$(curl -s -o "$TMP_DIR/cap-zero-payout.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$CAP_ZERO_TRADE/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"payout_type\":\"cash\",\"payout_cash\":500,\"payout_credit\":0,\"terms_accepted\":true,\"cash_session\":\"$SESSION2_ID\"}")"
[ "$CAP_ZERO_PAYOUT" = "422" ] || fail "a cash payout with cash_cap 0 returned $CAP_ZERO_PAYOUT, expected 422: $(cat "$TMP_DIR/cap-zero-payout.json")"
grep -q "Cash payouts are switched off in settings." "$TMP_DIR/cap-zero-payout.json" || fail "wrong message for a cash payout with cash_cap 0: $(cat "$TMP_DIR/cap-zero-payout.json")"
ok "a cash cap of 0 switches cash payouts off (422)"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"cash_cap":800000}'

# --- 15o/p. Roles and whose step-up token it is --------------------------
PLAIN_EMAIL="plain-check@local.test"
PLAIN_PASSWORD="plaincheckpassword123"
curl -s -o /dev/null -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$PLAIN_EMAIL\",\"password\":\"$PLAIN_PASSWORD\",\"passwordConfirm\":\"$PLAIN_PASSWORD\",\"name\":\"Plain Check\",\"role\":\"staff\",\"active\":true}"
PLAIN_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$PLAIN_EMAIL\",\"password\":\"$PLAIN_PASSWORD\"}" | jval token)"
[ -n "$PLAIN_TOKEN" ] || fail "could not authenticate the non-admin staff account"

PLAIN_STOCK_BOOK="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/exports/stock-book?from=$TODAY&to=$TODAY")"
[ "$PLAIN_STOCK_BOOK" = "403" ] || fail "a non-admin fetching the stock book got $PLAIN_STOCK_BOOK, expected 403"
ok "a non-admin staff account cannot fetch the stock book (403)"

PLAIN_STEPUP="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $PLAIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$PLAIN_PASSWORD\"}" | jval token)"
[ -n "$PLAIN_STEPUP" ] || fail "the non-admin staff account could not take a step-up token"
PLAIN_PHOTO="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $PLAIN_TOKEN" -H "X-Step-Up: $PLAIN_STEPUP" "$BASE/api/vault/id-photo/$ID_DOC_ID")"
[ "$PLAIN_PHOTO" = "403" ] || fail "a non-admin with a step-up token got $PLAIN_PHOTO on the ID photo, expected 403"
ok "a non-admin staff account cannot view an ID photo even with a step-up token (403)"

CROSS_STEPUP="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $PLAIN_STEPUP" "$BASE/api/vault/id-photo/$ID_DOC_ID")"
[ "$CROSS_STEPUP" = "403" ] || fail "an admin using another staff member's step-up token got $CROSS_STEPUP, expected 403"
ok "a step-up token minted for one staff member is rejected for another (403)"

# --- 15q. The ID check refuses to store a photo without the key ----------
# A second, throwaway server started with no GG_ID_PHOTO_KEY in its
# environment, since the key is read once when the process starts.
KEYLESS_DIR="$(mktemp -d)"
KEYLESS_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
KEYLESS_BASE="http://127.0.0.1:$KEYLESS_PORT"
"$PB" --dir "$KEYLESS_DIR" superuser upsert "$SUPER_EMAIL" "$SUPER_PASSWORD" >/dev/null
"$PB" serve \
  --dir "$KEYLESS_DIR" \
  --hooksDir "$HOOKS_DIR" \
  --hooksWatch=false \
  --migrationsDir "$MIGRATIONS_DIR" \
  --publicDir "$PUBLIC_DIR" \
  --http "127.0.0.1:$KEYLESS_PORT" \
  >"$KEYLESS_DIR/server.log" 2>&1 &
KEYLESS_PID=$!
keyless_healthy=""
for _ in $(seq 1 100); do
  if curl -s -o /dev/null "$KEYLESS_BASE/api/health"; then
    keyless_healthy=1
    break
  fi
  sleep 0.2
done
[ -n "$keyless_healthy" ] || fail "the keyless server never became healthy: $(cat "$KEYLESS_DIR/server.log")"

KEYLESS_SUPER_TOKEN="$(curl -s -X POST "$KEYLESS_BASE/api/collections/_superusers/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$SUPER_EMAIL\",\"password\":\"$SUPER_PASSWORD\"}" | jval token)"
curl -s -o /dev/null -X POST "$KEYLESS_BASE/api/collections/staff/records" \
  -H "Authorization: $KEYLESS_SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$STAFF_PASSWORD\",\"passwordConfirm\":\"$STAFF_PASSWORD\",\"name\":\"Keyless Admin\",\"role\":\"admin\",\"active\":true}"
KEYLESS_STAFF_TOKEN="$(curl -s -X POST "$KEYLESS_BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$STAFF_EMAIL\",\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
KEYLESS_CUSTOMER="$(curl -s -X POST "$KEYLESS_BASE/api/collections/customers/records" \
  -H "Authorization: $KEYLESS_STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Keyless Check","email":"keyless-check@local.test","source":"counter"}' | jval id)"
[ -n "$KEYLESS_CUSTOMER" ] || fail "could not create a customer on the keyless server"

KEYLESS_STATUS="$(curl -s -o "$KEYLESS_DIR/id-check.json" -w '%{http_code}' \
  -X POST "$KEYLESS_BASE/api/vault/customers/$KEYLESS_CUSTOMER/id-check" \
  -H "Authorization: $KEYLESS_STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/id.png;type=image/png" \
  -F "id_type=passport" -F "id_expiry=2030-06-30")"
[ "$KEYLESS_STATUS" = "500" ] || fail "the ID check without GG_ID_PHOTO_KEY returned $KEYLESS_STATUS, expected 500: $(cat "$KEYLESS_DIR/id-check.json")"
KEYLESS_ENC="$(find "$KEYLESS_DIR/storage" -name '*.enc' -type f 2>/dev/null | head -n1 || true)"
[ -z "$KEYLESS_ENC" ] || fail "the keyless server wrote an ID photo file anyway: $KEYLESS_ENC"
kill "$KEYLESS_PID" 2>/dev/null || true
wait "$KEYLESS_PID" 2>/dev/null || true
KEYLESS_PID=""
ok "the ID check refuses with 500 and stores nothing when GG_ID_PHOTO_KEY is unset"

# --- 15u. The stock book is one row per disposal plus the remainder ------
PART_ITEM="$(make_item "Part Sold Box" 3 400 1000)"
PART_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$PART_ITEM\",\"qty\":1,\"unit_price\":1000,\"discount\":0}],\"payment\":\"sumup_card\"}")"
[ "$(echo "$PART_SALE_JSON" | tail -n1)" = "200" ] || fail "the part-sale returned $(echo "$PART_SALE_JSON" | tail -n1): $(echo "$PART_SALE_JSON" | head -n -1)"
PART_SKU="$(curl -s "$BASE/api/collections/items/records/$PART_ITEM" -H "Authorization: $STAFF_TOKEN" | jval sku)"

curl -s -o "$TMP_DIR/stockbook2.csv" \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/exports/stock-book?from=$TODAY&to=$TODAY"
# The CSV is CRLF terminated (RFC 4180), so the line-anchored greps below
# read a copy with the carriage returns taken out.
tr -d '\r' <"$TMP_DIR/stockbook2.csv" >"$TMP_DIR/stockbook2.txt"

PART_ROWS="$(grep -c "^$PART_SKU," "$TMP_DIR/stockbook2.txt" || true)"
[ "$PART_ROWS" = "2" ] || fail "a box of 3 with 1 sold produced $PART_ROWS stock book rows, expected 2 (one sold, one remaining)"
grep "^$PART_SKU," "$TMP_DIR/stockbook2.txt" | grep -q ',4\.00,.*,10\.00,6\.00$' \
  || fail "no sold row of 4.00 cost / 10.00 sale / 6.00 margin for $PART_SKU: $(grep "^$PART_SKU," "$TMP_DIR/stockbook2.txt")"
grep "^$PART_SKU," "$TMP_DIR/stockbook2.txt" | grep -q ',8\.00,,,,$' \
  || fail "no remaining row of 8.00 cost with blank sale columns for $PART_SKU: $(grep "^$PART_SKU," "$TMP_DIR/stockbook2.txt")"
ok "the stock book writes one row per sale line plus one for the remaining stock"

# The refunded cash-sale item sold nothing in the end, so it is back to a
# single remaining row rather than a sold one.
CASH_SKU="$(curl -s "$BASE/api/collections/items/records/$CASH_ITEM" -H "Authorization: $STAFF_TOKEN" | jval sku)"
CASH_ROWS="$(grep -c "^$CASH_SKU," "$TMP_DIR/stockbook2.txt" || true)"
[ "$CASH_ROWS" = "1" ] || fail "the fully refunded item produced $CASH_ROWS stock book rows, expected 1"
grep "^$CASH_SKU," "$TMP_DIR/stockbook2.txt" | grep -q ',6\.00,,,,$' \
  || fail "the fully refunded item's row is not a remaining row: $(grep "^$CASH_SKU," "$TMP_DIR/stockbook2.txt")"
ok "a fully refunded sale line leaves no sold row in the stock book"

# -----------------------------------------------------------------------
# 16. The read-only config window and the two customer record operations.
# -----------------------------------------------------------------------
STEPUP_TOKEN="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
[ -n "$STEPUP_TOKEN" ] || fail "could not mint a step-up token for section 16"

# --- 16a. GET /api/vault/config -----------------------------------------
CONFIG_ANON="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/config")"
[ "$CONFIG_ANON" = "401" ] || [ "$CONFIG_ANON" = "403" ] || fail "/api/vault/config without auth returned $CONFIG_ANON, expected 401 or 403"
ok "/api/vault/config is refused without a staff token (got $CONFIG_ANON)"

CONFIG_STATUS="$(curl -s -o "$TMP_DIR/config.json" -w '%{http_code}' \
  -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/config")"
[ "$CONFIG_STATUS" = "200" ] || fail "an ordinary staff token got $CONFIG_STATUS from /api/vault/config: $(cat "$TMP_DIR/config.json")"
CONFIG_RULES="$(node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(String((JSON.parse(d).pricing_rules || []).length)));
' <"$TMP_DIR/config.json")"
[ "${CONFIG_RULES:-0}" -ge 1 ] || fail "/api/vault/config returned $CONFIG_RULES pricing rules to an ordinary staff member"
[ -n "$(jval "settings.cash_cap" <"$TMP_DIR/config.json")" ] || fail "/api/vault/config returned no settings.cash_cap"
[ -n "$(jval "settings.offer.minimumOffer" <"$TMP_DIR/config.json")" ] || fail "/api/vault/config did not decode settings.offer as JSON"
[ -n "$(jval "loyalty.programme.name" <"$TMP_DIR/config.json")" ] || fail "/api/vault/config returned no loyalty programme"
CONFIG_TIERS="$(node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(String(((JSON.parse(d).loyalty || {}).tiers || []).length)));
' <"$TMP_DIR/config.json")"
[ "${CONFIG_TIERS:-0}" -ge 3 ] || fail "/api/vault/config returned $CONFIG_TIERS loyalty tiers, expected the three seeded ones"
ok "/api/vault/config gives an ordinary staff member the pricing rules, settings and loyalty rows"

for SECRET_KEY in api_keys email_api_key push_vapid_private_key push_vapid_public_key; do
  grep -qF "$SECRET_KEY" "$TMP_DIR/config.json" && fail "/api/vault/config leaks the $SECRET_KEY field"
done
grep -qF "$SECRET_API_KEY" "$TMP_DIR/config.json" && fail "/api/vault/config leaks the stored email API key value"
ok "/api/vault/config carries no api_keys, mail key or VAPID key"

# --- 16b. The latest ID document, without the photo ----------------------
ID_DOC_LOOKUP="$(curl -s -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/customers/$SELLER_ID/id-document")"
[ "$(echo "$ID_DOC_LOOKUP" | jval "document.id")" = "$ID_DOC_ID" ] \
  || fail "the id-document lookup returned '$(echo "$ID_DOC_LOOKUP" | jval "document.id")', expected $ID_DOC_ID"
[ -n "$(echo "$ID_DOC_LOOKUP" | jval "document.expires_at")" ] || fail "the id-document lookup returned no expires_at"
echo "$ID_DOC_LOOKUP" | grep -qF "photo" && fail "the id-document lookup returned the photo field"
ok "the id-document lookup returns the latest document and never the photo"

EMPTY_DOC_CUSTOMER="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"No Document Check","email":"no-document-check@local.test","source":"counter"}' | jval id)"
EMPTY_DOC="$(curl -s -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/customers/$EMPTY_DOC_CUSTOMER/id-document" | jval document)"
[ -z "$EMPTY_DOC" ] || fail "a customer with no ID document returned '$EMPTY_DOC', expected null"
ok "a customer with no ID document on file returns null"

# --- 16c. Merging a duplicate customer -----------------------------------
DUPE_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Dupe Check","email":"dupe-check@local.test","phone":"+447700900001","source":"counter"}' | jval id)"
KEEP_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Keep Check","email":"keep-check@local.test","source":"counter"}' | jval id)"
[ -n "$DUPE_ID" ] && [ -n "$KEEP_ID" ] || fail "could not create the merge check customers"

DUPE_PRIVATE="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$DUPE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/customer_private/records/$DUPE_PRIVATE" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"address":"9 Sherwood Lodge, Bolsover, S44 6AB","dob":"1979-02-02","flags":["watchlist"],"notes":"Collects vintage Pokemon.","id_status":"verified","id_type":"driving_licence","id_expiry":"2032-02-02","id_ref_last4":"7777"}'

curl -s -o /dev/null -X POST "$BASE/api/collections/credit_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"amount\":1000,\"reason\":\"adjustment\",\"ref\":\"merge check\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/points_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"delta\":300,\"reason\":\"adjust\",\"ref\":\"merge check\"}"
DUPE_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/notifications/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"type\":\"quote_offer\",\"title\":\"Merge check\",\"body\":\"Body\"}"
# push_subscriptions createRule only lets a caller create their own row, so
# these go in as the superuser.
curl -s -o /dev/null -X POST "$BASE/api/collections/push_subscriptions/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"endpoint\":\"https://push.example.test/merge-check\"}"

# perk_usage has a unique index on (customer, perk_type, period): the shared
# September row has to be summed into the kept record's, and the row it has
# no counterpart for has to move across whole.
curl -s -o /dev/null -X POST "$BASE/api/collections/perk_usage/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"perk_type\":\"free_event_entries\",\"period\":\"2026-09\",\"used_count\":2}"
curl -s -o /dev/null -X POST "$BASE/api/collections/perk_usage/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$DUPE_ID\",\"perk_type\":\"lounge_hours\",\"period\":\"2026-09\",\"used_count\":3}"
curl -s -o /dev/null -X POST "$BASE/api/collections/perk_usage/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$KEEP_ID\",\"perk_type\":\"free_event_entries\",\"period\":\"2026-09\",\"used_count\":1}"

MERGE_SELF="$(curl -s -o "$TMP_DIR/merge-self.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$DUPE_ID/merge" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d "{\"into\":\"$DUPE_ID\"}")"
[ "$MERGE_SELF" = "409" ] || fail "merging a customer into itself returned $MERGE_SELF, expected 409: $(cat "$TMP_DIR/merge-self.json")"
MERGE_MISSING="$(curl -s -o "$TMP_DIR/merge-missing.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$DUPE_ID/merge" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"into":"doesnotexist0000"}')"
[ "$MERGE_MISSING" = "404" ] || fail "merging into a missing customer returned $MERGE_MISSING, expected 404: $(cat "$TMP_DIR/merge-missing.json")"
MERGE_NO_STEPUP="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$DUPE_ID/merge" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"into\":\"$KEEP_ID\"}")"
[ "$MERGE_NO_STEPUP" = "403" ] || fail "merging without a step-up token returned $MERGE_NO_STEPUP, expected 403"
ok "a merge is refused on itself (409), on a missing record (404) and without step-up (403)"

MERGE_STATUS="$(curl -s -o "$TMP_DIR/merge.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$DUPE_ID/merge" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d "{\"into\":\"$KEEP_ID\"}")"
[ "$MERGE_STATUS" = "200" ] || fail "the merge returned $MERGE_STATUS: $(cat "$TMP_DIR/merge.json")"
[ "$(jval "customer.id" <"$TMP_DIR/merge.json")" = "$KEEP_ID" ] || fail "the merge returned the wrong customer"
for MOVED_KEY in trade_ins credit_ledger push_subscriptions; do
  [ "$(jval "moved.$MOVED_KEY" <"$TMP_DIR/merge.json")" = "1" ] \
    || fail "the merge moved '$(jval "moved.$MOVED_KEY" <"$TMP_DIR/merge.json")' $MOVED_KEY rows, expected 1"
done
# Two points rows: the 300 seeded above and the duplicate's own 100 welcome
# bonus (Phase 6). Two notifications: the one seeded above and the "you are
# now a Member" the welcome bonus's tier promotion wrote.
[ "$(jval "moved.points_ledger" <"$TMP_DIR/merge.json")" = "2" ] \
  || fail "the merge moved '$(jval "moved.points_ledger" <"$TMP_DIR/merge.json")' points_ledger rows, expected 2"
[ "$(jval "moved.notifications" <"$TMP_DIR/merge.json")" = "2" ] \
  || fail "the merge moved '$(jval "moved.notifications" <"$TMP_DIR/merge.json")' notifications rows, expected 2"
[ "$(jval "moved.perk_usage" <"$TMP_DIR/merge.json")" = "2" ] \
  || fail "the merge moved '$(jval "moved.perk_usage" <"$TMP_DIR/merge.json")' perk_usage rows, expected 2"
DUPE_AFTER="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/customers/records/$DUPE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$DUPE_AFTER" = "404" ] || fail "the duplicate customer is still there after the merge (got $DUPE_AFTER)"
MERGED_TRADE_CUSTOMER="$(curl -s "$BASE/api/collections/trade_ins/records/$DUPE_TRADE_ID" -H "Authorization: $STAFF_TOKEN" | jval customer)"
[ "$MERGED_TRADE_CUSTOMER" = "$KEEP_ID" ] || fail "the duplicate's trade-in still points at '$MERGED_TRADE_CUSTOMER'"
ok "a merge re-points every relation and deletes the duplicate"

KEEP_PRIVATE_JSON="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$KEEP_ID%22" \
  -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$KEEP_PRIVATE_JSON" | jval totalItems)" = "1" ] || fail "the kept customer has $(echo "$KEEP_PRIVATE_JSON" | jval totalItems) customer_private rows, expected 1"
[ "$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.credit_balance")" = "1000" ] \
  || fail "the kept customer's credit balance is '$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.credit_balance")', expected 1000"
# 300 seeded on the duplicate, plus a 100 welcome bonus each (Phase 6).
[ "$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.points_balance")" = "500" ] \
  || fail "the kept customer's points balance is '$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.points_balance")', expected 500"
[ "$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.address")" = "9 Sherwood Lodge, Bolsover, S44 6AB" ] \
  || fail "the merge did not fill the kept customer's empty address"
[ "$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.id_status")" = "verified" ] \
  || fail "the merge did not carry the duplicate's verified ID over to a record that had none"
echo "$KEEP_PRIVATE_JSON" | grep -q "watchlist" || fail "the merge did not union the duplicate's flags"
echo "$KEEP_PRIVATE_JSON" | grep -q "vintage Pokemon" || fail "the merge did not append the duplicate's notes"
ok "a merge fills the kept record's gaps and recomputes its balances"

KEEP_PERKS="$(curl -s "$BASE/api/collections/perk_usage/records?perPage=50&sort=perk_type&filter=customer%3D%22$KEEP_ID%22" \
  -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$KEEP_PERKS" | jval totalItems)" = "2" ] \
  || fail "the kept customer has $(echo "$KEEP_PERKS" | jval totalItems) perk_usage rows, expected 2"
[ "$(echo "$KEEP_PERKS" | jval "items.0.perk_type")" = "free_event_entries" ] \
  || fail "unexpected first perk_usage row: $(echo "$KEEP_PERKS" | jval "items.0.perk_type")"
[ "$(echo "$KEEP_PERKS" | jval "items.0.used_count")" = "3" ] \
  || fail "the shared perk month came to '$(echo "$KEEP_PERKS" | jval "items.0.used_count")', expected 1 + 2 = 3"
[ "$(echo "$KEEP_PERKS" | jval "items.1.used_count")" = "3" ] \
  || fail "the duplicate's unmatched perk row came over as '$(echo "$KEEP_PERKS" | jval "items.1.used_count")', expected 3"
ORPHAN_PERKS="$(curl -s "$BASE/api/collections/perk_usage/records?filter=customer%3D%22$DUPE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$ORPHAN_PERKS" = "0" ] || fail "the duplicate still has $ORPHAN_PERKS perk_usage rows after the merge"
ok "a merge sums perk_usage for a shared perk and month and moves the rest across"

# --- 16d. Erasing a customer ---------------------------------------------
ERASE_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Erase Check","email":"erase-check@local.test","phone":"+447700900002","marketing_consent":true,"birthday_month":4,"source":"counter"}' | jval id)"
ERASE_PRIVATE="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$ERASE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$ERASE_ID" ] && [ -n "$ERASE_PRIVATE" ] || fail "could not create the erase check customer"

ERASE_DOC="$(curl -s -X POST "$BASE/api/vault/customers/$ERASE_ID/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/id.png;type=image/png" \
  -F "id_type=passport" -F "id_expiry=2032-06-30" -F "id_ref_last4=5555" \
  -F "dob=1991-11-11" -F "address=7 Hockley Lane, Bolsover, S44 6QT" | jval id_document)"
[ -n "$ERASE_DOC" ] || fail "could not take an ID photo for the erase check customer"

curl -s -o /dev/null -X POST "$BASE/api/collections/want_list/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$ERASE_ID\",\"free_text\":\"Base Set Charizard\",\"status\":\"open\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/notifications/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$ERASE_ID\",\"type\":\"quote_offer\",\"title\":\"Erase check\",\"body\":\"Body\"}"
ERASE_VOUCHER="$(curl -s -X POST "$BASE/api/collections/reward_redemptions/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$ERASE_ID\",\"reward\":\"$MONEY_OFF_REWARD\",\"points_spent\":500,\"status\":\"issued\",\"expires_at\":\"2031-01-01 00:00:00.000Z\"}" | jval id)"

# A completed credit buy-in, so there is both a store credit balance in the
# way and a seller snapshot that has to survive the erasure.
ERASE_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$ERASE_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$ERASE_TRADE_ID\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Erase Check Bundle\",\"qty\":1,\"market_price\":2500,\"market_currency\":\"GBP\",\"offer_price\":1500,\"accepted\":true}"
ERASE_COMPLETE="$(curl -s -o "$TMP_DIR/erase-buyin.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$ERASE_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":1500,"terms_accepted":true}')"
[ "$ERASE_COMPLETE" = "200" ] || fail "the erase check buy-in returned $ERASE_COMPLETE: $(cat "$TMP_DIR/erase-buyin.json")"

ERASE_NOT_ADMIN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/customers/$ERASE_ID/erase" \
  -H "Authorization: $PLAIN_TOKEN" -H "X-Step-Up: $PLAIN_STEPUP" -H "Content-Type: application/json" -d '{}')"
[ "$ERASE_NOT_ADMIN" = "403" ] || fail "a non-admin erasing a customer returned $ERASE_NOT_ADMIN, expected 403"
ok "only an admin can erase a customer (403)"

ERASE_WITH_CREDIT="$(curl -s -o "$TMP_DIR/erase-credit.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$ERASE_ID/erase" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$ERASE_WITH_CREDIT" = "422" ] || fail "erasing a customer with store credit returned $ERASE_WITH_CREDIT, expected 422: $(cat "$TMP_DIR/erase-credit.json")"
grep -q '£15.00' "$TMP_DIR/erase-credit.json" || fail "the erase refusal does not name the £15.00 balance: $(cat "$TMP_DIR/erase-credit.json")"
ok "erasing a customer who still holds store credit is refused with 422"

curl -s -o /dev/null -X POST "$BASE/api/collections/credit_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$ERASE_ID\",\"amount\":-1500,\"reason\":\"adjustment\",\"ref\":\"written off before erasure\"}"

ERASE_STATUS="$(curl -s -o "$TMP_DIR/erase.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/customers/$ERASE_ID/erase" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STEPUP_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$ERASE_STATUS" = "200" ] || fail "the erasure returned $ERASE_STATUS: $(cat "$TMP_DIR/erase.json")"
[ "$(jval erased <"$TMP_DIR/erase.json")" = "true" ] || fail "the erasure did not report erased: true"
[ "$(jval "customer.name" <"$TMP_DIR/erase.json")" = "Erased customer" ] || fail "the erased customer is still called '$(jval "customer.name" <"$TMP_DIR/erase.json")'"
[ -z "$(jval "customer.email" <"$TMP_DIR/erase.json")" ] || fail "the erased customer still has an email"
[ -n "$(jval "customer.code" <"$TMP_DIR/erase.json")" ] || fail "the erasure dropped the customer code"
grep -qF "erase-check@local.test" "$TMP_DIR/erase.json" && fail "the erase response still carries the old email"
grep -qiE '"(password|tokenKey|passwordHash)"' "$TMP_DIR/erase.json" && fail "the erase response leaks an auth secret"
ok "erasing a customer anonymises the record and keeps their code"

ERASED_PRIVATE="$(curl -s "$BASE/api/collections/customer_private/records/$ERASE_PRIVATE" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$ERASED_PRIVATE" | jval id_status)" = "none" ] || fail "the erased customer_private id_status is '$(echo "$ERASED_PRIVATE" | jval id_status)'"
[ -z "$(echo "$ERASED_PRIVATE" | jval address)" ] || fail "the erased customer_private still has an address"
[ -z "$(echo "$ERASED_PRIVATE" | jval dob)" ] || fail "the erased customer_private still has a date of birth"
ERASED_DOC_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/id_documents/records/$ERASE_DOC" -H "Authorization: $SUPER_TOKEN")"
[ "$ERASED_DOC_STATUS" = "404" ] || fail "the erased customer's ID document is still there (got $ERASED_DOC_STATUS)"
ERASED_WANT_LIST="$(curl -s "$BASE/api/collections/want_list/records?filter=customer%3D%22$ERASE_ID%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$ERASED_WANT_LIST" = "0" ] || fail "the erased customer still has $ERASED_WANT_LIST want_list rows"
ERASED_VOUCHER_STATUS="$(curl -s "$BASE/api/collections/reward_redemptions/records/$ERASE_VOUCHER" -H "Authorization: $STAFF_TOKEN" | jval status)"
[ "$ERASED_VOUCHER_STATUS" = "cancelled" ] || fail "the erased customer's open voucher is '$ERASED_VOUCHER_STATUS', expected cancelled"
ok "erasing a customer clears their private row, ID photos, lists and open vouchers"

ERASED_TRADE="$(curl -s "$BASE/api/collections/trade_ins/records/$ERASE_TRADE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$ERASED_TRADE" | jval seller_name)" = "Erase Check" ] \
  || fail "the buy-in's seller snapshot reads '$(echo "$ERASED_TRADE" | jval seller_name)', expected the name as it was at the time"
[ "$(echo "$ERASED_TRADE" | jval status)" = "completed" ] || fail "the erasure changed the buy-in's status"
ok "the six-year buy-in register keeps its seller snapshot through an erasure"

# -----------------------------------------------------------------------
# 17. The retention cron, triggered through PocketBase's own superuser
#     cron endpoint.
#
#     PocketBase stores a date as "2026-09-20 12:00:00.000Z" and compares
#     it as text, so an ISO cutoff with a "T" sorts above every same-day
#     timestamp (space is 0x20, "T" is 0x54) and would purge a photo that
#     expires later today. The cutoffs are written in the stored form, and
#     the two rows below are exactly that boundary case.
# -----------------------------------------------------------------------
EXPIRED_DOC="$(curl -s -X POST "$BASE/api/collections/id_documents/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$SELLER_ID\",\"taken_at\":\"2020-01-01 00:00:00.000Z\",\"expires_at\":\"2020-01-01 00:00:00.000Z\"}" | jval id)"
LIVE_DOC="$(curl -s -X POST "$BASE/api/collections/id_documents/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$SELLER_ID\",\"taken_at\":\"$TODAY 00:00:00.000Z\",\"expires_at\":\"$TODAY 23:59:00.000Z\"}" | jval id)"
[ -n "$EXPIRED_DOC" ] && [ -n "$LIVE_DOC" ] || fail "could not create the retention check id_documents rows"

CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: $SUPER_TOKEN" "$BASE/api/crons/retention")"
case "$CRON_STATUS" in
  20*) : ;;
  *) fail "triggering the retention cron returned $CRON_STATUS" ;;
esac

EXPIRED_GONE=""
for _ in $(seq 1 20); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/id_documents/records/$EXPIRED_DOC" -H "Authorization: $SUPER_TOKEN")" = "404" ]; then
    EXPIRED_GONE=1
    break
  fi
  sleep 0.2
done
[ -n "$EXPIRED_GONE" ] || fail "the retention cron left an id_documents row whose expires_at passed in 2020"
ok "the retention cron deletes an ID document whose expiry has passed"

LIVE_STILL="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/id_documents/records/$LIVE_DOC" -H "Authorization: $SUPER_TOKEN")"
[ "$LIVE_STILL" = "200" ] || fail "the retention cron deleted an ID document that expires later today (got $LIVE_STILL) - is the cutoff being formatted with a T?"
ok "the retention cron keeps an ID document that expires later the same day"

RETENTION_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22retention_delete%22" \
  -H "Authorization: $SUPER_TOKEN")"
[ "$(echo "$RETENTION_AUDIT" | jval totalItems)" -ge 1 ] || fail "the retention purge wrote no audit row"
echo "$RETENTION_AUDIT" | grep -qF "$EXPIRED_DOC" || fail "the retention audit row does not name the deleted document"
ok "the retention purge is audited by record id"

# -----------------------------------------------------------------------
# 18. Bulk lots and overridden lines.
# -----------------------------------------------------------------------

# --- 18a. A bulk lot completes as one ordinary stock line ----------------
# The wizard sends a lot as a single "other" line of qty 1 with a flat
# figure in both offer_price and market_price, so nothing downstream has to
# know it is a lot.
LOT_SELLER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Bulk Lot Check","email":"bulk-lot-check@local.test","source":"counter"}' | jval id)"
LOT_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$LOT_SELLER_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
LOT_LINE_JSON="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$LOT_TRADE_ID\",\"kind\":\"other\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Bulk lot, 400 cards\",\"qty\":1,\"market_price\":5000,\"market_currency\":\"GBP\",\"market_source\":\"Bulk lot\",\"offer_price\":5000,\"accepted\":true}")"
LOT_LINE_ID="$(echo "$LOT_LINE_JSON" | jval id)"
[ -n "$LOT_LINE_ID" ] || fail "could not create the bulk lot line (is \"other\" in trade_in_lines.kind?): $LOT_LINE_JSON"

LOT_STATUS="$(curl -s -o "$TMP_DIR/lot.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$LOT_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":5000,"terms_accepted":true}')"
[ "$LOT_STATUS" = "200" ] || fail "completing a bulk lot at its flat figure returned $LOT_STATUS: $(cat "$TMP_DIR/lot.json")"

LOT_ITEM_COUNT="$(node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(String((JSON.parse(d).items || []).length)));
' <"$TMP_DIR/lot.json")"
[ "$LOT_ITEM_COUNT" = "1" ] || fail "a bulk lot created $LOT_ITEM_COUNT items, expected 1"
[ "$(jval labels_queued <"$TMP_DIR/lot.json")" = "1" ] || fail "a bulk lot queued $(jval labels_queued <"$TMP_DIR/lot.json") labels, expected 1"
[ "$(jval credit_balance <"$TMP_DIR/lot.json")" = "5000" ] || fail "a bulk lot paid '$(jval credit_balance <"$TMP_DIR/lot.json")' in credit, expected 5000"

LOT_ITEM_ID="$(jval "items.0.id" <"$TMP_DIR/lot.json")"
LOT_ITEM_JSON="$(curl -s "$BASE/api/collections/items/records/$LOT_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$LOT_ITEM_JSON" | jval kind)" = "other" ] || fail "the lot's item kind is '$(echo "$LOT_ITEM_JSON" | jval kind)', expected other"
[ "$(echo "$LOT_ITEM_JSON" | jval qty)" = "1" ] || fail "the lot's item qty is '$(echo "$LOT_ITEM_JSON" | jval qty)', expected 1"
[ "$(echo "$LOT_ITEM_JSON" | jval cost)" = "5000" ] || fail "the lot's item cost is '$(echo "$LOT_ITEM_JSON" | jval cost)', expected 5000"
[ "$(echo "$LOT_ITEM_JSON" | jval title)" = "Bulk lot, 400 cards" ] || fail "the lot's item title is '$(echo "$LOT_ITEM_JSON" | jval title)'"
echo "$(echo "$LOT_ITEM_JSON" | jval sku)" | grep -Eq '^GG[SGRPAX][0-9A-HJKMNP-TV-Z]{6}$' || fail "the lot's item has no valid SKU"
ok "a bulk lot completes as one 'other' item of qty 1 with one label"

LOT_MISMATCH="$(curl -s -o "$TMP_DIR/lot-mismatch.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$LOT_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":4000,"terms_accepted":true}')"
[ "$LOT_MISMATCH" = "409" ] || fail "re-completing the lot returned $LOT_MISMATCH, expected 409: $(cat "$TMP_DIR/lot-mismatch.json")"
ok "a completed bulk lot cannot be completed again"

LOT_RECEIPT="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/trade-ins/$LOT_TRADE_ID/receipt")"
[ "$(echo "$LOT_RECEIPT" | jval "lines.0.title")" = "Bulk lot, 400 cards" ] || fail "the lot's receipt line reads '$(echo "$LOT_RECEIPT" | jval "lines.0.title")'"
[ "$(echo "$LOT_RECEIPT" | jval "lines.0.line_total")" = "5000" ] || fail "the lot's receipt line total is '$(echo "$LOT_RECEIPT" | jval "lines.0.line_total")', expected 5000"

curl -s -o "$TMP_DIR/stockbook3.csv" \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/exports/stock-book?from=$TODAY&to=$TODAY"
tr -d '\r' <"$TMP_DIR/stockbook3.csv" >"$TMP_DIR/stockbook3.txt"
LOT_SKU="$(echo "$LOT_ITEM_JSON" | jval sku)"
grep "^$LOT_SKU," "$TMP_DIR/stockbook3.txt" | grep -q '"Bulk lot, 400 cards",50\.00,,,,$' \
  || fail "the lot is not an ordinary unsold row in the stock book: $(grep "^$LOT_SKU," "$TMP_DIR/stockbook3.txt")"
ok "a bulk lot reads as an ordinary line on the receipt and in the stock book"

# --- 18b. An overridden line, and a retro line's cosmetic grade ----------
OVERRIDE_SELLER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Override Check","email":"override-check@local.test","source":"counter"}' | jval id)"
RETRO_GAME_ID="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27retro%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$RETRO_GAME_ID" ] || fail "seeded game 'retro' not found"
OVERRIDE_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$OVERRIDE_SELLER_ID\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"

OVERRIDE_REASON="Box is water damaged but the disc is mint"
OVERRIDE_LINE_JSON="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$OVERRIDE_TRADE_ID\",\"kind\":\"retro\",\"game\":\"$RETRO_GAME_ID\",\"free_text_title\":\"Zelda Ocarina of Time\",\"completeness\":\"cib\",\"cosmetic_grade\":\"B\",\"qty\":1,\"market_price\":6000,\"market_currency\":\"GBP\",\"offer_price\":2000,\"override_reason\":\"$OVERRIDE_REASON\",\"override_cash\":2000,\"override_credit\":2600,\"accepted\":true}")"
OVERRIDE_LINE_ID="$(echo "$OVERRIDE_LINE_JSON" | jval id)"
[ -n "$OVERRIDE_LINE_ID" ] || fail "could not create the overridden line: $OVERRIDE_LINE_JSON"
[ "$(echo "$OVERRIDE_LINE_JSON" | jval cosmetic_grade)" = "B" ] || fail "trade_in_lines.cosmetic_grade did not stick"
[ "$(echo "$OVERRIDE_LINE_JSON" | jval override_credit)" = "2600" ] || fail "trade_in_lines.override_credit did not stick"

# A plain line alongside it, so the audit meta has to name only the one.
PLAIN_LINE_ID="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$OVERRIDE_TRADE_ID\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Sealed Booster Box\",\"qty\":1,\"market_price\":8000,\"market_currency\":\"GBP\",\"offer_price\":5000,\"accepted\":true}" | jval id)"
[ -n "$PLAIN_LINE_ID" ] || fail "could not create the plain line beside the overridden one"

OVERRIDE_STATUS="$(curl -s -o "$TMP_DIR/override.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/trade-ins/$OVERRIDE_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":7000,"terms_accepted":true}')"
[ "$OVERRIDE_STATUS" = "200" ] || fail "the overridden buy-in returned $OVERRIDE_STATUS: $(cat "$TMP_DIR/override.json")"

# offer_price is still what is paid, overridden or not: 2000 + 5000.
[ "$(jval "trade_in.payout_credit" <"$TMP_DIR/override.json")" = "7000" ] \
  || fail "the overridden buy-in paid '$(jval "trade_in.payout_credit" <"$TMP_DIR/override.json")', expected 7000"

RETRO_ITEM_ID="$(curl -s "$BASE/api/collections/items/records?filter=trade_in_line%3D%22$OVERRIDE_LINE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$RETRO_ITEM_ID" ] || fail "no item was created for the overridden retro line"
RETRO_ITEM_JSON="$(curl -s "$BASE/api/collections/items/records/$RETRO_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$RETRO_ITEM_JSON" | jval cosmetic_grade)" = "B" ] \
  || fail "items.cosmetic_grade is '$(echo "$RETRO_ITEM_JSON" | jval cosmetic_grade)', expected B from the line"
[ "$(echo "$RETRO_ITEM_JSON" | jval cost)" = "2000" ] || fail "the overridden item's cost is not the offer_price"
ok "a retro line's cosmetic grade is copied onto its item"

# The sealed line is not retro, so it carries no cosmetic grade.
SEALED_ITEM_GRADE="$(curl -s "$BASE/api/collections/items/records?filter=trade_in_line%3D%22$PLAIN_LINE_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval "items.0.cosmetic_grade")"
[ -z "$SEALED_ITEM_GRADE" ] || fail "a sealed item picked up a cosmetic grade ('$SEALED_ITEM_GRADE')"
ok "a non-retro line's item carries no cosmetic grade"

OVERRIDE_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22trade_in_complete%22%26%26record%3D%22$OVERRIDE_TRADE_ID%22" \
  -H "Authorization: $SUPER_TOKEN")"
echo "$OVERRIDE_AUDIT" | grep -qF "$OVERRIDE_LINE_ID" || fail "the audit meta does not list the overridden line id: $OVERRIDE_AUDIT"
echo "$OVERRIDE_AUDIT" | grep -qF "$PLAIN_LINE_ID" && fail "the audit meta names a line that was not overridden"
echo "$OVERRIDE_AUDIT" | grep -qF "water damaged" && fail "the override reason reached audit_log; it belongs on the line row only"
ok "the audit meta lists the overridden line ids and never the reason"

# -----------------------------------------------------------------------
# 19. Phase 3: lookup, prices and FX. The server was started above with
#     GG_ADAPTER_TRANSPORT_MODE=fixture (pb_hooks/adapters/http.js,
#     pb_hooks/adapters/fixture_transport.js): every adapter call this
#     section makes gets a canned answer from pb_hooks/adapters/fixtures/,
#     the same recorded/hand-written fixtures pb/scripts/check-adapters.mjs
#     unit-tests each adapter against, so these checks exercise the real
#     routes end to end - the write-through into cards/card_sets, the GBP
#     conversion, the audit row - without a real network call anywhere. A
#     URL fixture_transport.js has no mapping for still throws exactly the
#     way GG_ADAPTER_TRANSPORT_MODE=offline_fail always has, so a route
#     this build never intended to call out from still fails loudly here
#     rather than silently reaching the real network.
# -----------------------------------------------------------------------

# --- 19a. GET /api/vault/fx reports stale with no rows at all -----------
# Nothing anywhere in this script writes to fx_rates (that is the daily
# cron's job - crons.pb.js), so this holds wherever it runs.
FX_EMPTY_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/fx")"
[ "$(echo "$FX_EMPTY_JSON" | jval stale)" = "true" ] || fail "GET /api/vault/fx with no fx_rates rows did not report stale: $FX_EMPTY_JSON"
[ "$(echo "$FX_EMPTY_JSON" | jval fetched_at)" = "" ] || fail "GET /api/vault/fx with no fx_rates rows returned a fetched_at: $FX_EMPTY_JSON"
[ "$(echo "$FX_EMPTY_JSON" | jval base)" = "GBP" ] || fail "GET /api/vault/fx did not default base to GBP: $FX_EMPTY_JSON"
ok "GET /api/vault/fx reports stale with an empty rates object when no fx_rates row exists"

# --- 19b. The lookup route serves a fresh card straight from the database,
#     with no outbound call at all -----------------------------------
P3_SET_ID="$(curl -s -X POST "$BASE/api/collections/card_sets/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"code\":\"p3-fresh-set\",\"name\":\"Phase 3 Fresh Set\"}" | jval id)"
[ -n "$P3_SET_ID" ] || fail "could not create the Phase 3 check's card_sets row"

NOW_ISO="$(node -e 'process.stdout.write(new Date().toISOString())')"
P3_FRESH_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"199\",\"name\":\"Cached Charizard\",\"last_synced\":\"$NOW_ISO\"}" | jval id)"
[ -n "$P3_FRESH_CARD_ID" ] || fail "could not create the Phase 3 check's fresh cards row"

LOOKUP_RESP="$(curl -s -w '\n%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup/pokemon/p3-fresh-set/199")"
LOOKUP_STATUS="$(echo "$LOOKUP_RESP" | tail -n1)"
LOOKUP_BODY="$(echo "$LOOKUP_RESP" | sed '$d')"
[ "$LOOKUP_STATUS" = "200" ] || fail "a fresh cached lookup returned $LOOKUP_STATUS, expected 200 (did it try to call out to a URL fixture_transport.js has no mapping for?): $LOOKUP_BODY"
[ "$(echo "$LOOKUP_BODY" | jval "cards.0.id")" = "$P3_FRESH_CARD_ID" ] || fail "the cached lookup did not return the expected card: $LOOKUP_BODY"
[ "$(echo "$LOOKUP_BODY" | jval "cards.0.set_name")" = "Phase 3 Fresh Set" ] || fail "the cached lookup row is missing its set_name: $LOOKUP_BODY"
ok "the lookup route serves a card whose last_synced is fresh straight from the database, with no outbound call"

# The free-text search's "set number" form goes through the exact same
# cached path (registry.js's parseSetNumberQuery), so it must be equally
# network-free for a fresh row.
LOOKUP_Q_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup?game=pokemon&q=p3-fresh-set%20199")"
[ "$(echo "$LOOKUP_Q_JSON" | jval "cards.0.id")" = "$P3_FRESH_CARD_ID" ] || fail "the 'set number' search form did not hit the cache: $LOOKUP_Q_JSON"
ok "a 'set number' search query uses the same cache-first path as the exact lookup route"

# --- 19c. uk-comp writes a price_snapshots row and is chosen first ------
P3_UKCOMP_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"200\",\"name\":\"UK Comp Card\"}" | jval id)"

UKCOMP_BAD_URL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/cards/$P3_UKCOMP_CARD_ID/uk-comp" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"finish\":\"holo\",\"condition\":\"NM\",\"price\":5000,\"url\":\"https://www.ebay.com/itm/123\",\"sold_at\":\"$TODAY\"}")"
[ "$UKCOMP_BAD_URL_STATUS" = "400" ] || fail "a non-ebay.co.uk uk-comp url returned $UKCOMP_BAD_URL_STATUS, expected 400"
UKCOMP_OLD_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/cards/$P3_UKCOMP_CARD_ID/uk-comp" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"finish\":\"holo\",\"condition\":\"NM\",\"price\":5000,\"url\":\"https://www.ebay.co.uk/itm/123\",\"sold_at\":\"2020-01-01\"}")"
[ "$UKCOMP_OLD_STATUS" = "400" ] || fail "a uk-comp sold more than 30 days ago returned $UKCOMP_OLD_STATUS, expected 400"
ok "uk-comp refuses a non-ebay.co.uk url and a sale older than 30 days, both with 400"

UKCOMP_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/cards/$P3_UKCOMP_CARD_ID/uk-comp" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"finish\":\"holo\",\"condition\":\"NM\",\"price\":5000,\"url\":\"https://www.ebay.co.uk/itm/123456789012\",\"sold_at\":\"$TODAY\"}")"
UKCOMP_STATUS="$(echo "$UKCOMP_RESP" | tail -n1)"
UKCOMP_BODY="$(echo "$UKCOMP_RESP" | sed '$d')"
[ "$UKCOMP_STATUS" = "200" ] || fail "uk-comp returned $UKCOMP_STATUS, expected 200: $UKCOMP_BODY"
[ "$(echo "$UKCOMP_BODY" | jval "chosen.source")" = "uk_sold_manual" ] || fail "uk-comp was not chosen first: $UKCOMP_BODY"
[ "$(echo "$UKCOMP_BODY" | jval "chosen.gbp_market")" = "5000" ] || fail "uk-comp's chosen gbp_market is '$(echo "$UKCOMP_BODY" | jval "chosen.gbp_market")', expected 5000"
[ "$(echo "$UKCOMP_BODY" | jval "chosen.native_currency")" = "GBP" ] || fail "uk-comp's native_currency is not GBP: $UKCOMP_BODY"
[ "$(echo "$UKCOMP_BODY" | jval "chosen.evidence_url")" = "https://www.ebay.co.uk/itm/123456789012" ] || fail "uk-comp did not keep the listing's evidence_url"

UKCOMP_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22uk_comp%22" -H "Authorization: $SUPER_TOKEN")"
echo "$UKCOMP_AUDIT" | grep -qF "$P3_UKCOMP_CARD_ID" || fail "the uk-comp audit row does not name the card: $UKCOMP_AUDIT"
ok "uk-comp writes a price_snapshots row, is chosen first ahead of every other source, and is audited"

# --- 19d. The prices route converts a foreign amount and puts the GBP ---
#     figure beside it, and flags a stale row rather than hiding it ------
P3_GBP_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"201\",\"name\":\"Native Beside GBP Card\"}" | jval id)"
NOW_ISO_2="$(node -e 'process.stdout.write(new Date().toISOString())')"
curl -s -o /dev/null -X POST "$BASE/api/collections/price_snapshots/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"card\":\"$P3_GBP_CARD_ID\",\"finish\":\"\",\"source\":\"cardmarket\",\"native_currency\":\"EUR\",\"native_low\":1500,\"native_mid\":1600,\"native_market\":1650,\"native_trend\":1700,\"fx_rate\":0.8606,\"fx_date\":\"$TODAY\",\"gbp_market\":1420,\"fetched_at\":\"$NOW_ISO_2\",\"evidence_url\":\"\"}"

PRICES_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cards/$P3_GBP_CARD_ID/prices")"
[ "$(echo "$PRICES_JSON" | jval "chosen.source")" = "cardmarket" ] || fail "the prices route did not choose the only source available: $PRICES_JSON"
[ "$(echo "$PRICES_JSON" | jval "chosen.native_currency")" = "EUR" ] || fail "the prices route lost the native currency: $PRICES_JSON"
[ "$(echo "$PRICES_JSON" | jval "chosen.native_market")" = "1650" ] || fail "the prices route lost the native amount: $PRICES_JSON"
[ "$(echo "$PRICES_JSON" | jval "chosen.gbp_market")" = "1420" ] || fail "the prices route did not put a GBP figure beside the native amount: $PRICES_JSON"
[ "$(echo "$PRICES_JSON" | jval "chosen.stale")" = "false" ] || fail "a snapshot fetched moments ago was flagged stale: $PRICES_JSON"
ok "the prices route returns the native amount with its GBP conversion beside it"

P3_STALE_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"202\",\"name\":\"Stale Row Card\"}" | jval id)"
TEN_DAYS_AGO_ISO="$(node -e 'const d = new Date(); d.setUTCDate(d.getUTCDate() - 10); process.stdout.write(d.toISOString())')"
curl -s -o /dev/null -X POST "$BASE/api/collections/price_snapshots/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"card\":\"$P3_STALE_CARD_ID\",\"finish\":\"\",\"source\":\"cardmarket\",\"native_currency\":\"EUR\",\"native_market\":1000,\"fx_rate\":0.86,\"fx_date\":\"$TODAY\",\"gbp_market\":860,\"fetched_at\":\"$TEN_DAYS_AGO_ISO\",\"evidence_url\":\"\"}"

STALE_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cards/$P3_STALE_CARD_ID/prices")"
[ "$(echo "$STALE_JSON" | jval "sources.0.source")" = "cardmarket" ] || fail "the stale-row check did not find its cardmarket source: $STALE_JSON"
[ "$(echo "$STALE_JSON" | jval "sources.0.stale")" = "true" ] || fail "a cardmarket row 10 days old was not flagged stale (3-day freshness window): $STALE_JSON"
[ "$(echo "$STALE_JSON" | jval "sources.0.gbp_market")" = "860" ] || fail "a stale row's figure was hidden rather than returned: $STALE_JSON"
ok "a price past its source's freshness window is flagged stale rather than hidden"

# --- 19e. The Batch API is on, so the nightly pricesync needs no manual step
BATCH_SETTINGS_JSON="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/settings")"
[ "$(echo "$BATCH_SETTINGS_JSON" | jval "batch.enabled")" = "true" ] || fail "the Batch API is not enabled in app settings: $(echo "$BATCH_SETTINGS_JSON" | jval batch)"
[ "$(echo "$BATCH_SETTINGS_JSON" | jval "batch.maxRequests")" = "200" ] || fail "batch.maxRequests is '$(echo "$BATCH_SETTINGS_JSON" | jval "batch.maxRequests")', expected 200"
ok "the Batch API is enabled in app settings (maxRequests 200), so the nightly pricesync needs no manual step"

CONFIG_OFFER_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/config")"
[ "$(echo "$CONFIG_OFFER_JSON" | jval "settings.offer.ebayHaircutPct")" = "15" ] \
  || fail "settings.offer.ebayHaircutPct is '$(echo "$CONFIG_OFFER_JSON" | jval "settings.offer.ebayHaircutPct")', expected 15 (its one seeded home)"
ok "the eBay haircut is seeded at settings.offer.ebayHaircutPct (15), the one home for the figure"

# --- 19f. Retro refresh-prices and uk-comp -------------------------------
RETRO_PLATFORM_ID="$(curl -s "$BASE/api/collections/platforms/records?filter=key%3D%27snes_pal_box%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$RETRO_PLATFORM_ID" ] || fail "seeded platform 'snes_pal_box' not found"
RETRO_TITLE_ID="$(curl -s -X POST "$BASE/api/collections/retro_titles/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"platform\":\"$RETRO_PLATFORM_ID\",\"name\":\"Super Mario Kart\"}" | jval id)"
[ -n "$RETRO_TITLE_ID" ] || fail "could not create the Phase 3 check's retro_titles row"

RETRO_REFRESH_STATUS="$(curl -s -o "$TMP_DIR/retro-refresh-no-key.json" -w '%{http_code}' \
  -X POST "$BASE/api/vault/retro/$RETRO_TITLE_ID/refresh-prices" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"completeness":"cib"}')"
[ "$RETRO_REFRESH_STATUS" = "422" ] || fail "retro refresh-prices with no PriceCharting key returned $RETRO_REFRESH_STATUS, expected 422: $(cat "$TMP_DIR/retro-refresh-no-key.json")"
grep -qF "PriceCharting is not set up. Add the key in Settings or enter a UK comp." "$TMP_DIR/retro-refresh-no-key.json" \
  || fail "wrong message for retro refresh-prices with no PriceCharting key: $(cat "$TMP_DIR/retro-refresh-no-key.json")"
ok "retro refresh-prices refuses cleanly with no PriceCharting key configured"

RETRO_UKCOMP_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/retro/$RETRO_TITLE_ID/uk-comp" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"completeness\":\"cib\",\"price\":3000,\"url\":\"https://www.ebay.co.uk/itm/987654321098\",\"sold_at\":\"$TODAY\"}")"
RETRO_UKCOMP_STATUS="$(echo "$RETRO_UKCOMP_RESP" | tail -n1)"
RETRO_UKCOMP_BODY="$(echo "$RETRO_UKCOMP_RESP" | sed '$d')"
[ "$RETRO_UKCOMP_STATUS" = "200" ] || fail "retro uk-comp returned $RETRO_UKCOMP_STATUS: $RETRO_UKCOMP_BODY"
[ "$(echo "$RETRO_UKCOMP_BODY" | jval "chosen.source")" = "uk_sold_manual" ] || fail "retro uk-comp was not chosen first: $RETRO_UKCOMP_BODY"
[ "$(echo "$RETRO_UKCOMP_BODY" | jval "chosen.gbp_market")" = "3000" ] || fail "retro uk-comp's chosen gbp_market is wrong: $RETRO_UKCOMP_BODY"
ok "retro uk-comp writes a price_snapshots row against the retro title and is chosen first, with no outbound call"

# --- 19g. Sale completion idempotency (the offline queue's client_id) ----
IDEMPOTENT_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\",\"price\":500}" | jval id)"
[ -n "$IDEMPOTENT_ITEM_ID" ] || fail "could not create the idempotency check's item"

IDEMPOTENCY_CLIENT_ID="idem-check-$$-$RANDOM"
SALE1_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$IDEMPOTENT_ITEM_ID\",\"qty\":1,\"unit_price\":500}],\"payment\":\"sumup_card\",\"client_id\":\"$IDEMPOTENCY_CLIENT_ID\"}")"
SALE1_STATUS="$(echo "$SALE1_RESP" | tail -n1)"
SALE1_BODY="$(echo "$SALE1_RESP" | sed '$d')"
[ "$SALE1_STATUS" = "200" ] || fail "the first idempotent sale returned $SALE1_STATUS: $SALE1_BODY"
SALE1_NUMBER="$(echo "$SALE1_BODY" | jval "sale.number")"
[ -n "$SALE1_NUMBER" ] || fail "the first idempotent sale has no number: $SALE1_BODY"

SALE2_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$IDEMPOTENT_ITEM_ID\",\"qty\":1,\"unit_price\":500}],\"payment\":\"sumup_card\",\"client_id\":\"$IDEMPOTENCY_CLIENT_ID\"}")"
SALE2_STATUS="$(echo "$SALE2_RESP" | tail -n1)"
SALE2_BODY="$(echo "$SALE2_RESP" | sed '$d')"
[ "$SALE2_STATUS" = "200" ] || fail "the replayed idempotent sale returned $SALE2_STATUS, expected 200: $SALE2_BODY"
[ "$(echo "$SALE2_BODY" | jval "sale.number")" = "$SALE1_NUMBER" ] \
  || fail "the replayed sale got number '$(echo "$SALE2_BODY" | jval "sale.number")', expected the original '$SALE1_NUMBER'"
[ "$(echo "$SALE2_BODY" | jval "sale.id")" = "$(echo "$SALE1_BODY" | jval "sale.id")" ] \
  || fail "the replayed sale created a second row"

SALE_COUNT_FOR_CLIENT_ID="$(curl -s "$BASE/api/collections/sales/records?filter=client_id%3D%22$IDEMPOTENCY_CLIENT_ID%22" \
  -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$SALE_COUNT_FOR_CLIENT_ID" = "1" ] || fail "client_id '$IDEMPOTENCY_CLIENT_ID' matches $SALE_COUNT_FOR_CLIENT_ID sales rows, expected 1"
ok "two identical sale completions with one client_id create a single sale and return the same number"

# --- 19h. Stock count close: variance, a move, roles and a second close -
STOCK_COUNT_LOCATION_ID="$(curl -s "$BASE/api/collections/locations/records?filter=name%3D%27Storeroom%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$STOCK_COUNT_LOCATION_ID" ] || fail "seeded location 'Storeroom' not found"

EXPECTED_STOCK_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\"}" | jval id)"
UNEXPECTED_STOCK_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\"}" | jval id)"
[ -n "$EXPECTED_STOCK_ITEM_ID" ] && [ -n "$UNEXPECTED_STOCK_ITEM_ID" ] || fail "could not create the stock count check's items"

STOCK_COUNT_ID="$(curl -s -X POST "$BASE/api/collections/stock_counts/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"location\":\"$STOCK_COUNT_LOCATION_ID\",\"status\":\"open\"}" | jval id)"
[ -n "$STOCK_COUNT_ID" ] || fail "could not create the stock count"

# Only one open count per location (1789820220_stock_counts_one_open.js): a
# second one against the same, still-open location is refused with 409,
# through stockcounts.pb.js's onRecordCreateRequest hook, not a generic 400.
SECOND_OPEN_COUNT_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/stock_counts/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"location\":\"$STOCK_COUNT_LOCATION_ID\",\"status\":\"open\"}")"
SECOND_OPEN_COUNT_STATUS="$(echo "$SECOND_OPEN_COUNT_RESP" | tail -n1)"
SECOND_OPEN_COUNT_BODY="$(echo "$SECOND_OPEN_COUNT_RESP" | sed '$d')"
[ "$SECOND_OPEN_COUNT_STATUS" = "409" ] || fail "a second open count on an already-open location returned $SECOND_OPEN_COUNT_STATUS, expected 409: $SECOND_OPEN_COUNT_BODY"
echo "$SECOND_OPEN_COUNT_BODY" | grep -qF "already open" || fail "the second-open-count refusal does not explain itself: $SECOND_OPEN_COUNT_BODY"
ok "a second open stock count on the same location is refused with 409"

LINE_EXPECTED_ID="$(curl -s -X POST "$BASE/api/collections/stock_count_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"stock_count\":\"$STOCK_COUNT_ID\",\"item\":\"$EXPECTED_STOCK_ITEM_ID\",\"expected_qty\":1,\"scanned_qty\":1}" | jval id)"
LINE_UNEXPECTED_ID="$(curl -s -X POST "$BASE/api/collections/stock_count_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"stock_count\":\"$STOCK_COUNT_ID\",\"item\":\"$UNEXPECTED_STOCK_ITEM_ID\",\"expected_qty\":0,\"scanned_qty\":1}" | jval id)"
[ -n "$LINE_EXPECTED_ID" ] && [ -n "$LINE_UNEXPECTED_ID" ] || fail "could not create the stock count lines"

STATUS_BLOCK_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/collections/stock_counts/records/$STOCK_COUNT_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"status":"closed"}')"
[ "$STATUS_BLOCK_STATUS" != "200" ] || fail "a staff token was able to set stock_counts.status directly through the collection API"
ok "stock_counts.status cannot be set through the collection API (got $STATUS_BLOCK_STATUS)"

CLOSE_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/stock-counts/$STOCK_COUNT_ID/close" \
  -H "Authorization: $PLAIN_TOKEN" -H "Content-Type: application/json" -d '{"move_unexpected":true}')"
[ "$CLOSE_NONADMIN_STATUS" = "403" ] || fail "a non-admin closing a stock count returned $CLOSE_NONADMIN_STATUS, expected 403"
ok "a non-admin staff token cannot close a stock count (403)"

CLOSE_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/stock-counts/$STOCK_COUNT_ID/close" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"move_unexpected":true}')"
CLOSE_STATUS="$(echo "$CLOSE_RESP" | tail -n1)"
CLOSE_BODY="$(echo "$CLOSE_RESP" | sed '$d')"
[ "$CLOSE_STATUS" = "200" ] || fail "closing the stock count returned $CLOSE_STATUS: $CLOSE_BODY"
[ "$(echo "$CLOSE_BODY" | jval "stock_count.status")" = "closed" ] || fail "the close response's status is not closed: $CLOSE_BODY"
[ "$(echo "$CLOSE_BODY" | jval lines)" = "2" ] || fail "closing the stock count reported '$(echo "$CLOSE_BODY" | jval lines)' lines, expected 2"
echo "$CLOSE_BODY" | grep -qF "$UNEXPECTED_STOCK_ITEM_ID" || fail "the close response does not list the unexpected item as moved: $CLOSE_BODY"

LINE_EXPECTED_VARIANCE="$(curl -s "$BASE/api/collections/stock_count_lines/records/$LINE_EXPECTED_ID" -H "Authorization: $STAFF_TOKEN" | jval variance)"
[ "$LINE_EXPECTED_VARIANCE" = "0" ] || fail "the expected line's variance is '$LINE_EXPECTED_VARIANCE', expected 0"
LINE_UNEXPECTED_VARIANCE="$(curl -s "$BASE/api/collections/stock_count_lines/records/$LINE_UNEXPECTED_ID" -H "Authorization: $STAFF_TOKEN" | jval variance)"
[ "$LINE_UNEXPECTED_VARIANCE" = "1" ] || fail "the unexpected line's variance is '$LINE_UNEXPECTED_VARIANCE', expected 1"

MOVED_ITEM_LOCATION="$(curl -s "$BASE/api/collections/items/records/$UNEXPECTED_STOCK_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval location)"
[ "$MOVED_ITEM_LOCATION" = "$STOCK_COUNT_LOCATION_ID" ] || fail "the unexpected item's location is '$MOVED_ITEM_LOCATION', expected it moved to $STOCK_COUNT_LOCATION_ID"
EXPECTED_ITEM_LOCATION_AFTER="$(curl -s "$BASE/api/collections/items/records/$EXPECTED_STOCK_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval location)"
[ -z "$EXPECTED_ITEM_LOCATION_AFTER" ] || fail "an expected item's location changed when it should not have: '$EXPECTED_ITEM_LOCATION_AFTER'"
ok "closing a stock count with move_unexpected sets every line's variance and moves only the unexpected item"

CLOSE_AGAIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/stock-counts/$STOCK_COUNT_ID/close" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"move_unexpected":false}')"
[ "$CLOSE_AGAIN_STATUS" = "409" ] || fail "closing an already-closed stock count returned $CLOSE_AGAIN_STATUS, expected 409"
ok "closing an already-closed stock count is refused with 409"

# -----------------------------------------------------------------------
# 20. Fixture-backed adapter checks: the real routes, real (fixture)
#     adapter data, still with no live network call anywhere - see the
#     GG_ADAPTER_TRANSPORT_MODE=fixture note above section 19.
# -----------------------------------------------------------------------

# --- 20a. A name search per game, through each adapter's own search fixture
YUGIOH_SEARCH_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup?game=yugioh&q=dark%20magician")"
[ "$(echo "$YUGIOH_SEARCH_JSON" | jval "cards.0.name")" = "Dark Magician" ] \
  || fail "a Yu-Gi-Oh! name search for 'dark magician' did not return Dark Magician: $YUGIOH_SEARCH_JSON"
ok "a Yu-Gi-Oh! name search ('dark magician') returns printings from the fixture"

POKEMON_SEARCH_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup?game=pokemon&q=charizard%20ex")"
POKEMON_SEARCH_COUNT="$(echo "$POKEMON_SEARCH_JSON" | jlen cards)"
[ "$POKEMON_SEARCH_COUNT" = "5" ] \
  || fail "a Pokemon name search for 'charizard ex' returned $POKEMON_SEARCH_COUNT cards, expected the 5-row search fixture: $POKEMON_SEARCH_JSON"
ok "a Pokemon name search ('charizard ex') is not misread as an exact set+number lookup and returns 5 cards"

MTG_SEARCH_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup?game=mtg&q=lightning%20bolt")"
MTG_SEARCH_COUNT="$(echo "$MTG_SEARCH_JSON" | jlen cards)"
[ "$MTG_SEARCH_COUNT" -ge 1 ] 2>/dev/null \
  || fail "an MTG name search for 'lightning bolt' returned $MTG_SEARCH_COUNT cards, expected at least 1: $MTG_SEARCH_JSON"
ok "an MTG name search ('lightning bolt') reaches Scryfall's search fixture and returns cards"

# --- 20b. The fx cron stores the rate's own date, distinct from fetched_at
FX_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/fx" -H "Authorization: $SUPER_TOKEN")"
[ "$FX_CRON_STATUS" = "204" ] || fail "POST /api/crons/fx returned $FX_CRON_STATUS, expected 204"

FX_ROW_JSON="$(curl -s "$BASE/api/collections/fx_rates/records?perPage=1&sort=-fetched_at" -H "Authorization: $STAFF_TOKEN")"
FX_ROW_DATE="$(echo "$FX_ROW_JSON" | jval "items.0.date")"
[ "$FX_ROW_DATE" = "2026-09-18" ] || fail "the fx cron's stored row has date '$FX_ROW_DATE', expected the fixture's own 2026-09-18 (frankfurter_gbp_latest.json)"
FX_ROW_BASE="$(echo "$FX_ROW_JSON" | jval "items.0.base")"
[ "$FX_ROW_BASE" = "GBP" ] || fail "the fx cron's stored row has base '$FX_ROW_BASE', expected GBP"
ok "the fx cron stores the ECB rate's own date (2026-09-18), not just when this server happened to fetch it"

FX_LIVE_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/fx")"
[ "$(echo "$FX_LIVE_JSON" | jval stale)" = "false" ] || fail "GET /api/vault/fx reports stale right after the fx cron ran: $FX_LIVE_JSON"
[ "$(echo "$FX_LIVE_JSON" | jval date)" = "2026-09-18" ] || fail "GET /api/vault/fx does not return the rate's own ECB date: $FX_LIVE_JSON"
ok "GET /api/vault/fx returns the ECB reference date beside the rates"
FX_EUR_RATE="$(echo "$FX_LIVE_JSON" | jval "rates.EUR")"
FX_USD_RATE="$(echo "$FX_LIVE_JSON" | jval "rates.USD")"
node -e 'if (!(Number(process.argv[1]) > 0)) { console.error("EUR rate not positive: " + process.argv[1]); process.exit(1); }' "$FX_EUR_RATE" \
  || fail "GET /api/vault/fx's EUR rate is not a positive number: $FX_LIVE_JSON"
ok "GET /api/vault/fx reports the fresh rate, fed only by the cron, never by a route calling Frankfurter itself"

# --- 20c. The set-number alias resolves with no network, and a stale row -
#     (over 30 days old) correctly triggers a real call-out under the
#     fixture transport, refreshing it -------------------------------------
ALIAS_SET_ID="$(curl -s -X POST "$BASE/api/collections/card_sets/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"code\":\"sv03.5\",\"name\":\"151 Alias Set\"}" | jval id)"
[ -n "$ALIAS_SET_ID" ] || fail "could not create the alias check's card_sets row"

ALIAS_NOW_ISO="$(node -e 'process.stdout.write(new Date().toISOString())')"
ALIAS_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$ALIAS_SET_ID\",\"number\":\"199\",\"name\":\"Cached Charizard Alias\",\"last_synced\":\"$ALIAS_NOW_ISO\"}" | jval id)"
[ -n "$ALIAS_CARD_ID" ] || fail "could not create the alias check's cards row"

ALIAS_LOOKUP_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup?game=pokemon&q=sv151%20199")"
[ "$(echo "$ALIAS_LOOKUP_JSON" | jval "cards.0.id")" = "$ALIAS_CARD_ID" ] \
  || fail "the 'sv151' alias did not resolve to sv03.5 with the card fresh in the database: $ALIAS_LOOKUP_JSON"
[ "$(echo "$ALIAS_LOOKUP_JSON" | jval "cards.0.name")" = "Cached Charizard Alias" ] \
  || fail "the alias lookup did not serve the cached row straight from the database: $ALIAS_LOOKUP_JSON"
ok "'sv151 199' resolves the alias table and serves a fresh row with no outbound call"

FORTY_DAYS_AGO_ISO="$(node -e 'const d = new Date(); d.setUTCDate(d.getUTCDate() - 40); process.stdout.write(d.toISOString())')"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/cards/records/$ALIAS_CARD_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"last_synced\":\"$FORTY_DAYS_AGO_ISO\"}"

STALE_ALIAS_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/lookup/pokemon/sv03.5/199")"
[ "$(echo "$STALE_ALIAS_JSON" | jval "cards.0.id")" = "$ALIAS_CARD_ID" ] \
  || fail "the stale exact lookup did not refresh the same row: $STALE_ALIAS_JSON"
[ "$(echo "$STALE_ALIAS_JSON" | jval "cards.0.name")" = "Charizard ex" ] \
  || fail "a card_sets row over 30 days old did not call out to refresh - got name '$(echo "$STALE_ALIAS_JSON" | jval "cards.0.name")', expected the fixture's own 'Charizard ex'"
ok "a last_synced over 30 days old triggers a real call-out (through the fixture transport) that refreshes the row"

# --- 20d. Condition validation on GET .../prices: case-insensitive, and a
#     value outside NM/LP/MP/HP/DMG is refused with 400 --------------------
CONDITION_LOWER_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" \
  "$BASE/api/vault/cards/$P3_GBP_CARD_ID/prices?condition=nm")"
[ "$CONDITION_LOWER_STATUS" = "200" ] || fail "condition=nm (lowercase) returned $CONDITION_LOWER_STATUS, expected 200"
ok "a lowercase condition ('nm') is accepted"

CONDITION_BAD_RESP="$(curl -s -w '\n%{http_code}' -H "Authorization: $STAFF_TOKEN" \
  "$BASE/api/vault/cards/$P3_GBP_CARD_ID/prices?condition=EX")"
CONDITION_BAD_STATUS="$(echo "$CONDITION_BAD_RESP" | tail -n1)"
CONDITION_BAD_BODY="$(echo "$CONDITION_BAD_RESP" | sed '$d')"
[ "$CONDITION_BAD_STATUS" = "400" ] || fail "condition=EX returned $CONDITION_BAD_STATUS, expected 400: $CONDITION_BAD_BODY"
echo "$CONDITION_BAD_BODY" | grep -qF "Pick a condition: NM, LP, MP, HP or DMG." \
  || fail "condition=EX's 400 does not name the valid conditions: $CONDITION_BAD_BODY"
ok "an unrecognised condition ('EX') is refused with 400 and names the valid conditions"

# --- 20e. refresh-prices end to end: fixture prices written as
#     price_snapshots, GBP shown beside the native amount, and an audit row -
REFRESH_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"203\",\"name\":\"Refresh Check Card\"}" | jval id)"
[ -n "$REFRESH_CARD_ID" ] || fail "could not create the refresh-prices check's card"

REFRESH_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/cards/$REFRESH_CARD_ID/refresh-prices" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"finish":"holo","condition":"NM"}')"
REFRESH_STATUS="$(echo "$REFRESH_RESP" | tail -n1)"
REFRESH_BODY="$(echo "$REFRESH_RESP" | sed '$d')"
[ "$REFRESH_STATUS" = "200" ] || fail "refresh-prices returned $REFRESH_STATUS, expected 200: $REFRESH_BODY"
[ "$(echo "$REFRESH_BODY" | jval "chosen.source")" = "cardmarket" ] \
  || fail "refresh-prices did not choose cardmarket (the only source available with no uk-comp or eBay key): $REFRESH_BODY"
[ "$(echo "$REFRESH_BODY" | jval "chosen.native_currency")" = "EUR" ] || fail "refresh-prices lost the native currency: $REFRESH_BODY"
[ "$(echo "$REFRESH_BODY" | jval "chosen.native_market")" = "36830" ] \
  || fail "refresh-prices' native_market is '$(echo "$REFRESH_BODY" | jval "chosen.native_market")', expected 36830 (368.30 EUR from the fixture, in minor units)"
echo "$REFRESH_BODY" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const body = JSON.parse(d || "{}");
    const sources = body.sources || [];
    process.exit(sources.some((s) => s && s.source === "tcgplayer") ? 0 : 1);
  });
' || fail "refresh-prices did not also write a tcgplayer snapshot from the same fixture: $REFRESH_BODY"

REFRESH_EXPECTED_GBP="$(node -e '
  const rate = Number(process.argv[1]);
  const minor = 36830;
  process.stdout.write(String(Math.floor(Math.abs(minor * rate) + 0.5)));
' "$FX_EUR_RATE")"
[ "$(echo "$REFRESH_BODY" | jval "chosen.gbp_market")" = "$REFRESH_EXPECTED_GBP" ] \
  || fail "refresh-prices' gbp_market is '$(echo "$REFRESH_BODY" | jval "chosen.gbp_market")', expected $REFRESH_EXPECTED_GBP (36830 EUR minor units at the live rate $FX_EUR_RATE, half-up)"
ok "refresh-prices writes fixture-sourced snapshots with the GBP figure correctly converted and shown beside the native amount"

REFRESH_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22refresh_prices%22%20%26%26%20collection%3D%22cards%22" -H "Authorization: $SUPER_TOKEN")"
echo "$REFRESH_AUDIT" | grep -qF "$REFRESH_CARD_ID" || fail "no refresh_prices audit row names the refreshed card: $REFRESH_AUDIT"
ok "refresh-prices writes an audit row naming the card and the sources that answered"

# --- 20f. retro/lookup: a fixture success, then IGDB configured but this
#     particular call has no fixture, mapped to 502 -----------------------
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"api_keys":{"igdb":{"client_id":"fixture-ok-client","client_secret":"fixture-secret"}}}'

RETRO_LOOKUP_OK_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/retro/lookup?q=super%20mario&platform=snes_pal_box")"
RETRO_LOOKUP_OK_COUNT="$(echo "$RETRO_LOOKUP_OK_JSON" | jlen titles)"
[ "$RETRO_LOOKUP_OK_COUNT" -ge 1 ] 2>/dev/null || fail "retro/lookup with a mapped IGDB fixture returned $RETRO_LOOKUP_OK_COUNT titles, expected at least 1: $RETRO_LOOKUP_OK_JSON"
RETRO_LOOKUP_TITLE_ID="$(echo "$RETRO_LOOKUP_OK_JSON" | jval "titles.0.id")"
[ -n "$RETRO_LOOKUP_TITLE_ID" ] || fail "retro/lookup did not write a retro_titles row through for a platform it knows: $RETRO_LOOKUP_OK_JSON"
ok "retro/lookup reaches IGDB's fixture and writes a title through"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"api_keys":{"igdb":{"client_id":"fixture-unmapped-client","client_secret":"fixture-secret"}}}'

RETRO_LOOKUP_502_STATUS="$(curl -s -o "$TMP_DIR/retro-lookup-502.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" \
  "$BASE/api/vault/retro/lookup?q=another%20title")"
[ "$RETRO_LOOKUP_502_STATUS" = "502" ] || fail "retro/lookup with an IGDB call the fixture transport refuses returned $RETRO_LOOKUP_502_STATUS, expected 502: $(cat "$TMP_DIR/retro-lookup-502.json")"
grep -qF "IGDB did not answer" "$TMP_DIR/retro-lookup-502.json" || fail "retro/lookup's 502 does not explain itself: $(cat "$TMP_DIR/retro-lookup-502.json")"
ok "retro/lookup maps an IGDB call this harness has no fixture for to a 502, not a silent empty result"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"api_keys":{"igdb":{"client_id":"fixture-ok-client","client_secret":"fixture-secret"}}}'

# --- 20g. The image queue: a real fixture image is cached, one over the
#     size cap and one that is not an image at all are both refused -------
IMG_GOOD_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"204\",\"name\":\"Image Queue Good\",\"image_large\":\"https://img.fixtures.test/good.png\"}" | jval id)"
IMG_OVERSIZED_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"205\",\"name\":\"Image Queue Oversized\",\"image_large\":\"https://img.fixtures.test/oversized.bin\"}" | jval id)"
IMG_NOTIMAGE_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$P3_SET_ID\",\"number\":\"206\",\"name\":\"Image Queue Not Image\",\"image_large\":\"https://img.fixtures.test/not-image.txt\"}" | jval id)"
[ -n "$IMG_GOOD_CARD_ID" ] && [ -n "$IMG_OVERSIZED_CARD_ID" ] && [ -n "$IMG_NOTIMAGE_CARD_ID" ] \
  || fail "could not create the image-queue check's cards"

for cid in "$IMG_GOOD_CARD_ID" "$IMG_OVERSIZED_CARD_ID" "$IMG_NOTIMAGE_CARD_ID"; do
  curl -s -o /dev/null -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$cid\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\"}"
done

IMAGE_QUEUE_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/image_queue" -H "Authorization: $SUPER_TOKEN")"
[ "$IMAGE_QUEUE_CRON_STATUS" = "204" ] || fail "POST /api/crons/image_queue returned $IMAGE_QUEUE_CRON_STATUS, expected 204"

IMG_GOOD_LARGE="$(curl -s "$BASE/api/collections/cards/records/$IMG_GOOD_CARD_ID" -H "Authorization: $STAFF_TOKEN" | jval image_large)"
echo "$IMG_GOOD_LARGE" | grep -qF "img.fixtures.test" && fail "a good fixture image was not cached locally: still '$IMG_GOOD_LARGE'"
echo "$IMG_GOOD_LARGE" | grep -qF "/api/files/" || fail "a good fixture image's image_large does not point at a local file: '$IMG_GOOD_LARGE'"
ok "the image queue caches a real fixture image locally and rewrites image_large to the local file"

IMG_OVERSIZED_LARGE="$(curl -s "$BASE/api/collections/cards/records/$IMG_OVERSIZED_CARD_ID" -H "Authorization: $STAFF_TOKEN" | jval image_large)"
[ "$IMG_OVERSIZED_LARGE" = "https://img.fixtures.test/oversized.bin" ] \
  || fail "an oversized image was cached anyway (image_large is now '$IMG_OVERSIZED_LARGE'), expected the size cap to refuse it and leave image_large untouched"
ok "an image over the size cap is refused; image_large is left exactly as it was"

IMG_NOTIMAGE_LARGE="$(curl -s "$BASE/api/collections/cards/records/$IMG_NOTIMAGE_CARD_ID" -H "Authorization: $STAFF_TOKEN" | jval image_large)"
[ "$IMG_NOTIMAGE_LARGE" = "https://img.fixtures.test/not-image.txt" ] \
  || fail "a non-image response was cached anyway (image_large is now '$IMG_NOTIMAGE_LARGE'), expected the mime sniff to refuse it and leave image_large untouched"
ok "a 200 response that is not a recognised image format is refused; image_large is left exactly as it was"

# -----------------------------------------------------------------------
# 21. Phase 4: stats and reports. Runs on top of everything sections 1-20
#     have already created today (sales, trade-ins, cash sessions and
#     refunds) - the daily row and the reports are cross-checked against
#     numbers computed independently, straight from the raw collections,
#     rather than against a hand-tracked running total, so this holds
#     however many earlier sections ran first.
# -----------------------------------------------------------------------

# --- 21a. A small scenario of its own: a sale with a full-line refund (so
#     items_out has a refund to net off), and a credit-only buy-in (no cash
#     session needed) ------------------------------------------------------
STATS_CUSTOMER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Stats Check Customer"}' | jval id)"
[ -n "$STATS_CUSTOMER_ID" ] || fail "could not create the stats-check customer"

STATS_ITEM_A="$(make_item "Stats Item A" 1 500 2000)"
STATS_ITEM_B="$(make_item "Stats Item B" 1 300 1000)"
[ -n "$STATS_ITEM_A" ] && [ -n "$STATS_ITEM_B" ] || fail "could not create the stats-check items"

STATS_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$STATS_ITEM_A\",\"qty\":1,\"unit_price\":2000,\"discount\":0},{\"item\":\"$STATS_ITEM_B\",\"qty\":1,\"unit_price\":1000,\"discount\":0}],\"customer\":\"$STATS_CUSTOMER_ID\",\"payment\":\"sumup_card\"}")"
STATS_SALE_STATUS="$(echo "$STATS_SALE_JSON" | tail -n1)"
echo "$STATS_SALE_JSON" | head -n -1 >"$TMP_DIR/stats-sale.json"
[ "$STATS_SALE_STATUS" = "200" ] || fail "the stats-check sale returned $STATS_SALE_STATUS: $(cat "$TMP_DIR/stats-sale.json")"
STATS_SALE_ID="$(jval "sale.id" <"$TMP_DIR/stats-sale.json")"

STATS_STEPUP_TOKEN="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
[ -n "$STATS_STEPUP_TOKEN" ] || fail "could not mint a step-up token for the stats check"

STATS_SALE_LINES_JSON="$(curl -s "$BASE/api/collections/sale_lines/records?perPage=50&sort=created,id&filter=sale%3D%22$STATS_SALE_ID%22" -H "Authorization: $STAFF_TOKEN")"
STATS_REFUND_LINE_ID="$(echo "$STATS_SALE_LINES_JSON" | jval "items.1.id")"
[ -n "$STATS_REFUND_LINE_ID" ] || fail "could not find the second stats-check sale line to refund"
STATS_REFUND_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/$STATS_SALE_ID/refund" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $STATS_STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"sale_line\":\"$STATS_REFUND_LINE_ID\",\"qty\":1}],\"reason\":\"Stats check refund\",\"refund_method\":\"sumup_card\"}")"
STATS_REFUND_STATUS="$(echo "$STATS_REFUND_JSON" | tail -n1)"
[ "$STATS_REFUND_STATUS" = "200" ] || fail "the stats-check refund returned $STATS_REFUND_STATUS: $(echo "$STATS_REFUND_JSON" | head -n -1)"

STATS_SELLER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Stats Check Seller"}' | jval id)"
STATS_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$STATS_SELLER_ID\",\"channel\":\"counter\",\"status\":\"draft\"}" | jval id)"
STATS_LINE_ID="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$STATS_TRADE_ID\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Stats Buy-in Line\",\"qty\":1,\"market_price\":1000,\"market_currency\":\"GBP\",\"offer_pct\":50,\"offer_price\":500,\"accepted\":true}" | jval id)"
[ -n "$STATS_LINE_ID" ] || fail "could not create the stats-check trade-in line"
STATS_COMPLETE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/trade-ins/$STATS_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":500,"terms_accepted":true}')"
STATS_COMPLETE_STATUS="$(echo "$STATS_COMPLETE_JSON" | tail -n1)"
[ "$STATS_COMPLETE_STATUS" = "200" ] || fail "the stats-check buy-in returned $STATS_COMPLETE_STATUS: $(echo "$STATS_COMPLETE_JSON" | head -n -1)"
ok "seeded a stats-check sale with a full-line refund and a credit-only buy-in for today"

# --- 21b. The stats rebuild route: admin only, and idempotent -----------
REBUILD_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $PLAIN_TOKEN")"
[ "$REBUILD_NONADMIN_STATUS" = "403" ] || fail "a non-admin rebuilding stats got $REBUILD_NONADMIN_STATUS, expected 403"

REBUILD1_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN")"
REBUILD1_STATUS="$(echo "$REBUILD1_JSON" | tail -n1)"
REBUILD1_BODY="$(echo "$REBUILD1_JSON" | head -n -1)"
[ "$REBUILD1_STATUS" = "200" ] || fail "stats/rebuild returned $REBUILD1_STATUS: $REBUILD1_BODY"
[ "$(echo "$REBUILD1_BODY" | jval days)" = "1" ] || fail "rebuilding one day reported '$(echo "$REBUILD1_BODY" | jval days)' days, expected 1"

curl -s -o /dev/null -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN"

DAILY_ROW_JSON="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=date>='${TODAY} 00:00:00.000Z' && date<='${TODAY} 23:59:59.999Z'" \
  "$BASE/api/collections/daily_stats/records")"
[ "$(echo "$DAILY_ROW_JSON" | jval totalItems)" = "1" ] \
  || fail "expected exactly one daily_stats row for today after two rebuilds, got $(echo "$DAILY_ROW_JSON" | jval totalItems)"
ok "the stats rebuild route is admin only and idempotent: two rebuilds leave one row for the day"

# --- 21c. The daily row against numbers computed independently from the
#     raw collections - never the daily row's own arithmetic checking
#     itself ------------------------------------------------------------
# sales.occurred_at (not created) is what every sales figure groups,
# filters and ranges on - see lib/reports/daily.js's own note - so the
# independent check reads the same field, including through the relation
# for sale_lines.
curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=occurred_at>='${TODAY} 00:00:00.000Z'" \
  --data-urlencode "perPage=500" \
  "$BASE/api/collections/sales/records" >"$TMP_DIR/stats-today-sales.json"
curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=sale.occurred_at>='${TODAY} 00:00:00.000Z'" \
  --data-urlencode "perPage=500" \
  "$BASE/api/collections/sale_lines/records" >"$TMP_DIR/stats-today-lines.json"
curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=status='completed' && completed_at>='${TODAY} 00:00:00.000Z'" \
  --data-urlencode "perPage=500" \
  "$BASE/api/collections/trade_ins/records" >"$TMP_DIR/stats-today-tradeins.json"

EXPECTED_JSON="$(node -e '
  const fs = require("fs");
  const sales = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items || [];
  const lines = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).items || [];
  const tradeIns = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).items || [];

  const byPayment = { sumup_card: 0, cash: 0, store_credit: 0, points: 0, mixed: 0, none: 0 };
  let salesTotal = 0;
  let salesRefunded = 0;
  for (const s of sales) {
    // Blank payment (an eBay-import sale: eBay took the money) is its own
    // "none" bucket, never folded into "mixed" - see lib/reports/daily.js.
    const m = s.payment === "" ? "none" : Object.prototype.hasOwnProperty.call(byPayment, s.payment) ? s.payment : "mixed";
    byPayment[m] += s.total;
    salesTotal += s.total;
    salesRefunded += s.refunded_total;
  }

  let itemsOut = 0;
  for (const l of lines) {
    const net = l.qty - l.refunded_qty;
    if (net > 0) itemsOut += net;
  }

  let cash = 0;
  let credit = 0;
  for (const t of tradeIns) {
    cash += t.payout_cash;
    credit += t.payout_credit;
  }

  process.stdout.write(JSON.stringify({
    salesCount: sales.length,
    salesTotal,
    salesRefunded,
    byPayment,
    itemsOut,
    buyInCount: tradeIns.length,
    buyInCash: cash,
    buyInCredit: credit,
  }));
' "$TMP_DIR/stats-today-sales.json" "$TMP_DIR/stats-today-lines.json" "$TMP_DIR/stats-today-tradeins.json")"

EXPECTED_SALES_TOTAL="$(echo "$EXPECTED_JSON" | jval salesTotal)"
EXPECTED_SALES_REFUNDED="$(echo "$EXPECTED_JSON" | jval salesRefunded)"
EXPECTED_SALES_NET=$((EXPECTED_SALES_TOTAL - EXPECTED_SALES_REFUNDED))
EXPECTED_SALES_COUNT="$(echo "$EXPECTED_JSON" | jval salesCount)"
EXPECTED_ITEMS_OUT="$(echo "$EXPECTED_JSON" | jval itemsOut)"
EXPECTED_BUYIN_CASH="$(echo "$EXPECTED_JSON" | jval buyInCash)"
EXPECTED_BUYIN_CREDIT="$(echo "$EXPECTED_JSON" | jval buyInCredit)"
EXPECTED_BUYIN_TOTAL=$((EXPECTED_BUYIN_CASH + EXPECTED_BUYIN_CREDIT))

D_SUMUP="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.sumup_card")"
D_CASH="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.cash")"
D_CREDIT="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.store_credit")"
D_POINTS="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.points")"
D_MIXED="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.mixed")"
D_NONE="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.none")"
DAILY_SALES_TOTAL=$((${D_SUMUP:-0} + ${D_CASH:-0} + ${D_CREDIT:-0} + ${D_POINTS:-0} + ${D_MIXED:-0} + ${D_NONE:-0}))
[ "$DAILY_SALES_TOTAL" = "$EXPECTED_SALES_TOTAL" ] \
  || fail "daily_stats.sales_total_by_payment sums to $DAILY_SALES_TOTAL, expected $EXPECTED_SALES_TOTAL from the raw sales rows"
[ "$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_count")" = "$EXPECTED_SALES_COUNT" ] \
  || fail "daily_stats.sales_count is '$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_count")', expected $EXPECTED_SALES_COUNT"
[ "$(echo "$DAILY_ROW_JSON" | jval "items.0.items_out")" = "$EXPECTED_ITEMS_OUT" ] \
  || fail "daily_stats.items_out is '$(echo "$DAILY_ROW_JSON" | jval "items.0.items_out")', expected $EXPECTED_ITEMS_OUT (net of today's refunds)"
DAILY_BUYIN_CASH="$(echo "$DAILY_ROW_JSON" | jval "items.0.buy_in_total_by_payout.cash")"
DAILY_BUYIN_CREDIT="$(echo "$DAILY_ROW_JSON" | jval "items.0.buy_in_total_by_payout.credit")"
[ "$DAILY_BUYIN_CASH" = "$EXPECTED_BUYIN_CASH" ] || fail "daily_stats buy_in_total_by_payout.cash is '$DAILY_BUYIN_CASH', expected $EXPECTED_BUYIN_CASH"
[ "$DAILY_BUYIN_CREDIT" = "$EXPECTED_BUYIN_CREDIT" ] || fail "daily_stats buy_in_total_by_payout.credit is '$DAILY_BUYIN_CREDIT', expected $EXPECTED_BUYIN_CREDIT"
ok "the daily row for today carries the expected sales_total, buy_in_total and items_out net of refunds"

# --- 21c2. daily_stats.sales_refunded: gross, refunded and net all agree,
#     independently of the daily row's own arithmetic - the 21a scenario's
#     full-line refund guarantees this is never a vacuous (zero-refund)
#     check ---------------------------------------------------------------
[ "$EXPECTED_SALES_REFUNDED" -gt 0 ] \
  || fail "the 21a stats-check refund did not leave a positive refunded_total across today's sales - the net-of-refunds checks below would be vacuous"
DAILY_SALES_REFUNDED="$(echo "$DAILY_ROW_JSON" | jval "items.0.sales_refunded")"
[ "$DAILY_SALES_REFUNDED" = "$EXPECTED_SALES_REFUNDED" ] \
  || fail "daily_stats.sales_refunded is '$DAILY_SALES_REFUNDED', expected $EXPECTED_SALES_REFUNDED from the raw sales rows"
[ "$((DAILY_SALES_TOTAL - DAILY_SALES_REFUNDED))" = "$EXPECTED_SALES_NET" ] \
  || fail "daily_stats sales_total_by_payment ($DAILY_SALES_TOTAL) minus sales_refunded ($DAILY_SALES_REFUNDED) does not equal the independently computed net $EXPECTED_SALES_NET"
ok "daily_stats.sales_refunded matches the raw sales rows, and gross minus refunded equals the independently computed net"

# --- 21d. reports/sales and reports/buyins agree with the same numbers.
#     reports/sales totals.revenue is NET of refunds (gross minus
#     sales_refunded); sales_total_by_payment itself (checked above) stays
#     gross - see docs/api-contract.md's Phase 4 section and daily.js's own
#     note. Comparing against $EXPECTED_SALES_TOTAL (gross) here would be
#     wrong now that a refund is seeded into today's numbers. -------------
REPORT_SALES_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY")"
[ "$(echo "$REPORT_SALES_JSON" | jval "totals.revenue")" = "$EXPECTED_SALES_NET" ] \
  || fail "reports/sales totals.revenue is '$(echo "$REPORT_SALES_JSON" | jval "totals.revenue")', expected $EXPECTED_SALES_NET (net of refunds)"
[ "$(echo "$REPORT_SALES_JSON" | jval "totals.count")" = "$EXPECTED_SALES_COUNT" ] \
  || fail "reports/sales totals.count is '$(echo "$REPORT_SALES_JSON" | jval "totals.count")', expected $EXPECTED_SALES_COUNT"

REPORT_BUYINS_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/buyins?from=$TODAY&to=$TODAY")"
[ "$(echo "$REPORT_BUYINS_JSON" | jval "totals.spend")" = "$EXPECTED_BUYIN_TOTAL" ] \
  || fail "reports/buyins totals.spend is '$(echo "$REPORT_BUYINS_JSON" | jval "totals.spend")', expected $EXPECTED_BUYIN_TOTAL"
[ "$(echo "$REPORT_BUYINS_JSON" | jval "totals.cash")" = "$EXPECTED_BUYIN_CASH" ] \
  || fail "reports/buyins totals.cash is '$(echo "$REPORT_BUYINS_JSON" | jval "totals.cash")', expected $EXPECTED_BUYIN_CASH"
[ "$(echo "$REPORT_BUYINS_JSON" | jval "totals.credit")" = "$EXPECTED_BUYIN_CREDIT" ] \
  || fail "reports/buyins totals.credit is '$(echo "$REPORT_BUYINS_JSON" | jval "totals.credit")', expected $EXPECTED_BUYIN_CREDIT"
ok "reports/sales and reports/buyins for the range agree with the daily row and the raw ledgers"

# --- 21e. group=week labels the series with that week's Monday ----------
WEEK_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY&group=week")"
EXPECTED_MONDAY="$(node -e '
  const d = new Date(process.argv[1] + "T00:00:00.000Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  process.stdout.write(d.toISOString().slice(0, 10));
' "$TODAY")"
[ "$(echo "$WEEK_JSON" | jval "series.0.label")" = "$EXPECTED_MONDAY" ] \
  || fail "group=week's series label is '$(echo "$WEEK_JSON" | jval "series.0.label")', expected the Monday $EXPECTED_MONDAY"
ok "group=week labels the series with the week's Monday"

# --- 21f. compare=previous returns a totals block; compare=none is null -
YESTERDAY="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00.000Z"); d.setUTCDate(d.getUTCDate()-1); process.stdout.write(d.toISOString().slice(0,10));' "$TODAY")"
COMPARE_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY&compare=previous")"
[ "$(echo "$COMPARE_JSON" | jval "compare.from")" = "$YESTERDAY" ] || fail "compare.from is '$(echo "$COMPARE_JSON" | jval "compare.from")', expected $YESTERDAY"
[ "$(echo "$COMPARE_JSON" | jval "compare.to")" = "$YESTERDAY" ] || fail "compare.to is '$(echo "$COMPARE_JSON" | jval "compare.to")', expected $YESTERDAY"
[ -n "$(echo "$COMPARE_JSON" | jval "compare.totals.revenue")" ] || fail "compare=previous returned no compare.totals.revenue: $COMPARE_JSON"
NONE_COMPARE_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY&compare=none")"
[ -z "$(echo "$NONE_COMPARE_JSON" | jval compare)" ] || fail "compare=none returned a non-null compare block: $NONE_COMPARE_JSON"
ok "compare=previous returns a totals block for the immediately preceding period; compare=none returns null"

# --- 21g. by=game splits revenue correctly across games -----------------
MTG_GAME_ID="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27mtg%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$MTG_GAME_ID" ] || fail "seeded game 'mtg' not found"

by_game_revenue() {
  # $1 report JSON, $2 game id -> that game's row revenue, or 0
  node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const row = (body.table || []).find((r) => r.key === process.argv[1]);
    process.stdout.write(String(row ? row.revenue : 0));
  ' "$2" <<<"$1"
}

BY_GAME_BEFORE="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY&by=game")"
POKEMON_REVENUE_BEFORE="$(by_game_revenue "$BY_GAME_BEFORE" "$GAME_ID")"
MTG_REVENUE_BEFORE="$(by_game_revenue "$BY_GAME_BEFORE" "$MTG_GAME_ID")"

MTG_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"sealed\",\"game\":\"$MTG_GAME_ID\",\"title\":\"By-game Split Check\",\"qty\":1,\"cost\":1000,\"price\":3333,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}" | jval id)"
[ -n "$MTG_ITEM_ID" ] || fail "could not create the by=game split-check item"
MTG_SALE_STATUS="$(curl -s -o "$TMP_DIR/mtg-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$MTG_ITEM_ID\",\"qty\":1,\"unit_price\":3333,\"discount\":0}],\"payment\":\"sumup_card\"}")"
[ "$MTG_SALE_STATUS" = "200" ] || fail "the by=game split-check sale returned $MTG_SALE_STATUS: $(cat "$TMP_DIR/mtg-sale.json")"

BY_GAME_AFTER="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY&by=game")"
POKEMON_REVENUE_AFTER="$(by_game_revenue "$BY_GAME_AFTER" "$GAME_ID")"
MTG_REVENUE_AFTER="$(by_game_revenue "$BY_GAME_AFTER" "$MTG_GAME_ID")"

[ "$POKEMON_REVENUE_AFTER" = "$POKEMON_REVENUE_BEFORE" ] \
  || fail "adding an mtg-only sale changed the pokemon by=game bucket from $POKEMON_REVENUE_BEFORE to $POKEMON_REVENUE_AFTER"
[ "$((MTG_REVENUE_AFTER - MTG_REVENUE_BEFORE))" = "3333" ] \
  || fail "the mtg by=game bucket moved by $((MTG_REVENUE_AFTER - MTG_REVENUE_BEFORE)), expected exactly 3333"
ok "by=game splits revenue correctly across games"

# --- 21h. A range over 400 days is refused -------------------------------
RANGE_TOO_LONG_STATUS="$(curl -s -o "$TMP_DIR/range-too-long.json" -w '%{http_code}' \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=2020-01-01&to=2021-12-31")"
[ "$RANGE_TOO_LONG_STATUS" = "400" ] || fail "a 731-day range returned $RANGE_TOO_LONG_STATUS, expected 400: $(cat "$TMP_DIR/range-too-long.json")"
grep -qF "Pick a range of up to 400 days." "$TMP_DIR/range-too-long.json" \
  || fail "the 400 does not name the 400-day limit: $(cat "$TMP_DIR/range-too-long.json")"
ok "a range over 400 days is refused with 400 naming the limit"

# --- 21i. The CSV variant: a header row, and the formula-injection guard
#     prefixes a cell starting with '=' ------------------------------------
CSV_SELLER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"=HYPERLINK(\"y\")"}' | jval id)"
[ -n "$CSV_SELLER_ID" ] || fail "could not create the reports-CSV formula-check customer"
CSV_ITEM_ID="$(make_item "CSV Formula Check Item" 1 100 900)"
CSV_SALE_STATUS="$(curl -s -o "$TMP_DIR/csv-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$CSV_ITEM_ID\",\"qty\":1,\"unit_price\":900,\"discount\":0}],\"customer\":\"$CSV_SELLER_ID\",\"payment\":\"sumup_card\"}")"
[ "$CSV_SALE_STATUS" = "200" ] || fail "the reports-CSV formula-check sale returned $CSV_SALE_STATUS: $(cat "$TMP_DIR/csv-sale.json")"

curl -s -o "$TMP_DIR/customers-report.csv" -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/customers.csv?from=$TODAY&to=$TODAY"
head -n1 "$TMP_DIR/customers-report.csv" | grep -q "Customer" \
  || fail "reports/customers.csv has no header row: $(head -n1 "$TMP_DIR/customers-report.csv")"
grep -qF '"'"'"'=HYPERLINK' "$TMP_DIR/customers-report.csv" \
  || fail "a customer called =HYPERLINK(\"y\") is not prefixed in the CSV export: $(grep -F 'HYPERLINK' "$TMP_DIR/customers-report.csv" || true)"
ok "the CSV report variant has a header row and the formula-injection guard prefixes a cell starting with '='"

# --- 21j. The compliance report and the audit log CSV are admin only ----
COMPLIANCE_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/reports/compliance?from=$TODAY&to=$TODAY")"
[ "$COMPLIANCE_NONADMIN_STATUS" = "403" ] || fail "a non-admin fetching the compliance report got $COMPLIANCE_NONADMIN_STATUS, expected 403"
COMPLIANCE_ADMIN_STATUS="$(curl -s -o "$TMP_DIR/compliance.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/compliance?from=$TODAY&to=$TODAY")"
[ "$COMPLIANCE_ADMIN_STATUS" = "200" ] || fail "an admin fetching the compliance report got $COMPLIANCE_ADMIN_STATUS: $(cat "$TMP_DIR/compliance.json")"
grep -qF "$STATS_TRADE_ID" "$TMP_DIR/compliance.json" \
  || fail "the compliance register does not carry today's stats-check buy-in: $(cat "$TMP_DIR/compliance.json")"
ok "the compliance report is admin only and lists today's buy-in register"

AUDIT_CSV_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/reports/audit.csv?from=$TODAY&to=$TODAY")"
[ "$AUDIT_CSV_NONADMIN_STATUS" = "403" ] || fail "a non-admin fetching the audit CSV got $AUDIT_CSV_NONADMIN_STATUS, expected 403"
AUDIT_CSV_ADMIN_STATUS="$(curl -s -o "$TMP_DIR/audit.csv" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/audit.csv?from=$TODAY&to=$TODAY")"
[ "$AUDIT_CSV_ADMIN_STATUS" = "200" ] || fail "an admin fetching the audit CSV got $AUDIT_CSV_ADMIN_STATUS"
head -n1 "$TMP_DIR/audit.csv" | grep -q "Action" || fail "the audit CSV has no header row: $(head -n1 "$TMP_DIR/audit.csv")"
ok "the audit log CSV export is admin only"

# POST /api/crons/{name} (PocketBase's own "run this job now" route) queues
# the job and returns 204 before it finishes running, confirmed against this
# binary: a cron that does real work (building a report, sending an email)
# can still be mid-flight when the very next request lands. Poll briefly
# for the audit row it writes on completion rather than checking once,
# immediately, and calling it absent.
wait_for_audit_row() {
  # $1 audit_log filter query string (already url-encoded) -> the response
  # JSON once totalItems >= 1, or the last response after ~10 seconds.
  local filter="$1"
  local tries=0
  local json=""
  while [ "$tries" -lt 40 ]; do
    json="$(curl -s "$BASE/api/collections/audit_log/records?$filter" -H "Authorization: $SUPER_TOKEN")"
    if [ "$(echo "$json" | jval totalItems)" -ge 1 ] 2>/dev/null; then
      echo "$json"
      return 0
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  echo "$json"
}

# --- 21k. The weekly scheduled-report cron, under test_mode, logs a send
#     and writes an audit row ------------------------------------------
STAFF_ADMIN_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval id)"
[ -n "$STAFF_ADMIN_ID" ] || fail "could not resolve the admin's own staff id from /api/vault/me"

SAVED_REPORT_ID="$(curl -s -X POST "$BASE/api/collections/saved_reports/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"owner\":\"$STAFF_ADMIN_ID\",\"report_key\":\"sales\",\"name\":\"Weekly Sales Check\",\"schedule\":\"weekly\",\"recipients\":[\"stats-check-recipient@local.test\"]}" | jval id)"
[ -n "$SAVED_REPORT_ID" ] || fail "could not create a saved_reports row"

SCHEDULED_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/scheduled_reports_weekly" -H "Authorization: $SUPER_TOKEN")"
[ "$SCHEDULED_CRON_STATUS" = "204" ] || fail "POST /api/crons/scheduled_reports_weekly returned $SCHEDULED_CRON_STATUS, expected 204"

SCHEDULED_AUDIT="$(wait_for_audit_row "perPage=50&filter=action%3D%22saved_report_sent%22%26%26record%3D%22$SAVED_REPORT_ID%22")"
[ "$(echo "$SCHEDULED_AUDIT" | jval totalItems)" -ge 1 ] \
  || fail "the scheduled_reports_weekly cron wrote no saved_report_sent audit row for $SAVED_REPORT_ID: $SCHEDULED_AUDIT"
echo "$SCHEDULED_AUDIT" | grep -q '"test_mode":true' || fail "the scheduled report send did not log test_mode: $SCHEDULED_AUDIT"
echo "$SCHEDULED_AUDIT" | grep -q '"sent":false' || fail "the scheduled report audit row does not say sent:false under test_mode: $SCHEDULED_AUDIT"
ok "the weekly scheduled-report cron, run under settings.email.test_mode, logs a send and writes an audit row"

# --- 21l. The Monday digest names the three biggest price movers --------
# A distinct, brand new game (not $GAME_ID/pokemon, which is used all over
# this script) so these three cards can never collide with a card_sets
# code or a cards (game, set, number) tuple anything earlier created -
# the whole point is a clean, deterministic "3 movers and only these 3".
MOVER_GAME_ID="$(curl -s -X POST "$BASE/api/collections/games/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"mover-check-game","name":"Mover Check Game","enabled":true}' | jval id)"
[ -n "$MOVER_GAME_ID" ] || fail "could not create the mover-check's own game"

MOVER_TITLES=()
for pct in 20 30 50; do
  MOVER_SET_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/card_sets/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"game\":\"$MOVER_GAME_ID\",\"code\":\"mover-set-$pct\",\"name\":\"Mover Set $pct\"}")"
  MOVER_SET_STATUS="$(echo "$MOVER_SET_RESP" | tail -n1)"
  MOVER_SET_BODY="$(echo "$MOVER_SET_RESP" | head -n -1)"
  [ "$MOVER_SET_STATUS" = "200" ] || fail "creating the mover-check card_sets row ($pct%) returned $MOVER_SET_STATUS: $MOVER_SET_BODY"
  MOVER_SET_ID="$(echo "$MOVER_SET_BODY" | jval id)"
  [ -n "$MOVER_SET_ID" ] || fail "the mover-check card_sets row ($pct%) has no id: $MOVER_SET_BODY"

  MOVER_CARD_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/cards/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"game\":\"$MOVER_GAME_ID\",\"set\":\"$MOVER_SET_ID\",\"number\":\"$pct\",\"name\":\"Mover Card $pct\"}")"
  MOVER_CARD_STATUS="$(echo "$MOVER_CARD_RESP" | tail -n1)"
  MOVER_CARD_BODY="$(echo "$MOVER_CARD_RESP" | head -n -1)"
  [ "$MOVER_CARD_STATUS" = "200" ] || fail "creating the mover-check cards row ($pct%) returned $MOVER_CARD_STATUS: $MOVER_CARD_BODY"
  MOVER_CARD_ID="$(echo "$MOVER_CARD_BODY" | jval id)"
  [ -n "$MOVER_CARD_ID" ] || fail "the mover-check cards row ($pct%) has no id: $MOVER_CARD_BODY"

  MOVER_MARKET=$((1000 + pct * 10))
  MOVER_FETCHED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
  MOVER_SNAP_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/price_snapshots/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"card\":\"$MOVER_CARD_ID\",\"finish\":\"\",\"source\":\"uk_sold_manual\",\"native_currency\":\"GBP\",\"native_market\":$MOVER_MARKET,\"fx_rate\":1,\"gbp_market\":$MOVER_MARKET,\"fetched_at\":\"$MOVER_FETCHED_AT\"}")"
  MOVER_SNAP_STATUS="$(echo "$MOVER_SNAP_RESP" | tail -n1)"
  MOVER_SNAP_BODY="$(echo "$MOVER_SNAP_RESP" | head -n -1)"
  [ "$MOVER_SNAP_STATUS" = "200" ] || fail "creating the mover-check price_snapshots row ($pct%) returned $MOVER_SNAP_STATUS: $MOVER_SNAP_BODY"
  [ "$(echo "$MOVER_SNAP_BODY" | jval card)" = "$MOVER_CARD_ID" ] \
    || fail "the mover-check price_snapshots row ($pct%) did not save against card $MOVER_CARD_ID: $MOVER_SNAP_BODY"

  MOVER_ITEM_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"single\",\"game\":\"$MOVER_GAME_ID\",\"card\":\"$MOVER_CARD_ID\",\"condition\":\"NM\",\"qty\":1,\"cost\":500,\"market_at_intake\":1000,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}")"
  MOVER_ITEM_STATUS="$(echo "$MOVER_ITEM_RESP" | tail -n1)"
  MOVER_ITEM_BODY="$(echo "$MOVER_ITEM_RESP" | head -n -1)"
  [ "$MOVER_ITEM_STATUS" = "200" ] || fail "creating the mover-check items row ($pct%) returned $MOVER_ITEM_STATUS: $MOVER_ITEM_BODY"
  MOVER_SKU="$(echo "$MOVER_ITEM_BODY" | jval sku)"
  [ -n "$MOVER_SKU" ] || fail "the mover-check item ($pct%) has no sku: $MOVER_ITEM_BODY"
  MOVER_TITLES+=("$MOVER_SKU")
done

STOCK_MOVERS_STATUS="$(curl -s -o "$TMP_DIR/stock-movers.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/stock?from=$TODAY&to=$TODAY")"
[ "$STOCK_MOVERS_STATUS" = "200" ] || fail "GET reports/stock returned $STOCK_MOVERS_STATUS: $(cat "$TMP_DIR/stock-movers.json")"

STOCK_MOVERS_TABLE_LEN="$(node -e '
  const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String((body.table || []).length));
' "$TMP_DIR/stock-movers.json")"
[ "$STOCK_MOVERS_TABLE_LEN" = "3" ] \
  || fail "reports/stock's price-movers table has $STOCK_MOVERS_TABLE_LEN rows, expected exactly the 3 seeded here: $(cat "$TMP_DIR/stock-movers.json")"

DIGEST_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/weekly_digest" -H "Authorization: $SUPER_TOKEN")"
[ "$DIGEST_STATUS" = "204" ] || fail "POST /api/crons/weekly_digest returned $DIGEST_STATUS, expected 204"

DIGEST_AUDIT="$(wait_for_audit_row "perPage=10&sort=-created&filter=action%3D%22weekly_digest_sent%22")"
[ "$(echo "$DIGEST_AUDIT" | jval totalItems)" -ge 1 ] || fail "the weekly_digest cron wrote no weekly_digest_sent audit row: $DIGEST_AUDIT"
for title in "${MOVER_TITLES[@]}"; do
  echo "$DIGEST_AUDIT" | grep -qF "$title" || fail "the digest audit meta does not name mover $title: $DIGEST_AUDIT"
done
ok "the weekly digest names the three biggest price movers"

# --- 21m. An eBay-import-shaped sale (sales.channel/.external_ref, added
#     by the exports/imports package this same phase): channel "ebay",
#     payment left blank because eBay took the money. Not dropped, and
#     not folded into sales_total_by_payment's "mixed" bucket, which means
#     the shop itself split a payment across methods - see
#     lib/reports/daily.js. Created directly against the collection (the
#     eBay orders import route itself belongs to that other package). ----
# occurred_at set explicitly to today: this sale is created directly
# against the collection rather than through the eBay orders import route
# (that route, and the hook that sets occurred_at from the order's own
# date, belong to the exports/imports package), and every figure this
# check reads groups, filters and ranges on occurred_at, not created.
EBAY_SALE_NUMBER="GG-S-EBAYCHECK1"
EBAY_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/sales/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"number\":\"$EBAY_SALE_NUMBER\",\"channel\":\"ebay\",\"external_ref\":\"EBAY-ORDER-99\",\"subtotal\":1234,\"discount\":0,\"total\":1234,\"payment\":\"\",\"status\":\"complete\",\"occurred_at\":\"$TODAY 12:00:00.000Z\"}")"
EBAY_SALE_STATUS="$(echo "$EBAY_SALE_JSON" | tail -n1)"
EBAY_SALE_BODY="$(echo "$EBAY_SALE_JSON" | head -n -1)"
[ "$EBAY_SALE_STATUS" = "200" ] || fail "creating an eBay-channel sale with blank payment returned $EBAY_SALE_STATUS: $EBAY_SALE_BODY"

EBAY_REBUILD_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$EBAY_REBUILD_JSON" | tail -n1)" = "200" ] || fail "rebuilding stats after the eBay-channel sale returned $(echo "$EBAY_REBUILD_JSON" | tail -n1): $(echo "$EBAY_REBUILD_JSON" | head -n -1)"

EBAY_DAILY_ROW_JSON="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=date>='${TODAY} 00:00:00.000Z' && date<='${TODAY} 23:59:59.999Z'" \
  "$BASE/api/collections/daily_stats/records")"
EBAY_D_NONE="$(echo "$EBAY_DAILY_ROW_JSON" | jval "items.0.sales_total_by_payment.none")"
[ "${EBAY_D_NONE:-0}" -ge 1234 ] \
  || fail "daily_stats.sales_total_by_payment.none is '$EBAY_D_NONE', expected at least 1234 (the eBay-channel sale with no shop-side payment)"

EBAY_CHANNELS_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/channels?from=$TODAY&to=$TODAY")"
echo "$EBAY_CHANNELS_JSON" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const ebayRow = (body.table || []).find((r) => r.key === "ebay");
  process.exit(ebayRow && ebayRow.revenue >= 1234 ? 0 : 1);
' || fail "reports/channels did not attribute the eBay-channel sale to an 'ebay' row keyed off sales.channel: $EBAY_CHANNELS_JSON"
ok "an eBay-import-shaped sale (channel ebay, blank payment) lands in sales_total_by_payment's 'none' bucket and the channels report's 'ebay' row"
# --- 21n. Partial-refund proportional netting: refunding one of two units
#     on a single line nets exactly that unit's share (saleline.js's
#     cumNet), not the whole line - checked at the stats layer
#     (reports/sales totals.revenue), not the refund route's own math
#     (covered elsewhere in this script) ----------------------------------
PARTIAL_ITEM_ID="$(make_item "Partial Refund Netting Item" 5 400 1000)"
[ -n "$PARTIAL_ITEM_ID" ] || fail "could not create the partial-refund-netting item"
PARTIAL_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$PARTIAL_ITEM_ID\",\"qty\":2,\"unit_price\":1000,\"discount\":0}],\"payment\":\"sumup_card\"}")"
PARTIAL_SALE_STATUS="$(echo "$PARTIAL_SALE_JSON" | tail -n1)"
echo "$PARTIAL_SALE_JSON" | head -n -1 >"$TMP_DIR/partial-sale.json"
[ "$PARTIAL_SALE_STATUS" = "200" ] || fail "the partial-refund-netting sale returned $PARTIAL_SALE_STATUS: $(cat "$TMP_DIR/partial-sale.json")"
PARTIAL_SALE_ID="$(jval "sale.id" <"$TMP_DIR/partial-sale.json")"

PARTIAL_LINE_ID="$(curl -s "$BASE/api/collections/sale_lines/records?perPage=1&filter=sale%3D%22$PARTIAL_SALE_ID%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$PARTIAL_LINE_ID" ] || fail "could not find the partial-refund-netting sale's own line"

# reports/sales reads the stored daily_stats row when one exists (built by
# the last /api/vault/stats/rebuild call, back in 21b) rather than always
# computing fresh - so this sale's own revenue has to be rebuilt in before
# "before" is read, or "before" would still be the older stored figure.
curl -s -o /dev/null -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN"
REVENUE_BEFORE_PARTIAL="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY" | jval "totals.revenue")"

PARTIAL_STEPUP_TOKEN="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
PARTIAL_REFUND_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/$PARTIAL_SALE_ID/refund" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $PARTIAL_STEPUP_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"sale_line\":\"$PARTIAL_LINE_ID\",\"qty\":1}],\"reason\":\"Partial netting check\",\"refund_method\":\"sumup_card\"}")"
PARTIAL_REFUND_STATUS="$(echo "$PARTIAL_REFUND_JSON" | tail -n1)"
PARTIAL_REFUND_BODY="$(echo "$PARTIAL_REFUND_JSON" | head -n -1)"
[ "$PARTIAL_REFUND_STATUS" = "200" ] || fail "the partial-refund-netting refund returned $PARTIAL_REFUND_STATUS: $PARTIAL_REFUND_BODY"
PARTIAL_REFUND_AMOUNT="$(echo "$PARTIAL_REFUND_BODY" | jval refunded)"
[ "$PARTIAL_REFUND_AMOUNT" = "1000" ] \
  || fail "refunding one of two 1000p units refunded '$PARTIAL_REFUND_AMOUNT', expected exactly 1000 (half the 2000p line, not the whole line)"

curl -s -o /dev/null -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN"
REVENUE_AFTER_PARTIAL="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY" | jval "totals.revenue")"
[ "$((REVENUE_BEFORE_PARTIAL - REVENUE_AFTER_PARTIAL))" = "1000" ] \
  || fail "reports/sales totals.revenue moved by $((REVENUE_BEFORE_PARTIAL - REVENUE_AFTER_PARTIAL)) after refunding one of two units, expected exactly -1000"
ok "refunding one of two units on a line nets exactly that unit's proportional share from reports/sales revenue"

# --- 21o. margin report figures: an isolated, discount-free sale's own
#     revenue/cost/margin move totals.{revenue,cost,margin} by exactly the
#     expected amount, computed independently from the item's own cost ----
MARGIN_ITEM_COST=400
MARGIN_ITEM_PRICE=1100
MARGIN_ITEM_ID="$(make_item "Margin Figure Check Item" 1 $MARGIN_ITEM_COST $MARGIN_ITEM_PRICE)"
[ -n "$MARGIN_ITEM_ID" ] || fail "could not create the margin-figure-check item"

MARGIN_BEFORE_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/margin?from=$TODAY&to=$TODAY")"
MARGIN_REVENUE_BEFORE="$(echo "$MARGIN_BEFORE_JSON" | jval "totals.revenue")"
MARGIN_COST_BEFORE="$(echo "$MARGIN_BEFORE_JSON" | jval "totals.cost")"
MARGIN_MARGIN_BEFORE="$(echo "$MARGIN_BEFORE_JSON" | jval "totals.margin")"

MARGIN_SALE_STATUS="$(curl -s -o "$TMP_DIR/margin-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$MARGIN_ITEM_ID\",\"qty\":1,\"unit_price\":$MARGIN_ITEM_PRICE,\"discount\":0}],\"payment\":\"sumup_card\"}")"
[ "$MARGIN_SALE_STATUS" = "200" ] || fail "the margin-figure-check sale returned $MARGIN_SALE_STATUS: $(cat "$TMP_DIR/margin-sale.json")"

MARGIN_AFTER_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/margin?from=$TODAY&to=$TODAY")"
MARGIN_REVENUE_AFTER="$(echo "$MARGIN_AFTER_JSON" | jval "totals.revenue")"
MARGIN_COST_AFTER="$(echo "$MARGIN_AFTER_JSON" | jval "totals.cost")"
MARGIN_MARGIN_AFTER="$(echo "$MARGIN_AFTER_JSON" | jval "totals.margin")"

[ "$((MARGIN_REVENUE_AFTER - MARGIN_REVENUE_BEFORE))" = "$MARGIN_ITEM_PRICE" ] \
  || fail "reports/margin totals.revenue moved by $((MARGIN_REVENUE_AFTER - MARGIN_REVENUE_BEFORE)), expected exactly $MARGIN_ITEM_PRICE"
[ "$((MARGIN_COST_AFTER - MARGIN_COST_BEFORE))" = "$MARGIN_ITEM_COST" ] \
  || fail "reports/margin totals.cost moved by $((MARGIN_COST_AFTER - MARGIN_COST_BEFORE)), expected exactly $MARGIN_ITEM_COST"
[ "$((MARGIN_MARGIN_AFTER - MARGIN_MARGIN_BEFORE))" = "$((MARGIN_ITEM_PRICE - MARGIN_ITEM_COST))" ] \
  || fail "reports/margin totals.margin moved by $((MARGIN_MARGIN_AFTER - MARGIN_MARGIN_BEFORE)), expected exactly $((MARGIN_ITEM_PRICE - MARGIN_ITEM_COST))"
ok "reports/margin totals.revenue, cost and margin move by exactly the expected amount for an isolated, discount-free sale"

# --- 21p. occurred_at day boundary: a sale dated yesterday (occurred_at),
#     even though created today, belongs to yesterday's daily row and
#     reports/sales range, never today's ----------------------------------
DAYBOUND_YESTERDAY="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00.000Z"); d.setUTCDate(d.getUTCDate()-1); process.stdout.write(d.toISOString().slice(0,10));' "$TODAY")"
DAYBOUND_AMOUNT=4321
# reports/sales.totals.revenue reads the stored daily_stats row when one
# exists, not always a fresh computation - rebuild today explicitly first,
# so "before" reflects everything real up to this point (21o's own sale
# included) rather than whatever the last unrelated rebuild happened to
# leave stored.
curl -s -o /dev/null -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN"
TODAY_REVENUE_BEFORE_DAYBOUND="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY" | jval "totals.revenue")"

DAYBOUND_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/sales/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"number\":\"GG-S-DAYBOUND1\",\"subtotal\":$DAYBOUND_AMOUNT,\"discount\":0,\"total\":$DAYBOUND_AMOUNT,\"payment\":\"cash\",\"status\":\"complete\",\"occurred_at\":\"$DAYBOUND_YESTERDAY 12:00:00.000Z\"}")"
DAYBOUND_SALE_STATUS="$(echo "$DAYBOUND_SALE_JSON" | tail -n1)"
[ "$DAYBOUND_SALE_STATUS" = "200" ] || fail "creating a sale dated yesterday returned $DAYBOUND_SALE_STATUS: $(echo "$DAYBOUND_SALE_JSON" | head -n -1)"

# Two separate, targeted rebuilds - yesterday and today each on their own -
# rather than one call spanning both days, so today's own row is a genuine
# fresh recompute (not merely an untouched older figure) that still, after
# that recompute, excludes a sale whose occurred_at is yesterday's.
curl -s -o /dev/null -X POST "$BASE/api/vault/stats/rebuild?from=$DAYBOUND_YESTERDAY&to=$DAYBOUND_YESTERDAY" -H "Authorization: $STAFF_TOKEN"
curl -s -o /dev/null -X POST "$BASE/api/vault/stats/rebuild?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN"

TODAY_REVENUE_AFTER_DAYBOUND="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY" | jval "totals.revenue")"
[ "$TODAY_REVENUE_AFTER_DAYBOUND" = "$TODAY_REVENUE_BEFORE_DAYBOUND" ] \
  || fail "a sale dated yesterday changed today's reports/sales revenue from $TODAY_REVENUE_BEFORE_DAYBOUND to $TODAY_REVENUE_AFTER_DAYBOUND, even after a fresh rebuild of today"

YESTERDAY_REPORT_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$DAYBOUND_YESTERDAY&to=$DAYBOUND_YESTERDAY")"
YESTERDAY_REVENUE="$(echo "$YESTERDAY_REPORT_JSON" | jval "totals.revenue")"
[ "${YESTERDAY_REVENUE:-0}" -ge "$DAYBOUND_AMOUNT" ] \
  || fail "reports/sales for yesterday is '$YESTERDAY_REVENUE', expected at least $DAYBOUND_AMOUNT (the day-boundary sale, keyed on occurred_at)"
ok "a sale's occurred_at, not created, decides which day's daily row and report it belongs to"

# --- 21q. group=week/month produce one bucket per week/month across a wide
#     range, each correctly labelled, and compare=previous is a same-length
#     window immediately before the range, not the previous calendar
#     month/week --------------------------------------------------------
FORTYDAYS_AGO="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00.000Z"); d.setUTCDate(d.getUTCDate()-40); process.stdout.write(d.toISOString().slice(0,10));' "$TODAY")"
WEEK_SERIES_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$FORTYDAYS_AGO&to=$TODAY&group=week")"
WEEK_SERIES_CHECK="$(echo "$WEEK_SERIES_JSON" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const labels = (body.series || []).map((s) => s.label);
  const mondayRe = /^\d{4}-\d{2}-\d{2}$/;
  const allMondays = labels.every((l) => mondayRe.test(l));
  const unique = new Set(labels).size === labels.length;
  process.stdout.write(labels.length > 1 && allMondays && unique ? "ok" : "bad:" + JSON.stringify(labels));
')"
[ "$WEEK_SERIES_CHECK" = "ok" ] \
  || fail "group=week over a 41-day range did not produce multiple, uniquely-labelled Monday buckets: $WEEK_SERIES_CHECK"

SEVENTYDAYS_AGO="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00.000Z"); d.setUTCDate(d.getUTCDate()-70); process.stdout.write(d.toISOString().slice(0,10));' "$TODAY")"
MONTH_SERIES_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$SEVENTYDAYS_AGO&to=$TODAY&group=month")"
MONTH_SERIES_CHECK="$(echo "$MONTH_SERIES_JSON" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const labels = (body.series || []).map((s) => s.label);
  const monthRe = /^\d{4}-\d{2}$/;
  const allMonths = labels.every((l) => monthRe.test(l));
  const unique = new Set(labels).size === labels.length;
  process.stdout.write(labels.length >= 2 && allMonths && unique ? "ok" : "bad:" + JSON.stringify(labels));
')"
[ "$MONTH_SERIES_CHECK" = "ok" ] \
  || fail "group=month over a 71-day range did not produce at least two, uniquely-labelled YYYY-MM buckets: $MONTH_SERIES_CHECK"
ok "group=week and group=month each produce one correctly labelled bucket per week/month across a wide range"

COMPARE_MONTH_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$SEVENTYDAYS_AGO&to=$TODAY&group=month&compare=previous")"
COMPARE_MONTH_CHECK="$(echo "$COMPARE_MONTH_JSON" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const days = (a, b) => Math.round((Date.parse(b + "T00:00:00.000Z") - Date.parse(a + "T00:00:00.000Z")) / 86400000) + 1;
  const mainLen = days(body.from, body.to);
  const prevLen = days(body.compare.from, body.compare.to);
  const dayBefore = new Date(Date.parse(body.from + "T00:00:00.000Z"));
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const expectedPrevTo = dayBefore.toISOString().slice(0, 10);
  process.stdout.write(mainLen === prevLen && body.compare.to === expectedPrevTo ? "ok" : `bad: main=${mainLen} prev=${prevLen} compare.to=${body.compare.to} expected=${expectedPrevTo}`);
')"
[ "$COMPARE_MONTH_CHECK" = "ok" ] \
  || fail "compare=previous with group=month is not a same-length window ending the day before 'from': $COMPARE_MONTH_CHECK"
ok "compare=previous is a same-length window immediately before the range, not the previous calendar month"

# --- 21r. The sales heatmap reads in Europe/London time, not raw UTC - a
#     sale at 10:00 UTC today (British Summer Time, +1 hour, in September)
#     lands in the 11:00 local bucket, not the 10:00 UTC one --------------
HEATMAP_WEEKDAY="$(node -e '
  const d = new Date(process.argv[1] + "T00:00:00.000Z");
  process.stdout.write(String((d.getUTCDay() + 6) % 7));
' "$TODAY")"
HEATMAP_BEFORE_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY" | jval "totals.heatmap.$HEATMAP_WEEKDAY.11")"
HEATMAP_ITEM_ID="$(make_item "Heatmap London Time Item" 1 100 500)"
[ -n "$HEATMAP_ITEM_ID" ] || fail "could not create the heatmap-check item"
HEATMAP_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/sales/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"number\":\"GG-S-HEATMAP1\",\"subtotal\":500,\"discount\":0,\"total\":500,\"payment\":\"cash\",\"status\":\"complete\",\"occurred_at\":\"$TODAY 10:00:00.000Z\"}")"
HEATMAP_SALE_STATUS="$(echo "$HEATMAP_SALE_JSON" | tail -n1)"
[ "$HEATMAP_SALE_STATUS" = "200" ] || fail "creating the heatmap-check sale at 10:00 UTC returned $HEATMAP_SALE_STATUS: $(echo "$HEATMAP_SALE_JSON" | head -n -1)"

HEATMAP_AFTER_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY")"
HEATMAP_AFTER_1100="$(echo "$HEATMAP_AFTER_JSON" | jval "totals.heatmap.$HEATMAP_WEEKDAY.11")"
HEATMAP_AFTER_1000="$(echo "$HEATMAP_AFTER_JSON" | jval "totals.heatmap.$HEATMAP_WEEKDAY.10")"
[ "$((HEATMAP_AFTER_1100 - HEATMAP_BEFORE_JSON))" = "1" ] \
  || fail "a sale at 10:00 UTC (11:00 BST) did not add one count to the heatmap's 11:00 local bucket (before $HEATMAP_BEFORE_JSON, after $HEATMAP_AFTER_1100)"
ok "the sales heatmap buckets a 10:00 UTC sale at 11:00, Europe/London's British Summer Time, not raw UTC"

# --- 21s. Stock ageing: the 180+ bucket's max is JSON null (never
#     Infinity, which breaks response encoding), a very old item lands in
#     it and in dead_stock, and an item with no acquired_at at all gets its
#     own "unknown" bucket rather than being miscounted as freshly acquired
#     -------------------------------------------------------------------
OLD_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"title\":\"Dead Stock Check Item\",\"qty\":1,\"cost\":500,\"price\":1000,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"acquired_at\":\"2024-01-01 09:00:00.000Z\"}" | jval id)"
[ -n "$OLD_ITEM_ID" ] || fail "could not create the dead-stock-check item"

UNKNOWN_AGE_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"title\":\"Unknown Acquired Date Item\",\"qty\":1,\"cost\":200,\"price\":400,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}" | jval id)"
[ -n "$UNKNOWN_AGE_ITEM_ID" ] || fail "could not create the unknown-acquired-date item"

STOCK_AGEING_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/stock?from=$TODAY&to=$TODAY")"
STOCK_AGEING_CHECK="$(echo "$STOCK_AGEING_JSON" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const buckets = body.totals.ageing_buckets || [];
  const openEnded = buckets.find((b) => b.bucket === "180+");
  const unknown = buckets.find((b) => b.bucket === "unknown");
  const zeroThirty = buckets.find((b) => b.bucket === "0-30");
  const problems = [];
  if (!openEnded || !("max" in openEnded) || openEnded.max !== null) problems.push("180+ bucket max is not JSON null: " + JSON.stringify(openEnded));
  if (!openEnded || openEnded.count < 1) problems.push("180+ bucket count is not at least 1");
  if (!unknown || unknown.count < 1) problems.push("unknown bucket is missing or has no items: " + JSON.stringify(unknown));
  const deadRow = (body.totals.dead_stock || []).find((d) => d.item_id === process.argv[1]);
  if (!deadRow) problems.push("the 2024-01-01 item is not in dead_stock");
  process.stdout.write(problems.length ? "bad: " + problems.join("; ") : "ok");
' "$OLD_ITEM_ID")"
[ "$STOCK_AGEING_CHECK" = "ok" ] || fail "$STOCK_AGEING_CHECK"
ok "the 180+ ageing bucket has a JSON null max, a very old item reaches it and dead_stock, and a blank acquired_at gets its own unknown bucket"

# --- 21t. Finish-aware stock valuation: two items of the same card but
#     different finishes are valued off their own finish's price_snapshot,
#     never off each other's ------------------------------------------
FINISH_CARD_SET_ID="$(curl -s -X POST "$BASE/api/collections/card_sets/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"code\":\"finish-check-set\",\"name\":\"Finish Check Set\"}" | jval id)"
[ -n "$FINISH_CARD_SET_ID" ] || fail "could not create the finish-check card set"
FINISH_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$FINISH_CARD_SET_ID\",\"number\":\"1\",\"name\":\"Finish Check Card\"}" | jval id)"
[ -n "$FINISH_CARD_ID" ] || fail "could not create the finish-check card"

FINISH_FETCHED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
FINISH_NORMAL_MARKET=1500
FINISH_HOLO_MARKET=4200
curl -s -o /dev/null -X POST "$BASE/api/collections/price_snapshots/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"card\":\"$FINISH_CARD_ID\",\"finish\":\"\",\"source\":\"uk_sold_manual\",\"native_currency\":\"GBP\",\"native_market\":$FINISH_NORMAL_MARKET,\"fx_rate\":1,\"gbp_market\":$FINISH_NORMAL_MARKET,\"fetched_at\":\"$FINISH_FETCHED_AT\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/price_snapshots/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"card\":\"$FINISH_CARD_ID\",\"finish\":\"holo\",\"source\":\"uk_sold_manual\",\"native_currency\":\"GBP\",\"native_market\":$FINISH_HOLO_MARKET,\"fx_rate\":1,\"gbp_market\":$FINISH_HOLO_MARKET,\"fetched_at\":\"$FINISH_FETCHED_AT\"}"

STOCK_VALUE_BEFORE_FINISH="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/stock?from=$TODAY&to=$TODAY" | jval "totals.value_market")"

curl -s -o /dev/null -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$FINISH_CARD_ID\",\"finish\":\"\",\"condition\":\"NM\",\"qty\":1,\"cost\":100,\"market_at_intake\":$FINISH_NORMAL_MARKET,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$FINISH_CARD_ID\",\"finish\":\"holo\",\"condition\":\"NM\",\"qty\":1,\"cost\":100,\"market_at_intake\":$FINISH_HOLO_MARKET,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}"

STOCK_VALUE_AFTER_FINISH="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/stock?from=$TODAY&to=$TODAY" | jval "totals.value_market")"
FINISH_EXPECTED_DELTA=$((FINISH_NORMAL_MARKET + FINISH_HOLO_MARKET))
[ "$((STOCK_VALUE_AFTER_FINISH - STOCK_VALUE_BEFORE_FINISH))" = "$FINISH_EXPECTED_DELTA" ] \
  || fail "adding a normal and a holo copy of the same card moved totals.value_market by $((STOCK_VALUE_AFTER_FINISH - STOCK_VALUE_BEFORE_FINISH)), expected exactly $FINISH_EXPECTED_DELTA ($FINISH_NORMAL_MARKET + $FINISH_HOLO_MARKET, each priced off its own finish's snapshot)"
ok "stock valuation prices a normal and a holo copy of the same card off their own finish's price_snapshot, not each other's"

# --- 21u. cash, loyalty and customers report totals agree with the raw
#     ledgers, independently computed - and customers' top_by_spend is net
#     of refunds -----------------------------------------------------------
curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=closed_at>='${TODAY} 00:00:00.000Z' && closed_at<='${TODAY} 23:59:59.999Z'" \
  --data-urlencode "perPage=500" \
  "$BASE/api/collections/cash_sessions/records" >"$TMP_DIR/stats-today-sessions.json"
curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=created>='${TODAY} 00:00:00.000Z' && created<='${TODAY} 23:59:59.999Z'" \
  --data-urlencode "perPage=500" \
  "$BASE/api/collections/points_ledger/records" >"$TMP_DIR/stats-today-points.json"

CASH_LOYALTY_EXPECTED_JSON="$(node -e '
  const fs = require("fs");
  const sessions = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items || [];
  const points = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).items || [];
  let varianceTotal = 0;
  for (const s of sessions) varianceTotal += s.variance;
  let earned = 0;
  let redeemed = 0;
  for (const p of points) {
    if (p.delta > 0) earned += p.delta;
    else redeemed += -p.delta;
  }
  process.stdout.write(JSON.stringify({ varianceTotal, sessionCount: sessions.length, earned, redeemed }));
' "$TMP_DIR/stats-today-sessions.json" "$TMP_DIR/stats-today-points.json")"

EXPECTED_VARIANCE_TOTAL="$(echo "$CASH_LOYALTY_EXPECTED_JSON" | jval varianceTotal)"
EXPECTED_SESSION_COUNT="$(echo "$CASH_LOYALTY_EXPECTED_JSON" | jval sessionCount)"
EXPECTED_POINTS_EARNED="$(echo "$CASH_LOYALTY_EXPECTED_JSON" | jval earned)"
EXPECTED_POINTS_REDEEMED="$(echo "$CASH_LOYALTY_EXPECTED_JSON" | jval redeemed)"

REPORT_CASH_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/cash?from=$TODAY&to=$TODAY")"
[ "$(echo "$REPORT_CASH_JSON" | jval "totals.variance_total")" = "$EXPECTED_VARIANCE_TOTAL" ] \
  || fail "reports/cash totals.variance_total is '$(echo "$REPORT_CASH_JSON" | jval "totals.variance_total")', expected $EXPECTED_VARIANCE_TOTAL"
[ "$(echo "$REPORT_CASH_JSON" | jval "totals.session_count")" = "$EXPECTED_SESSION_COUNT" ] \
  || fail "reports/cash totals.session_count is '$(echo "$REPORT_CASH_JSON" | jval "totals.session_count")', expected $EXPECTED_SESSION_COUNT"

REPORT_LOYALTY_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/loyalty?from=$TODAY&to=$TODAY")"
[ "$(echo "$REPORT_LOYALTY_JSON" | jval "totals.points_earned")" = "$EXPECTED_POINTS_EARNED" ] \
  || fail "reports/loyalty totals.points_earned is '$(echo "$REPORT_LOYALTY_JSON" | jval "totals.points_earned")', expected $EXPECTED_POINTS_EARNED"
[ "$(echo "$REPORT_LOYALTY_JSON" | jval "totals.points_redeemed")" = "$EXPECTED_POINTS_REDEEMED" ] \
  || fail "reports/loyalty totals.points_redeemed is '$(echo "$REPORT_LOYALTY_JSON" | jval "totals.points_redeemed")', expected $EXPECTED_POINTS_REDEEMED"
ok "reports/cash and reports/loyalty totals agree with the raw cash_sessions and points_ledger rows"

STATS_SALE_NOW_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/collections/sales/records/$STATS_SALE_ID")"
STATS_SALE_TOTAL_FOR_CUSTOMER="$(echo "$STATS_SALE_NOW_JSON" | jval total)"
STATS_SALE_REFUNDED_FOR_CUSTOMER="$(echo "$STATS_SALE_NOW_JSON" | jval refunded_total)"
STATS_SALE_NET="$((STATS_SALE_TOTAL_FOR_CUSTOMER - STATS_SALE_REFUNDED_FOR_CUSTOMER))"
REPORT_CUSTOMERS_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/customers?from=$TODAY&to=$TODAY")"
CUSTOMERS_TOP_SPEND_CHECK="$(echo "$REPORT_CUSTOMERS_JSON" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const row = (body.totals.top_by_spend || []).find((r) => r.customer === process.argv[1]);
  process.stdout.write(row ? String(row.amount) : "missing");
' "$STATS_CUSTOMER_ID")"
[ "$CUSTOMERS_TOP_SPEND_CHECK" = "$STATS_SALE_NET" ] \
  || fail "reports/customers top_by_spend for the stats-check customer is '$CUSTOMERS_TOP_SPEND_CHECK', expected $STATS_SALE_NET (net of the seeded refund)"
ok "reports/customers top_by_spend is net of refunds"

# --- 21v. CSV export formatting: attachment headers, no-store, and a money
#     column renders in pounds, never raw pence ---------------------------
curl -s -D "$TMP_DIR/margin-csv-headers.txt" -o "$TMP_DIR/margin-report.csv" \
  -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/margin.csv?from=$TODAY&to=$TODAY"
grep -qi 'Content-Disposition: attachment; filename="margin-' "$TMP_DIR/margin-csv-headers.txt" \
  || fail "reports/margin.csv has no attachment Content-Disposition: $(cat "$TMP_DIR/margin-csv-headers.txt")"
grep -qi 'Cache-Control: no-store' "$TMP_DIR/margin-csv-headers.txt" \
  || fail "reports/margin.csv has no Cache-Control: no-store: $(cat "$TMP_DIR/margin-csv-headers.txt")"
grep -qi 'Content-Type: text/csv' "$TMP_DIR/margin-csv-headers.txt" \
  || fail "reports/margin.csv is not served as text/csv: $(cat "$TMP_DIR/margin-csv-headers.txt")"
MARGIN_CSV_POUNDS_CHECK="$(node -e '
  const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split(/\r\n/);
  const header = rows[0].split(",");
  const revenueCol = header.indexOf("Revenue");
  if (revenueCol < 0) { process.stdout.write("no Revenue column"); process.exit(0); }
  const dataRow = rows.slice(1).find((r) => r.split(",")[revenueCol] && r.split(",")[revenueCol] !== "0.00");
  if (!dataRow) { process.stdout.write("ok-no-nonzero-row"); process.exit(0); }
  const cell = dataRow.split(",")[revenueCol];
  process.stdout.write(/^-?\d+\.\d{2}$/.test(cell) ? "ok" : "bad cell: " + cell);
' "$TMP_DIR/margin-report.csv")"
[ "$MARGIN_CSV_POUNDS_CHECK" = "ok" ] || [ "$MARGIN_CSV_POUNDS_CHECK" = "ok-no-nonzero-row" ] \
  || fail "reports/margin.csv's Revenue column is not plain pounds-and-pence: $MARGIN_CSV_POUNDS_CHECK"
ok "reports/margin.csv is served as an attachment, no-store, with money columns in plain pounds"

# --- 21w. The nightly "stats" cron rebuilds the last 7 UTC days, not just
#     today or yesterday: a sale dated 5 days ago (outside any row built so
#     far this run) is picked up; one dated 10 days ago (outside the
#     7-day window) is not --------------------------------------------
FIVE_DAYS_AGO="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00.000Z"); d.setUTCDate(d.getUTCDate()-5); process.stdout.write(d.toISOString().slice(0,10));' "$TODAY")"
TEN_DAYS_AGO="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00.000Z"); d.setUTCDate(d.getUTCDate()-10); process.stdout.write(d.toISOString().slice(0,10));' "$TODAY")"

curl -s -o /dev/null -X POST "$BASE/api/collections/sales/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"number\":\"GG-S-CRON7DAY1\",\"subtotal\":6543,\"discount\":0,\"total\":6543,\"payment\":\"cash\",\"status\":\"complete\",\"occurred_at\":\"$FIVE_DAYS_AGO 12:00:00.000Z\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/sales/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"number\":\"GG-S-CRON10DAY1\",\"subtotal\":8765,\"discount\":0,\"total\":8765,\"payment\":\"cash\",\"status\":\"complete\",\"occurred_at\":\"$TEN_DAYS_AGO 12:00:00.000Z\"}"

# Both days start with no stored daily_stats row (never built by any
# earlier check in this run - 5 and 10 days back are well clear of
# anything section 1-20 or the rest of section 21 touches).
CRON7_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/stats" -H "Authorization: $SUPER_TOKEN")"
[ "$CRON7_STATUS" = "204" ] || fail "POST /api/crons/stats returned $CRON7_STATUS, expected 204"

wait_for_daily_row() {
  # $1 date -> the daily_stats row JSON once it exists, or the last (empty) response after ~10 seconds.
  local date="$1"
  local tries=0
  local json=""
  while [ "$tries" -lt 40 ]; do
    json="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
      --data-urlencode "filter=date>='${date} 00:00:00.000Z' && date<='${date} 23:59:59.999Z'" \
      "$BASE/api/collections/daily_stats/records")"
    if [ "$(echo "$json" | jval totalItems)" -ge 1 ] 2>/dev/null; then
      echo "$json"
      return 0
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  echo "$json"
}

CRON7_FIVE_DAYS_ROW="$(wait_for_daily_row "$FIVE_DAYS_AGO")"
[ "$(echo "$CRON7_FIVE_DAYS_ROW" | jval totalItems)" -ge 1 ] \
  || fail "the nightly stats cron did not build a daily_stats row for 5 days ago ($FIVE_DAYS_AGO): $CRON7_FIVE_DAYS_ROW"
[ "$(echo "$CRON7_FIVE_DAYS_ROW" | jval "items.0.sales_total_by_payment.cash")" -ge 6543 ] \
  || fail "the 5-days-ago daily row's cash total is '$(echo "$CRON7_FIVE_DAYS_ROW" | jval "items.0.sales_total_by_payment.cash")', expected at least 6543"

CRON7_TEN_DAYS_ROW="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=date>='${TEN_DAYS_AGO} 00:00:00.000Z' && date<='${TEN_DAYS_AGO} 23:59:59.999Z'" \
  "$BASE/api/collections/daily_stats/records")"
[ "$(echo "$CRON7_TEN_DAYS_ROW" | jval totalItems)" = "0" ] \
  || fail "the nightly stats cron (last 7 UTC days) built a row for 10 days ago, outside its own window: $CRON7_TEN_DAYS_ROW"
ok "the nightly stats cron rebuilds the last 7 UTC days (picks up a sale from 5 days ago, leaves 10 days ago untouched)"

# --- 21x. Admin-only saved reports: a non-admin-owned compliance schedule
#     is skipped (never sent, however it was saved) and audited as such;
#     an admin-owned one still sends (under test_mode) - the cron re-checks
#     this itself rather than trusting the collection rules alone --------
SCHEDADMIN_ADMIN_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval id)"
SCHEDADMIN_PLAIN_STAFF_ID="$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=email='$PLAIN_EMAIL'" "$BASE/api/collections/staff/records" | jval "items.0.id")"
[ -n "$SCHEDADMIN_PLAIN_STAFF_ID" ] || fail "could not resolve the plain staff member's own id"

# Written with the superuser token, bypassing saved_reports' own rules -
# exactly the "row written straight against the database" case
# lib/reports/scheduled.js's own admin re-check exists for.
SCHEDADMIN_NONADMIN_ROW="$(curl -s -X POST "$BASE/api/collections/saved_reports/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"owner\":\"$SCHEDADMIN_PLAIN_STAFF_ID\",\"report_key\":\"compliance\",\"name\":\"Nonadmin Compliance Check\",\"schedule\":\"weekly\",\"recipients\":[\"$PLAIN_EMAIL\"]}" | jval id)"
[ -n "$SCHEDADMIN_NONADMIN_ROW" ] || fail "could not create the non-admin-owned compliance saved_reports row"

SCHEDADMIN_ADMIN_ROW="$(curl -s -X POST "$BASE/api/collections/saved_reports/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"owner\":\"$SCHEDADMIN_ADMIN_ID\",\"report_key\":\"compliance\",\"name\":\"Admin Compliance Check\",\"schedule\":\"weekly\",\"recipients\":[\"$STAFF_EMAIL\"]}" | jval id)"
[ -n "$SCHEDADMIN_ADMIN_ROW" ] || fail "could not create the admin-owned compliance saved_reports row"

SCHEDADMIN_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/scheduled_reports_weekly" -H "Authorization: $SUPER_TOKEN")"
[ "$SCHEDADMIN_CRON_STATUS" = "204" ] || fail "POST /api/crons/scheduled_reports_weekly (admin-gate check) returned $SCHEDADMIN_CRON_STATUS, expected 204"

SCHEDADMIN_SKIPPED_AUDIT="$(wait_for_audit_row "perPage=10&filter=action%3D%22saved_report_skipped%22%26%26record%3D%22$SCHEDADMIN_NONADMIN_ROW%22")"
[ "$(echo "$SCHEDADMIN_SKIPPED_AUDIT" | jval totalItems)" -ge 1 ] \
  || fail "a compliance saved report owned by a non-admin was not skipped (no saved_report_skipped audit row): $SCHEDADMIN_SKIPPED_AUDIT"
echo "$SCHEDADMIN_SKIPPED_AUDIT" | grep -q '"reason":"admin_only"' \
  || fail "the saved_report_skipped audit row does not name admin_only as the reason: $SCHEDADMIN_SKIPPED_AUDIT"

SCHEDADMIN_SENT_AUDIT="$(wait_for_audit_row "perPage=10&filter=action%3D%22saved_report_sent%22%26%26record%3D%22$SCHEDADMIN_ADMIN_ROW%22")"
[ "$(echo "$SCHEDADMIN_SENT_AUDIT" | jval totalItems)" -ge 1 ] \
  || fail "a compliance saved report owned by an admin was not sent: $SCHEDADMIN_SENT_AUDIT"
ok "a compliance saved report owned by a non-admin is skipped and audited; one owned by an admin still sends"

# --- 21y. An unknown report key (including the prototype-chain key
#     "constructor") 404s cleanly; an invalid calendar date (2026-02-30,
#     shaped right but not a real day) 400s -------------------------------
UNKNOWN_KEY_STATUS="$(curl -s -o "$TMP_DIR/unknown-key.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/banana-report-xyz?from=$TODAY&to=$TODAY")"
[ "$UNKNOWN_KEY_STATUS" = "404" ] || fail "an unknown report key returned $UNKNOWN_KEY_STATUS, expected 404: $(cat "$TMP_DIR/unknown-key.json")"

CONSTRUCTOR_KEY_STATUS="$(curl -s -o "$TMP_DIR/constructor-key.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/constructor?from=$TODAY&to=$TODAY")"
[ "$CONSTRUCTOR_KEY_STATUS" = "404" ] \
  || fail "the report key 'constructor' returned $CONSTRUCTOR_KEY_STATUS, expected 404 (it must not resolve to Object.prototype.constructor): $(cat "$TMP_DIR/constructor-key.json")"
ok "an unknown report key and the prototype-chain key 'constructor' both 404 cleanly"

BAD_CALENDAR_DATE_STATUS="$(curl -s -o "$TMP_DIR/bad-calendar-date.json" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=2026-02-30&to=2026-02-30")"
[ "$BAD_CALENDAR_DATE_STATUS" = "400" ] \
  || fail "from=2026-02-30 (shaped right, not a real day) returned $BAD_CALENDAR_DATE_STATUS, expected 400: $(cat "$TMP_DIR/bad-calendar-date.json")"
ok "an invalid calendar date that is only shaped like YYYY-MM-DD (2026-02-30) is refused with 400"

# --- 21z. A plain staff token (no admin role) can read every report except
#     the admin-only ones - compliance and audit.csv, already checked in
#     21j -------------------------------------------------------------
STAFFALL_CHECK="ok"
for key in sales buyins margin stock channels customers loyalty cash; do
  status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/reports/$key?from=$TODAY&to=$TODAY")"
  if [ "$status" != "200" ]; then
    STAFFALL_CHECK="bad: $key returned $status"
    break
  fi
done
[ "$STAFFALL_CHECK" = "ok" ] || fail "a plain staff token could not read every non-admin report: $STAFFALL_CHECK"
ok "a plain staff token (no admin role) reads all 8 non-admin reports"

# -----------------------------------------------------------------------
# 22. Phase 4: exports, imports and SumUp. Still under
#     GG_ADAPTER_TRANSPORT_MODE=fixture (see section 19's own note), so
#     the SumUp pull below calls pb_hooks/adapters/fixture_transport.js's
#     own SumUp mapping rather than the real network.
# -----------------------------------------------------------------------

curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"api_keys":{"sumup":"fixture-sumup-key"},"sumup":{"merchant_code":"MFIXTURE1"}}'

# --- 22a. The SumUp export: header row, SKU prefix, 0 tax for margin,
#     sumup_synced_at semantics ------------------------------------------
SUMUP_ITEM_ID="$(make_item "SumUp CSV Item" 1 500 1999)"
[ -n "$SUMUP_ITEM_ID" ] || fail "could not create the SumUp export check's item"
SUMUP_ITEM_SKU="$(curl -s "$BASE/api/collections/items/records/$SUMUP_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval sku)"
[ -n "$SUMUP_ITEM_SKU" ] || fail "the SumUp export check's item has no sku"
SUMUP_ITEM_SKU_DISPLAY="${SUMUP_ITEM_SKU:0:3}-${SUMUP_ITEM_SKU:3}"

SUMUP_DRYRUN_CSV="$(curl -s "$BASE/api/vault/exports/sumup.csv?dry_run=1" -H "Authorization: $STAFF_TOKEN")"
echo "$SUMUP_DRYRUN_CSV" | head -n1 | grep -qF "Item name,Description,Category,Price,SKU,Barcode,Quantity,Tax rate (%),Variations,Option set 1,Option set 2,Option set 3,Option set 4,Modifiers,Display colour" \
  || fail "the SumUp export CSV header row is wrong: $(echo "$SUMUP_DRYRUN_CSV" | head -n1)"
ok "the SumUp export CSV has the documented header row"

echo "$SUMUP_DRYRUN_CSV" | grep -qF "$SUMUP_ITEM_SKU_DISPLAY SumUp CSV Item" \
  || fail "the SumUp export did not prefix the item name with the display SKU: $SUMUP_DRYRUN_CSV"
ok "the SumUp export prefixes the item name with the SKU"

SUMUP_TAX_RATE="$(echo "$SUMUP_DRYRUN_CSV" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const sku = process.argv[1];
    for (const line of d.split(/\r\n/).filter(Boolean)) {
      const cells = line.split(",");
      if (cells[4] === sku) { process.stdout.write(cells[7] || ""); return; }
    }
    process.stdout.write("");
  });
' "$SUMUP_ITEM_SKU")"
[ "$SUMUP_TAX_RATE" = "0" ] || fail "the SumUp export tax rate for a margin-scheme item is '$SUMUP_TAX_RATE', expected 0"
ok "the SumUp export writes 0 tax for a margin-scheme item"

SUMUP_SYNCED_AFTER_DRYRUN="$(curl -s "$BASE/api/collections/items/records/$SUMUP_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval sumup_synced_at)"
[ -z "$SUMUP_SYNCED_AFTER_DRYRUN" ] || fail "dry_run=1 set sumup_synced_at anyway: $SUMUP_SYNCED_AFTER_DRYRUN"

SUMUP_REAL_CSV="$(curl -s "$BASE/api/vault/exports/sumup.csv" -H "Authorization: $STAFF_TOKEN")"
echo "$SUMUP_REAL_CSV" | grep -qF "$SUMUP_ITEM_SKU_DISPLAY SumUp CSV Item" \
  || fail "the real SumUp export did not include the not-yet-synced item: $SUMUP_REAL_CSV"
SUMUP_SYNCED_AFTER_REAL="$(curl -s "$BASE/api/collections/items/records/$SUMUP_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval sumup_synced_at)"
[ -n "$SUMUP_SYNCED_AFTER_REAL" ] || fail "the real SumUp export did not set sumup_synced_at"
ok "the SumUp export sets sumup_synced_at on export, and dry_run=1 leaves it untouched"

SUMUP_REAL_CSV_AGAIN="$(curl -s "$BASE/api/vault/exports/sumup.csv" -H "Authorization: $STAFF_TOKEN")"
echo "$SUMUP_REAL_CSV_AGAIN" | grep -qF "$SUMUP_ITEM_SKU" && fail "an already-synced item reappeared in the SumUp export with no since parameter"
ok "an already-synced item does not reappear in the SumUp export once sumup_synced_at is set"

# --- 22b. The eBay listing CSV for two ids -------------------------------
EBAY_LIST_A="$(make_item "Ebay List Item A" 1 200 999)"
EBAY_LIST_B="$(make_item "Ebay List Item B" 1 200 1499)"
[ -n "$EBAY_LIST_A" ] && [ -n "$EBAY_LIST_B" ] || fail "could not create the eBay listing check's items"

EBAY_LISTING_CSV="$(curl -s "$BASE/api/vault/exports/ebay-listings.csv?ids=$EBAY_LIST_A,$EBAY_LIST_B" -H "Authorization: $STAFF_TOKEN")"
echo "$EBAY_LISTING_CSV" | head -n1 | grep -qF "Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193),Custom label (SKU),Title,Description,Category,ConditionID,Format,Duration,StartPrice,Quantity,ImageURL,Location,PostalCode" \
  || fail "the eBay listing CSV header row is wrong: $(echo "$EBAY_LISTING_CSV" | head -n1)"
EBAY_LISTING_ROWS="$(echo "$EBAY_LISTING_CSV" | tail -n +2 | grep -c 'Ebay List Item')"
[ "$EBAY_LISTING_ROWS" = "2" ] || fail "the eBay listing CSV for two ids produced $EBAY_LISTING_ROWS matching rows, expected 2: $EBAY_LISTING_CSV"
ok "the eBay listing CSV for two ids has the documented header row and one row per id"

# --- 22c. Inventory, sales and register exports: header rows, register
#     admin only -----------------------------------------------------------
INVENTORY_CSV="$(curl -s "$BASE/api/vault/exports/inventory.csv" -H "Authorization: $STAFF_TOKEN")"
echo "$INVENTORY_CSV" | head -n1 | grep -qF "SKU,Kind,Game,Title,Set code,Number,Finish,Language,Condition,Completeness,Cosmetic grade,Tested,Region,Grade company,Grade,Certificate number,EAN,Quantity,Cost,Market value at intake,Sell price,Tax scheme,Status,Location,Source,Acquired date,Supplier reference" \
  || fail "the inventory export CSV header row is wrong: $(echo "$INVENTORY_CSV" | head -n1)"
ok "the inventory export has the documented header row"

SALES_CSV="$(curl -s "$BASE/api/vault/exports/sales.csv?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN")"
echo "$SALES_CSV" | head -n1 | grep -qF "Sale number,Date,Staff,Customer,SKU,Item title,Quantity,Unit price,Discount,VAT rate,Tax scheme,Payment method,Sale total,Line status" \
  || fail "the sales export CSV header row is wrong: $(echo "$SALES_CSV" | head -n1)"
ok "the sales export has the documented header row"

REGISTER_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/exports/buy-in-register.csv?from=$TODAY&to=$TODAY")"
[ "$REGISTER_NONADMIN_STATUS" = "403" ] || fail "a non-admin fetching the buy-in register returned $REGISTER_NONADMIN_STATUS, expected 403"

REGISTER_CSV="$(curl -s "$BASE/api/vault/exports/buy-in-register.csv?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN")"
echo "$REGISTER_CSV" | head -n1 | grep -qF "Trade-in number,Date,Staff,Customer,Seller name,Seller address,ID type,ID last four digits,ID expiry,Item description,Condition,Quantity,Market price,Offer price,Payout type,Cash amount,Credit amount,Signature reference" \
  || fail "the buy-in register export CSV header row is wrong: $(echo "$REGISTER_CSV" | head -n1)"
ok "the inventory, sales and buy-in register exports have header rows, and the register is admin only"

# --- 22c2. Row-level content: a money cell reading 19.99, a seller
#     snapshot row, and a formula-injection guard on the inventory export -
INV_MONEY_ROW="$(echo "$INVENTORY_CSV" | grep -F "$SUMUP_ITEM_SKU,")"
[ -n "$INV_MONEY_ROW" ] || fail "the inventory export has no row for $SUMUP_ITEM_SKU: $INVENTORY_CSV"
echo "$INV_MONEY_ROW" | grep -qF ",19.99," || fail "the inventory export's money cell for $SUMUP_ITEM_SKU is not 19.99: $INV_MONEY_ROW"
ok "the inventory export has a row-level money cell reading 19.99"

FORMULA_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"title\":\"=SUM(A1:A2)\",\"qty\":1,\"status\":\"in_stock\"}" | jval id)"
[ -n "$FORMULA_ITEM_ID" ] || fail "could not create the formula-injection check's item"
FORMULA_INVENTORY_CSV="$(curl -s "$BASE/api/vault/exports/inventory.csv" -H "Authorization: $STAFF_TOKEN")"
echo "$FORMULA_INVENTORY_CSV" | grep -qF "\"'=SUM(A1:A2)\"" || fail "the inventory export did not guard a title starting with '=': $(echo "$FORMULA_INVENTORY_CSV" | grep -F 'SUM(A1')"
ok "the inventory export prefixes and quotes a title that opens with '=' (formula-injection guard)"

REGISTER_SNAPSHOT_ROW="$(echo "$REGISTER_CSV" | grep -F "GG-BI-000001")"
[ -n "$REGISTER_SNAPSHOT_ROW" ] || fail "the buy-in register does not list GG-BI-000001: $REGISTER_CSV"
echo "$REGISTER_SNAPSHOT_ROW" | grep -qF "Seller Check" || fail "the buy-in register row for GG-BI-000001 does not carry the seller snapshot name: $REGISTER_SNAPSHOT_ROW"
ok "the buy-in register carries a seller snapshot row for a real completed buy-in"

ROWCHECK_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"title\":\"Sales Row Check Item\",\"qty\":1,\"price\":1999,\"status\":\"in_stock\"}" | jval id)"
ROWCHECK_ITEM_SKU="$(curl -s "$BASE/api/collections/items/records/$ROWCHECK_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval sku)"
curl -s -o /dev/null -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$ROWCHECK_ITEM_ID\",\"qty\":1,\"unit_price\":1999,\"discount\":0}],\"payment\":\"sumup_card\"}"
SALES_CSV_2="$(curl -s "$BASE/api/vault/exports/sales.csv?from=$TODAY&to=$TODAY" -H "Authorization: $STAFF_TOKEN")"
SALES_ROW_CHECK="$(echo "$SALES_CSV_2" | grep -F "$ROWCHECK_ITEM_SKU")"
[ -n "$SALES_ROW_CHECK" ] || fail "the sales export has no row for $ROWCHECK_ITEM_SKU: $SALES_CSV_2"
echo "$SALES_ROW_CHECK" | grep -qF ",19.99," || fail "the sales export row for $ROWCHECK_ITEM_SKU does not show 19.99: $SALES_ROW_CHECK"
ok "the sales export has a row-level money cell reading 19.99"

# --- 22d. end-listings.csv and clearing a listing -------------------------
ENDLIST_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"title\":\"Ended Listing Item\",\"qty\":1,\"status\":\"sold\",\"ebay_listing_id\":\"EBAYLIST123\",\"ebay_sku\":\"CS-999999\"}" | jval id)"
[ -n "$ENDLIST_ITEM_ID" ] || fail "could not create the end-listings check's item"

END_LISTINGS_CSV="$(curl -s "$BASE/api/vault/exports/end-listings.csv" -H "Authorization: $STAFF_TOKEN")"
echo "$END_LISTINGS_CSV" | grep -qF "EBAYLIST123" || fail "end-listings.csv did not list a sold item with an ebay_listing_id: $END_LISTINGS_CSV"
ok "end-listings.csv lists a sold, still-listed item"

END_LISTINGS_STATUS="$(curl -s -o "$TMP_DIR/end-listings.json" -w '%{http_code}' -X POST "$BASE/api/vault/items/end-listings" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"ids\":[\"$ENDLIST_ITEM_ID\"]}")"
[ "$END_LISTINGS_STATUS" = "200" ] || fail "POST /api/vault/items/end-listings returned $END_LISTINGS_STATUS: $(cat "$TMP_DIR/end-listings.json")"
[ "$(jval "ended.0" <"$TMP_DIR/end-listings.json")" = "$ENDLIST_ITEM_ID" ] || fail "end-listings did not report the ended item: $(cat "$TMP_DIR/end-listings.json")"

ENDLIST_AFTER_JSON="$(curl -s "$BASE/api/collections/items/records/$ENDLIST_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$ENDLIST_AFTER_JSON" | jval ebay_listing_id)" = "" ] || fail "end-listings did not clear ebay_listing_id: $ENDLIST_AFTER_JSON"
[ "$(echo "$ENDLIST_AFTER_JSON" | jval ebay_sku)" = "" ] || fail "end-listings did not clear ebay_sku: $ENDLIST_AFTER_JSON"

END_LISTINGS_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22end_ebay_listings%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${END_LISTINGS_AUDIT:-0}" -ge 1 ] || fail "ending an eBay listing wrote no audit_log row"
ok "POST /api/vault/items/end-listings clears the listing and writes an audit row"

# --- 22d2. A Card-Uploader-shaped item (ebay_sku only, no ebay_listing_id)
#     sold at the counter still appears in end-listings.csv ----------------
CU_COUNTER_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"title\":\"Counter Sold Listing\",\"qty\":1,\"price\":1200,\"status\":\"in_stock\",\"ebay_sku\":\"CS-COUNTER-1\"}" | jval id)"
[ -n "$CU_COUNTER_ITEM_ID" ] || fail "could not create the ebay_sku-only end-listings check's item"
curl -s -o /dev/null -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$CU_COUNTER_ITEM_ID\",\"qty\":1,\"unit_price\":1200,\"discount\":0}],\"payment\":\"sumup_card\"}"
[ "$(curl -s "$BASE/api/collections/items/records/$CU_COUNTER_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)" = "sold" ] \
  || fail "the ebay_sku-only item was not sold by the counter sale"

END_LISTINGS_CSV_2="$(curl -s "$BASE/api/vault/exports/end-listings.csv" -H "Authorization: $STAFF_TOKEN")"
echo "$END_LISTINGS_CSV_2" | grep -qF "CS-COUNTER-1" \
  || fail "end-listings.csv did not list a sold item with only an ebay_sku (no ebay_listing_id): $END_LISTINGS_CSV_2"
ok "end-listings.csv lists a Card-Uploader-shaped item (ebay_sku only) sold at the counter"

CU_COUNTER_END_STATUS="$(curl -s -o "$TMP_DIR/end-listings-2.json" -w '%{http_code}' -X POST "$BASE/api/vault/items/end-listings" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"ids\":[\"$CU_COUNTER_ITEM_ID\"]}")"
[ "$CU_COUNTER_END_STATUS" = "200" ] || fail "ending the ebay_sku-only listing returned $CU_COUNTER_END_STATUS: $(cat "$TMP_DIR/end-listings-2.json")"
[ "$(jval "ended.0" <"$TMP_DIR/end-listings-2.json")" = "$CU_COUNTER_ITEM_ID" ] || fail "ending the ebay_sku-only listing did not report it: $(cat "$TMP_DIR/end-listings-2.json")"
[ "$(curl -s "$BASE/api/collections/items/records/$CU_COUNTER_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval ebay_sku)" = "" ] \
  || fail "ending the listing did not clear ebay_sku"
ok "POST /api/vault/items/end-listings clears an ebay_sku-only listing too"

# --- 22e. Card Uploader import: one id-matched row, one name-only review row
CU_SET_ID="$(curl -s -X POST "$BASE/api/collections/card_sets/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"code\":\"cu-fixture-set\",\"name\":\"Card Uploader Fixture Set\"}" | jval id)"
CU_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$CU_SET_ID\",\"number\":\"199\",\"name\":\"Fixture Charizard\",\"tcgplayer_id\":\"TCG-FIX-001\"}" | jval id)"
[ -n "$CU_CARD_ID" ] || fail "could not create the Card Uploader check's cards row"

cat >"$TMP_DIR/card-uploader.csv" <<'EOF'
Card Name,Set,Number,Condition,Price,Quantity,TCGplayer ID,Cardmarket ID,CS SKU
,Scarlet & Violet 151,199,NM,12.50,1,TCG-FIX-001,,CS-000123
Random Uncatalogued Card,Some Set,42,NM,5.00,1,,,
EOF

CU_IMPORT_STATUS="$(curl -s -o "$TMP_DIR/cu-import.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/card-uploader.csv;type=text/csv" \
  -F "type=card_uploader")"
[ "$CU_IMPORT_STATUS" = "200" ] || fail "the Card Uploader import returned $CU_IMPORT_STATUS: $(cat "$TMP_DIR/cu-import.json")"
[ "$(jval matched <"$TMP_DIR/cu-import.json")" = "1" ] || fail "Card Uploader import matched count is wrong: $(cat "$TMP_DIR/cu-import.json")"
[ "$(jval review <"$TMP_DIR/cu-import.json")" = "1" ] || fail "Card Uploader import review count is wrong: $(cat "$TMP_DIR/cu-import.json")"
ok "a Card Uploader file with one id-matched row and one name-only row reports 1 matched, 1 review"

CU_ITEM_JSON="$(curl -s "$BASE/api/collections/items/records?filter=ebay_sku%3D%22CS-000123%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$CU_ITEM_JSON" | jval totalItems)" = "1" ] || fail "the Card Uploader import did not create exactly one item for CS-000123: $CU_ITEM_JSON"
CU_ITEM_ID="$(echo "$CU_ITEM_JSON" | jval "items.0.id")"
[ "$(echo "$CU_ITEM_JSON" | jval "items.0.status")" = "listed_ebay" ] || fail "the Card Uploader-imported item is not listed_ebay: $CU_ITEM_JSON"
[ "$(echo "$CU_ITEM_JSON" | jval "items.0.price")" = "1250" ] || fail "the Card Uploader-imported item price is wrong: $CU_ITEM_JSON"
ok "the id-matched row created one listed_ebay item at the file's price"

CU_IMPORT_ID="$(jval "import.id" <"$TMP_DIR/cu-import.json")"
CU_IMPORT_GET_JSON="$(curl -s "$BASE/api/vault/imports/$CU_IMPORT_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$CU_IMPORT_GET_JSON" | jval rows_total)" = "2" ] || fail "GET the import row has the wrong rows_total: $CU_IMPORT_GET_JSON"
echo "$CU_IMPORT_GET_JSON" | grep -qF "needs match" || fail "GET the import row does not carry the review entry: $CU_IMPORT_GET_JSON"
ok "GET /api/vault/imports/:id returns the row with its review entries"

IMPORT_VIEW_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22import_view%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${IMPORT_VIEW_AUDIT:-0}" -ge 1 ] || fail "GET /api/vault/imports/:id wrote no audit_log row"
ok "GET /api/vault/imports/:id is audited"

# --- 22e2. Card Uploader connects to an item already in stock for the same
#     card, rather than duplicating it (docs/api-contract.md rule 2) -------
CU_STOCK_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$CU_SET_ID\",\"number\":\"6\",\"name\":\"Fixture Pikachu\",\"tcgplayer_id\":\"TCG-FIX-STOCK\"}" | jval id)"
[ -n "$CU_STOCK_CARD_ID" ] || fail "could not create the duplicate-stock check's card"
CU_STOCK_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$CU_STOCK_CARD_ID\",\"condition\":\"NM\",\"qty\":1,\"cost\":300,\"status\":\"in_stock\",\"source\":\"trade_in\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}" | jval id)"
[ -n "$CU_STOCK_ITEM_ID" ] || fail "could not create the duplicate-stock check's already-in-stock item"

cat >"$TMP_DIR/card-uploader-dupe.csv" <<'EOF'
Card Name,Set,Number,Condition,Price,Quantity,TCGplayer ID,Cardmarket ID,CS SKU
,Scarlet & Violet 151,6,NM,8.00,1,TCG-FIX-STOCK,,CS-DUPE-001
EOF
CU_DUPE_STATUS="$(curl -s -o "$TMP_DIR/cu-dupe.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/card-uploader-dupe.csv;type=text/csv")"
[ "$CU_DUPE_STATUS" = "200" ] || fail "the duplicate-stock Card Uploader import returned $CU_DUPE_STATUS: $(cat "$TMP_DIR/cu-dupe.json")"
[ "$(jval matched <"$TMP_DIR/cu-dupe.json")" = "1" ] || fail "the duplicate-stock import's matched count is wrong: $(cat "$TMP_DIR/cu-dupe.json")"

CU_STOCK_CARD_ITEMS="$(curl -s "$BASE/api/collections/items/records?filter=card%3D%22$CU_STOCK_CARD_ID%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$CU_STOCK_CARD_ITEMS" | jval totalItems)" = "1" ] || fail "the Card Uploader import created a duplicate item instead of connecting to the one already in stock: $CU_STOCK_CARD_ITEMS"
CU_STOCK_ITEM_AFTER="$(curl -s "$BASE/api/collections/items/records/$CU_STOCK_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$CU_STOCK_ITEM_AFTER" | jval status)" = "listed_ebay" ] || fail "the already-in-stock item was not connected to the listing: $CU_STOCK_ITEM_AFTER"
[ "$(echo "$CU_STOCK_ITEM_AFTER" | jval ebay_sku)" = "CS-DUPE-001" ] || fail "the already-in-stock item did not get the file's ebay_sku: $CU_STOCK_ITEM_AFTER"
[ "$(echo "$CU_STOCK_ITEM_AFTER" | jval price)" = "800" ] || fail "the already-in-stock item did not get the file's price: $CU_STOCK_ITEM_AFTER"
[ "$(echo "$CU_STOCK_ITEM_AFTER" | jval cost)" = "300" ] || fail "connecting to stock changed the item's cost, which must be left untouched: $CU_STOCK_ITEM_AFTER"
[ "$(echo "$CU_STOCK_ITEM_AFTER" | jval source)" = "trade_in" ] || fail "connecting to stock changed the item's source, which must be left untouched: $CU_STOCK_ITEM_AFTER"
ok "a Card Uploader row for a card already in stock connects to that item rather than duplicating it, leaving cost and source untouched"

# --- 22f. A malformed file, and the wrong declared type -------------------
cat >"$TMP_DIR/malformed.csv" <<'EOF'
not,a,real,header,row
foo,bar
EOF
MALFORMED_STATUS="$(curl -s -o "$TMP_DIR/malformed.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/malformed.csv;type=text/csv")"
[ "$MALFORMED_STATUS" = "400" ] || fail "a malformed CSV import returned $MALFORMED_STATUS, expected 400: $(cat "$TMP_DIR/malformed.json")"
grep -qF "That file is not a CSV we recognise. Check the first line has the column headings." "$TMP_DIR/malformed.json" \
  || fail "the malformed-CSV refusal message is wrong: $(cat "$TMP_DIR/malformed.json")"
ok "a malformed CSV is refused with the documented sentence"

WRONGTYPE_STATUS="$(curl -s -o "$TMP_DIR/wrongtype.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/card-uploader.csv;type=text/csv" \
  -F "type=ebay_orders")"
[ "$WRONGTYPE_STATUS" = "400" ] || fail "posting the wrong declared type returned $WRONGTYPE_STATUS, expected 400: $(cat "$TMP_DIR/wrongtype.json")"
ok "posting the wrong declared type to an import route is refused with 400"

# --- 22g. eBay orders import: sells a listed item, channel ebay and
#     external_ref, a second run reports already sold ---------------------
cat >"$TMP_DIR/ebay-orders.csv" <<'EOF'
Custom Label,Item Number,Order Number,Sale Date,Sold For,Quantity,Sale Currency
CS-000123,110099887766,05-12345,2026-09-20,15.00,1,GBP
EOF

EO_IMPORT_STATUS="$(curl -s -o "$TMP_DIR/eo-import.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/ebay-orders" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/ebay-orders.csv;type=text/csv" \
  -F "type=ebay_orders")"
[ "$EO_IMPORT_STATUS" = "200" ] || fail "the eBay orders import returned $EO_IMPORT_STATUS: $(cat "$TMP_DIR/eo-import.json")"
[ "$(jval sold <"$TMP_DIR/eo-import.json")" = "1" ] || fail "the eBay orders import sold count is wrong: $(cat "$TMP_DIR/eo-import.json")"
[ "$(jval already_sold <"$TMP_DIR/eo-import.json")" = "0" ] || fail "the eBay orders import already_sold count is wrong on the first run: $(cat "$TMP_DIR/eo-import.json")"
ok "an eBay orders file sells the listed item"

[ "$(curl -s "$BASE/api/collections/items/records/$CU_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)" = "sold" ] \
  || fail "the eBay-orders-sold item is not marked sold"

EO_SALE_JSON="$(curl -s "$BASE/api/collections/sales/records?filter=external_ref%3D%2205-12345%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$EO_SALE_JSON" | jval totalItems)" = "1" ] || fail "the eBay orders import did not create exactly one sale with that external_ref: $EO_SALE_JSON"
[ "$(echo "$EO_SALE_JSON" | jval "items.0.channel")" = "ebay" ] || fail "the eBay-orders-created sale is not channel ebay: $EO_SALE_JSON"
[ "$(echo "$EO_SALE_JSON" | jval "items.0.total")" = "1500" ] || fail "the eBay-orders-created sale total is wrong: $EO_SALE_JSON"
ok "the eBay orders import creates a sale of channel ebay with the order reference as external_ref"

EO_IMPORT2_STATUS="$(curl -s -o "$TMP_DIR/eo-import2.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/ebay-orders" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/ebay-orders.csv;type=text/csv")"
[ "$EO_IMPORT2_STATUS" = "200" ] || fail "the second eBay orders import returned $EO_IMPORT2_STATUS: $(cat "$TMP_DIR/eo-import2.json")"
[ "$(jval sold <"$TMP_DIR/eo-import2.json")" = "0" ] || fail "the second eBay orders import should sell nothing new: $(cat "$TMP_DIR/eo-import2.json")"
[ "$(jval already_sold <"$TMP_DIR/eo-import2.json")" = "1" ] || fail "the second eBay orders import did not report already_sold: $(cat "$TMP_DIR/eo-import2.json")"
grep -qF "already sold" "$TMP_DIR/eo-import2.json" || fail "the second run's errors do not say already sold: $(cat "$TMP_DIR/eo-import2.json")"
ok "a second run of the same eBay orders file reports already sold rather than selling it twice"

# --- 22g2. Re-importing a Card Uploader row for an item that has since
#     sold (through the eBay orders import above) is refused as
#     already_sold, not resurrected to listed_ebay ------------------------
CU_REIMPORT_STATUS="$(curl -s -o "$TMP_DIR/cu-reimport.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/card-uploader.csv;type=text/csv")"
[ "$CU_REIMPORT_STATUS" = "200" ] || fail "the Card Uploader re-import returned $CU_REIMPORT_STATUS: $(cat "$TMP_DIR/cu-reimport.json")"
grep -qF "already_sold" "$TMP_DIR/cu-reimport.json" || fail "re-importing a sold item's row was not reported already_sold: $(cat "$TMP_DIR/cu-reimport.json")"
CU_ITEM_AFTER_REIMPORT="$(curl -s "$BASE/api/collections/items/records/$CU_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)"
[ "$CU_ITEM_AFTER_REIMPORT" = "sold" ] || fail "re-importing the same Card Uploader row resurrected a sold item to '$CU_ITEM_AFTER_REIMPORT'"
ok "re-importing a Card Uploader row for an item that has since sold is refused as already_sold, not resurrected"

# --- 22g3. A partial sale of a multi-unit stock line stays listed_ebay ----
CU_MULTI_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"title\":\"Multi Unit Listing\",\"qty\":3,\"price\":1000,\"status\":\"listed_ebay\",\"ebay_sku\":\"CS-MULTI-001\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}" | jval id)"
[ -n "$CU_MULTI_ITEM_ID" ] || fail "could not create the partial-sale check's multi-unit item"

cat >"$TMP_DIR/ebay-orders-partial.csv" <<'EOF'
Custom Label,Item Number,Order Number,Sale Date,Sold For,Quantity,Sale Currency
CS-MULTI-001,220011,ORDER-PARTIAL-1,2026-09-20,10.00,1,GBP
EOF
EO_PARTIAL_STATUS="$(curl -s -o "$TMP_DIR/eo-partial.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/ebay-orders" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/ebay-orders-partial.csv;type=text/csv")"
[ "$EO_PARTIAL_STATUS" = "200" ] || fail "the partial-sale eBay orders import returned $EO_PARTIAL_STATUS: $(cat "$TMP_DIR/eo-partial.json")"
[ "$(jval sold <"$TMP_DIR/eo-partial.json")" = "1" ] || fail "the partial-sale import's sold count is wrong: $(cat "$TMP_DIR/eo-partial.json")"

CU_MULTI_AFTER="$(curl -s "$BASE/api/collections/items/records/$CU_MULTI_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$CU_MULTI_AFTER" | jval status)" = "listed_ebay" ] || fail "selling 1 of 3 units marked the whole line sold: $CU_MULTI_AFTER"
[ "$(echo "$CU_MULTI_AFTER" | jval qty)" = "2" ] || fail "the multi-unit item's qty after selling 1 of 3 is wrong: $CU_MULTI_AFTER"
ok "a partial sale of a multi-unit stock line stays listed_ebay with its qty reduced, not sold"

# --- 22g4. Two rows sharing one order number produce one sale with two
#     lines, and occurred_at is taken from the file's own sale date -------
CU_ORDER_A_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"title\":\"Two Row Order A\",\"qty\":1,\"price\":1000,\"status\":\"listed_ebay\",\"ebay_sku\":\"CS-ORDER2-A\"}" | jval id)"
CU_ORDER_B_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"title\":\"Two Row Order B\",\"qty\":1,\"price\":700,\"status\":\"listed_ebay\",\"ebay_sku\":\"CS-ORDER2-B\"}" | jval id)"
[ -n "$CU_ORDER_A_ID" ] && [ -n "$CU_ORDER_B_ID" ] || fail "could not create the two-row-order check's items"

cat >"$TMP_DIR/ebay-orders-tworow.csv" <<'EOF'
Custom Label,Item Number,Order Number,Sale Date,Sold For,Quantity,Sale Currency
CS-ORDER2-A,330011,ORDER-TWO-1,2026-09-01,10.00,1,GBP
CS-ORDER2-B,330012,ORDER-TWO-1,2026-09-01,7.00,1,GBP
EOF
EO_TWOROW_STATUS="$(curl -s -o "$TMP_DIR/eo-tworow.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/ebay-orders" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/ebay-orders-tworow.csv;type=text/csv")"
[ "$EO_TWOROW_STATUS" = "200" ] || fail "the two-row-order eBay orders import returned $EO_TWOROW_STATUS: $(cat "$TMP_DIR/eo-tworow.json")"
[ "$(jval sold <"$TMP_DIR/eo-tworow.json")" = "2" ] || fail "the two-row-order import's sold count is wrong: $(cat "$TMP_DIR/eo-tworow.json")"

EO_TWOROW_SALE_JSON="$(curl -s "$BASE/api/collections/sales/records?filter=external_ref%3D%22ORDER-TWO-1%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$EO_TWOROW_SALE_JSON" | jval totalItems)" = "1" ] || fail "two rows of one order produced more than one sale: $EO_TWOROW_SALE_JSON"
EO_TWOROW_SALE_ID="$(echo "$EO_TWOROW_SALE_JSON" | jval "items.0.id")"
[ "$(echo "$EO_TWOROW_SALE_JSON" | jval "items.0.total")" = "1700" ] || fail "the two-row-order sale's total is not the sum of both rows: $EO_TWOROW_SALE_JSON"
[ "$(echo "$EO_TWOROW_SALE_JSON" | jval "items.0.occurred_at")" != "" ] || fail "the two-row-order sale has no occurred_at: $EO_TWOROW_SALE_JSON"
echo "$EO_TWOROW_SALE_JSON" | jval "items.0.occurred_at" | grep -qF "2026-09-01" \
  || fail "the two-row-order sale's occurred_at was not taken from the file's own Sale Date: $(echo "$EO_TWOROW_SALE_JSON" | jval "items.0.occurred_at")"
ok "two rows sharing one order number produce one sale with occurred_at from the file's own sale date"

EO_TWOROW_LINES="$(curl -s "$BASE/api/collections/sale_lines/records?filter=sale%3D%22$EO_TWOROW_SALE_ID%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$EO_TWOROW_LINES" = "2" ] || fail "the two-row-order sale does not have exactly two sale_lines: $EO_TWOROW_LINES"
ok "the two-row order's sale carries two sale_lines, one per row"

# An ordinary counter sale (through the completion route) still gets
# channel defaulted to "counter" by the onRecordCreate hook in sales.pb.js.
CHANNEL_ITEM_ID="$(make_item "Channel Default Item" 1 200 650)"
CHANNEL_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$CHANNEL_ITEM_ID\",\"qty\":1,\"unit_price\":650,\"discount\":0}],\"payment\":\"sumup_card\"}")"
CHANNEL_SALE_ID="$(echo "$CHANNEL_SALE_JSON" | jval "sale.id")"
[ -n "$CHANNEL_SALE_ID" ] || fail "could not create the channel-default check's sale"
CHANNEL_ON_SALE="$(curl -s "$BASE/api/collections/sales/records/$CHANNEL_SALE_ID" -H "Authorization: $STAFF_TOKEN" | jval channel)"
[ "$CHANNEL_ON_SALE" = "counter" ] || fail "an ordinary counter sale's channel is '$CHANNEL_ON_SALE', expected counter"
ok "an ordinary counter sale defaults channel to counter"

# --- 22h. The SumUp pull: matches by SKU prefix and by amount+time
#     (including a mixed sale's own card share, not its total), stores a
#     FAILED transaction without matching or counting it, leaves a
#     same-amount transaction outside the three-minute window unmatched, a
#     second pull does not duplicate, reconcile, a non-admin refused ------
SUMUP_SKU_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"sku\":\"GGPAAAAAY\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"title\":\"Fixture Sku Match Item\",\"qty\":1,\"price\":3000,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}" | jval id)"
[ -n "$SUMUP_SKU_ITEM_ID" ] || fail "could not create the SumUp SKU-match item"
SUMUP_SKU_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SUMUP_SKU_ITEM_ID\",\"qty\":1,\"unit_price\":3000,\"discount\":0}],\"payment\":\"sumup_card\"}")"
SUMUP_SKU_SALE_ID="$(echo "$SUMUP_SKU_SALE_JSON" | jval "sale.id")"
[ -n "$SUMUP_SKU_SALE_ID" ] || fail "could not create the SumUp SKU-match sale"

SUMUP_AMOUNT_ITEM_ID="$(make_item "SumUp Amount Match Item" 1 5000 19483)"
SUMUP_AMOUNT_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SUMUP_AMOUNT_ITEM_ID\",\"qty\":1,\"unit_price\":19483,\"discount\":0}],\"payment\":\"sumup_card\"}")"
SUMUP_AMOUNT_SALE_ID="$(echo "$SUMUP_AMOUNT_SALE_JSON" | jval "sale.id")"
[ -n "$SUMUP_AMOUNT_SALE_ID" ] || fail "could not create the SumUp amount+time match sale"

SUMUP_UNMATCHED_ITEM_ID="$(make_item "SumUp Unmatched Item" 1 300 837)"
SUMUP_UNMATCHED_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SUMUP_UNMATCHED_ITEM_ID\",\"qty\":1,\"unit_price\":837,\"discount\":0}],\"payment\":\"sumup_card\"}")"
SUMUP_UNMATCHED_SALE_ID="$(echo "$SUMUP_UNMATCHED_SALE_JSON" | jval "sale.id")"
[ -n "$SUMUP_UNMATCHED_SALE_ID" ] || fail "could not create the SumUp reconcile check's unmatched sale"

# A same-amount sale that must NOT match txn-outside-window-0004: that
# fixture transaction's own timestamp is fixed months in the past, well
# outside the three-minute window around this sale's real (today) created
# time, even though both are exactly 246p.
SUMUP_OUTSIDE_ITEM_ID="$(make_item "SumUp Outside Window Item" 1 100 246)"
SUMUP_OUTSIDE_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SUMUP_OUTSIDE_ITEM_ID\",\"qty\":1,\"unit_price\":246,\"discount\":0}],\"payment\":\"sumup_card\"}")"
SUMUP_OUTSIDE_SALE_ID="$(echo "$SUMUP_OUTSIDE_SALE_JSON" | jval "sale.id")"
[ -n "$SUMUP_OUTSIDE_SALE_ID" ] || fail "could not create the SumUp outside-window check's sale"

# A mixed-payment sale matched by its card share (payment_split.sumup_card
# = 1288), not its total (2000) - the bug finding 1 fixed. Reuses an
# already-open cash session if section 21 or an earlier section left one,
# opens a fresh one otherwise; nothing downstream needs it closed again.
MIXED_SESSION_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id")"
if [ -z "$MIXED_SESSION_ID" ]; then
  MIXED_SESSION_ID="$(curl -s -X POST "$BASE/api/vault/cash-sessions/open" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"float":10000}' | jval id)"
fi
[ -n "$MIXED_SESSION_ID" ] || fail "could not obtain an open cash session for the mixed-payment SumUp check"
SUMUP_MIXED_ITEM_ID="$(make_item "SumUp Mixed Payment Item" 1 500 2000)"
SUMUP_MIXED_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$SUMUP_MIXED_ITEM_ID\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"payment\":\"mixed\",\"payment_split\":{\"sumup_card\":1288,\"cash\":712,\"store_credit\":0,\"points\":0},\"cash_session\":\"$MIXED_SESSION_ID\"}")"
SUMUP_MIXED_SALE_ID="$(echo "$SUMUP_MIXED_SALE_JSON" | jval "sale.id")"
[ -n "$SUMUP_MIXED_SALE_ID" ] || fail "could not create the SumUp mixed-payment check's sale: $SUMUP_MIXED_SALE_JSON"

PULL_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/sumup/pull" -H "Authorization: $PLAIN_TOKEN")"
[ "$PULL_NONADMIN_STATUS" = "403" ] || fail "a non-admin calling sumup/pull got $PULL_NONADMIN_STATUS, expected 403"
ok "a non-admin cannot pull SumUp transactions (403)"

# Five fixture transactions this pull sees: txn-sku-0001 (SKU match),
# txn-amount-0002 (amount+time match), txn-failed-0003 (FAILED - stored,
# never matched or counted), txn-outside-window-0004 (SUCCESSFUL, same
# amount as a real sale but outside the time window - unmatched),
# txn-mixed-0005 (amount+time match, by card share).
PULL1_JSON="$(curl -s -X POST "$BASE/api/vault/sumup/pull" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$PULL1_JSON" | jval fetched)" = "5" ] || fail "the first SumUp pull's fetched count is wrong: $PULL1_JSON"
[ "$(echo "$PULL1_JSON" | jval matched)" = "3" ] || fail "the first SumUp pull's matched count is wrong: $PULL1_JSON"
[ "$(echo "$PULL1_JSON" | jval unmatched)" = "1" ] || fail "the first SumUp pull's unmatched count is wrong: $PULL1_JSON"
[ "$(echo "$PULL1_JSON" | jval refunded)" = "0" ] || fail "the first SumUp pull's refunded count is wrong: $PULL1_JSON"
ok "the first SumUp pull fetches all five fixture transactions and buckets FAILED/unmatched/matched correctly"

SKU_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-sku-0001%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SKU_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-sku-0001 was not upserted exactly once: $SKU_TXN_JSON"
[ "$(echo "$SKU_TXN_JSON" | jval "items.0.matched_sale")" = "$SUMUP_SKU_SALE_ID" ] || fail "txn-sku-0001 did not match the SKU-named sale: $SKU_TXN_JSON"
ok "the SumUp pull matches a sale by a SKU-prefixed product name"

AMOUNT_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-amount-0002%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$AMOUNT_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-amount-0002 was not upserted exactly once: $AMOUNT_TXN_JSON"
[ "$(echo "$AMOUNT_TXN_JSON" | jval "items.0.matched_sale")" = "$SUMUP_AMOUNT_SALE_ID" ] || fail "txn-amount-0002 did not match the amount+time sale: $AMOUNT_TXN_JSON"
ok "the SumUp pull matches a sale by amount and time when the product name carries no SKU"

MIXED_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-mixed-0005%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$MIXED_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-mixed-0005 was not upserted exactly once: $MIXED_TXN_JSON"
[ "$(echo "$MIXED_TXN_JSON" | jval "items.0.matched_sale")" = "$SUMUP_MIXED_SALE_ID" ] || fail "txn-mixed-0005 (12.88) did not match the mixed sale by its card share (12.88 of a 20.00 total): $MIXED_TXN_JSON"
ok "the SumUp pull matches a mixed-payment sale by its card share (payment_split.sumup_card), not its total"

FAILED_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-failed-0003%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$FAILED_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-failed-0003 was not stored: $FAILED_TXN_JSON"
[ "$(echo "$FAILED_TXN_JSON" | jval "items.0.status")" = "FAILED" ] || fail "txn-failed-0003's stored status is wrong: $FAILED_TXN_JSON"
[ "$(echo "$FAILED_TXN_JSON" | jval "items.0.matched_sale")" = "" ] || fail "a FAILED transaction was matched to a sale: $FAILED_TXN_JSON"
ok "a FAILED transaction is stored but never matched (and did not count toward matched/unmatched above)"

OUTSIDE_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-outside-window-0004%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$OUTSIDE_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-outside-window-0004 was not stored: $OUTSIDE_TXN_JSON"
[ "$(echo "$OUTSIDE_TXN_JSON" | jval "items.0.matched_sale")" = "" ] || fail "txn-outside-window-0004 matched a sale despite being outside the three-minute window: $OUTSIDE_TXN_JSON"
ok "a same-amount transaction outside the three-minute window is left unmatched"

PULL2_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/sumup_pull" -H "Authorization: $SUPER_TOKEN")"
[ "$PULL2_CRON_STATUS" = "204" ] || fail "POST /api/crons/sumup_pull returned $PULL2_CRON_STATUS, expected 204"

SKU_TXN_AFTER2="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-sku-0001%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SKU_TXN_AFTER2" | jval totalItems)" = "1" ] || fail "a second pull duplicated txn-sku-0001: $SKU_TXN_AFTER2"
AMOUNT_TXN_AFTER2="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-amount-0002%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$AMOUNT_TXN_AFTER2" | jval totalItems)" = "1" ] || fail "a second pull duplicated txn-amount-0002: $AMOUNT_TXN_AFTER2"
[ "$(echo "$AMOUNT_TXN_AFTER2" | jval "items.0.matched_sale")" = "$SUMUP_AMOUNT_SALE_ID" ] || fail "a second pull changed txn-amount-0002's match: $AMOUNT_TXN_AFTER2"
MIXED_TXN_AFTER2="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-mixed-0005%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$MIXED_TXN_AFTER2" | jval totalItems)" = "1" ] || fail "a second pull duplicated txn-mixed-0005: $MIXED_TXN_AFTER2"
SUMUP_TXN_TOTAL_AFTER2="$(curl -s "$BASE/api/collections/sumup_transactions/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$SUMUP_TXN_TOTAL_AFTER2" -ge 5 ] || fail "fewer than 5 sumup_transactions rows exist after two pulls: $SUMUP_TXN_TOTAL_AFTER2"
ok "a second pull (run here as the sumup_pull cron, with an ISO changes_since - fixture_transport.js itself asserts this on every call) upserts in place and does not duplicate or re-match"

RECONCILE_JSON="$(curl -s "$BASE/api/vault/sumup/reconcile?date=$TODAY" -H "Authorization: $STAFF_TOKEN")"
RECONCILE_CHECK="$(echo "$RECONCILE_JSON" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    let body;
    try { body = JSON.parse(d); } catch (e) { console.log("PARSE_ERROR"); return; }
    const [amountSaleId, mixedSaleId, unmatchedSaleId] = process.argv.slice(1);

    const hasAmountMatch = (body.matched || []).some((m) => m.sale && m.sale.id === amountSaleId);
    const mixedEntry = (body.matched || []).find((m) => m.sale && m.sale.id === mixedSaleId);
    const hasUnmatchedSale = (body.unmatched_sales || []).some((s) => s.id === unmatchedSaleId);

    // Arithmetic: the summary totals must equal the sum of the detail
    // rows they summarise, not a separately (and possibly wrongly)
    // computed figure.
    const sumupFromRows =
      (body.matched || []).reduce((n, m) => n + (m.transaction ? m.transaction.amount : 0), 0) +
      (body.unmatched_transactions || []).reduce((n, t) => n + t.amount, 0);
    const salesFromRows =
      (body.matched || []).reduce((n, m) => n + (m.sale ? m.sale.card_share : 0), 0) +
      (body.unmatched_sales || []).reduce((n, s) => n + s.card_share, 0);

    const problems = [];
    if (!hasAmountMatch) problems.push("amount-matched sale missing from matched[]");
    if (!mixedEntry) problems.push("mixed sale missing from matched[]");
    else if (mixedEntry.sale.card_share !== 1288) problems.push("mixed sale card_share is " + mixedEntry.sale.card_share + ", expected 1288");
    else if (mixedEntry.sale.total !== 2000) problems.push("mixed sale total is " + mixedEntry.sale.total + ", expected 2000 (unchanged)");
    if (!hasUnmatchedSale) problems.push("unmatched sale missing from unmatched_sales[]");
    if (sumupFromRows !== body.totals.sumup) problems.push("totals.sumup (" + body.totals.sumup + ") != sum of row amounts (" + sumupFromRows + ")");
    if (salesFromRows !== body.totals.sales) problems.push("totals.sales (" + body.totals.sales + ") != sum of row card_shares (" + salesFromRows + ")");
    if (body.totals.difference !== body.totals.sumup - body.totals.sales) problems.push("totals.difference is not sumup - sales");

    process.stdout.write(problems.length ? "PROBLEMS: " + problems.join("; ") : "OK");
  });
' "$SUMUP_AMOUNT_SALE_ID" "$SUMUP_MIXED_SALE_ID" "$SUMUP_UNMATCHED_SALE_ID")"
[ "$RECONCILE_CHECK" = "OK" ] || fail "reconcile check failed ($RECONCILE_CHECK): $RECONCILE_JSON"
ok "reconcile lists the mixed sale by its card share (not total), the unmatched sale, and its totals sum arithmetically from the detail rows"

RECONCILE_PLAIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/sumup/reconcile?date=$TODAY")"
[ "$RECONCILE_PLAIN_STATUS" = "200" ] || fail "a non-admin staff member calling reconcile got $RECONCILE_PLAIN_STATUS, expected 200"
ok "reconcile is available to any staff member, unlike the admin-only pull"

# --- 22i. POST /api/vault/imports/:id/link: the counter screen's review
#     queue resolves a "needs match" row through the same three-path rule
#     the automatic import uses, rather than creating an items row itself.
LINK_STOCK_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$CU_SET_ID\",\"number\":\"501\",\"name\":\"Link Stock Card\"}" | jval id)"
[ -n "$LINK_STOCK_CARD_ID" ] || fail "could not create the link route's already-in-stock card"
LINK_NEW_CARD_ID="$(curl -s -X POST "$BASE/api/collections/cards/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$GAME_ID\",\"set\":\"$CU_SET_ID\",\"number\":\"502\",\"name\":\"Link New Card\"}" | jval id)"
[ -n "$LINK_NEW_CARD_ID" ] || fail "could not create the link route's nothing-in-stock card"

LINK_STOCK_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$LINK_STOCK_CARD_ID\",\"condition\":\"NM\",\"qty\":1,\"cost\":250,\"status\":\"in_stock\",\"source\":\"trade_in\",\"acquired_at\":\"$TODAY 09:00:00.000Z\"}" | jval id)"
[ -n "$LINK_STOCK_ITEM_ID" ] || fail "could not create the link route's already-in-stock item"

cat >"$TMP_DIR/link-route.csv" <<'EOF'
Card Name,Set,Number,Condition,Price,Quantity,TCGplayer ID,Cardmarket ID,CS SKU
Link To Stock Card,Some Set,501,NM,7.50,1,,,CS-LINK-STOCK
Link Creates New Card,Some Set,502,NM,9.00,1,,,CS-LINK-NEW
Link Skip Me Card,Some Set,503,NM,3.00,1,,,CS-LINK-SKIP
EOF
LINK_IMPORT_STATUS="$(curl -s -o "$TMP_DIR/link-import.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$TMP_DIR/link-route.csv;type=text/csv")"
[ "$LINK_IMPORT_STATUS" = "200" ] || fail "the link route's own Card Uploader import returned $LINK_IMPORT_STATUS: $(cat "$TMP_DIR/link-import.json")"
[ "$(jval matched <"$TMP_DIR/link-import.json")" = "0" ] || fail "the link route's own import should match nothing automatically: $(cat "$TMP_DIR/link-import.json")"
[ "$(jval review <"$TMP_DIR/link-import.json")" = "3" ] || fail "the link route's own import should leave all three rows for review: $(cat "$TMP_DIR/link-import.json")"
LINK_IMPORT_ID="$(jval "import.id" <"$TMP_DIR/link-import.json")"
[ -n "$LINK_IMPORT_ID" ] || fail "could not read the link route's own import id"

# Row 2: links to the card already in stock - no new item, cost untouched.
LINK_A_STATUS="$(curl -s -o "$TMP_DIR/link-a.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/$LINK_IMPORT_ID/link" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"row\":2,\"card\":\"$LINK_STOCK_CARD_ID\"}")"
[ "$LINK_A_STATUS" = "200" ] || fail "linking row 2 to the in-stock card returned $LINK_A_STATUS: $(cat "$TMP_DIR/link-a.json")"
[ "$(jval path <"$TMP_DIR/link-a.json")" = "in_stock" ] || fail "linking row 2 returned the wrong path: $(cat "$TMP_DIR/link-a.json")"
[ "$(jval "item.id" <"$TMP_DIR/link-a.json")" = "$LINK_STOCK_ITEM_ID" ] || fail "linking row 2 did not reuse the existing item: $(cat "$TMP_DIR/link-a.json")"
LINK_STOCK_CARD_ITEMS="$(curl -s "$BASE/api/collections/items/records?filter=card%3D%22$LINK_STOCK_CARD_ID%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$LINK_STOCK_CARD_ITEMS" | jval totalItems)" = "1" ] || fail "linking row 2 created a duplicate item instead of reusing the one in stock: $LINK_STOCK_CARD_ITEMS"
LINK_STOCK_ITEM_AFTER="$(curl -s "$BASE/api/collections/items/records/$LINK_STOCK_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$LINK_STOCK_ITEM_AFTER" | jval status)" = "listed_ebay" ] || fail "the row-2-linked item is not listed_ebay: $LINK_STOCK_ITEM_AFTER"
[ "$(echo "$LINK_STOCK_ITEM_AFTER" | jval price)" = "750" ] || fail "the row-2-linked item did not get the row's price: $LINK_STOCK_ITEM_AFTER"
[ "$(echo "$LINK_STOCK_ITEM_AFTER" | jval ebay_sku)" = "CS-LINK-STOCK" ] || fail "the row-2-linked item did not get the row's ebay_sku: $LINK_STOCK_ITEM_AFTER"
[ "$(echo "$LINK_STOCK_ITEM_AFTER" | jval cost)" = "250" ] || fail "linking row 2 changed the item's cost, which must be left untouched: $LINK_STOCK_ITEM_AFTER"
[ "$(echo "$LINK_STOCK_ITEM_AFTER" | jval source)" = "trade_in" ] || fail "linking row 2 changed the item's source, which must be left untouched: $LINK_STOCK_ITEM_AFTER"
ok "linking a review row to a card already in stock connects to that item rather than creating one, leaving cost untouched"

# Row 3: no stock anywhere for this card - a new supplier item, flagged
# for review same as the automatic (c) path would leave it.
LINK_B_STATUS="$(curl -s -o "$TMP_DIR/link-b.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/$LINK_IMPORT_ID/link" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"row\":3,\"card\":\"$LINK_NEW_CARD_ID\"}")"
[ "$LINK_B_STATUS" = "200" ] || fail "linking row 3 to a card with no stock returned $LINK_B_STATUS: $(cat "$TMP_DIR/link-b.json")"
[ "$(jval path <"$TMP_DIR/link-b.json")" = "created" ] || fail "linking row 3 returned the wrong path: $(cat "$TMP_DIR/link-b.json")"
LINK_NEW_ITEM_ID="$(jval "item.id" <"$TMP_DIR/link-b.json")"
[ -n "$LINK_NEW_ITEM_ID" ] || fail "linking row 3 returned no item"
LINK_NEW_ITEM_JSON="$(curl -s "$BASE/api/collections/items/records/$LINK_NEW_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$LINK_NEW_ITEM_JSON" | jval status)" = "listed_ebay" ] || fail "the row-3-created item is not listed_ebay: $LINK_NEW_ITEM_JSON"
[ "$(echo "$LINK_NEW_ITEM_JSON" | jval price)" = "900" ] || fail "the row-3-created item did not get the row's price: $LINK_NEW_ITEM_JSON"
[ "$(echo "$LINK_NEW_ITEM_JSON" | jval ebay_sku)" = "CS-LINK-NEW" ] || fail "the row-3-created item did not get the row's ebay_sku: $LINK_NEW_ITEM_JSON"
[ "$(echo "$LINK_NEW_ITEM_JSON" | jval source)" = "supplier" ] || fail "the row-3-created item has the wrong source: $LINK_NEW_ITEM_JSON"
LINK_IMPORT_AFTER_B="$(curl -s "$BASE/api/vault/imports/$LINK_IMPORT_ID" -H "Authorization: $STAFF_TOKEN")"
echo "$LINK_IMPORT_AFTER_B" | grep -qF "Link Creates New Card" && fail "row 3's needs-match entry should have been dropped once linked: $LINK_IMPORT_AFTER_B"
echo "$LINK_IMPORT_AFTER_B" | grep -qF "Created with no cost" || fail "linking row 3 should leave a zero-cost review note behind: $LINK_IMPORT_AFTER_B"
[ "$(echo "$LINK_IMPORT_AFTER_B" | jval rows_ok)" = "3" ] || fail "linking must not change rows_ok: $LINK_IMPORT_AFTER_B"
ok "linking a review row to a card with nothing in stock creates a new supplier item and leaves a zero-cost review note"

# Row 4: dismissed rather than linked.
LINK_SKIP_STATUS="$(curl -s -o "$TMP_DIR/link-skip.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/$LINK_IMPORT_ID/link" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"row":4,"skip":true}')"
[ "$LINK_SKIP_STATUS" = "200" ] || fail "skipping row 4 returned $LINK_SKIP_STATUS: $(cat "$TMP_DIR/link-skip.json")"
[ "$(jval path <"$TMP_DIR/link-skip.json")" = "skipped" ] || fail "skipping row 4 returned the wrong path: $(cat "$TMP_DIR/link-skip.json")"
[ "$(jval "item.id" <"$TMP_DIR/link-skip.json")" = "" ] || fail "skipping row 4 should return no item: $(cat "$TMP_DIR/link-skip.json")"
LINK_IMPORT_AFTER_SKIP="$(curl -s "$BASE/api/vault/imports/$LINK_IMPORT_ID" -H "Authorization: $STAFF_TOKEN")"
echo "$LINK_IMPORT_AFTER_SKIP" | grep -qF "Link Skip Me Card" && fail "row 4's needs-match entry should have been dropped once skipped: $LINK_IMPORT_AFTER_SKIP"
[ "$(echo "$LINK_IMPORT_AFTER_SKIP" | jval rows_skipped)" = "1" ] || fail "skipping row 4 did not record a skipped count: $LINK_IMPORT_AFTER_SKIP"
[ "$(echo "$LINK_IMPORT_AFTER_SKIP" | jval rows_ok)" = "3" ] || fail "skipping must not change rows_ok either: $LINK_IMPORT_AFTER_SKIP"
ok "skipping a review row drops its entry and counts it as skipped, without touching rows_ok"

# A second link of the already-linked row 2 is a conflict, not a fresh match.
LINK_AGAIN_STATUS="$(curl -s -o "$TMP_DIR/link-again.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/$LINK_IMPORT_ID/link" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"row\":2,\"card\":\"$LINK_STOCK_CARD_ID\"}")"
[ "$LINK_AGAIN_STATUS" = "409" ] || fail "re-linking row 2 returned $LINK_AGAIN_STATUS, expected 409: $(cat "$TMP_DIR/link-again.json")"
ok "linking an already-linked row again is refused with 409"

# An unknown row on a real import is 404, worded the same as a missing import.
LINK_UNKNOWN_STATUS="$(curl -s -o "$TMP_DIR/link-unknown.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/$LINK_IMPORT_ID/link" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"row\":99,\"card\":\"$LINK_STOCK_CARD_ID\"}")"
[ "$LINK_UNKNOWN_STATUS" = "404" ] || fail "linking a row that was never waiting for a match returned $LINK_UNKNOWN_STATUS, expected 404: $(cat "$TMP_DIR/link-unknown.json")"
grep -qF "not waiting for a match" "$TMP_DIR/link-unknown.json" || fail "the unknown-row 404 does not carry the documented message: $(cat "$TMP_DIR/link-unknown.json")"
ok "linking a row that is not waiting for a match is refused with 404"

LINK_AUDIT_COUNT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22import_link%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${LINK_AUDIT_COUNT:-0}" -ge 3 ] || fail "linking and skipping wrote fewer than 3 import_link audit rows: $LINK_AUDIT_COUNT"
ok "linking and skipping a review row is audited as import_link"

# --- 22j. csv_imports and sumup_transactions can no longer be rewritten
#     wholesale by a staff token through the collection API - the counter
#     screen's manual SumUp match is the one field-level exception left.
CSVIMPORT_PATCH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/collections/csv_imports/records/$LINK_IMPORT_ID" \
  -H "Authorization: $PLAIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"errors":[]}')"
[ "$CSVIMPORT_PATCH_STATUS" = "404" ] || fail "a staff PATCH of csv_imports.errors returned $CSVIMPORT_PATCH_STATUS, expected 404"
ok "a staff member cannot update csv_imports directly; every write goes through the import routes"

SUMUP_UNMATCHED_TXN_ID="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-outside-window-0004%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$SUMUP_UNMATCHED_TXN_ID" ] || fail "could not find txn-outside-window-0004 to test the sumup_transactions write rules against"

SUMUP_MATCH_PATCH_STATUS="$(curl -s -o "$TMP_DIR/sumup-match-patch.json" -w '%{http_code}' -X PATCH "$BASE/api/collections/sumup_transactions/records/$SUMUP_UNMATCHED_TXN_ID" \
  -H "Authorization: $PLAIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"matched_sale\":\"$SUMUP_UNMATCHED_SALE_ID\"}")"
[ "$SUMUP_MATCH_PATCH_STATUS" = "200" ] || fail "a staff PATCH of sumup_transactions.matched_sale returned $SUMUP_MATCH_PATCH_STATUS, expected 200: $(cat "$TMP_DIR/sumup-match-patch.json")"
[ "$(jval matched_sale <"$TMP_DIR/sumup-match-patch.json")" = "$SUMUP_UNMATCHED_SALE_ID" ] || fail "the manual match PATCH did not actually set matched_sale: $(cat "$TMP_DIR/sumup-match-patch.json")"
ok "a staff member can set sumup_transactions.matched_sale directly, for the counter screen's manual match"

SUMUP_AMOUNT_PATCH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/collections/sumup_transactions/records/$SUMUP_UNMATCHED_TXN_ID" \
  -H "Authorization: $PLAIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount":999999}')"
[ "$SUMUP_AMOUNT_PATCH_STATUS" = "404" ] || fail "a staff PATCH of sumup_transactions.amount returned $SUMUP_AMOUNT_PATCH_STATUS, expected 404"
ok "a staff member cannot rewrite sumup_transactions.amount, or any field but matched_sale, directly"

# -----------------------------------------------------------------------
# 23. Phase 5: portal, quotes, want lists, estimate, notifications and push.
#     Still under GG_ADAPTER_TRANSPORT_MODE=fixture (see section 19's own
#     note), so the estimate checks below prove no adapter call by using
#     cards this section creates by hand, never through the lookup route -
#     the fixture transport has no mapping for them, so any accidental
#     outbound call would throw and fail this section loudly rather than
#     passing quietly.
# -----------------------------------------------------------------------

p5_impersonate() {
  # $1 customer id -> prints a customer token
  curl -s -X POST "$BASE/api/collections/customers/impersonate/$1" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token
}

p5_make_customer() {
  # $1 name, $2 email -> prints the customer id
  curl -s -X POST "$BASE/api/collections/customers/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"source\":\"counter\"}" | jval id
}

p5_make_card() {
  # $1 name, $2 number -> prints the card id (a fresh set per call, so
  # nothing here is a set/number the fixture transport, or an earlier
  # section, has ever heard of)
  local set_id
  set_id="$(curl -s -X POST "$BASE/api/collections/card_sets/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"game\":\"$GAME_ID\",\"code\":\"p5set$RANDOM$RANDOM\",\"name\":\"P5 Test Set\"}" | jval id)"
  curl -s -X POST "$BASE/api/collections/cards/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"game\":\"$GAME_ID\",\"set\":\"$set_id\",\"number\":\"$2\",\"name\":\"$1\"}" | jval id
}

# --- 23a. OTP request for a counter-created customer (the claim), then an
#     impersonation token stands in for "auth" for the rest of this section
#     the same way section 7's own CUSTOMER_TOKEN does: PocketBase's OTP
#     password is a one-way hashed value even to a superuser (the same
#     reasoning a staff password hash is never returned), so there is no
#     plaintext code here to complete auth-with-otp against without either
#     a real mailbox or a test-only backdoor in production hook code, which
#     this build does not add. -----------------------------------------
P5_CUSTOMER_ID="$(p5_make_customer "Phase 5 Customer" "p5-customer@local.test")"
[ -n "$P5_CUSTOMER_ID" ] || fail "could not create the Phase 5 check customer"

P5_OTP_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/customers/request-otp" \
  -H "Content-Type: application/json" -d '{"email":"p5-customer@local.test"}')"
P5_OTP_STATUS="$(echo "$P5_OTP_JSON" | tail -n1)"
P5_OTP_ID="$(echo "$P5_OTP_JSON" | head -n -1 | jval otpId)"
[ "$P5_OTP_STATUS" = "200" ] || fail "request-otp for a counter-created customer returned $P5_OTP_STATUS, expected 200"
[ -n "$P5_OTP_ID" ] || fail "request-otp did not return an otpId: $(echo "$P5_OTP_JSON" | head -n -1)"
ok "a counter-created customer can request an OTP (the claim)"

P5_CUSTOMER_TOKEN="$(p5_impersonate "$P5_CUSTOMER_ID")"
[ -n "$P5_CUSTOMER_TOKEN" ] || fail "could not impersonate the Phase 5 check customer"

# --- 23b. GET /api/vault/me: balances are the live ledger sums, never a
#     cached field --------------------------------------------------------
curl -s -o /dev/null -X POST "$BASE/api/collections/credit_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"amount\":1200,\"reason\":\"adjustment\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/credit_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"amount\":-200,\"reason\":\"adjustment\"}"
curl -s -o /dev/null -X POST "$BASE/api/collections/points_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"delta\":300,\"reason\":\"adjust\"}"
# Deliberately drive customer_private.credit_balance out of step with the
# ledger, so this check actually distinguishes "summed live" from "read the
# cache" rather than passing by coincidence.
P5_PRIVATE_ID="$(curl -s "$BASE/api/collections/customer_private/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/customer_private/records/$P5_PRIVATE_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"credit_balance":999999,"points_balance":999999}'

P5_ME_JSON="$(curl -s "$BASE/api/vault/me" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$(echo "$P5_ME_JSON" | jval "balances.credit")" = "1000" ] || fail "GET /me balances.credit is '$(echo "$P5_ME_JSON" | jval "balances.credit")', expected 1000 (summed from credit_ledger, not the stale cache)"
# 300 adjusted above plus the 100 welcome bonus (Phase 6).
[ "$(echo "$P5_ME_JSON" | jval "balances.points")" = "400" ] || fail "GET /me balances.points is '$(echo "$P5_ME_JSON" | jval "balances.points")', expected 400"
[ "$(echo "$P5_ME_JSON" | jval "customer.code")" != "" ] || fail "GET /me did not return the customer's own code"
[ "$(echo "$P5_ME_JSON" | jval "id_status")" = "none" ] || fail "GET /me id_status is '$(echo "$P5_ME_JSON" | jval id_status)', expected none"
ok "GET /api/vault/me sums both balances live from the ledgers, never the cached fields"

[ "$(echo "$P5_ME_JSON" | jval "customer.notifications.email")" = "true" ] || fail "GET /me does not return notifications.email (default true): $P5_ME_JSON"
[ "$(echo "$P5_ME_JSON" | jval "customer.notifications.push")" = "true" ] || fail "GET /me does not return notifications.push (default true): $P5_ME_JSON"
ok "GET /api/vault/me returns the customer's own notification preferences"

# GET /api/vault/config is staff-only, so it is not where a customer reads
# push.vapid_public_key from - /me carries it too (fix round, finding 2),
# and /config keeps it for staff, unwidened.
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$(curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"push":{"vapid_public_key":"p5-test-vapid-public-key"}}'
P5_ME_PUSH_JSON="$(curl -s "$BASE/api/vault/me" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$(echo "$P5_ME_PUSH_JSON" | jval "push.vapid_public_key")" = "p5-test-vapid-public-key" ] || fail "GET /me does not carry push.vapid_public_key: $P5_ME_PUSH_JSON"
P5_CONFIG_PUSH_JSON="$(curl -s "$BASE/api/vault/config" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_CONFIG_PUSH_JSON" | jval "push.vapid_public_key")" = "p5-test-vapid-public-key" ] || fail "GET /config does not carry push.vapid_public_key: $P5_CONFIG_PUSH_JSON"
P5_CONFIG_CUSTOMER_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/config" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$P5_CONFIG_CUSTOMER_STATUS" = "403" ] || fail "a customer token reading GET /api/vault/config returned $P5_CONFIG_CUSTOMER_STATUS, expected 403 (unwidened, staff-only)"
ok "push.vapid_public_key is readable by a customer through /me, and by staff through /config, which stays staff-only"

# The Phase 1 settings.push_vapid_public_key / .push_vapid_private_key
# fields are gone (fix round, finding 16, the orchestrator's own): nothing
# ever read either, and settings.push.vapid_public_key above is the public
# half's one home now.
P5_SETTINGS_FIELD_NAMES="$(curl -s "$BASE/api/collections/settings" -H "Authorization: $SUPER_TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).fields.map(f=>f.name).join(",")))')"
echo "$P5_SETTINGS_FIELD_NAMES" | grep -qw "push_vapid_public_key" && fail "settings still has the unused push_vapid_public_key field"
echo "$P5_SETTINGS_FIELD_NAMES" | grep -qw "push_vapid_private_key" && fail "settings still has the unused push_vapid_private_key field"
ok "settings no longer carries the unused push_vapid_public_key / push_vapid_private_key fields"

# --- 23b2. A customer can read their own trade_ins, trade_in_lines,
#     credit_ledger and points_ledger directly through the collection API
#     (Phase 1/2 rules, unchanged by this phase), and never another
#     customer's -------------------------------------------------------
P5_OWN_TRADE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/trade_ins/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$P5_OWN_TRADE_STATUS" = "200" ] || fail "a customer listing their own trade_ins returned $P5_OWN_TRADE_STATUS, expected 200"
P5_OWN_CREDIT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/credit_ledger/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$P5_OWN_CREDIT_STATUS" = "200" ] || fail "a customer listing their own credit_ledger returned $P5_OWN_CREDIT_STATUS, expected 200"
P5_OWN_CREDIT_COUNT="$(curl -s "$BASE/api/collections/credit_ledger/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $P5_CUSTOMER_TOKEN" | jval totalItems)"
[ "${P5_OWN_CREDIT_COUNT:-0}" -ge 1 ] || fail "a customer's own credit_ledger list came back empty"
P5_OWN_POINTS_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/points_ledger/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$P5_OWN_POINTS_STATUS" = "200" ] || fail "a customer listing their own points_ledger returned $P5_OWN_POINTS_STATUS, expected 200"
P5_OWN_POINTS_COUNT="$(curl -s "$BASE/api/collections/points_ledger/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $P5_CUSTOMER_TOKEN" | jval totalItems)"
[ "${P5_OWN_POINTS_COUNT:-0}" -ge 1 ] || fail "a customer's own points_ledger list came back empty"
ok "a customer can read their own trade_ins, credit_ledger and points_ledger through the collection API"

P5_LEDGER_TRADE_ID="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"channel\":\"counter\",\"status\":\"draft\"}" | jval id)"
[ -n "$P5_LEDGER_TRADE_ID" ] || fail "could not create a second draft trade-in for the trade_in_lines ownership check"
P5_LEDGER_LINE_ID="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$P5_LEDGER_TRADE_ID\",\"free_text_title\":\"Ownership Check Line\",\"qty\":1}" | jval id)"
[ -n "$P5_LEDGER_LINE_ID" ] || fail "could not create a trade_in_lines row for the ownership check"
P5_OWN_LINE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/trade_in_lines/records/$P5_LEDGER_LINE_ID" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$P5_OWN_LINE_STATUS" = "200" ] || fail "a customer viewing their own trade_in_lines row (via the trade_in relation) returned $P5_OWN_LINE_STATUS, expected 200"
ok "a customer can view their own trade_in_lines through the trade_in relation"

# ... and never another customer's.
P5_LEDGER_OTHER_CUSTOMER_ID="$(p5_make_customer "Ledger Cross-Check Customer" "p5-ledger-cross@local.test")"
P5_LEDGER_CUSTOMER_TOKEN="$(p5_impersonate "$P5_LEDGER_OTHER_CUSTOMER_ID")"
P5_CROSS_TRADE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/trade_ins/records/$P5_LEDGER_TRADE_ID" -H "Authorization: $P5_LEDGER_CUSTOMER_TOKEN")"
[ "$P5_CROSS_TRADE_STATUS" = "403" ] || [ "$P5_CROSS_TRADE_STATUS" = "404" ] || fail "a customer viewing another customer's trade_ins row returned $P5_CROSS_TRADE_STATUS, expected 403 or 404"
P5_CROSS_LINE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/trade_in_lines/records/$P5_LEDGER_LINE_ID" -H "Authorization: $P5_LEDGER_CUSTOMER_TOKEN")"
[ "$P5_CROSS_LINE_STATUS" = "403" ] || [ "$P5_CROSS_LINE_STATUS" = "404" ] || fail "a customer viewing another customer's trade_in_lines row returned $P5_CROSS_LINE_STATUS, expected 403 or 404"
P5_CROSS_CREDIT_ID="$(curl -s "$BASE/api/collections/credit_ledger/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
P5_CROSS_CREDIT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/credit_ledger/records/$P5_CROSS_CREDIT_ID" -H "Authorization: $P5_LEDGER_CUSTOMER_TOKEN")"
[ "$P5_CROSS_CREDIT_STATUS" = "403" ] || [ "$P5_CROSS_CREDIT_STATUS" = "404" ] || fail "a customer viewing another customer's credit_ledger row returned $P5_CROSS_CREDIT_STATUS, expected 403 or 404"
P5_CROSS_POINTS_ID="$(curl -s "$BASE/api/collections/points_ledger/records?filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
P5_CROSS_POINTS_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/points_ledger/records/$P5_CROSS_POINTS_ID" -H "Authorization: $P5_LEDGER_CUSTOMER_TOKEN")"
[ "$P5_CROSS_POINTS_STATUS" = "403" ] || [ "$P5_CROSS_POINTS_STATUS" = "404" ] || fail "a customer viewing another customer's points_ledger row returned $P5_CROSS_POINTS_STATUS, expected 403 or 404"
ok "a customer token cannot view another customer's trade_ins, trade_in_lines, credit_ledger or points_ledger rows"

# --- 23c. PATCH /api/vault/me: email refused, everything else applied ----
P5_PATCH_EMAIL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/vault/me" \
  -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"someone-else@local.test"}')"
[ "$P5_PATCH_EMAIL_STATUS" = "400" ] || fail "PATCH /me with an email returned $P5_PATCH_EMAIL_STATUS, expected 400"
ok "PATCH /api/vault/me refuses an email change (400)"

P5_PATCH_JSON="$(curl -s -w '\n%{http_code}' -X PATCH "$BASE/api/vault/me" \
  -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Renamed Customer","phone":"+447700900123","marketing_consent":true,"birthday_month":9,"notifications":{"email":false,"push":true}}')"
P5_PATCH_STATUS="$(echo "$P5_PATCH_JSON" | tail -n1)"
P5_PATCH_BODY="$(echo "$P5_PATCH_JSON" | head -n -1)"
[ "$P5_PATCH_STATUS" = "200" ] || fail "PATCH /me returned $P5_PATCH_STATUS: $P5_PATCH_BODY"
[ "$(echo "$P5_PATCH_BODY" | jval "customer.name")" = "Renamed Customer" ] || fail "PATCH /me did not update name: $P5_PATCH_BODY"
[ "$(echo "$P5_PATCH_BODY" | jval "customer.notifications.email")" = "false" ] || fail "PATCH /me did not turn off email notifications: $P5_PATCH_BODY"
[ "$(echo "$P5_PATCH_BODY" | jval "customer.notifications.push")" = "true" ] || fail "PATCH /me left push notifications wrong: $P5_PATCH_BODY"
ok "PATCH /api/vault/me updates name, phone, consent, birthday month and notification preferences, and returns the /me shape"

# --- 23g. GET /api/vault/c/:token in its three shapes --------------------
P5_QR_TOKEN="$(echo "$P5_ME_JSON" | jval "customer.qr_token")"
[ -n "$P5_QR_TOKEN" ] || fail "the Phase 5 customer has no qr_token to test /c/:token with"

P5_C_ANON="$(curl -s -w '\n%{http_code}' "$BASE/api/vault/c/$P5_QR_TOKEN")"
[ "$(echo "$P5_C_ANON" | tail -n1)" = "200" ] || fail "GET /api/vault/c/:token with no auth returned $(echo "$P5_C_ANON" | tail -n1), expected 200"
[ "$(echo "$P5_C_ANON" | head -n -1 | jval known)" = "true" ] || fail "GET /api/vault/c/:token with no auth did not report known:true: $(echo "$P5_C_ANON" | head -n -1)"
echo "$P5_C_ANON" | head -n -1 | grep -qi "Renamed Customer" && fail "GET /api/vault/c/:token with no auth leaked the customer's name"
ok "GET /api/vault/c/:token with no auth returns known:true and never a name"

P5_C_BOGUS_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/c/not-a-real-token-at-all")"
[ "$P5_C_BOGUS_STATUS" = "404" ] || fail "GET /api/vault/c/:token for an unknown token returned $P5_C_BOGUS_STATUS, expected 404"
ok "GET /api/vault/c/:token for an unknown token is a plain 404"

P5_C_STAFF="$(curl -s "$BASE/api/vault/c/$P5_QR_TOKEN" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_C_STAFF" | jval customer_id)" = "$P5_CUSTOMER_ID" ] || fail "GET /api/vault/c/:token as staff did not return customer_id: $P5_C_STAFF"
[ "$(echo "$P5_C_STAFF" | jval name)" = "Renamed Customer" ] || fail "GET /api/vault/c/:token as staff did not return the name: $P5_C_STAFF"
ok "GET /api/vault/c/:token as staff returns customer_id, code and name"

P5_C_OWN="$(curl -s "$BASE/api/vault/c/$P5_QR_TOKEN" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$(echo "$P5_C_OWN" | jval "customer.customer.id")" = "$P5_CUSTOMER_ID" ] || fail "GET /api/vault/c/:token as the owning customer did not return the /me shape: $P5_C_OWN"
ok "GET /api/vault/c/:token as the owning customer returns the /me shape"

# --- 23e. GET /api/vault/me/export: the trade-in, and never an ID field --
P5_EXPORT_TRADE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/trade_ins/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"channel\":\"counter\",\"status\":\"draft\"}")"
P5_EXPORT_TRADE_ID="$(echo "$P5_EXPORT_TRADE_JSON" | head -n -1 | jval id)"
[ -n "$P5_EXPORT_TRADE_ID" ] || fail "could not create a draft trade-in for the export check: $P5_EXPORT_TRADE_JSON"
curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$P5_EXPORT_TRADE_ID\",\"free_text_title\":\"Export Check Card\",\"kind\":\"other\",\"game\":\"$GAME_ID\",\"qty\":1,\"market_price\":400,\"offer_price\":400,\"accepted\":true}"
P5_EXPORT_COMPLETE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/trade-ins/$P5_EXPORT_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":400,"terms_accepted":true}')"
[ "$(echo "$P5_EXPORT_COMPLETE_JSON" | tail -n1)" = "200" ] || fail "completing the export check's trade-in (credit only, no ID gate) returned $(echo "$P5_EXPORT_COMPLETE_JSON" | tail -n1): $(echo "$P5_EXPORT_COMPLETE_JSON" | head -n -1)"
P5_EXPORT_TRADE_NUMBER="$(echo "$P5_EXPORT_COMPLETE_JSON" | head -n -1 | jval "trade_in.number")"
[ -n "$P5_EXPORT_TRADE_NUMBER" ] || fail "the export check's trade-in has no number after completion"

P5_EXPORT_JSON="$(curl -s -D "$TMP_DIR/export-headers.txt" "$BASE/api/vault/me/export" -H "Authorization: $P5_CUSTOMER_TOKEN")"
grep -qi 'Content-Disposition: attachment' "$TMP_DIR/export-headers.txt" || fail "the export is not served as an attachment: $(cat "$TMP_DIR/export-headers.txt")"
echo "$P5_EXPORT_JSON" | grep -qF "$P5_EXPORT_TRADE_NUMBER" || fail "the export does not contain the customer's own trade-in number: $P5_EXPORT_JSON"
for field in id_type id_expiry id_ref_last4 dob address; do
  echo "$P5_EXPORT_JSON" | grep -q "\"$field\"" && fail "the export leaks the ID field '$field': $P5_EXPORT_JSON"
done
ok "GET /api/vault/me/export downloads as an attachment, contains the trade-in and never an ID field"

P5_EXPORT_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22customer_self_export%22%26%26record%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${P5_EXPORT_AUDIT:-0}" -ge 1 ] || fail "the self-export was not audited"
ok "the self-export is audited"

# --- 23f. POST /api/vault/me/delete: refused with credit, then succeeds -
P5_DELETE_CUSTOMER_ID="$(p5_make_customer "Delete Me" "p5-delete@local.test")"
P5_DELETE_CUSTOMER_TOKEN="$(p5_impersonate "$P5_DELETE_CUSTOMER_ID")"
curl -s -o /dev/null -X POST "$BASE/api/collections/credit_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_DELETE_CUSTOMER_ID\",\"amount\":1500,\"reason\":\"adjustment\"}"

P5_DELETE_BLOCKED_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/me/delete" -H "Authorization: $P5_DELETE_CUSTOMER_TOKEN")"
[ "$(echo "$P5_DELETE_BLOCKED_JSON" | tail -n1)" = "422" ] || fail "self-delete with credit outstanding returned $(echo "$P5_DELETE_BLOCKED_JSON" | tail -n1), expected 422"
echo "$P5_DELETE_BLOCKED_JSON" | head -n -1 | grep -qF "£15.00" || fail "the self-delete credit refusal does not name the balance: $(echo "$P5_DELETE_BLOCKED_JSON" | head -n -1)"
ok "POST /api/vault/me/delete is refused with 422 while store credit remains"

curl -s -o /dev/null -X POST "$BASE/api/collections/credit_ledger/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P5_DELETE_CUSTOMER_ID\",\"amount\":-1500,\"reason\":\"adjustment\"}"
P5_DELETE_OK_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/me/delete" -H "Authorization: $P5_DELETE_CUSTOMER_TOKEN")"
[ "$(echo "$P5_DELETE_OK_JSON" | tail -n1)" = "200" ] || fail "self-delete with no credit returned $(echo "$P5_DELETE_OK_JSON" | tail -n1): $(echo "$P5_DELETE_OK_JSON" | head -n -1)"
[ "$(echo "$P5_DELETE_OK_JSON" | head -n -1 | jval erased)" = "true" ] || fail "self-delete did not report erased:true"
P5_DELETE_TOKEN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/me" -H "Authorization: $P5_DELETE_CUSTOMER_TOKEN")"
[ "$P5_DELETE_TOKEN_STATUS" = "401" ] || fail "the token still works after self-delete (got $P5_DELETE_TOKEN_STATUS), expected 401"
ok "POST /api/vault/me/delete succeeds once credit is clear, and the token stops working"

P5_DELETE_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22customer_self_delete%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${P5_DELETE_AUDIT:-0}" -ge 1 ] || fail "the self-delete was not audited"
ok "the self-delete is audited"

# --- 23h/23i/23j/23k/23l/23m. Quotes: submit with photos, message both
#     ways, offer with the total recomputed, accept/decline and expiry,
#     received, and the trade-in completion marking the quote completed --
node -e '
  require("fs").writeFileSync(
    process.argv[1],
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
' "$TMP_DIR/p5-photo1.png"
cp "$TMP_DIR/p5-photo1.png" "$TMP_DIR/p5-photo2.png"
echo "not a photo" >"$TMP_DIR/p5-notaphoto.txt"
# A real PNG header (so the sniff itself would pass) padded past 10 MB -
# the size cap is checked from the multipart part's own declared size
# before any byte is read or sniffed, so the padding's own content is
# never inspected.
cat "$TMP_DIR/p5-photo1.png" >"$TMP_DIR/p5-huge.png"
dd if=/dev/zero bs=1M count=11 >>"$TMP_DIR/p5-huge.png" 2>/dev/null

P5_QUOTE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes" -H "Authorization: $P5_CUSTOMER_TOKEN" \
  -F "photos=@$TMP_DIR/p5-photo1.png;type=image/png" \
  -F "photos=@$TMP_DIR/p5-photo2.png;type=image/png" \
  -F "message=Loft box of Pokemon cards" \
  -F "drop_off=in_store")"
[ "$(echo "$P5_QUOTE_JSON" | tail -n1)" = "200" ] || fail "submitting a quote with two photos returned $(echo "$P5_QUOTE_JSON" | tail -n1): $(echo "$P5_QUOTE_JSON" | head -n -1)"
P5_QUOTE_ID="$(echo "$P5_QUOTE_JSON" | head -n -1 | jval "quote.id")"
[ -n "$P5_QUOTE_ID" ] || fail "quote submission did not return a quote id"
[ "$(echo "$P5_QUOTE_JSON" | head -n -1 | jlen "quote.photos")" = "2" ] || fail "the submitted quote does not carry both photos"
[ "$(echo "$P5_QUOTE_JSON" | head -n -1 | jval "quote.status")" = "submitted" ] || fail "a submitted quote is not status submitted"
ok "a quote submits with two photos as multipart and reads back submitted"

P5_MY_QUOTES_JSON="$(curl -s -w '\n%{http_code}' "$BASE/api/vault/quotes" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$(echo "$P5_MY_QUOTES_JSON" | tail -n1)" = "200" ] || fail "GET /api/vault/quotes returned $(echo "$P5_MY_QUOTES_JSON" | tail -n1), expected 200"
P5_MY_QUOTES_BODY="$(echo "$P5_MY_QUOTES_JSON" | head -n -1)"
[ "$(echo "$P5_MY_QUOTES_BODY" | jlen quotes)" -ge 1 ] || fail "GET /api/vault/quotes returned none for a customer with one: $P5_MY_QUOTES_BODY"
echo "$P5_MY_QUOTES_BODY" | grep -qF "\"$P5_QUOTE_ID\"" || fail "GET /api/vault/quotes did not include the quote just submitted: $P5_MY_QUOTES_BODY"
ok "GET /api/vault/quotes lists the customer's own quotes, newest first"

P5_BAD_PHOTO_STATUS="$(curl -s -o "$TMP_DIR/p5-bad-photo.json" -w '%{http_code}' -X POST "$BASE/api/vault/quotes" -H "Authorization: $P5_CUSTOMER_TOKEN" \
  -F "photos=@$TMP_DIR/p5-notaphoto.txt;type=text/plain" \
  -F "message=bad upload")"
[ "$P5_BAD_PHOTO_STATUS" = "400" ] || fail "submitting a non-image photo returned $P5_BAD_PHOTO_STATUS, expected 400: $(cat "$TMP_DIR/p5-bad-photo.json")"
ok "a non-image upload on a quote is refused with 400"

P5_HUGE_PHOTO_STATUS="$(curl -s -o "$TMP_DIR/p5-huge-photo.json" -w '%{http_code}' -X POST "$BASE/api/vault/quotes" -H "Authorization: $P5_CUSTOMER_TOKEN" \
  -F "photos=@$TMP_DIR/p5-huge.png;type=image/png" \
  -F "message=too big")"
[ "$P5_HUGE_PHOTO_STATUS" = "400" ] || fail "submitting an over-size photo (>10MB) returned $P5_HUGE_PHOTO_STATUS, expected 400: $(cat "$TMP_DIR/p5-huge-photo.json")"
ok "a photo over 10MB is refused with 400"

P5_MANY_PHOTOS_ARGS=()
for _ in $(seq 1 21); do
  P5_MANY_PHOTOS_ARGS+=(-F "photos=@$TMP_DIR/p5-photo1.png;type=image/png")
done
P5_MANY_PHOTOS_STATUS="$(curl -s -o "$TMP_DIR/p5-many-photos.json" -w '%{http_code}' -X POST "$BASE/api/vault/quotes" -H "Authorization: $P5_CUSTOMER_TOKEN" \
  "${P5_MANY_PHOTOS_ARGS[@]}" -F "message=too many photos")"
[ "$P5_MANY_PHOTOS_STATUS" = "400" ] || fail "submitting 21 photos returned $P5_MANY_PHOTOS_STATUS, expected 400: $(cat "$TMP_DIR/p5-many-photos.json")"
ok "a 21st photo on one quote is refused with 400 (the 20-photo cap)"

P5_SUBMIT_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22quote_submit%22%26%26record%3D%22$P5_QUOTE_ID%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${P5_SUBMIT_AUDIT:-0}" -ge 1 ] || fail "quote submission was not audited"
P5_QUOTE_SUBMIT_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_submitted%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "${P5_QUOTE_SUBMIT_NOTIF:-0}" -ge 1 ] || fail "submitting a quote did not notify staff"
ok "submitting a quote is audited and notifies staff"

# messages both directions
P5_MSG_CUST_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/messages" \
  -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" -d '{"body":"Any idea on timing?"}')"
[ "$(echo "$P5_MSG_CUST_JSON" | tail -n1)" = "200" ] || fail "a customer message on their own quote returned $(echo "$P5_MSG_CUST_JSON" | tail -n1)"
[ "$(echo "$P5_MSG_CUST_JSON" | head -n -1 | jval "message.author")" = "customer" ] || fail "the customer message's author is not 'customer'"

P5_MSG_STAFF_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/messages" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"body":"We will look at it today."}')"
[ "$(echo "$P5_MSG_STAFF_JSON" | tail -n1)" = "200" ] || fail "a staff message on a quote returned $(echo "$P5_MSG_STAFF_JSON" | tail -n1)"
[ "$(echo "$P5_MSG_STAFF_JSON" | head -n -1 | jval "message.author")" = "staff" ] || fail "the staff message's author is not 'staff'"

P5_QUOTE_DETAIL="$(curl -s "$BASE/api/vault/quotes/$P5_QUOTE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_QUOTE_DETAIL" | jlen messages)" = "2" ] || fail "the quote detail does not show both messages: $P5_QUOTE_DETAIL"
[ "$(echo "$P5_QUOTE_DETAIL" | jlen photos)" = "2" ] || fail "the quote detail does not carry both photo tokens"
echo "$P5_QUOTE_DETAIL" | jval "photos.0.url" | grep -q "token=" || fail "a quote photo URL carries no file token"
ok "messages in both directions land on the quote's thread, with photo URLs carrying a file token"

P5_CUSTOMER_MSG_NOTIF_JSON="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_message%22%26%26customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_CUSTOMER_MSG_NOTIF_JSON" | jval totalItems)" -ge 1 ] || fail "the staff message did not notify the customer"
[ "$(echo "$P5_CUSTOMER_MSG_NOTIF_JSON" | jval "items.0.link")" = "/account/quotes/$P5_QUOTE_ID" ] || fail "a customer-facing quote notification's link is '$(echo "$P5_CUSTOMER_MSG_NOTIF_JSON" | jval "items.0.link")', expected an in-app /account/quotes/:id path"
P5_STAFF_ANY_MSG_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_message%22" -H "Authorization: $SUPER_TOKEN")"
[ "$(echo "$P5_STAFF_ANY_MSG_NOTIF" | jval totalItems)" -ge 2 ] || fail "expected a notification row for both the customer's and staff's message: $P5_STAFF_ANY_MSG_NOTIF"
ok "a quote message notifies the other side, with an in-app link"

# POST /:id/reviewing: submitted -> reviewing (someone has picked it up),
# and only from submitted
P5_REVIEWING_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/reviewing" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_REVIEWING_JSON" | tail -n1)" = "200" ] || fail "POST /:id/reviewing on a submitted quote returned $(echo "$P5_REVIEWING_JSON" | tail -n1)"
[ "$(echo "$P5_REVIEWING_JSON" | head -n -1 | jval "quote.status")" = "reviewing" ] || fail "the quote is not status reviewing after POST /:id/reviewing"
P5_REVIEWING_AGAIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/reviewing" -H "Authorization: $STAFF_TOKEN")"
[ "$P5_REVIEWING_AGAIN_STATUS" = "409" ] || fail "POST /:id/reviewing on an already-reviewing quote returned $P5_REVIEWING_AGAIN_STATUS, expected 409"
ok "POST /api/vault/quotes/:id/reviewing moves submitted to reviewing, and only from submitted"

# offer, with the total recomputed server-side from two lines - the offer
# route itself allows submitted or reviewing, so the quote above still
# takes an offer even though it is reviewing rather than submitted now
P5_CARD_A="$(p5_make_card "Phase 5 Card A" "6")"
P5_OFFER_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/offer" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"card\":\"$P5_CARD_A\",\"title\":\"Phase 5 Card A\",\"condition\":\"NM\",\"qty\":1,\"market_price\":3000,\"market_source\":\"Cardmarket\",\"offer_price\":1800},{\"title\":\"Bulk lot\",\"kind\":\"other\",\"game\":\"$GAME_ID\",\"qty\":2,\"market_price\":0,\"market_source\":\"Bulk lot\",\"offer_price\":500}],\"message\":\"Here is what we can offer\"}")"
[ "$(echo "$P5_OFFER_JSON" | tail -n1)" = "200" ] || fail "the quote offer returned $(echo "$P5_OFFER_JSON" | tail -n1): $(echo "$P5_OFFER_JSON" | head -n -1)"
P5_OFFER_TOTAL="$(echo "$P5_OFFER_JSON" | head -n -1 | jval "quote.offer_total")"
[ "$P5_OFFER_TOTAL" = "2800" ] || fail "the offer total is '$P5_OFFER_TOTAL', expected 2800 (1800 + 2*500), recomputed server-side"
[ "$(echo "$P5_OFFER_JSON" | head -n -1 | jval "quote.status")" = "offered" ] || fail "the quote is not status offered after an offer"
P5_OFFER_EXPIRES="$(echo "$P5_OFFER_JSON" | head -n -1 | jval "quote.offer_expires_at")"
[ -n "$P5_OFFER_EXPIRES" ] || fail "the offer did not set offer_expires_at"
ok "a staff offer recomputes offer_total server-side from the lines (2800) and sets an expiry"

# a non-integer or negative offer_price/market_price/qty is refused
# outright, never rounded into shape (money is never a float once stored) -
# a fresh, still-submitted quote, since P5_QUOTE_ID above already moved to
# offered and a second offer on it would 409 before the lines are even
# read.
P5_BAD_OFFER_QUOTE_ID="$(curl -s -X POST "$BASE/api/collections/quotes/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"status\":\"submitted\"}" | jval id)"
P5_BAD_OFFER_STATUS="$(curl -s -o "$TMP_DIR/p5-bad-offer.json" -w '%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_BAD_OFFER_QUOTE_ID/offer" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"lines":[{"title":"Bad line","kind":"other","qty":1,"market_price":100,"offer_price":49.5}]}')"
[ "$P5_BAD_OFFER_STATUS" = "400" ] || fail "an offer line with a non-integer offer_price returned $P5_BAD_OFFER_STATUS, expected 400: $(cat "$TMP_DIR/p5-bad-offer.json")"
P5_BAD_OFFER_STATUS_2="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_BAD_OFFER_QUOTE_ID/offer" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"lines":[{"title":"Bad line","kind":"other","qty":0,"market_price":100,"offer_price":50}]}')"
[ "$P5_BAD_OFFER_STATUS_2" = "400" ] || fail "an offer line with qty 0 returned $P5_BAD_OFFER_STATUS_2, expected 400"
ok "an offer line with a non-integer or below-minimum amount is refused with 400, never rounded"

P5_OFFER_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22quote_offer%22%26%26record%3D%22$P5_QUOTE_ID%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${P5_OFFER_AUDIT:-0}" -ge 1 ] || fail "the offer was not audited"
P5_OFFER_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_offered%22%26%26customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "${P5_OFFER_NOTIF:-0}" -ge 1 ] || fail "the offer did not notify the customer"
ok "the offer is audited and notifies the customer"

# notify_email:false suppresses the send, not merely the log line (fix
# round, finding 14): section 23c above turned email off for
# P5_CUSTOMER_ID before this offer was made, so its own subject
# ("would email \"Your quote offer, £28.00\"") must never appear in the
# test-mode mail log, even though the notification row itself (just
# asserted above) is always written regardless of the preference.
P5_OFFER_EMAIL_LOG_COUNT="$(grep -c 'would email "Your quote offer, £28.00"' "$TMP_DIR/server.log" || true)"
[ "${P5_OFFER_EMAIL_LOG_COUNT:-0}" = "0" ] || fail "an email was attempted for a customer with notify_email off ($P5_OFFER_EMAIL_LOG_COUNT log line(s) found)"
ok "a customer with notify_email off never has an email attempted, even though their notification row is still written"

# accept before expiry works; a second, expired quote is refused after
P5_ACCEPT_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/accept" \
  -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" -d '{"reply":"Sounds good","drop_off":"in_store"}')"
[ "$(echo "$P5_ACCEPT_JSON" | tail -n1)" = "200" ] || fail "accepting a quote before expiry returned $(echo "$P5_ACCEPT_JSON" | tail -n1): $(echo "$P5_ACCEPT_JSON" | head -n -1)"
[ "$(echo "$P5_ACCEPT_JSON" | head -n -1 | jval "quote.status")" = "accepted" ] || fail "an accepted quote is not status accepted"
ok "accepting a quote before its offer expires succeeds"

# Created by staff, not the customer: quotes.createRule is staff-only
# (section 8's own assertion covers the refusal itself).
P5_EXPIRE_QUOTE_ID="$(curl -s -X POST "$BASE/api/collections/quotes/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"status\":\"submitted\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/vault/quotes/$P5_EXPIRE_QUOTE_ID/offer" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"lines":[{"title":"Old offer","qty":1,"market_price":100,"offer_price":50}]}'
curl -s -o /dev/null -X PATCH "$BASE/api/collections/quotes/records/$P5_EXPIRE_QUOTE_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"offer_expires_at":"2020-01-01 00:00:00.000Z"}'
P5_EXPIRED_ACCEPT_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_EXPIRE_QUOTE_ID/accept" -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$(echo "$P5_EXPIRED_ACCEPT_JSON" | tail -n1)" = "409" ] || fail "accepting an expired offer returned $(echo "$P5_EXPIRED_ACCEPT_JSON" | tail -n1), expected 409"
echo "$P5_EXPIRED_ACCEPT_JSON" | head -n -1 | grep -qF "1 Jan 2020" || fail "the expired-offer message does not name the expiry date: $(echo "$P5_EXPIRED_ACCEPT_JSON" | head -n -1)"
ok "accepting a quote after its offer has expired is refused with 409 naming the expiry date"

# received creates the draft trade-in with the lines, and completing it
# marks the quote completed
P5_RECEIVED_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/received" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_RECEIVED_JSON" | tail -n1)" = "200" ] || fail "marking a quote received returned $(echo "$P5_RECEIVED_JSON" | tail -n1): $(echo "$P5_RECEIVED_JSON" | head -n -1)"
P5_RECEIVED_TRADE_ID="$(echo "$P5_RECEIVED_JSON" | head -n -1 | jval trade_in_id)"
[ -n "$P5_RECEIVED_TRADE_ID" ] || fail "received did not return a trade_in_id"
P5_RECEIVED_TRADE="$(curl -s "$BASE/api/collections/trade_ins/records/$P5_RECEIVED_TRADE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_RECEIVED_TRADE" | jval channel)" = "remote" ] || fail "the draft trade-in from a quote is not channel remote"
[ "$(echo "$P5_RECEIVED_TRADE" | jval quote)" = "$P5_QUOTE_ID" ] || fail "the draft trade-in is not linked back to the quote"
P5_RECEIVED_LINES="$(curl -s "$BASE/api/collections/trade_in_lines/records?perPage=50&filter=trade_in%3D%22$P5_RECEIVED_TRADE_ID%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_RECEIVED_LINES" | jval totalItems)" = "2" ] || fail "the draft trade-in does not carry both quote lines: $P5_RECEIVED_LINES"
[ "$(echo "$P5_RECEIVED_LINES" | jval "items.0.accepted")" = "true" ] || fail "a line copied from an accepted quote is not itself accepted"
ok "quotes/:id/received creates a draft trade-in with the quote's lines"

# Both lines already carry kind and game straight off /received - the
# card line inferred (single, this card's own game), the free-text "Bulk
# lot" line from what the offer itself set (fix round, finding 9: this
# used to need a PATCH here to paper over both lines landing with neither
# field set, which completion then refused with "no game set").
P5_QUOTE_LINE_WITH_CARD_JSON="$(curl -s "$BASE/api/collections/trade_in_lines/records?perPage=50&filter=trade_in%3D%22$P5_RECEIVED_TRADE_ID%22%26%26card%3D%22$P5_CARD_A%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_QUOTE_LINE_WITH_CARD_JSON" | jval "items.0.kind")" = "single" ] || fail "a card line from /received has kind '$(echo "$P5_QUOTE_LINE_WITH_CARD_JSON" | jval "items.0.kind")', expected single"
[ -n "$(echo "$P5_QUOTE_LINE_WITH_CARD_JSON" | jval "items.0.game")" ] || fail "a card line from /received has no game set"
P5_OTHER_LINE_JSON="$(curl -s "$BASE/api/collections/trade_in_lines/records?perPage=50&filter=trade_in%3D%22$P5_RECEIVED_TRADE_ID%22%26%26card%3D%22%22" -H "Authorization: $STAFF_TOKEN")"
P5_OTHER_LINE_ID="$(echo "$P5_OTHER_LINE_JSON" | jval "items.0.id")"
[ "$(echo "$P5_OTHER_LINE_JSON" | jval "items.0.kind")" = "other" ] || fail "the free-text line from /received has kind '$(echo "$P5_OTHER_LINE_JSON" | jval "items.0.kind")', expected other"
[ "$(echo "$P5_OTHER_LINE_JSON" | jval "items.0.game")" = "$GAME_ID" ] || fail "the free-text line from /received does not carry the game the offer itself set"
ok "quotes/:id/received sets kind and game on every line, a card line inferred and a free-text line from the offer, with no manual fix-up"

P5_COMPLETE_QUOTE_TRADE="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/trade-ins/$P5_RECEIVED_TRADE_ID/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"payout_type":"credit","payout_cash":0,"payout_credit":2800,"terms_accepted":true}')"
[ "$(echo "$P5_COMPLETE_QUOTE_TRADE" | tail -n1)" = "200" ] || fail "completing the quote's draft trade-in returned $(echo "$P5_COMPLETE_QUOTE_TRADE" | tail -n1): $(echo "$P5_COMPLETE_QUOTE_TRADE" | head -n -1)"

P5_QUOTE_AFTER_COMPLETE="$(curl -s "$BASE/api/collections/quotes/records/$P5_QUOTE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_QUOTE_AFTER_COMPLETE" | jval status)" = "completed" ] || fail "the quote is '$(echo "$P5_QUOTE_AFTER_COMPLETE" | jval status)' after its trade-in completed, expected completed"
[ -n "$(echo "$P5_QUOTE_AFTER_COMPLETE" | jval closed_at)" ] || fail "a completed quote has no closed_at"
ok "completing the trade-in a quote became marks that quote completed"

# POST /:id/cancel: a note is required, cancels to declined and notifies
# the customer, and refuses a quote already in a closed status
P5_CANCEL_QUOTE_ID="$(curl -s -X POST "$BASE/api/collections/quotes/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"status\":\"submitted\"}" | jval id)"
P5_CANCEL_NO_NOTE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_CANCEL_QUOTE_ID/cancel" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P5_CANCEL_NO_NOTE_STATUS" = "400" ] || fail "POST /:id/cancel with no note returned $P5_CANCEL_NO_NOTE_STATUS, expected 400"
P5_CANCEL_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_CANCEL_QUOTE_ID/cancel" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"note":"Items no longer available"}')"
[ "$(echo "$P5_CANCEL_JSON" | tail -n1)" = "200" ] || fail "POST /:id/cancel with a note returned $(echo "$P5_CANCEL_JSON" | tail -n1)"
[ "$(echo "$P5_CANCEL_JSON" | head -n -1 | jval "quote.status")" = "declined" ] || fail "a cancelled quote is not status declined"
P5_CANCEL_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_declined%22%26%26customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "${P5_CANCEL_NOTIF:-0}" -ge 1 ] || fail "cancelling a quote did not notify the customer"
P5_CANCEL_AGAIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/quotes/$P5_QUOTE_ID/cancel" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"note":"too late"}')"
[ "$P5_CANCEL_AGAIN_STATUS" = "409" ] || fail "POST /:id/cancel on an already-completed quote returned $P5_CANCEL_AGAIN_STATUS, expected 409"
ok "POST /api/vault/quotes/:id/cancel requires a note, declines the quote and notifies the customer, and refuses an already-closed one"

# quote_photos_retention: a quote closed more than 90 days ago has its
# photos cleared; the record itself, and every other field, stays
P5_RETENTION_CUTOFF="$(node -e 'console.log(new Date(Date.now() - 91 * 86400000).toISOString().replace("T"," "))')"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/quotes/records/$P5_QUOTE_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"closed_at\":\"$P5_RETENTION_CUTOFF\"}"
[ "$(curl -s "$BASE/api/collections/quotes/records/$P5_QUOTE_ID" -H "Authorization: $STAFF_TOKEN" | jlen photos)" = "2" ] || fail "the retention check's quote does not still have its two photos before the cron runs"
P5_RETENTION_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/quote_photos_retention" -H "Authorization: $SUPER_TOKEN")"
[ "$P5_RETENTION_CRON_STATUS" = "204" ] || fail "POST /api/crons/quote_photos_retention returned $P5_RETENTION_CRON_STATUS, expected 204"
sleep 1
P5_RETENTION_QUOTE_AFTER="$(curl -s "$BASE/api/collections/quotes/records/$P5_QUOTE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_RETENTION_QUOTE_AFTER" | jlen photos)" = "0" ] || fail "a quote closed 91 days ago still has photos after quote_photos_retention"
[ "$(echo "$P5_RETENTION_QUOTE_AFTER" | jval status)" = "completed" ] || fail "quote_photos_retention changed the quote's own status"
ok "quote_photos_retention clears photos 90 days after a quote closes, leaving the record itself alone"

# the expiry cron itself, and the day-before warning
P5_CRON_QUOTE_ID="$(curl -s -X POST "$BASE/api/collections/quotes/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"status\":\"submitted\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/vault/quotes/$P5_CRON_QUOTE_ID/offer" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"lines":[{"title":"Cron test","qty":1,"market_price":100,"offer_price":50}]}'
curl -s -o /dev/null -X PATCH "$BASE/api/collections/quotes/records/$P5_CRON_QUOTE_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"offer_expires_at":"2020-06-15 00:00:00.000Z"}'
P5_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/quotes_expire" -H "Authorization: $SUPER_TOKEN")"
[ "$P5_CRON_STATUS" = "204" ] || fail "POST /api/crons/quotes_expire returned $P5_CRON_STATUS, expected 204"
sleep 1
P5_CRON_QUOTE_AFTER="$(curl -s "$BASE/api/collections/quotes/records/$P5_CRON_QUOTE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_CRON_QUOTE_AFTER" | jval status)" = "expired" ] || fail "the quotes_expire cron left status '$(echo "$P5_CRON_QUOTE_AFTER" | jval status)', expected expired"
P5_EXPIRE_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_expired%22%26%26customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "${P5_EXPIRE_NOTIF:-0}" -ge 1 ] || fail "the quotes_expire cron did not notify the customer"
ok "the quotes_expire cron expires a past-due offer and notifies the customer"

# the day-before warning: an offer due within 24h (but not yet past) gets a
# quote_expiring notification and is left offered, not expired
P5_WARN_QUOTE_ID="$(curl -s -X POST "$BASE/api/collections/quotes/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"customer\":\"$P5_CUSTOMER_ID\",\"status\":\"submitted\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/vault/quotes/$P5_WARN_QUOTE_ID/offer" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"lines":[{"title":"Warn test","qty":1,"market_price":100,"offer_price":50}]}'
P5_WARN_EXPIRES_AT="$(node -e 'console.log(new Date(Date.now() + 12 * 3600000).toISOString().replace("T"," "))')"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/quotes/records/$P5_WARN_QUOTE_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"offer_expires_at\":\"$P5_WARN_EXPIRES_AT\"}"
P5_WARN_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/quotes_expire" -H "Authorization: $SUPER_TOKEN")"
[ "$P5_WARN_CRON_STATUS" = "204" ] || fail "POST /api/crons/quotes_expire (day-before pass) returned $P5_WARN_CRON_STATUS, expected 204"
sleep 1
P5_WARN_QUOTE_AFTER="$(curl -s "$BASE/api/collections/quotes/records/$P5_WARN_QUOTE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_WARN_QUOTE_AFTER" | jval status)" = "offered" ] || fail "a quote due within 24h is '$(echo "$P5_WARN_QUOTE_AFTER" | jval status)' after quotes_expire, expected still offered"
P5_WARN_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22quote_expiring%22%26%26customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "${P5_WARN_NOTIF:-0}" -ge 1 ] || fail "the quotes_expire cron did not send a quote_expiring day-before warning"
ok "the quotes_expire cron warns the day before expiry without expiring the offer"

# --- 23n/23o. Want lists: match on creation with the hold and the
#     notification, then selling the held item to its customer fulfils
#     the row ------------------------------------------------------------
P5_WANT_CUSTOMER_ID="$(p5_make_customer "Want List Customer" "p5-want@local.test")"
P5_WANT_CUSTOMER_TOKEN="$(p5_impersonate "$P5_WANT_CUSTOMER_ID")"
P5_CARD_B="$(p5_make_card "Phase 5 Card B" "7")"

P5_WANT_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/want-list" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN" -H "Content-Type: application/json" -d "{\"card\":\"$P5_CARD_B\",\"max_price\":3000}")"
[ "$(echo "$P5_WANT_JSON" | tail -n1)" = "200" ] || fail "creating a want-list row returned $(echo "$P5_WANT_JSON" | tail -n1)"
P5_WANT_ID="$(echo "$P5_WANT_JSON" | head -n -1 | jval "row.id")"
[ -n "$P5_WANT_ID" ] || fail "want-list creation did not return an id"
[ "$(echo "$P5_WANT_JSON" | head -n -1 | jval "row.status")" = "open" ] || fail "a new want-list row is not status open"
[ "$(echo "$P5_WANT_JSON" | head -n -1 | jval "row.card.name")" = "Phase 5 Card B" ] || fail "the want-list row does not expand the card's name: $(echo "$P5_WANT_JSON" | head -n -1)"
[ -n "$(echo "$P5_WANT_JSON" | head -n -1 | jval "row.card.set")" ] || fail "the want-list row does not expand the card's set"
[ "$(echo "$P5_WANT_JSON" | head -n -1 | jval "row.card.number")" = "7" ] || fail "the want-list row does not expand the card's number"
echo "$P5_WANT_JSON" | head -n -1 | grep -q '"image"' || fail "the want-list row's card does not carry an image key"

# a second want-list row for the same customer, on a card nothing will ever
# match, created a moment later so GET /api/vault/want-list's newest-first
# order is unambiguous - this is the "open" row that must read back
# hold: null, contrasted below against the first row once it is matched
P5_CARD_B_OPEN="$(p5_make_card "Phase 5 Card B Open" "70")"
P5_WANT_OPEN_ID="$(curl -s -X POST "$BASE/api/vault/want-list" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN" -H "Content-Type: application/json" -d "{\"card\":\"$P5_CARD_B_OPEN\",\"max_price\":3000}" | jval "row.id")"
[ -n "$P5_WANT_OPEN_ID" ] || fail "could not create the second, never-matched want-list row"
sleep 1

P5_WANT_ITEM_JSON="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$P5_CARD_B\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\",\"price\":2500}")"
P5_WANT_ITEM_ID="$(echo "$P5_WANT_ITEM_JSON" | jval id)"
[ -n "$P5_WANT_ITEM_ID" ] || fail "could not create the want-list match item: $P5_WANT_ITEM_JSON"
[ "$(echo "$P5_WANT_ITEM_JSON" | jval status)" = "reserved" ] || fail "an item matching an open want row was not reserved on creation: $P5_WANT_ITEM_JSON"
[ "$(echo "$P5_WANT_ITEM_JSON" | jval reserved_for)" = "$P5_WANT_CUSTOMER_ID" ] || fail "the reserved item is not held for the want-list customer"
[ -n "$(echo "$P5_WANT_ITEM_JSON" | jval reserved_until)" ] || fail "the reserved item has no reserved_until"

P5_WANT_AFTER_MATCH="$(curl -s "$BASE/api/collections/want_list/records/$P5_WANT_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_WANT_AFTER_MATCH" | jval status)" = "matched" ] || fail "the want-list row did not become matched"
[ "$(echo "$P5_WANT_AFTER_MATCH" | jval matched_item)" = "$P5_WANT_ITEM_ID" ] || fail "the want-list row's matched_item is wrong"
[ -n "$(echo "$P5_WANT_AFTER_MATCH" | jval notified_at)" ] || fail "the want-list row has no notified_at"

P5_MATCH_NOTIF="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22want_match%22%26%26customer%3D%22$P5_WANT_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_MATCH_NOTIF" | jval totalItems)" -ge 1 ] || fail "the want-list match did not notify the customer"
echo "$P5_MATCH_NOTIF" | grep -qF "Phase 5 Card B" || fail "the want-match notification does not name the item: $P5_MATCH_NOTIF"
echo "$P5_MATCH_NOTIF" | grep -qF "Held for you until" || fail "the want-match notification does not say when the hold ends: $P5_MATCH_NOTIF"
[ "$(echo "$P5_MATCH_NOTIF" | jval "items.0.link")" = "/account/wants" ] || fail "a want-match notification's link is '$(echo "$P5_MATCH_NOTIF" | jval "items.0.link")', expected /account/wants"
ok "creating an item matches the oldest open want-list row, holds it, and notifies the customer"

# GET /api/vault/want-list: the customer's own rows, newest first, each
# with its card and a hold that only exists on the matched one - the
# collection read (filtered by customer) stays allowed too, this route
# just adds what that read cannot: matched_item expanded off the
# staff-only items collection.
P5_WANT_LIST_JSON="$(curl -s -w '\n%{http_code}' "$BASE/api/vault/want-list" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN")"
[ "$(echo "$P5_WANT_LIST_JSON" | tail -n1)" = "200" ] || fail "GET /api/vault/want-list returned $(echo "$P5_WANT_LIST_JSON" | tail -n1)"
P5_WANT_LIST_BODY="$(echo "$P5_WANT_LIST_JSON" | head -n -1)"
[ "$(echo "$P5_WANT_LIST_BODY" | jval "rows.0.id")" = "$P5_WANT_OPEN_ID" ] || fail "GET /api/vault/want-list is not newest first"
[ -z "$(echo "$P5_WANT_LIST_BODY" | jval "rows.0.hold")" ] || fail "an open want-list row's hold is '$(echo "$P5_WANT_LIST_BODY" | jval "rows.0.hold")', expected null"
[ "$(echo "$P5_WANT_LIST_BODY" | jval "rows.1.id")" = "$P5_WANT_ID" ] || fail "GET /api/vault/want-list did not return the matched row second"
[ "$(echo "$P5_WANT_LIST_BODY" | jval "rows.1.hold.price")" = "2500" ] || fail "a matched want-list row's hold.price is '$(echo "$P5_WANT_LIST_BODY" | jval "rows.1.hold.price")', expected 2500"
[ "$(echo "$P5_WANT_LIST_BODY" | jval "rows.1.hold.title")" = "Phase 5 Card B #7" ] || fail "a matched want-list row's hold.title is '$(echo "$P5_WANT_LIST_BODY" | jval "rows.1.hold.title")', expected Phase 5 Card B #7"
[ -n "$(echo "$P5_WANT_LIST_BODY" | jval "rows.1.hold.until")" ] || fail "a matched want-list row's hold has no until"
ok "GET /api/vault/want-list returns the customer's own rows newest first, with hold set only on the matched row"

P5_WANT_SALE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/sales/complete" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$P5_WANT_ITEM_ID\",\"qty\":1,\"unit_price\":2500,\"discount\":0}],\"customer\":\"$P5_WANT_CUSTOMER_ID\",\"payment\":\"sumup_card\"}")"
[ "$(echo "$P5_WANT_SALE_JSON" | tail -n1)" = "200" ] || fail "selling the reserved item to its own customer returned $(echo "$P5_WANT_SALE_JSON" | tail -n1)"
P5_WANT_AFTER_SALE="$(curl -s "$BASE/api/collections/want_list/records/$P5_WANT_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_WANT_AFTER_SALE" | jval status)" = "fulfilled" ] || fail "the want-list row is '$(echo "$P5_WANT_AFTER_SALE" | jval status)' after the sale, expected fulfilled"
ok "selling a reserved item to its own customer marks the want-list row fulfilled"

# --- 23o2. Closing a matched want-list row releases the held item back to
#     in_stock, in the same request (fix round, finding 11) ---------------
P5_CARD_CLOSE="$(p5_make_card "Phase 5 Card Close" "72")"
P5_WANT_CLOSE_ID="$(curl -s -X POST "$BASE/api/vault/want-list" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN" -H "Content-Type: application/json" -d "{\"card\":\"$P5_CARD_CLOSE\",\"max_price\":0}" | jval "row.id")"
[ -n "$P5_WANT_CLOSE_ID" ] || fail "could not create the want-list row for the close-releases-item check"
P5_ITEM_CLOSE_ID="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$P5_CARD_CLOSE\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\",\"price\":1200}" | jval id)"
[ "$(curl -s "$BASE/api/collections/items/records/$P5_ITEM_CLOSE_ID" -H "Authorization: $STAFF_TOKEN" | jval status)" = "reserved" ] || fail "the close-releases-item check's item was not reserved by its want match"
P5_CLOSE_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/want-list/$P5_WANT_CLOSE_ID/close" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN")"
[ "$(echo "$P5_CLOSE_JSON" | tail -n1)" = "200" ] || fail "closing a matched want-list row returned $(echo "$P5_CLOSE_JSON" | tail -n1)"
[ "$(echo "$P5_CLOSE_JSON" | head -n -1 | jval "row.status")" = "closed" ] || fail "the closed want-list row is not status closed"
P5_ITEM_AFTER_CLOSE="$(curl -s "$BASE/api/collections/items/records/$P5_ITEM_CLOSE_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_ITEM_AFTER_CLOSE" | jval status)" = "in_stock" ] || fail "an item held by a closed want-list row is '$(echo "$P5_ITEM_AFTER_CLOSE" | jval status)', expected in_stock"
[ "$(echo "$P5_ITEM_AFTER_CLOSE" | jval reserved_for)" = "" ] || fail "an item held by a closed want-list row still carries reserved_for"
ok "closing a matched want-list row puts its held item back in stock, in the same transaction"

# --- 23p. holds_release: an expired hold goes back to in_stock, its row
#     closes, and the customer is told; a hold not yet due, and a staff
#     reservation with no want-list row at all, both survive the same
#     cron pass untouched (fix round, findings 3 and 12) ------------------
P5_CARD_C="$(p5_make_card "Phase 5 Card C" "8")"
P5_HOLD_CUSTOMER_ID="$(p5_make_customer "Hold Release Customer" "p5-hold@local.test")"
curl -s -o /dev/null -X POST "$BASE/api/vault/want-list" -H "Authorization: $(p5_impersonate "$P5_HOLD_CUSTOMER_ID")" -H "Content-Type: application/json" -d "{\"card\":\"$P5_CARD_C\",\"max_price\":0}"
P5_HOLD_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$P5_CARD_C\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\",\"price\":1000}" | jval id)"
[ "$(curl -s "$BASE/api/collections/items/records/$P5_HOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)" = "reserved" ] || fail "the hold-release item was not reserved by its want match"
P5_HOLD_WANT_ID="$(curl -s "$BASE/api/collections/want_list/records?filter=card%3D%22$P5_CARD_C%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/items/records/$P5_HOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"reserved_until":"2020-01-01 00:00:00.000Z"}'

# A want-list hold due later today (not in the past): the whole reason for
# finding 3's fix is that comparing an ISO "T" now against a PocketBase
# space-separated reserved_until used to release every same-day hold
# regardless of what time later today it was actually due.
P5_CARD_NOTDUE="$(p5_make_card "Phase 5 Card Not Due" "73")"
P5_NOTDUE_CUSTOMER_ID="$(p5_make_customer "Hold Not Due Customer" "p5-hold-notdue@local.test")"
curl -s -o /dev/null -X POST "$BASE/api/vault/want-list" -H "Authorization: $(p5_impersonate "$P5_NOTDUE_CUSTOMER_ID")" -H "Content-Type: application/json" -d "{\"card\":\"$P5_CARD_NOTDUE\",\"max_price\":0}"
P5_NOTDUE_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$P5_CARD_NOTDUE\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\",\"price\":1500}" | jval id)"
[ "$(curl -s "$BASE/api/collections/items/records/$P5_NOTDUE_ITEM_ID" -H "Authorization: $STAFF_TOKEN" | jval status)" = "reserved" ] || fail "the not-due hold item was not reserved by its want match"
P5_NOTDUE_LATER_TODAY="$(node -e 'console.log(new Date(Date.now() + 6 * 3600000).toISOString().replace("T"," "))')"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/items/records/$P5_NOTDUE_ITEM_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"reserved_until\":\"$P5_NOTDUE_LATER_TODAY\"}"

# A staff reservation with no want-list row behind it at all - the cron
# must never touch this, whatever its own reserved_until says.
P5_CARD_STAFFHOLD="$(p5_make_card "Phase 5 Card Staff Hold" "74")"
P5_STAFFHOLD_CUSTOMER_ID="$(p5_make_customer "Staff Hold Customer" "p5-staffhold@local.test")"
P5_STAFFHOLD_ITEM_ID="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$P5_CARD_STAFFHOLD\",\"condition\":\"NM\",\"qty\":1,\"status\":\"in_stock\",\"price\":800}" | jval id)"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/items/records/$P5_STAFFHOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"status\":\"reserved\",\"reserved_for\":\"$P5_STAFFHOLD_CUSTOMER_ID\",\"reserved_until\":\"2020-01-01 00:00:00.000Z\"}"
[ "$(curl -s "$BASE/api/collections/want_list/records?filter=card%3D%22$P5_CARD_STAFFHOLD%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)" = "0" ] || fail "the staff-hold card unexpectedly has a want-list row"

P5_RELEASE_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/holds_release" -H "Authorization: $SUPER_TOKEN")"
[ "$P5_RELEASE_CRON_STATUS" = "204" ] || fail "POST /api/crons/holds_release returned $P5_RELEASE_CRON_STATUS, expected 204"
sleep 1

P5_HOLD_ITEM_AFTER="$(curl -s "$BASE/api/collections/items/records/$P5_HOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_HOLD_ITEM_AFTER" | jval status)" = "in_stock" ] || fail "an item past its hold is '$(echo "$P5_HOLD_ITEM_AFTER" | jval status)' after holds_release, expected in_stock"
[ "$(echo "$P5_HOLD_ITEM_AFTER" | jval reserved_for)" = "" ] || fail "a released item still carries reserved_for"
P5_HOLD_WANT_AFTER="$(curl -s "$BASE/api/collections/want_list/records/$P5_HOLD_WANT_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_HOLD_WANT_AFTER" | jval status)" = "closed" ] || fail "the released want-list row is '$(echo "$P5_HOLD_WANT_AFTER" | jval status)', expected closed"
P5_RELEASE_NOTIF_JSON="$(curl -s "$BASE/api/collections/notifications/records?perPage=200&filter=type%3D%22hold_released%22%26%26customer%3D%22$P5_HOLD_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_RELEASE_NOTIF_JSON" | jval totalItems)" -ge 1 ] || fail "the holds_release cron did not notify the customer"
[ "$(echo "$P5_RELEASE_NOTIF_JSON" | jval "items.0.link")" = "/account/wants" ] || fail "a hold-released notification's link is '$(echo "$P5_RELEASE_NOTIF_JSON" | jval "items.0.link")', expected /account/wants"
ok "the holds_release cron puts an expired hold back in stock, closes its want-list row and notifies the customer"

P5_NOTDUE_ITEM_AFTER="$(curl -s "$BASE/api/collections/items/records/$P5_NOTDUE_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_NOTDUE_ITEM_AFTER" | jval status)" = "reserved" ] || fail "a hold not yet due is '$(echo "$P5_NOTDUE_ITEM_AFTER" | jval status)' after holds_release, expected still reserved (finding 3's date-format bug would release it early)"
ok "a want-list hold due later today survives the holds_release cron"

P5_STAFFHOLD_ITEM_AFTER="$(curl -s "$BASE/api/collections/items/records/$P5_STAFFHOLD_ITEM_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_STAFFHOLD_ITEM_AFTER" | jval status)" = "reserved" ] || fail "a staff reservation with no want-list row is '$(echo "$P5_STAFFHOLD_ITEM_AFTER" | jval status)' after holds_release, expected still reserved"
[ "$(echo "$P5_STAFFHOLD_ITEM_AFTER" | jval reserved_for)" = "$P5_STAFFHOLD_CUSTOMER_ID" ] || fail "a staff reservation's reserved_for changed after holds_release"
ok "a staff reservation with no matched want-list row survives the holds_release cron untouched"

# --- 23q. Public estimate: no token, real bands, never an adapter call --
curl -s -o /dev/null -X POST "$BASE/api/vault/cards/$P5_CARD_A/uk-comp" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"finish\":\"\",\"condition\":\"NM\",\"price\":3000,\"url\":\"https://www.ebay.co.uk/itm/999999\",\"sold_at\":\"$TODAY\"}"

P5_ESTIMATE_SEARCH_STATUS="$(curl -s -o "$TMP_DIR/p5-estimate-search.json" -w '%{http_code}' "$BASE/api/vault/estimate/search?q=Phase%205%20Card%20A")"
[ "$P5_ESTIMATE_SEARCH_STATUS" = "200" ] || fail "the public estimate search returned $P5_ESTIMATE_SEARCH_STATUS, expected 200: $(cat "$TMP_DIR/p5-estimate-search.json")"
grep -qF "Phase 5 Card A" "$TMP_DIR/p5-estimate-search.json" || fail "the estimate search did not find the card: $(cat "$TMP_DIR/p5-estimate-search.json")"
ok "GET /api/vault/estimate/search finds a card by name with no auth"

# every hit carries finishes (the card's own finishes_available, [] when
# never set) so the estimate page can offer finish chips straight off a
# search result - Phase 5 Card A never had finishes_available set, so its
# own hit proves the "[] when none" half; a second card with the field set
# proves the other half.
[ "$(jlen "cards.0.finishes" < "$TMP_DIR/p5-estimate-search.json")" = "0" ] || fail "Phase 5 Card A's search hit has a non-empty finishes array, expected [] (finishes_available was never set on it): $(cat "$TMP_DIR/p5-estimate-search.json")"
P5_CARD_FINISHES="$(p5_make_card "Phase 5 Card Finishes" "71")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/cards/records/$P5_CARD_FINISHES" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"finishes_available":["normal","holo"]}'
P5_ESTIMATE_SEARCH_FINISHES_JSON="$(curl -s "$BASE/api/vault/estimate/search?q=Phase%205%20Card%20Finishes")"
[ "$(echo "$P5_ESTIMATE_SEARCH_FINISHES_JSON" | jlen "cards.0.finishes")" = "2" ] || fail "a card with finishes_available set does not carry both finishes in its search hit: $P5_ESTIMATE_SEARCH_FINISHES_JSON"
[ "$(echo "$P5_ESTIMATE_SEARCH_FINISHES_JSON" | jval "cards.0.finishes")" = "normal,holo" ] || fail "a search hit's finishes are '$(echo "$P5_ESTIMATE_SEARCH_FINISHES_JSON" | jval "cards.0.finishes")', expected normal,holo"
ok "GET /api/vault/estimate/search includes each card's finishes, [] when none are set"

P5_ESTIMATE_JSON="$(curl -s -w '\n%{http_code}' "$BASE/api/vault/estimate?card=$P5_CARD_A&condition=NM")"
[ "$(echo "$P5_ESTIMATE_JSON" | tail -n1)" = "200" ] || fail "the public estimate returned $(echo "$P5_ESTIMATE_JSON" | tail -n1): $(echo "$P5_ESTIMATE_JSON" | head -n -1)"
P5_ESTIMATE_BODY="$(echo "$P5_ESTIMATE_JSON" | head -n -1)"
[ "$(echo "$P5_ESTIMATE_BODY" | jval market)" = "3000" ] || fail "the estimate's market figure is '$(echo "$P5_ESTIMATE_BODY" | jval market)', expected 3000"
[ "$(echo "$P5_ESTIMATE_BODY" | jval "cash.high")" -gt "$(echo "$P5_ESTIMATE_BODY" | jval "cash.low")" ] || fail "the estimate's cash band is not high > low: $P5_ESTIMATE_BODY"
[ "$(echo "$P5_ESTIMATE_BODY" | jval note)" = "Subject to inspection in the shop." ] || fail "the estimate is missing its inspection note"
ok "GET /api/vault/estimate returns cash and credit bands from a cached price, with no auth"

# GG_ADAPTER_TRANSPORT_MODE=fixture makes any call this build did not
# intend to make throw and fail the request outright (see section 19's own
# note) - both estimate calls above used only a card this section created
# by hand and a manually-entered UK comp, never the lookup/adapter route,
# so their clean 200s are themselves proof no adapter was ever reached.
ok "the public estimate routes never call an adapter (both requests above succeeded using only hand-created, uncached-by-any-adapter rows)"

P5_ESTIMATE_UNKNOWN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/estimate?card=not-a-real-card-id&condition=NM")"
[ "$P5_ESTIMATE_UNKNOWN_STATUS" = "404" ] || fail "the public estimate for an unknown card returned $P5_ESTIMATE_UNKNOWN_STATUS, expected 404"
ok "the public estimate 404s cleanly for an unknown card"

# --- 23q2. The *:auth rate limit fires on a burst from one IP (fix round,
#     finding 4) - wrong credentials on purpose, since a limiter that only
#     counted successful logins would do nothing to slow a brute-force
#     guess. Only 5 other auth-classified calls happen anywhere else in
#     this whole script (the staff/superuser logins near the top and this
#     section's own request-otp), so a burst of 12 here cannot be confused
#     with, or itself disrupt, anything else this script does. -----------
P5_AUTH_BURST_429_COUNT=0
for _ in $(seq 1 12); do
  P5_AUTH_BURST_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/staff/auth-with-password" -H "Content-Type: application/json" -d '{"identity":"admin-check@local.test","password":"definitely-the-wrong-password"}')"
  [ "$P5_AUTH_BURST_STATUS" = "429" ] && P5_AUTH_BURST_429_COUNT=$((P5_AUTH_BURST_429_COUNT + 1))
done
[ "$P5_AUTH_BURST_429_COUNT" -ge 1 ] || fail "12 rapid login attempts from one IP never tripped the *:auth rate limit"
ok "the *:auth rate limit fires on a burst of login attempts from one IP ($P5_AUTH_BURST_429_COUNT/12 refused with 429)"

# --- 23r. Push subscribe and unsubscribe ---------------------------------
P5_PUSH_SUB_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/push/subscribe" -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.example.com/p5-endpoint","keys":{"p256dh":"p256dh-value","auth":"auth-value"}}')"
[ "$P5_PUSH_SUB_STATUS" = "200" ] || fail "push subscribe returned $P5_PUSH_SUB_STATUS, expected 200"
P5_PUSH_SUB_COUNT="$(curl -s "$BASE/api/collections/push_subscriptions/records?filter=endpoint%3D%22https%3A%2F%2Fpush.example.com%2Fp5-endpoint%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$P5_PUSH_SUB_COUNT" = "1" ] || fail "expected exactly one push_subscriptions row for the endpoint, got $P5_PUSH_SUB_COUNT"
# Subscribing again with the same endpoint upserts rather than duplicating.
curl -s -o /dev/null -X POST "$BASE/api/vault/push/subscribe" -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.example.com/p5-endpoint","keys":{"p256dh":"changed","auth":"changed"}}'
P5_PUSH_SUB_COUNT_2="$(curl -s "$BASE/api/collections/push_subscriptions/records?filter=endpoint%3D%22https%3A%2F%2Fpush.example.com%2Fp5-endpoint%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$P5_PUSH_SUB_COUNT_2" = "1" ] || fail "subscribing again with the same endpoint duplicated the row (count $P5_PUSH_SUB_COUNT_2)"
ok "push subscribe upserts by endpoint rather than duplicating"

# A different customer subscribing with the SAME endpoint must never
# re-point the first customer's own row (fix round, finding 8) - it gets
# its own new row instead, even though the endpoint string is identical.
P5_PUSH_ORIGINAL_OWNER_ID="$(curl -s "$BASE/api/collections/push_subscriptions/records?filter=endpoint%3D%22https%3A%2F%2Fpush.example.com%2Fp5-endpoint%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
curl -s -o /dev/null -X POST "$BASE/api/vault/push/subscribe" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.example.com/p5-endpoint","keys":{"p256dh":"stolen-attempt","auth":"stolen-attempt"}}'
P5_PUSH_SHARED_ENDPOINT_JSON="$(curl -s "$BASE/api/collections/push_subscriptions/records?filter=endpoint%3D%22https%3A%2F%2Fpush.example.com%2Fp5-endpoint%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P5_PUSH_SHARED_ENDPOINT_JSON" | jval totalItems)" = "2" ] || fail "a second customer subscribing with another's endpoint did not create its own row (expected 2 rows, got $(echo "$P5_PUSH_SHARED_ENDPOINT_JSON" | jval totalItems))"
P5_PUSH_ORIGINAL_STILL_OWNED="$(curl -s "$BASE/api/collections/push_subscriptions/records/$P5_PUSH_ORIGINAL_OWNER_ID" -H "Authorization: $STAFF_TOKEN" | jval customer)"
[ "$P5_PUSH_ORIGINAL_STILL_OWNED" = "$P5_CUSTOMER_ID" ] || fail "the first customer's own push_subscriptions row was re-pointed to another customer"
ok "a different customer subscribing with the same endpoint gets its own row, never re-pointing the first customer's"

# Unsubscribing an endpoint you do not own is a 404, not a delete of
# someone else's row (fix round, finding 8).
P5_PUSH_UNSUB_OTHER_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/vault/push/subscribe" -H "Authorization: $(p5_impersonate "$P5_HOLD_CUSTOMER_ID")" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.example.com/p5-endpoint"}')"
[ "$P5_PUSH_UNSUB_OTHER_STATUS" = "404" ] || fail "unsubscribing an endpoint you do not own returned $P5_PUSH_UNSUB_OTHER_STATUS, expected 404"
[ "$(curl -s "$BASE/api/collections/push_subscriptions/records?filter=endpoint%3D%22https%3A%2F%2Fpush.example.com%2Fp5-endpoint%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)" = "2" ] || fail "a 404'd unsubscribe attempt still deleted a row"
ok "a customer token cannot unsubscribe another customer's push subscription (404, and nothing is deleted)"

curl -s -o /dev/null -X DELETE "$BASE/api/vault/push/subscribe" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.example.com/p5-endpoint"}'

P5_PUSH_UNSUB_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/vault/push/subscribe" -H "Authorization: $P5_CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://push.example.com/p5-endpoint"}')"
[ "$P5_PUSH_UNSUB_STATUS" = "200" ] || fail "push unsubscribe returned $P5_PUSH_UNSUB_STATUS, expected 200"
P5_PUSH_SUB_COUNT_3="$(curl -s "$BASE/api/collections/push_subscriptions/records?filter=endpoint%3D%22https%3A%2F%2Fpush.example.com%2Fp5-endpoint%22" -H "Authorization: $STAFF_TOKEN" | jval totalItems)"
[ "$P5_PUSH_SUB_COUNT_3" = "0" ] || fail "the push subscription still exists after both owners unsubscribed"
ok "push unsubscribe removes the caller's own subscription"

P5_PUSH_AUDIT="$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22push_subscribe%22%7C%7Caction%3D%22push_unsubscribe%22" -H "Authorization: $SUPER_TOKEN" | jval totalItems)"
[ "${P5_PUSH_AUDIT:-0}" -ge 2 ] || fail "push subscribe/unsubscribe were not both audited"
echo "$(curl -s "$BASE/api/collections/audit_log/records?perPage=200&filter=action%3D%22push_subscribe%22" -H "Authorization: $SUPER_TOKEN")" | grep -qi "push.example.com" && fail "a push endpoint reached audit_log"
ok "push subscribe and unsubscribe are audited, and never log the endpoint"

# --- 23s. A customer token cannot read another customer's quote, want row
#     or notification ----------------------------------------------------
P5_CROSS_QUOTE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/quotes/$P5_QUOTE_ID" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN")"
[ "$P5_CROSS_QUOTE_STATUS" = "404" ] || fail "a customer reading another customer's quote returned $P5_CROSS_QUOTE_STATUS, expected 404"
ok "a customer token cannot read another customer's quote (404)"

P5_CROSS_WANT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/want-list/$P5_WANT_ID/close" -H "Authorization: $(p5_impersonate "$P5_HOLD_CUSTOMER_ID")")"
[ "$P5_CROSS_WANT_STATUS" = "404" ] || fail "a customer closing another customer's want-list row returned $P5_CROSS_WANT_STATUS, expected 404"
ok "a customer token cannot close another customer's want-list row (404)"

P5_SOME_NOTIF_ID="$(curl -s "$BASE/api/collections/notifications/records?perPage=1&filter=customer%3D%22$P5_CUSTOMER_ID%22" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$P5_SOME_NOTIF_ID" ] || fail "the Phase 5 customer has no notification to test cross-customer access with"
P5_CROSS_NOTIF_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/me/notifications/$P5_SOME_NOTIF_ID/read" -H "Authorization: $P5_WANT_CUSTOMER_TOKEN")"
[ "$P5_CROSS_NOTIF_STATUS" = "404" ] || fail "a customer marking another customer's notification read returned $P5_CROSS_NOTIF_STATUS, expected 404"
ok "a customer token cannot mark another customer's notification read (404)"

# --- 23t. GET /api/vault/me/notifications and marking one read ----------
P5_NOTIF_LIST="$(curl -s "$BASE/api/vault/me/notifications" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$(echo "$P5_NOTIF_LIST" | jlen items)" -ge 1 ] || fail "GET /api/vault/me/notifications returned none for a customer with several"
[ "$(echo "$P5_NOTIF_LIST" | jval unread)" -ge 1 ] || fail "GET /api/vault/me/notifications did not report an unread count"
P5_READ_JSON="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/vault/me/notifications/$P5_SOME_NOTIF_ID/read" -H "Authorization: $P5_CUSTOMER_TOKEN")"
[ "$(echo "$P5_READ_JSON" | tail -n1)" = "200" ] || fail "marking a customer's own notification read returned $(echo "$P5_READ_JSON" | tail -n1)"
[ -n "$(echo "$P5_READ_JSON" | head -n -1 | jval "notification.read_at")" ] || fail "marking a notification read did not set read_at"
ok "a customer can list their own notifications, newest first, and mark one read"

# -----------------------------------------------------------------------
# 24. Phase 6: the loyalty engine (tiers, the welcome bonus, referrals and
#     points expiry), rewards and vouchers, perks, memberships, the admin
#     adjustment and the customer-facing display.
# -----------------------------------------------------------------------

# PocketBase rewrites an autodate field on every write, so `created` cannot
# be set through the API at all, superuser included (verified against
# v0.40.4: both a create carrying it and a superuser PATCH of it come back
# stamped with now). Two of this phase's rules measure from
# points_ledger.created - the rolling tier window and the points-expiry
# cron - so testing either needs rows that are genuinely months old. This
# starts a second, short-lived PocketBase on the same data directory whose
# entire hooks directory is one throwaway file doing the UPDATE through
# $app.db(). Nothing in pb_hooks/ gains a test-only route, and the server
# under test keeps serving the repo's own hooks throughout.
mkdir -p "$TMP_DIR/check_backdate_hooks"
cat >"$TMP_DIR/check_backdate_hooks/backdate.pb.js" <<'BACKDATE_HOOK'
/// Throwaway, written by pb/scripts/check.sh. Never part of pb_hooks/.
routerAdd(
  "POST",
  "/api/check/backdate",
  (e) => {
    const info = e.requestInfo();
    const body = (info && info.body) || {};
    const table = String(body.table || "");
    if (table !== "points_ledger") {
      throw e.badRequestError("check.sh only ever backdates points_ledger", null);
    }
    $app
      .db()
      .newQuery("UPDATE points_ledger SET created = {:created} WHERE id = {:id}")
      .bind({ created: String(body.created || ""), id: String(body.id || "") })
      .execute();
    return e.json(200, { ok: true });
  },
  $apis.requireSuperuserAuth()
);
BACKDATE_HOOK

BACKDATE_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
BACKDATE_BASE="http://127.0.0.1:$BACKDATE_PORT"
"$PB" serve --http "127.0.0.1:$BACKDATE_PORT" --dir "$TMP_DIR" \
  --hooksDir "$TMP_DIR/check_backdate_hooks" --hooksWatch=false \
  --migrationsDir "$MIGRATIONS_DIR" --publicDir "$PUBLIC_DIR" \
  >"$TMP_DIR/backdate.log" 2>&1 &
BACKDATE_PID=$!
for _ in $(seq 1 80); do
  curl -sf "$BACKDATE_BASE/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "$BACKDATE_BASE/api/health" >/dev/null 2>&1 \
  || fail "the backdating helper server did not start: $(tail -n 5 "$TMP_DIR/backdate.log")"

p6_ago() {
  # $1 whole months back, $2 further days back -> a PocketBase stored
  # timestamp. The same clamped calendar-month arithmetic lib/vaultutil.js's
  # addMonths uses, so the expectations below hold whatever today's date is.
  node -e '
    const d = new Date();
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - Number(process.argv[1]));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    d.setUTCDate(d.getUTCDate() - Number(process.argv[2]));
    process.stdout.write(d.toISOString().replace("T", " "));
  ' "$1" "$2"
}

p6_backdate_points() {
  # $1 customer id, $2 stored timestamp -> every points_ledger row of theirs
  local ids row
  ids="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
    --data-urlencode "filter=customer='$1'" --data-urlencode "perPage=200" \
    "$BASE/api/collections/points_ledger/records" | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c));
      process.stdin.on("end", () => {
        let items = [];
        try { items = JSON.parse(d || "{}").items || []; } catch (e) { items = []; }
        process.stdout.write(items.map((i) => i.id).join(" "));
      });
    ')"
  local status
  for row in $ids; do
    status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BACKDATE_BASE/api/check/backdate" \
      -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
      -d "{\"table\":\"points_ledger\",\"id\":\"$row\",\"created\":\"$2\"}")"
    [ "$status" = "200" ] || fail "backdating points_ledger row $row returned $status"
  done
  [ -n "$ids" ] || fail "there were no points_ledger rows to backdate for customer $1"
  # Read one back through the server under test, so a backdate that did not
  # reach it is caught here rather than three assertions later.
  local seen
  seen="$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=customer='$1'" \
    --data-urlencode "sort=-created" "$BASE/api/collections/points_ledger/records" | jval "items.0.created")"
  [ "$seen" = "$2" ] || fail "backdating customer $1's points rows to '$2' left the newest reading '$seen'"
}

p6_count() {
  # $1 collection, $2 filter -> totalItems
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    "$BASE/api/collections/$1/records" | jval totalItems
}

p6_notifications() {
  # $1 customer id, $2 type -> how many notifications of that type they hold
  p6_count notifications "customer='$1' && type='$2'"
}

p6_points_rows() {
  # $1 customer id, $2 reason -> how many points_ledger rows of that reason
  p6_count points_ledger "customer='$1' && reason='$2'"
}

p6_ledger_sum() {
  # $1 collection (points_ledger/credit_ledger), $2 signed column,
  # $3 customer id -> the ledger's own total, which is the truth
  # customer_private only caches (CLAUDE.md, "Money").
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=customer='$3'" \
    --data-urlencode "perPage=500" "$BASE/api/collections/$1/records" | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c));
      process.stdin.on("end", () => {
        let items = [];
        try { items = JSON.parse(d || "{}").items || []; } catch (e) { items = []; }
        let total = 0;
        for (const row of items) total += row[process.argv[1]] || 0;
        process.stdout.write(String(total));
      });
    ' "$2"
}

p6_tier_name() {
  # $1 customer id -> the name on their customer_private.tier, or ""
  local tier_id
  tier_id="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=customer='$1'" \
    "$BASE/api/collections/customer_private/records" | jval "items.0.tier")"
  [ -n "$tier_id" ] || return 0
  curl -s "$BASE/api/collections/loyalty_tiers/records/$tier_id" -H "Authorization: $STAFF_TOKEN" | jval name
}

p6_private_field() {
  # $1 customer id, $2 field -> that field off their customer_private row
  curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=customer='$1'" \
    "$BASE/api/collections/customer_private/records" | jval "items.0.$2"
}

p6_run_cron() {
  # $1 cron name. POST /api/crons/{name} returns 204 before the job has
  # finished (see wait_for_audit_row's note), so callers poll for the row
  # the job writes rather than reading once.
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/$1" -H "Authorization: $SUPER_TOKEN")"
  [ "$status" = "204" ] || fail "POST /api/crons/$1 returned $status, expected 204"
}

p6_wait_count() {
  # $1 collection, $2 filter, $3 wanted count -> polls for ~10 seconds
  local tries=0
  while [ "$tries" -lt 40 ]; do
    [ "$(p6_count "$1" "$2")" = "$3" ] && return 0
    sleep 0.25
    tries=$((tries + 1))
  done
  return 1
}

# A record written by an after-create hook (the welcome bonus's own tier
# re-evaluation, the cached balances) is not always in the database by the
# time the request that set it off has answered: PocketBase runs those
# hooks off the completion of the whole create, which can land after the
# response. The three helpers below poll for ~10 seconds rather than
# reading once, the same way wait_for_audit_row does for a cron.
p6_expect_private() {
  # $1 customer id, $2 field, $3 wanted value, $4 what to say if it never is
  local tries=0
  while [ "$tries" -lt 40 ]; do
    [ "$(p6_private_field "$1" "$2")" = "$3" ] && return 0
    sleep 0.25
    tries=$((tries + 1))
  done
  fail "$4 (customer_private.$2 is '$(p6_private_field "$1" "$2")', expected '$3')"
}

p6_expect_tier() {
  # $1 customer id, $2 wanted tier name, $3 what to say if it never is
  local tries=0
  while [ "$tries" -lt 40 ]; do
    [ "$(p6_tier_name "$1")" = "$2" ] && return 0
    sleep 0.25
    tries=$((tries + 1))
  done
  fail "$3 (on '$(p6_tier_name "$1")', expected '$2')"
}

p6_expect_count() {
  # $1 collection, $2 filter, $3 wanted count, $4 what to say if it never is
  p6_wait_count "$1" "$2" "$3" || fail "$4 (found $(p6_count "$1" "$2"), expected $3)"
}

p6_customer() {
  # $1 name, $2 email -> the customer id
  curl -s -X POST "$BASE/api/collections/customers/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"source\":\"counter\"}" | jval id
}

p6_award() {
  # $1 customer id, $2 delta -> an adjust row straight through the
  # collection API, the way a correction at the counter would go in
  curl -s -o /dev/null -X POST "$BASE/api/collections/points_ledger/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"customer\":\"$1\",\"delta\":$2,\"reason\":\"adjust\",\"ref\":\"phase 6 check\"}"
}

P6_STEPUP="$(curl -s -X POST "$BASE/api/vault/step-up" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$STAFF_PASSWORD\"}" | jval token)"
[ -n "$P6_STEPUP" ] || fail "could not mint a step-up token for section 24"

# --- 24a. The welcome bonus, once and only once -------------------------
P6_REFERRER_ID="$(p6_customer "P6 Referrer" "p6-referrer@local.test")"
[ -n "$P6_REFERRER_ID" ] || fail "could not create the referring customer"

[ "$(p6_points_rows "$P6_REFERRER_ID" welcome)" = "1" ] \
  || fail "a new customer has $(p6_points_rows "$P6_REFERRER_ID" welcome) welcome rows, expected exactly 1"
P6_WELCOME_DELTA="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_REFERRER_ID' && reason='welcome'" \
  "$BASE/api/collections/points_ledger/records" | jval "items.0.delta")"
[ "$P6_WELCOME_DELTA" = "100" ] || fail "the welcome bonus is '$P6_WELCOME_DELTA' points, expected the seeded 100"
p6_expect_private "$P6_REFERRER_ID" points_balance 100 "the welcome bonus did not reach customer_private.points_balance"
ok "a new customer gets one welcome bonus row of 100 points, and the cached balance follows"

p6_expect_tier "$P6_REFERRER_ID" Member "a customer with the welcome bonus was left with no tier"
p6_expect_count notifications "customer='$P6_REFERRER_ID' && type='tier_up'" 1 "joining the Guild did not notify the customer once"
ok "the welcome bonus puts the customer on the first tier and notifies them once"

p6_award "$P6_REFERRER_ID" 50
[ "$(p6_points_rows "$P6_REFERRER_ID" welcome)" = "1" ] \
  || fail "a second points row gave the customer a second welcome bonus"
ok "a later points row never writes a second welcome bonus"

# --- 24b. Referrals: resolved at creation, refused for a bad code and for
#     self, earned on the referee's first completed sale, never twice ----
P6_REFERRER_CODE="$(curl -s "$BASE/api/collections/customers/records/$P6_REFERRER_ID" -H "Authorization: $STAFF_TOKEN" | jval code)"
[ -n "$P6_REFERRER_CODE" ] || fail "the referring customer has no code"

P6_BAD_REFERRAL="$(curl -s -o "$TMP_DIR/p6-bad-referral.json" -w '%{http_code}' \
  -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"P6 Bad Code","email":"p6-badcode@local.test","source":"counter","referred_by":"GGC-ZZZZZ"}')"
[ "$P6_BAD_REFERRAL" = "400" ] \
  || fail "creating a customer with an unknown referral code returned $P6_BAD_REFERRAL, expected 400: $(cat "$TMP_DIR/p6-bad-referral.json")"
grep -q "No customer has the code" "$TMP_DIR/p6-bad-referral.json" \
  || fail "the unknown-code refusal does not name the code: $(cat "$TMP_DIR/p6-bad-referral.json")"
grep -q "Check it with them" "$TMP_DIR/p6-bad-referral.json" \
  || fail "the unknown-code refusal does not say what to do: $(cat "$TMP_DIR/p6-bad-referral.json")"
[ "$(p6_count customers "email='p6-badcode@local.test'")" = "0" ] \
  || fail "the customer with an unknown referral code was created anyway"
ok "a referral code nobody holds is refused at creation (400), and no customer is left behind"

# referred_by resolves a record id as well as a GGC code, which is the only
# way to name a customer that does not exist yet: an explicit id, pointed at
# itself.
P6_SELF_REFERRAL="$(curl -s -o "$TMP_DIR/p6-self-referral.json" -w '%{http_code}' \
  -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"p6selfreferral1","name":"P6 Self","email":"p6-self@local.test","source":"counter","referred_by":"p6selfreferral1"}')"
[ "$P6_SELF_REFERRAL" = "400" ] \
  || fail "a customer referring themselves returned $P6_SELF_REFERRAL, expected 400: $(cat "$TMP_DIR/p6-self-referral.json")"
grep -q "cannot refer themselves" "$TMP_DIR/p6-self-referral.json" \
  || fail "the self-referral refusal does not say so: $(cat "$TMP_DIR/p6-self-referral.json")"
ok "a customer cannot refer themselves (400)"

P6_REFEREE_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"P6 Referee\",\"email\":\"p6-referee@local.test\",\"source\":\"counter\",\"referred_by\":\"$P6_REFERRER_CODE\"}" | jval id)"
[ -n "$P6_REFEREE_ID" ] || fail "could not create the referred customer"
P6_REFEREE_REFERRED_BY="$(curl -s "$BASE/api/collections/customers/records/$P6_REFEREE_ID" -H "Authorization: $STAFF_TOKEN" | jval referred_by)"
[ "$P6_REFEREE_REFERRED_BY" = "$P6_REFERRER_ID" ] \
  || fail "referred_by resolved to '$P6_REFEREE_REFERRED_BY', expected the referrer's id"
P6_REFERRAL_JSON="$(curl -s -G -H "Authorization: $STAFF_TOKEN" \
  --data-urlencode "filter=referee='$P6_REFEREE_ID'" "$BASE/api/collections/referrals/records")"
[ "$(echo "$P6_REFERRAL_JSON" | jval totalItems)" = "1" ] \
  || fail "creating a referred customer wrote $(echo "$P6_REFERRAL_JSON" | jval totalItems) referrals rows, expected 1"
[ "$(echo "$P6_REFERRAL_JSON" | jval "items.0.status")" = "pending" ] \
  || fail "the new referral is '$(echo "$P6_REFERRAL_JSON" | jval "items.0.status")', expected pending"
P6_REFERRAL_ID="$(echo "$P6_REFERRAL_JSON" | jval "items.0.id")"
ok "a customer code at creation resolves to the referrer and writes a pending referral"

P6_REFERRAL_ITEM="$(make_item "P6 Referral Sale Item" 1 500 2000)"
P6_REFERRAL_SALE="$(curl -s -o "$TMP_DIR/p6-referral-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$P6_REFERRAL_ITEM\",\"qty\":1,\"unit_price\":2000,\"discount\":0}],\"customer\":\"$P6_REFEREE_ID\",\"payment\":\"sumup_card\"}")"
[ "$P6_REFERRAL_SALE" = "200" ] || fail "the referee's first sale returned $P6_REFERRAL_SALE: $(cat "$TMP_DIR/p6-referral-sale.json")"

P6_REFERRAL_AFTER="$(curl -s "$BASE/api/collections/referrals/records/$P6_REFERRAL_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P6_REFERRAL_AFTER" | jval status)" = "earned" ] \
  || fail "after the referee's first sale the referral is '$(echo "$P6_REFERRAL_AFTER" | jval status)', expected earned"
[ -n "$(echo "$P6_REFERRAL_AFTER" | jval earned_at)" ] || fail "the earned referral has no earned_at"
P6_REFERRER_BONUS="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_REFERRER_ID' && reason='referral'" \
  "$BASE/api/collections/points_ledger/records")"
[ "$(echo "$P6_REFERRER_BONUS" | jval totalItems)" = "1" ] || fail "the referrer has no single referral row"
[ "$(echo "$P6_REFERRER_BONUS" | jval "items.0.delta")" = "250" ] \
  || fail "the referrer's bonus is '$(echo "$P6_REFERRER_BONUS" | jval "items.0.delta")', expected the seeded 250"
[ "$(echo "$P6_REFERRER_BONUS" | jval "items.0.ref")" = "$P6_REFERRAL_ID" ] \
  || fail "the referrer's bonus row does not ref the referral"
P6_REFEREE_BONUS="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_REFEREE_ID' && reason='referral'" \
  "$BASE/api/collections/points_ledger/records")"
[ "$(echo "$P6_REFEREE_BONUS" | jval "items.0.delta")" = "250" ] \
  || fail "the referee's bonus is '$(echo "$P6_REFEREE_BONUS" | jval "items.0.delta")', expected 250"
[ "$(p6_notifications "$P6_REFERRER_ID" referral_earned)" = "1" ] \
  || fail "the referrer was not notified of the referral bonus"
[ "$(p6_notifications "$P6_REFEREE_ID" referral_earned)" = "1" ] \
  || fail "the referee was not notified of the referral bonus"
ok "the referee's first completed sale earns both sides, with a ledger row and a notification each"

P6_SECOND_ITEM="$(make_item "P6 Second Sale Item" 1 500 1000)"
curl -s -o /dev/null -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$P6_SECOND_ITEM\",\"qty\":1,\"unit_price\":1000,\"discount\":0}],\"customer\":\"$P6_REFEREE_ID\",\"payment\":\"sumup_card\"}"
[ "$(p6_points_rows "$P6_REFEREE_ID" referral)" = "1" ] \
  || fail "a second sale paid the referral bonus again"
[ "$(p6_points_rows "$P6_REFERRER_ID" referral)" = "1" ] \
  || fail "a second sale paid the referrer again"
ok "a second completed sale never pays the referral a second time"

# --- 24c. Tiers: promotion, the nightly window recompute, and a paid plan
#     pinning a tier until it lapses -------------------------------------
P6_TIER_ID="$(p6_customer "P6 Tier" "p6-tier@local.test")"
p6_award "$P6_TIER_ID" 2500
p6_expect_tier "$P6_TIER_ID" Regular "2600 window points did not promote the customer"
p6_expect_count notifications "customer='$P6_TIER_ID' && type='tier_up'" 2 "the promotion to Regular did not add a second tier_up notification (Member, then Regular)"
P6_TIER_UP_TITLE="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_TIER_ID' && type='tier_up'" --data-urlencode "sort=-created" \
  "$BASE/api/collections/notifications/records" | jval "items.0.title")"
[ "$P6_TIER_UP_TITLE" = "You are now a Regular" ] \
  || fail "the promotion notification reads '$P6_TIER_UP_TITLE', expected 'You are now a Regular'"
ok "a ledger write promotes the customer and notifies them, naming the tier"

# Roll the whole ledger out of the 12-month window and let the nightly
# recompute notice: nothing writes a row when points simply age out.
p6_backdate_points "$P6_TIER_ID" "$(p6_ago 13 0)"
p6_run_cron tiers_recompute
p6_expect_tier "$P6_TIER_ID" Member "after the window rolled past, tiers_recompute did not demote the customer"
[ "$(p6_notifications "$P6_TIER_ID" tier_up)" = "2" ] \
  || fail "the demotion was announced; it is meant to be silent"
[ "$(p6_private_field "$P6_TIER_ID" points_balance)" = "2600" ] \
  || fail "the demotion changed the points balance, which the rolling window must never touch"
ok "points ageing out of the rolling window demote the customer on the nightly cron, silently, without touching the balance"

P6_PASS_TIER_ID="$(curl -s -X POST "$BASE/api/collections/loyalty_tiers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Guild Pass","threshold_points":0,"colour_token":"tier-pass","sort":40,"paid_plan":true,"perks":[{"type":"free_event_entries","value":2,"perMonth":true}]}' | jval id)"
[ -n "$P6_PASS_TIER_ID" ] || fail "could not create the paid-plan tier"

P6_REGULAR_TIER_ID="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Regular'" \
  "$BASE/api/collections/loyalty_tiers/records" | jval "items.0.id")"
[ -n "$P6_REGULAR_TIER_ID" ] || fail "could not resolve the seeded Regular tier"
P6_MEMBERSHIP_EARNED="$(curl -s -o "$TMP_DIR/p6-membership-earned.json" -w '%{http_code}' -X POST "$BASE/api/vault/memberships" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_TIER_ID\",\"tier\":\"$P6_REGULAR_TIER_ID\",\"months\":1,\"price\":1000}")"
[ "$P6_MEMBERSHIP_EARNED" = "422" ] \
  || fail "selling a membership on an earned tier returned $P6_MEMBERSHIP_EARNED, expected 422: $(cat "$TMP_DIR/p6-membership-earned.json")"
ok "a membership cannot be sold on a tier that is earned with points (422)"

P6_MEMBERSHIP_STATUS="$(curl -s -o "$TMP_DIR/p6-membership.json" -w '%{http_code}' -X POST "$BASE/api/vault/memberships" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_TIER_ID\",\"tier\":\"$P6_PASS_TIER_ID\",\"months\":6,\"price\":3000,\"payment_note\":\"Card at the counter\"}")"
[ "$P6_MEMBERSHIP_STATUS" = "200" ] || fail "starting a membership returned $P6_MEMBERSHIP_STATUS: $(cat "$TMP_DIR/p6-membership.json")"
P6_MEMBERSHIP_ID="$(jval "membership.id" <"$TMP_DIR/p6-membership.json")"
p6_expect_tier "$P6_TIER_ID" "Guild Pass" "a paid plan did not pin its own tier"
[ "$(p6_notifications "$P6_TIER_ID" membership_started)" = "1" ] || fail "the new member was not notified"
[ "$(p6_count audit_log "action='membership_start' && record='$P6_MEMBERSHIP_ID'")" = "1" ] \
  || fail "starting a membership wrote no audit row"
ok "a paid plan pins a higher tier than the points earn, notifies the customer and is audited"

P6_MEMBERSHIP_DUPE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/memberships" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_TIER_ID\",\"tier\":\"$P6_PASS_TIER_ID\",\"months\":6,\"price\":3000}")"
[ "$P6_MEMBERSHIP_DUPE" = "409" ] || fail "a second active membership returned $P6_MEMBERSHIP_DUPE, expected 409"
P6_RENEWS_BEFORE="$(curl -s "$BASE/api/collections/memberships/records/$P6_MEMBERSHIP_ID" -H "Authorization: $STAFF_TOKEN" | jval renews_at)"
P6_RENEW_STATUS="$(curl -s -o "$TMP_DIR/p6-renew.json" -w '%{http_code}' -X POST "$BASE/api/vault/memberships/$P6_MEMBERSHIP_ID/renew" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"months":6,"price":3000}')"
[ "$P6_RENEW_STATUS" = "200" ] || fail "renewing a membership returned $P6_RENEW_STATUS: $(cat "$TMP_DIR/p6-renew.json")"
P6_RENEWS_AFTER="$(jval "membership.renews_at" <"$TMP_DIR/p6-renew.json")"
[ "$P6_RENEWS_AFTER" \> "$P6_RENEWS_BEFORE" ] \
  || fail "renewing early moved renews_at from '$P6_RENEWS_BEFORE' to '$P6_RENEWS_AFTER' instead of extending it"
[ "$(p6_count audit_log "action='membership_renew' && record='$P6_MEMBERSHIP_ID'")" = "1" ] \
  || fail "renewing a membership wrote no audit row"
ok "a second active membership is refused (409), and a renewal extends from the existing expiry and is audited"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/memberships/records/$P6_MEMBERSHIP_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"renews_at\":\"$(p6_ago 1 0)\"}"
p6_run_cron memberships_lapse
p6_wait_count memberships "id='$P6_MEMBERSHIP_ID' && status='lapsed'" 1 \
  || fail "the memberships_lapse cron left the past-due membership as '$(curl -s "$BASE/api/collections/memberships/records/$P6_MEMBERSHIP_ID" -H "Authorization: $STAFF_TOKEN" | jval status)'"
p6_expect_tier "$P6_TIER_ID" Member "a lapsed membership did not put the customer back on their earned tier"
[ "$(p6_notifications "$P6_TIER_ID" membership_lapsed)" = "1" ] || fail "the lapsed member was not notified"
ok "a membership past its renewal lapses on the nightly cron, unpins the tier and notifies the customer"

P6_MEMBERSHIP_TWO="$(curl -s -X POST "$BASE/api/vault/memberships" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_TIER_ID\",\"tier\":\"$P6_PASS_TIER_ID\",\"months\":1,\"price\":600}" | jval "membership.id")"
[ -n "$P6_MEMBERSHIP_TWO" ] || fail "could not start a second membership after the first lapsed"
P6_CANCEL_STATUS="$(curl -s -o "$TMP_DIR/p6-cancel.json" -w '%{http_code}' -X POST "$BASE/api/vault/memberships/$P6_MEMBERSHIP_TWO/cancel" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_CANCEL_STATUS" = "200" ] || fail "cancelling a membership returned $P6_CANCEL_STATUS: $(cat "$TMP_DIR/p6-cancel.json")"
p6_expect_tier "$P6_TIER_ID" Member "a cancelled membership did not put the customer back on their earned tier"
[ "$(p6_count audit_log "action='membership_cancel' && record='$P6_MEMBERSHIP_TWO'")" = "1" ] \
  || fail "cancelling a membership wrote no audit row"
ok "a cancelled membership unpins the tier straight away and is audited"

# --- 24d. Points expiry: one warning per run-up, a purchase resets the
#     clock, and the whole balance goes when it runs out -----------------
P6_EXPIRY_ID="$(p6_customer "P6 Expiry" "p6-expiry@local.test")"
p6_award "$P6_EXPIRY_ID" 1140
p6_expect_private "$P6_EXPIRY_ID" points_balance 1240 "the expiry customer's balance never reached 1240"

# 17 months and 20 days back, so the seeded 18-month expiry falls a week or
# two from now: inside the 30-day warning run-up, not yet past.
p6_backdate_points "$P6_EXPIRY_ID" "$(p6_ago 17 20)"
p6_run_cron points_expire
p6_wait_count notifications "customer='$P6_EXPIRY_ID' && type='points_expiring'" 1 \
  || fail "the points_expire cron sent no warning to a customer three weeks from expiry"
P6_WARNING="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_EXPIRY_ID' && type='points_expiring'" \
  "$BASE/api/collections/notifications/records")"
echo "$P6_WARNING" | grep -q "1,240 points expire on" \
  || fail "the expiry warning does not say how many points expire when: $P6_WARNING"
echo "$P6_WARNING" | grep -q "Any purchase keeps them." \
  || fail "the expiry warning does not say what to do about it: $P6_WARNING"
[ -n "$(p6_private_field "$P6_EXPIRY_ID" points_expiry_warned_at)" ] \
  || fail "the warning was not recorded on customer_private.points_expiry_warned_at"
[ "$(p6_points_rows "$P6_EXPIRY_ID" expire)" = "0" ] \
  || fail "the warning run expired the points as well"
ok "points a month from expiring earn one warning naming the figure and the date"

p6_run_cron points_expire
sleep 2
[ "$(p6_notifications "$P6_EXPIRY_ID" points_expiring)" = "1" ] \
  || fail "a second nightly run warned the same customer again"
ok "the expiry warning is sent once per run-up, not once a night"

p6_award "$P6_EXPIRY_ID" 60
p6_expect_private "$P6_EXPIRY_ID" points_expiry_warned_at "" "points coming in did not clear the expiry warning stamp"
ok "points coming in reset the expiry clock and clear the warning"

p6_backdate_points "$P6_EXPIRY_ID" "$(p6_ago 19 0)"
p6_run_cron points_expire
p6_wait_count points_ledger "customer='$P6_EXPIRY_ID' && reason='expire'" 1 \
  || fail "the points_expire cron wrote no expire row for a customer 19 months past their last purchase"
P6_EXPIRE_ROW="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_EXPIRY_ID' && reason='expire'" \
  "$BASE/api/collections/points_ledger/records")"
[ "$(echo "$P6_EXPIRE_ROW" | jval "items.0.delta")" = "-1300" ] \
  || fail "the expire row is '$(echo "$P6_EXPIRE_ROW" | jval "items.0.delta")' points, expected the whole -1300 balance"
[ "$(echo "$P6_EXPIRE_ROW" | jval "items.0.balance_after")" = "0" ] \
  || fail "the expire row's balance_after is '$(echo "$P6_EXPIRE_ROW" | jval "items.0.balance_after")', expected 0"
p6_expect_private "$P6_EXPIRY_ID" points_balance 0 "the cached balance did not follow the expiry down to 0"
[ "$(p6_notifications "$P6_EXPIRY_ID" points_expired)" = "1" ] || fail "the customer was not told their points had expired"
ok "points past the inactivity window expire in one row for the whole balance, and the customer is told"

# --- 24e. Rewards, redemption and the vouchers it produces --------------
P6_SHOPPER_ID="$(p6_customer "P6 Shopper" "p6-shopper@local.test")"
p6_award "$P6_SHOPPER_ID" 1900
P6_SHOPPER_TOKEN="$(p5_impersonate "$P6_SHOPPER_ID")"
[ -n "$P6_SHOPPER_TOKEN" ] || fail "could not impersonate the rewards shopper"

p6_reward() {
  # $1 json body -> the reward id
  curl -s -X POST "$BASE/api/collections/loyalty_rewards/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$1" | jval id
}
P6_REWARD_BOOSTER="$(p6_reward '{"name":"P6 Free booster","type":"free_item","value":0,"cost_points":500,"active":true}')"
P6_REWARD_DEAR="$(p6_reward '{"name":"P6 Display case","type":"free_item","value":0,"cost_points":9000,"active":true}')"
P6_REWARD_LAST="$(p6_reward '{"name":"P6 Last one","type":"event_entry","value":0,"cost_points":100,"active":true,"stock_limit":1}')"
P6_REWARD_ONCE="$(p6_reward '{"name":"P6 Once only","type":"custom","value":0,"cost_points":100,"active":true,"per_customer_limit":1}')"
P6_REWARD_SOON="$(p6_reward '{"name":"P6 Early bird","type":"free_item","value":0,"cost_points":100,"active":true,"starts_at":"2031-01-01 00:00:00.000Z"}')"
P6_REWARD_CREDIT="$(p6_reward '{"name":"P6 Five pounds credit","type":"store_credit","value":500,"cost_points":200,"active":true}')"
P6_REWARD_MONEYOFF="$(p6_reward '{"name":"P6 Five pounds off","type":"money_off","value":500,"cost_points":100,"active":true}')"
for P6_REWARD_ID in "$P6_REWARD_BOOSTER" "$P6_REWARD_DEAR" "$P6_REWARD_LAST" "$P6_REWARD_ONCE" "$P6_REWARD_SOON" "$P6_REWARD_CREDIT" "$P6_REWARD_MONEYOFF"; do
  [ -n "$P6_REWARD_ID" ] || fail "could not create one of the section 24 rewards"
done

# Somebody else takes the only one of the limited reward.
P6_OTHER_ID="$(p6_customer "P6 Other" "p6-other@local.test")"
p6_award "$P6_OTHER_ID" 400
P6_OTHER_TOKEN="$(p5_impersonate "$P6_OTHER_ID")"
P6_OTHER_REDEEM="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/rewards/$P6_REWARD_LAST/redeem" \
  -H "Authorization: $P6_OTHER_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_OTHER_REDEEM" = "200" ] || fail "the other customer could not take the only one of the limited reward ($P6_OTHER_REDEEM)"
# And the shopper takes their one allowance of the per-customer-limited one.
curl -s -o /dev/null -X POST "$BASE/api/vault/rewards/$P6_REWARD_ONCE/redeem" \
  -H "Authorization: $P6_SHOPPER_TOKEN" -H "Content-Type: application/json" -d '{}'

P6_REWARDS_JSON="$(curl -s "$BASE/api/vault/rewards" -H "Authorization: $P6_SHOPPER_TOKEN")"
p6_reward_field() {
  # $1 rewards json, $2 reward id, $3 field
  echo "$1" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const rewards = (JSON.parse(d || "{}").rewards) || [];
      const row = rewards.find((r) => r.id === process.argv[1]) || {};
      const v = row[process.argv[2]];
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });
  ' "$2" "$3"
}
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_BOOSTER" reason)" = "ok" ] \
  || fail "a reward the shopper can afford reads '$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_BOOSTER" reason)', expected ok"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_DEAR" reason)" = "insufficient" ] \
  || fail "a reward beyond the balance reads '$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_DEAR" reason)', expected insufficient"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_LAST" reason)" = "sold_out" ] \
  || fail "the reward somebody else took the last of reads '$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_LAST" reason)', expected sold_out"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_LAST" remaining)" = "0" ] \
  || fail "the sold-out reward reports '$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_LAST" remaining)' remaining, expected 0"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_ONCE" reason)" = "limit_reached" ] \
  || fail "the reward the shopper has already had reads '$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_ONCE" reason)', expected limit_reached"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_SOON" reason)" = "not_yet" ] \
  || fail "a reward that has not opened reads '$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_SOON" reason)', expected not_yet"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_BOOSTER" can_redeem)" = "true" ] \
  || fail "the affordable reward is not marked can_redeem"
[ "$(p6_reward_field "$P6_REWARDS_JSON" "$P6_REWARD_DEAR" can_redeem)" = "false" ] \
  || fail "an unaffordable reward is marked can_redeem"
ok "the rewards list says why each reward cannot be redeemed: insufficient, sold out, limit reached, not yet"

P6_REWARDS_ANON="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/rewards")"
[ "$P6_REWARDS_ANON" = "401" ] || fail "GET /api/vault/rewards without a token returned $P6_REWARDS_ANON, expected 401"
P6_DEAR_REDEEM="$(curl -s -o "$TMP_DIR/p6-dear.json" -w '%{http_code}' -X POST "$BASE/api/vault/rewards/$P6_REWARD_DEAR/redeem" \
  -H "Authorization: $P6_SHOPPER_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_DEAR_REDEEM" = "422" ] || fail "redeeming an unaffordable reward returned $P6_DEAR_REDEEM, expected 422"
grep -q "You need 9,000 points for this and have" "$TMP_DIR/p6-dear.json" \
  || fail "the insufficient-points refusal does not say how short they are: $(cat "$TMP_DIR/p6-dear.json")"
ok "redeeming a reward beyond the balance is refused with the two figures (422)"

P6_REDEEM_STATUS="$(curl -s -o "$TMP_DIR/p6-redeem.json" -w '%{http_code}' -X POST "$BASE/api/vault/rewards/$P6_REWARD_BOOSTER/redeem" \
  -H "Authorization: $P6_SHOPPER_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_REDEEM_STATUS" = "200" ] || fail "redeeming a reward returned $P6_REDEEM_STATUS: $(cat "$TMP_DIR/p6-redeem.json")"
P6_VOUCHER_ID="$(jval "voucher.id" <"$TMP_DIR/p6-redeem.json")"
P6_VOUCHER_CODE="$(jval "voucher.code" <"$TMP_DIR/p6-redeem.json")"
P6_VOUCHER_NUMBER="$(jval "voucher.number" <"$TMP_DIR/p6-redeem.json")"
echo "$P6_VOUCHER_NUMBER" | grep -Eq '^GG-V-[0-9]{6}$' || fail "the voucher number is '$P6_VOUCHER_NUMBER', expected the GG-V-000001 form"
echo "$P6_VOUCHER_CODE" | grep -Eq '^GGV[0-9A-HJKMNP-TV-Z]{6}$' || fail "the voucher code is '$P6_VOUCHER_CODE', expected the GGV… form"
[ "$(jval "voucher.status" <"$TMP_DIR/p6-redeem.json")" = "issued" ] || fail "a new voucher is not issued"
[ -n "$(jval "voucher.expires_at" <"$TMP_DIR/p6-redeem.json")" ] || fail "a new voucher has no expiry"
P6_REDEEM_ROW="$(curl -s -G -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=customer='$P6_SHOPPER_ID' && reason='redeem' && ref='$P6_VOUCHER_ID'" \
  "$BASE/api/collections/points_ledger/records")"
[ "$(echo "$P6_REDEEM_ROW" | jval "items.0.delta")" = "-500" ] \
  || fail "the redemption's points row is '$(echo "$P6_REDEEM_ROW" | jval "items.0.delta")', expected -500 refing the voucher"
[ "$(p6_notifications "$P6_SHOPPER_ID" reward_issued)" = "2" ] \
  || fail "the shopper holds $(p6_notifications "$P6_SHOPPER_ID" reward_issued) reward_issued notifications, expected 2"
[ "$(p6_count audit_log "action='reward_redeem' && record='$P6_VOUCHER_ID'")" = "1" ] \
  || fail "redeeming a reward wrote no audit row"
ok "redeeming a reward spends the points and issues a numbered, coded, dated voucher"

P6_CREDIT_BEFORE="$(p6_ledger_sum credit_ledger amount "$P6_SHOPPER_ID")"
P6_CREDIT_REDEEM="$(curl -s -o "$TMP_DIR/p6-credit.json" -w '%{http_code}' -X POST "$BASE/api/vault/rewards/$P6_REWARD_CREDIT/redeem" \
  -H "Authorization: $P6_SHOPPER_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_CREDIT_REDEEM" = "200" ] || fail "redeeming a store-credit reward returned $P6_CREDIT_REDEEM: $(cat "$TMP_DIR/p6-credit.json")"
[ "$(jval "voucher.status" <"$TMP_DIR/p6-credit.json")" = "used" ] \
  || fail "a store-credit reward's voucher is '$(jval "voucher.status" <"$TMP_DIR/p6-credit.json")', expected used at once"
p6_expect_private "$P6_SHOPPER_ID" credit_balance "$((P6_CREDIT_BEFORE + 500))" "a store-credit reward did not credit the account"
[ "$(p6_count credit_ledger "customer='$P6_SHOPPER_ID' && reason='reward'")" = "1" ] \
  || fail "a store-credit reward wrote no credit_ledger row with reason reward"
ok "a store-credit reward credits the account at once and closes its own voucher"

P6_VOUCHER_LOOKUP="$(curl -s -o "$TMP_DIR/p6-voucher.json" -w '%{http_code}' "$BASE/api/vault/vouchers/$P6_VOUCHER_CODE" -H "Authorization: $STAFF_TOKEN")"
[ "$P6_VOUCHER_LOOKUP" = "200" ] || fail "looking a voucher up by code returned $P6_VOUCHER_LOOKUP: $(cat "$TMP_DIR/p6-voucher.json")"
[ "$(jval "voucher.customer.id" <"$TMP_DIR/p6-voucher.json")" = "$P6_SHOPPER_ID" ] \
  || fail "the voucher lookup does not name the customer holding it"
[ "$(jval "voucher.reward.name" <"$TMP_DIR/p6-voucher.json")" = "P6 Free booster" ] \
  || fail "the voucher lookup does not name the reward"
P6_VOUCHER_UNKNOWN="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/vouchers/GGVZZZZZZ" -H "Authorization: $STAFF_TOKEN")"
[ "$P6_VOUCHER_UNKNOWN" = "404" ] || fail "an unknown voucher code returned $P6_VOUCHER_UNKNOWN, expected 404"
ok "staff can look a voucher up by its code, and an unknown code is a 404"

P6_USE_STATUS="$(curl -s -o "$TMP_DIR/p6-use.json" -w '%{http_code}' -X POST "$BASE/api/vault/vouchers/$P6_VOUCHER_CODE/use" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_USE_STATUS" = "200" ] || fail "using a voucher returned $P6_USE_STATUS: $(cat "$TMP_DIR/p6-use.json")"
[ "$(jval "voucher.status" <"$TMP_DIR/p6-use.json")" = "used" ] || fail "the used voucher is not marked used"
[ -n "$(curl -s "$BASE/api/collections/reward_redemptions/records/$P6_VOUCHER_ID" -H "Authorization: $STAFF_TOKEN" | jval used_by)" ] \
  || fail "the used voucher does not record who took it"
[ "$(p6_notifications "$P6_SHOPPER_ID" reward_used)" = "1" ] || fail "the customer was not told their reward had been used"
[ "$(p6_count audit_log "action='voucher_use' && record='$P6_VOUCHER_ID'")" = "1" ] || fail "using a voucher wrote no audit row"
P6_USE_AGAIN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/vouchers/$P6_VOUCHER_CODE/use" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_USE_AGAIN" = "409" ] || fail "using a voucher twice returned $P6_USE_AGAIN, expected 409"
ok "staff mark a voucher used once, the customer is told, and a second use is refused (409)"

P6_MONEYOFF_CODE="$(curl -s -X POST "$BASE/api/vault/rewards/$P6_REWARD_MONEYOFF/redeem" \
  -H "Authorization: $P6_SHOPPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval "voucher.code")"
[ -n "$P6_MONEYOFF_CODE" ] || fail "could not redeem the money-off reward"
P6_MONEYOFF_USE="$(curl -s -o "$TMP_DIR/p6-moneyoff.json" -w '%{http_code}' -X POST "$BASE/api/vault/vouchers/$P6_MONEYOFF_CODE/use" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_MONEYOFF_USE" = "409" ] || fail "marking a money-off voucher used returned $P6_MONEYOFF_USE, expected 409"
grep -q "Use this one on the sale: scan it at Sell." "$TMP_DIR/p6-moneyoff.json" \
  || fail "the money-off refusal does not send staff to the Sell screen: $(cat "$TMP_DIR/p6-moneyoff.json")"
ok "a money-off voucher is never ticked off at the counter, it goes on the sale (409)"

P6_POINTS_BEFORE_CANCEL="$(p6_ledger_sum points_ledger delta "$P6_SHOPPER_ID")"
P6_CANCEL_NONADMIN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/vouchers/$P6_MONEYOFF_CODE/cancel" \
  -H "Authorization: $PLAIN_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_CANCEL_NONADMIN" = "403" ] || fail "a non-admin cancelling a voucher returned $P6_CANCEL_NONADMIN, expected 403"
P6_CANCEL_VOUCHER="$(curl -s -o "$TMP_DIR/p6-voucher-cancel.json" -w '%{http_code}' -X POST "$BASE/api/vault/vouchers/$P6_MONEYOFF_CODE/cancel" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_CANCEL_VOUCHER" = "200" ] || fail "cancelling a voucher returned $P6_CANCEL_VOUCHER: $(cat "$TMP_DIR/p6-voucher-cancel.json")"
[ "$(jval "voucher.status" <"$TMP_DIR/p6-voucher-cancel.json")" = "cancelled" ] || fail "the cancelled voucher is not marked cancelled"
p6_expect_private "$P6_SHOPPER_ID" points_balance "$((P6_POINTS_BEFORE_CANCEL + 100))" "cancelling a voucher did not return its 100 points"
P6_CANCEL_NOTE="$(curl -s -G -H "Authorization: $STAFF_TOKEN" \
  --data-urlencode "filter=target_collection='customers' && target_record='$P6_SHOPPER_ID'" --data-urlencode "sort=-created" \
  "$BASE/api/collections/notes/records" | jval "items.0.body")"
echo "$P6_CANCEL_NOTE" | grep -q "cancelled, 100 points returned" \
  || fail "cancelling a voucher left no note saying which voucher: '$P6_CANCEL_NOTE'"
[ "$(p6_count audit_log "action='voucher_cancel'")" = "1" ] || fail "cancelling a voucher wrote no audit row"
ok "an admin cancels a voucher, the points come back and a note on the customer says which one"

P6_STALE_VOUCHER="$(curl -s -X POST "$BASE/api/collections/reward_redemptions/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_SHOPPER_ID\",\"reward\":\"$P6_REWARD_BOOSTER\",\"points_spent\":0,\"status\":\"issued\",\"expires_at\":\"2020-01-01 00:00:00.000Z\"}" | jval id)"
[ -n "$P6_STALE_VOUCHER" ] || fail "could not create the already-expired voucher"
p6_run_cron vouchers_expire
p6_wait_count reward_redemptions "id='$P6_STALE_VOUCHER' && status='expired'" 1 \
  || fail "the vouchers_expire cron left a voucher past its expires_at as '$(curl -s "$BASE/api/collections/reward_redemptions/records/$P6_STALE_VOUCHER" -H "Authorization: $STAFF_TOKEN" | jval status)'"
[ "$(curl -s "$BASE/api/collections/reward_redemptions/records/$P6_VOUCHER_ID" -H "Authorization: $STAFF_TOKEN" | jval status)" = "used" ] \
  || fail "the vouchers_expire cron touched a voucher that was already used"
ok "the nightly vouchers_expire cron expires an unused voucher past its date and leaves the rest alone"

P6_MY_VOUCHERS="$(curl -s "$BASE/api/vault/me/vouchers" -H "Authorization: $P6_SHOPPER_TOKEN")"
[ "$(echo "$P6_MY_VOUCHERS" | jlen vouchers)" -ge 4 ] \
  || fail "GET /api/vault/me/vouchers returned $(echo "$P6_MY_VOUCHERS" | jlen vouchers) for a customer with several"
P6_OTHERS_VOUCHER_SEEN="$(echo "$P6_MY_VOUCHERS" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const rows = (JSON.parse(d || "{}").vouchers) || [];
    process.stdout.write(String(rows.some((v) => v.reward && v.reward.name === "P6 Last one")));
  });
')"
[ "$P6_OTHERS_VOUCHER_SEEN" = "false" ] || fail "GET /api/vault/me/vouchers returned another customer's voucher"
ok "a customer's own voucher list is theirs alone"

# --- 24f. The perks wallet, and using one ------------------------------
P6_LEGEND_ID="$(p6_customer "P6 Legend" "p6-legend@local.test")"
p6_award "$P6_LEGEND_ID" 10000
p6_expect_tier "$P6_LEGEND_ID" Legend "10,100 window points did not reach the Legend tier"
P6_PERKS_JSON="$(curl -s "$BASE/api/vault/customers/$P6_LEGEND_ID/perks" -H "Authorization: $STAFF_TOKEN")"
p6_perk_field() {
  # $1 perks json, $2 perk type, $3 field
  echo "$1" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const perks = (JSON.parse(d || "{}").perks) || [];
      const row = perks.find((p) => p.type === process.argv[1]) || {};
      const v = row[process.argv[2]];
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });
  ' "$2" "$3"
}
[ "$(p6_perk_field "$P6_PERKS_JSON" free_event_entries allowed)" = "2" ] \
  || fail "the Legend wallet allows '$(p6_perk_field "$P6_PERKS_JSON" free_event_entries allowed)' free event entries, expected the seeded 2"
[ "$(p6_perk_field "$P6_PERKS_JSON" free_event_entries used)" = "0" ] || fail "a fresh perk wallet already has entries used"
[ "$(p6_perk_field "$P6_PERKS_JSON" lounge_hours allowed)" = "12" ] \
  || fail "the Legend wallet allows '$(p6_perk_field "$P6_PERKS_JSON" lounge_hours allowed)' lounge hours, expected 12"
echo "$(p6_perk_field "$P6_PERKS_JSON" free_event_entries period)" | grep -Eq '^[0-9]{4}-[0-9]{2}$' \
  || fail "a counted perk's period is '$(p6_perk_field "$P6_PERKS_JSON" free_event_entries period)', expected YYYY-MM"
[ "$(p6_perk_field "$P6_PERKS_JSON" points_multiplier value)" = "1.5" ] \
  || fail "the informational points_multiplier perk is missing from the wallet: $P6_PERKS_JSON"
[ "$(p6_perk_field "$P6_PERKS_JSON" percent_off value)" = "10" ] \
  || fail "the informational percent_off perk is missing from the wallet: $P6_PERKS_JSON"
ok "the perks wallet reads this month's allowance and use off the tier, with the informational perks beside them"

for P6_PERK_TRY in 1 2; do
  P6_PERK_USE="$(curl -s -o "$TMP_DIR/p6-perk-use.json" -w '%{http_code}' -X POST "$BASE/api/vault/customers/$P6_LEGEND_ID/perks/use" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"type":"free_event_entries"}')"
  [ "$P6_PERK_USE" = "200" ] || fail "using free entry $P6_PERK_TRY returned $P6_PERK_USE: $(cat "$TMP_DIR/p6-perk-use.json")"
  [ "$(jval "perk.used" <"$TMP_DIR/p6-perk-use.json")" = "$P6_PERK_TRY" ] \
    || fail "after use $P6_PERK_TRY the wallet reports '$(jval "perk.used" <"$TMP_DIR/p6-perk-use.json")' used"
done
P6_PERK_OVER="$(curl -s -o "$TMP_DIR/p6-perk-over.json" -w '%{http_code}' -X POST "$BASE/api/vault/customers/$P6_LEGEND_ID/perks/use" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"type":"free_event_entries"}')"
[ "$P6_PERK_OVER" = "422" ] || fail "a third free entry in one month returned $P6_PERK_OVER, expected 422"
grep -q "Both free entries this month are used. The next two come on " "$TMP_DIR/p6-perk-over.json" \
  || fail "the used-up refusal does not say when the next ones come: $(cat "$TMP_DIR/p6-perk-over.json")"
[ "$(p6_count perk_usage "customer='$P6_LEGEND_ID' && perk_type='free_event_entries'")" = "1" ] \
  || fail "using a perk twice in one month wrote more than one perk_usage row"
[ "$(p6_count audit_log "action='perk_use'")" = "2" ] || fail "using a perk wrote no audit row"
ok "a counted perk is used up to the tier's monthly allowance, in one row, and refused after that"

P6_PERK_NOTIER="$(curl -s -o "$TMP_DIR/p6-perk-notier.json" -w '%{http_code}' -X POST "$BASE/api/vault/customers/$P6_SHOPPER_ID/perks/use" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"type":"lounge_hours"}')"
[ "$P6_PERK_NOTIER" = "422" ] || fail "using a perk the tier does not have returned $P6_PERK_NOTIER, expected 422"
grep -q "does not include lounge hours" "$TMP_DIR/p6-perk-notier.json" \
  || fail "the refusal does not name the tier and the perk: $(cat "$TMP_DIR/p6-perk-notier.json")"
P6_PERK_UNKNOWN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/customers/$P6_LEGEND_ID/perks/use" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"type":"free_parking"}')"
[ "$P6_PERK_UNKNOWN" = "400" ] || fail "using a perk that is not a perk returned $P6_PERK_UNKNOWN, expected 400"
ok "a perk the customer's tier does not carry is refused, naming the tier (422)"

# --- 24g. The admin points adjustment ----------------------------------
P6_ADJUST_NO_STEPUP="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/loyalty/adjust" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_SHOPPER_ID\",\"delta\":100,\"reason\":\"Goodwill after a long wait\"}")"
[ "$P6_ADJUST_NO_STEPUP" = "403" ] || fail "adjusting points without a step-up token returned $P6_ADJUST_NO_STEPUP, expected 403"
P6_ADJUST_NONADMIN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/loyalty/adjust" \
  -H "Authorization: $PLAIN_TOKEN" -H "X-Step-Up: $PLAIN_STEPUP" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_SHOPPER_ID\",\"delta\":100,\"reason\":\"Goodwill after a long wait\"}")"
[ "$P6_ADJUST_NONADMIN" = "403" ] || fail "a non-admin adjusting points returned $P6_ADJUST_NONADMIN, expected 403"
P6_ADJUST_SHORT="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/loyalty/adjust" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $P6_STEPUP" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_SHOPPER_ID\",\"delta\":100,\"reason\":\"oops\"}")"
[ "$P6_ADJUST_SHORT" = "400" ] || fail "adjusting points without a real reason returned $P6_ADJUST_SHORT, expected 400"
ok "a points adjustment needs an admin, a step-up token and a reason"

P6_ADJUST_BALANCE="$(p6_ledger_sum points_ledger delta "$P6_SHOPPER_ID")"
P6_ADJUST_OVER="$(curl -s -o "$TMP_DIR/p6-adjust-over.json" -w '%{http_code}' -X POST "$BASE/api/vault/loyalty/adjust" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $P6_STEPUP" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_SHOPPER_ID\",\"delta\":-$((P6_ADJUST_BALANCE + 40)),\"reason\":\"Removing more than they have\"}")"
[ "$P6_ADJUST_OVER" = "422" ] || fail "an adjustment taking the balance negative returned $P6_ADJUST_OVER, expected 422"
grep -q "That would take them to -40 points. The most you can remove is " "$TMP_DIR/p6-adjust-over.json" \
  || fail "the negative-balance refusal does not say how far it would go: $(cat "$TMP_DIR/p6-adjust-over.json")"
ok "an adjustment is never allowed to take a balance below zero (422)"

P6_ADJUST_STATUS="$(curl -s -o "$TMP_DIR/p6-adjust.json" -w '%{http_code}' -X POST "$BASE/api/vault/loyalty/adjust" \
  -H "Authorization: $STAFF_TOKEN" -H "X-Step-Up: $P6_STEPUP" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$P6_SHOPPER_ID\",\"delta\":-100,\"reason\":\"Took a booster off the shelf without paying\"}")"
[ "$P6_ADJUST_STATUS" = "200" ] || fail "adjusting points returned $P6_ADJUST_STATUS: $(cat "$TMP_DIR/p6-adjust.json")"
[ "$(jval balance <"$TMP_DIR/p6-adjust.json")" = "$((P6_ADJUST_BALANCE - 100))" ] \
  || fail "the adjustment reports a balance of '$(jval balance <"$TMP_DIR/p6-adjust.json")', expected $((P6_ADJUST_BALANCE - 100))"
P6_ADJUST_NOTE="$(curl -s -G -H "Authorization: $STAFF_TOKEN" \
  --data-urlencode "filter=target_collection='customers' && target_record='$P6_SHOPPER_ID'" --data-urlencode "sort=-created" \
  "$BASE/api/collections/notes/records" | jval "items.0.body")"
[ "$P6_ADJUST_NOTE" = "Took a booster off the shelf without paying" ] \
  || fail "the adjustment's reason is not on the customer's notes: '$P6_ADJUST_NOTE'"
P6_ADJUST_AUDIT="$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=action='points_adjust'" \
  "$BASE/api/collections/audit_log/records")"
[ "$(echo "$P6_ADJUST_AUDIT" | jval totalItems)" = "1" ] || fail "adjusting points wrote no audit row"
echo "$P6_ADJUST_AUDIT" | grep -q "Took a booster" \
  && fail "the audit row carries the reason text; audit_log holds identifiers and figures only"
ok "an admin adjustment writes the ledger row, the reason as a note and an audit row of figures alone"

# --- 24h. The loyalty config the evaluators have to be able to read -----
p6_refusal() {
  # $1 collection, $2 json body -> "<status> <message>"
  local out status
  out="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/collections/$1/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$2")"
  status="$(echo "$out" | tail -n1)"
  printf '%s %s' "$status" "$(echo "$out" | head -n -1 | jval message)"
}
P6_RULE_BAD_KEY="$(p6_refusal loyalty_rules '{"name":"P6 Bad key","type":"multiplier","value":2,"active":true,"conditions":{"kind":["sealed"]}}')"
case "$P6_RULE_BAD_KEY" in
  '400 Conditions has no "kind" setting.'*) : ;;
  *) fail "a rule with an unknown conditions key gave: $P6_RULE_BAD_KEY" ;;
esac
P6_RULE_BAD_VALUE="$(p6_refusal loyalty_rules '{"name":"P6 Zero","type":"fixed_bonus","value":0,"active":true,"conditions":{}}')"
case "$P6_RULE_BAD_VALUE" in 400*) : ;; *) fail "a rule worth 0 points gave: $P6_RULE_BAD_VALUE" ;; esac
P6_RULE_BIG="$(p6_refusal loyalty_rules '{"name":"P6 Huge","type":"multiplier","value":12,"active":true,"conditions":{}}')"
case "$P6_RULE_BIG" in 400*) : ;; *) fail "a 12x multiplier gave: $P6_RULE_BIG" ;; esac
P6_RULE_OK="$(p6_refusal loyalty_rules '{"name":"P6 Good rule","type":"multiplier","value":2,"active":false,"conditions":{"kinds":["sealed"],"minSpend":3000}}')"
case "$P6_RULE_OK" in 200*) : ;; *) fail "a well-formed rule was refused: $P6_RULE_OK" ;; esac
ok "a loyalty rule the shared evaluator could not read is refused, naming the key; a well-formed one saves"

P6_TIER_BAD_PERK="$(p6_refusal loyalty_tiers '{"name":"P6 Bad perk","threshold_points":7777,"sort":50,"perks":[{"type":"free_event_entries","value":2,"per_month":true}]}')"
case "$P6_TIER_BAD_PERK" in '400 Perk 1 is not a perk this app knows.'*) : ;; *) fail "a tier with an unparseable perk gave: $P6_TIER_BAD_PERK" ;; esac
P6_TIER_CLASH="$(p6_refusal loyalty_tiers '{"name":"P6 Clash","threshold_points":2500,"sort":60,"perks":[]}')"
case "$P6_TIER_CLASH" in '400 Regular already starts at 2500 points.'*) : ;; *) fail "a second tier at the Regular threshold gave: $P6_TIER_CLASH" ;; esac
P6_TIER_IN_USE="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Legend'" \
  "$BASE/api/collections/loyalty_tiers/records" | jval "items.0.id")"
P6_TIER_DELETE="$(curl -s -o "$TMP_DIR/p6-tier-delete.json" -w '%{http_code}' -X DELETE \
  "$BASE/api/collections/loyalty_tiers/records/$P6_TIER_IN_USE" -H "Authorization: $STAFF_TOKEN")"
[ "$P6_TIER_DELETE" = "409" ] || fail "deleting a tier a customer is on returned $P6_TIER_DELETE, expected 409"
grep -q "is a customer's current tier" "$TMP_DIR/p6-tier-delete.json" \
  || fail "the in-use tier refusal does not say why: $(cat "$TMP_DIR/p6-tier-delete.json")"
ok "a tier's perks have to parse, thresholds stay distinct, and a tier somebody is on cannot be deleted (409)"

P6_REWARD_BAD="$(p6_refusal loyalty_rewards '{"name":"P6 Worthless","type":"money_off","value":0,"cost_points":100,"active":true}')"
case "$P6_REWARD_BAD" in 400*) : ;; *) fail "a money-off reward worth nothing gave: $P6_REWARD_BAD" ;; esac
P6_PROGRAMME_ID="$(curl -s "$BASE/api/collections/loyalty_programme/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
P6_PROGRAMME_BAD="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/collections/loyalty_programme/records/$P6_PROGRAMME_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"points_per_pound_redemption":0}')"
[ "$P6_PROGRAMME_BAD" = "400" ] || fail "a programme with 0 points per pound returned $P6_PROGRAMME_BAD, expected 400"
ok "a money-off reward worth nothing and a programme that divides by zero are both refused"

# --- 24i. The customer-facing display ----------------------------------
P6_DISPLAY_PII="$(curl -s -o "$TMP_DIR/p6-display-pii.json" -w '%{http_code}' -X POST "$BASE/api/vault/display" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"sale","payload":{"lines":[{"title":"Booster","detail":"Sealed","qty":1,"unit_price":499}],"subtotal":499,"discount":0,"total":499,"points_to_earn":40,"customer_email":"someone@local.test"}}')"
[ "$P6_DISPLAY_PII" = "400" ] || fail "publishing a payload carrying an email returned $P6_DISPLAY_PII, expected 400"
grep -q "The customer display never shows" "$TMP_DIR/p6-display-pii.json" \
  || fail "the display refusal does not say what it will not show: $(cat "$TMP_DIR/p6-display-pii.json")"
P6_DISPLAY_ID_FIELD="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/display" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"sale","payload":{"lines":[{"title":"Booster","detail":"Sealed","qty":1,"unit_price":499,"item_id":"abc"}],"subtotal":499,"discount":0,"total":499,"points_to_earn":40}}')"
[ "$P6_DISPLAY_ID_FIELD" = "400" ] || fail "publishing a payload carrying an id returned $P6_DISPLAY_ID_FIELD, expected 400"
ok "the display refuses a payload carrying an email or an identifier (400)"

P6_DISPLAY_SALE="$(curl -s -o "$TMP_DIR/p6-display-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/display" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"sale","payload":{"lines":[{"title":"Booster","detail":"Sealed","qty":1,"unit_price":499,"margin":120}],"subtotal":499,"discount":0,"total":499,"points_to_earn":40,"customer_name":"Sam","till_float":9999}}')"
[ "$P6_DISPLAY_SALE" = "200" ] || fail "publishing a sale to the display returned $P6_DISPLAY_SALE: $(cat "$TMP_DIR/p6-display-sale.json")"
P6_DISPLAY_TOKEN="$(jval token <"$TMP_DIR/p6-display-sale.json")"
[ -n "$P6_DISPLAY_TOKEN" ] || fail "publishing to the display returned no token"
P6_DISPLAY_ROW="$(curl -s "$BASE/api/collections/display_state/records?perPage=1" -H "Authorization: $STAFF_TOKEN")"
P6_DISPLAY_ROW_ID="$(echo "$P6_DISPLAY_ROW" | jval "items.0.id")"
[ "$(echo "$P6_DISPLAY_ROW" | jval totalItems)" = "1" ] || fail "display_state holds more than the one row"
[ "$(echo "$P6_DISPLAY_ROW" | jval "items.0.mode")" = "sale" ] || fail "the display row is not in sale mode"
echo "$P6_DISPLAY_ROW" | grep -q "till_float" && fail "the display kept a payload key the contract does not name"
echo "$P6_DISPLAY_ROW" | grep -q '"margin"' && fail "the display kept a line key the contract does not name"
echo "$P6_DISPLAY_ROW" | grep -q "Sam" || fail "the display dropped the customer's first name: $P6_DISPLAY_ROW"
[ "$(p6_count audit_log "action='display_publish'")" -ge 1 ] || fail "publishing to the display wrote no audit row"
ok "a published sale keeps only the keys the contract names, and is audited"

P6_DISPLAY_ACCEPT_SALE="$(curl -s -o "$TMP_DIR/p6-accept-sale.json" -w '%{http_code}' -X POST "$BASE/api/vault/display/accept" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"token\":\"$P6_DISPLAY_TOKEN\"}")"
[ "$P6_DISPLAY_ACCEPT_SALE" = "409" ] || fail "accepting a sale on the display returned $P6_DISPLAY_ACCEPT_SALE, expected 409"

P6_DISPLAY_BUYIN="$(curl -s -o "$TMP_DIR/p6-display-buyin.json" -w '%{http_code}' -X POST "$BASE/api/vault/display" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"buy_in","payload":{"lines":[{"title":"Zelda","detail":"SNES, boxed","qty":1,"offer_price":4500}],"total_market":9000,"total_offer":4500,"payout_type":"credit","customer_name":"Sam","credit_bonus_points":225}}')"
[ "$P6_DISPLAY_BUYIN" = "200" ] || fail "publishing a buy-in offer returned $P6_DISPLAY_BUYIN: $(cat "$TMP_DIR/p6-display-buyin.json")"
P6_BUYIN_TOKEN="$(jval token <"$TMP_DIR/p6-display-buyin.json")"
P6_ACCEPT_STALE_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/display/accept" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"token\":\"$P6_DISPLAY_TOKEN\"}")"
[ "$P6_ACCEPT_STALE_TOKEN" = "409" ] || fail "accepting with the previous publish's token returned $P6_ACCEPT_STALE_TOKEN, expected 409"
P6_ACCEPT_STATUS="$(curl -s -o "$TMP_DIR/p6-accept.json" -w '%{http_code}' -X POST "$BASE/api/vault/display/accept" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"token\":\"$P6_BUYIN_TOKEN\"}")"
[ "$P6_ACCEPT_STATUS" = "200" ] || fail "accepting the live offer returned $P6_ACCEPT_STATUS: $(cat "$TMP_DIR/p6-accept.json")"
[ -n "$(jval accepted_at <"$TMP_DIR/p6-accept.json")" ] || fail "accepting the offer stamped no time on it"
[ -n "$(curl -s "$BASE/api/collections/display_state/records/$P6_DISPLAY_ROW_ID" -H "Authorization: $STAFF_TOKEN" | jval customer_accepted_at)" ] \
  || fail "the accepted offer is not stamped on the display row the wizard subscribes to"
[ "$(p6_count audit_log "action='display_accept'")" = "1" ] || fail "accepting an offer wrote no audit row"
ok "only the live publish's own token accepts a buy-in offer, and the accept lands on the row the wizard watches"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/display_state/records/$P6_DISPLAY_ROW_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"expires_at\":\"$(p6_ago 0 1)\",\"customer_accepted_at\":\"\"}"
P6_ACCEPT_EXPIRED="$(curl -s -o "$TMP_DIR/p6-accept-expired.json" -w '%{http_code}' -X POST "$BASE/api/vault/display/accept" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"token\":\"$P6_BUYIN_TOKEN\"}")"
[ "$P6_ACCEPT_EXPIRED" = "409" ] || fail "accepting an offer published over fifteen minutes ago returned $P6_ACCEPT_EXPIRED, expected 409"
P6_DISPLAY_AFTER_EXPIRY="$(curl -s "$BASE/api/collections/display_state/records/$P6_DISPLAY_ROW_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P6_DISPLAY_AFTER_EXPIRY" | jval mode)" = "idle" ] \
  || fail "a publish past its fifteen minutes stayed on screen as '$(echo "$P6_DISPLAY_AFTER_EXPIRY" | jval mode)'"
[ "$(echo "$P6_DISPLAY_AFTER_EXPIRY" | jval token)" = "" ] || fail "a cleared display kept its token"
ok "a publish nobody dealt with inside fifteen minutes clears itself and can no longer be accepted"

curl -s -o /dev/null -X POST "$BASE/api/vault/display" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"sale","payload":{"lines":[],"subtotal":0,"discount":0,"total":0,"points_to_earn":0}}'
P6_CLEAR_STATUS="$(curl -s -o "$TMP_DIR/p6-clear.json" -w '%{http_code}' -X POST "$BASE/api/vault/display/clear" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{}')"
[ "$P6_CLEAR_STATUS" = "200" ] || fail "clearing the display returned $P6_CLEAR_STATUS: $(cat "$TMP_DIR/p6-clear.json")"
P6_DISPLAY_IDLE="$(curl -s "$BASE/api/collections/display_state/records/$P6_DISPLAY_ROW_ID" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P6_DISPLAY_IDLE" | jval mode)" = "idle" ] || fail "the cleared display is not idle"
[ "$(p6_count audit_log "action='display_clear'")" = "1" ] || fail "clearing the display wrote no audit row"
ok "clearing the display puts it back to idle and is audited"

P6_DISPLAY_LIST_CUSTOMER="$(curl -s "$BASE/api/collections/display_state/records" -H "Authorization: $P6_SHOPPER_TOKEN" | jval totalItems)"
[ "${P6_DISPLAY_LIST_CUSTOMER:-0}" = "0" ] || fail "a customer token listed $P6_DISPLAY_LIST_CUSTOMER display_state rows, expected none"
P6_DISPLAY_VIEW_CUSTOMER="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/display_state/records/$P6_DISPLAY_ROW_ID" -H "Authorization: $P6_SHOPPER_TOKEN")"
[ "$P6_DISPLAY_VIEW_CUSTOMER" = "404" ] || [ "$P6_DISPLAY_VIEW_CUSTOMER" = "403" ] \
  || fail "a customer token reading the display row returned $P6_DISPLAY_VIEW_CUSTOMER, expected 403 or 404"
P6_DISPLAY_PUBLISH_CUSTOMER="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/display" \
  -H "Authorization: $P6_SHOPPER_TOKEN" -H "Content-Type: application/json" -d '{"mode":"idle","payload":{}}')"
[ "$P6_DISPLAY_PUBLISH_CUSTOMER" = "403" ] || fail "a customer token publishing to the display returned $P6_DISPLAY_PUBLISH_CUSTOMER, expected 403"
for P6_CLOSED in perk_usage memberships referrals; do
  P6_CLOSED_COUNT="$(curl -s "$BASE/api/collections/$P6_CLOSED/records" -H "Authorization: $P6_SHOPPER_TOKEN" | jval totalItems)"
  [ "${P6_CLOSED_COUNT:-0}" = "0" ] || fail "a customer token listed $P6_CLOSED_COUNT $P6_CLOSED rows, expected none"
done
ok "a customer token can neither read nor write display_state, perk_usage, memberships or referrals"

P6_CONFIG_JSON="$(curl -s "$BASE/api/vault/config" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$P6_CONFIG_JSON" | jval "settings.display.signup_url")" = "/estimate" ] \
  || fail "GET /api/vault/config does not carry settings.display: $(echo "$P6_CONFIG_JSON" | jval "settings.display.signup_url")"
[ "$(echo "$P6_CONFIG_JSON" | jval "settings.display.enabled")" = "false" ] \
  || fail "settings.display is seeded on; a shop with no tablet should see nothing change"
[ "$(echo "$P6_CONFIG_JSON" | jval "settings.rewards.voucher_days")" = "90" ] \
  || fail "GET /api/vault/config does not carry settings.rewards.voucher_days"
ok "the counter reads settings.display and settings.rewards through /api/vault/config"

# --- 24j. The portal's own Guild pages ---------------------------------
P6_GUILD_JSON="$(curl -s "$BASE/api/vault/me/guild" -H "Authorization: $P6_SHOPPER_TOKEN")"
[ "$(echo "$P6_GUILD_JSON" | jval "points_name")" = "GG Points" ] || fail "GET /me/guild does not name the points: $P6_GUILD_JSON"
[ "$(echo "$P6_GUILD_JSON" | jval "tier.name")" = "Member" ] || fail "GET /me/guild reports tier '$(echo "$P6_GUILD_JSON" | jval "tier.name")', expected Member"
[ "$(echo "$P6_GUILD_JSON" | jval "next.name")" = "Regular" ] || fail "GET /me/guild does not name the next tier"
[ "$(echo "$P6_GUILD_JSON" | jval "referral.code")" != "" ] || fail "GET /me/guild does not carry the customer's own referral code"
[ "$(echo "$P6_GUILD_JSON" | jval "referral.bonus_referrer")" = "250" ] || fail "GET /me/guild does not carry the referral bonus"
[ "$(echo "$P6_GUILD_JSON" | jval "vouchers_open")" -ge 0 ] || fail "GET /me/guild does not count open vouchers"
P6_REFERRER_TOKEN="$(p5_impersonate "$P6_REFERRER_ID")"
P6_REFERRER_GUILD="$(curl -s "$BASE/api/vault/me/guild" -H "Authorization: $P6_REFERRER_TOKEN")"
[ "$(echo "$P6_REFERRER_GUILD" | jval "referral.earned")" = "1" ] \
  || fail "the referrer's guild page counts '$(echo "$P6_REFERRER_GUILD" | jval "referral.earned")' earned referrals, expected 1"
ok "GET /api/vault/me/guild reports the tier, the next one, the wallet and the customer's own referral figures"

P6_POINTS_JSON="$(curl -s "$BASE/api/vault/me/points" -H "Authorization: $P6_REFERRER_TOKEN")"
[ "$(echo "$P6_POINTS_JSON" | jlen rows)" -ge 3 ] || fail "GET /me/points returned $(echo "$P6_POINTS_JSON" | jlen rows) rows for a customer with several"
echo "$P6_POINTS_JSON" | grep -q "Welcome bonus" || fail "GET /me/points does not explain the welcome row: $P6_POINTS_JSON"
echo "$P6_POINTS_JSON" | grep -q "Referral bonus" || fail "GET /me/points does not explain the referral row: $P6_POINTS_JSON"
P6_REFEREE_TOKEN="$(p5_impersonate "$P6_REFEREE_ID")"
P6_SALE_NOTES="$(curl -s "$BASE/api/vault/me/points" -H "Authorization: $P6_REFEREE_TOKEN" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const rows = (JSON.parse(d || "{}").rows) || [];
    process.stdout.write(rows.filter((r) => r.reason === "earn_sale").map((r) => r.note).join(" | "));
  });
')"
echo "$P6_SALE_NOTES" | grep -qF "Earned on a £20.00 sale" \
  || fail "GET /me/points explains the referee's sale rows as '$P6_SALE_NOTES', expected one of them to read 'Earned on a £20.00 sale'"
P6_POINTS_ANON="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/me/points")"
[ "$P6_POINTS_ANON" = "401" ] || fail "GET /me/points without a token returned $P6_POINTS_ANON, expected 401"
ok "GET /api/vault/me/points explains every row in a sentence, money included"

kill "$BACKDATE_PID" 2>/dev/null || true
wait "$BACKDATE_PID" 2>/dev/null || true
BACKDATE_PID=""

echo
echo "All checks passed ($PASS_COUNT)."
