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
[ "$SALE_POINTS_BALANCE" = "325" ] || fail "points balance after the sale is '$SALE_POINTS_BALANCE', expected 325"
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
[ "$(jval points_balance <"$TMP_DIR/refund.json")" = "125" ] || fail "points after the refund is '$(jval points_balance <"$TMP_DIR/refund.json")', expected 125"
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
[ "$(jval points_balance <"$TMP_DIR/points-sale.json")" = "1650" ] \
  || fail "the points balance after the redemption is '$(jval points_balance <"$TMP_DIR/points-sale.json")', expected 1650"
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
for MOVED_KEY in trade_ins credit_ledger points_ledger notifications push_subscriptions; do
  [ "$(jval "moved.$MOVED_KEY" <"$TMP_DIR/merge.json")" = "1" ] \
    || fail "the merge moved '$(jval "moved.$MOVED_KEY" <"$TMP_DIR/merge.json")' $MOVED_KEY rows, expected 1"
done
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
[ "$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.points_balance")" = "300" ] \
  || fail "the kept customer's points balance is '$(echo "$KEEP_PRIVATE_JSON" | jval "items.0.points_balance")', expected 300"
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
  for (const s of sales) {
    // Blank payment (an eBay-import sale: eBay took the money) is its own
    // "none" bucket, never folded into "mixed" - see lib/reports/daily.js.
    const m = s.payment === "" ? "none" : Object.prototype.hasOwnProperty.call(byPayment, s.payment) ? s.payment : "mixed";
    byPayment[m] += s.total;
    salesTotal += s.total;
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
    byPayment,
    itemsOut,
    buyInCount: tradeIns.length,
    buyInCash: cash,
    buyInCredit: credit,
  }));
' "$TMP_DIR/stats-today-sales.json" "$TMP_DIR/stats-today-lines.json" "$TMP_DIR/stats-today-tradeins.json")"

EXPECTED_SALES_TOTAL="$(echo "$EXPECTED_JSON" | jval salesTotal)"
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

# --- 21d. reports/sales and reports/buyins agree with the same numbers --
REPORT_SALES_JSON="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/reports/sales?from=$TODAY&to=$TODAY")"
[ "$(echo "$REPORT_SALES_JSON" | jval "totals.revenue")" = "$EXPECTED_SALES_TOTAL" ] \
  || fail "reports/sales totals.revenue is '$(echo "$REPORT_SALES_JSON" | jval "totals.revenue")', expected $EXPECTED_SALES_TOTAL"
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

# An ordinary counter sale (sales.pb.js, untouched this round) still gets
# channel defaulted to "counter" by imports.pb.js's own onRecordCreate hook.
CHANNEL_ITEM_ID="$(make_item "Channel Default Item" 1 200 650)"
CHANNEL_SALE_JSON="$(curl -s -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"item\":\"$CHANNEL_ITEM_ID\",\"qty\":1,\"unit_price\":650,\"discount\":0}],\"payment\":\"sumup_card\"}")"
CHANNEL_SALE_ID="$(echo "$CHANNEL_SALE_JSON" | jval "sale.id")"
[ -n "$CHANNEL_SALE_ID" ] || fail "could not create the channel-default check's sale"
CHANNEL_ON_SALE="$(curl -s "$BASE/api/collections/sales/records/$CHANNEL_SALE_ID" -H "Authorization: $STAFF_TOKEN" | jval channel)"
[ "$CHANNEL_ON_SALE" = "counter" ] || fail "an ordinary counter sale's channel is '$CHANNEL_ON_SALE', expected counter"
ok "an ordinary counter sale defaults channel to counter"

# --- 22h. The SumUp pull: matches by SKU prefix and by amount+time, a
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

PULL_NONADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/sumup/pull" -H "Authorization: $PLAIN_TOKEN")"
[ "$PULL_NONADMIN_STATUS" = "403" ] || fail "a non-admin calling sumup/pull got $PULL_NONADMIN_STATUS, expected 403"
ok "a non-admin cannot pull SumUp transactions (403)"

PULL1_JSON="$(curl -s -X POST "$BASE/api/vault/sumup/pull" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$PULL1_JSON" | jval fetched)" = "2" ] || fail "the first SumUp pull's fetched count is wrong: $PULL1_JSON"
[ "$(echo "$PULL1_JSON" | jval matched)" = "2" ] || fail "the first SumUp pull's matched count is wrong: $PULL1_JSON"
[ "$(echo "$PULL1_JSON" | jval unmatched)" = "0" ] || fail "the first SumUp pull's unmatched count is wrong: $PULL1_JSON"

SKU_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-sku-0001%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SKU_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-sku-0001 was not upserted exactly once: $SKU_TXN_JSON"
[ "$(echo "$SKU_TXN_JSON" | jval "items.0.matched_sale")" = "$SUMUP_SKU_SALE_ID" ] || fail "txn-sku-0001 did not match the SKU-named sale: $SKU_TXN_JSON"
ok "the SumUp pull matches a sale by a SKU-prefixed product name"

AMOUNT_TXN_JSON="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-amount-0002%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$AMOUNT_TXN_JSON" | jval totalItems)" = "1" ] || fail "txn-amount-0002 was not upserted exactly once: $AMOUNT_TXN_JSON"
[ "$(echo "$AMOUNT_TXN_JSON" | jval "items.0.matched_sale")" = "$SUMUP_AMOUNT_SALE_ID" ] || fail "txn-amount-0002 did not match the amount+time sale: $AMOUNT_TXN_JSON"
ok "the SumUp pull matches a sale by amount and time when the product name carries no SKU"

PULL2_CRON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/sumup_pull" -H "Authorization: $SUPER_TOKEN")"
[ "$PULL2_CRON_STATUS" = "204" ] || fail "POST /api/crons/sumup_pull returned $PULL2_CRON_STATUS, expected 204"

SKU_TXN_AFTER2="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-sku-0001%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$SKU_TXN_AFTER2" | jval totalItems)" = "1" ] || fail "a second pull duplicated txn-sku-0001: $SKU_TXN_AFTER2"
AMOUNT_TXN_AFTER2="$(curl -s "$BASE/api/collections/sumup_transactions/records?filter=sumup_id%3D%22txn-amount-0002%22" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$AMOUNT_TXN_AFTER2" | jval totalItems)" = "1" ] || fail "a second pull duplicated txn-amount-0002: $AMOUNT_TXN_AFTER2"
[ "$(echo "$AMOUNT_TXN_AFTER2" | jval "items.0.matched_sale")" = "$SUMUP_AMOUNT_SALE_ID" ] || fail "a second pull changed txn-amount-0002's match: $AMOUNT_TXN_AFTER2"
ok "a second pull (run here as the sumup_pull cron) upserts in place and does not duplicate or re-match"

RECONCILE_JSON="$(curl -s "$BASE/api/vault/sumup/reconcile?date=$TODAY" -H "Authorization: $STAFF_TOKEN")"
RECONCILE_HAS_AMOUNT_MATCH="$(echo "$RECONCILE_JSON" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    let body;
    try { body = JSON.parse(d); } catch (e) { body = {}; }
    const saleId = process.argv[1];
    const found = (body.matched || []).some((m) => m.sale && m.sale.id === saleId);
    process.stdout.write(found ? "yes" : "no");
  });
' "$SUMUP_AMOUNT_SALE_ID")"
[ "$RECONCILE_HAS_AMOUNT_MATCH" = "yes" ] || fail "reconcile did not list the amount-matched sale as matched: $RECONCILE_JSON"

RECONCILE_HAS_UNMATCHED_SALE="$(echo "$RECONCILE_JSON" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    let body;
    try { body = JSON.parse(d); } catch (e) { body = {}; }
    const saleId = process.argv[1];
    const found = (body.unmatched_sales || []).some((s) => s.id === saleId);
    process.stdout.write(found ? "yes" : "no");
  });
' "$SUMUP_UNMATCHED_SALE_ID")"
[ "$RECONCILE_HAS_UNMATCHED_SALE" = "yes" ] || fail "reconcile did not list the unmatched card sale: $RECONCILE_JSON"
[ -n "$(echo "$RECONCILE_JSON" | jval "totals.sales")" ] || fail "reconcile's totals.sales is missing: $RECONCILE_JSON"
[ -n "$(echo "$RECONCILE_JSON" | jval "totals.sumup")" ] || fail "reconcile's totals.sumup is missing: $RECONCILE_JSON"
ok "reconcile returns the day's matched and unmatched lists with totals"

RECONCILE_PLAIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $PLAIN_TOKEN" "$BASE/api/vault/sumup/reconcile?date=$TODAY")"
[ "$RECONCILE_PLAIN_STATUS" = "200" ] || fail "a non-admin staff member calling reconcile got $RECONCILE_PLAIN_STATUS, expected 200"
ok "reconcile is available to any staff member, unlike the admin-only pull"

echo
echo "All checks passed ($PASS_COUNT)."
