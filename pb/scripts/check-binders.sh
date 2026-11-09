#!/usr/bin/env bash
# Binder checks for GG Vault (feat/binders-v2).
#
# Starts a throwaway PocketBase with the repo's hooks and migrations, then
# proves through plain HTTP, as a real client would:
#   - a customer token cannot read or change another customer's binder,
#     pockets, share link or wanted requests;
#   - share and customer responses carry no price field;
#   - the share view is read only, needs the exact token and stops working
#     when the link is switched off;
#   - layout batches refuse two cards in one pocket;
#   - a wanted request is one open row per customer per card, cancellable,
#     and the staff list counts it while customers cannot reach that list;
#   - a Pokedex binder for one generation has a sprite in every pocket;
#   - "In stock at GG": availability flags only needed pockets holding the
#     exact print (never a Japanese item on an English pocket), leaks no
#     qty, price or SKU, follows the item's status, shows on the share
#     view, and one stock arrival writes at most one alert per customer,
#     honouring the per-binder alerts switch.
# Also runs the pure helper tests in binders_lib.test.cjs and
# binders_stock.test.cjs.
#
# Uses made-up names only. Requires pb/pocketbase, curl and node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PB="$ROOT/pb/pocketbase"
TMP_DIR="$(mktemp -d)"
PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
BASE="http://127.0.0.1:$PORT"
SUPER_EMAIL="binders-check@local.test"
SUPER_PASSWORD="binderscheckpassword123"
SERVER_PID=""
PASS_COUNT=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; if [ -f "$TMP_DIR/server.log" ]; then echo "--- server.log (tail) ---" >&2; tail -n 30 "$TMP_DIR/server.log" >&2; fi; exit 1; }
ok() { PASS_COUNT=$((PASS_COUNT + 1)); echo "OK: $1"; }

jval() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      let v;
      try { v = JSON.parse(d || "{}"); } catch (e) { v = null; }
      for (const key of process.argv[1].split(".")) { if (v == null) break; v = v[key]; }
      process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    });
  ' "$1"
}

# Exits non-zero if any key anywhere in the JSON on stdin looks like money.
no_price_keys() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const re = /(pric|cost|value|market|pence|amount|gbp|eur|usd|tcgplayer|cardmarket|offer|payout|margin)/i;
      const bad = [];
      const walk = (v, path) => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + "." + i));
        else if (v && typeof v === "object") for (const k of Object.keys(v)) { if (re.test(k)) bad.push(path + "." + k); walk(v[k], path + "." + k); }
      };
      walk(JSON.parse(d), "$");
      if (bad.length) { console.error(bad.join(", ")); process.exit(1); }
    });
  '
}

# curl wrapper: req METHOD URL TOKEN [BODY] -> writes body to $TMP_DIR/out.json, prints status
req() {
  local method="$1" url="$2" token="${3:-}" body="${4:-}"
  local args=(-s -o "$TMP_DIR/out.json" -w '%{http_code}' -X "$method" "$BASE$url")
  if [ -n "$token" ]; then args+=(-H "Authorization: $token"); fi
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  curl "${args[@]}"
}
out() { cat "$TMP_DIR/out.json"; }

echo "== pure helper tests"
node --test "$ROOT/pb/scripts/binders_lib.test.cjs" >/dev/null || fail "binders_lib.test.cjs failed (run node --test pb/scripts/binders_lib.test.cjs)"
ok "binders_v2.js helper tests pass"
node --test "$ROOT/pb/scripts/binders_stock.test.cjs" >/dev/null || fail "binders_stock.test.cjs failed (run node --test pb/scripts/binders_stock.test.cjs)"
ok "binders_stock.js matching tests pass"

[ -x "$PB" ] || fail "pb/pocketbase not found - see pb/scripts/dev.sh"
"$PB" --dir "$TMP_DIR" superuser upsert "$SUPER_EMAIL" "$SUPER_PASSWORD" >/dev/null
GG_ADAPTER_TRANSPORT_MODE="fixture" "$PB" serve --dir "$TMP_DIR" --hooksDir "$ROOT/pb/pb_hooks" --hooksWatch=false \
  --migrationsDir "$ROOT/pb/pb_migrations" --http "127.0.0.1:$PORT" >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 150); do
  if curl -s -o /dev/null "$BASE/api/health"; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited before becoming healthy"
  sleep 0.2
done
curl -s -o /dev/null "$BASE/api/health" || fail "server never became healthy"
ok "server healthy with the v2 migration applied"

SUPER="$(curl -s -X POST "$BASE/api/collections/_superusers/auth-with-password" -H "Content-Type: application/json" \
  -d "{\"identity\":\"$SUPER_EMAIL\",\"password\":\"$SUPER_PASSWORD\"}" | jval token)"
[ -n "$SUPER" ] || fail "no superuser token"

# Schema: rules on the new collection.
[ "$(req GET /api/collections/binder_wanted "$SUPER")" = "200" ] || fail "binder_wanted collection missing"
for rule in createRule updateRule deleteRule; do
  [ "$(out | jval "$rule")" = "" ] || fail "binder_wanted.$rule should be null (routes only), got '$(out | jval "$rule")'"
done
ok "binder_wanted exists and is written through the routes only"

# Staff and two customers (made-up names, no real data).
[ "$(req POST /api/collections/staff/records "$SUPER" '{"email":"binders-staff@local.test","password":"bindersstaffpass123","passwordConfirm":"bindersstaffpass123","name":"Binder Staff","role":"staff","active":true}')" = "200" ] \
  || fail "could not create staff: $(out)"
STAFF="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" -H "Content-Type: application/json" \
  -d '{"identity":"binders-staff@local.test","password":"bindersstaffpass123"}' | jval token)"
[ -n "$STAFF" ] || fail "no staff token"

mkcustomer() {
  local name="$1" email="$2"
  local id
  id="$(curl -s -X POST "$BASE/api/collections/customers/records" -H "Authorization: $SUPER" -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"email\":\"$email\",\"source\":\"counter\"}" | jval id)"
  [ -n "$id" ] || fail "could not create customer $name"
  curl -s -X POST "$BASE/api/collections/customers/impersonate/$id" -H "Authorization: $SUPER" -H "Content-Type: application/json" -d '{}' | jval token
}
ALICE="$(mkcustomer "Test Customer A" "binders-a@local.test")"
BOB="$(mkcustomer "Test Customer B" "binders-b@local.test")"
[ -n "$ALICE" ] && [ -n "$BOB" ] || fail "could not impersonate the test customers"
ok "staff and two customers ready"

# A binder for customer A, filled with made-up pockets through the superuser.
[ "$(req POST /api/vault/binders "$ALICE" '{"kind":"custom","name":"Check binder","grid":"2x2","color":"pop"}')" = "200" ] || fail "create binder: $(out)"
BID="$(out | jval id)"
[ "$(req GET "/api/collections/binders/records/$BID" "$ALICE")" = "200" ] || fail "owner cannot read own binder"
[ "$(out | jval grid)" = "2x2" ] || fail "grid not stored: $(out)"
[ "$(out | jval min_slots)" = "4" ] || fail "an empty binder should start with one page of pockets: $(out)"
out | no_price_keys || fail "customer binder response carries a price-like key"
ok "customer A made a 2x2 binder and reads it with no price fields"

P=()
for i in 0 1 2; do
  [ "$(req POST /api/collections/binder_cards/records "$SUPER" "{\"binder\":\"$BID\",\"card_id\":\"chk-$i\",\"name\":\"Check Card $i\",\"number\":\"$((i + 1))\",\"set_id\":\"chk\",\"set_name\":\"Check Set\",\"set_total\":\"3\",\"slot\":$i,\"sort\":$((i * 10)),\"owned\":false}")" = "200" ] \
    || fail "seed pocket $i: $(out)"
  P+=("$(out | jval id)")
done
[ "$(req GET "/api/collections/binder_cards/records?filter=binder%3D%22$BID%22" "$ALICE")" = "200" ] || fail "owner list pockets"
[ "$(out | jval totalItems)" = "3" ] || fail "owner should see 3 pockets: $(out)"
out | no_price_keys || fail "customer pocket list carries a price-like key"
ok "customer A lists their pockets with no price fields"

# Customer B cannot see or touch any of it.
[ "$(req GET "/api/collections/binders/records/$BID" "$BOB")" = "404" ] || fail "B read A's binder"
[ "$(req GET "/api/collections/binders/records" "$BOB")" = "200" ] && [ "$(out | jval totalItems)" = "0" ] || fail "B's binder list is not empty: $(out)"
[ "$(req GET "/api/collections/binder_cards/records?filter=binder%3D%22$BID%22" "$BOB")" = "200" ] && [ "$(out | jval totalItems)" = "0" ] || fail "B listed A's pockets: $(out)"
[ "$(req GET "/api/collections/binder_cards/records/${P[0]}" "$BOB")" = "404" ] || fail "B read A's pocket"
[ "$(req PATCH "/api/collections/binder_cards/records/${P[0]}" "$BOB" '{"owned":true}')" = "404" ] || fail "B ticked A's pocket"
[ "$(req PATCH "/api/collections/binders/records/$BID" "$BOB" '{"name":"Taken"}')" = "404" ] || fail "B renamed A's binder"
[ "$(req DELETE "/api/collections/binders/records/$BID" "$BOB")" = "404" ] || fail "B deleted A's binder"
[ "$(req POST "/api/vault/binders/$BID/layout" "$BOB" "{\"pockets\":[{\"id\":\"${P[0]}\",\"owned\":true}]}")" = "404" ] || fail "B changed A's layout"
[ "$(req POST "/api/vault/binders/$BID/share" "$BOB")" = "404" ] || fail "B made a share link for A's binder"
[ "$(req POST /api/vault/binder-wanted "$BOB" "{\"pocket\":\"${P[0]}\"}")" = "404" ] || fail "B raised a wanted request from A's pocket"
[ "$(req GET "/api/collections/binders/records/$BID")" = "404" ] || fail "anonymous read A's binder"
ok "customer B and anonymous callers cannot read or change customer A's binder"

# Rules: A cannot write fields the routes own.
[ "$(req PATCH "/api/collections/binders/records/$BID" "$ALICE" '{"share_token":"abcdefghijklmnopqrstuvwxyz123456"}')" != "200" ] || fail "A set share_token directly"
[ "$(req PATCH "/api/collections/binder_cards/records/${P[0]}" "$ALICE" '{"name":"Renamed"}')" != "200" ] || fail "A renamed a pocket's card"
[ "$(req PATCH "/api/collections/binders/records/$BID" "$ALICE" '{"grid":"4x4"}')" = "200" ] || fail "A could not change grid: $(out)"
ok "A can switch the grid but cannot set the share token or card identity"

# Layout: move, tick and a clash.
[ "$(req POST "/api/vault/binders/$BID/layout" "$ALICE" "{\"pockets\":[{\"id\":\"${P[0]}\",\"slot\":5,\"owned\":true},{\"id\":\"${P[2]}\",\"slot\":-1}],\"min_slots\":8}")" = "200" ] || fail "layout: $(out)"
[ "$(req GET "/api/collections/binder_cards/records/${P[0]}" "$ALICE")" = "200" ] || fail "re-read pocket"
[ "$(out | jval slot)" = "5" ] && [ "$(out | jval owned)" = "true" ] || fail "layout not applied: $(out)"
[ "$(req POST "/api/vault/binders/$BID/layout" "$ALICE" "{\"pockets\":[{\"id\":\"${P[1]}\",\"slot\":5}]}")" = "400" ] || fail "a clash was accepted"
[ "$(req POST "/api/vault/binders/$BID/layout" "$ALICE" '{"pockets":[{"id":"notapocket123456","slot":1}]}')" = "400" ] || fail "an unknown pocket was accepted"
ok "layout batches move and tick, and refuse clashes and unknown pockets"

# Share view.
[ "$(req POST "/api/vault/binders/$BID/share" "$ALICE")" = "200" ] || fail "share: $(out)"
TOKEN="$(out | jval token)"
[ "${#TOKEN}" -ge 32 ] || fail "share token too short: '$TOKEN'"
[ "$(req POST "/api/vault/binders/$BID/share" "$ALICE")" = "200" ] && [ "$(out | jval token)" = "$TOKEN" ] || fail "share link changed on a second press"
[ "$(req GET "/api/vault/binder-share/$TOKEN")" = "200" ] || fail "anonymous share view: $(out)"
SHARE="$(out)"
echo "$SHARE" | no_price_keys || fail "share response carries a price-like key"
[ "$(echo "$SHARE" | jval binder.name)" = "Check binder" ] || fail "share view binder name: $SHARE"
[ "$(echo "$SHARE" | jval binder.customer)" = "" ] && [ "$(echo "$SHARE" | jval binder.owner)" = "" ] && [ "$(echo "$SHARE" | jval binder.share_token)" = "" ] \
  || fail "share view leaks the owner or token: $SHARE"
[ "$(echo "$SHARE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).pockets.length))')" = "2" ] \
  || fail "share view should hold the 2 pockets still in the binder: $SHARE"
echo "$SHARE" | grep -q '"binder":"' && fail "share view pockets leak the binder id"
ok "share view is anonymous, read only and price free, with no owner details"
[ "$(req GET "/api/vault/binder-share/${TOKEN:0:31}x")" = "404" ] || fail "a wrong token was accepted"
[ "$(req GET "/api/vault/binder-share/short")" = "404" ] || fail "a short token was accepted"
[ "$(req DELETE "/api/vault/binders/$BID/share" "$ALICE")" = "200" ] || fail "unshare"
[ "$(req GET "/api/vault/binder-share/$TOKEN")" = "404" ] || fail "share view still works after the link was switched off"
ok "wrong tokens 404 and switching the link off ends the share view"

# Wanted.
[ "$(req POST /api/vault/binder-wanted "$ALICE" "{\"pocket\":\"${P[1]}\"}")" = "200" ] || fail "wanted: $(out)"
WID="$(out | jval id)"
[ "$(req POST /api/vault/binder-wanted "$ALICE" "{\"pocket\":\"${P[1]}\"}")" = "200" ] || fail "second wanted"
[ "$(out | jval id)" = "$WID" ] && [ "$(out | jval existed)" = "true" ] || fail "second press made a second open request: $(out)"
[ "$(req GET "/api/collections/binder_wanted/records" "$ALICE")" = "200" ] && [ "$(out | jval totalItems)" = "1" ] || fail "A should see 1 request: $(out)"
out | no_price_keys || fail "wanted list carries a price-like key"
[ "$(req GET "/api/collections/binder_wanted/records" "$BOB")" = "200" ] && [ "$(out | jval totalItems)" = "0" ] || fail "B can see A's wanted requests"
[ "$(req POST /api/collections/binder_wanted/records "$ALICE" "{\"customer\":\"x\",\"card_id\":\"y\",\"status\":\"open\"}")" != "200" ] || fail "a customer wrote binder_wanted directly"
[ "$(req GET /api/vault/binder-wanted "$ALICE")" = "403" ] || fail "a customer reached the staff wanted list"
[ "$(req GET /api/vault/binder-wanted)" = "401" ] || fail "anonymous reached the staff wanted list"
[ "$(req GET /api/vault/binder-wanted "$STAFF")" = "200" ] || fail "staff wanted list: $(out)"
[ "$(out | jval total)" = "1" ] && [ "$(out | jval cards.0.card_id)" = "chk-1" ] && [ "$(out | jval cards.0.count)" = "1" ] || fail "staff list counts: $(out)"
ok "wanted: one open request per card, private to the customer, counted on the staff list"
[ "$(req DELETE "/api/vault/binder-wanted/$WID" "$BOB")" = "404" ] || fail "B cancelled A's request"
[ "$(req DELETE "/api/vault/binder-wanted/$WID" "$ALICE")" = "200" ] && [ "$(out | jval status)" = "cancelled" ] || fail "cancel: $(out)"
[ "$(req GET /api/vault/binder-wanted "$STAFF")" = "200" ] && [ "$(out | jval total)" = "0" ] || fail "cancelled request still open: $(out)"
[ "$(req POST /api/vault/binder-wanted "$ALICE" "{\"pocket\":\"${P[1]}\"}")" = "200" ] && [ "$(out | jval existed)" = "" ] || fail "could not ask again after cancelling: $(out)"
W2="$(out | jval id)"
[ "$(req POST "/api/vault/binder-wanted/$W2/close" "$ALICE" '{"status":"fulfilled"}')" = "403" ] || fail "a customer closed a request as staff"
[ "$(req POST "/api/vault/binder-wanted/$W2/close" "$STAFF" '{"status":"fulfilled"}')" = "200" ] || fail "staff close: $(out)"
ok "wanted requests cancel, reopen, and only staff can close them"

# Pokedex binder for generation 1 (names from PokeAPI when it answers).
[ "$(req POST /api/vault/binders "$ALICE" '{"kind":"pokedex","query":"gen1","name":"Kanto","grid":"3x3"}')" = "200" ] || fail "pokedex: $(out)"
[ "$(out | jval cards)" = "151" ] || fail "gen 1 should have 151 pockets: $(out)"
DEX="$(out | jval id)"
[ "$(req GET "/api/collections/binder_cards/records?perPage=1&sort=slot&filter=binder%3D%22$DEX%22" "$ALICE")" = "200" ] || fail "dex pockets"
[ "$(out | jval items.0.dex)" = "1" ] && [ "$(out | jval items.0.slot)" = "0" ] || fail "first dex pocket: $(out)"
out | jval items.0.sprite | grep -q '/1.png$' || fail "first dex pocket has no sprite: $(out)"
ok "a generation 1 Pokedex binder has 151 pockets with sprites, in dex order"

# Deleting a binder takes its pockets with it; the request history stays.
[ "$(req DELETE "/api/collections/binders/records/$BID" "$ALICE")" = "204" ] || fail "delete binder: $(out)"
[ "$(req GET "/api/collections/binder_cards/records/${P[1]}" "$SUPER")" = "404" ] || fail "pockets survived their binder"
ok "deleting a binder removes its pockets"

# ---------------------------------------------------------------------
# In stock at GG: catalogue prints, shop items, availability and alerts.
# ---------------------------------------------------------------------
[ "$(req GET "/api/collections/games/records?filter=key%3D%22pokemon%22" "$SUPER")" = "200" ] || fail "games list"
GAME_ID="$(out | jval items.0.id)"
[ -n "$GAME_ID" ] || fail "no seeded pokemon game"

mkset() {
  # $1 code -> prints the card_sets id
  curl -s -X POST "$BASE/api/collections/card_sets/records" -H "Authorization: $SUPER" -H "Content-Type: application/json" \
    -d "{\"game\":\"$GAME_ID\",\"code\":\"$1\",\"name\":\"Check Set $1\"}" | jval id
}
mkprint() {
  # $1 set id, $2 number, $3 name, $4 language, $5 tcgdex id -> prints the cards id
  curl -s -X POST "$BASE/api/collections/cards/records" -H "Authorization: $SUPER" -H "Content-Type: application/json" \
    -d "{\"game\":\"$GAME_ID\",\"set\":\"$1\",\"number\":\"$2\",\"name\":\"$3\",\"language\":\"$4\",\"external_ids\":{\"tcgdex\":\"$5\"}}" | jval id
}
mkshopitem() {
  # $1 cards id, $2 status, $3 qty -> prints the items id
  curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF" -H "Content-Type: application/json" \
    -d "{\"kind\":\"single\",\"game\":\"$GAME_ID\",\"card\":\"$1\",\"title\":\"Check stock item\",\"qty\":$3,\"cost\":100,\"price\":500,\"status\":\"$2\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}" | jval id
}

SET_EN="$(mkset chken)"
SET_JA="$(mkset chkja)"
[ -n "$SET_EN" ] && [ -n "$SET_JA" ] || fail "could not create the check card sets"
CARD_EN="$(mkprint "$SET_EN" 199 "Check Charizard" en chkset-199)"
CARD_JA="$(mkprint "$SET_JA" 199 "Check Charizard" ja chkset-199)"
[ -n "$CARD_EN" ] && [ -n "$CARD_JA" ] || fail "could not create the check catalogue prints"

# Alice's stock binder: the English print needed, the same print owned in a
# second pocket, and the Japanese print needed.
[ "$(req POST /api/vault/binders "$ALICE" '{"kind":"custom","name":"Stock binder","grid":"2x2","color":"volt"}')" = "200" ] || fail "stock binder: $(out)"
SBID="$(out | jval id)"
mkpocket() {
  # $1 binder, $2 card_id, $3 lang, $4 slot, $5 owned, $6 variant -> prints the pocket id
  curl -s -X POST "$BASE/api/collections/binder_cards/records" -H "Authorization: $SUPER" -H "Content-Type: application/json" \
    -d "{\"binder\":\"$1\",\"card_id\":\"$2\",\"name\":\"Check Charizard\",\"number\":\"199\",\"set_id\":\"chk\",\"set_name\":\"Check Set\",\"lang\":\"$3\",\"slot\":$4,\"sort\":$4,\"owned\":$5,\"variant\":\"${6:-}\"}" | jval id
}
PK_NEED_EN="$(mkpocket "$SBID" chkset-199 en 0 false)"
# Same print, owned, as a holo variant (one card and variant per binder).
PK_OWNED_EN="$(mkpocket "$SBID" chkset-199 en 1 true holo)"
# The Japanese pocket lives in its own binder: a binder holds one row per
# card and variant, whatever the language.
[ "$(req POST /api/vault/binders "$ALICE" '{"kind":"custom","name":"Stock binder JA","grid":"2x2","color":"cyan"}')" = "200" ] || fail "ja binder: $(out)"
SBID_JA="$(out | jval id)"
PK_NEED_JA="$(mkpocket "$SBID_JA" chkset-199 ja 0 false)"
[ -n "$PK_NEED_EN" ] && [ -n "$PK_OWNED_EN" ] && [ -n "$PK_NEED_JA" ] || fail "could not seed the stock binder pockets"

# No stock yet: nothing is flagged.
[ "$(req GET "/api/vault/binder-availability/$SBID" "$ALICE")" = "200" ] || fail "availability (empty): $(out)"
[ "$(out | jval in_stock)" = "[]" ] || fail "availability should start empty: $(out)"

# Unavailable statuses and qty 0 never flag a pocket.
for status in reserved listed_ebay sold written_off; do
  UNAVAIL_ID="$(mkshopitem "$CARD_EN" "$status" 1)"
  [ -n "$UNAVAIL_ID" ] || fail "could not create a $status item"
done
ZERO_ID="$(mkshopitem "$CARD_EN" in_stock 0)"
[ -n "$ZERO_ID" ] || fail "could not create the qty-0 item"
[ "$(req GET "/api/vault/binder-availability/$SBID" "$ALICE")" = "200" ] || fail "availability (unavailable statuses): $(out)"
[ "$(out | jval in_stock)" = "[]" ] || fail "reserved, listed, sold, written off or qty-0 stock was flagged: $(out)"
[ "$(req GET "/api/collections/binder_alerts/records" "$ALICE")" = "200" ] && [ "$(out | jval totalItems)" = "0" ] \
  || fail "unavailable stock raised an alert: $(out)"
ok "reserved, listed_ebay, sold, written_off and qty-0 items never flag a pocket or alert anyone"

# A real arrival: the English print only, on the needed English pocket only.
ITEM_EN="$(mkshopitem "$CARD_EN" in_stock 1)"
[ -n "$ITEM_EN" ] || fail "could not create the in-stock item"
[ "$(req GET "/api/vault/binder-availability/$SBID" "$ALICE")" = "200" ] || fail "availability: $(out)"
AVAIL="$(out)"
echo "$AVAIL" | no_price_keys || fail "availability carries a price-like key: $AVAIL"
echo "$AVAIL" | grep -qiE '"(sku|qty|location)"' && fail "availability leaks sku, qty or location: $AVAIL"
[ "$(echo "$AVAIL" | jval in_stock)" = "[\"$PK_NEED_EN\"]" ] \
  || fail "only the needed English pocket should be flagged (need $PK_NEED_EN): $AVAIL"
[ "$(req GET "/api/vault/binder-availability/$SBID_JA" "$ALICE")" = "200" ] && [ "$(out | jval in_stock)" = "[]" ] \
  || fail "an English item flagged the Japanese pocket: $(out)"
ok "an in-stock English print flags the needed English pocket only: never owned pockets, never the Japanese print"

[ "$(req GET "/api/vault/binder-availability/$SBID" "$BOB")" = "404" ] || fail "B read A's availability"
[ "$(req GET "/api/vault/binder-availability/$SBID")" = "401" ] || fail "anonymous read availability"
ok "availability is the owner's only"

# The share view carries the same boolean and nothing more.
[ "$(req POST "/api/vault/binders/$SBID/share" "$ALICE")" = "200" ] || fail "share stock binder: $(out)"
STOKEN="$(out | jval token)"
[ "$(req GET "/api/vault/binder-share/$STOKEN")" = "200" ] || fail "stock share view: $(out)"
SSHARE="$(out)"
echo "$SSHARE" | no_price_keys || fail "stock share view carries a price-like key"
echo "$SSHARE" | grep -qiE '"(sku|qty|location)"' && fail "stock share view leaks sku, qty or location"
[ "$(echo "$SSHARE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const p=JSON.parse(d).pockets;console.log(p.filter(x=>x.in_stock===true).length+" "+(p.find(x=>x.owned)?.in_stock===undefined));})')" = "1 true" ] \
  || fail "share view should flag exactly the needed English pocket: $SSHARE"
ok "the share view shows in_stock true on the needed pocket, nothing on owned ones, and no price"

# The arrival wrote exactly one alert, for Alice, with the agreed sentence.
[ "$(req GET "/api/collections/binder_alerts/records" "$ALICE")" = "200" ] || fail "alerts list: $(out)"
[ "$(out | jval totalItems)" = "1" ] || fail "one arrival should mean one alert: $(out)"
ALERT_ID="$(out | jval items.0.id)"
[ "$(out | jval items.0.message)" = "Good news: Check Charizard for your Stock binder binder is in at GG Entertainment. Pop in before it goes." ] \
  || fail "alert message is wrong: $(out)"
out | no_price_keys || fail "alert carries a price-like key"
[ "$(req GET "/api/collections/binder_alerts/records" "$BOB")" = "200" ] && [ "$(out | jval totalItems)" = "0" ] \
  || fail "B can see A's alerts: $(out)"
[ "$(req POST /api/collections/binder_alerts/records "$ALICE" '{"card_id":"x","dedupe_key":"y"}')" != "200" ] \
  || fail "a customer wrote binder_alerts directly"
[ "$(req PATCH "/api/collections/binder_alerts/records/$ALERT_ID" "$ALICE" '{"message":"changed"}')" != "200" ] \
  || fail "a customer rewrote an alert's message"
ok "one arrival, one alert, private to the customer, with the agreed sentence and no price"

# A second copy while the first is on the shelf says nothing new; the same
# item re-saved says nothing; a fresh arrival after everything sold, with
# the old alert read, speaks again.
ITEM_EN2="$(mkshopitem "$CARD_EN" in_stock 1)"
[ -n "$ITEM_EN2" ] || fail "could not create the second copy"
[ "$(req PATCH "/api/collections/items/records/$ITEM_EN" "$STAFF" '{"notes":"still here"}')" = "200" ] || fail "re-save item"
[ "$(req GET "/api/collections/binder_alerts/records" "$ALICE")" = "200" ] && [ "$(out | jval totalItems)" = "1" ] \
  || fail "a second copy or a re-save alerted again: $(out)"
[ "$(req PATCH "/api/collections/items/records/$ITEM_EN" "$STAFF" '{"status":"sold"}')" = "200" ] || fail "sell copy 1"
[ "$(req PATCH "/api/collections/items/records/$ITEM_EN2" "$STAFF" '{"status":"sold"}')" = "200" ] || fail "sell copy 2"
[ "$(req GET "/api/vault/binder-availability/$SBID" "$ALICE")" = "200" ] && [ "$(out | jval in_stock)" = "[]" ] \
  || fail "sold stock still flagged: $(out)"
[ "$(req PATCH "/api/collections/binder_alerts/records/$ALERT_ID" "$ALICE" "{\"read_at\":\"2026-01-01 00:00:00.000Z\"}")" = "200" ] \
  || fail "customer could not mark the alert read: $(out)"
ITEM_EN3="$(mkshopitem "$CARD_EN" in_stock 1)"
[ -n "$ITEM_EN3" ] || fail "could not create the third copy"
[ "$(req GET "/api/collections/binder_alerts/records" "$ALICE")" = "200" ] && [ "$(out | jval totalItems)" = "2" ] \
  || fail "a fresh arrival after a read alert should alert again: $(out)"
ok "copies and re-saves stay quiet; a fresh arrival after the alert was read speaks once more"

# Alerts off for the binder: the next arrival says nothing.
[ "$(req PATCH "/api/collections/binders/records/$SBID" "$ALICE" '{"alerts_off":true}')" = "200" ] || fail "turn alerts off: $(out)"
[ "$(req PATCH "/api/collections/items/records/$ITEM_EN3" "$STAFF" '{"status":"sold"}')" = "200" ] || fail "sell copy 3"
[ "$(req GET "/api/collections/binder_alerts/records?filter=read_at%3D%22%22" "$ALICE")" = "200" ] || fail "unread alerts list: $(out)"
ALERT2_ID="$(out | jval items.0.id)"
[ -n "$ALERT2_ID" ] || fail "no unread second alert to mark read"
[ "$(req PATCH "/api/collections/binder_alerts/records/$ALERT2_ID" "$ALICE" '{"read_at":"2026-01-01 00:00:00.000Z"}')" = "200" ] \
  || fail "could not read the second alert: $(out)"
ITEM_EN4="$(mkshopitem "$CARD_EN" in_stock 1)"
[ -n "$ITEM_EN4" ] || fail "could not create the fourth copy"
[ "$(req GET "/api/collections/binder_alerts/records" "$ALICE")" = "200" ] && [ "$(out | jval totalItems)" = "2" ] \
  || fail "an arrival alerted a binder with alerts off: $(out)"
ok "a binder with alerts off is left alone, while the badge still shows"

echo
echo "All $PASS_COUNT binder checks passed."
