# shellcheck shell=bash
# -----------------------------------------------------------------------
# 32. The stock category tree (docs/api-contract-inventory.md, section 1):
#     the seeded tree, creating, renaming and moving a branch with the derived
#     fields rewritten down its subtree, every refusal with its exact sentence
#     and status, the delete rules and Unsorted's protection, reordering and
#     move ordering, `assign` with its audit row and its 500 limit, the
#     stock_manage capability and its override, filing for items created
#     through the collection API, a buy-in, a part-exchange and the Card
#     Uploader import, an unknown branch refused, the tree's shelf counts
#     after stock moves and sells, the till's branch route and the
#     catalogue's `branches`, the lineage filter on the items collection, the
#     X report's category labels, the sales report by category with and
#     without `branch` (and its CSV and saved view), and the quick-key pages
#     migration.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR
# and the ok/fail/jval helpers. It leaves the tree exactly as it found it
# (every branch it adds is deleted, the top level back in its original
# order), the stock it made written off or deleted, and the default
# register's till open as it was.
# -----------------------------------------------------------------------

S32_DIR="$TMP_DIR/s32"
mkdir -p "$S32_DIR"
S32_TODAY="$(date -u +%Y-%m-%d)"

# --- helpers -------------------------------------------------------------

# $1 METHOD, $2 token, $3 path, [$4 JSON body], [$5 an extra header] -> the
# status code; the body is left in $S32_DIR/last.json.
s32_call() {
  local extra=() data=()
  if [ -n "${5:-}" ]; then extra=(-H "$5"); fi
  if [ -n "${4:-}" ]; then data=(-d "$4"); fi
  curl -s -o "$S32_DIR/last.json" -w '%{http_code}' -X "$1" "$BASE$3" \
    -H "Authorization: $2" -H "Content-Type: application/json" ${extra[@]+"${extra[@]}"} ${data[@]+"${data[@]}"}
}
s32_get() { s32_call GET "$1" "$2"; }
s32_post() { s32_call POST "$1" "$2" "$3" "${4:-}"; }

s32_body() { cat "$S32_DIR/last.json"; }
s32_field() { jval "$1" <"$S32_DIR/last.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
s32_expect() {
  [ "$1" = "$2" ] || fail "$4 returned $1, expected $2: $(s32_body)"
  if [ -n "$3" ]; then
    [ "$(s32_field message)" = "$3" ] || fail "$4 said '$(s32_field message)', expected '$3'"
  fi
}

# $1 collection, $2 filter -> the superuser's list of matching records.
s32_list() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    --data-urlencode "perPage=200" --data-urlencode "sort=created,id" "$BASE/api/collections/$1/records"
}

# $1 JS expression over the last response parsed as `r` -> its value (objects as JSON).
s32_js() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$S32_DIR/last.json" "$1"
}

# The category tree as the admin reads it, left in $S32_DIR/tree.json.
s32_tree() {
  curl -s -o "$S32_DIR/tree.json" -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/categories/tree"
}
# $1 JS expression over the tree's branches as `t` -> its value (objects as JSON).
s32_t() {
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).branches;
    const key = (k) => t.find((b) => b.key === k);
    const name = (n) => t.find((b) => b.name === n);
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$S32_DIR/tree.json" "$1"
}
# $1 id, $2 field -> that branch's field from the tree on file.
s32_b() { s32_t "t.find((b) => b.id === '$1').$2"; }

# $1 name, [$2 parent id], [$3 extra JSON fields, leading comma] -> a new branch's id,
# made through the collection API as the admin.
s32_branch() {
  local parent=""
  if [ -n "${2:-}" ]; then parent=",\"parent\":\"$2\""; fi
  local id
  id="$(curl -s -X POST "$BASE/api/collections/categories/records" -H "Authorization: $STAFF_TOKEN" \
    -H "Content-Type: application/json" -d "{\"name\":\"$1\"$parent${3:-}}" | jval id)"
  [ -n "$id" ] || fail "could not create the branch '$1'"
  s32_track branches "$id"
  echo "$id"
}
# Everything this section makes is written to a file, since the helpers run in subshells.
s32_track() { echo "$2" >> "$S32_DIR/made-$1.txt"; }

# $1 title, $2 qty, [$3 kind, default other], [$4 category], [$5 price, default 500],
# [$6 status, default in_stock] -> a new stock row's id.
s32_item() {
  local category=""
  if [ -n "${4:-}" ]; then category=",\"category\":\"$4\""; fi
  local id
  id="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"kind\":\"${3:-other}\",\"game\":\"$S32_GAME\",\"title\":\"$1\",\"qty\":$2,\"cost\":100,\"price\":${5:-500},\"status\":\"${6:-in_stock}\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"$category}" \
    | jval id)"
  [ -n "$id" ] || fail "could not create the stock row '$1'"
  s32_track items "$id"
  echo "$id"
}

# $1 collection, $2 id, $3 field -> that field from the record, as the superuser reads it.
s32_rec() {
  curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/$1/records/$2" | jval "$3"
}

# $1 capability, $2 requested_by -> a raw override token whose sha256 is now a live,
# unused till_overrides row approved by the admin (as 30-sales.sh does).
s32_override() {
  local token hash expires
  token="s32-$1-$RANDOM-$RANDOM-$$"
  hash="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$token")"
  expires="$(node -e 'process.stdout.write(new Date(Date.now() + 5 * 60000).toISOString().replace("T", " "))')"
  curl -s -o "$S32_DIR/override.json" -X POST "$BASE/api/collections/till_overrides/records" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"token_hash\":\"$hash\",\"capability\":\"$1\",\"requested_by\":\"$2\",\"approver\":\"$S32_ADMIN_ID\",\"expires_at\":\"$expires\"}"
  [ -n "$(jval id <"$S32_DIR/override.json")" ] || fail "could not write a $1 override row: $(cat "$S32_DIR/override.json")"
  echo "$token"
}

# The default register's open session, or "".
s32_session() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id"
}
s32_expected() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected
}
# Close the default register's session at its expected total (legacy route).
s32_close_till() {
  local sid
  sid="$(s32_session)"
  [ -n "$sid" ] || return 0
  curl -s -o /dev/null -X POST "$BASE/api/vault/cash-sessions/$sid/close" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"counted\":$(s32_expected)}"
}

# Whether the tree on file is sound: in tree order (parents before children, siblings
# by sort), every path, lineage and depth derived from its parent and every child
# count right. With "seed" as $1 also: every branch active, sorts in tens.
s32_tree_problems() {
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).branches;
    const seed = process.argv[2] === "seed";
    const byId = new Map(t.map((b) => [b.id, b]));
    const problems = [];
    const seen = new Set();
    const lastSort = new Map();
    for (const b of t) {
      const parent = b.parent ? byId.get(b.parent) : null;
      if (b.parent && (!parent || !seen.has(b.parent))) problems.push(`${b.path} comes before its parent`);
      seen.add(b.id);
      const path = parent ? `${parent.path} / ${b.name}` : b.name;
      const lineage = parent ? `${parent.lineage}${b.id}|` : `|${b.id}|`;
      if (b.path !== path) problems.push(`${b.id} path ${b.path} should be ${path}`);
      if (b.lineage !== lineage) problems.push(`${b.id} lineage ${b.lineage} should be ${lineage}`);
      if (b.depth !== (parent ? parent.depth + 1 : 0)) problems.push(`${b.path} depth ${b.depth}`);
      if (b.visible !== (b.active && (!parent || parent.visible))) problems.push(`${b.path} visible ${b.visible}`);
      const before = lastSort.get(b.parent);
      if (before !== undefined && b.sort < before) problems.push(`${b.path} is out of sort order`);
      lastSort.set(b.parent, b.sort);
      if (b.counts.children !== t.filter((c) => c.parent === b.id).length) problems.push(`${b.path} child count`);
      if (seed && (!b.active || !b.visible)) problems.push(`${b.path} is not active and visible`);
      if (seed && b.sort % 10 !== 0) problems.push(`${b.path} sort ${b.sort} is not a multiple of ten`);
    }
    process.stdout.write(problems.slice(0, 5).join("; "));
  ' "$S32_DIR/tree.json" "${1:-}"
}

# --- setup ---------------------------------------------------------------

S32_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S32_RETRO_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27retro%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S32_MTG_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27mtg%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$S32_GAME" ] && [ -n "$S32_RETRO_GAME" ] && [ -n "$S32_MTG_GAME" ] || fail "32: a seeded game is missing"
S32_ADMIN_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval id)"
[ -n "$S32_ADMIN_ID" ] || fail "32: could not read the admin's own id"

# A plain staff member (no stock_manage) and a manager (has it by default).
S32_CLERK_EMAIL="s32-clerk@local.test"
S32_CLERK_PASSWORD="s32-clerk-password-123"
S32_CLERK_ID="$(curl -s -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$S32_CLERK_EMAIL\",\"password\":\"$S32_CLERK_PASSWORD\",\"passwordConfirm\":\"$S32_CLERK_PASSWORD\",\"name\":\"Sam Shelf\",\"role\":\"staff\",\"active\":true}" | jval id)"
S32_CLERK_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" -d "{\"identity\":\"$S32_CLERK_EMAIL\",\"password\":\"$S32_CLERK_PASSWORD\"}" | jval token)"
S32_MANAGER_EMAIL="s32-manager@local.test"
S32_MANAGER_PASSWORD="s32-manager-password-123"
S32_MANAGER_ID="$(curl -s -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$S32_MANAGER_EMAIL\",\"password\":\"$S32_MANAGER_PASSWORD\",\"passwordConfirm\":\"$S32_MANAGER_PASSWORD\",\"name\":\"Max Shelf\",\"role\":\"manager\",\"active\":true}" | jval id)"
S32_MANAGER_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" -d "{\"identity\":\"$S32_MANAGER_EMAIL\",\"password\":\"$S32_MANAGER_PASSWORD\"}" | jval token)"
[ -n "$S32_CLERK_ID" ] && [ -n "$S32_CLERK_TOKEN" ] && [ -n "$S32_MANAGER_ID" ] && [ -n "$S32_MANAGER_TOKEN" ] \
  || fail "32: could not create the plain staff member and the manager"

# --- 32a. The seeded tree ------------------------------------------------
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/categories/tree")"
s32_expect "$S32_STATUS" 200 "" "the category tree for a plain staff member"
cp "$S32_DIR/last.json" "$S32_DIR/tree.json"
S32_ORIGINAL_COUNT="$(s32_t 't.length')"
[ "$S32_ORIGINAL_COUNT" = "235" ] || fail "the seeded tree has $S32_ORIGINAL_COUNT branches, expected 235"
S32_ORIGINAL_TOP="$(s32_t "t.filter((b) => b.parent === '').map((b) => b.id + ':' + b.sort).join()")"
# What is on the shelf in each seeded branch now, to compare at the end.
S32_SHELF_BEFORE="$(s32_t "t.map((b) => b.key + ':' + b.counts.items + ':' + b.counts.items_total + ':' + b.counts.products).join()")"
S32_TREE_PROBLEMS="$(s32_tree_problems seed)"
[ -z "$S32_TREE_PROBLEMS" ] || fail "the seeded tree is not in tree order with its derived fields: $S32_TREE_PROBLEMS"
[ "$(s32_t "t[0].name + '|' + t[0].path + '|' + t[0].depth + '|' + t[0].parent")" = "Trading cards|Trading cards|0|" ] \
  || fail "the tree does not start with Trading cards"
[ "$(s32_t "key('tcg.pokemon.singles').path + '|' + key('tcg.pokemon.singles').depth")" = "Trading cards / Pokémon / Singles|2" ] \
  || fail "tcg.pokemon.singles is not Trading cards / Pokémon / Singles at depth 2"
[ "$(s32_t "key('retro.sega.megadrive.games').path + '|' + key('retro.sega.megadrive.games').depth")" = "Retro / Sega / Mega Drive / Games|3" ] \
  || fail "retro.sega.megadrive.games is not Retro / Sega / Mega Drive / Games at depth 3"
[ "$(s32_t "key('services.tabletime').path")" = "Services / Table time" ] || fail "services.tabletime has the wrong path"
[ "$(s32_t "key('unsorted').name + '|' + key('unsorted').depth + '|' + key('unsorted').parent")" = "Unsorted|0|" ] || fail "Unsorted is not a top-level branch"
S32_PLATFORM_MD="$(curl -s "$BASE/api/collections/platforms/records?filter=key%3D%27megadrive_box%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S32_DEFAULTS_JS="[d.kind, d.game, d.platform, d.tax_scheme].join('|')"
[ "$(s32_t "((d) => $S32_DEFAULTS_JS)(key('tcg.pokemon.singles').defaults)")" = "single|$S32_GAME||margin" ] \
  || fail "the Pokémon singles defaults are wrong: $(s32_t "JSON.stringify(key('tcg.pokemon.singles').defaults)")"
[ "$(s32_t "((d) => $S32_DEFAULTS_JS)(key('retro.sega.megadrive.games').defaults)")" = "retro|$S32_RETRO_GAME|$S32_PLATFORM_MD|margin" ] \
  || fail "the Mega Drive games defaults do not carry the game and platform ids: $(s32_t "JSON.stringify(key('retro.sega.megadrive.games').defaults)")"
[ "$(s32_t "t.filter((b) => b.key).length")" = "235" ] || fail "every seeded branch should carry its key"
[ "$(s32_t "t.filter((b) => b.image_url !== '').length")" = "0" ] || fail "a seeded branch has an image"
# Active till products by home branch, as the migration filed them: the open-price
# Single card on Trading cards, an hour of table time, event entry, the deposit on
# Services, and the switched-off membership (not counted).
[ "$(s32_t "key('tcg').counts.products + ',' + key('services.tabletime').counts.products + ',' + key('services.events').counts.products + ',' + key('services').counts.products + ',' + key('services.memberships').counts.products")" = "1,1,1,1,0" ] \
  || fail "the seeded till products are not counted on their branches: $(s32_t "key('tcg').counts.products + ',' + key('services.tabletime').counts.products + ',' + key('services.events').counts.products + ',' + key('services').counts.products + ',' + key('services.memberships').counts.products")"
S32_STATUS="$(s32_get "invalid.token" "/api/vault/categories/tree")"
[ "$S32_STATUS" = "401" ] || fail "the tree answered $S32_STATUS to a request with no valid sign-in"
ok "the seeded tree has 235 branches in tree order with their derived fields, keys and defaults resolved to ids, read by plain staff"

# --- 32b. Creating, renaming and moving: the derived fields follow --------
# A four-level branch, A > B > C > D: three levels below the top.
S32_A="$(s32_branch "Check A")"
S32_B="$(s32_branch "Check B" "$S32_A")"
S32_C="$(s32_branch "Check C" "$S32_B")"
S32_D="$(s32_branch "Check D" "$S32_C")"
s32_tree
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after adding four nested branches the tree is unsound: $S32_PROBLEMS"
[ "$(s32_t "t.length")" = "$((S32_ORIGINAL_COUNT + 4))" ] || fail "the four new branches are not all in the tree"
[ "$(s32_b "$S32_D" path)|$(s32_b "$S32_D" depth)" = "Check A / Check B / Check C / Check D|3" ] \
  || fail "a branch three levels down has the path '$(s32_b "$S32_D" path)' at depth '$(s32_b "$S32_D" depth)'"
[ "$(s32_b "$S32_D" lineage)" = "|$S32_A|$S32_B|$S32_C|$S32_D|" ] || fail "the lineage of a branch three levels down is '$(s32_b "$S32_D" lineage)'"
# A branch sent with no `active` or `sort` is on and goes last at its level (the
# seeded top level ends at 90).
[ "$(s32_b "$S32_A" active)|$(s32_b "$S32_A" sort)|$(s32_b "$S32_B" sort)" = "true|100|10" ] \
  || fail "a new branch with no active or sort is '$(s32_b "$S32_A" active)' at sort '$(s32_b "$S32_A" sort)'"

# A request cannot choose the derived fields or the key.
S32_E_JSON="$(curl -s -X POST "$BASE/api/collections/categories/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Check E\",\"parent\":\"$S32_A\",\"path\":\"bogus\",\"lineage\":\"|x|\",\"depth\":5,\"key\":\"tcg.pokemon.singles\",\"sort\":7,\"active\":false}")"
S32_E="$(echo "$S32_E_JSON" | jval id)"
[ -n "$S32_E" ] || fail "a branch sent with its own path, lineage, depth and a taken key was refused: $S32_E_JSON"
s32_track branches "$S32_E"
[ "$(echo "$S32_E_JSON" | jval path)|$(echo "$S32_E_JSON" | jval depth)|$(echo "$S32_E_JSON" | jval key)" = "Check A / Check E|1|" ] \
  && [ "$(echo "$S32_E_JSON" | jval lineage)" = "|$S32_A|$S32_E|" ] \
  || fail "a request chose a branch's derived fields or key: $S32_E_JSON"
[ "$(echo "$S32_E_JSON" | jval active)|$(echo "$S32_E_JSON" | jval sort)" = "false|7" ] || fail "an explicit active and sort were not kept: $S32_E_JSON"
S32_KEY_JSON="$(curl -s -X PATCH "$BASE/api/collections/categories/records/$(s32_t "key('tcg.pokemon.singles').id")" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"key":"hijacked","path":"Nowhere","depth":4}')"
[ "$(echo "$S32_KEY_JSON" | jval key)|$(echo "$S32_KEY_JSON" | jval path)|$(echo "$S32_KEY_JSON" | jval depth)" = "tcg.pokemon.singles|Trading cards / Pokémon / Singles|2" ] \
  || fail "a request changed a seeded branch's key or derived fields: $S32_KEY_JSON"

# Renaming a branch in the middle rewrites everything beneath it, in the one request.
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/categories/records/$S32_B" '{"name":"  Check B2 ","path":"bogus","lineage":"hack"}')"
s32_expect "$S32_STATUS" 200 "" "renaming the middle branch"
[ "$(s32_field name)" = "Check B2" ] || fail "a renamed branch's name was not trimmed: '$(s32_field name)'"
s32_tree
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after a rename the tree is unsound: $S32_PROBLEMS"
[ "$(s32_b "$S32_B" path)" = "Check A / Check B2" ] && [ "$(s32_b "$S32_C" path)" = "Check A / Check B2 / Check C" ] \
  && [ "$(s32_b "$S32_D" path)" = "Check A / Check B2 / Check C / Check D" ] \
  || fail "a rename did not reach the branches beneath: $(s32_b "$S32_C" path) / $(s32_b "$S32_D" path)"
# ... and the stored rows say the same as the tree (the tree route derives from names).
[ "$(s32_rec categories "$S32_D" path)" = "Check A / Check B2 / Check C / Check D" ] \
  && [ "$(s32_rec categories "$S32_D" depth)" = "3" ] || fail "the stored path of the deepest branch is '$(s32_rec categories "$S32_D" path)'"

S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/categories/records/$S32_A" '{"name":"Check A2"}')"
s32_expect "$S32_STATUS" 200 "" "renaming the top branch"
s32_tree
[ "$(s32_b "$S32_D" path)" = "Check A2 / Check B2 / Check C / Check D" ] && [ "$(s32_b "$S32_E" path)" = "Check A2 / Check E" ] \
  || fail "renaming the top branch did not reach every branch beneath it"

# Moving the middle branch to another top-level branch carries its subtree.
S32_Z="$(s32_branch "Check Z")"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/categories/records/$S32_B" "{\"parent\":\"$S32_Z\"}")"
s32_expect "$S32_STATUS" 200 "" "moving a branch with branches beneath it"
s32_tree
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after a move the tree is unsound: $S32_PROBLEMS"
[ "$(s32_b "$S32_B" path)|$(s32_b "$S32_B" depth)" = "Check Z / Check B2|1" ] \
  && [ "$(s32_b "$S32_D" path)|$(s32_b "$S32_D" depth)" = "Check Z / Check B2 / Check C / Check D|3" ] \
  && [ "$(s32_b "$S32_D" lineage)" = "|$S32_Z|$S32_B|$S32_C|$S32_D|" ] \
  || fail "a move did not rewrite the subtree: $(s32_b "$S32_D" path) $(s32_b "$S32_D" lineage)"
[ "$(s32_rec categories "$S32_D" lineage)" = "|$S32_Z|$S32_B|$S32_C|$S32_D|" ] || fail "the stored lineage of the moved subtree is stale"
ok "a branch is trimmed, filed last and on by default; path, lineage, depth and key cannot be chosen by a request; a rename or a move rewrites every branch beneath it, three levels down"

# --- 32c. The refusals on create and update -------------------------------
S32_CATS="/api/collections/categories/records"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" "{\"name\":\"   \",\"parent\":\"$S32_Z\"}")"
s32_expect "$S32_STATUS" 400 "Give the branch a name." "a branch with a blank name"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" '{"name":"No parent needed"}')"
s32_expect "$S32_STATUS" 200 "" "a top-level branch with no parent"
s32_track branches "$(s32_field id)"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_C" '{"name":""}')"
s32_expect "$S32_STATUS" 400 "Give the branch a name." "renaming a branch to nothing"
S32_LONG="$(node -e 'process.stdout.write("x".repeat(61))')"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" "{\"name\":\"$S32_LONG\"}")"
s32_expect "$S32_STATUS" 400 "Branch names are 60 characters at most. Shorten it." "a 61-character name"
S32_LONG="$(node -e 'process.stdout.write("y".repeat(60))')"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" "{\"name\":\"$S32_LONG\"}")"
s32_expect "$S32_STATUS" 200 "" "a 60-character name"
s32_track branches "$(s32_field id)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" '{"name":"Orphan","parent":"nosuchbranch001"}')"
s32_expect "$S32_STATUS" 400 "That parent branch was not found." "a branch under a parent that does not exist"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_C" '{"parent":"nosuchbranch001"}')"
s32_expect "$S32_STATUS" 400 "That parent branch was not found." "moving a branch under a parent that does not exist"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_B" "{\"parent\":\"$S32_B\"}")"
s32_expect "$S32_STATUS" 400 "A branch cannot go inside itself or one of its own branches." "a branch inside itself"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_B" "{\"parent\":\"$S32_D\"}")"
s32_expect "$S32_STATUS" 400 "A branch cannot go inside itself or one of its own branches." "a branch inside its own subtree"
# Siblings are unique whatever the case; the same name elsewhere is fine.
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" "{\"name\":\"check b2\",\"parent\":\"$S32_Z\"}")"
s32_expect "$S32_STATUS" 400 "There is already a branch called check b2 here." "a sibling whose name differs only by case"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" '{"name":"CHECK Z"}')"
s32_expect "$S32_STATUS" 400 "There is already a branch called CHECK Z here." "a top-level branch whose name differs only by case"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_E" "{\"name\":\"Check B2\",\"parent\":\"$S32_Z\"}")"
s32_expect "$S32_STATUS" 400 "There is already a branch called Check B2 here." "moving a branch onto a sibling's name"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" "{\"name\":\"Check B2\",\"parent\":\"$S32_A\"}")"
s32_expect "$S32_STATUS" 200 "" "the same name under a different parent"
s32_track branches "$(s32_field id)"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_E" '{"name":"Check E"}')"
s32_expect "$S32_STATUS" 200 "" "saving a branch under its own name"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_E" '{"name":"CHECK E"}')"
s32_expect "$S32_STATUS" 200 "" "changing only the case of a branch's own name"
# Eight levels at most: a root and seven below it is eight deep, a ninth is refused.
S32_R="$(s32_branch "Check Deep")"
S32_PARENT="$S32_R"
for S32_LEVEL in 1 2 3 4 5 6 7; do
  S32_PARENT="$(s32_branch "Check Level $S32_LEVEL" "$S32_PARENT")"
  if [ "$S32_LEVEL" = "6" ]; then S32_L6="$S32_PARENT"; fi
done
S32_L7="$S32_PARENT"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_CATS" "{\"name\":\"Too deep\",\"parent\":\"$S32_L7\"}")"
s32_expect "$S32_STATUS" 400 "Branches go 8 levels deep at most. Put this one higher up." "a ninth level"
# A branch with a branch beneath it needs two levels of room (C > D is two deep).
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_C" "{\"parent\":\"$S32_L6\"}")"
s32_expect "$S32_STATUS" 400 "Branches go 8 levels deep at most. Put this one higher up." "a subtree that would reach a ninth level"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_D" "{\"parent\":\"$S32_L6\"}")"
s32_expect "$S32_STATUS" 200 "" "a leaf under the seventh level"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_D" "{\"parent\":\"$S32_C\"}")"
s32_expect "$S32_STATUS" 200 "" "putting that leaf back"
s32_tree
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after the refusals the tree is unsound: $S32_PROBLEMS"
[ "$(s32_b "$S32_L7" depth)" = "7" ] || fail "the seventh level is at depth $(s32_b "$S32_L7" depth)"
# Who may write a branch through the collection API is still the collection's rule.
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "$S32_CATS" '{"name":"Clerk branch"}')"
[ "$S32_STATUS" != "200" ] || fail "a plain staff member created a branch through the collection API"
S32_STATUS="$(s32_post "$S32_MANAGER_TOKEN" "$S32_CATS" '{"name":"Manager branch"}')"
s32_expect "$S32_STATUS" 200 "" "a manager adding a branch"
s32_track branches "$(s32_field id)"
[ "$(s32_field path)" = "Manager branch" ] || fail "a manager's branch has the path '$(s32_field path)'"
ok "every refusal on create and update says what happened: a blank or long name, a missing parent, a branch inside itself or its own branches, a sibling's name in any case, a ninth level or a subtree that would reach one"

# --- 32d. Deleting a branch ------------------------------------------------
# Check H holds two branches, three stock rows (one of them sold: history counts)
# and one till product.
S32_H="$(s32_branch "Check H")"
S32_H1="$(s32_branch "Check H1" "$S32_H")"
S32_H2="$(s32_branch "Check H2" "$S32_H")"
S32_HI1="$(s32_item "Check H stock 1" 2 other "$S32_H")"
S32_HI2="$(s32_item "Check H stock 2" 1 other "$S32_H")"
S32_HI3="$(s32_item "Check H stock 3 (sold)" 0 other "$S32_H" 500 sold)"
S32_HP="$(curl -s -X POST "$BASE/api/collections/till_products/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Check H product\",\"kind\":\"service\",\"price\":100,\"tax_scheme\":\"standard\",\"active\":true,\"category\":\"$S32_H\"}" | jval id)"
[ -n "$S32_HP" ] || fail "could not create the check till product"
s32_track products "$S32_HP"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H")"
s32_expect "$S32_STATUS" 409 "Check H still holds 2 branches, 3 stock rows and 1 till product. Move them out or switch the branch off." "deleting a branch that holds branches, stock and a product"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H1")"
[ "$S32_STATUS" = "204" ] || fail "deleting an empty branch returned $S32_STATUS"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H")"
s32_expect "$S32_STATUS" 409 "Check H still holds 1 branch, 3 stock rows and 1 till product. Move them out or switch the branch off." "deleting a branch that holds one branch"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H2")"
[ "$S32_STATUS" = "204" ] || fail "deleting the second empty branch returned $S32_STATUS"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H")"
s32_expect "$S32_STATUS" 409 "Check H still holds 3 stock rows and 1 till product. Move them out or switch the branch off." "deleting a branch that holds stock and a product"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/assign" "{\"category\":\"$S32_Z\",\"products\":[\"$S32_HP\"]}")"
s32_expect "$S32_STATUS" 200 "" "filing the product elsewhere"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H")"
s32_expect "$S32_STATUS" 409 "Check H still holds 3 stock rows. Move them out or switch the branch off." "deleting a branch that holds only stock"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/assign" "{\"category\":\"$S32_Z\",\"items\":[\"$S32_HI1\",\"$S32_HI2\"]}")"
s32_expect "$S32_STATUS" 200 "" "filing two of the stock rows elsewhere"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H")"
s32_expect "$S32_STATUS" 409 "Check H still holds 1 stock row. Move them out or switch the branch off." "deleting a branch that holds a sold stock row"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/assign" "{\"category\":\"$S32_Z\",\"items\":[\"$S32_HI3\"]}")"
s32_expect "$S32_STATUS" 200 "" "filing the sold stock row elsewhere"
S32_STATUS="$(s32_call DELETE "$S32_CLERK_TOKEN" "$S32_CATS/$S32_H")"
[ "$S32_STATUS" != "204" ] || fail "a plain staff member deleted a branch through the collection API"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_H")"
[ "$S32_STATUS" = "204" ] || fail "deleting an emptied branch returned $S32_STATUS"
# A branch with only one branch in it, and nothing else, names just that.
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_B")"
s32_expect "$S32_STATUS" 409 "Check B2 still holds 1 branch. Move them out or switch the branch off." "deleting a branch that holds only a branch"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_D")"
[ "$S32_STATUS" = "204" ] || fail "deleting an empty leaf returned $S32_STATUS"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_C")"
[ "$S32_STATUS" = "204" ] || fail "deleting a branch whose only branch was just deleted returned $S32_STATUS"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_B")"
[ "$S32_STATUS" = "204" ] || fail "deleting a branch with no branches left returned $S32_STATUS"

# Unsorted can be neither deleted nor switched off.
S32_UNSORTED="$(s32_t "key('unsorted').id")"
S32_STATUS="$(s32_call DELETE "$STAFF_TOKEN" "$S32_CATS/$S32_UNSORTED")"
s32_expect "$S32_STATUS" 409 "Unsorted is where stock with no branch goes, so it stays." "deleting Unsorted"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_UNSORTED" '{"active":false}')"
s32_expect "$S32_STATUS" 409 "Unsorted is where stock with no branch goes, so it stays." "switching Unsorted off"
# Nor off by switching off a branch it sits in.
S32_U_HOME="$(s32_branch "Check U home")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_UNSORTED/move" "{\"parent\":\"$S32_U_HOME\"}")"
s32_expect "$S32_STATUS" 200 "" "moving Unsorted into a branch"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_U_HOME" '{"active":false}')"
s32_expect "$S32_STATUS" 409 "Unsorted is where stock with no branch goes, so it stays." "switching off the branch Unsorted is in"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_UNSORTED/move" '{"parent":""}')"
s32_expect "$S32_STATUS" 200 "" "moving Unsorted back to the top"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_U_HOME" '{"active":false}')"
s32_expect "$S32_STATUS" 200 "" "switching off a branch Unsorted has left"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "$S32_CATS/$S32_U_HOME" '{"active":true}')"
s32_expect "$S32_STATUS" 200 "" "switching it back on"
s32_tree
[ "$(s32_t "key('unsorted').active + ',' + key('unsorted').parent")" = "true," ] || fail "Unsorted is not a top-level, active branch any more"
ok "a branch that holds branches, stock rows (sold ones too) or till products cannot be deleted, the sentence naming only what is there; an empty one can; Unsorted can be neither deleted nor switched off, nor can the branch it sits in"

# --- 32e. Reordering and move ordering -------------------------------------
S32_P="$(s32_branch "Check P")"
S32_P1="$(s32_branch "Check P1" "$S32_P")"
S32_P2="$(s32_branch "Check P2" "$S32_P")"
S32_P3="$(s32_branch "Check P3" "$S32_P")"
s32_tree
# Children are filed last, ten apart.
[ "$(s32_t "t.filter((b) => b.parent === '$S32_P').map((b) => b.name + ':' + b.sort).join(',')")" = "Check P1:10,Check P2:20,Check P3:30" ] \
  || fail "new children are not filed last, ten apart"
S32_ORDER="/api/vault/categories/reorder"
# $1 parent id -> the children of that branch in the last response, "name:sort,..."
s32_children() { s32_js "r.branches.filter((b) => b.parent === '$1').map((b) => b.name + ':' + b.sort).join(',')"; }
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" "{\"parent\":\"$S32_P\",\"order\":[\"$S32_P3\",\"$S32_P1\",\"$S32_P2\"]}")"
s32_expect "$S32_STATUS" 200 "" "reordering the children of a branch"
[ "$(s32_children "$S32_P")" = "Check P3:10,Check P1:20,Check P2:30" ] || fail "the reorder answered the wrong order: $(s32_children "$S32_P")"
cp "$S32_DIR/last.json" "$S32_DIR/tree.json"
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after a reorder the tree is unsound: $S32_PROBLEMS"
S32_MISMATCH="That order does not match the branches here. Reload and try again."
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" "{\"parent\":\"$S32_P\",\"order\":[\"$S32_P3\",\"$S32_P1\"]}")"
s32_expect "$S32_STATUS" 400 "$S32_MISMATCH" "an order that leaves a child out"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" "{\"parent\":\"$S32_P\",\"order\":[\"$S32_P3\",\"$S32_P1\",\"$S32_P2\",\"$S32_P2\"]}")"
s32_expect "$S32_STATUS" 400 "$S32_MISMATCH" "an order that names a child twice"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" "{\"parent\":\"$S32_P\",\"order\":[\"$S32_P3\",\"$S32_P1\",\"$S32_Z\"]}")"
s32_expect "$S32_STATUS" 400 "$S32_MISMATCH" "an order that names a branch from elsewhere"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" "{\"parent\":\"$S32_P\",\"order\":[\"$S32_P3\",\"$S32_P1\",\"nosuchbranch001\"]}")"
s32_expect "$S32_STATUS" 400 "$S32_MISMATCH" "an order that names a branch that does not exist"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" "{\"parent\":\"$S32_P\",\"order\":[]}")"
s32_expect "$S32_STATUS" 400 "$S32_MISMATCH" "an empty order"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ORDER" '{"parent":"nosuchbranch001","order":[]}')"
s32_expect "$S32_STATUS" 400 "That parent branch was not found." "reordering the children of a branch that does not exist"
s32_tree
[ "$(s32_t "t.filter((b) => b.parent === '$S32_P').map((b) => b.name).join(',')")" = "Check P3,Check P1,Check P2" ] \
  || fail "a refused reorder changed the order"

# Moving: before a sibling, last, to another parent (renumbered 10, 20, 30), to the top.
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P2/move" "{\"parent\":\"$S32_P\",\"before\":\"$S32_P3\"}")"
s32_expect "$S32_STATUS" 200 "" "moving a branch before its sibling"
[ "$(s32_children "$S32_P")" = "Check P2:10,Check P3:20,Check P1:30" ] || fail "moving before a sibling gave $(s32_children "$S32_P")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P3/move" "{\"parent\":\"$S32_P\"}")"
s32_expect "$S32_STATUS" 200 "" "moving a branch to the end of its own parent"
[ "$(s32_children "$S32_P")" = "Check P2:10,Check P1:20,Check P3:30" ] || fail "moving last gave $(s32_children "$S32_P")"
S32_Q="$(s32_branch "Check Q")"
S32_Q1="$(s32_branch "Check Q1" "$S32_Q")"
S32_Q2="$(s32_branch "Check Q2" "$S32_Q")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P1/move" "{\"parent\":\"$S32_Q\",\"before\":\"$S32_Q2\"}")"
s32_expect "$S32_STATUS" 200 "" "moving a branch under another parent, before a child there"
[ "$(s32_children "$S32_Q")" = "Check Q1:10,Check P1:20,Check Q2:30" ] || fail "moving under a new parent gave $(s32_children "$S32_Q")"
cp "$S32_DIR/last.json" "$S32_DIR/tree.json"
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after moves the tree is unsound: $S32_PROBLEMS"
[ "$(s32_b "$S32_P1" path)" = "Check Q / Check P1" ] || fail "a branch moved by the route has the path '$(s32_b "$S32_P1" path)'"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P1/move" '{"parent":""}')"
s32_expect "$S32_STATUS" 200 "" "moving a branch to the top level"
[ "$(s32_js "r.branches.filter((b) => b.id === '$S32_P1').map((b) => b.parent + '|' + b.depth + '|' + b.path).join()")" = "|0|Check P1" ] \
  || fail "moving to the top level gave $(s32_js "r.branches.filter((b) => b.id === '$S32_P1').map((b) => b.parent + '|' + b.depth + '|' + b.path).join()")"
# The refusals.
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P2/move" "{\"parent\":\"$S32_Q\",\"before\":\"$S32_P3\"}")"
s32_expect "$S32_STATUS" 400 "That branch is not under the new parent." "a 'before' sibling that is under another parent"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P2/move" "{\"parent\":\"$S32_P\",\"before\":\"$S32_P2\"}")"
s32_expect "$S32_STATUS" 400 "That branch is not under the new parent." "a branch placed before itself"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P/move" "{\"parent\":\"$S32_P3\"}")"
s32_expect "$S32_STATUS" 400 "A branch cannot go inside itself or one of its own branches." "a branch moved into its own subtree"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P2/move" '{"parent":"nosuchbranch001"}')"
s32_expect "$S32_STATUS" 400 "That parent branch was not found." "a move under a parent that does not exist"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/nosuchbranch001/move" '{"parent":""}')"
s32_expect "$S32_STATUS" 404 "That branch was not found." "moving a branch that does not exist"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_L7/move" "{\"parent\":\"$S32_L7\"}")"
s32_expect "$S32_STATUS" 400 "A branch cannot go inside itself or one of its own branches." "a branch moved into itself"
S32_CLASH="$(s32_branch "Check Q1")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_CLASH/move" "{\"parent\":\"$S32_Q\"}")"
s32_expect "$S32_STATUS" 400 "There is already a branch called Check Q1 here." "a move onto a sibling's name"
S32_WIDE="$(s32_branch "Check Wide")"
S32_WIDE_CHILD="$(s32_branch "Check Wide child" "$S32_WIDE")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_WIDE/move" "{\"parent\":\"$S32_L6\"}")"
s32_expect "$S32_STATUS" 400 "Branches go 8 levels deep at most. Put this one higher up." "a move whose subtree would reach a ninth level"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/$S32_P2/move" '{}')"
s32_expect "$S32_STATUS" 400 "That parent branch was not found." "a move that names no parent"
s32_tree
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "after the refused moves the tree is unsound: $S32_PROBLEMS"
ok "reorder numbers the children 10, 20, 30 in the order given and refuses any list that is not every child once; move places a branch before a sibling, last, under another parent or at the top, and says why when it cannot"

# --- 32f. Filing stock and products into a branch (assign) -----------------
# Stock made with no branch lands in Unsorted; assign is how it is emptied.
s32_tree
S32_UNSORTED_BEFORE="$(s32_b "$S32_UNSORTED" counts.items)"
S32_T="$(s32_branch "Check T")"
S32_F1="$(s32_item "Check file 1" 1 other)"
S32_F2="$(s32_item "Check file 2" 1 other)"
[ "$(s32_rec items "$S32_F1" category)" = "$S32_UNSORTED" ] && [ "$(s32_rec items "$S32_F2" category)" = "$S32_UNSORTED" ] \
  || fail "stock made with no branch is not in Unsorted"
s32_tree
[ "$(s32_b "$S32_UNSORTED" counts.items)" = "$((S32_UNSORTED_BEFORE + 2))" ] || fail "Unsorted does not count the two new rows"
S32_ASSIGN="/api/vault/categories/assign"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_T\",\"items\":[\"$S32_F1\",\"$S32_F2\"]}")"
s32_expect "$S32_STATUS" 200 "" "filing two stock rows"
[ "$(s32_field items)|$(s32_field products)" = "2|0" ] || fail "assign answered $(s32_body), expected 2 stock rows and 0 products"
[ "$(s32_rec items "$S32_F1" category)" = "$S32_T" ] && [ "$(s32_rec items "$S32_F2" category)" = "$S32_T" ] || fail "assign did not move the stock rows"
s32_tree
[ "$(s32_b "$S32_UNSORTED" counts.items)" = "$S32_UNSORTED_BEFORE" ] && [ "$(s32_b "$S32_T" counts.items)" = "2" ] \
  || fail "emptying Unsorted into a branch left the counts at $(s32_b "$S32_UNSORTED" counts.items) and $(s32_b "$S32_T" counts.items)"
S32_AUDIT="$(s32_list audit_log "action='category_assign' && record='$S32_T'")"
[ "$(echo "$S32_AUDIT" | jval totalItems)" = "1" ] || fail "assign wrote $(echo "$S32_AUDIT" | jval totalItems) audit rows, expected 1"
[ "$(echo "$S32_AUDIT" | jval items.0.collection)|$(echo "$S32_AUDIT" | jval items.0.actor)|$(echo "$S32_AUDIT" | jval items.0.meta.category)|$(echo "$S32_AUDIT" | jval items.0.meta.items)|$(echo "$S32_AUDIT" | jval items.0.meta.products)" \
  = "categories|$S32_ADMIN_ID|$S32_T|2|0" ] || fail "the category_assign audit row is wrong: $S32_AUDIT"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_T\",\"products\":[\"$S32_HP\"],\"items\":[\"$S32_F1\"]}")"
s32_expect "$S32_STATUS" 200 "" "filing a product and a stock row already there"
[ "$(s32_field items)|$(s32_field products)" = "1|1" ] || fail "assign answered $(s32_body), expected 1 and 1"
[ "$(s32_rec till_products "$S32_HP" category)" = "$S32_T" ] || fail "assign did not move the till product"
[ "$(s32_list audit_log "action='category_assign' && record='$S32_T'" | jval totalItems)" = "2" ] || fail "the second assign did not write its own audit row"

S32_BEFORE_REFUSALS="$(s32_rec items "$S32_F1" category)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_UNSORTED\"}")"
s32_expect "$S32_STATUS" 400 "Choose the stock rows or till products to file." "filing nothing"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_UNSORTED\",\"items\":[\"$S32_F1\",\"nosuchitem00001\"]}")"
s32_expect "$S32_STATUS" 404 "One of those was not found. Reload and try again." "filing a stock row that does not exist"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_UNSORTED\",\"products\":[\"$S32_HP\",\"nosuchproduct01\"]}")"
s32_expect "$S32_STATUS" 404 "One of those was not found. Reload and try again." "filing a till product that does not exist"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"nosuchbranch001\",\"items\":[\"$S32_F1\"]}")"
s32_expect "$S32_STATUS" 400 "That branch was not found." "filing into a branch that does not exist"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"items\":[\"$S32_F1\"]}")"
s32_expect "$S32_STATUS" 400 "That branch was not found." "filing with no branch named"
[ "$(s32_rec items "$S32_F1" category)" = "$S32_BEFORE_REFUSALS" ] && [ "$(s32_rec till_products "$S32_HP" category)" = "$S32_T" ] \
  || fail "a refused assign moved something"
[ "$(s32_list audit_log "action='category_assign' && record='$S32_UNSORTED'" | jval totalItems)" = "0" ] || fail "a refused assign wrote an audit row"

# 500 at most between stock rows and products; 2,000 rows to file from.
s32_bulk() {
  node -e '
    (async () => {
      const [base, token, count, category, prefix, game] = process.argv.slice(1);
      const ids = [];
      for (let start = 0; start < Number(count); start += 100) {
        const requests = [];
        for (let i = start; i < Math.min(start + 100, Number(count)); i += 1) {
          const body = { kind: "other", game, title: `${prefix} ${String(i + 1).padStart(4, "0")}`, qty: 1, cost: 100, price: 500, status: "in_stock", tax_scheme: "margin", source: "supplier" };
          if (category) body.category = category;
          requests.push({ method: "POST", url: "/api/collections/items/records", body });
        }
        const res = await fetch(`${base}/api/batch`, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ requests }) });
        if (!res.ok) { console.error(await res.text()); process.exit(1); }
        for (const part of await res.json()) {
          if (part.status !== 200) { console.error(JSON.stringify(part)); process.exit(1); }
          ids.push(part.body.id);
        }
      }
      process.stdout.write(ids.join(" "));
    })();
  ' "$BASE" "$STAFF_TOKEN" "$1" "$2" "$3" "$S32_GAME"
}
# $1.. ids -> deletes those stock rows through the batch API.
s32_bulk_delete() {
  node -e '
    (async () => {
      const [base, token, ...ids] = process.argv.slice(1);
      for (let i = 0; i < ids.length; i += 100) {
        const requests = ids.slice(i, i + 100).map((id) => ({ method: "DELETE", url: `/api/collections/items/records/${id}` }));
        const res = await fetch(`${base}/api/batch`, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ requests }) });
        if (!res.ok) { console.error(await res.text()); process.exit(1); }
      }
    })();
  ' "$BASE" "$STAFF_TOKEN" "$@"
}
S32_BK="$(s32_branch "Check Bulk")"
S32_BULK_IDS="$(s32_bulk 2000 "$S32_BK" "Bulk row")"
[ "$(echo "$S32_BULK_IDS" | wc -w | tr -d ' ')" = "2000" ] || fail "could not make 2,000 stock rows"
S32_BT="$(s32_branch "Check Bulk target")"
S32_ID_LIST() { echo "$S32_BULK_IDS" | tr ' ' '\n' | sed -n "$1,$2p" | sed 's/.*/"&"/' | paste -sd, -; }
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_BT\",\"items\":[$(S32_ID_LIST 1 501)]}")"
s32_expect "$S32_STATUS" 400 "File up to 500 at a time." "filing 501 stock rows"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_BT\",\"items\":[$(S32_ID_LIST 1 500)],\"products\":[\"$S32_HP\"]}")"
s32_expect "$S32_STATUS" 400 "File up to 500 at a time." "filing 500 stock rows and a product (501 between them)"
[ "$(s32_rec items "$(echo "$S32_BULK_IDS" | cut -d' ' -f1)" category)" = "$S32_BK" ] || fail "a refused assign moved a stock row"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_BT\",\"items\":[$(S32_ID_LIST 1 500)]}")"
s32_expect "$S32_STATUS" 200 "" "filing exactly 500 stock rows"
[ "$(s32_field items)|$(s32_field products)" = "500|0" ] || fail "assign answered $(s32_body), expected 500 and 0"
s32_tree
[ "$(s32_b "$S32_BT" counts.items)|$(s32_b "$S32_BK" counts.items)" = "500|1500" ] || fail "after filing 500 the counts are $(s32_b "$S32_BT" counts.items) and $(s32_b "$S32_BK" counts.items)"
[ "$(s32_list audit_log "action='category_assign' && record='$S32_BT'" | jval "items.0.meta.items")" = "500" ] || fail "the 500-row assign was not audited with its count"
ok "assign files stock rows and till products into a branch in one request, answers how many of each, writes one category_assign audit row, empties Unsorted, and refuses nothing chosen, an id that is missing, an unknown branch or more than 500"

# --- 32g. stock_manage and its override ------------------------------------
S32_MOVE_BODY="{\"parent\":\"$S32_Q\"}"
S32_ORDER_BODY="{\"parent\":\"$S32_Q\",\"order\":[\"$S32_Q2\",\"$S32_Q1\"]}"
S32_ASSIGN_BODY="{\"category\":\"$S32_T\",\"items\":[\"$S32_F2\"]}"
for S32_ROUTE in "/api/vault/categories/$S32_WIDE_CHILD/move|$S32_MOVE_BODY" "/api/vault/categories/reorder|$S32_ORDER_BODY" "/api/vault/categories/assign|$S32_ASSIGN_BODY"; do
  S32_PATH="${S32_ROUTE%%|*}"
  S32_REQ="${S32_ROUTE#*|}"
  S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "$S32_PATH" "$S32_REQ")"
  s32_expect "$S32_STATUS" 403 "A manager needs to approve this." "a plain staff member calling $S32_PATH"
  [ "$(s32_field needs_override)|$(s32_field capability)" = "true|stock_manage" ] || fail "the refusal on $S32_PATH is not a stock_manage override request: $(s32_body)"
done
[ "$(s32_rec categories "$S32_WIDE_CHILD" parent)" = "$S32_WIDE" ] && [ "$(s32_rec items "$S32_F2" category)" = "$S32_T" ] || fail "a refused request changed something"
# A manager holds the capability by default.
S32_STATUS="$(s32_post "$S32_MANAGER_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_T\",\"items\":[\"$S32_F2\"]}")"
s32_expect "$S32_STATUS" 200 "" "a manager filing stock"
# A plain staff member with a manager's override, once.
S32_TOKEN="$(s32_override stock_manage "$S32_CLERK_ID")"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_BT\",\"items\":[\"$S32_F2\"]}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 200 "" "a plain staff member's assign with a manager's override"
[ "$(s32_rec items "$S32_F2" category)" = "$S32_BT" ] || fail "the approved assign did not file the row"
S32_USED="$(s32_list till_overrides "capability='stock_manage' && requested_by='$S32_CLERK_ID'")"
[ "$(echo "$S32_USED" | jval items.0.used_for)" = "category_assign:$S32_BT" ] && [ -n "$(echo "$S32_USED" | jval items.0.used_at)" ] \
  || fail "the approval was not spent on the assign: $S32_USED"
S32_AUDIT="$(s32_list audit_log "action='category_assign' && actor='$S32_CLERK_ID'")"
[ "$(echo "$S32_AUDIT" | jval items.0.meta.approvals.0.approver)|$(echo "$S32_AUDIT" | jval items.0.meta.approvals.0.capability)" = "$S32_ADMIN_ID|stock_manage" ] \
  || fail "the audit row does not name the approver: $S32_AUDIT"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_T\",\"items\":[\"$S32_F2\"]}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 403 "A manager needs to approve this." "reusing a spent approval"
[ "$(s32_rec items "$S32_F2" category)" = "$S32_BT" ] || fail "a spent approval filed a row"
S32_TOKEN="$(s32_override refund "$S32_CLERK_ID")"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_T\",\"items\":[\"$S32_F2\"]}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 403 "A manager needs to approve this." "an approval for another capability"
S32_TOKEN="$(s32_override stock_manage "$S32_MANAGER_ID")"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_T\",\"items\":[\"$S32_F2\"]}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 403 "A manager needs to approve this." "an approval issued to somebody else"
# The same approval works on move and reorder, and is spent there too.
S32_TOKEN="$(s32_override stock_manage "$S32_CLERK_ID")"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "/api/vault/categories/$S32_WIDE_CHILD/move" "{\"parent\":\"$S32_Q\"}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 200 "" "a plain staff member's move with a manager's override"
[ "$(s32_rec categories "$S32_WIDE_CHILD" parent)" = "$S32_Q" ] || fail "the approved move did not happen"
S32_TOKEN="$(s32_override stock_manage "$S32_CLERK_ID")"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "/api/vault/categories/reorder" "{\"parent\":\"$S32_Q\",\"order\":[\"$S32_WIDE_CHILD\",\"$S32_Q2\",\"nosuchbranch001\"]}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 400 "$S32_MISMATCH" "an approved reorder that is itself refused"
S32_STATUS="$(s32_post "$S32_CLERK_TOKEN" "/api/vault/categories/reorder" "{\"parent\":\"$S32_Q\",\"order\":[\"$S32_WIDE_CHILD\",\"$S32_Q2\",\"$S32_Q1\"]}" "X-GG-Override: $S32_TOKEN")"
s32_expect "$S32_STATUS" 200 "" "an approval not spent by a refused request"
[ "$(s32_children "$S32_Q")" = "Check Wide child:10,Check Q2:20,Check Q1:30" ] || fail "the approved reorder gave $(s32_children "$S32_Q")"
S32_AUDIT="$(s32_list audit_log "action='category_move' && actor='$S32_CLERK_ID'")"
[ "$(echo "$S32_AUDIT" | jval items.0.record)|$(echo "$S32_AUDIT" | jval items.0.meta.parent)|$(echo "$S32_AUDIT" | jval items.0.meta.approvals.0.approver)" = "$S32_WIDE_CHILD|$S32_Q|$S32_ADMIN_ID" ] \
  || fail "the category_move audit row is wrong: $S32_AUDIT"
S32_AUDIT="$(s32_list audit_log "action='category_reorder' && actor='$S32_CLERK_ID'")"
[ "$(echo "$S32_AUDIT" | jval items.0.meta.parent)|$(echo "$S32_AUDIT" | jval items.0.meta.approvals.0.approver)" = "$S32_Q|$S32_ADMIN_ID" ] \
  || fail "the category_reorder audit row is wrong: $S32_AUDIT"
ok "move, reorder and assign need stock_manage: a plain staff member is asked for a manager's approval, a manager is not, an approval is spent once and only for its capability and its holder, and the audit rows name the approver"

# --- 32h. Filing new stock ---------------------------------------------------
# A till of our own for the buy-in, the part-exchange and the sales below: what
# is open on the default register is closed at its expected total, and opened
# again at the end of this section if it was.
S32_TILL_WAS_OPEN="$(s32_session)"
s32_close_till
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":20000}')"
s32_expect "$S32_STATUS" 200 "" "opening the till for section 32"
S32_SESSION="$(s32_field session.id)"
[ -n "$S32_SESSION" ] || fail "32: the till did not open"

# $1 item JSON (without a game unless it carries one) -> the new stock row's id,
# made through the collection API as the admin.
s32_raw_item() {
  local id
  id="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" \
    -H "Content-Type: application/json" -d "$1" | jval id)"
  [ -n "$id" ] || fail "could not create the stock row $1"
  s32_track items "$id"
  echo "$id"
}
# $1 branch key, $2 stock row id, $3 what it is -> fails unless the row is filed in that seeded branch.
s32_filed_in() {
  local want got
  want="$(s32_t "key('$1').id")"
  got="$(s32_rec items "$2" category)"
  [ -n "$want" ] || fail "no seeded branch has the key $1"
  [ "$got" = "$want" ] || fail "$3 is filed in '$(s32_t "(t.find((b) => b.id === '$got') || {path: got}).path")', expected $(s32_t "key('$1').path")"
}

S32_RT_MD="$(curl -s -X POST "$BASE/api/collections/retro_titles/records" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"name\":\"S32 Sonic\",\"platform\":\"$S32_PLATFORM_MD\"}" | jval id)"
S32_PLATFORM_PS2="$(curl -s "$BASE/api/collections/platforms/records?filter=key%3D%27ps2_case%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S32_RT_PS2="$(curl -s -X POST "$BASE/api/collections/retro_titles/records" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"name\":\"S32 Tekken\",\"platform\":\"$S32_PLATFORM_PS2\"}" | jval id)"
[ -n "$S32_RT_MD" ] && [ -n "$S32_RT_PS2" ] || fail "32: could not create the retro titles"

S32_ITEM_BASE="\"qty\":1,\"cost\":100,\"price\":500,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\""
s32_filed_in tcg.pokemon.singles "$(s32_raw_item "{\"kind\":\"single\",\"game\":\"$S32_GAME\",\"title\":\"S32 f1\",$S32_ITEM_BASE}")" "a Pokémon single"
s32_filed_in tcg.pokemon.graded "$(s32_raw_item "{\"kind\":\"graded\",\"game\":\"$S32_GAME\",\"title\":\"S32 f2\",$S32_ITEM_BASE}")" "a graded Pokémon card"
s32_filed_in tcg.pokemon.sealed "$(s32_raw_item "{\"kind\":\"sealed\",\"game\":\"$S32_GAME\",\"title\":\"S32 f3\",$S32_ITEM_BASE}")" "Pokémon sealed product"
s32_filed_in tcg.pokemon.accessories "$(s32_raw_item "{\"kind\":\"accessory\",\"game\":\"$S32_GAME\",\"title\":\"S32 f4\",$S32_ITEM_BASE}")" "a Pokémon accessory"
s32_filed_in tcg.mtg.sealed "$(s32_raw_item "{\"kind\":\"sealed\",\"game\":\"$S32_MTG_GAME\",\"title\":\"S32 f5\",$S32_ITEM_BASE}")" "Magic sealed product"
s32_filed_in accessories "$(s32_raw_item "{\"kind\":\"accessory\",\"game\":\"$S32_RETRO_GAME\",\"title\":\"S32 f6\",$S32_ITEM_BASE}")" "an accessory for no card game"
s32_filed_in unsorted "$(s32_raw_item "{\"kind\":\"other\",\"game\":\"$S32_GAME\",\"title\":\"S32 f7\",$S32_ITEM_BASE}")" "an 'other' row"
s32_filed_in retro.sega.megadrive.games "$(s32_raw_item "{\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"retro_title\":\"$S32_RT_MD\",$S32_ITEM_BASE}")" "a Mega Drive game"
s32_filed_in unsorted "$(s32_raw_item "{\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"retro_title\":\"$S32_RT_PS2\",$S32_ITEM_BASE}")" "a game on a case that could be PlayStation 2 or Xbox"
s32_filed_in unsorted "$(s32_raw_item "{\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"title\":\"S32 f10\",$S32_ITEM_BASE}")" "a retro row with no title"
S32_KEPT="$(s32_raw_item "{\"kind\":\"single\",\"game\":\"$S32_GAME\",\"title\":\"S32 f11\",\"category\":\"$S32_T\",$S32_ITEM_BASE}")"
[ "$(s32_rec items "$S32_KEPT" category)" = "$S32_T" ] || fail "a row sent with its own branch was filed by the rule instead"
# The SKU and the title are assigned exactly as before.
S32_SKU_ROW="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/collections/items/records/$S32_KEPT")"
echo "$(echo "$S32_SKU_ROW" | jval sku)" | grep -Eq '^GGS[0-9A-HJKMNP-TV-Z]{6}$' || fail "filing changed the SKU: $S32_SKU_ROW"
[ "$(echo "$S32_SKU_ROW" | jval title)" = "S32 f11" ] || fail "filing changed the title"
[ "$(s32_rec items "$(s32_raw_item "{\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"retro_title\":\"$S32_RT_MD\",$S32_ITEM_BASE}")" title)" = "S32 Sonic" ] \
  || fail "a row's title is no longer taken from its retro title"

# A buy-in completed: a Pokémon single, a Mega Drive game and two Magic boxes.
S32_SELLER="$(curl -s -X POST "$BASE/api/collections/customers/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Sid Seller","source":"counter"}' | jval id)"
S32_TRADE="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d "{\"customer\":\"$S32_SELLER\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
# $1 trade-in id, $2 line JSON fields -> adds an accepted line.
s32_trade_line() {
  local line
  line="{\"trade_in\":\"$1\",\"market_currency\":\"GBP\",\"accepted\":true,$2}"
  [ -n "$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" -H "Authorization: $STAFF_TOKEN" \
    -H "Content-Type: application/json" -d "$line" | jval id)" ] || fail "could not add a trade-in line: $line"
}
s32_trade_line "$S32_TRADE" "\"kind\":\"single\",\"game\":\"$S32_GAME\",\"free_text_title\":\"S32 Buy-in single\",\"condition\":\"NM\",\"qty\":1,\"market_price\":900,\"offer_price\":600"
s32_trade_line "$S32_TRADE" "\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"retro_title\":\"$S32_RT_MD\",\"completeness\":\"loose\",\"cosmetic_grade\":\"B\",\"qty\":1,\"market_price\":1500,\"offer_price\":800"
s32_trade_line "$S32_TRADE" "\"kind\":\"sealed\",\"game\":\"$S32_MTG_GAME\",\"free_text_title\":\"S32 Buy-in boxes\",\"qty\":2,\"market_price\":300,\"offer_price\":200"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/trade-ins/$S32_TRADE/complete" '{"payout_type":"credit","payout_cash":0,"payout_credit":1800,"terms_accepted":true}')"
s32_expect "$S32_STATUS" 200 "" "completing a buy-in"
S32_BUYIN_ITEMS="$(s32_list items "trade_in_line.trade_in='$S32_TRADE'")"
[ "$(echo "$S32_BUYIN_ITEMS" | jval totalItems)" = "3" ] || fail "the buy-in made $(echo "$S32_BUYIN_ITEMS" | jval totalItems) stock rows, expected 3"
for S32_IDX in 0 1 2; do s32_track items "$(echo "$S32_BUYIN_ITEMS" | jval "items.$S32_IDX.id")"; done
S32_BUYIN_CHECK="$(echo "$S32_BUYIN_ITEMS" | node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const tree = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).branches;
  process.stdout.write(items.map((i) => `${i.kind}=${(tree.find((b) => b.id === i.category) || { key: "none" }).key}`).sort().join(","));
' "$S32_DIR/tree.json")"
[ "$S32_BUYIN_CHECK" = "retro=retro.sega.megadrive.games,sealed=tcg.mtg.sealed,single=tcg.pokemon.singles" ] \
  || fail "the buy-in's stock is filed '$S32_BUYIN_CHECK'"

# A part-exchange completed: a Pokémon single and a PlayStation 2 game paid towards a box.
S32_SIGNATURE="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
S32_PX_TRADE="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d "{\"customer\":\"$S32_SELLER\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
s32_trade_line "$S32_PX_TRADE" "\"kind\":\"single\",\"game\":\"$S32_GAME\",\"free_text_title\":\"S32 Swap single\",\"condition\":\"NM\",\"qty\":1,\"market_price\":900,\"offer_price\":600"
s32_trade_line "$S32_PX_TRADE" "\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"retro_title\":\"$S32_RT_PS2\",\"completeness\":\"loose\",\"cosmetic_grade\":\"B\",\"qty\":1,\"market_price\":700,\"offer_price\":400"
S32_PX_ITEM="$(s32_item "S32 Swap box" 1 sealed "" 3000)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S32_PX_ITEM\",\"qty\":1}],\"customer\":\"$S32_SELLER\",\"trade_in\":\"$S32_PX_TRADE\",\"trade_settlement\":{\"terms_accepted\":true,\"signature\":\"$S32_SIGNATURE\"},\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "a part-exchange"
S32_PX_ITEMS="$(s32_list items "trade_in_line.trade_in='$S32_PX_TRADE'")"
[ "$(echo "$S32_PX_ITEMS" | jval totalItems)" = "2" ] || fail "the part-exchange made $(echo "$S32_PX_ITEMS" | jval totalItems) stock rows, expected 2"
for S32_IDX in 0 1; do s32_track items "$(echo "$S32_PX_ITEMS" | jval "items.$S32_IDX.id")"; done
S32_PX_CHECK="$(echo "$S32_PX_ITEMS" | node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const tree = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).branches;
  process.stdout.write(items.map((i) => `${i.kind}=${(tree.find((b) => b.id === i.category) || { key: "none" }).key}`).sort().join(","));
' "$S32_DIR/tree.json")"
[ "$S32_PX_CHECK" = "retro=unsorted,single=tcg.pokemon.singles" ] || fail "the part-exchange's stock is filed '$S32_PX_CHECK'"

# A Card Uploader row that creates a stock row.
S32_CU_SET="$(curl -s -X POST "$BASE/api/collections/card_sets/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d "{\"game\":\"$S32_GAME\",\"code\":\"s32-set\",\"name\":\"S32 Fixture Set\"}" | jval id)"
curl -s -o /dev/null -X POST "$BASE/api/collections/cards/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"game\":\"$S32_GAME\",\"set\":\"$S32_CU_SET\",\"number\":\"7\",\"name\":\"S32 Fixture Card\",\"tcgplayer_id\":\"TCG-S32-001\"}"
cat >"$S32_DIR/card-uploader.csv" <<'CSV'
Card Name,Set,Number,Condition,Price,Quantity,TCGplayer ID,Cardmarket ID,CS SKU
,S32 Fixture Set,7,NM,4.00,1,TCG-S32-001,,CS-S32-001
CSV
S32_STATUS="$(curl -s -o "$S32_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/vault/imports/card-uploader" \
  -H "Authorization: $STAFF_TOKEN" -F "file=@$S32_DIR/card-uploader.csv;type=text/csv" -F "type=card_uploader")"
s32_expect "$S32_STATUS" 200 "" "a Card Uploader import"
S32_CU_ITEM="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=ebay_sku='CS-S32-001'" "$BASE/api/collections/items/records" | jval "items.0.id")"
[ -n "$S32_CU_ITEM" ] || fail "the Card Uploader import made no stock row"
s32_track items "$S32_CU_ITEM"
s32_filed_in tcg.pokemon.singles "$S32_CU_ITEM" "the Card Uploader's new stock row"

# A branch that does not exist is refused, for stock and for till products.
S32_NO_BRANCH="That branch was not found."
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/collections/items/records" "{\"kind\":\"single\",\"game\":\"$S32_GAME\",\"title\":\"S32 nowhere\",\"category\":\"nosuchbranch001\",$S32_ITEM_BASE}")"
s32_expect "$S32_STATUS" 400 "$S32_NO_BRANCH" "a stock row in a branch that does not exist"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/items/records/$S32_KEPT" '{"category":"nosuchbranch001"}')"
s32_expect "$S32_STATUS" 400 "$S32_NO_BRANCH" "moving a stock row to a branch that does not exist"
[ "$(s32_rec items "$S32_KEPT" category)" = "$S32_T" ] || fail "a refused update moved the stock row"
S32_PRODUCT_BODY='"kind":"service","price":100,"tax_scheme":"standard","active":false'
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/collections/till_products/records" "{\"name\":\"S32 nowhere\",\"category\":\"nosuchbranch001\",$S32_PRODUCT_BODY}")"
s32_expect "$S32_STATUS" 400 "$S32_NO_BRANCH" "a till product in a branch that does not exist"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/till_products/records/$S32_HP" '{"category":"nosuchbranch001"}')"
s32_expect "$S32_STATUS" 400 "$S32_NO_BRANCH" "moving a till product to a branch that does not exist"
[ "$(s32_rec till_products "$S32_HP" category)" = "$S32_T" ] || fail "a refused update moved the till product"
# A till product made with no branch goes to Unsorted; one made with a branch stays put.
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/collections/till_products/records" "{\"name\":\"S32 loose product\",$S32_PRODUCT_BODY}")"
s32_expect "$S32_STATUS" 200 "" "a till product with no branch"
S32_LOOSE_PRODUCT="$(s32_field id)"
s32_track products "$S32_LOOSE_PRODUCT"
[ "$(s32_field category)" = "$S32_UNSORTED" ] || fail "a till product with no branch was filed in '$(s32_field category)', not Unsorted"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/collections/till_products/records" "{\"name\":\"S32 filed product\",\"category\":\"$S32_T\",$S32_PRODUCT_BODY}")"
s32_expect "$S32_STATUS" 200 "" "a till product with a branch"
s32_track products "$(s32_field id)"
[ "$(s32_field category)" = "$S32_T" ] || fail "a till product sent with its branch was filed elsewhere"
ok "new stock is filed by kind, game and platform (Unsorted when they do not settle it), keeping its SKU and title, whether made through the collection API, a buy-in, a part-exchange or the Card Uploader; an unknown branch is refused for stock and products; a product with no branch goes to Unsorted"

# --- 32i. The tree's shelf counts, and the till's branch route ---------------
# S holds SC (stock and a product) and SO (switched off, one row); S itself has one row.
S32_S="$(s32_branch "Check S")"
S32_SC="$(s32_branch "Check S child" "$S32_S")"
S32_SO="$(s32_branch "Check S off" "$S32_S" ',"active":false')"
S32_SOC="$(s32_branch "Check S off child" "$S32_SO")"
S32_CI1="$(s32_item "Check count 1" 3 other "$S32_SC" 1000)"
S32_CI2="$(s32_item "Check count 2" 1 other "$S32_SC" 1000)"
s32_item "Check count zero" 0 other "$S32_SC" >/dev/null
s32_item "Check count sold" 1 other "$S32_SC" 500 sold >/dev/null
s32_item "Check count held" 1 other "$S32_SC" 500 reserved >/dev/null
s32_item "Check count listed" 1 other "$S32_SC" 500 listed_ebay >/dev/null
S32_CI_OWN="$(s32_item "Check count own" 1 other "$S32_S")"
s32_item "Check count off" 1 other "$S32_SO" >/dev/null
# Stock in a switched-off branch keeps its branch and still sells.
S32_OFF_SALE="$(s32_item "Check off sale" 1 other "$S32_SO" 500)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S32_OFF_SALE\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "selling a stock row that sits in a switched-off branch"
[ "$(s32_rec items "$S32_OFF_SALE" category)" = "$S32_SO" ] || fail "selling a row moved it out of its branch"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_SC\",\"products\":[\"$S32_HP\",\"$S32_LOOSE_PRODUCT\"]}")"
s32_expect "$S32_STATUS" 200 "" "filing an active and a switched-off product into the child branch"
s32_tree
# Only rows on the shelf (in stock with a quantity) count; the switched-off branch's row counts in the total.
S32_COUNTS="$(s32_b "$S32_SC" counts.items):$(s32_b "$S32_SC" counts.items_total):$(s32_b "$S32_S" counts.items):$(s32_b "$S32_S" counts.items_total):$(s32_b "$S32_SO" counts.items):$(s32_b "$S32_S" counts.children)"
[ "$S32_COUNTS" = "2:2:1:4:1:2" ] || fail "the shelf counts are $S32_COUNTS, expected 2:2:1:4:1:2 (child, child total, own, total, switched-off child, children)"
[ "$(s32_b "$S32_SC" counts.products):$(s32_b "$S32_S" counts.products)" = "1:0" ] || fail "only active till products should count: $(s32_b "$S32_SC" counts.products):$(s32_b "$S32_S" counts.products)"
[ "$(s32_b "$S32_S" visible):$(s32_b "$S32_SO" visible):$(s32_b "$S32_SOC" visible):$(s32_b "$S32_SOC" active)" = "true:false:false:true" ] \
  || fail "a switched-off branch does not hide the branches beneath it"
S32_PROBLEMS="$(s32_tree_problems)"
[ -z "$S32_PROBLEMS" ] || fail "the tree with a switched-off branch is unsound: $S32_PROBLEMS"

# The till's branch route, as a plain staff member reads it.
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_S")"
s32_expect "$S32_STATUS" 200 "" "the till's view of a top-level branch"
S32_VIEW="$(s32_js "[r.branch.name, r.branch.path, r.trail.length, r.children.map((c) => c.name + ':' + c.items + ':' + c.image_url).join(), r.products.length, r.items.map((i) => i.title).join(), r.page, r.per_page, r.total].join('|')")"
[ "$S32_VIEW" = "Check S|Check S|0|Check S child:2:|0|Check count own|1|40|1" ] || fail "the view of a top-level branch is '$S32_VIEW'"
[ "$(s32_js "r.items[0].id + '|' + r.items[0].qty + '|' + r.items[0].kind + '|' + r.items[0].status + '|' + (r.items[0].sku.length > 0)")" = "$S32_CI_OWN|1|other|in_stock|true" ] \
  || fail "the view's stock tile is wrong: $(s32_body)"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_SC")"
s32_expect "$S32_STATUS" 200 "" "the till's view of a child branch"
S32_VIEW="$(s32_js "[r.branch.path, r.trail.map((t) => t.id + '=' + t.name).join(), r.children.length, r.products.map((p) => p.name + ':' + p.price + ':' + p.kind + ':' + p.open_price + ':' + p.tax_scheme).join(), r.items.map((i) => i.title).join(), r.total].join('|')")"
[ "$S32_VIEW" = "Check S / Check S child|$S32_S=Check S|0|Check H product:100:service:false:standard|Check count 1,Check count 2|2" ] || fail "the view of a child branch is '$S32_VIEW'"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_L7")"
s32_expect "$S32_STATUS" 200 "" "the till's view of a branch seven levels down"
[ "$(s32_js "r.trail.map((t) => t.name).join(' > ')")" = "Check Deep > Check Level 1 > Check Level 2 > Check Level 3 > Check Level 4 > Check Level 5 > Check Level 6" ] \
  || fail "the trail of a deep branch is $(s32_js "r.trail.map((t) => t.name).join(' > ')")"
# Search runs through everything beneath the branch that is on the till, and offers no folders.
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_S?q=check%20count")"
s32_expect "$S32_STATUS" 200 "" "searching a branch's subtree"
[ "$(s32_js "[r.children.length, r.items.map((i) => i.title).join(), r.total].join('|')")" = "0|Check count 1,Check count 2,Check count own|3" ] \
  || fail "a search of the subtree gave $(s32_js "[r.children.length, r.items.map((i) => i.title).join(), r.total].join('|')") (the switched-off branch's row is hidden)"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_S?q=h%20product")"
s32_expect "$S32_STATUS" 200 "" "searching for a product beneath the branch"
[ "$(s32_js "r.products.map((p) => p.name).join() + '|' + r.items.length")" = "Check H product|0" ] || fail "a search for a product gave $(s32_body)"
S32_CI1_SKU="$(s32_rec items "$S32_CI1" sku)"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_S?q=$(echo "$S32_CI1_SKU" | tr 'A-Z' 'a-z')")"
s32_expect "$S32_STATUS" 200 "" "searching by SKU"
[ "$(s32_js "r.items.map((i) => i.id).join()")" = "$S32_CI1" ] || fail "a search by SKU found $(s32_body)"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_SC?q=nothing%20called%20this")"
[ "$(s32_js "r.items.length + r.products.length + r.total")" = "0" ] || fail "a search with no match found something: $(s32_body)"
# Paging: 45 rows, 40 a page by title; the products come on the first page.
S32_PG="$(s32_branch "Check Page")"
S32_PAGE_IDS="$(s32_bulk 45 "$S32_PG" "Page item")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/collections/till_products/records" "{\"name\":\"S32 page product\",\"category\":\"$S32_PG\",\"kind\":\"service\",\"price\":250,\"tax_scheme\":\"standard\",\"active\":true}")"
s32_expect "$S32_STATUS" 200 "" "a till product for the paging branch"
s32_track products "$(s32_field id)"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_PG")"
s32_expect "$S32_STATUS" 200 "" "the first page of a branch"
[ "$(s32_js "[r.items.length, r.items[0].title, r.items[39].title, r.page, r.per_page, r.total, r.products.length].join('|')")" = "40|Page item 0001|Page item 0040|1|40|45|1" ] \
  || fail "the first page is $(s32_js "[r.items.length, r.items[0].title, r.items[39].title, r.page, r.per_page, r.total, r.products.length].join('|')")"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_PG?page=2")"
s32_expect "$S32_STATUS" 200 "" "the second page of a branch"
[ "$(s32_js "[r.items.length, r.items[0].title, r.items[4].title, r.page, r.total, r.products.length].join('|')")" = "5|Page item 0041|Page item 0045|2|45|0" ] \
  || fail "the second page is $(s32_js "[r.items.length, r.items[0].title, r.items[4].title, r.page, r.total, r.products.length].join('|')")"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_PG?page=3")"
[ "$(s32_js "r.items.length + '|' + r.page + '|' + r.total")" = "0|3|45" ] || fail "a page past the end is $(s32_body)"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_PG?q=page%20item&page=2")"
[ "$(s32_js "r.items.length + '|' + r.total + '|' + r.products.length")" = "5|45|0" ] || fail "page 2 of a search is $(s32_body)"
# A switched-off branch, one beneath it and one that does not exist are not there.
for S32_GONE in "$S32_SO" "$S32_SOC" "nosuchbranch001"; do
  S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/branch/$S32_GONE")"
  s32_expect "$S32_STATUS" 404 "That branch was not found." "the till's view of $S32_GONE"
done
S32_STATUS="$(s32_get "invalid.token" "/api/vault/till/branch/$S32_S")"
[ "$S32_STATUS" = "401" ] || fail "the till's branch view answered $S32_STATUS to a request with no valid sign-in"
# The catalogue: the quick-key pages as before, and the visible top-level branches in tree order.
S32_OFF_TOP="$(s32_branch "Check Off top" "" ',"active":false')"
s32_tree
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/catalogue")"
s32_expect "$S32_STATUS" 200 "" "the till catalogue"
cp "$S32_DIR/last.json" "$S32_DIR/catalogue.json"
S32_CAT_CHECK="$(node -e '
  const cat = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const tree = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8")).branches;
  const want = tree.filter((b) => b.parent === "" && b.visible).map((b) => ({ id: b.id, name: b.name, image_url: b.image_url, items: b.counts.items_total }));
  const problems = [];
  if (!Array.isArray(cat.branches)) problems.push("no branches");
  else if (JSON.stringify(cat.branches.map((b) => [b.id, b.name, b.image_url, b.items])) !== JSON.stringify(want.map((b) => [b.id, b.name, b.image_url, b.items]))) {
    problems.push(`branches ${JSON.stringify(cat.branches.map((b) => b.name))} are not the visible top-level branches ${JSON.stringify(want.map((b) => b.name))}`);
  }
  if (cat.branches && cat.branches.some((b) => b.id === process.argv[3])) problems.push("a switched-off branch is on the rail");
  if (cat.branches && Object.keys(cat.branches[0] || {}).sort().join() !== "id,image_url,items,name") problems.push("a chip has the wrong fields");
  process.stdout.write(problems.join("; "));
' "$S32_DIR/catalogue.json" "$S32_DIR/tree.json" "$S32_OFF_TOP")"
[ -z "$S32_CAT_CHECK" ] || fail "the catalogue's branches are wrong: $S32_CAT_CHECK"
ok "the tree counts only shelf rows (in stock with a quantity), by branch and by subtree, and only active products; the till's branch view gives the trail, visible child branches, products, stock 40 a page by title and a subtree search by name, title or SKU, and 404s for a branch that is off, under one that is off, or missing; the catalogue lists the visible top-level branches"

# --- 32j. Counts after stock is sold and moved --------------------------------
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S32_CI1\",\"qty\":1},{\"item\":\"$S32_CI2\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "selling one of a three-unit row and a one-unit row"
s32_tree
# The three-unit row is still on the shelf; the one-unit row is not.
[ "$(s32_b "$S32_SC" counts.items):$(s32_b "$S32_S" counts.items_total)" = "1:3" ] \
  || fail "after a sale the counts are $(s32_b "$S32_SC" counts.items):$(s32_b "$S32_S" counts.items_total), expected 1:3"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "$S32_ASSIGN" "{\"category\":\"$S32_S\",\"items\":[\"$S32_CI1\"]}")"
s32_expect "$S32_STATUS" 200 "" "moving the remaining stock row up a level"
s32_tree
[ "$(s32_b "$S32_SC" counts.items):$(s32_b "$S32_S" counts.items):$(s32_b "$S32_S" counts.items_total)" = "0:2:3" ] \
  || fail "after moving stock up the counts are $(s32_b "$S32_SC" counts.items):$(s32_b "$S32_S" counts.items):$(s32_b "$S32_S" counts.items_total), expected 0:2:3"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/categories/records/$S32_SO" '{"active":true}')"
s32_expect "$S32_STATUS" 200 "" "switching the off branch back on"
s32_tree
[ "$(s32_b "$S32_SOC" visible):$(s32_b "$S32_S" counts.items_total)" = "true:3" ] || fail "switching a branch on did not show the branches beneath it"
ok "selling a row out, selling part of a row and moving stock between branches move the shelf counts exactly"

# --- 32k. Stock filtered by branch ---------------------------------------------
# The items collection takes category.lineage ~ '|<id>|' for a branch and everything beneath it,
# for a plain staff token, and stays quick with 2,000 rows in one branch.
# $1 branch id [$2 extra query] -> the status; the body is in last.json.
s32_by_branch() {
  local filter
  filter="$(node -e 'process.stdout.write(encodeURIComponent("category.lineage ~ \x27|" + process.argv[1] + "|\x27"))' "$1")"
  curl -s -o "$S32_DIR/last.json" -w '%{http_code}:%{time_total}' -H "Authorization: $S32_CLERK_TOKEN" \
    "$BASE/api/collections/items/records?filter=$filter&perPage=200${2:-}"
}
S32_TIMED="$(s32_by_branch "$S32_S")"
[ "${S32_TIMED%%:*}" = "200" ] || fail "filtering stock by branch as plain staff returned ${S32_TIMED%%:*}: $(s32_body)"
# The nine rows made under S and its branches, sold and held ones included.
[ "$(s32_field totalItems)" = "9" ] || fail "the filter on a branch found $(s32_field totalItems) rows, expected the 9 beneath it"
S32_TIMED="$(s32_by_branch "$S32_SC")"
[ "$(s32_field totalItems)" = "5" ] || fail "the filter on a child branch found $(s32_field totalItems) rows, expected 5 (the moved row is in its parent now)"
S32_TIMED="$(s32_by_branch "$S32_BK")"
[ "${S32_TIMED%%:*}" = "200" ] && [ "$(s32_field totalItems)" = "1500" ] || fail "the filter on the bulk branch found $(s32_field totalItems) rows, expected 1500 (500 were filed elsewhere)"
under_seconds "${S32_TIMED#*:}" 1.5 || fail "filtering 1,500 of 2,000 rows by branch took ${S32_TIMED#*:} seconds"
S32_TIMED="$(s32_by_branch "$S32_UNSORTED" "&sort=-created")"
[ "${S32_TIMED%%:*}" = "200" ] || fail "filtering by Unsorted returned ${S32_TIMED%%:*}"
under_seconds "${S32_TIMED#*:}" 1.5 || fail "filtering by Unsorted took ${S32_TIMED#*:} seconds"
ok "stock filtered by category.lineage returns a branch and everything beneath it for plain staff, in well under a second over 2,000 rows"

# --- 32l. The X report names a line by the first two levels of its branch ------
# A till session of our own, so the running report holds only these sales.
s32_close_till
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":20000}')"
s32_expect "$S32_STATUS" 200 "" "opening a fresh till for the sales"
S32_SESSION="$(s32_field session.id)"
# Check Sales > One > One A, and Check Sales > Two.
S32_SR="$(s32_branch "Check Sales")"
S32_SR1="$(s32_branch "Check Sales One" "$S32_SR")"
S32_SR1A="$(s32_branch "Check Sales One A" "$S32_SR1")"
S32_SR2="$(s32_branch "Check Sales Two" "$S32_SR")"
S32_IT_A="$(s32_item "Check sale A" 5 other "$S32_SR1A" 1000)"
S32_IT_B="$(s32_item "Check sale B" 5 other "$S32_SR1" 700)"
S32_IT_C="$(s32_item "Check sale C" 5 other "$S32_SR" 300)"
S32_IT_D="$(s32_item "Check sale D" 5 other "$S32_SR2" 400)"
S32_IT_E="$(s32_item "Check sale E" 5 other "$S32_SR2" 500)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S32_IT_A\",\"qty\":2},{\"item\":\"$S32_IT_B\",\"qty\":1,\"discount\":100},{\"item\":\"$S32_IT_C\",\"qty\":1},{\"item\":\"$S32_IT_D\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":3300,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "a sale across the check branches, one line discounted"
[ "$(s32_field sale.total)" = "3300" ] || fail "the sale came to $(s32_field sale.total), expected 3300: $(s32_body)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S32_IT_E\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "a sale to be refunded"
S32_E_SALE="$(s32_field sale.id)"
S32_E_LINE="$(s32_list sale_lines "sale='$S32_E_SALE'" | jval "items.0.id")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/$S32_E_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S32_E_LINE\",\"qty\":1}],\"reason\":\"Check refund\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "refunding that line"
# Stock and products from the rest of the tree, for the labels.
S32_TCG="$(s32_t "key('tcg').id")"
S32_X_TCG="$(s32_raw_item "{\"kind\":\"single\",\"game\":\"$S32_GAME\",\"title\":\"S32 x tcg\",\"category\":\"$S32_TCG\",\"qty\":1,\"cost\":100,\"price\":1100,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}")"
S32_X_SINGLE="$(s32_raw_item "{\"kind\":\"single\",\"game\":\"$S32_GAME\",\"title\":\"S32 x single\",\"qty\":1,\"cost\":100,\"price\":900,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}")"
S32_X_SEALED="$(s32_raw_item "{\"kind\":\"sealed\",\"game\":\"$S32_GAME\",\"title\":\"S32 x sealed\",\"qty\":1,\"cost\":100,\"price\":2500,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}")"
S32_X_RETRO="$(s32_raw_item "{\"kind\":\"retro\",\"game\":\"$S32_RETRO_GAME\",\"retro_title\":\"$S32_RT_MD\",\"title\":\"S32 x retro\",\"qty\":1,\"cost\":100,\"price\":1500,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}")"
S32_X_LOOSE="$(s32_raw_item "{\"kind\":\"other\",\"game\":\"$S32_GAME\",\"title\":\"S32 x loose\",\"qty\":1,\"cost\":100,\"price\":200,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/items/records/$S32_X_LOOSE" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"category":""}'
[ -z "$(s32_rec items "$S32_X_LOOSE" category)" ] || fail "could not take the stock row out of its branch"
S32_TABLE="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Table time, 1 hour'" "$BASE/api/collections/till_products/records" | jval "items.0.id")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S32_X_TCG\",\"qty\":1},{\"item\":\"$S32_X_SINGLE\",\"qty\":1},{\"item\":\"$S32_X_SEALED\",\"qty\":1},{\"item\":\"$S32_X_RETRO\",\"qty\":1},{\"item\":\"$S32_X_LOOSE\",\"qty\":1},{\"product\":\"$S32_TABLE\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":6700,\"card_last4\":\"4242\"}]}")"
s32_expect "$S32_STATUS" 200 "" "a sale across the rest of the tree"
S32_STATUS="$(s32_get "$STAFF_TOKEN" "/api/vault/till/current")"
s32_expect "$S32_STATUS" 200 "" "the running report"
S32_WANT_CATEGORIES='[["Trading cards / Pokémon",3400,2],["Check Sales / Check Sales One",2600,3],["Retro / Sega",1500,1],["Trading cards",1100,1],["Check Sales / Check Sales Two",900,2],["Services / Table time",500,1],["Check Sales",300,1],["Other",200,1]]'
[ "$(s32_js "r.running.by_category.map((c) => [c.category, c.net, c.count])")" = "$S32_WANT_CATEGORIES" ] \
  || fail "the running report's categories are $(s32_js "r.running.by_category.map((c) => [c.category, c.net, c.count])")"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/till/x" '{}')"
s32_expect "$S32_STATUS" 201 "" "an X report"
[ "$(s32_js "r.report.by_category.map((c) => [c.category, c.net, c.count])")" = "$S32_WANT_CATEGORIES" ] \
  || fail "the saved X report's categories are $(s32_js "r.report.by_category.map((c) => [c.category, c.net, c.count])")"
ok "an X report labels each line with the first two levels of its branch's path (a top-level branch alone, Other with none), stock and till products alike, merging branches that share them"

# --- 32m. The sales report by category ----------------------------------------
S32_REPORT="/api/vault/reports/sales?from=$S32_TODAY&to=$S32_TODAY&by=category"
# $1 extra query -> the rows of the table as "key|label|net|count|has_children", in order.
s32_rows() {
  s32_get "$STAFF_TOKEN" "$S32_REPORT$1" >/dev/null
  s32_js "r.table.map((x) => [x.key, x.label, x.net, x.count, x.has_children].join('|')).join(';')"
}
S32_STATUS="$(s32_get "$STAFF_TOKEN" "$S32_REPORT")"
s32_expect "$S32_STATUS" 200 "" "the sales report by category"
S32_SR_ROW="$(s32_js "r.table.filter((x) => x.key === '$S32_SR').map((x) => [x.label, x.path, x.net, x.revenue, x.count, x.has_children].join('|')).join(';')")"
[ "$S32_SR_ROW" = "Check Sales|Check Sales|3300|3300|5|true" ] || fail "the top-level row for the check branch is '$S32_SR_ROW', expected Check Sales|Check Sales|3300|3300|5|true"
[ "$(s32_js "r.table.filter((x) => x.key === '').map((x) => [x.label, x.has_children].join('|')).join(';')")" = "(none)|false" ] \
  || fail "lines with no branch are not in a row of their own"
[ "$(s32_js "r.table.every((x, i) => i === 0 || r.table[i - 1].net >= x.net)")" = "true" ] || fail "the rows are not largest first"
[ "$(s32_js "r.table.every((x) => x.net === x.revenue)")" = "true" ] || fail "a row's net and revenue differ"
s32_tree
S32_TOP_IDS="$(s32_t "t.filter((b) => b.parent === '').map((b) => b.id).join(' ')")"
[ "$(s32_js "r.table.every((x) => x.key === '' || '$S32_TOP_IDS'.split(' ').includes(x.key)) && new Set(r.table.map((x) => x.key)).size === r.table.length")" = "true" ] \
  || fail "the top level is not one row per top-level branch: $(s32_js "r.table.map((x) => x.label)")"
[ "$(s32_js "r.table.filter((x) => x.label === 'Trading cards').length")" = "1" ] || fail "Trading cards is not one row of its own"
S32_ROWS="$(s32_rows "&branch=$S32_SR")"
[ "$S32_ROWS" = "$S32_SR1|Check Sales One|2600|2|true;$S32_SR2|Check Sales Two|400|2|false;$S32_SR|In Check Sales itself|300|1|false" ] \
  || fail "drilling into the check branch gave '$S32_ROWS'"
S32_ROWS="$(s32_rows "&branch=$S32_SR1")"
[ "$S32_ROWS" = "$S32_SR1A|Check Sales One A|2000|1|false;$S32_SR1|In Check Sales One itself|600|1|false" ] || fail "drilling into the next level gave '$S32_ROWS'"
S32_ROWS="$(s32_rows "&branch=$S32_SR1A")"
[ "$S32_ROWS" = "$S32_SR1A|In Check Sales One A itself|2000|1|false" ] || fail "a leaf branch gave '$S32_ROWS'"
S32_ROWS="$(s32_rows "&branch=$S32_SR2")"
[ "$S32_ROWS" = "$S32_SR2|In Check Sales Two itself|400|2|false" ] || fail "net after a refund gave '$S32_ROWS' for the branch with the refunded line"
S32_ROWS="$(s32_rows "&branch=$S32_WIDE")"
[ -z "$S32_ROWS" ] || fail "a branch with no sales gave '$S32_ROWS'"
[ "$(s32_get "$STAFF_TOKEN" "$S32_REPORT&branch=nosuchbranch001" >/dev/null; s32_js "r.table.filter((x) => x.key === '$S32_SR').length")" = "1" ] \
  || fail "a branch that does not exist should read as the top level"
# The CSV names each branch by its full path.
curl -s -o "$S32_DIR/report.csv" -w '%{http_code}' -H "Authorization: $STAFF_TOKEN" "$BASE${S32_REPORT/sales?/sales.csv?}&branch=$S32_SR" >"$S32_DIR/csv-status.txt"
[ "$(cat "$S32_DIR/csv-status.txt")" = "200" ] || fail "the sales CSV by category returned $(cat "$S32_DIR/csv-status.txt")"
tr -d '\r' <"$S32_DIR/report.csv" >"$S32_DIR/report.txt"
[ "$(sed -n 1p "$S32_DIR/report.txt")" = "Branch,Revenue,Lines" ] || fail "the CSV header is '$(sed -n 1p "$S32_DIR/report.txt")'"
grep -qxF "Check Sales / Check Sales One,26.00,2" "$S32_DIR/report.txt" \
  && grep -qxF "Check Sales / Check Sales Two,4.00,2" "$S32_DIR/report.txt" \
  && grep -qxF "Check Sales (itself),3.00,1" "$S32_DIR/report.txt" || fail "the CSV rows are wrong: $(cat "$S32_DIR/report.txt")"
# A saved view keeps the dimension and the branch.
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/collections/saved_reports/records" \
  "{\"owner\":\"$S32_ADMIN_ID\",\"report_key\":\"sales\",\"name\":\"S32 by category\",\"schedule\":\"none\",\"filters\":{\"group\":\"day\",\"by\":\"category\",\"branch\":\"$S32_SR\"}}")"
s32_expect "$S32_STATUS" 200 "" "saving a view with a branch"
S32_VIEW_ID="$(s32_field id)"
[ "$(s32_rec saved_reports "$S32_VIEW_ID" filters.branch)|$(s32_rec saved_reports "$S32_VIEW_ID" filters.by)" = "$S32_SR|category" ] || fail "the saved view lost its dimension or branch"
S32_STATUS="$(s32_call PATCH "$STAFF_TOKEN" "/api/collections/saved_reports/records/$S32_VIEW_ID" "{\"filters\":{\"group\":\"day\",\"by\":\"category\",\"branch\":\"$S32_SR1\"}}")"
s32_expect "$S32_STATUS" 200 "" "drilling a saved view down a level"
[ "$(s32_rec saved_reports "$S32_VIEW_ID" filters.branch)" = "$S32_SR1" ] || fail "the saved view's branch did not change"
curl -s -o /dev/null -X DELETE "$BASE/api/collections/saved_reports/records/$S32_VIEW_ID" -H "Authorization: $STAFF_TOKEN"
ok "the sales report by category lists the top-level branches, drills into a branch's children with an 'In <name> itself' row and has_children, nets off discounts and refunds, falls back to the top level for a branch that is gone, exports full paths as CSV and keeps the branch in a saved view"

# --- 32n. The quick-key pages ---------------------------------------------------
S32_PAGES="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "perPage=100" --data-urlencode "sort=sort" "$BASE/api/collections/till_categories/records")"
S32_PAGES_CHECK="$(echo "$S32_PAGES" | node -e '
  const pages = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const active = pages.filter((p) => p.active).map((p) => p.name).join();
  const off = ["Sealed", "Accessories", "Services"].filter((n) => !pages.some((p) => p.name === n && p.active === false));
  process.stdout.write(active === "Quick" && !off.length ? "" : `active pages are "${active}"; not switched off: ${off.join()}`);
')"
[ -z "$S32_PAGES_CHECK" ] || fail "the quick-key pages after the tree: $S32_PAGES_CHECK"
S32_QUICK_KEYS="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=category.name='Quick'" "$BASE/api/collections/till_keys/records" | jval totalItems)"
[ "${S32_QUICK_KEYS:-0}" -ge 1 ] || fail "Quick has no keys"
S32_STATUS="$(s32_get "$S32_CLERK_TOKEN" "/api/vault/till/catalogue")"
[ "$(s32_js "r.categories.map((c) => c.name).join()")" = "Quick" ] || fail "the catalogue lists the pages $(s32_js "r.categories.map((c) => c.name).join()"), expected Quick alone"
ok "the pages migration switched off the seeded pages with no keys (Sealed, Accessories, Services), kept Quick, and the catalogue lists the one page then the branches"

# --- 32z. Leave the tree as it was found ----------------------------------------
# The stock this section made is written off (or deleted), the rows and products
# filed in its branches go to Unsorted, its branches are deleted deepest first, and the
# top level goes back in its original order.
s32_bulk_delete $S32_BULK_IDS $S32_PAGE_IDS
S32_LEFTOVERS="$(cat "$S32_DIR"/made-items.txt 2>/dev/null | tr '\n' ' ')"
for S32_ID in $S32_LEFTOVERS; do
  S32_ST="$(s32_rec items "$S32_ID" status)"
  case "$S32_ST" in
    in_stock|reserved|listed_ebay)
      curl -s -o /dev/null -X PATCH "$BASE/api/collections/items/records/$S32_ID" -H "Authorization: $SUPER_TOKEN" \
        -H "Content-Type: application/json" -d '{"status":"written_off","qty":0}' ;;
  esac
done
for S32_ID in $(cat "$S32_DIR"/made-products.txt 2>/dev/null | tr '\n' ' '); do
  curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S32_ID" -H "Authorization: $SUPER_TOKEN" \
    -H "Content-Type: application/json" -d '{"active":false}'
done
s32_tree
# Everything still filed in a branch staff added goes to Unsorted, a page at a time.
node -e '
  (async () => {
    const [base, token, treeFile] = process.argv.slice(1);
    const tree = JSON.parse(require("fs").readFileSync(treeFile, "utf8")).branches;
    const unsorted = tree.find((b) => b.key === "unsorted").id;
    const made = tree.filter((b) => b.key === "");
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { Authorization: token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    for (const kind of ["items", "products"]) {
      const collection = kind === "items" ? "items" : "till_products";
      for (const b of made) {
        for (;;) {
          const page = await call("GET", `/api/collections/${collection}/records?filter=${encodeURIComponent(`category="${b.id}"`)}&perPage=200&fields=id`);
          if (!page.body.items || !page.body.items.length) break;
          const res = await call("POST", "/api/vault/categories/assign", { category: unsorted, [kind]: page.body.items.map((r) => r.id) });
          if (res.status !== 200) { console.error(`could not file ${kind} out of ${b.path}: ${JSON.stringify(res.body)}`); process.exit(1); }
        }
      }
    }
  })();
' "$BASE" "$STAFF_TOKEN" "$S32_DIR/tree.json" || fail "could not empty the check branches"
# Deepest first; a branch left over after a pass is tried again with its children gone.
for S32_PASS in 1 2 3 4 5 6 7 8 9; do
  s32_tree
  S32_MADE="$(s32_t "t.filter((b) => b.key === '').sort((a, b) => b.depth - a.depth).map((b) => b.id).join(' ')")"
  [ -n "$S32_MADE" ] || break
  for S32_ID in $S32_MADE; do
    curl -s -o /dev/null -X DELETE "$BASE/api/collections/categories/records/$S32_ID" -H "Authorization: $STAFF_TOKEN"
  done
done
s32_tree
[ -z "$(s32_t "t.filter((b) => b.key === '').map((b) => b.path).join()")" ] || fail "the check branches are not all deleted: $(s32_t "t.filter((b) => b.key === '').map((b) => b.path).join()")"
S32_ORIGINAL_IDS="$(echo "$S32_ORIGINAL_TOP" | tr ',' '\n' | sed 's/:.*//' | sed 's/.*/"&"/' | paste -sd, -)"
S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/categories/reorder" "{\"parent\":\"\",\"order\":[$S32_ORIGINAL_IDS]}")"
s32_expect "$S32_STATUS" 200 "" "putting the top level back in its original order"
cp "$S32_DIR/last.json" "$S32_DIR/tree.json"
[ "$(s32_t "t.length")" = "$S32_ORIGINAL_COUNT" ] || fail "the tree has $(s32_t "t.length") branches, not the $S32_ORIGINAL_COUNT it started with"
[ "$(s32_t "t.filter((b) => b.parent === '').map((b) => b.id + ':' + b.sort).join()")" = "$S32_ORIGINAL_TOP" ] || fail "the top level is not back in its original order and numbering"
S32_PROBLEMS="$(s32_tree_problems seed)"
[ -z "$S32_PROBLEMS" ] || fail "the tree is not as it was found: $S32_PROBLEMS"
[ "$(s32_t "t.map((b) => b.key + ':' + b.counts.items + ':' + b.counts.items_total + ':' + b.counts.products).join()")" = "$S32_SHELF_BEFORE" ] \
  || fail "the shelf and product counts are not as they were found"
# The default register's till is as it was found: closed, or open on a session of its own.
s32_close_till
if [ -n "$S32_TILL_WAS_OPEN" ]; then
  S32_STATUS="$(s32_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":5000}')"
  s32_expect "$S32_STATUS" 200 "" "opening the till again"
fi
ok "section 32 leaves the tree as it found it: 235 branches, the top level in its original order, the same shelf and product counts, and the till as it was"
