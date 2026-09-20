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
  [ -n "$KEYLESS_DIR" ] && rm -rf "$KEYLESS_DIR"
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

GG_ID_PHOTO_KEY="$ID_PHOTO_KEY" "$PB" serve \
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
KEYLESS_ENC="$(find "$KEYLESS_DIR/storage" -name '*.enc' -type f 2>/dev/null | head -n1)"
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
PART_ROWS="$(grep -c "^$PART_SKU," "$TMP_DIR/stockbook2.csv" || true)"
[ "$PART_ROWS" = "2" ] || fail "a box of 3 with 1 sold produced $PART_ROWS stock book rows, expected 2 (one sold, one remaining)"
grep "^$PART_SKU," "$TMP_DIR/stockbook2.csv" | grep -q ',4\.00,.*,10\.00,6\.00$' \
  || fail "no sold row of 4.00 cost / 10.00 sale / 6.00 margin for $PART_SKU: $(grep "^$PART_SKU," "$TMP_DIR/stockbook2.csv")"
grep "^$PART_SKU," "$TMP_DIR/stockbook2.csv" | grep -q ',8\.00,,,,$' \
  || fail "no remaining row of 8.00 cost with blank sale columns for $PART_SKU: $(grep "^$PART_SKU," "$TMP_DIR/stockbook2.csv")"
ok "the stock book writes one row per sale line plus one for the remaining stock"

# The refunded cash-sale item sold nothing in the end, so it is back to a
# single remaining row rather than a sold one.
CASH_SKU="$(curl -s "$BASE/api/collections/items/records/$CASH_ITEM" -H "Authorization: $STAFF_TOKEN" | jval sku)"
CASH_ROWS="$(grep -c "^$CASH_SKU," "$TMP_DIR/stockbook2.csv" || true)"
[ "$CASH_ROWS" = "1" ] || fail "the fully refunded item produced $CASH_ROWS stock book rows, expected 1"
grep "^$CASH_SKU," "$TMP_DIR/stockbook2.csv" | grep -q ',6\.00,,,,$' \
  || fail "the fully refunded item's row is not a remaining row: $(grep "^$CASH_SKU," "$TMP_DIR/stockbook2.csv")"
ok "a fully refunded sale line leaves no sold row in the stock book"

echo
echo "All checks passed ($PASS_COUNT)."
