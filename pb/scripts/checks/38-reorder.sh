# shellcheck shell=bash
# -----------------------------------------------------------------------
# 38. The supplier reorder report (docs/api-contract-reorder.md, sections 2
#     and 3): pb_migrations/1789821300_supplier_reorder.js,
#     pb_hooks/suppliers.pb.js, reorder.pb.js and mcp.js's supplier tools.
#
#     The two games for stock that is not a card game and the seeded
#     supplier; the starter tree's branches carrying them as their default
#     game, a branch an admin had already set left alone when the migration
#     runs (on a second server of this section's own); Warhammer filed under
#     Miniatures and paints; who may read and write suppliers, the duplicate
#     name and in-use delete refusals; staff setting a stock row's supplier,
#     Keep on shelf and supplier code, and a negative or fractional target
#     refused; customer requests (a customer token refused, the three
#     create refusals, created_by the caller and fixed, status_changed_at
#     stamped, no delete); a rack of four products (one restocked over two
#     rows, one out with a target, one with no target, one stocked to
#     target), two sales and a part refund in the range and one sale
#     outside it, whose lines, statuses, units sold, to-order figures and
#     totals equal the hand-worked figures of
#     packages/shared/test/reorder.test.ts; only open requests on the
#     report; the route's refusals; and the agent tools (reorder_report,
#     stock_request, and stock_update's three new fields).
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR,
# $ROOT, $PB and the ok/fail/jval helpers. It makes its own staff, supplier,
# customer, agent and stock (everything it defines starts with S38_ or
# s38_), starts a second server on a data directory of its own and stops it
# again, and closes the till if it had to open it.
# -----------------------------------------------------------------------

S38_DIR="$TMP_DIR/s38"
mkdir -p "$S38_DIR"
S38_SHARED="$ROOT/pb/pb_hooks/lib/shared"
S38_PASSWORD="s38-check-password-123"
S38_MIG_PID=""

# --- helpers -------------------------------------------------------------

# $1 token ("" for none), $2 method, $3 path, [$4 JSON body] -> the status code; the body
# is left in $S38_DIR/last.json.
s38_call() {
  local auth=()
  if [ -n "$1" ]; then auth=(-H "Authorization: $1"); fi
  if [ -n "${4:-}" ]; then
    curl -s -o "$S38_DIR/last.json" -w '%{http_code}' -X "$2" "$BASE$3" ${auth[@]+"${auth[@]}"} \
      -H "Content-Type: application/json" -d "$4"
  else
    curl -s -o "$S38_DIR/last.json" -w '%{http_code}' -X "$2" "$BASE$3" ${auth[@]+"${auth[@]}"}
  fi
}
s38_body() { cat "$S38_DIR/last.json"; }
s38_field() { jval "$1" <"$S38_DIR/last.json"; }
s38_keep() { cp "$S38_DIR/last.json" "$S38_DIR/$1.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
s38_expect() {
  [ "$1" = "$2" ] || fail "38: $4 returned $1, expected $2: $(s38_body)"
  if [ -n "$3" ]; then
    [ "$(s38_field message)" = "$3" ] || fail "38: $4 said '$(s38_field message)', expected '$3'"
  fi
}

# $1 status, $2 what was tried -> fails unless PocketBase refused it (400, 403 or 404).
s38_refused() {
  case "$1" in
    400 | 403 | 404) ;;
    *) fail "38: $2 returned $1, expected it to be refused: $(s38_body)" ;;
  esac
}

# $1 a PocketBase date, $2 another -> succeeds when $1 is the later one (the stored form sorts as text).
s38_later() { node -e 'process.exit(process.argv[1] > process.argv[2] ? 0 : 1)' "$1" "$2"; }

# $1 a JavaScript expression over the last body parsed as `r` -> its value (an object as JSON).
s38_js() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "null");
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$S38_DIR/last.json" "$1"
}
# $1 a kept body's name, $2 a JavaScript expression over it parsed as `r`.
s38_jsf() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "null");
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$S38_DIR/$1.json" "$2"
}

# $1 name, $2 email, $3 role -> a new staff member's id.
s38_make_staff() {
  curl -s -X POST "$BASE/api/collections/staff/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"$S38_PASSWORD\",\"passwordConfirm\":\"$S38_PASSWORD\",\"role\":\"$3\",\"active\":true}" | jval id
}
s38_sign_in() {
  curl -s -X POST "$BASE/api/collections/staff/auth-with-password" -H "Content-Type: application/json" \
    -d "{\"identity\":\"$1\",\"password\":\"$S38_PASSWORD\"}" | jval token
}

# $1 collection, $2 id, $3 field -> the record's field, read by the superuser.
s38_record() {
  curl -s "$BASE/api/collections/$1/records/$2" -H "Authorization: $SUPER_TOKEN" | jval "$3"
}

# $1 title, $2 qty, $3 price, $4 status, $5 supplier code, $6 shelf target, $7 barcode, [$8 supplier id]
# -> a new Warhammer stock row's id, made by the admin through the collection API. Every row
# carries a cost, which the report must never answer.
s38_stock() {
  local supplier="${8-$S38_GW}"
  local extra=""
  if [ -n "$supplier" ]; then extra=",\"supplier\":\"$supplier\""; fi
  local id
  id="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"other\",\"game\":\"$S38_WAR\",\"title\":\"$1\",\"qty\":$2,\"price\":$3,\"cost\":98765,\"status\":\"$4\",\"tax_scheme\":\"standard\",\"supplier_code\":\"$5\",\"shelf_target\":$6,\"ean\":\"$7\"$extra}" \
    | jval id)"
  [ -n "$id" ] || fail "38: could not create the stock row '$1'"
  echo "$id"
}

# $1 JSON body -> a new supplier's id, made by the manager.
s38_supplier() {
  curl -s -X POST "$BASE/api/collections/suppliers/records" -H "Authorization: $S38_MANAGER_TOKEN" \
    -H "Content-Type: application/json" -d "$1" | jval id
}

# $1 token, $2 tool, $3 arguments JSON -> a tools/call as an MCP client posts it. Sets
# S38_TOOL_ERROR ("true" or "false"); the tool's text is in $S38_DIR/tool.txt.
s38_tool() {
  local status
  status="$(curl -s -o "$S38_DIR/rpc.json" -w '%{http_code}' -X POST "$BASE/api/vault/mcp" \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"s38-$2\",\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}")"
  [ "$status" = "200" ] || fail "38: the $2 tool call returned $status: $(cat "$S38_DIR/rpc.json")"
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.content[0].text)' \
    "$S38_DIR/rpc.json" >"$S38_DIR/tool.txt"
  S38_TOOL_ERROR="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.isError))' "$S38_DIR/rpc.json")"
}
s38_tool_text() { cat "$S38_DIR/tool.txt"; }
# $1 a JavaScript expression over the tool's JSON answer parsed as `t`.
s38_tool_js() {
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$S38_DIR/tool.txt" "$1"
}

# The lines of the report in $S38_DIR/$1.json as one comparable string:
# title|in stock|keep on shelf|sold|to order|status|price, lines joined by ;
s38_lines() {
  s38_jsf "$1" "r.lines.map((l) => [l.title, l.inStock, l.shelfTarget, l.sold, l.toOrder, l.status, l.price].join('|')).join(';')"
}
# The totals of the report in $S38_DIR/$1.json: products,on target,in stock,sold,out,below,to order,requests
s38_totals() {
  s38_jsf "$1" "[r.totals.products, r.totals.onTarget, r.totals.inStock, r.totals.sold, r.totals.outOfStock, r.totals.belowTarget, r.totals.toOrder, r.totals.openRequests].join(',')"
}

# A second server on a data directory of this section's own, for the migration test.
# $1 data dir, $2 migrations dir, $3 port
s38_serve() {
  GG_ADAPTER_TRANSPORT_MODE="fixture" "$PB" serve --dir "$1" --hooksDir "$ROOT/pb/pb_hooks" --hooksWatch=false \
    --migrationsDir "$2" --http "127.0.0.1:$3" >"$1/server.log" 2>&1 &
  S38_MIG_PID=$!
  local healthy=""
  for _ in $(seq 1 100); do
    if curl -s -o /dev/null "http://127.0.0.1:$3/api/health"; then
      healthy=1
      break
    fi
    sleep 0.2
  done
  if [ -z "$healthy" ]; then
    kill "$S38_MIG_PID" 2>/dev/null || true
    fail "38: the migration test's server never became healthy: $(tail -5 "$1/server.log")"
  fi
}
s38_stop() {
  if [ -n "$S38_MIG_PID" ] && kill -0 "$S38_MIG_PID" 2>/dev/null; then
    kill "$S38_MIG_PID" 2>/dev/null || true
    wait "$S38_MIG_PID" 2>/dev/null || true
  fi
  S38_MIG_PID=""
}

# --- setup ---------------------------------------------------------------

S38_TODAY="$(node -e "process.stdout.write(require('$S38_SHARED/bookings.js').shopDateOf(new Date()))")"
S38_PERIOD_FROM="$(node -e "process.stdout.write(require('$S38_SHARED/reorder.js').defaultReorderPeriod('$S38_TODAY').from)")"
S38_OLD="$(node -e "process.stdout.write(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))")"

S38_CLERK_ID="$(s38_make_staff "S38 Sam" "s38-sam@local.test" staff)"
S38_MANAGER_ID="$(s38_make_staff "S38 Mo" "s38-mo@local.test" manager)"
S38_ADMIN_ID="$(s38_make_staff "S38 Ada" "s38-ada@local.test" admin)"
[ -n "$S38_CLERK_ID" ] && [ -n "$S38_MANAGER_ID" ] && [ -n "$S38_ADMIN_ID" ] || fail "38: could not create the section's staff"
S38_CLERK_TOKEN="$(s38_sign_in s38-sam@local.test)"
S38_MANAGER_TOKEN="$(s38_sign_in s38-mo@local.test)"
S38_ADMIN_TOKEN="$(s38_sign_in s38-ada@local.test)"
[ -n "$S38_CLERK_TOKEN" ] && [ -n "$S38_MANAGER_TOKEN" ] && [ -n "$S38_ADMIN_TOKEN" ] || fail "38: could not sign the section's staff in"

S38_CUSTOMER_JSON="$(curl -s -X POST "$BASE/api/collections/customers/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"S38 Customer","email":"s38-customer@local.test","phone":"07700 900456","source":"counter","guild_joined_at":"2026-01-01 00:00:00.000Z"}')"
S38_CUSTOMER="$(jval id <<<"$S38_CUSTOMER_JSON")"
S38_CUSTOMER_CODE="$(jval code <<<"$S38_CUSTOMER_JSON")"
[ -n "$S38_CUSTOMER" ] && [ -n "$S38_CUSTOMER_CODE" ] || fail "38: could not create the section's customer: $S38_CUSTOMER_JSON"
S38_CUSTOMER_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$S38_CUSTOMER" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$S38_CUSTOMER_TOKEN" ] || fail "38: could not impersonate the section's customer"

# --- 38a. The two games, the seeded supplier and the tree's default games ----

S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/collections/games/records?filter=key%3D%27warhammer%27")"
s38_expect "$S38_STATUS" 200 "" "reading the Warhammer game"
S38_WAR="$(s38_field items.0.id)"
[ -n "$S38_WAR" ] && [ "$(s38_field items.0.name)" = "Warhammer" ] && [ "$(s38_field items.0.enabled)" = "true" ] && [ -z "$(s38_field items.0.adapter)" ] \
  || fail "38: the Warhammer game is not an enabled game called Warhammer with no adapter: $(s38_body)"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/collections/games/records?filter=key%3D%27other%27")"
S38_OTHER="$(s38_field items.0.id)"
[ -n "$S38_OTHER" ] && [ "$(s38_field items.0.name)" = "Other" ] && [ "$(s38_field items.0.enabled)" = "true" ] && [ -z "$(s38_field items.0.adapter)" ] \
  || fail "38: the Other game is not an enabled game called Other with no adapter: $(s38_body)"
S38_POKEMON="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval items.0.id)"
S38_RETRO="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27retro%27" -H "Authorization: $STAFF_TOKEN" | jval items.0.id)"

# The five card games say which adapter finds their cards; the two new games say none, so a card
# search can leave them out. The lookup routes agree: no adapter, no search.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/collections/games/records?perPage=100")"
s38_expect "$S38_STATUS" 200 "" "listing the games"
[ "$(s38_js "r.items.filter((g) => ['pokemon', 'mtg', 'yugioh', 'onepiece', 'lorcana'].includes(g.key)).map((g) => g.key + ':' + g.adapter).sort().join()")" = "lorcana:lorcast,mtg:scryfall,onepiece:optcg,pokemon:tcgdex,yugioh:ygoprodeck" ] \
  || fail "38: the card games do not name their adapters: $(s38_js "r.items.map((g) => g.key + ':' + g.adapter).join()")"
for S38_NO_ADAPTER in warhammer other; do
  S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/lookup?game=$S38_NO_ADAPTER&q=charizard")"
  s38_expect "$S38_STATUS" 400 "Unknown game \"$S38_NO_ADAPTER\". Pick one of pokemon, mtg, yugioh, onepiece, lorcana." "a card search in the game $S38_NO_ADAPTER"
  S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/lookup/$S38_NO_ADAPTER/sv151/199")"
  s38_expect "$S38_STATUS" 400 "Unknown game \"$S38_NO_ADAPTER\". Pick one of pokemon, mtg, yugioh, onepiece, lorcana." "an exact card lookup in the game $S38_NO_ADAPTER"
done

S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/collections/suppliers/records?filter=name%3D%27Games%20Workshop%27")"
s38_expect "$S38_STATUS" 200 "" "reading the seeded supplier"
S38_GW="$(s38_field items.0.id)"
[ -n "$S38_GW" ] && [ "$(s38_field items.0.active)" = "true" ] && [ "$(s38_field items.0.sort)" = "10" ] \
  || fail "38: Games Workshop is not seeded as an active supplier with sort 10: $(s38_body)"

S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/categories/tree")"
s38_expect "$S38_STATUS" 200 "" "the category tree"
s38_keep tree
S38_BAD_DEFAULTS="$(s38_jsf tree "(() => {
  const bad = [];
  for (const b of r.branches) {
    const top = b.key.split('.')[0];
    let want = '';
    if (top === 'minis') want = b.key === 'minis.otherminiatures' ? '$S38_OTHER' : '$S38_WAR';
    else if (['boardgames', 'pc', 'accessories', 'food', 'services'].includes(top)) want = '$S38_OTHER';
    else if (b.key === 'tcg.pokemon.singles') want = '$S38_POKEMON';
    else if (b.key === 'retro.sega.megadrive.games') want = '$S38_RETRO';
    else continue;
    if (b.defaults.game !== want) bad.push(b.key);
  }
  return bad.join();
})()")"
[ -z "$S38_BAD_DEFAULTS" ] || fail "38: these branches do not carry the starter tree's default game: $S38_BAD_DEFAULTS"
[ "$(s38_jsf tree "r.branches.filter((b) => b.key.split('.')[0] === 'minis' && b.defaults.game === '$S38_WAR').length")" = "5" ] \
  || fail "38: the Miniatures and paints branches are not five on Warhammer"
ok "the Warhammer and Other games exist with no adapter (the five card games now name theirs, and the lookup routes refuse a card search in either new game), Games Workshop is seeded, and the starter tree's minis branches default to Warhammer (Other miniatures to Other) and board games, PC parts, accessories, food and services to Other"

# --- 38a2. The migration leaves a branch an admin had set alone ------------
# A data directory of its own: migrated to just before this migration, a
# branch's default game set as an admin would, then this migration run.

S38_MIG_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
S38_MIG_DATA="$S38_DIR/migration-data"
S38_MIG_BEFORE="$S38_DIR/migrations-before"
S38_MIG_BASE="http://127.0.0.1:$S38_MIG_PORT"
mkdir -p "$S38_MIG_DATA" "$S38_MIG_BEFORE"
for S38_MIGRATION in "$ROOT"/pb/pb_migrations/*.js; do
  case "$S38_MIGRATION" in
    *1789821300_supplier_reorder.js) ;;
    *) ln -s "$S38_MIGRATION" "$S38_MIG_BEFORE/" ;;
  esac
done
"$PB" --dir "$S38_MIG_DATA" superuser upsert "check-s38@local.test" "$S38_PASSWORD" >/dev/null
s38_serve "$S38_MIG_DATA" "$S38_MIG_BEFORE" "$S38_MIG_PORT"
S38_MIG_TOKEN="$(curl -s -X POST "$S38_MIG_BASE/api/collections/_superusers/auth-with-password" -H "Content-Type: application/json" \
  -d "{\"identity\":\"check-s38@local.test\",\"password\":\"$S38_PASSWORD\"}" | jval token)"
[ -n "$S38_MIG_TOKEN" ] || { s38_stop; fail "38: could not sign in to the migration test's server"; }
[ "$(curl -s "$S38_MIG_BASE/api/collections/games/records?filter=key%3D%27warhammer%27" -H "Authorization: $S38_MIG_TOKEN" | jval totalItems)" = "0" ] \
  || { s38_stop; fail "38: the migration test's database already has the Warhammer game"; }
S38_MIG_POKEMON="$(curl -s "$S38_MIG_BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $S38_MIG_TOKEN" | jval items.0.id)"
S38_MIG_PAINTS="$(curl -s "$S38_MIG_BASE/api/collections/categories/records?filter=key%3D%27minis.paints%27" -H "Authorization: $S38_MIG_TOKEN" | jval items.0.id)"
S38_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$S38_MIG_BASE/api/collections/categories/records/$S38_MIG_PAINTS" \
  -H "Authorization: $S38_MIG_TOKEN" -H "Content-Type: application/json" -d "{\"default_game\":\"$S38_MIG_POKEMON\"}")"
[ "$S38_STATUS" = "200" ] || { s38_stop; fail "38: could not set Paints' default game on the migration test's server ($S38_STATUS)"; }
s38_stop
S38_MIG_OUTPUT="$("$PB" migrate up --dir "$S38_MIG_DATA" --hooksDir "$ROOT/pb/pb_hooks" --migrationsDir "$ROOT/pb/pb_migrations" 2>&1)" \
  || fail "38: migrate up failed: $S38_MIG_OUTPUT"
echo "$S38_MIG_OUTPUT" | grep -q "1789821300_supplier_reorder.js" || fail "38: migrate up did not apply the supplier reorder migration: $S38_MIG_OUTPUT"
s38_serve "$S38_MIG_DATA" "$ROOT/pb/pb_migrations" "$S38_MIG_PORT"
S38_MIG_TOKEN="$(curl -s -X POST "$S38_MIG_BASE/api/collections/_superusers/auth-with-password" -H "Content-Type: application/json" \
  -d "{\"identity\":\"check-s38@local.test\",\"password\":\"$S38_PASSWORD\"}" | jval token)"
S38_MIG_WAR="$(curl -s "$S38_MIG_BASE/api/collections/games/records?filter=key%3D%27warhammer%27" -H "Authorization: $S38_MIG_TOKEN" | jval items.0.id)"
S38_MIG_OTHER="$(curl -s "$S38_MIG_BASE/api/collections/games/records?filter=key%3D%27other%27" -H "Authorization: $S38_MIG_TOKEN" | jval items.0.id)"
S38_MIG_DEFAULTS="$(curl -s "$S38_MIG_BASE/api/collections/categories/records?perPage=500&fields=key,default_game" -H "Authorization: $S38_MIG_TOKEN" | node -e '
  const [war, other, pokemon] = process.argv.slice(1);
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const game = (key) => (rows.find((r) => r.key === key) || {}).default_game;
  process.stdout.write([
    game("minis") === war, game("minis.warhammer40000") === war, game("minis.ageofsigmar") === war,
    game("minis.toolsandhobby") === war, game("minis.otherminiatures") === other, game("pc.memory") === other,
    game("services.events") === other, game("minis.paints") === pokemon, game("unsorted") === "",
  ].join());
' "$S38_MIG_WAR" "$S38_MIG_OTHER" "$S38_MIG_POKEMON")"
S38_MIG_SUPPLIERS="$(curl -s "$S38_MIG_BASE/api/collections/suppliers/records" -H "Authorization: $S38_MIG_TOKEN" | jval items.0.name)"
s38_stop
[ "$S38_MIG_DEFAULTS" = "true,true,true,true,true,true,true,true,true" ] \
  || fail "38: after the migration the branches' default games read $S38_MIG_DEFAULTS, expected an admin's Paints (Pokémon) left alone and the rest on the starter tree's"
[ "$S38_MIG_SUPPLIERS" = "Games Workshop" ] || fail "38: the migration seeded '$S38_MIG_SUPPLIERS', expected Games Workshop"
ok "the migration sets the new games on the branches by key only where they had none: a branch an admin had set (Paints, on Pokémon) is untouched"

# --- 38b. Suppliers: who may read and write, the name rules ---------------

S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/collections/suppliers/records")"
s38_expect "$S38_STATUS" 200 "" "staff listing suppliers"
[ "$(s38_js "r.items.filter((s) => s.id === '$S38_GW').length")" = "1" ] || fail "38: staff cannot list Games Workshop"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/collections/suppliers/records/$S38_GW")"
s38_expect "$S38_STATUS" 200 "" "staff viewing a supplier"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/suppliers/records" '{"name":"S38 Staff Supplier","active":true}')"
s38_refused "$S38_STATUS" "plain staff creating a supplier"
[ "$(curl -s -G "$BASE/api/collections/suppliers/records" -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=name = 'S38 Staff Supplier'" | jval totalItems)" = "0" ] \
  || fail "38: plain staff created a supplier"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/suppliers/records/$S38_GW" '{"rep_name":"Nobody"}')"
s38_refused "$S38_STATUS" "plain staff changing a supplier"
[ -z "$(s38_record suppliers "$S38_GW" rep_name)" ] || fail "38: plain staff changed a supplier"

S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" POST "/api/collections/suppliers/records" \
  '{"name":"  S38 Other Supplier  ","account_number":"S38-1","rep_name":"Pat","rep_email":"pat@s38.test","rep_phone":"07700 900111","active":true,"sort":20}')"
s38_expect "$S38_STATUS" 200 "" "a manager creating a supplier"
S38_SUP2="$(s38_field id)"
[ "$(s38_field name)" = "S38 Other Supplier" ] || fail "38: the supplier's name was not trimmed: '$(s38_field name)'"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" POST "/api/collections/suppliers/records" '{"name":"s38 OTHER supplier","active":true}')"
s38_expect "$S38_STATUS" 400 "There is already a supplier called s38 OTHER supplier." "a duplicate name in another case"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" POST "/api/collections/suppliers/records" '{"name":"Games Workshop"}')"
s38_expect "$S38_STATUS" 400 "There is already a supplier called Games Workshop." "a second Games Workshop"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" POST "/api/collections/suppliers/records" '{"name":"   ","active":true}')"
s38_expect "$S38_STATUS" 400 "Give the supplier a name." "a supplier with a blank name"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" POST "/api/collections/suppliers/records" '{"active":true}')"
s38_expect "$S38_STATUS" 400 "Give the supplier a name." "a supplier with no name"

S38_SPARE="$(s38_supplier '{"name":"S38 Spare","active":true,"sort":30}')"
[ -n "$S38_SPARE" ] || fail "38: could not create the spare supplier"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" PATCH "/api/collections/suppliers/records/$S38_SPARE" '{"name":"games workshop"}')"
s38_expect "$S38_STATUS" 400 "There is already a supplier called games workshop." "renaming a supplier to an existing name"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" PATCH "/api/collections/suppliers/records/$S38_SPARE" '{"name":"S38 SPARE"}')"
s38_expect "$S38_STATUS" 200 "" "changing the case of a supplier's own name"
S38_STATUS="$(s38_call "$S38_ADMIN_TOKEN" PATCH "/api/collections/suppliers/records/$S38_GW" '{"rep_name":"Dan","rep_phone":"07700 900456","rep_email":"dan@s38.test","account_number":"GW-48213"}')"
s38_expect "$S38_STATUS" 200 "" "an admin setting the rep on Games Workshop"
ok "staff can list and view suppliers but not create or change one; a manager creates one with its name trimmed; a duplicate or blank name is refused in a sentence, whatever the case"

# --- 38c. Items: supplier, Keep on shelf and supplier code -------------------

S38_ITEM_JSON="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $S38_CLERK_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"other\",\"game\":\"$S38_WAR\",\"title\":\"S38 Wraithknight Box\",\"qty\":1,\"price\":20000,\"cost\":98765,\"status\":\"in_stock\",\"tax_scheme\":\"standard\"}")"
S38_WK="$(jval id <<<"$S38_ITEM_JSON")"
[ -n "$S38_WK" ] || fail "38: plain staff could not create a Warhammer stock row: $S38_ITEM_JSON"
S38_MINIS="$(s38_jsf tree "r.branches.find((b) => b.key === 'minis').id")"
[ "$(jval category <<<"$S38_ITEM_JSON")" = "$S38_MINIS" ] \
  || fail "38: a Warhammer stock row made with no branch was not filed under Miniatures and paints: $S38_ITEM_JSON"
S38_ACC_ITEM="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"accessory\",\"game\":\"$S38_OTHER\",\"title\":\"S38 Generic Sleeves\",\"qty\":4,\"price\":599,\"status\":\"in_stock\",\"tax_scheme\":\"standard\"}")"
S38_ACCESSORIES="$(s38_jsf tree "r.branches.find((b) => b.key === 'accessories').id")"
[ "$(jval category <<<"$S38_ACC_ITEM")" = "$S38_ACCESSORIES" ] \
  || fail "38: an accessory of the game Other was not filed under Accessories by its kind: $S38_ACC_ITEM"

S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/items/records/$S38_WK" \
  "{\"supplier\":\"$S38_SUP2\",\"shelf_target\":3,\"supplier_code\":\"  WK-001  \"}")"
s38_expect "$S38_STATUS" 200 "" "plain staff setting the supplier, Keep on shelf and supplier code"
[ "$(s38_field supplier)" = "$S38_SUP2" ] && [ "$(s38_field shelf_target)" = "3" ] && [ "$(s38_field supplier_code)" = "WK-001" ] \
  || fail "38: the three item fields did not save as sent (code trimmed): $(s38_body)"
for S38_BAD in -1 -20 2.5 0.5; do
  S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/items/records/$S38_WK" "{\"shelf_target\":$S38_BAD}")"
  s38_expect "$S38_STATUS" 400 "Keep on shelf is a whole number, 0 or more." "a Keep on shelf of $S38_BAD"
done
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/items/records" \
  "{\"kind\":\"other\",\"game\":\"$S38_WAR\",\"title\":\"S38 Refused Box\",\"qty\":1,\"price\":100,\"status\":\"in_stock\",\"shelf_target\":-1}")"
s38_expect "$S38_STATUS" 400 "Keep on shelf is a whole number, 0 or more." "creating a stock row with a negative Keep on shelf"
[ "$(s38_record items "$S38_WK" shelf_target)" = "3" ] || fail "38: a refused Keep on shelf changed the row"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/items/records/$S38_WK" '{"price":20500}')"
s38_expect "$S38_STATUS" 200 "" "plain staff changing another field of a stock row with a target"
[ "$(s38_field shelf_target)" = "3" ] && [ "$(s38_field supplier)" = "$S38_SUP2" ] || fail "38: changing the price lost the supplier fields"
ok "staff set supplier, Keep on shelf and supplier code on a stock row (code trimmed); a negative or fractional target is refused on create and update; Warhammer stock is filed under Miniatures and paints and the game Other by its kind"

# --- 38d. Customer requests: the rules, the refusals, the stamps --------------

S38_REQUEST_ONLY="$(s38_supplier '{"name":"S38 Request Only","active":true,"sort":40}')"
[ -n "$S38_REQUEST_ONLY" ] || fail "38: could not create the request-only supplier"

S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" \
  "{\"title\":\"  Dark Angels Combat Patrol  \",\"supplier\":\"$S38_GW\",\"customer\":\"$S38_CUSTOMER\",\"qty\":2,\"created_by\":\"$S38_ADMIN_ID\",\"status_changed_at\":\"2020-01-01 00:00:00.000Z\"}")"
s38_expect "$S38_STATUS" 200 "" "plain staff logging a request for a Guild customer"
S38_R1="$(s38_field id)"
s38_keep r1
[ "$(s38_field title)" = "Dark Angels Combat Patrol" ] && [ "$(s38_field qty)" = "2" ] && [ "$(s38_field status)" = "waiting" ] \
  || fail "38: the new request is not a trimmed Waiting request for 2: $(s38_body)"
[ "$(s38_field created_by)" = "$S38_CLERK_ID" ] \
  || fail "38: created_by is '$(s38_field created_by)', expected the caller $S38_CLERK_ID whatever was sent"
S38_STAMP1="$(s38_field status_changed_at)"
[ "$(node -e "const t = Date.parse(process.argv[1].replace(' ', 'T')); process.stdout.write(Math.abs(Date.now() - t) < 60000 ? 'yes' : 'no')" "$S38_STAMP1")" = "yes" ] \
  || fail "38: status_changed_at is '$S38_STAMP1', expected now (a sent value is ignored)"

# Left out, qty is 1 and the status Waiting; a contact name alone is enough.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" \
  "{\"title\":\"Space Marine Heroes\",\"supplier\":\"$S38_GW\",\"contact_name\":\"  Jo Bloggs \",\"contact_phone\":\"07700 900123\",\"notes\":\"Wants it for Saturday\"}")"
s38_expect "$S38_STATUS" 200 "" "logging a request with a contact name only"
S38_R2="$(s38_field id)"
[ "$(s38_field qty)" = "1" ] && [ "$(s38_field status)" = "waiting" ] && [ "$(s38_field contact_name)" = "Jo Bloggs" ] \
  || fail "38: a request with no qty is not for 1, Waiting, with the contact name trimmed: $(s38_body)"

# The three create refusals, verbatim.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"   \",\"supplier\":\"$S38_GW\",\"contact_name\":\"Jo\"}")"
s38_expect "$S38_STATUS" 400 "Say what the customer is after." "a request with a blank title"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"supplier\":\"$S38_GW\",\"contact_name\":\"Jo\"}")"
s38_expect "$S38_STATUS" 400 "Say what the customer is after." "a request with no title"
for S38_BAD in -1 2.5; do
  S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Too few\",\"qty\":$S38_BAD,\"supplier\":\"$S38_GW\",\"contact_name\":\"Jo\"}")"
  s38_expect "$S38_STATUS" 400 "The quantity is a whole number, 1 or more." "a request for $S38_BAD"
done
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Nobody to tell\",\"supplier\":\"$S38_GW\"}")"
s38_expect "$S38_STATUS" 400 "Add the customer, or a name to contact, so they can be told when it comes in." "a request with no customer and no contact name"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Blank contact\",\"contact_name\":\"   \"}")"
s38_expect "$S38_STATUS" 400 "Add the customer, or a name to contact, so they can be told when it comes in." "a request with a blank contact name"

# created_by cannot change; a status change stamps status_changed_at; another change does not.
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" "{\"created_by\":\"$S38_ADMIN_ID\",\"notes\":\"Rang the rep\"}")"
s38_expect "$S38_STATUS" 200 "" "a manager changing a request's notes and trying to change created_by"
[ "$(s38_field created_by)" = "$S38_CLERK_ID" ] || fail "38: created_by changed to '$(s38_field created_by)'"
[ "$(s38_field status_changed_at)" = "$S38_STAMP1" ] || fail "38: a change to the notes moved status_changed_at"
sleep 0.05
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" '{"status":"asked"}')"
s38_expect "$S38_STATUS" 200 "" "moving a request to Asked the rep"
S38_STAMP2="$(s38_field status_changed_at)"
[ "$(s38_field status)" = "asked" ] && s38_later "$S38_STAMP2" "$S38_STAMP1" \
  || fail "38: moving to asked left status_changed_at at '$S38_STAMP2' (was '$S38_STAMP1')"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" '{"status":"ordered","qty":3}')"
s38_expect "$S38_STATUS" 200 "" "moving a request to Ordered and changing its quantity"
[ "$(s38_field qty)" = "3" ] && s38_later "$(s38_field status_changed_at)" "$S38_STAMP2" || fail "38: the quantity or the stamp did not follow: $(s38_body)"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" '{"title":"   "}')"
s38_expect "$S38_STATUS" 400 "Say what the customer is after." "blanking a request's title"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" '{"qty":-2}')"
s38_expect "$S38_STATUS" 400 "The quantity is a whole number, 1 or more." "a negative quantity on an update"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" '{"status":"asked"}')"
s38_expect "$S38_STATUS" 200 "" "moving a request back to Asked the rep"

# Delete is refused to every member of staff, an admin included.
S38_STATUS="$(s38_call "$S38_ADMIN_TOKEN" DELETE "/api/collections/stock_requests/records/$S38_R2")"
s38_refused "$S38_STATUS" "an admin deleting a request"
[ -n "$(s38_record stock_requests "$S38_R2" id)" ] || fail "38: an admin deleted a request"

# A customer token gets nothing.
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" GET "/api/collections/stock_requests/records")"
s38_expect "$S38_STATUS" 200 "" "a customer listing requests"
[ "$(s38_field totalItems)" = "0" ] || fail "38: a customer listed $(s38_field totalItems) requests"
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" GET "/api/collections/stock_requests/records/$S38_R1")"
s38_refused "$S38_STATUS" "a customer viewing a request"
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Sneaky\",\"customer\":\"$S38_CUSTOMER\"}")"
s38_refused "$S38_STATUS" "a customer creating a request"
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R1" '{"status":"collected"}')"
s38_refused "$S38_STATUS" "a customer changing a request"
[ "$(s38_record stock_requests "$S38_R1" status)" = "asked" ] || fail "38: a customer changed a request"
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" GET "/api/collections/suppliers/records")"
s38_expect "$S38_STATUS" 200 "" "a customer listing suppliers"
[ "$(s38_field totalItems)" = "0" ] || fail "38: a customer listed $(s38_field totalItems) suppliers"
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" POST "/api/collections/suppliers/records" '{"name":"S38 Customer Supplier"}')"
s38_refused "$S38_STATUS" "a customer creating a supplier"

# More requests: one closed, one cancelled, one for another supplier, one for none.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Already collected\",\"supplier\":\"$S38_GW\",\"contact_name\":\"Al\"}")"
S38_R3="$(s38_field id)"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R3" '{"status":"collected"}')"
s38_expect "$S38_STATUS" 200 "" "collecting a request"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Changed their mind\",\"supplier\":\"$S38_GW\",\"contact_name\":\"Bo\"}")"
S38_R4="$(s38_field id)"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R4" '{"status":"cancelled"}')"
s38_expect "$S38_STATUS" 200 "" "cancelling a request"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Another supplier's\",\"supplier\":\"$S38_SUP2\",\"contact_name\":\"Cy\"}")"
S38_R5="$(s38_field id)"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"For nobody yet\",\"contact_name\":\"Di\"}")"
S38_R6="$(s38_field id)"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" POST "/api/collections/stock_requests/records" "{\"title\":\"Only a request\",\"supplier\":\"$S38_REQUEST_ONLY\",\"contact_name\":\"Ed\"}")"
s38_expect "$S38_STATUS" 200 "" "logging a request for the request-only supplier"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" PATCH "/api/collections/stock_requests/records/$S38_R2" '{"status":"arrived"}')"
s38_expect "$S38_STATUS" 200 "" "marking a request Arrived"
ok "a request is Waiting for 1 by default, trimmed, with created_by the caller whatever is sent and fixed afterwards and status_changed_at stamped only by a status change; the three create refusals say their sentences; no member of staff can delete a request and a customer reaches nothing"

# --- 38e. In-use suppliers cannot be deleted -----------------------------------

S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" DELETE "/api/collections/suppliers/records/$S38_SUP2")"
s38_expect "$S38_STATUS" 400 "S38 Other Supplier still has stock or requests. Switch it off instead." "deleting a supplier with stock and a request"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" DELETE "/api/collections/suppliers/records/$S38_REQUEST_ONLY")"
s38_expect "$S38_STATUS" 400 "S38 Request Only still has stock or requests. Switch it off instead." "deleting a supplier with only a request"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" DELETE "/api/collections/suppliers/records/$S38_GW")"
s38_expect "$S38_STATUS" 400 "Games Workshop still has stock or requests. Switch it off instead." "deleting Games Workshop while a request names it"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" DELETE "/api/collections/suppliers/records/$S38_SPARE")"
s38_refused "$S38_STATUS" "plain staff deleting a supplier"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" PATCH "/api/collections/suppliers/records/$S38_REQUEST_ONLY" '{"active":false}')"
s38_expect "$S38_STATUS" 200 "" "switching a supplier off instead"
S38_STATUS="$(s38_call "$S38_MANAGER_TOKEN" DELETE "/api/collections/suppliers/records/$S38_SPARE")"
[ "$S38_STATUS" = "204" ] || fail "38: a manager could not delete a supplier nothing points at ($S38_STATUS): $(s38_body)"
ok "a supplier any stock row or request points at cannot be deleted (it can be switched off); one nothing points at can, by a manager"

# --- 38f. The rack, its sales and the route ------------------------------------
# The hand-worked figures of packages/shared/test/reorder.test.ts, as real
# stock and sales. Four products of Games Workshop's, prices in pence:
#   Combat Patrol: restocked over two rows. a1 (2, sold out last month's
#     stock) and a2 (2, made after a1 sold): target 3, 3 sold, 1 left.
#   Citadel Contrast: stocked to its target of 6: b1 (8, 5 sold, 1 refunded)
#     and b2 (2, reserved): 4 + 2 on hand, 4 kept.
#   Starter Set: out (a row at 0, sold), a target of 2.
#   Kill Team: no target; d1 (2, one sold outside the range) and d2 written off.
# plus a supplier-less box sold in the same sale, which the report must not count.

S38_TILL_WAS_OPEN="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id")"
if [ -z "$S38_TILL_WAS_OPEN" ]; then
  S38_STATUS="$(s38_call "$STAFF_TOKEN" POST "/api/vault/cash-sessions/open" '{"float":20000}')"
  s38_expect "$S38_STATUS" 200 "" "opening the till"
fi

S38_A1="$(s38_stock "Combat Patrol: Space Marines" 2 9500 in_stock "99120101" 3 "")"
S38_B1="$(s38_stock "Citadel Contrast: Black Templar" 8 525 in_stock "" 6 "5011921000001")"
S38_C1="$(s38_stock "Warhammer 40,000 Starter Set" 0 6000 sold "" 2 "")"
S38_D1="$(s38_stock "Kill Team: Hivestorm" 2 13000 in_stock "" 0 "")"
S38_D2="$(s38_stock "Kill Team: Hivestorm" 3 13000 written_off "" 0 "")"
S38_B2="$(s38_stock "Citadel Contrast: Black Templar" 2 525 reserved "" 0 "5011921000001")"
S38_Z="$(s38_stock "S38 Unrelated Box" 9 100 in_stock "" 0 "" "")"

S38_STATUS="$(s38_call "$STAFF_TOKEN" POST "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S38_A1\",\"qty\":2},{\"item\":\"$S38_B1\",\"qty\":3},{\"item\":\"$S38_Z\",\"qty\":9}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":21475,\"card_last4\":\"3838\"}]}")"
s38_expect "$S38_STATUS" 200 "" "sale A: two Combat Patrols, three Contrast and nine unrelated boxes"

# Made after the sale, so its row is the newest Combat Patrol.
S38_A2="$(s38_stock "Combat Patrol: Space Marines" 2 9900 in_stock "99120101" 3 "")"
S38_STATUS="$(s38_call "$STAFF_TOKEN" POST "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S38_A2\",\"qty\":1},{\"item\":\"$S38_B1\",\"qty\":2}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":10950,\"card_last4\":\"3838\"}]}")"
s38_expect "$S38_STATUS" 200 "" "sale B: a Combat Patrol and two Contrast"
S38_SALE_B="$(s38_field "sale.id")"
S38_B_LINE="$(curl -s -G "$BASE/api/collections/sale_lines/records" -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=sale = '$S38_SALE_B' && item = '$S38_B1'" | jval items.0.id)"
[ -n "$S38_B_LINE" ] || fail "38: sale B has no Contrast line"
S38_STATUS="$(s38_call "$STAFF_TOKEN" POST "/api/vault/sales/$S38_SALE_B/refund" \
  "{\"lines\":[{\"sale_line\":\"$S38_B_LINE\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"cash\",\"amount\":525}]}")"
s38_expect "$S38_STATUS" 200 "" "refunding one Contrast from sale B"

S38_STATUS="$(s38_call "$STAFF_TOKEN" POST "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S38_D1\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":13000,\"card_last4\":\"3838\"}]}")"
s38_expect "$S38_STATUS" 200 "" "sale C: a Kill Team box"
S38_SALE_C="$(s38_field "sale.id")"
S38_STATUS="$(s38_call "$SUPER_TOKEN" PATCH "/api/collections/sales/records/$S38_SALE_C" "{\"occurred_at\":\"$S38_OLD 12:00:00.000Z\"}")"
s38_expect "$S38_STATUS" 200 "" "dating sale C thirty days ago"

# The report as plain staff reads it, over the default last seven days.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW")"
s38_expect "$S38_STATUS" 200 "" "plain staff reading Games Workshop's report"
s38_keep report
[ "$(s38_jsf report "[r.from, r.to].join()")" = "$S38_PERIOD_FROM,$S38_TODAY" ] \
  || fail "38: the default period is $(s38_jsf report "[r.from, r.to].join()"), expected $S38_PERIOD_FROM,$S38_TODAY (the last seven days, both ends counted)"
[ "$(s38_jsf report "[r.supplier.id, r.supplier.name, r.supplier.accountNumber, r.supplier.repName, r.supplier.repEmail, r.supplier.repPhone].join('|')")" = "$S38_GW|Games Workshop|GW-48213|Dan|dan@s38.test|07700 900456" ] \
  || fail "38: the report names the supplier wrongly: $(s38_jsf report "r.supplier")"
S38_EXPECTED_LINES="Warhammer 40,000 Starter Set|0|2|0|2|out|6000;Combat Patrol: Space Marines|1|3|3|2|low|9900;Citadel Contrast: Black Templar|6|6|4|0|ok|525;Kill Team: Hivestorm|1|0|0|0|untracked|13000"
[ "$(s38_lines report)" = "$S38_EXPECTED_LINES" ] \
  || fail "38: the report's lines read '$(s38_lines report)', expected '$S38_EXPECTED_LINES'"
# 4 products, 3 on a target, 8 on hand, 7 sold, 1 out, 1 below target, 4 to order, 2 open requests (Ordered and Arrived).
[ "$(s38_totals report)" = "4,3,8,7,1,1,4,2" ] || fail "38: the report's totals read '$(s38_totals report)', expected 4,3,8,7,1,1,4,2"
S38_A_IDS="$(printf '%s\n%s\n' "$S38_A1" "$S38_A2" | LC_ALL=C sort | paste -sd, -)"
[ "$(s38_jsf report "[r.lines[1].key, r.lines[1].supplierCode, r.lines[1].sku === '$(s38_record items "$S38_A2" sku)', r.lines[1].itemIds.slice().sort().join()].join('|')")" = "code:99120101|99120101|true|$S38_A_IDS" ] \
  || fail "38: the Combat Patrol line is not one product over both rows, opened from the newest: $(s38_jsf report "r.lines[1]")"
[ "$(s38_jsf report "[r.lines[2].key, r.lines[2].ean, r.lines[2].sku === '$(s38_record items "$S38_B1" sku)', r.lines[2].itemIds.length].join('|')")" = "ean:5011921000001|5011921000001|true|2" ] \
  || fail "38: the Contrast line is not one product over its two rows: $(s38_jsf report "r.lines[2]")"
[ "$(s38_jsf report "[r.lines[0].key, r.lines[3].key].join('|')")" = "title:warhammer 40,000 starter set|title:kill team: hivestorm" ] \
  || fail "38: the lines without a code or barcode are not keyed by title: $(s38_jsf report "[r.lines[0].key, r.lines[3].key]")"
[ "$(s38_jsf report "r.lines.every((l) => l.categoryPath === 'Miniatures and paints')")" = "true" ] \
  || fail "38: the lines' branch is not Miniatures and paints: $(s38_jsf report "r.lines.map((l) => l.categoryPath)")"
grep -q "98765" "$S38_DIR/report.json" && fail "38: the report answered a cost"
grep -q '"cost"' "$S38_DIR/report.json" && fail "38: the report answered a cost field"
[ "$(s38_jsf report "r.lines.map((l) => l.title).join('|').indexOf('S38 Unrelated') + r.lines.map((l) => l.title).join('|').indexOf('Wraithknight')")" = "-2" ] \
  || fail "38: another supplier's stock, or a stock row with no supplier, is on Games Workshop's report"
ok "Games Workshop's report over the last seven days: four products with the shared test's hand-worked in stock, Keep on shelf, sold (kept after the refund, none from the sale outside the range), to order and status, totals 4,3,8,7,1,1,4,2, no cost, and only its own stock"

# Only open requests, oldest first, as StockRequestView.
[ "$(s38_jsf report "r.requests.map((q) => q.id).join()")" = "$S38_R1,$S38_R2" ] \
  || fail "38: the report's requests are $(s38_jsf report "r.requests.map((q) => q.title).join(' | ')"), expected the Ordered one then the Arrived one only"
[ "$(s38_jsf report "(() => { const q = r.requests[0]; return [q.supplierId, q.title, q.qty, q.customerId, q.customerName, q.customerCode, q.contactName, q.status, q.notes, q.createdByName].join('|') })()")" = "$S38_GW|Dark Angels Combat Patrol|3|$S38_CUSTOMER|S38 Customer|$S38_CUSTOMER_CODE||asked|Rang the rep|S38 Sam" ] \
  || fail "38: the first request reads $(s38_jsf report "r.requests[0]")"
[ "$(s38_jsf report "(() => { const q = r.requests[1]; return [q.title, q.qty, q.customerId, q.customerName, q.contactName, q.contactPhone, q.status, q.notes].join('|') })()")" = "Space Marine Heroes|1|||Jo Bloggs|07700 900123|arrived|Wants it for Saturday" ] \
  || fail "38: the second request reads $(s38_jsf report "r.requests[1]")"
[ "$(s38_jsf report "r.requests.every((q) => /^\d{4}-\d{2}-\d{2}T/.test(q.created) && /^\d{4}-\d{2}-\d{2}T/.test(q.statusChangedAt))")" = "true" ] \
  || fail "38: a request's dates are not ISO times: $(s38_jsf report "r.requests[0]")"
ok "the report's requests are the supplier's open ones only (not Collected, Cancelled, another supplier's or none), oldest first, with the customer's name and Guild code and who logged it"

# A longer range reaches the sale thirty days ago; one entirely before it reaches only that.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW&from=$S38_OLD&to=$S38_TODAY")"
s38_expect "$S38_STATUS" 200 "" "a range reaching back thirty days"
s38_keep wide
[ "$(s38_totals wide)" = "4,3,8,8,1,1,4,2" ] || fail "38: the thirty-day totals read '$(s38_totals wide)', expected 4,3,8,8,1,1,4,2 (the Kill Team box now counts)"
[ "$(s38_jsf wide "[r.from, r.to].join()")" = "$S38_OLD,$S38_TODAY" ] || fail "38: the range asked for was not answered back"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW&from=$S38_OLD&to=$S38_OLD")"
s38_expect "$S38_STATUS" 200 "" "the one day thirty days ago"
s38_keep old
[ "$(s38_jsf old "r.lines.map((l) => l.title + ':' + l.sold).join()")" = "Warhammer 40,000 Starter Set:0,Combat Patrol: Space Marines:0,Citadel Contrast: Black Templar:0,Kill Team: Hivestorm:1" ] \
  || fail "38: the day thirty days ago reads $(s38_jsf old "r.lines.map((l) => l.title + ':' + l.sold).join()")"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW&to=$S38_TODAY")"
s38_expect "$S38_STATUS" 200 "" "a range with only a to date"
[ "$(s38_field from)" = "$S38_PERIOD_FROM" ] || fail "38: a to date alone gave from '$(s38_field from)', expected the six days before it, $S38_PERIOD_FROM"

# The other supplier's report has its own product and its own request.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_SUP2")"
s38_expect "$S38_STATUS" 200 "" "the other supplier's report"
s38_keep sup2
[ "$(s38_lines sup2)" = "S38 Wraithknight Box|1|3|0|2|low|20500" ] || fail "38: the other supplier's lines read '$(s38_lines sup2)'"
[ "$(s38_totals sup2)" = "1,1,1,0,0,1,2,1" ] || fail "38: the other supplier's totals read '$(s38_totals sup2)', expected 1,1,1,0,0,1,2,1"
[ "$(s38_jsf sup2 "r.requests.map((q) => q.id).join()")" = "$S38_R5" ] || fail "38: the other supplier's requests are not just its own"
[ "$(s38_jsf sup2 "r.supplier.repName + '|' + r.supplier.accountNumber")" = "Pat|S38-1" ] || fail "38: the other supplier's rep and account are wrong"

# A supplier with nothing yet answers an empty report, not an error.
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_REQUEST_ONLY")"
s38_expect "$S38_STATUS" 200 "" "a supplier with no stock"
[ "$(s38_js "[r.lines.length, r.totals.products, r.totals.openRequests, r.requests.length].join()")" = "0,0,1,1" ] \
  || fail "38: a supplier with no stock did not answer an empty rack and its one request: $(s38_body)"
ok "a longer range reaches back to the sale outside the default week, a to date alone gives the six days before it, and each supplier's report holds only its own stock and requests"

# --- 38g. The route's refusals ---------------------------------------------------

S38_STATUS="$(s38_call "" GET "/api/vault/reorder?supplier=$S38_GW")"
s38_expect "$S38_STATUS" 401 "" "the report with no sign-in"
S38_STATUS="$(s38_call "invalid.token" GET "/api/vault/reorder?supplier=$S38_GW")"
s38_expect "$S38_STATUS" 401 "" "the report with a token that is not valid"
S38_STATUS="$(s38_call "$S38_CUSTOMER_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW")"
s38_refused "$S38_STATUS" "a customer reading the report"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder")"
s38_expect "$S38_STATUS" 400 "Choose a supplier." "the report with no supplier"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=")"
s38_expect "$S38_STATUS" 400 "Choose a supplier." "the report with a blank supplier"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=doesnotexist1")"
s38_expect "$S38_STATUS" 404 "That supplier was not found." "the report for a supplier that does not exist"
S38_DATES="The dates do not make sense. Check the from and to dates."
# From today back 401 days is 402 days with both ends counted; 399 back is 400.
S38_TOO_LONG="$(node -e "process.stdout.write(new Date(Date.parse('${S38_TODAY}T00:00:00Z') - 401 * 86400000).toISOString().slice(0, 10))")"
S38_JUST_LONG_ENOUGH="$(node -e "process.stdout.write(new Date(Date.parse('${S38_TODAY}T00:00:00Z') - 399 * 86400000).toISOString().slice(0, 10))")"
for S38_QUERY in "from=2026-10-10&to=2026-10-01" "from=yesterday&to=$S38_TODAY" "from=$S38_TODAY&to=not-a-date" "from=2026-13-45&to=2026-13-46" \
  "from=2026-02-30&to=2026-03-02" "from=$S38_TOO_LONG&to=$S38_TODAY" "from=junk" "to=junk"; do
  S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW&$S38_QUERY")"
  s38_expect "$S38_STATUS" 400 "$S38_DATES" "the report with $S38_QUERY"
done
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW&from=$S38_JUST_LONG_ENOUGH&to=$S38_TODAY")"
s38_expect "$S38_STATUS" 200 "" "a range of 400 days, both ends counted"
S38_STATUS="$(s38_call "$S38_CLERK_TOKEN" GET "/api/vault/reorder?supplier=$S38_GW&from=$S38_TODAY&to=$S38_TODAY")"
s38_expect "$S38_STATUS" 200 "" "a one-day range"
ok "the report needs a sign-in (401), a supplier (400 Choose a supplier.) that exists (404), and sensible dates (400, from after to, malformed, impossible or over 400 days), and answers any signed-in staff member"

# --- 38h. The agent tools ---------------------------------------------------------

S38_STEP="$(curl -s -X POST "$BASE/api/vault/step-up" -H "Authorization: $S38_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"password\":\"$S38_PASSWORD\"}" | jval token)"
[ -n "$S38_STEP" ] || fail "38: could not get a step-up for the admin"
S38_STATUS="$(curl -s -o "$S38_DIR/agent.json" -w '%{http_code}' -X POST "$BASE/api/vault/agents" -H "Authorization: $S38_ADMIN_TOKEN" \
  -H "X-Step-Up: $S38_STEP" -H "Content-Type: application/json" -d '{"name":"S38 Gandalf"}')"
[ "$S38_STATUS" = "201" ] || fail "38: could not create the section's agent ($S38_STATUS): $(cat "$S38_DIR/agent.json")"
S38_AGENT="$(jval agent.id <"$S38_DIR/agent.json")"
S38_AGENT_TOKEN="$(jval token <"$S38_DIR/agent.json")"
[ -n "$S38_AGENT" ] && [ -n "$S38_AGENT_TOKEN" ] || fail "38: the agent has no id or token"

S38_STATUS="$(curl -s -o "$S38_DIR/rpc.json" -w '%{http_code}' -X POST "$BASE/api/vault/mcp" -H "Authorization: Bearer $S38_AGENT_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
[ "$S38_STATUS" = "200" ] || fail "38: tools/list returned $S38_STATUS"
for S38_NAME in reorder_report stock_request; do
  [ "$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const t = r.result.tools.find((x) => x.name === process.argv[2]);
    process.stdout.write(t && t.description && t.inputSchema && t.inputSchema.type === "object" ? "yes" : "no");
  ' "$S38_DIR/rpc.json" "$S38_NAME")" = "yes" ] || fail "38: tools/list has no described $S38_NAME with a JSON Schema"
done
[ "$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const p = r.result.tools.find((x) => x.name === "stock_update").inputSchema.properties;
  process.stdout.write(["supplier", "shelf_target", "supplier_code"].every((k) => p[k]) ? "yes" : "no");
' "$S38_DIR/rpc.json")" = "yes" ] || fail "38: stock_update does not take supplier, shelf_target and supplier_code"

# stock_update: the three new fields.
S38_TOOL_SKU="$(s38_record items "$S38_WK" sku)"
s38_tool "$S38_AGENT_TOKEN" stock_update "{\"sku\":\"$S38_TOOL_SKU\",\"supplier\":\"games workshop\",\"shelf_target\":4,\"supplier_code\":\"WK-002\"}"
[ "$S38_TOOL_ERROR" = "false" ] && [ "$(s38_tool_js "[t.supplier, t.shelf_target, t.supplier_code].join('|')")" = "Games Workshop|4|WK-002" ] \
  || fail "38: stock_update did not set the supplier by name, the target and the code: $(s38_tool_text)"
[ "$(s38_record items "$S38_WK" supplier)" = "$S38_GW" ] && [ "$(s38_record items "$S38_WK" shelf_target)" = "4" ] || fail "38: stock_update did not reach the stock row"
s38_tool "$S38_AGENT_TOKEN" stock_update "{\"sku\":\"$S38_TOOL_SKU\",\"supplier\":\"$S38_SUP2\",\"shelf_target\":3,\"supplier_code\":\"WK-001\"}"
[ "$S38_TOOL_ERROR" = "false" ] && [ "$(s38_record items "$S38_WK" supplier)" = "$S38_SUP2" ] || fail "38: stock_update did not set the supplier by id: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" stock_update "{\"sku\":\"$S38_TOOL_SKU\",\"supplier\":\"No Such Supplier\"}"
[ "$S38_TOOL_ERROR" = "true" ] && [ "$(s38_tool_text)" = "No supplier is called No Such Supplier. Check the name under Settings, Suppliers." ] \
  || fail "38: an unknown supplier did not come back as a tool error: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" stock_update "{\"sku\":\"$S38_TOOL_SKU\",\"shelf_target\":-1}"
[ "$S38_TOOL_ERROR" = "true" ] || fail "38: a negative shelf_target was not refused: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" stock_get "{\"sku\":\"$S38_TOOL_SKU\"}"
[ "$(s38_tool_js "[t.supplier, t.shelf_target, t.supplier_code].join('|')")" = "S38 Other Supplier|3|WK-001" ] \
  || fail "38: stock_get does not show the supplier, target and code: $(s38_tool_text)"

# reorder_report: the route's answer, by name or id.
s38_tool "$S38_AGENT_TOKEN" reorder_report '{"supplier":"Games Workshop"}'
[ "$S38_TOOL_ERROR" = "false" ] || fail "38: reorder_report failed: $(s38_tool_text)"
cp "$S38_DIR/tool.txt" "$S38_DIR/tool-report.json"
[ "$(s38_lines tool-report)" = "$S38_EXPECTED_LINES" ] && [ "$(s38_totals tool-report)" = "4,3,8,7,1,1,4,2" ] \
  || fail "38: reorder_report by name does not answer the route's lines and totals: $(s38_lines tool-report) / $(s38_totals tool-report)"
[ "$(s38_jsf tool-report "r.lines[0].price_gbp + '|' + r.lines[1].price_gbp")" = "£60.00|£99.00" ] \
  || fail "38: reorder_report has no price in pounds beside the pence: $(s38_jsf tool-report "r.lines[0]")"
s38_tool "$S38_AGENT_TOKEN" reorder_report "{\"supplier\":\"$S38_SUP2\",\"from\":\"$S38_OLD\",\"to\":\"$S38_TODAY\"}"
[ "$S38_TOOL_ERROR" = "false" ] && [ "$(s38_tool_js "t.supplier.name + '|' + t.from + '|' + t.to")" = "S38 Other Supplier|$S38_OLD|$S38_TODAY" ] \
  || fail "38: reorder_report by id and range did not answer that supplier and range: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" reorder_report '{"supplier":"Nobody Ltd"}'
[ "$S38_TOOL_ERROR" = "true" ] && [ "$(s38_tool_text)" = "No supplier is called Nobody Ltd. Check the name under Settings, Suppliers." ] \
  || fail "38: reorder_report for an unknown supplier did not come back as a tool error: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" reorder_report "{\"supplier\":\"Games Workshop\",\"from\":\"$S38_TODAY\",\"to\":\"$S38_OLD\"}"
[ "$S38_TOOL_ERROR" = "true" ] && [ "$(s38_tool_text)" = "$S38_DATES" ] \
  || fail "38: reorder_report with from after to did not carry the route's sentence: $(s38_tool_text)"

# stock_request: created_by empty for the agent, the notes say who logged it.
s38_tool "$S38_AGENT_TOKEN" stock_request "{\"title\":\"Space Wolves Start Collecting\",\"qty\":2,\"supplier\":\"Games Workshop\",\"contact_name\":\"Dan's mate\",\"contact_phone\":\"07700 900999\",\"notes\":\"Wants it for the weekend\"}"
[ "$S38_TOOL_ERROR" = "false" ] || fail "38: stock_request failed: $(s38_tool_text)"
S38_AGENT_REQUEST="$(s38_tool_js "t.id")"
[ "$(s38_tool_js "[t.title, t.qty, t.status, t.supplier, t.contact_name, t.notes].join('|')")" = "Space Wolves Start Collecting|2|waiting|$S38_GW|Dan's mate|Wants it for the weekend Logged by S38 Gandalf." ] \
  || fail "38: the logged request reads $(s38_tool_text)"
[ -n "$S38_AGENT_REQUEST" ] && [ -z "$(s38_record stock_requests "$S38_AGENT_REQUEST" created_by)" ] \
  || fail "38: a request an agent logged has created_by '$(s38_record stock_requests "$S38_AGENT_REQUEST" created_by)', expected none"
s38_tool "$S38_AGENT_TOKEN" stock_request "{\"title\":\"Blood Angels Upgrades\",\"supplier\":\"$S38_GW\",\"customer\":\"$S38_CUSTOMER_CODE\"}"
[ "$S38_TOOL_ERROR" = "false" ] && [ "$(s38_record stock_requests "$(s38_tool_js "t.id")" customer)" = "$S38_CUSTOMER" ] \
  || fail "38: stock_request by a customer code did not name the customer: $(s38_tool_text)"
[ "$(s38_record stock_requests "$(s38_tool_js "t.id")" notes)" = "Logged by S38 Gandalf." ] || fail "38: a request with no notes did not say who logged it"
s38_tool "$S38_AGENT_TOKEN" stock_request '{"title":"Nobody to tell"}'
[ "$S38_TOOL_ERROR" = "true" ] && [ "$(s38_tool_text)" = "Add the customer, or a name to contact, so they can be told when it comes in." ] \
  || fail "38: a request with no customer or contact did not carry the hook's sentence: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" stock_request '{"title":"Nobody","customer":"GGCZZZZZZ"}'
[ "$S38_TOOL_ERROR" = "true" ] && [ "$(s38_tool_text)" = "No customer has that id or code. Search for them by name first." ] \
  || fail "38: a request for an unknown customer did not come back as a tool error: $(s38_tool_text)"
s38_tool "$S38_AGENT_TOKEN" reorder_report '{"supplier":"Games Workshop"}'
cp "$S38_DIR/tool.txt" "$S38_DIR/tool-report2.json"
[ "$(s38_jsf tool-report2 "r.totals.openRequests")" = "4" ] && [ "$(s38_jsf tool-report2 "r.requests.map((q) => q.title).slice(2).join('|')")" = "Space Wolves Start Collecting|Blood Angels Upgrades" ] \
  || fail "38: the agent's requests are not on the report after the others: $(s38_jsf tool-report2 "r.requests.map((q) => q.title).join('|')")"
[ "$(s38_jsf tool-report2 "r.requests[2].createdByName")" = "" ] || fail "38: a request an agent logged names a person who logged it"
s38_tool "$S38_AGENT_TOKEN" stock_update "{\"sku\":\"$S38_TOOL_SKU\",\"supplier\":\"\",\"supplier_code\":\"\"}"
[ "$S38_TOOL_ERROR" = "false" ] && [ -z "$(s38_record items "$S38_WK" supplier)" ] && [ -z "$(s38_record items "$S38_WK" supplier_code)" ] \
  || fail "38: an empty supplier and code did not clear them: $(s38_tool_text)"

# Each tool call is audited under the agent.
for S38_TOOL_NAME in reorder_report stock_request stock_update; do
  [ "$(curl -s -G "$BASE/api/collections/audit_log/records" -H "Authorization: $SUPER_TOKEN" \
    --data-urlencode "filter=action = 'mcp_call' && actor = '$S38_AGENT' && meta.tool = '$S38_TOOL_NAME' && meta.ok = true" | jval totalItems)" -ge 1 ] \
    || fail "38: the $S38_TOOL_NAME call has no mcp_call row under the agent"
done
ok "the agent tools: stock_update sets the supplier (by name or id), Keep on shelf and supplier code and says what is wrong in a sentence; reorder_report answers the route's lines and totals by supplier name; stock_request logs a request with no created_by and 'Logged by <agent>.' in its notes, and its refusals are the hook's sentences"

# --- tidy ---------------------------------------------------------------------------

if [ -z "$S38_TILL_WAS_OPEN" ]; then
  S38_SID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id")"
  S38_EXPECTED_CASH="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected)"
  curl -s -o /dev/null -X POST "$BASE/api/vault/cash-sessions/$S38_SID/close" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"counted\":$S38_EXPECTED_CASH}"
fi
ok "section 38 leaves the till as it found it and its second server stopped"
