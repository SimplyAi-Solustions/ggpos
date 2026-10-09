# shellcheck shell=bash
# -----------------------------------------------------------------------
# 31. Part-exchange and exchanges in one ticket (docs/api-contract-epos.md,
#     section 7): a trade-in worth less than the sale, exactly the sale and
#     more than it (the surplus as store credit, and as cash under the
#     buy-in's own cap and ID gate), the item costs spread to what was paid
#     when part of a cash surplus is left with the shop, the trade-in's
#     number, items, labels, links and audit, points once, every refusal, a
#     trade-in already completed, exchanges smaller and larger than the new
#     sale, a ticket of returns alone, a ticket with both, replays, the X and
#     the Z, the receipts, and the buy-in and refund routes as they were.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR
# and the ok/fail/jval helpers. It runs its own till session, closes it
# with a Z, and leaves the default register's till open again with the cash
# cap as it found it.
# -----------------------------------------------------------------------

S31_DIR="$TMP_DIR/s31"
mkdir -p "$S31_DIR"

# --- helpers -------------------------------------------------------------

# $1 token, $2 path, $3 JSON body, [$4 an extra header] -> the status code;
# the body is left in $S31_DIR/last.json.
s31_post() {
  local extra=()
  if [ -n "${4:-}" ]; then extra=(-H "$4"); fi
  curl -s -o "$S31_DIR/last.json" -w '%{http_code}' -X POST "$BASE$2" \
    -H "Authorization: $1" -H "Content-Type: application/json" ${extra[@]+"${extra[@]}"} -d "$3"
}

# $1 token, $2 path -> the status code; the body is left in $S31_DIR/last.json.
s31_get() {
  curl -s -o "$S31_DIR/last.json" -w '%{http_code}' "$BASE$2" -H "Authorization: $1"
}

s31_body() { cat "$S31_DIR/last.json"; }
s31_field() { jval "$1" <"$S31_DIR/last.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
s31_expect() {
  [ "$1" = "$2" ] || fail "$4 returned $1, expected $2: $(s31_body)"
  if [ -n "$3" ]; then
    [ "$(s31_field message)" = "$3" ] || fail "$4 said '$(s31_field message)', expected '$3'"
  fi
}

# $1 collection, $2 filter -> the superuser's list of matching records.
s31_list() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    --data-urlencode "perPage=200" --data-urlencode "sort=created,id" "$BASE/api/collections/$1/records"
}

# $1 collection, $2 filter -> how many records match.
s31_count() { s31_list "$1" "$2" | jval totalItems; }

# $1 collection, $2 id -> the record, as the superuser reads it.
s31_record() {
  curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/$1/records/$2"
}

# $1 title, $2 qty, $3 price, [$4 kind, default sealed] -> item id.
s31_item() {
  curl -s -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"${4:-sealed}\",\"game\":\"$S31_GAME\",\"title\":\"$1\",\"qty\":$2,\"cost\":100,\"price\":$3,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"}" \
    | jval id
}

# $1 name -> customer id.
s31_customer() {
  curl -s -X POST "$BASE/api/collections/customers/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"source\":\"counter\"}" | jval id
}

# $1 customer, [$2 status, default draft], then one JSON object per line
# (without trade_in or game) -> the draft trade-in's id, built through the
# collection API as the till's Trade-in panel builds it.
s31_trade() {
  local customer="$1" status="$2" id line
  shift 2
  id="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"customer\":\"$customer\",\"status\":\"$status\",\"channel\":\"counter\"}" | jval id)"
  [ -n "$id" ] || fail "could not create a $status trade-in"
  for line in "$@"; do
    line="${line%\}},\"trade_in\":\"$id\",\"game\":\"$S31_GAME\",\"market_currency\":\"GBP\"}"
    [ -n "$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" \
      -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$line" | jval id)" ] \
      || fail "could not add a line to trade-in $id: $line"
  done
  echo "$id"
}

# $1 sale id, $2 item id -> that item's sale line id.
s31_line_of() {
  s31_list sale_lines "sale='$1' && item='$2'" | jval "items.0.id"
}

# $1 pence -> £1,234.56, through the shared formatter itself.
s31_gbp() {
  node --experimental-strip-types -e "
    const { formatGBP } = require('$ROOT/packages/shared/src/money.ts');
    process.stdout.write(formatGBP(Number(process.argv[1])));
  " "$1" 2>/dev/null
}

# $1 capability, $2 requested_by -> a raw override token whose sha256 is now
# a live, unused till_overrides row approved by the admin (as 30-sales.sh).
s31_override() {
  local token hash expires
  token="s31-$1-$RANDOM-$RANDOM-$$"
  hash="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$token")"
  expires="$(node -e 'process.stdout.write(new Date(Date.now() + 5 * 60000).toISOString().replace("T", " "))')"
  curl -s -o "$S31_DIR/override.json" -X POST "$BASE/api/collections/till_overrides/records" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"token_hash\":\"$hash\",\"capability\":\"$1\",\"requested_by\":\"$2\",\"approver\":\"$S31_ADMIN_ID\",\"expires_at\":\"$expires\"}"
  [ -n "$(jval id <"$S31_DIR/override.json")" ] || fail "could not write a $1 override row: $(cat "$S31_DIR/override.json")"
  echo "$token"
}

# The default register's open session, or "".
s31_session() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id"
}

# What the default register's drawer should hold now.
s31_expected() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected
}

# A tender's field from a response's `tenders` (or any list at $1): $1 the
# list's path in the last response, $2 the method, $3 the field.
s31_tender() {
  s31_body | node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
    let list = body;
    for (const key of process.argv[1].split(".")) list = list == null ? null : list[key];
    const found = (list || []).filter((t) => t.method === process.argv[2]);
    process.stdout.write(found.length === 1 ? String(found[0][process.argv[3]]) : found.length ? "many" : "");
  ' "$1" "$2" "$3"
}

# $1 settings JSON patch.
s31_settings() {
  curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$S31_SETTINGS_ID" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$1"
}

S31_SIGNATURE="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

# --- setup ---------------------------------------------------------------

S31_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$S31_GAME" ] || fail "31: the seeded pokemon game is missing"
S31_ADMIN_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval id)"
S31_SETTINGS_ID="$(curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S31_REGISTER="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=active=true" \
  --data-urlencode "sort=sort,created" "$BASE/api/collections/registers/records" | jval "items.0.id")"
[ -n "$S31_ADMIN_ID" ] && [ -n "$S31_SETTINGS_ID" ] && [ -n "$S31_REGISTER" ] || fail "31: setup could not read the admin, settings or register"
S31_CAP_BEFORE="$(s31_record settings "$S31_SETTINGS_ID" | jval cash_cap)"
s31_settings '{"cash_cap":800000}'

S31_CLERK_EMAIL="s31-clerk@local.test"
S31_CLERK_PASSWORD="s31-clerk-password-123"
S31_CLERK_ID="$(curl -s -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$S31_CLERK_EMAIL\",\"password\":\"$S31_CLERK_PASSWORD\",\"passwordConfirm\":\"$S31_CLERK_PASSWORD\",\"name\":\"Jo Swap\",\"role\":\"staff\",\"active\":true}" | jval id)"
S31_CLERK_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" -d "{\"identity\":\"$S31_CLERK_EMAIL\",\"password\":\"$S31_CLERK_PASSWORD\"}" | jval token)"
[ -n "$S31_CLERK_TOKEN" ] || fail "31: the plain staff member could not sign in"

S31_PAT="$(s31_customer "Pat Exchange")"
S31_CASH="$(s31_customer "Casey Cash")"
S31_RET="$(s31_customer "Robin Returns")"
[ -n "$S31_PAT" ] && [ -n "$S31_CASH" ] && [ -n "$S31_RET" ] || fail "31: could not create the check customers"

# A till of our own: whatever is open on the default register is closed at
# its expected total, then the legacy route opens it with a £200.00 float.
S31_OPEN="$(s31_session)"
if [ -n "$S31_OPEN" ]; then
  curl -s -o /dev/null -X POST "$BASE/api/vault/cash-sessions/$S31_OPEN/close" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"counted\":$(s31_expected)}"
fi
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":20000}')"
s31_expect "$S31_STATUS" 200 "" "opening the till for section 31"
S31_SESSION="$(s31_field "session.id")"
[ "$(s31_session)" = "$S31_SESSION" ] || fail "31: the till did not open on the default register"
ok "section 31 runs on a till session of its own with a £200.00 float"

# --- 31a. The refusals, before anything is written ------------------------
S31_A_ITEM="$(s31_item "S31 Booster Box" 1 3000)"
S31_A_TRADE="$(s31_trade "$S31_PAT" draft \
  '{"kind":"single","free_text_title":"S31 Pikachu","condition":"NM","qty":1,"market_price":900,"offer_price":600,"accepted":true}' \
  '{"kind":"sealed","free_text_title":"S31 Bundle","qty":2,"market_price":300,"offer_price":200,"accepted":true}')"
S31_EMPTY_TRADE="$(s31_trade "$S31_PAT" draft \
  '{"kind":"single","free_text_title":"S31 Not taken","condition":"LP","qty":1,"market_price":500,"offer_price":300,"accepted":false}')"
S31_CANCELLED_TRADE="$(s31_trade "$S31_PAT" cancelled \
  '{"kind":"single","free_text_title":"S31 Cancelled","condition":"NM","qty":1,"market_price":500,"offer_price":300,"accepted":true}')"
S31_TERMS='"trade_settlement":{"terms_accepted":true}'

s31_refusal() {
  # $1 body, $2 expected status, $3 expected sentence, $4 what
  local status
  status="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$1")"
  s31_expect "$status" "$2" "$3" "$4"
}
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"trade_in\":\"$S31_A_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}" \
  400 "Add the customer before taking a trade-in." "a trade-in on a ticket with no customer"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"nosuchtradein01\",$S31_TERMS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}" \
  404 "That trade-in was not found. Start the trade-in again." "a trade-in that does not exist"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_CASH\",\"trade_in\":\"$S31_A_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}" \
  400 "That trade-in is for a different customer. Start it again with the customer on the ticket." "another customer's trade-in"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_CANCELLED_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":2700,\"card_last4\":\"4242\"}]}" \
  409 "That trade-in is cancelled. Start a new one." "a cancelled trade-in"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_EMPTY_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":3000,\"card_last4\":\"4242\"}]}" \
  422 "Accept at least one line before completing this trade-in." "a trade-in with no accepted line"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_A_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":1500,\"card_last4\":\"4242\"}]}" \
  400 "The payments come to £15.00 but £20.00 is left after the trade-in." "tenders short of what the trade-in leaves"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_A_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"part_exchange\",\"amount\":500},{\"method\":\"card_tide\",\"amount\":2500,\"card_last4\":\"4242\"}]}" \
  400 "The trade-in pays £10.00 towards this sale, not £5.00. Reload the ticket and try again." "a part-exchange tender that is not the trade-in's"
s31_refusal "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_A_TRADE\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}" \
  422 "Ask the customer to accept the terms before completing." "a part-exchange without the terms"
s31_refusal "{\"lines\":[],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_A_TRADE\",$S31_TERMS,\"tenders\":[]}" \
  400 "Add at least one item to the sale." "a trade-in with nothing to pay for"
[ "$(s31_record items "$S31_A_ITEM" | jval status)" = "in_stock" ] || fail "a refused part-exchange sold the item"
S31_A_ROW="$(s31_record trade_ins "$S31_A_TRADE")"
[ "$(echo "$S31_A_ROW" | jval status)" = "draft" ] && [ -z "$(echo "$S31_A_ROW" | jval number)" ] \
  || fail "a refused part-exchange touched the trade-in: $S31_A_ROW"
ok "a part-exchange is refused with the contract's sentences, and a refusal writes nothing"

# --- 31b. A trade worth less than the sale: part-exchange and card ------
# A control sale first: the same £30.00 on card for the same customer, so
# the part-exchange's points can be held against a sale's own. A £1.00
# sale before it means neither is the customer's first purchase.
S31_WARM_ITEM="$(s31_item "S31 Penny Sleeve" 1 100)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_WARM_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":100,\"card_last4\":\"4242\"}]}")"
s31_expect "$S31_STATUS" 200 "" "the customer's first sale"
S31_CTRL_ITEM="$(s31_item "S31 Control Box" 1 3000)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_CTRL_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":3000,\"card_last4\":\"4242\"}]}")"
s31_expect "$S31_STATUS" 200 "" "the control sale"
S31_CTRL_POINTS="$(s31_field points_earned)"
[ "$S31_CTRL_POINTS" -gt 0 ] || fail "the control sale earned no points, so points once cannot be checked"

S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_A_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_A_TRADE\",\"trade_settlement\":{\"terms_accepted\":true,\"signature\":\"$S31_SIGNATURE\"},\"tenders\":[{\"method\":\"card_tide\",\"amount\":2000,\"card_last4\":\"4242\"}]}")"
s31_expect "$S31_STATUS" 200 "" "a part-exchange worth less than the sale"
cp "$S31_DIR/last.json" "$S31_DIR/b.json"
S31_B_SALE="$(s31_field "sale.id")"
S31_B_NUMBER="$(s31_field "sale.number")"
S31_B_TRADE_NUMBER="$(s31_field "trade_in.number")"
echo "$S31_B_TRADE_NUMBER" | grep -Eq '^GG-BI-[0-9]{6}$' || fail "the part-exchange's trade-in number is '$S31_B_TRADE_NUMBER'"
[ "$(s31_field "trade_in.id")" = "$S31_A_TRADE" ] && [ "$(s31_field "trade_in.value")" = "1000" ] \
  && [ "$(s31_field "trade_in.applied")" = "1000" ] && [ "$(s31_field "trade_in.payout_cash")" = "0" ] \
  && [ "$(s31_field "trade_in.payout_credit")" = "0" ] || fail "the response's trade_in block is wrong: $(s31_body)"
[ "$(s31_tender tenders part_exchange amount)" = "1000" ] && [ "$(s31_tender tenders part_exchange label)" = "Part-exchange" ] \
  || fail "the sale has no £10.00 Part-exchange tender: $(s31_body)"
[ "$(s31_tender tenders card_tide amount)" = "2000" ] || fail "the card tender is not the £20.00 left"
[ "$(s31_field refund)" = "" ] || fail "a sale with no returns answered a refund block"
S31_B_ROW="$(s31_record sales "$S31_B_SALE")"
[ "$(echo "$S31_B_ROW" | jval trade_in)" = "$S31_A_TRADE" ] || fail "sales.trade_in does not point at the trade-in"
[ "$(echo "$S31_B_ROW" | jval total)" = "3000" ] && [ "$(echo "$S31_B_ROW" | jval payment)" = "mixed" ] \
  || fail "the sale's total or payment is wrong: $S31_B_ROW"
[ "$(echo "$S31_B_ROW" | jval payment_split.part_exchange)" = "1000" ] || fail "payment_split does not mirror the part-exchange"
S31_B_PX_ROW="$(s31_list sale_tenders "sale='$S31_B_SALE' && method='part_exchange'")"
[ "$(echo "$S31_B_PX_ROW" | jval totalItems)" = "1" ] && [ "$(echo "$S31_B_PX_ROW" | jval items.0.amount)" = "1000" ] \
  && [ "$(echo "$S31_B_PX_ROW" | jval items.0.session)" = "$S31_SESSION" ] || fail "the part_exchange tender row is wrong: $S31_B_PX_ROW"

S31_B_TRADE_ROW="$(s31_record trade_ins "$S31_A_TRADE")"
S31_B_TRADE_CHECK="$(echo "$S31_B_TRADE_ROW" | node -e '
  const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const want = { status: "completed", sale: process.argv[1], part_exchange_value: 1000, payout_type: "part_exchange",
    payout_cash: 0, payout_credit: 0, total_offer: 1000, total_market: 1500, cash_session: process.argv[2],
    staff: process.argv[3], number: process.argv[4], seller_name: "Pat Exchange" };
  const problems = Object.keys(want).filter((k) => t[k] !== want[k]).map((k) => `${k} is ${JSON.stringify(t[k])}`);
  if (!t.signature) problems.push("no signature");
  if (!t.completed_at) problems.push("no completed_at");
  process.stdout.write(problems.join("; "));
' "$S31_B_SALE" "$S31_SESSION" "$S31_ADMIN_ID" "$S31_B_TRADE_NUMBER")"
[ -z "$S31_B_TRADE_CHECK" ] || fail "the part-exchanged trade-in is wrong: $S31_B_TRADE_CHECK"

S31_B_LINES="$(s31_list trade_in_lines "trade_in='$S31_A_TRADE' && accepted=true")"
S31_B_ITEMS="$(s31_list items "trade_in_line.trade_in='$S31_A_TRADE'")"
S31_B_ITEM_CHECK="$(echo "$S31_B_ITEMS" | node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const got = items.map((i) => `${i.title}:${i.kind}:${i.qty}:${i.cost}:${i.status}:${i.source}`).sort().join(",");
  process.stdout.write(got);
')"
[ "$S31_B_ITEM_CHECK" = "S31 Bundle:sealed:2:200:in_stock:trade_in,S31 Pikachu:single:1:600:in_stock:trade_in" ] \
  || fail "the trade-in's items are '$S31_B_ITEM_CHECK'"
for S31_IDX in 0 1; do
  [ -n "$(echo "$S31_B_LINES" | jval "items.$S31_IDX.item")" ] || fail "trade-in line $S31_IDX is not linked to its item"
done
S31_B_ITEM_IDS="$(echo "$S31_B_ITEMS" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).items.map((i)=>`item=\x27${i.id}\x27`).join(" || "))')"
[ "$(s31_count label_jobs "($S31_B_ITEM_IDS) && status='queued'")" = "2" ] || fail "the trade-in's two items have no queued labels"
S31_B_AUDIT="$(s31_list audit_log "action='trade_in_complete' && record='$S31_A_TRADE'")"
[ "$(echo "$S31_B_AUDIT" | jval totalItems)" = "1" ] && [ "$(echo "$S31_B_AUDIT" | jval items.0.meta.part_exchange_value)" = "1000" ] \
  && [ "$(echo "$S31_B_AUDIT" | jval items.0.meta.sale)" = "$S31_B_NUMBER" ] && [ "$(echo "$S31_B_AUDIT" | jval items.0.meta.items)" = "2" ] \
  || fail "the trade_in_complete audit row is wrong: $S31_B_AUDIT"
[ "$(s31_list audit_log "action='sale_complete' && record='$S31_B_SALE'" | jval items.0.meta.trade_in.applied)" = "1000" ] \
  || fail "the sale's audit row does not carry the part-exchange"
[ "$(s31_count credit_ledger "ref='$S31_B_TRADE_NUMBER'")" = "0" ] || fail "a part-exchange with no surplus wrote store credit"
[ "$(s31_count cash_movements "ref='$S31_B_TRADE_NUMBER'")" = "0" ] || fail "a part-exchange with no surplus moved the drawer"
ok "a trade worth less than the sale pays £10.00 as one part_exchange tender, the card takes the rest, and the trade-in is numbered, linked both ways, stocked, labelled and audited"

# Points once: the sale earns on its whole £30.00, as the control sale did,
# and the trade-in earns nothing on what paid for it.
[ "$(jval points_earned <"$S31_DIR/b.json")" = "$S31_CTRL_POINTS" ] \
  || fail "the part-exchange sale earned $(jval points_earned <"$S31_DIR/b.json") points; a £30.00 sale earns $S31_CTRL_POINTS"
[ "$(s31_list points_ledger "ref='$S31_B_NUMBER' && reason='earn_sale'" | jval items.0.delta)" = "$S31_CTRL_POINTS" ] \
  || fail "the sale's earn_sale row is not its points"
[ "$(s31_count points_ledger "ref='$S31_B_TRADE_NUMBER'")" = "0" ] || fail "the trade-in earned points on the part that paid for the sale"
ok "points once: the sale earns on its whole value and the trade-in earns none on what it paid towards it"

# --- 31c. A trade worth exactly the sale ---------------------------------
S31_C_ITEM="$(s31_item "S31 Elite Box" 1 1500)"
S31_C_TRADE="$(s31_trade "$S31_PAT" accepted \
  '{"kind":"single","free_text_title":"S31 Mew","condition":"LP","qty":1,"market_price":2000,"offer_price":1500,"accepted":true}')"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_C_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_C_TRADE\",$S31_TERMS,\"tenders\":[{\"method\":\"part_exchange\",\"amount\":1500}]}")"
s31_expect "$S31_STATUS" 200 "" "a part-exchange worth exactly the sale, with the till sending its tender"
S31_C_SALE="$(s31_field "sale.id")"
[ "$(s31_count sale_tenders "sale='$S31_C_SALE'")" = "1" ] || fail "an exact part-exchange wrote $(s31_count sale_tenders "sale='$S31_C_SALE'") tenders, expected the one"
[ "$(s31_record sales "$S31_C_SALE" | jval payment)" = "part_exchange" ] || fail "a sale paid wholly by trade is not payment part_exchange"
[ "$(s31_record trade_ins "$S31_C_TRADE" | jval payout_type)" = "part_exchange" ] && [ "$(s31_field "trade_in.applied")" = "1500" ] \
  || fail "an exact part-exchange is not payout_type part_exchange: $(s31_body)"
ok "a trade worth exactly the sale pays it all, the till's own part_exchange tender taken as the server's"

# --- 31d. A trade worth more, the surplus as store credit ----------------
# A credit-only buy-in through the buy-in route first: the same £6.00 of
# credit the surplus will be, so its points can be held against the
# surplus's. Its response is the route's own, and it is now on the session.
S31_D_CTRL_TRADE="$(s31_trade "$S31_PAT" draft \
  '{"kind":"single","free_text_title":"S31 Control card","condition":"NM","qty":1,"market_price":900,"offer_price":600,"accepted":true}')"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/trade-ins/$S31_D_CTRL_TRADE/complete" \
  '{"payout_type":"credit","payout_cash":0,"payout_credit":600,"terms_accepted":true,"cash_session":null}')"
s31_expect "$S31_STATUS" 200 "" "a credit-only buy-in through the buy-in route"
S31_D_KEYS="$(s31_body | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.stdout.write(Object.keys(b).sort().join(",") + "|" + Object.keys(b.trade_in).sort().join(","));
')"
[ "$S31_D_KEYS" = "credit_balance,items,labels_queued,points_earned,trade_in|id,number,payout_cash,payout_credit,status" ] \
  || fail "the buy-in route's response changed shape: $S31_D_KEYS"
S31_D_CTRL_POINTS="$(s31_field points_earned)"
[ "$(s31_record trade_ins "$S31_D_CTRL_TRADE" | jval cash_session)" = "$S31_SESSION" ] \
  || fail "a credit-only buy-in is not linked to the open session, so the X and Z would miss it"
ok "the buy-in route answers as it always has, and a credit-only buy-in is now linked to the open session"

S31_D_ITEM="$(s31_item "S31 Tin" 1 1000)"
S31_D_TRADE="$(s31_trade "$S31_PAT" offered \
  '{"kind":"single","free_text_title":"S31 Lugia","condition":"NM","qty":1,"market_price":2500,"offer_price":1600,"accepted":true}')"
S31_D_BODY_HEAD="{\"lines\":[{\"item\":\"$S31_D_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_D_TRADE\",\"tenders\":[]"
s31_refusal "$S31_D_BODY_HEAD,$S31_TERMS}" 400 "Pay the surplus as credit or cash." "a surplus with no choice"
s31_refusal "$S31_D_BODY_HEAD,\"trade_settlement\":{\"surplus\":\"cash\",\"surplus_cash\":0,\"terms_accepted\":true}}" \
  400 "Pay between £0.01 and £6.00 in cash, or pay the surplus as credit." "a cash surplus of nothing"
s31_refusal "$S31_D_BODY_HEAD,\"trade_settlement\":{\"surplus\":\"cash\",\"surplus_cash\":601,\"terms_accepted\":true}}" \
  400 "Pay between £0.01 and £6.00 in cash, or pay the surplus as credit." "a cash surplus above the surplus"
s31_refusal "{\"lines\":[{\"item\":\"$S31_D_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_D_TRADE\",\"trade_settlement\":{\"surplus\":\"credit\",\"terms_accepted\":true},\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"4242\"}]}" \
  400 "The payments come to £5.00 but £0.00 is left after the trade-in." "a payment on a sale the trade-in covers"
S31_D_CREDIT_BEFORE="$(s31_list customer_private "customer='$S31_PAT'" | jval items.0.credit_balance)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S31_D_BODY_HEAD,\"trade_settlement\":{\"surplus\":\"credit\",\"terms_accepted\":true}}")"
s31_expect "$S31_STATUS" 200 "" "a part-exchange with the surplus as store credit"
S31_D_SALE="$(s31_field "sale.id")"
S31_D_TRADE_NUMBER="$(s31_field "trade_in.number")"
[ "$(s31_field "trade_in.value")" = "1600" ] && [ "$(s31_field "trade_in.applied")" = "1000" ] \
  && [ "$(s31_field "trade_in.payout_credit")" = "600" ] && [ "$(s31_field "trade_in.payout_cash")" = "0" ] \
  || fail "the credit surplus's trade_in block is wrong: $(s31_body)"
[ "$(s31_field credit_balance)" = "$((S31_D_CREDIT_BEFORE + 600))" ] || fail "the response's credit balance did not go up by the £6.00 surplus"
[ "$(s31_record sales "$S31_D_SALE" | jval payment)" = "part_exchange" ] || fail "a sale the trade-in covers is not payment part_exchange"
S31_D_ROW="$(s31_record trade_ins "$S31_D_TRADE")"
[ "$(echo "$S31_D_ROW" | jval payout_type)" = "credit" ] && [ "$(echo "$S31_D_ROW" | jval payout_credit)" = "600" ] \
  && [ "$(echo "$S31_D_ROW" | jval part_exchange_value)" = "1000" ] || fail "the credit surplus trade-in is wrong: $S31_D_ROW"
S31_D_LEDGER="$(s31_list credit_ledger "ref='$S31_D_TRADE_NUMBER'")"
[ "$(echo "$S31_D_LEDGER" | jval totalItems)" = "1" ] && [ "$(echo "$S31_D_LEDGER" | jval items.0.amount)" = "600" ] \
  && [ "$(echo "$S31_D_LEDGER" | jval items.0.reason)" = "trade_in" ] || fail "the surplus's credit ledger row is wrong: $S31_D_LEDGER"
S31_D_POINTS="$(s31_list points_ledger "ref='$S31_D_TRADE_NUMBER'")"
[ "$(echo "$S31_D_POINTS" | jval totalItems)" = "1" ] && [ "$(echo "$S31_D_POINTS" | jval items.0.reason)" = "earn_trade_in" ] \
  && [ "$(echo "$S31_D_POINTS" | jval items.0.delta)" = "$S31_D_CTRL_POINTS" ] \
  || fail "the credit surplus earned '$(echo "$S31_D_POINTS" | jval items.0.delta)' points; £6.00 of buy-in credit earns $S31_D_CTRL_POINTS: $S31_D_POINTS"
[ "$(s31_count cash_movements "ref='$S31_D_TRADE_NUMBER'")" = "0" ] || fail "a credit surplus moved the drawer"
ok "a trade worth more pays the whole sale and its £6.00 surplus as store credit, which alone earns trade-in points"

# --- 31e. The surplus as cash: the cap and the ID gate, then the spread --
# Three singles at £3.33 and two of a sealed tin at £5.00: £19.99 of trade
# against a £10.00 sale leaves £9.99, of which £7.00 is paid in cash. What
# was paid, £17.00, is spread over the lines pro rata (£8.50 and £8.50):
# the singles cost 283, 284 and 283, the tin line costs 425 a unit.
S31_E_ITEM="$(s31_item "S31 Deck Box" 1 1000)"
S31_E_TRADE="$(s31_trade "$S31_CASH" draft \
  '{"kind":"single","free_text_title":"S31 Eevee","condition":"NM","qty":3,"market_price":500,"offer_price":333,"accepted":true}' \
  '{"kind":"sealed","free_text_title":"S31 Collector Tin","qty":2,"market_price":800,"offer_price":500,"accepted":true}')"
s31_cash_body() {
  # $1 the id_check JSON ("null" for none)
  echo "{\"lines\":[{\"item\":\"$S31_E_ITEM\",\"qty\":1}],\"customer\":\"$S31_CASH\",\"trade_in\":\"$S31_E_TRADE\",\"trade_settlement\":{\"surplus\":\"cash\",\"surplus_cash\":700,\"terms_accepted\":true,\"id_check\":$1}}"
}
S31_E_ADDRESS='"address":"2 Market Place, Bolsover, S44 6PB"'
s31_refusal "$(s31_cash_body null)" 422 "Add the seller's address before paying cash." "a cash surplus with no address"
s31_refusal "$(s31_cash_body "{$S31_E_ADDRESS}")" 422 \
  "Take an ID check before paying cash. Photograph the seller's ID on the ID step." "a cash surplus with no ID"
s31_refusal "$(s31_cash_body "{\"id_type\":\"passport\",\"id_expiry\":\"2031-01-31\",\"id_ref_last4\":\"4321\",\"dob\":\"2015-03-01\",$S31_E_ADDRESS}")" \
  422 "We cannot buy for cash from anyone under 18." "a cash surplus to someone under 18"
s31_refusal "$(s31_cash_body "{\"id_type\":\"passport\",\"id_expiry\":\"2031-01-31\",\"id_ref_last4\":\"4321\",\"dob\":\"1990-03-01\",$S31_E_ADDRESS}")" \
  422 "Take a photo of the customer's ID before paying cash." "a cash surplus with ID details and no photo"
s31_settings '{"cash_cap":500}'
s31_refusal "$(s31_cash_body "{\"id_type\":\"passport\",\"id_expiry\":\"2031-01-31\",\"id_ref_last4\":\"4321\",\"dob\":\"1990-03-01\",$S31_E_ADDRESS}")" \
  422 "Cash payouts are capped at £5.00. Pay the rest as store credit." "a cash surplus over the cash cap"
s31_settings '{"cash_cap":800000}'
[ "$(s31_record trade_ins "$S31_E_TRADE" | jval status)" = "draft" ] || fail "a refused cash surplus touched the trade-in"
ok "a cash surplus is held to the buy-in's address, ID, age, photo and cash cap rules, in their own sentences"

node -e '
  require("fs").writeFileSync(process.argv[1], Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
' "$S31_DIR/id.png"
S31_E_DOC="$(curl -s -X POST "$BASE/api/vault/customers/$S31_CASH/id-check" -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$S31_DIR/id.png;type=image/png" -F "id_type=passport" -F "id_expiry=2031-01-31" \
  -F "id_ref_last4=4321" -F "dob=1990-03-01" -F "address=2 Market Place, Bolsover, S44 6PB" | jval id_document)"
[ -n "$S31_E_DOC" ] || fail "the ID photo for the cash surplus was not stored"
S31_E_EXPECTED_BEFORE="$(s31_expected)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "$(s31_cash_body "{\"id_type\":\"passport\",\"id_expiry\":\"2031-01-31\",\"id_ref_last4\":\"4321\",\"dob\":\"1990-03-01\",$S31_E_ADDRESS,\"id_document\":\"$S31_E_DOC\"}")")"
s31_expect "$S31_STATUS" 200 "" "a part-exchange with £7.00 of its £9.99 surplus paid in cash"
S31_E_SALE="$(s31_field "sale.id")"
S31_E_TRADE_NUMBER="$(s31_field "trade_in.number")"
[ "$(s31_field "trade_in.value")" = "1999" ] && [ "$(s31_field "trade_in.applied")" = "1000" ] \
  && [ "$(s31_field "trade_in.payout_cash")" = "700" ] && [ "$(s31_field "trade_in.payout_credit")" = "0" ] \
  || fail "the cash surplus's trade_in block is wrong: $(s31_body)"
S31_E_MOVES="$(s31_list cash_movements "ref='$S31_E_TRADE_NUMBER'")"
[ "$(echo "$S31_E_MOVES" | jval totalItems)" = "1" ] && [ "$(echo "$S31_E_MOVES" | jval items.0.type)" = "payout" ] \
  && [ "$(echo "$S31_E_MOVES" | jval items.0.amount)" = "-700" ] && [ "$(echo "$S31_E_MOVES" | jval items.0.session)" = "$S31_SESSION" ] \
  || fail "the cash surplus's payout movement is wrong: $S31_E_MOVES"
[ "$(s31_expected)" = "$((S31_E_EXPECTED_BEFORE - 700))" ] || fail "the drawer did not go down by the £7.00 paid out"
S31_E_ROW="$(s31_record trade_ins "$S31_E_TRADE")"
[ "$(echo "$S31_E_ROW" | jval payout_type)" = "cash" ] && [ "$(echo "$S31_E_ROW" | jval id_document)" = "$S31_E_DOC" ] \
  && [ "$(echo "$S31_E_ROW" | jval id_checked)" = "true" ] && [ "$(echo "$S31_E_ROW" | jval seller_address)" = "2 Market Place, Bolsover, S44 6PB" ] \
  && [ "$(echo "$S31_E_ROW" | jval seller_id_last4)" = "4321" ] || fail "the cash surplus trade-in's ID record is wrong: $S31_E_ROW"
[ "$(s31_count credit_ledger "ref='$S31_E_TRADE_NUMBER'")" = "0" ] && [ "$(s31_count points_ledger "ref='$S31_E_TRADE_NUMBER'")" = "0" ] \
  || fail "a cash surplus wrote store credit or trade-in points"
S31_E_COSTS="$(s31_list items "trade_in_line.trade_in='$S31_E_TRADE'" | node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const singles = items.filter((i) => i.kind === "single").map((i) => `${i.qty}x${i.cost}`).sort().join("+");
  const sealed = items.filter((i) => i.kind === "sealed").map((i) => `${i.qty}x${i.cost}`).join("+");
  const paid = items.reduce((s, i) => s + i.qty * i.cost, 0);
  process.stdout.write(`${singles}|${sealed}|${paid}`);
')"
[ "$S31_E_COSTS" = "1x283+1x283+1x284|2x425|1700" ] \
  || fail "the items' costs are '$S31_E_COSTS', expected the £17.00 paid spread as 283, 284, 283 and 425 a tin"
[ "$(s31_list audit_log "action='trade_in_complete' && record='$S31_E_TRADE'" | jval items.0.meta.cost_spread)" = "true" ] \
  || fail "the audit row does not say the costs were spread"
ok "a £7.00 cash surplus is a payout movement on the session, with the ID on the trade-in, and the items cost what was paid: £17.00 spread to the penny"

# --- 31f. A trade-in that is already completed ---------------------------
S31_F_ITEM="$(s31_item "S31 Sleeves" 1 900)"
s31_refusal "{\"lines\":[{\"item\":\"$S31_F_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_A_TRADE\",$S31_TERMS,\"tenders\":[]}" \
  409 "That trade-in has already been completed." "a part-exchange of a completed trade-in"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/trade-ins/$S31_A_TRADE/complete" \
  '{"payout_type":"credit","payout_cash":0,"payout_credit":1000,"terms_accepted":true}')"
s31_expect "$S31_STATUS" 409 "This trade-in is already completed." "the buy-in route on a part-exchanged trade-in"
[ "$(s31_count audit_log "action='trade_in_complete' && record='$S31_A_TRADE'")" = "1" ] || fail "a trade-in was completed twice"
ok "a trade-in already completed is refused by the till and by the buy-in route, each in its own words"

# --- 31g. An exchange smaller than the new sale ---------------------------
S31_G_A="$(s31_item "S31 Return A" 1 1500)"
S31_G_B="$(s31_item "S31 Return B" 1 2000)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_G_A\",\"qty\":1},{\"item\":\"$S31_G_B\",\"qty\":1}],\"customer\":\"$S31_RET\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":3500,\"card_last4\":\"1111\"}]}")"
s31_expect "$S31_STATUS" 200 "" "the sale the goods come back from"
S31_G_ORIGIN="$(s31_field "sale.id")"
S31_G_ORIGIN_NUMBER="$(s31_field "sale.number")"
S31_G_LINE_A="$(s31_line_of "$S31_G_ORIGIN" "$S31_G_A")"
S31_G_LINE_B="$(s31_line_of "$S31_G_ORIGIN" "$S31_G_B")"
S31_G_NEW="$(s31_item "S31 Exchange Box" 1 2500)"
S31_G_BODY="{\"lines\":[{\"item\":\"$S31_G_NEW\",\"qty\":1}],\"customer\":\"$S31_RET\",\"returns\":{\"sale\":\"$S31_G_ORIGIN\",\"lines\":[{\"sale_line\":\"$S31_G_LINE_A\",\"qty\":1}],\"reason\":\"Wrong set\"},\"tenders\":[{\"method\":\"card_tide\",\"amount\":1000,\"card_last4\":\"2222\"}]}"
S31_STATUS="$(s31_post "$S31_CLERK_TOKEN" "/api/vault/sales/complete" "$S31_G_BODY")"
s31_expect "$S31_STATUS" 403 "A manager needs to approve this." "an exchange from a plain staff member"
[ "$(s31_field capability)" = "refund" ] || fail "the exchange's refusal names '$(s31_field capability)', expected refund"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S31_G_BODY")"
s31_expect "$S31_STATUS" 200 "" "an exchange smaller than the new sale"
S31_G_SALE="$(s31_field "sale.id")"
S31_G_REF="$S31_G_ORIGIN_NUMBER-R1"
[ "$(s31_field "refund.ref")" = "$S31_G_REF" ] && [ "$(s31_field "refund.amount")" = "1500" ] \
  && [ "$(s31_field "refund.exchange")" = "1500" ] && [ "$(s31_field "refund.sale.id")" = "$S31_G_ORIGIN" ] \
  || fail "the response's refund block is wrong: $(s31_body)"
[ "$(s31_tender tenders exchange amount)" = "1500" ] && [ "$(s31_tender tenders exchange label)" = "Exchange" ] \
  && [ "$(s31_tender tenders card_tide amount)" = "1000" ] || fail "the new sale's tenders are wrong: $(s31_body)"
[ "$(s31_tender refund.tenders exchange amount)" = "-1500" ] || fail "the refund block does not carry the negative exchange tender"
S31_G_ORIGIN_ROW="$(s31_record sales "$S31_G_ORIGIN")"
[ "$(echo "$S31_G_ORIGIN_ROW" | jval status)" = "part_refunded" ] && [ "$(echo "$S31_G_ORIGIN_ROW" | jval refund_count)" = "1" ] \
  && [ "$(echo "$S31_G_ORIGIN_ROW" | jval refunded_total)" = "1500" ] || fail "the original sale was not refunded the returned line: $S31_G_ORIGIN_ROW"
[ "$(s31_record items "$S31_G_A" | jval status)" = "in_stock" ] || fail "the returned item did not go back in stock"
S31_G_BACK="$(s31_list sale_tenders "sale='$S31_G_ORIGIN' && refund_ref='$S31_G_REF'")"
[ "$(echo "$S31_G_BACK" | jval totalItems)" = "1" ] && [ "$(echo "$S31_G_BACK" | jval items.0.method)" = "exchange" ] \
  && [ "$(echo "$S31_G_BACK" | jval items.0.amount)" = "-1500" ] && [ "$(echo "$S31_G_BACK" | jval items.0.session)" = "$S31_SESSION" ] \
  || fail "the refund's tenders are not one negative exchange row: $S31_G_BACK"
[ "$(s31_count cash_movements "ref='$S31_G_REF'")" = "0" ] || fail "an exchange moved the drawer"
S31_G_AUDIT="$(s31_list audit_log "action='sale_refund' && record='$S31_G_ORIGIN'")"
[ "$(echo "$S31_G_AUDIT" | jval items.0.meta.exchange.amount)" = "1500" ] && [ "$(echo "$S31_G_AUDIT" | jval items.0.meta.exchange.sale)" = "$S31_G_SALE" ] \
  && [ "$(echo "$S31_G_AUDIT" | jval items.0.meta.lines.0.sale_line)" = "$S31_G_LINE_A" ] || fail "the refund's audit row is wrong: $S31_G_AUDIT"
[ "$(s31_list audit_log "action='sale_complete' && record='$S31_G_SALE'" | jval items.0.meta.returns.ref)" = "$S31_G_REF" ] \
  || fail "the new sale's audit row does not name the refund"
[ "$(s31_count notes "target_record='$S31_G_ORIGIN' && body='Wrong set'")" = "1" ] || fail "the exchange's reason is not a note on the original sale"
[ "$(s31_count points_ledger "ref='$S31_G_REF' && reason='refund_reverse'")" = "1" ] || fail "the returned line's points were not taken back"
ok "an exchange refunds the returned line as R1, £15.00 of it paying the new sale as an exchange tender that the refund cancels, and the card takes the rest"

# --- 31h. An exchange larger than the new sale, with returns.tenders -----
S31_H_NEW="$(s31_item "S31 Small Box" 1 500)"
S31_H_HEAD="{\"lines\":[{\"item\":\"$S31_H_NEW\",\"qty\":1}],\"customer\":\"$S31_RET\""
S31_H_RETURNS="\"sale\":\"$S31_G_ORIGIN\",\"lines\":[{\"sale_line\":\"$S31_G_LINE_B\",\"qty\":1}],\"reason\":\"Changed their mind\""
s31_refusal "$S31_H_HEAD,\"returns\":{$S31_H_RETURNS,\"tenders\":[{\"method\":\"store_credit\",\"amount\":1500}]},\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"2222\"}]}" \
  400 "The payments come to £5.00 but £0.00 is left after the exchange." "a payment on a sale the returns cover"
s31_refusal "$S31_H_HEAD,\"returns\":{$S31_H_RETURNS,\"tenders\":[{\"method\":\"store_credit\",\"amount\":1000}]},\"tenders\":[]}" \
  400 "The payments back come to £10.00 but £15.00 is left to give back after the exchange." "returns tenders short of the rest"
s31_refusal "$S31_H_HEAD,\"returns\":{$S31_H_RETURNS},\"tenders\":[]}" \
  400 "Say how the refund is going back: cash, card or store credit." "returns worth more than the sale with nothing to give back"
S31_H_TOKEN="$(s31_override refund "$S31_CLERK_ID")"
S31_H_OVERRIDE="$(jval id <"$S31_DIR/override.json")"
S31_STATUS="$(s31_post "$S31_CLERK_TOKEN" "/api/vault/sales/complete" \
  "$S31_H_HEAD,\"returns\":{$S31_H_RETURNS,\"tenders\":[{\"method\":\"store_credit\",\"amount\":1500}]},\"tenders\":[]}" \
  "X-GG-Override: $S31_H_TOKEN")"
s31_expect "$S31_STATUS" 200 "" "an exchange larger than the new sale, approved by a manager"
S31_H_SALE="$(s31_field "sale.id")"
S31_H_REF="$S31_G_ORIGIN_NUMBER-R2"
[ "$(s31_field "refund.ref")" = "$S31_H_REF" ] && [ "$(s31_field "refund.amount")" = "2000" ] && [ "$(s31_field "refund.exchange")" = "500" ] \
  || fail "the larger exchange's refund block is wrong: $(s31_body)"
[ "$(s31_tender refund.tenders store_credit amount)" = "-1500" ] && [ "$(s31_tender refund.tenders exchange amount)" = "-500" ] \
  || fail "the refund block's tenders are wrong: $(s31_body)"
[ "$(s31_count sale_tenders "sale='$S31_H_SALE'")" = "1" ] && [ "$(s31_tender tenders exchange amount)" = "500" ] \
  || fail "the new sale took something other than the £5.00 exchange"
[ "$(s31_record sales "$S31_H_SALE" | jval payment)" = "exchange" ] || fail "a sale paid wholly by returns is not payment exchange"
[ "$(s31_record sales "$S31_G_ORIGIN" | jval status)" = "refunded" ] || fail "the original sale is not refunded in full"
S31_H_CREDIT="$(s31_list credit_ledger "ref='$S31_H_REF'")"
[ "$(echo "$S31_H_CREDIT" | jval items.0.amount)" = "1500" ] && [ "$(echo "$S31_H_CREDIT" | jval items.0.customer)" = "$S31_RET" ] \
  || fail "the rest did not go back as £15.00 of store credit: $S31_H_CREDIT"
S31_H_USED="$(s31_record till_overrides "$S31_H_OVERRIDE")"
[ -n "$(echo "$S31_H_USED" | jval used_at)" ] && [ "$(echo "$S31_H_USED" | jval used_for)" = "sale:$S31_H_SALE" ] \
  || fail "the refund approval was not spent on the ticket: $S31_H_USED"
[ "$(s31_count till_events "kind='override' && staff='$S31_CLERK_ID' && session='$S31_SESSION'")" = "1" ] \
  || fail "the exchange's approval wrote no override till event"
S31_H_AUDIT="$(s31_list audit_log "action='sale_refund' && record='$S31_G_ORIGIN'" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const r = rows.find((x) => x.meta && x.meta.ref === process.argv[1]);
  process.stdout.write(r ? JSON.stringify(r.meta) : "");
' "$S31_H_REF")"
[ "$(echo "$S31_H_AUDIT" | jval approvals.0.capability)" = "refund" ] && [ "$(echo "$S31_H_AUDIT" | jval approvals.0.approver)" = "$S31_ADMIN_ID" ] \
  || fail "the refund's audit row does not name its approver: $S31_H_AUDIT"
ok "an exchange larger than the new sale pays all of it, gives the rest back through returns.tenders, and needs the refund capability once for the ticket"

# --- 31i. A ticket of returns alone is a refund, and replays as one ------
S31_I_ITEM="$(s31_item "S31 Faulty Pad" 1 1200)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_I_ITEM\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1200,\"card_last4\":\"3333\"}]}")"
s31_expect "$S31_STATUS" 200 "" "the walk-in sale to bring back"
S31_I_ORIGIN="$(s31_field "sale.id")"
S31_I_NUMBER="$(s31_field "sale.number")"
S31_I_LINE="$(s31_line_of "$S31_I_ORIGIN" "$S31_I_ITEM")"
S31_I_RETURNS="\"returns\":{\"sale\":\"$S31_I_ORIGIN\",\"lines\":[{\"sale_line\":\"$S31_I_LINE\",\"qty\":1}],\"reason\":\"Faulty\""
s31_refusal "{\"lines\":[],$S31_I_RETURNS}}" 400 "Say how the refund is going back: cash, card or store credit." "returns alone with nothing to give back"
s31_refusal "{\"lines\":[],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_C_TRADE\",$S31_I_RETURNS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":1200}]}}" \
  400 "There is nothing on the ticket for the trade-in to pay for. Add an item, or complete it as a buy-in." "returns alone with a trade-in"
S31_I_BODY="{\"client_id\":\"s31-returns-$$\",\"lines\":[],$S31_I_RETURNS,\"tenders\":[{\"method\":\"card_tide\",\"amount\":1200,\"card_last4\":\"3333\"}]}}"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S31_I_BODY")"
s31_expect "$S31_STATUS" 200 "" "a ticket of returns alone"
cp "$S31_DIR/last.json" "$S31_DIR/i1.json"
[ "$(s31_field "sale.id")" = "$S31_I_ORIGIN" ] && [ "$(s31_field "sale.status")" = "refunded" ] \
  && [ "$(s31_field "refund.ref")" = "$S31_I_NUMBER-R1" ] && [ "$(s31_field "refund.amount")" = "1200" ] \
  && [ "$(s31_field "refund.exchange")" = "0" ] && [ "$(s31_field refunded)" = "1200" ] \
  && [ "$(s31_tender refund.tenders card_tide amount)" = "-1200" ] || fail "a ticket of returns alone did not answer as its refund: $(s31_body)"
[ "$(s31_count sales "client_id='s31-returns-$$'")" = "0" ] || fail "a ticket of returns alone made a sale"
[ "$(s31_record items "$S31_I_ITEM" | jval status)" = "in_stock" ] || fail "the returned item did not go back in stock"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S31_I_BODY")"
s31_expect "$S31_STATUS" 200 "" "the replay of a ticket of returns alone"
for S31_PATH in sale.id refund.ref refund.amount refund.exchange refunded refunded_total points_reversed refund.tenders.0.amount; do
  [ "$(jval "$S31_PATH" <"$S31_DIR/i1.json")" = "$(s31_field "$S31_PATH")" ] \
    || fail "the replay's $S31_PATH is '$(s31_field "$S31_PATH")', the first answer's '$(jval "$S31_PATH" <"$S31_DIR/i1.json")'"
done
[ "$(s31_record sales "$S31_I_ORIGIN" | jval refund_count)" = "1" ] || fail "the replay refunded the sale again"
ok "a ticket of returns and no new lines is simply a refund, answered as one, and a replay of it refunds nothing twice"

# --- 31j. A trade-in and an exchange in one ticket, and its replay ------
S31_J_OLD="$(s31_item "S31 Old Game" 1 1500 retro)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_J_OLD\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1500,\"card_last4\":\"5555\"}]}")"
s31_expect "$S31_STATUS" 200 "" "the sale for the combined ticket's return"
S31_J_ORIGIN="$(s31_field "sale.id")"
S31_J_ORIGIN_NUMBER="$(s31_field "sale.number")"
S31_J_LINE="$(s31_line_of "$S31_J_ORIGIN" "$S31_J_OLD")"
S31_J_ITEM="$(s31_item "S31 Console" 1 2000)"
S31_J_TRADE="$(s31_trade "$S31_PAT" draft \
  '{"kind":"single","free_text_title":"S31 Snorlax","condition":"MP","qty":1,"market_price":1200,"offer_price":800,"accepted":true}')"
# The trade pays £8.00 of the £20.00; the £15.00 return pays £12.00 of
# what is left; £3.00 of the return goes back on the card.
S31_J_BODY="{\"client_id\":\"s31-both-$$\",\"lines\":[{\"item\":\"$S31_J_ITEM\",\"qty\":1}],\"customer\":\"$S31_PAT\",\"trade_in\":\"$S31_J_TRADE\",$S31_TERMS,\"returns\":{\"sale\":\"$S31_J_ORIGIN\",\"lines\":[{\"sale_line\":\"$S31_J_LINE\",\"qty\":1}],\"reason\":\"Doubled up\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":300,\"card_last4\":\"5555\"}]},\"tenders\":[]}"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S31_J_BODY")"
s31_expect "$S31_STATUS" 200 "" "a ticket with a trade-in and returns"
cp "$S31_DIR/last.json" "$S31_DIR/j1.json"
S31_J_SALE="$(s31_field "sale.id")"
[ "$(s31_tender tenders part_exchange amount)" = "800" ] && [ "$(s31_tender tenders exchange amount)" = "1200" ] \
  && [ "$(s31_count sale_tenders "sale='$S31_J_SALE'")" = "2" ] || fail "the combined ticket's tenders are wrong: $(s31_body)"
[ "$(s31_field "trade_in.applied")" = "800" ] && [ "$(s31_field "refund.amount")" = "1500" ] && [ "$(s31_field "refund.exchange")" = "1200" ] \
  || fail "the combined ticket's blocks are wrong: $(s31_body)"
S31_J_BACK="$(s31_list sale_tenders "sale='$S31_J_ORIGIN' && refund_ref='$S31_J_ORIGIN_NUMBER-R1'" | node -e '
  process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).items.map((t) => `${t.method}:${t.amount}`).sort().join(","));
')"
[ "$S31_J_BACK" = "card_tide:-300,exchange:-1200" ] || fail "the combined ticket's refund tenders are '$S31_J_BACK'"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S31_J_BODY")"
s31_expect "$S31_STATUS" 200 "" "the replay of the combined ticket"
for S31_PATH in sale.id sale.number sale.total trade_in.id trade_in.number trade_in.value trade_in.applied trade_in.payout_cash \
  trade_in.payout_credit refund.ref refund.amount refund.exchange refund.sale.id vat_total change receipt.number; do
  [ "$(jval "$S31_PATH" <"$S31_DIR/j1.json")" = "$(s31_field "$S31_PATH")" ] \
    || fail "the replay's $S31_PATH is '$(s31_field "$S31_PATH")', the first answer's '$(jval "$S31_PATH" <"$S31_DIR/j1.json")'"
done
[ "$(s31_count sales "client_id='s31-both-$$'")" = "1" ] || fail "the replay made a second sale"
[ "$(s31_count audit_log "action='trade_in_complete' && record='$S31_J_TRADE'")" = "1" ] || fail "the replay completed the trade-in again"
[ "$(s31_record sales "$S31_J_ORIGIN" | jval refund_count)" = "1" ] || fail "the replay refunded the returned line again"
ok "one ticket takes a trade-in and returns together (the trade first, then the returns), and its replay answers the same, trade_in and refund included, completing nothing twice"

# --- 31k. The receipts ----------------------------------------------------
S31_STATUS="$(s31_get "$S31_CLERK_TOKEN" "/api/vault/sales/$S31_B_SALE/receipt")"
s31_expect "$S31_STATUS" 200 "" "the part-exchange sale's receipt"
S31_K_CHECK="$(s31_body | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).receipt;
  const problems = [];
  const sale = r.lines.filter((l) => l.kind === "sale");
  const trade = r.lines.filter((l) => l.kind === "trade");
  if (sale.length !== 1 || sale[0].total !== 3000) problems.push("the sale line is not the £30.00 box");
  const got = trade.map((l) => `${l.title}:${l.detail}:${l.qty}:${l.unit_price}:${l.total}`).sort().join(",");
  if (got !== "S31 Bundle::2:200:-400,S31 Pikachu:NM:1:600:-600") problems.push(`the trade lines are ${got}`);
  if (!trade.every((l) => /^GG/.test(l.sku))) problems.push("a trade line has no SKU");
  if (r.total !== 3000 || r.subtotal !== 3000) problems.push(`the total is ${r.total}, subtotal ${r.subtotal}`);
  const tenders = r.tenders.reduce((s, t) => s + t.amount, 0);
  if (tenders !== r.total) problems.push("the tenders do not add up to the total");
  const px = r.tenders.find((t) => t.method === "part_exchange");
  if (!px || px.label !== "Part-exchange" || px.amount !== 1000) problems.push("no Part-exchange tender");
  const t = r.trade_in || {};
  if (t.value !== 1000 || t.applied !== 1000 || t.payout_cash !== 0 || t.payout_credit !== 0 || !/^GG-BI-/.test(t.number)) {
    problems.push(`the trade_in block is ${JSON.stringify(r.trade_in)}`);
  }
  process.stdout.write(problems.join("; "));
')"
[ -z "$S31_K_CHECK" ] || fail "the part-exchange receipt is wrong: $S31_K_CHECK"
S31_STATUS="$(s31_get "$S31_CLERK_TOKEN" "/api/vault/sales/$S31_G_SALE/receipt")"
s31_expect "$S31_STATUS" 200 "" "the exchange sale's receipt"
S31_K_CHECK="$(s31_body | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).receipt;
  const problems = [];
  const back = r.lines.filter((l) => l.kind === "return");
  if (back.length !== 1 || back[0].title !== "S31 Return A" || back[0].total !== -1500) problems.push(`the return lines are ${JSON.stringify(back)}`);
  if (r.total !== 2500) problems.push(`the total is ${r.total}`);
  const ex = r.tenders.find((t) => t.method === "exchange");
  if (!ex || ex.label !== "Exchange" || ex.amount !== 1500) problems.push("no Exchange tender");
  if (r.tenders.reduce((s, t) => s + t.amount, 0) !== r.total) problems.push("the tenders do not add up to the total");
  if (r.trade_in !== null) problems.push("a sale with no trade-in has a trade_in block");
  process.stdout.write(problems.join("; "));
')"
[ -z "$S31_K_CHECK" ] || fail "the exchange receipt is wrong: $S31_K_CHECK"
S31_STATUS="$(s31_get "$S31_CLERK_TOKEN" "/api/vault/sales/$S31_G_ORIGIN/receipt?refund=$S31_G_REF")"
s31_expect "$S31_STATUS" 200 "" "the exchange's refund receipt"
[ "$(s31_field "receipt.kind")" = "refund" ] && [ "$(s31_field "receipt.total")" = "-1500" ] \
  && [ "$(s31_field "receipt.tenders.0.label")" = "Exchange" ] && [ "$(s31_field "receipt.tenders.0.amount")" = "-1500" ] \
  && [ "$(s31_field "receipt.lines.0.kind")" = "return" ] || fail "the exchange's refund receipt is wrong: $(s31_body)"
S31_STATUS="$(s31_post "$S31_CLERK_TOKEN" "/api/vault/sales/$S31_B_SALE/receipt/email" '{"email":"pat@example.com"}')"
s31_expect "$S31_STATUS" 202 "" "emailing the part-exchange receipt"
ok "receipts list traded-in and returned lines with negative totals outside the sale's own total, the trade_in block, and the Part-exchange and Exchange tenders by name"

# --- 31l. The refund route as it was --------------------------------------
S31_L_ITEM="$(s31_item "S31 Refund Route" 1 800)"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S31_L_ITEM\",\"qty\":1}],\"tenders\":[{\"method\":\"cash\",\"amount\":800}]}")"
s31_expect "$S31_STATUS" 200 "" "a sale for the refund route"
S31_L_SALE="$(s31_field "sale.id")"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/sales/$S31_L_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$(s31_line_of "$S31_L_SALE" "$S31_L_ITEM")\",\"qty\":1}],\"reason\":\"Spare\",\"tenders\":[{\"method\":\"cash\",\"amount\":800}]}")"
s31_expect "$S31_STATUS" 200 "" "a refund through the refund route"
S31_L_KEYS="$(s31_body | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.stdout.write([Object.keys(b).sort().join(","), Object.keys(b.sale).sort().join(","), Object.keys(b.refund).sort().join(",")].join("|"));
')"
[ "$S31_L_KEYS" = "credit_balance,points_balance,points_reversed,refund,refunded,refunded_total,sale|id,number,refund_count,refunded_total,status|amount,ref,tenders" ] \
  || fail "the refund route's response changed shape: $S31_L_KEYS"
[ "$(s31_field "refund.tenders.0.amount")" = "-800" ] && [ "$(s31_field "sale.status")" = "refunded" ] \
  || fail "the refund route's refund is wrong: $(s31_body)"
ok "the refund route answers exactly as before"

# --- 31m. The X and the Z -------------------------------------------------
# On this session: part-exchanges of £10.00, £15.00, £10.00, £10.00 and
# £8.00; surpluses of £6.00 credit and £7.00 cash, plus the £6.00 credit
# buy-in; exchanges of £15.00, £5.00 and £12.00, each cancelled by its
# refund's own exchange row.
s31_report_check() {
  # $1 what; reads the report from the last response's `report`
  local problems
  problems="$(s31_body | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8")).report;
    const problems = [];
    const t = r.trade_ins;
    if (t.part_exchange_value !== 5300) problems.push(`part_exchange_value ${t.part_exchange_value}, expected 5300`);
    if (t.cash_paid !== 700) problems.push(`cash_paid ${t.cash_paid}, expected 700`);
    if (t.credit_issued !== 1200) problems.push(`credit_issued ${t.credit_issued}, expected 1200`);
    if (t.count !== 6) problems.push(`count ${t.count}, expected 6`);
    const px = r.tenders.find((x) => x.method === "part_exchange");
    if (!px || px.taken !== 5300 || px.refunded !== 0 || px.label !== "Part-exchange") problems.push(`the part_exchange row is ${JSON.stringify(px)}`);
    const ex = r.tenders.find((x) => x.method === "exchange");
    if (!ex || ex.taken !== 3200 || ex.refunded !== 3200 || ex.net !== 0 || ex.label !== "Exchange") problems.push(`the exchange row is ${JSON.stringify(ex)}`);
    if (r.cash.buy_in_payouts !== 700) problems.push(`buy_in_payouts ${r.cash.buy_in_payouts}, expected 700`);
    process.stdout.write(problems.join("; "));
  ')"
  [ -z "$problems" ] || fail "$1 is wrong: $problems"
}
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/till/x" "{\"register\":\"$S31_REGISTER\"}")"
s31_expect "$S31_STATUS" 201 "" "an X report"
s31_report_check "the X report"
S31_M_CARD="$(s31_field "report.card.till_total")"
S31_M_EXPECTED="$(s31_field "report.cash.expected")"
ok "the X counts each part-exchange's value once, only the surpluses as cash paid and credit issued, and the exchange rows cancel"

# Anything parked on the register would block the Z; this section parked
# nothing, and every earlier section has finished.
for S31_PARKED in $(s31_list parked_tickets "register='$S31_REGISTER'" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).items.map((p)=>p.id).join(" "))'); do
  curl -s -o /dev/null -X DELETE "$BASE/api/collections/parked_tickets/records/$S31_PARKED" -H "Authorization: $SUPER_TOKEN"
done
S31_M_COUNTS="{\"5000\":$((S31_M_EXPECTED / 5000)),\"1\":$((S31_M_EXPECTED % 5000))}"
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/till/z" \
  "{\"register\":\"$S31_REGISTER\",\"counts\":$S31_M_COUNTS,\"card_reported_total\":$S31_M_CARD}")"
s31_expect "$S31_STATUS" 201 "" "the Z report"
s31_report_check "the Z report"
[ "$(s31_field "report.cash.variance")" = "0" ] && [ "$(s31_field "report.card.variance")" = "0" ] \
  || fail "the Z did not balance: $(s31_body)"
ok "the Z carries the same part-exchange figures and balances to the penny"

# --- tidy up ----------------------------------------------------------------
S31_STATUS="$(s31_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":5000}')"
s31_expect "$S31_STATUS" 200 "" "reopening the till after section 31"
s31_settings "{\"cash_cap\":${S31_CAP_BEFORE:-800000}}"
ok "section 31 leaves the till open and the cash cap as it found them"
