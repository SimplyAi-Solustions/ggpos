# shellcheck shell=bash
# -----------------------------------------------------------------------
# 37. The public stock feed (docs/api-contract-launch.md, section 6;
#     pb/pb_hooks/public_stock.pb.js): only items marked show_online, in
#     stock and on the shelf appear, with no token; sold and reserved stock
#     leaves at once; the exact key set of every answer, so no private field
#     (cost, supplier, customer, location, note) can reach it; the minimum
#     price, the hidden quantity and the feed switched off; a branch marked
#     show_online starting new stock shown; search, the branch filter and
#     paging; one item with its photos; the categories with their online
#     counts; CORS for the website's two origins and nobody else, with a
#     minute of caching, across the whole /api/public/ prefix
#     (public_api.pb.js); and the prefix's one rate limit. The burst at the
#     end spends this client's /api/public/ budget for a minute.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR
# and the ok/fail/jval helpers. It deletes every item and branch it makes
# and puts settings.online back as it found it.
# -----------------------------------------------------------------------

S37_DIR="$TMP_DIR/s37"
mkdir -p "$S37_DIR"
S37_SITE="https://ggentertainment.co.uk"
S37_WWW="https://www.ggentertainment.co.uk"

# --- helpers -------------------------------------------------------------

# $1 path (with any query), [$2 Origin] -> the status; body in last.json, headers in last.headers.
s37_public() {
  local origin=()
  if [ -n "${2:-}" ]; then origin=(-H "Origin: $2"); fi
  curl -s -o "$S37_DIR/last.json" -D "$S37_DIR/last.headers" -w '%{http_code}' "$BASE$1" ${origin[@]+"${origin[@]}"}
}
s37_body() { cat "$S37_DIR/last.json"; }
s37_field() { jval "$1" <"$S37_DIR/last.json"; }
# $1 header name -> its value from the last answer, "" when absent.
s37_header() {
  grep -i "^$1:" "$S37_DIR/last.headers" | head -1 | sed -e 's/^[^:]*: *//' -e 's/\r$//'
}
# $1 JS expression over the last body parsed as `r` -> its value (objects as JSON).
s37_js() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$S37_DIR/last.json" "$1"
}
# $1 sku -> "yes" when the last list answer carries it.
s37_has() { s37_js "r.items.some((i) => i.sku === '$1') ? 'yes' : 'no'"; }
s37_track() { echo "$2" >> "$S37_DIR/made-$1.txt"; }

# $1 title, $2 kind, $3 price, $4 qty, $5 category id ("" for none), [$6 extra JSON, leading comma]
# -> the new item's id, made by the admin through the collection API.
s37_item() {
  local category=""
  if [ -n "$5" ]; then category=",\"category\":\"$5\""; fi
  local id
  id="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $STAFF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"kind\":\"$2\",\"game\":\"$S37_GAME\",\"title\":\"$1\",\"qty\":$4,\"cost\":98765,\"market_at_intake\":87654,\"price\":$3,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\",\"supplier_ref\":\"S37-SECRET-SUPPLIER\",\"notes\":\"S37-SECRET-NOTE\"$category${6:-}}" \
    | jval id)"
  [ -n "$id" ] || fail "37: could not create the item '$1'"
  s37_track items "$id"
  echo "$id"
}
# $1 id, $2 JSON patch, as the superuser.
s37_patch() {
  curl -s -o "$S37_DIR/patch.json" -w '%{http_code}' -X PATCH "$BASE/api/collections/$1" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d "$2"
}
s37_sku() { curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/items/records/$1" | jval sku; }
s37_online_flag() { curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/items/records/$1" | jval show_online; }

# $1 name, [$2 parent], [$3 extra JSON, leading comma] -> a new branch's id.
s37_branch() {
  local parent=""
  if [ -n "${2:-}" ]; then parent=",\"parent\":\"$2\""; fi
  local id
  id="$(curl -s -X POST "$BASE/api/collections/categories/records" -H "Authorization: $STAFF_TOKEN" \
    -H "Content-Type: application/json" -d "{\"name\":\"$1\",\"active\":true$parent${3:-}}" | jval id)"
  [ -n "$id" ] || fail "37: could not create the branch '$1'"
  s37_track branches "$id"
  echo "$id"
}

# settings.online as a JSON object string -> written by the superuser.
s37_online() {
  local status
  status="$(s37_patch "settings/records/$S37_SETTINGS_ID" "{\"online\":$1}")"
  [ "$status" = "200" ] || fail "37: could not write settings.online ($status): $(cat "$S37_DIR/patch.json")"
}

# Every key anywhere in the last body that is not in the allowed set, comma separated.
s37_stray_keys() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const allowed = new Set(process.argv[2].split(","));
    const stray = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") for (const k of Object.keys(v)) { if (!allowed.has(k)) stray.add(k); walk(v[k]); }
    };
    walk(r);
    process.stdout.write([...stray].join(","));
  ' "$S37_DIR/last.json" "$1"
}

# Sorted: the server writes JSON objects in no fixed order.
S37_ITEM_KEYS="category,condition,finish,game,image,price,qty,sku,title,updated"
S37_ITEM_KEYS_NO_QTY="category,condition,finish,game,image,price,sku,title,updated"
S37_DETAIL_ITEM_KEYS="category,condition,finish,game,image,photos,price,qty,sku,title,updated"
S37_FEED_KEYS="items,page,per_page,total,$S37_ITEM_KEYS,id,path,small,large,ratio"
S37_DETAIL_KEYS="$S37_ITEM_KEYS,photos,id,path,small,large,ratio"
S37_CATEGORY_KEYS="categories,id,name,parent,path,depth,count"

# --- setup ---------------------------------------------------------------

S37_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S37_GAME_NAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.name")"
[ -n "$S37_GAME" ] || fail "37: the seeded Pokémon game is missing"
S37_SETTINGS_ID="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/settings/records?perPage=1" | jval "items.0.id")"
[ -n "$S37_SETTINGS_ID" ] || fail "37: the settings record is missing"
S37_ONLINE_BEFORE="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/settings/records/$S37_SETTINGS_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(d).online ?? null)))')"
S37_LOCATION_NAME="S37 Secret Shelf"
S37_LOCATION="$(curl -s -X POST "$BASE/api/collections/locations/records" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"name\":\"$S37_LOCATION_NAME\"}" | jval id)"
[ -n "$S37_LOCATION" ] || fail "37: could not create a location"

s37_online '{"enabled":true,"min_price":0,"hide_qty":false}'

# Three branches: "S37 Online" marked show_online with "S37 Child" beneath it,
# and "S37 Plain" not marked.
S37_ONLINE_BRANCH="$(s37_branch "S37 Online" "" ',"show_online":true')"
S37_CHILD_BRANCH="$(s37_branch "S37 Child" "$S37_ONLINE_BRANCH")"
S37_PLAIN_BRANCH="$(s37_branch "S37 Plain")"

# Filed under the marked branch: starts shown, with every private field set.
S37_SHOWN="$(s37_item "S37 Charizard Zephyr" single 4500 1 "$S37_CHILD_BRANCH" ",\"condition\":\"NM\",\"finish\":\"holo\",\"location\":\"$S37_LOCATION\"")"
# Filed under the plain branch: starts hidden.
S37_HIDDEN="$(s37_item "S37 Hidden Pikachu" single 3000 1 "$S37_PLAIN_BRANCH")"
# Marked by hand, cheap, under the plain branch.
S37_CHEAP="$(s37_item "S37 Cheap Bulbasaur" single 200 1 "$S37_PLAIN_BRANCH" ',"show_online":true')"
# Marked, but none left on the shelf.
S37_EMPTY="$(s37_item "S37 Empty Booster Box" sealed 9000 0 "$S37_PLAIN_BRANCH" ',"show_online":true')"
# Marked, to be reserved.
S37_HELD="$(s37_item "S37 Held Mewtwo" single 6000 1 "$S37_CHILD_BRANCH")"
# Marked, with a photo.
S37_PHOTO="$(s37_item "S37 Photo Gengar" single 5000 1 "$S37_CHILD_BRANCH")"
S37_PHOTO_STATUS="$(curl -s -o "$S37_DIR/photo.json" -w '%{http_code}' -X PATCH "$BASE/api/collections/items/records/$S37_PHOTO" \
  -H "Authorization: $STAFF_TOKEN" -F "photos=@$ROOT/e2e/fixtures/id-sample.png;type=image/png")"
[ "$S37_PHOTO_STATUS" = "200" ] || fail "37: could not add a photo to an item ($S37_PHOTO_STATUS): $(cat "$S37_DIR/photo.json")"
S37_PHOTO_FILE="$(jval "photos.0" <"$S37_DIR/photo.json")"

S37_SHOWN_SKU="$(s37_sku "$S37_SHOWN")"
S37_HIDDEN_SKU="$(s37_sku "$S37_HIDDEN")"
S37_CHEAP_SKU="$(s37_sku "$S37_CHEAP")"
S37_EMPTY_SKU="$(s37_sku "$S37_EMPTY")"
S37_HELD_SKU="$(s37_sku "$S37_HELD")"
S37_PHOTO_SKU="$(s37_sku "$S37_PHOTO")"

# --- a branch marked show_online starts new stock shown -------------------

[ "$(s37_online_flag "$S37_SHOWN")" = "true" ] || fail "an item filed beneath a branch marked show_online did not start shown"
[ "$(s37_online_flag "$S37_HELD")" = "true" ] || fail "a second item filed beneath the marked branch did not start shown"
[ "$(s37_online_flag "$S37_HIDDEN")" = "false" ] || fail "an item filed in a plain branch started shown online"
[ "$(s37_online_flag "$S37_CHEAP")" = "true" ] || fail "an item created with show_online lost it"
ok "new stock filed in a branch marked show_online, or beneath one, starts shown; a plain branch's does not"

# --- the list: only shown, in stock, on the shelf --------------------------

S37_STATUS="$(s37_public "/api/public/stock")"
[ "$S37_STATUS" = "200" ] || fail "GET /api/public/stock with no token returned $S37_STATUS: $(s37_body)"
[ "$(s37_has "$S37_SHOWN_SKU")" = "yes" ] || fail "a shown, in-stock item is missing from the feed: $(s37_body)"
[ "$(s37_has "$S37_CHEAP_SKU")" = "yes" ] || fail "an item marked by hand is missing from the feed"
[ "$(s37_has "$S37_PHOTO_SKU")" = "yes" ] || fail "the item with a photo is missing from the feed"
[ "$(s37_has "$S37_HIDDEN_SKU")" = "no" ] || fail "an item not marked show_online is in the feed"
[ "$(s37_has "$S37_EMPTY_SKU")" = "no" ] || fail "an item with none on the shelf is in the feed"
[ "$(s37_field per_page)" = "24" ] || fail "the feed's per_page is $(s37_field per_page), not 24"
[ "$(s37_field page)" = "1" ] || fail "the feed's first page is not page 1"
ok "GET /api/public/stock answers with no token: shown, in-stock items with some on the shelf, 24 a page"

# --- the exact key set: nothing private anywhere ----------------------------

[ "$(s37_js "Object.keys(r).sort().join()")" = "items,page,per_page,total" ] || fail "the feed's envelope keys are $(s37_js "Object.keys(r).sort().join()")"
S37_BAD="$(s37_js "r.items.map((i) => Object.keys(i).sort().join()).filter((k) => k !== '$S37_ITEM_KEYS').join(' | ')")"
[ -z "$S37_BAD" ] || fail "a feed item's keys are not exactly $S37_ITEM_KEYS: $S37_BAD"
S37_BAD="$(s37_js "r.items.filter((i) => Object.keys(i.image).sort().join() !== 'large,ratio,small' || (i.category && Object.keys(i.category).sort().join() !== 'id,path')).map((i) => i.sku).join()")"
[ -z "$S37_BAD" ] || fail "a feed item's image or category keys are wrong: $S37_BAD"
S37_STRAY="$(s37_stray_keys "$S37_FEED_KEYS")"
[ -z "$S37_STRAY" ] || fail "the feed carries keys outside the contract: $S37_STRAY"
for S37_SECRET in "98765" "87654" "S37-SECRET-SUPPLIER" "S37-SECRET-NOTE" "$S37_LOCATION_NAME" "$S37_LOCATION" "$S37_SHOWN" "\"cost\"" "\"notes\"" "\"location\"" "\"supplier_ref\"" "\"reserved_for\"" "\"market_at_intake\""; do
  grep -qF "$S37_SECRET" "$S37_DIR/last.json" && fail "the feed leaks $S37_SECRET: $(s37_body)"
done
ok "every feed answer has exactly the contract's keys, and no cost, supplier, note, location or record id anywhere in it"

# --- what one item says ---------------------------------------------------

S37_ROW="r.items.find((i) => i.sku === '$S37_SHOWN_SKU')"
[ "$(s37_js "$S37_ROW.title")" = "S37 Charizard Zephyr" ] || fail "the feed's title is $(s37_js "$S37_ROW.title")"
[ "$(s37_js "$S37_ROW.price")" = "4500" ] || fail "the feed's price is $(s37_js "$S37_ROW.price"), not 4500 pence"
[ "$(s37_js "$S37_ROW.condition")" = "Near mint" ] || fail "the feed's condition is $(s37_js "$S37_ROW.condition")"
[ "$(s37_js "$S37_ROW.finish")" = "holo" ] || fail "the feed's finish is $(s37_js "$S37_ROW.finish")"
[ "$(s37_js "$S37_ROW.game")" = "$S37_GAME_NAME" ] || fail "the feed's game is $(s37_js "$S37_ROW.game"), not $S37_GAME_NAME"
[ "$(s37_js "$S37_ROW.category.id")" = "$S37_CHILD_BRANCH" ] || fail "the feed's category id is not the item's branch"
[ "$(s37_js "$S37_ROW.category.path")" = "S37 Online / S37 Child" ] || fail "the feed's category path is $(s37_js "$S37_ROW.category.path")"
[ "$(s37_js "$S37_ROW.qty")" = "1" ] || fail "the feed's qty is $(s37_js "$S37_ROW.qty")"
[ "$(s37_js "$S37_ROW.image.ratio")" = "0.7159" ] || fail "a card's frame is $(s37_js "$S37_ROW.image.ratio"), not 63:88"
[ "$(s37_js "/^\\d{4}-\\d\\d-\\d\\dT/.test($S37_ROW.updated) ? 'iso' : 'no'")" = "iso" ] || fail "updated is not an ISO date: $(s37_js "$S37_ROW.updated")"
S37_PHOTO_ROW="r.items.find((i) => i.sku === '$S37_PHOTO_SKU')"
[ "$(s37_js "$S37_PHOTO_ROW.image.large.endsWith('/$S37_PHOTO_FILE') ? 'yes' : 'no'")" = "yes" ] \
  || fail "the feed's image is not the item's first photo: $(s37_js "$S37_PHOTO_ROW.image")"
[ "$(s37_js "$S37_PHOTO_ROW.image.small.endsWith('/$S37_PHOTO_FILE?thumb=640x0') ? 'yes' : 'no'")" = "yes" ] \
  || fail "the feed's small image is not the photo's 640px thumb: $(s37_js "$S37_PHOTO_ROW.image.small")"
[ "$(s37_js "/^https?:\\/\\//.test($S37_PHOTO_ROW.image.large) ? 'yes' : 'no'")" = "yes" ] || fail "the photo URL is not absolute"
S37_PHOTO_URL="$(s37_js "$S37_PHOTO_ROW.image.large")"
S37_PHOTO_PATH="/${S37_PHOTO_URL#*://*/}"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$S37_PHOTO_PATH")" = "200" ] || fail "the feed's photo URL does not load with no token: $S37_PHOTO_PATH"
ok "a feed item: title, price in pence, condition in words, finish, game, branch path, quantity, a 63:88 frame, an ISO date, and the first photo with its thumb"

# --- one item by SKU ------------------------------------------------------

S37_STATUS="$(s37_public "/api/public/stock/$S37_PHOTO_SKU")"
[ "$S37_STATUS" = "200" ] || fail "GET /api/public/stock/{sku} returned $S37_STATUS: $(s37_body)"
[ "$(s37_js "Object.keys(r).sort().join()")" = "$S37_DETAIL_ITEM_KEYS" ] || fail "one item's keys are $(s37_js "Object.keys(r).sort().join()")"
S37_STRAY="$(s37_stray_keys "$S37_DETAIL_KEYS")"
[ -z "$S37_STRAY" ] || fail "one item carries keys outside the contract: $S37_STRAY"
[ "$(s37_js "r.photos.length")" = "1" ] || fail "one item does not list its photo"
[ "$(s37_js "r.photos[0].large === r.image.large ? 'yes' : 'no'")" = "yes" ] || fail "one item's first photo is not its image"
grep -qF "S37-SECRET" "$S37_DIR/last.json" && fail "one item leaks a private field: $(s37_body)"
S37_STATUS="$(s37_public "/api/public/stock/$(echo "$S37_SHOWN_SKU" | sed 's/^\(...\)/\1-/')")"
[ "$S37_STATUS" = "200" ] || fail "an item asked for by its printed code (with the hyphen) returned $S37_STATUS"
for S37_SKU in "$S37_HIDDEN_SKU" "$S37_EMPTY_SKU" "GGS00000Z"; do
  S37_STATUS="$(s37_public "/api/public/stock/$S37_SKU")"
  [ "$S37_STATUS" = "404" ] || fail "GET /api/public/stock/$S37_SKU (not online) returned $S37_STATUS"
  [ "$(s37_field message)" = "That item is not on sale online. It may have just sold." ] || fail "the 404 said '$(s37_field message)'"
done
ok "GET /api/public/stock/{sku}: one item with its photos and nothing else; a hidden, empty or unknown one is 404 with the sentence"

# --- search, the branch filter and paging ----------------------------------

s37_public "/api/public/stock?q=zephyr" >/dev/null
[ "$(s37_has "$S37_SHOWN_SKU")" = "yes" ] && [ "$(s37_field total)" = "1" ] || fail "a search for one word of a title did not find exactly that item: $(s37_body)"
s37_public "/api/public/stock?q=S37%20gengar" >/dev/null
[ "$(s37_js "r.items.map((i) => i.sku).join()")" = "$S37_PHOTO_SKU" ] || fail "a two-word search did not narrow to the item matching both"
s37_public "/api/public/stock?q=$S37_SHOWN_SKU" >/dev/null
[ "$(s37_has "$S37_SHOWN_SKU")" = "yes" ] || fail "a search by code did not find the item"
s37_public "/api/public/stock?q=100%25" >/dev/null
[ "$(s37_field total)" = "0" ] || fail "a % in the search was taken as a wildcard"
s37_public "/api/public/stock?category=$S37_ONLINE_BRANCH" >/dev/null
[ "$(s37_has "$S37_SHOWN_SKU")" = "yes" ] && [ "$(s37_has "$S37_CHEAP_SKU")" = "no" ] \
  || fail "the branch filter does not take in the branch's subtree, or lets another branch in: $(s37_body)"
s37_public "/api/public/stock?category=$S37_PLAIN_BRANCH" >/dev/null
[ "$(s37_js "r.items.map((i) => i.sku).join()")" = "$S37_CHEAP_SKU" ] || fail "the plain branch shows $(s37_js "r.items.map((i) => i.sku).join()")"
s37_public "/api/public/stock?category=nosuchbranch" >/dev/null
[ "$(s37_field total)" = "0" ] || fail "an unknown branch did not answer an empty page"
s37_public "/api/public/stock?category=$S37_ONLINE_BRANCH&page=2" >/dev/null
[ "$(s37_js "r.items.length")" = "0" ] && [ "$(s37_field page)" = "2" ] && [ "$(s37_field total)" = "3" ] \
  || fail "page 2 of a three-item branch is not empty with the total: $(s37_body)"
ok "search (every word, the code, a literal %), the branch filter over its subtree, and paging"

# --- the minimum price, hidden quantities and the switch --------------------

s37_online '{"enabled":true,"min_price":500,"hide_qty":false}'
s37_public "/api/public/stock" >/dev/null
[ "$(s37_has "$S37_CHEAP_SKU")" = "no" ] || fail "an item under the minimum price is still in the feed"
[ "$(s37_has "$S37_SHOWN_SKU")" = "yes" ] || fail "an item over the minimum price left the feed"
[ "$(s37_public "/api/public/stock/$S37_CHEAP_SKU")" = "404" ] || fail "one item under the minimum price is not 404"
s37_online '{"enabled":true,"min_price":200,"hide_qty":false}'
s37_public "/api/public/stock" >/dev/null
[ "$(s37_has "$S37_CHEAP_SKU")" = "yes" ] || fail "an item priced exactly at the minimum is not in the feed"
ok "nothing below settings.online.min_price shows; an item at it does"

s37_online '{"enabled":true,"min_price":0,"hide_qty":true}'
s37_public "/api/public/stock" >/dev/null
S37_BAD="$(s37_js "r.items.map((i) => Object.keys(i).sort().join()).filter((k) => k !== '$S37_ITEM_KEYS_NO_QTY').join(' | ')")"
[ -z "$S37_BAD" ] || fail "with hide_qty an item's keys are not exactly $S37_ITEM_KEYS_NO_QTY: $S37_BAD"
s37_public "/api/public/stock/$S37_SHOWN_SKU" >/dev/null
[ "$(s37_js "'qty' in r ? 'yes' : 'no'")" = "no" ] || fail "with hide_qty one item still says its quantity"
ok "with hide_qty no answer carries a quantity"

s37_online '{"enabled":false,"min_price":0,"hide_qty":false}'
s37_public "/api/public/stock" >/dev/null
[ "$(s37_field total)" = "0" ] && [ "$(s37_js "r.items.length")" = "0" ] || fail "the feed switched off still lists stock"
[ "$(s37_public "/api/public/stock/$S37_SHOWN_SKU")" = "404" ] || fail "one item is still answered with the feed switched off"
s37_public "/api/public/categories" >/dev/null
[ "$(s37_js "r.categories.length")" = "0" ] || fail "the categories still list branches with the feed switched off"
s37_online '{"enabled":true,"min_price":0,"hide_qty":false}'
ok "with the feed switched off the list and the categories are empty and every item is 404"

# --- sold and reserved stock leaves at once ---------------------------------

[ "$(s37_patch "items/records/$S37_HELD" '{"status":"reserved"}')" = "200" ] || fail "could not reserve an item"
s37_public "/api/public/stock" >/dev/null
[ "$(s37_has "$S37_HELD_SKU")" = "no" ] || fail "a reserved item is still in the feed"
[ "$(s37_public "/api/public/stock/$S37_HELD_SKU")" = "404" ] || fail "a reserved item is still answered by SKU"
[ "$(s37_patch "items/records/$S37_CHEAP" '{"status":"sold","qty":0}')" = "200" ] || fail "could not mark an item sold"
s37_public "/api/public/stock" >/dev/null
[ "$(s37_has "$S37_CHEAP_SKU")" = "no" ] || fail "a sold item is still in the feed"
[ "$(s37_public "/api/public/stock/$S37_CHEAP_SKU")" = "404" ] || fail "a sold item is still answered by SKU"
[ "$(s37_patch "items/records/$S37_HELD" '{"status":"in_stock"}')" = "200" ] || fail "could not put the held item back"
s37_public "/api/public/stock" >/dev/null
[ "$(s37_has "$S37_HELD_SKU")" = "yes" ] || fail "an item back on the shelf did not return to the feed"
ok "reserved and sold stock leaves the feed on the next read, and returns when it is back on the shelf"

# --- the categories ---------------------------------------------------------

S37_STATUS="$(s37_public "/api/public/categories")"
[ "$S37_STATUS" = "200" ] || fail "GET /api/public/categories returned $S37_STATUS"
S37_STRAY="$(s37_stray_keys "$S37_CATEGORY_KEYS")"
[ -z "$S37_STRAY" ] || fail "the categories carry keys outside the contract: $S37_STRAY"
S37_BAD="$(s37_js "r.categories.map((c) => Object.keys(c).sort().join()).filter((k) => k !== 'count,depth,id,name,parent,path').join(' | ')")"
[ -z "$S37_BAD" ] || fail "a category's keys are wrong: $S37_BAD"
S37_CAT="(id) => r.categories.find((c) => c.id === id)"
[ "$(s37_js "($S37_CAT)('$S37_CHILD_BRANCH').count")" = "3" ] || fail "the child branch's online count is $(s37_js "($S37_CAT)('$S37_CHILD_BRANCH')")"
[ "$(s37_js "($S37_CAT)('$S37_ONLINE_BRANCH').count")" = "3" ] || fail "the marked branch does not count its subtree: $(s37_js "($S37_CAT)('$S37_ONLINE_BRANCH')")"
[ "$(s37_js "($S37_CAT)('$S37_CHILD_BRANCH').parent")" = "$S37_ONLINE_BRANCH" ] || fail "the child branch's parent is wrong"
[ "$(s37_js "($S37_CAT)('$S37_CHILD_BRANCH').path")" = "S37 Online / S37 Child" ] || fail "the child branch's path is wrong"
[ "$(s37_js "($S37_CAT)('$S37_CHILD_BRANCH').depth")" = "1" ] || fail "the child branch's depth is wrong"
[ "$(s37_js "($S37_CAT)('$S37_PLAIN_BRANCH') ? 'yes' : 'no'")" = "no" ] || fail "a branch with nothing online is listed"
[ "$(s37_js "r.categories.findIndex((c) => c.id === '$S37_ONLINE_BRANCH') < r.categories.findIndex((c) => c.id === '$S37_CHILD_BRANCH') ? 'yes' : 'no'")" = "yes" ] \
  || fail "the categories are not depth first"
[ "$(s37_patch "categories/records/$S37_CHILD_BRANCH" '{"active":false}')" = "200" ] || fail "could not switch the child branch off"
s37_public "/api/public/categories" >/dev/null
[ "$(s37_js "($S37_CAT)('$S37_CHILD_BRANCH') ? 'yes' : 'no'")" = "no" ] || fail "a branch switched off is still listed"
[ "$(s37_patch "categories/records/$S37_CHILD_BRANCH" '{"active":true}')" = "200" ] || fail "could not switch the child branch back on"
ok "GET /api/public/categories: the visible branches with online stock, depth first, each with its subtree's count"

# --- CORS and caching -------------------------------------------------------

for S37_PATH in "/api/public/stock" "/api/public/stock/$S37_SHOWN_SKU" "/api/public/categories"; do
  s37_public "$S37_PATH" "$S37_SITE" >/dev/null
  [ "$(s37_header Access-Control-Allow-Origin)" = "$S37_SITE" ] || fail "$S37_PATH does not allow $S37_SITE: '$(s37_header Access-Control-Allow-Origin)'"
  [ "$(s37_header Cache-Control)" = "public, max-age=60" ] || fail "$S37_PATH caches for '$(s37_header Cache-Control)'"
  grep -qi '^vary:.*origin' "$S37_DIR/last.headers" || fail "$S37_PATH does not vary by Origin"
  s37_public "$S37_PATH" "$S37_WWW" >/dev/null
  [ "$(s37_header Access-Control-Allow-Origin)" = "$S37_WWW" ] || fail "$S37_PATH does not allow $S37_WWW"
  s37_public "$S37_PATH" "https://evil.example" >/dev/null
  [ -z "$(s37_header Access-Control-Allow-Origin)" ] || fail "$S37_PATH allows another origin: '$(s37_header Access-Control-Allow-Origin)'"
  s37_public "$S37_PATH" "http://ggentertainment.co.uk" >/dev/null
  [ -z "$(s37_header Access-Control-Allow-Origin)" ] || fail "$S37_PATH allows the site over plain http"
  s37_public "$S37_PATH" >/dev/null
  [ -z "$(s37_header Access-Control-Allow-Origin)" ] || fail "$S37_PATH sends a CORS header with no Origin"
done
s37_public "/api/public/stock/GGS00000Z" "$S37_SITE" >/dev/null
[ "$(s37_header Access-Control-Allow-Origin)" = "$S37_SITE" ] || fail "a 404 from the feed cannot be read by the website"
S37_PREFLIGHT="$(curl -s -o /dev/null -D - -w '%{http_code}' -X OPTIONS "$BASE/api/public/stock" -H "Origin: $S37_SITE" -H "Access-Control-Request-Method: GET")"
echo "$S37_PREFLIGHT" | grep -qi "^access-control-allow-origin: $S37_SITE" || fail "the preflight does not allow the website: $S37_PREFLIGHT"
S37_PREFLIGHT="$(curl -s -o /dev/null -D - -X OPTIONS "$BASE/api/public/categories" -H "Origin: https://evil.example" -H "Access-Control-Request-Method: GET")"
echo "$S37_PREFLIGHT" | grep -qi '^access-control-allow-origin' && fail "the preflight allows another origin: $S37_PREFLIGHT"
ok "CORS for https://ggentertainment.co.uk and https://www.ggentertainment.co.uk only (answers, 404s and the preflight), varying by Origin, cached for a minute"

# The whole prefix, not the feed alone: any route under /api/public/ (the
# bookings server's too) gets the same headers, and nothing outside it does.
s37_public "/api/public/s37-no-such-route" "$S37_SITE" >/dev/null
[ "$(s37_header Access-Control-Allow-Origin)" = "$S37_SITE" ] || fail "another path under /api/public/ does not allow the website: '$(s37_header Access-Control-Allow-Origin)'"
s37_public "/api/public/s37-no-such-route" "https://evil.example" >/dev/null
[ -z "$(s37_header Access-Control-Allow-Origin)" ] || fail "another path under /api/public/ allows another origin"
S37_PREFLIGHT="$(curl -s -o /dev/null -D - -X OPTIONS "$BASE/api/public/availability" -H "Origin: $S37_WWW" -H "Access-Control-Request-Method: GET")"
echo "$S37_PREFLIGHT" | grep -qi "^access-control-allow-origin: $S37_WWW" || fail "a preflight elsewhere under /api/public/ does not allow the website: $S37_PREFLIGHT"
s37_public "/api/health" "https://evil.example" >/dev/null
[ "$(s37_header Access-Control-Allow-Origin)" = "*" ] || fail "a route outside /api/public/ lost PocketBase's own CORS: '$(s37_header Access-Control-Allow-Origin)'"
[ -z "$(s37_header Cache-Control)" ] || fail "a route outside /api/public/ is cached: $(s37_header Cache-Control)"
ok "every route under /api/public/ carries the same CORS and caching, and nothing outside the prefix does"

# --- the rate limit ---------------------------------------------------------

# One budget for the whole prefix: a burst on the categories trips it.
S37_BURST="$(for _ in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/public/categories"; done)"
grep -q '^429$' <<<"$S37_BURST" || fail "200 reads of /api/public/categories in a burst never tripped the rate limit"
S37_STATUS="$(s37_public "/api/public/stock" "$S37_SITE")"
[ "$S37_STATUS" = "429" ] || fail "the stock feed shares no budget with the categories: $S37_STATUS after the burst"
[ "$(s37_header Access-Control-Allow-Origin)" = "$S37_SITE" ] || fail "a 429 cannot be read by the website"
[ -z "$(s37_header Cache-Control)" ] || fail "a 429 is cached: $(s37_header Cache-Control)"
S37_LIMITS="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/settings" | node -e '
  let d=""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const rules = JSON.parse(d).rateLimits.rules;
    const r = rules.find((rule) => rule.label === "/api/public/");
    process.stdout.write(r ? `${r.maxRequests}/${r.duration}/${r.audience || "all"}` : "missing");
  });')"
[ "$S37_LIMITS" = "180/60/all" ] || fail "the /api/public/ rate limit rule is $S37_LIMITS, not 180 a minute for everyone"
ok "every /api/public/ route shares one rate limit per client (180 a minute): a burst is refused with 429, readable by the website and never cached"

# --- tidy up ----------------------------------------------------------------

for S37_ID in $(cat "$S37_DIR/made-items.txt"); do
  curl -s -o /dev/null -X DELETE "$BASE/api/collections/items/records/$S37_ID" -H "Authorization: $SUPER_TOKEN"
done
for S37_ID in "$S37_CHILD_BRANCH" "$S37_ONLINE_BRANCH" "$S37_PLAIN_BRANCH"; do
  S37_STATUS="$(curl -s -o "$S37_DIR/delete.json" -w '%{http_code}' -X DELETE "$BASE/api/collections/categories/records/$S37_ID" -H "Authorization: $STAFF_TOKEN")"
  [ "$S37_STATUS" = "204" ] || fail "37: could not delete the branch $S37_ID ($S37_STATUS): $(cat "$S37_DIR/delete.json")"
done
curl -s -o /dev/null -X DELETE "$BASE/api/collections/locations/records/$S37_LOCATION" -H "Authorization: $SUPER_TOKEN"
s37_online "$S37_ONLINE_BEFORE"
ok "section 37 deletes its items, branches and location, and puts settings.online back as it was"
