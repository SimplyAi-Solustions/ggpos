# shellcheck shell=bash
# -----------------------------------------------------------------------
# 30. Selling at the till (docs/api-contract-epos.md, sections 4 and 5):
#     tenders and their refusals, till products, the membership product,
#     server-checked discounts and price overrides with a manager's
#     override, VAT, voids, the closed-till refusal, idempotent replay, the
#     sale lookup, refunds with tenders, the till catalogue, receipts, the
#     reprint event, the receipt email, the display's sale stages, the money
#     collections locked down, and SumUp gone from the server.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR
# and the ok/fail/jval helpers, and leaves the default register's till
# open, as it found it or not, with nothing else changed.
# -----------------------------------------------------------------------

S30_DIR="$TMP_DIR/s30"
mkdir -p "$S30_DIR"

# --- helpers -------------------------------------------------------------

# $1 token, $2 path, $3 JSON body, [$4 an extra header] -> the status code;
# the body is left in $S30_DIR/last.json.
s30_post() {
  local extra=()
  if [ -n "${4:-}" ]; then extra=(-H "$4"); fi
  curl -s -o "$S30_DIR/last.json" -w '%{http_code}' -X POST "$BASE$2" \
    -H "Authorization: $1" -H "Content-Type: application/json" ${extra[@]+"${extra[@]}"} -d "$3"
}

# $1 token, $2 path -> the status code; the body is left in $S30_DIR/last.json.
s30_get() {
  curl -s -o "$S30_DIR/last.json" -w '%{http_code}' "$BASE$2" -H "Authorization: $1"
}

s30_body() { cat "$S30_DIR/last.json"; }
s30_field() { jval "$1" <"$S30_DIR/last.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
s30_expect() {
  [ "$1" = "$2" ] || fail "$4 returned $1, expected $2: $(s30_body)"
  if [ -n "$3" ]; then
    [ "$(s30_field message)" = "$3" ] || fail "$4 said '$(s30_field message)', expected '$3'"
  fi
}

# $1 collection, $2 filter -> the superuser's list of matching records.
s30_list() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    --data-urlencode "perPage=200" --data-urlencode "sort=created" "$BASE/api/collections/$1/records"
}

# $1 title, $2 qty, $3 price, [$4 kind, default sealed], [$5 tax scheme, default margin] -> item id.
s30_item() {
  curl -s -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"${4:-sealed}\",\"game\":\"$S30_GAME\",\"title\":\"$1\",\"qty\":$2,\"cost\":100,\"price\":$3,\"status\":\"in_stock\",\"tax_scheme\":\"${5:-margin}\",\"source\":\"supplier\"}" \
    | jval id
}

# $1 pence -> £1,234.56, through the shared formatter itself.
s30_gbp() {
  node --experimental-strip-types -e "
    const { formatGBP } = require('$ROOT/packages/shared/src/money.ts');
    process.stdout.write(formatGBP(Number(process.argv[1])));
  " "$1" 2>/dev/null
}

# $1 capability, $2 requested_by -> a raw override token whose sha256 is now
# a live, unused till_overrides row approved by the admin, written straight
# in as the superuser (the PIN route that issues them is another package's).
s30_override() {
  local token hash expires
  token="s30-$1-$RANDOM-$RANDOM-$$"
  hash="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$token")"
  expires="$(node -e 'process.stdout.write(new Date(Date.now() + 5 * 60000).toISOString().replace("T", " "))')"
  curl -s -o "$S30_DIR/override.json" -X POST "$BASE/api/collections/till_overrides/records" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"token_hash\":\"$hash\",\"capability\":\"$1\",\"requested_by\":\"$2\",\"approver\":\"$S30_ADMIN_ID\",\"expires_at\":\"$expires\"}"
  [ -n "$(jval id <"$S30_DIR/override.json")" ] || fail "could not write a $1 override row: $(cat "$S30_DIR/override.json")"
  echo "$token"
}

# The default register's open session, or "".
s30_session() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id"
}

# What the default register's drawer should hold now.
s30_expected() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected
}

# Close the default register's session at its expected total (legacy route).
s30_close_till() {
  local sid expected
  sid="$(s30_session)"
  [ -n "$sid" ] || return 0
  expected="$(s30_expected)"
  curl -s -o /dev/null -X POST "$BASE/api/vault/cash-sessions/$sid/close" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"counted\":$expected}"
}

# --- setup ---------------------------------------------------------------

S30_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$S30_GAME" ] || fail "30: the seeded pokemon game is missing"
S30_ADMIN_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval id)"
[ -n "$S30_ADMIN_ID" ] || fail "30: could not read the admin's own id"
S30_SETTINGS_ID="$(curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
S30_REGISTER="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=active=true" \
  --data-urlencode "sort=sort,created" "$BASE/api/collections/registers/records" | jval "items.0.id")"
[ -n "$S30_REGISTER" ] || fail "30: there is no active register"

# A plain staff member: no discount over the limit, no price override, no
# refund, without a manager's approval (packages/shared/src/permissions.ts).
S30_CLERK_EMAIL="s30-clerk@local.test"
S30_CLERK_PASSWORD="s30-clerk-password-123"
S30_CLERK_ID="$(curl -s -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$S30_CLERK_EMAIL\",\"password\":\"$S30_CLERK_PASSWORD\",\"passwordConfirm\":\"$S30_CLERK_PASSWORD\",\"name\":\"Robin Till\",\"role\":\"staff\",\"active\":true}" | jval id)"
[ -n "$S30_CLERK_ID" ] || fail "30: could not create the plain staff member"
S30_CLERK_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$S30_CLERK_EMAIL\",\"password\":\"$S30_CLERK_PASSWORD\"}" | jval token)"
[ -n "$S30_CLERK_TOKEN" ] || fail "30: the plain staff member could not sign in"

S30_CUSTOMER_ID="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Sasha Till","email":"sasha-till@local.test","source":"counter"}' | jval id)"
[ -n "$S30_CUSTOMER_ID" ] || fail "30: could not create the check customer"

# Start from a till of our own: whatever an earlier section left open on
# the default register is closed at its expected total, then the legacy
# route (which opens the default register) opens it with a £50.00 float.
s30_close_till
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":5000}')"
s30_expect "$S30_STATUS" 200 "" "opening the till with the legacy route"
S30_SESSION="$(s30_field "session.id")"
[ "$(s30_session)" = "$S30_SESSION" ] || fail "the legacy open route did not open the default register's till"
ok "the legacy route opens the default register's till for these checks"

# --- 30a. A split cash and card sale, with change ------------------------
S30_A_ITEM="$(s30_item "S30 Split Box" 1 2500)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_A_ITEM\",\"qty\":1}],\"tenders\":[{\"method\":\"cash\",\"amount\":1000,\"tendered\":2000},{\"method\":\"card_tide\",\"amount\":1500,\"card_last4\":\"4242\",\"reference\":\"AUTH42\"}]}")"
s30_expect "$S30_STATUS" 200 "" "a split cash and card sale"
cp "$S30_DIR/last.json" "$S30_DIR/a.json"
S30_A_SALE="$(jval "sale.id" <"$S30_DIR/a.json")"
S30_A_NUMBER="$(jval "sale.number" <"$S30_DIR/a.json")"
[ "$(jval change <"$S30_DIR/a.json")" = "1000" ] || fail "the split sale's change is '$(jval change <"$S30_DIR/a.json")', expected 1000"
[ "$(jval "tenders.0.method" <"$S30_DIR/a.json")" = "cash" ] || fail "the split sale's first tender is not cash"
[ "$(jval "tenders.0.tendered" <"$S30_DIR/a.json")" = "2000" ] || fail "the cash tender lost what was handed over"
[ "$(jval "tenders.1.label" <"$S30_DIR/a.json")" = "Card" ] || fail "the card tender is not labelled Card"
[ "$(jval "tenders.1.card_last4" <"$S30_DIR/a.json")" = "4242" ] || fail "the card tender lost its last four digits"
[ "$(jval "receipt.number" <"$S30_DIR/a.json")" = "$S30_A_NUMBER" ] || fail "the response carries no receipt number"
[ "$(jval vat_total <"$S30_DIR/a.json")" = "0" ] || fail "a margin-scheme sale carried VAT"

S30_A_ROW="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/sales/records/$S30_A_SALE")"
[ "$(echo "$S30_A_ROW" | jval register)" = "$S30_REGISTER" ] || fail "the sale is not linked to the register"
[ "$(echo "$S30_A_ROW" | jval cash_session)" = "$S30_SESSION" ] || fail "the sale is not linked to the open session"
[ "$(echo "$S30_A_ROW" | jval payment)" = "mixed" ] || fail "a split sale's payment is '$(echo "$S30_A_ROW" | jval payment)', expected mixed"
[ "$(echo "$S30_A_ROW" | jval payment_split.cash)" = "1000" ] || fail "payment_split.cash is not the cash tender's amount"
[ "$(echo "$S30_A_ROW" | jval payment_split.card_tide)" = "1500" ] || fail "payment_split does not mirror the card tender"
[ "$(echo "$S30_A_ROW" | jval payment_split.sumup_card)" = "0" ] || fail "payment_split.sumup_card is not 0 on a new sale"

S30_A_TENDERS="$(s30_list sale_tenders "sale='$S30_A_SALE'")"
[ "$(echo "$S30_A_TENDERS" | jval totalItems)" = "2" ] || fail "the split sale wrote $(echo "$S30_A_TENDERS" | jval totalItems) sale_tenders rows, expected 2"
for idx in 0 1; do
  [ "$(echo "$S30_A_TENDERS" | jval "items.$idx.register")" = "$S30_REGISTER" ] || fail "sale_tenders row $idx has no register"
  [ "$(echo "$S30_A_TENDERS" | jval "items.$idx.session")" = "$S30_SESSION" ] || fail "sale_tenders row $idx has no session"
  [ "$(echo "$S30_A_TENDERS" | jval "items.$idx.staff")" = "$S30_ADMIN_ID" ] || fail "sale_tenders row $idx has no staff"
  [ "$(echo "$S30_A_TENDERS" | jval "items.$idx.refund_ref")" = "" ] || fail "a sale's tender carries a refund reference"
done
S30_A_MOVES="$(s30_list cash_movements "session='$S30_SESSION' && ref='$S30_A_NUMBER'")"
[ "$(echo "$S30_A_MOVES" | jval totalItems)" = "1" ] || fail "the cash tender wrote $(echo "$S30_A_MOVES" | jval totalItems) cash movements, expected 1"
[ "$(echo "$S30_A_MOVES" | jval "items.0.type")" = "cash_sale" ] || fail "the cash movement is not a cash_sale"
[ "$(echo "$S30_A_MOVES" | jval "items.0.amount")" = "1000" ] || fail "the drawer moved by '$(echo "$S30_A_MOVES" | jval "items.0.amount")', expected the cash tender's 1000, not what was handed over"
[ "$(s30_list sale_lines "sale='$S30_A_SALE'" | jval "items.0.title")" = "S30 Split Box" ] || fail "the item line has no title snapshot"
ok "a split cash and card sale gives change from the cash, writes two tenders with the register and session, and moves the drawer by the cash amount"

# --- 30b. Every tender refusal --------------------------------------------
S30_B_ITEM="$(s30_item "S30 Refusal Box" 1 4000)"
s30_tender_refusal() {
  # $1 tenders JSON, $2 expected status, $3 expected sentence, $4 what, [$5 extra body fields]
  local status
  status="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
    "{\"lines\":[{\"item\":\"$S30_B_ITEM\",\"qty\":1}],\"tenders\":$1${5:-}}")"
  s30_expect "$status" "$2" "$3" "$4"
}
s30_tender_refusal '[{"method":"card_tide","amount":3800,"card_last4":"1234"}]' 400 \
  "The payments come to £38.00 but the total is £40.00." "tenders short of the total"
s30_tender_refusal '[{"method":"cash","amount":2000},{"method":"cash","amount":2000}]' 400 \
  "There are two cash payments. Put the cash together as one payment." "two cash tenders"
s30_tender_refusal '[{"method":"cash","amount":4000,"tendered":1000}]' 400 \
  "£10.00 does not cover the £40.00 cash payment. Key what the customer handed over." "cash handed over short of its amount"
s30_tender_refusal '[{"method":"card_tide","amount":4000,"tendered":5000,"card_last4":"1234"}]' 400 \
  "Only cash gives change. Key the exact amount for every other payment." "change from a card"
s30_tender_refusal '[{"method":"card_tide","amount":4000}]' 400 \
  "Key the last four digits of the card." "a card tender with no last four digits"
s30_tender_refusal '[{"method":"card_tide","amount":4000,"card_last4":"12a4"}]' 400 \
  "Key the last four digits of the card." "a card tender with a bad last four digits"
s30_tender_refusal '[{"method":"store_credit","amount":4000}]' 422 \
  "Add the customer before using store credit or points." "store credit with no customer"
s30_tender_refusal '[{"method":"sumup_card","amount":4000}]' 400 \
  "SumUp is no longer used. Take card payments on the Tide reader." "a SumUp tender"
s30_tender_refusal '[{"method":"part_exchange","amount":4000}]' 400 \
  "Part-exchange is not available yet." "a part-exchange tender"
s30_tender_refusal '[{"method":"gift_card","amount":4000}]' 400 \
  "Pick how the customer is paying: cash, card, store credit or points." "an unknown tender"
s30_tender_refusal '[{"method":"cash","amount":0}]' 400 \
  "Each payment needs an amount above £0.00." "a tender of nothing"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_B_ITEM\",\"qty\":1}],\"payment\":\"sumup_card\"}")"
s30_expect "$S30_STATUS" 400 "SumUp is no longer used. Take card payments on the Tide reader." "a legacy SumUp payment"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_B_ITEM\",\"qty\":1}],\"payment\":\"mixed\",\"payment_split\":{\"sumup_card\":4000}}")"
s30_expect "$S30_STATUS" 400 "SumUp is no longer used. Take card payments on the Tide reader." "a legacy split with SumUp in it"
[ "$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/collections/items/records/$S30_B_ITEM" | jval status)" = "in_stock" ] \
  || fail "a refused sale sold the item anyway"
ok "every tender refusal says its own sentence, SumUp is refused new and legacy, and nothing is sold"

# The legacy payment_split still works, mapped onto tenders.
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_B_ITEM\",\"qty\":1}],\"payment\":\"mixed\",\"payment_split\":{\"cash\":1500,\"card_tide\":2500,\"store_credit\":0,\"points\":0},\"card_last4\":\"9876\",\"cash_session\":\"$S30_SESSION\"}")"
s30_expect "$S30_STATUS" 200 "" "a legacy cash and card split"
[ "$(s30_field "tenders.0.method")" = "cash" ] && [ "$(s30_field "tenders.1.method")" = "card_tide" ] \
  || fail "the legacy split was not mapped onto a cash and a card tender: $(s30_body)"
[ "$(s30_field "tenders.1.card_last4")" = "9876" ] || fail "the legacy card tender lost its last four digits"
ok "an older caller's payment_split is mapped onto tenders"

# --- 30c. Till products ----------------------------------------------------
s30_product() {
  curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='$1'" \
    "$BASE/api/collections/till_products/records" | jval "items.0.id"
}
S30_TABLE="$(s30_product "Table time, 1 hour")"
S30_SINGLE="$(s30_product "Single card")"
S30_MEMBERSHIP="$(s30_product "Guild Membership, 12 months")"
[ -n "$S30_TABLE" ] && [ -n "$S30_SINGLE" ] && [ -n "$S30_MEMBERSHIP" ] || fail "the seeded till products are missing"

S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_TABLE\",\"qty\":2}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1000,\"card_last4\":\"1111\"}]}")"
s30_expect "$S30_STATUS" 200 "" "selling two hours of table time"
S30_C_SALE="$(s30_field "sale.id")"
S30_C_LINE="$(s30_list sale_lines "sale='$S30_C_SALE'")"
[ "$(echo "$S30_C_LINE" | jval "items.0.product")" = "$S30_TABLE" ] || fail "the product line does not point at the product"
[ "$(echo "$S30_C_LINE" | jval "items.0.item")" = "" ] || fail "the product line points at an item"
[ "$(echo "$S30_C_LINE" | jval "items.0.title")" = "Table time, 1 hour" ] || fail "the product line's title is '$(echo "$S30_C_LINE" | jval "items.0.title")'"
[ "$(echo "$S30_C_LINE" | jval "items.0.unit_price")" = "500" ] || fail "the product line did not take the product's price"
[ "$(echo "$S30_C_LINE" | jval "items.0.vat_amount")" = "0" ] || fail "a standard line carried VAT while the shop is not VAT registered"
[ "$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/sales/records/$S30_C_SALE" | jval payment)" = "card_tide" ] \
  || fail "a card-only sale's payment is not card_tide"
ok "a till product sells at its own price, with its name as the line title and no stock item"

# --- 30d. An open-price product, with and without a price ----------------
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_SINGLE\",\"qty\":1}],\"tenders\":[{\"method\":\"cash\",\"amount\":1250}]}")"
s30_expect "$S30_STATUS" 400 "Key a price for Single card." "an open-price product with no price"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_SINGLE\",\"qty\":1,\"unit_price\":1250,\"title\":\"Single card: Charizard ex\"}],\"tenders\":[{\"method\":\"cash\",\"amount\":1250,\"tendered\":2000}]}")"
s30_expect "$S30_STATUS" 200 "" "an open-price product with a price, from a plain staff member"
S30_D_SALE="$(s30_field "sale.id")"
[ "$(s30_field change)" = "750" ] || fail "the open-price cash sale's change is '$(s30_field change)', expected 750"
S30_D_LINE="$(s30_list sale_lines "sale='$S30_D_SALE'")"
[ "$(echo "$S30_D_LINE" | jval "items.0.title")" = "Single card: Charizard ex" ] || fail "the open-price line did not keep the title it was keyed with"
[ "$(echo "$S30_D_LINE" | jval "items.0.tax_scheme")" = "margin" ] || fail "the single card line is not margin scheme"
ok "an open-price product needs a keyed price, takes the keyed title, and needs no price override"

# --- 30e. The membership product -----------------------------------------
curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S30_MEMBERSHIP" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"active":true}'
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_MEMBERSHIP\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":2400,\"card_last4\":\"2222\"}]}")"
s30_expect "$S30_STATUS" 400 "Attach the customer to sell a Guild Membership." "a membership with no customer"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_MEMBERSHIP\",\"qty\":1}],\"customer\":\"$S30_CUSTOMER_ID\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":2400,\"card_last4\":\"2222\"}]}")"
s30_expect "$S30_STATUS" 409 "Guild Membership has no tier to grant yet. Set one under Settings first." "a membership product with no tier"

S30_PASS_TIER="$(curl -s -X POST "$BASE/api/collections/loyalty_tiers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Till Pass","threshold_points":0,"colour_token":"tier-pass","sort":45,"paid_plan":true,"perks":[]}' | jval id)"
[ -n "$S30_PASS_TIER" ] || fail "could not create the till's paid-plan tier"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S30_MEMBERSHIP" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d "{\"membership_tier\":\"$S30_PASS_TIER\"}"

S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_MEMBERSHIP\",\"qty\":1}],\"customer\":\"$S30_CUSTOMER_ID\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":2400,\"card_last4\":\"2222\"}]}")"
s30_expect "$S30_STATUS" 200 "" "selling a Guild Membership"
S30_E_NUMBER="$(s30_field "sale.number")"
S30_E_MEMBERSHIPS="$(s30_list memberships "customer='$S30_CUSTOMER_ID'")"
[ "$(echo "$S30_E_MEMBERSHIPS" | jval totalItems)" = "1" ] || fail "the membership sale left $(echo "$S30_E_MEMBERSHIPS" | jval totalItems) memberships, expected 1"
[ "$(echo "$S30_E_MEMBERSHIPS" | jval "items.0.status")" = "active" ] || fail "the sold membership is not active"
[ "$(echo "$S30_E_MEMBERSHIPS" | jval "items.0.tier")" = "$S30_PASS_TIER" ] || fail "the sold membership is not on the product's tier"
[ "$(echo "$S30_E_MEMBERSHIPS" | jval "items.0.price")" = "2400" ] || fail "the membership's price is not what was paid"
[ "$(echo "$S30_E_MEMBERSHIPS" | jval "items.0.payment_note")" = "Sold on $S30_E_NUMBER" ] || fail "the membership's payment note does not name the sale"
S30_E_FIRST_END="$(echo "$S30_E_MEMBERSHIPS" | jval "items.0.renews_at")"
S30_E_YEARS="$(node -e 'const a=new Date(process.argv[1].replace(" ","T"));process.stdout.write(String(a.getUTCFullYear()-new Date().getUTCFullYear()))' "$S30_E_FIRST_END")"
[ "$S30_E_YEARS" = "1" ] || fail "a 12 month membership renews '$S30_E_FIRST_END', not a year from now"

S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_MEMBERSHIP\",\"qty\":1}],\"customer\":\"$S30_CUSTOMER_ID\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":2400,\"card_last4\":\"2222\"}]}")"
s30_expect "$S30_STATUS" 200 "" "selling a second Guild Membership year"
S30_E_AFTER="$(s30_list memberships "customer='$S30_CUSTOMER_ID'")"
[ "$(echo "$S30_E_AFTER" | jval totalItems)" = "1" ] || fail "a second membership year made a second membership row"
S30_E_MONTHS="$(node -e '
  const a = new Date(process.argv[1].replace(" ", "T"));
  const b = new Date(process.argv[2].replace(" ", "T"));
  process.stdout.write(String((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()));
' "$S30_E_FIRST_END" "$(echo "$S30_E_AFTER" | jval "items.0.renews_at")")"
[ "$S30_E_MONTHS" = "12" ] || fail "the second year moved renews_at on by $S30_E_MONTHS months from its end, expected 12"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S30_MEMBERSHIP" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"active":false}'
ok "the membership product needs a customer and a tier, creates the membership, and a second sale extends it from its end"

# --- 30f. Discounts and price overrides, with a manager's override -------
S30_F_ITEM="$(s30_item "S30 Discount Box" 3 2000)"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_ITEM\",\"qty\":1}],\"discount\":400,\"discount_source\":\"manual\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1600,\"card_last4\":\"3333\"}]}")"
s30_expect "$S30_STATUS" 403 "A manager needs to approve this." "a 20 percent discount from a plain staff member"
[ "$(s30_field needs_override)" = "true" ] || fail "the discount refusal does not say it needs an override"
[ "$(s30_field capability)" = "discount_over_limit" ] || fail "the discount refusal names '$(s30_field capability)'"

S30_F_TOKEN="$(s30_override discount_over_limit "$S30_CLERK_ID")"
S30_F_OVERRIDE_ID="$(jval id <"$S30_DIR/override.json")"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_ITEM\",\"qty\":1}],\"discount\":400,\"discount_source\":\"manual\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1600,\"card_last4\":\"3333\"}]}" \
  "X-GG-Override: $S30_F_TOKEN")"
s30_expect "$S30_STATUS" 200 "" "the same discount with a manager's override"
S30_F_SALE="$(s30_field "sale.id")"
S30_F_USED="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/till_overrides/records/$S30_F_OVERRIDE_ID")"
[ -n "$(echo "$S30_F_USED" | jval used_at)" ] || fail "the override was not marked used"
[ "$(echo "$S30_F_USED" | jval used_for)" = "sale:$S30_F_SALE" ] || fail "the override's used_for is '$(echo "$S30_F_USED" | jval used_for)'"
S30_F_EVENT="$(s30_list till_events "kind='override' && staff='$S30_CLERK_ID' && session='$S30_SESSION'")"
[ "$(echo "$S30_F_EVENT" | jval totalItems)" = "1" ] || fail "the override wrote $(echo "$S30_F_EVENT" | jval totalItems) override till events, expected 1"
[ "$(echo "$S30_F_EVENT" | jval "items.0.approver")" = "$S30_ADMIN_ID" ] || fail "the override till event does not name the approver"
S30_F_AUDIT="$(s30_list audit_log "action='sale_complete' && record='$S30_F_SALE'")"
[ "$(echo "$S30_F_AUDIT" | jval "items.0.meta.approvals.0.approver")" = "$S30_ADMIN_ID" ] || fail "the sale's audit row does not name the approver"
[ "$(echo "$S30_F_AUDIT" | jval "items.0.meta.approvals.0.capability")" = "discount_over_limit" ] || fail "the sale's audit row does not name the capability approved"

S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_ITEM\",\"qty\":1}],\"discount\":400,\"discount_source\":\"manual\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1600,\"card_last4\":\"3333\"}]}" \
  "X-GG-Override: $S30_F_TOKEN")"
s30_expect "$S30_STATUS" 403 "A manager needs to approve this." "a used override sent again"

S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_ITEM\",\"qty\":1,\"discount\":500}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1500,\"card_last4\":\"3333\"}]}")"
s30_expect "$S30_STATUS" 403 "A manager needs to approve this." "a 25 percent line discount from a plain staff member"
[ "$(s30_field capability)" = "discount_over_limit" ] || fail "a line discount over the limit names '$(s30_field capability)'"

S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_ITEM\",\"qty\":1}],\"discount\":200,\"discount_source\":\"manual\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1800,\"card_last4\":\"3333\"}]}")"
s30_expect "$S30_STATUS" 200 "" "a discount at the 10 percent limit from a plain staff member"
ok "a discount over the limit needs a manager's override, which is used once, logged as an override event and named on the audit row"

S30_F_PRICE_ITEM="$(s30_item "S30 Price Box" 1 1500)"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_PRICE_ITEM\",\"qty\":1,\"unit_price\":1200}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1200,\"card_last4\":\"4444\"}]}")"
s30_expect "$S30_STATUS" 403 "A manager needs to approve this." "a changed price from a plain staff member"
[ "$(s30_field capability)" = "price_override" ] || fail "the price refusal names '$(s30_field capability)'"
S30_F_PRICE_TOKEN="$(s30_override price_override "$S30_CLERK_ID")"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_F_PRICE_ITEM\",\"qty\":1,\"unit_price\":1200}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1200,\"card_last4\":\"4444\"}]}" \
  "X-GG-Override: $S30_F_PRICE_TOKEN")"
s30_expect "$S30_STATUS" 200 "" "the changed price with a manager's override"
S30_F_PRICE_AUDIT="$(s30_list audit_log "action='price_override' && record='$S30_F_PRICE_ITEM'")"
[ "$(echo "$S30_F_PRICE_AUDIT" | jval "items.0.meta.from")" = "1500" ] && [ "$(echo "$S30_F_PRICE_AUDIT" | jval "items.0.meta.to")" = "1200" ] \
  || fail "the price_override audit row does not carry the two prices: $S30_F_PRICE_AUDIT"
[ "$(echo "$S30_F_PRICE_AUDIT" | jval "items.0.meta.approver")" = "$S30_ADMIN_ID" ] || fail "the price_override audit row does not name the approver"
ok "a changed price needs price_override, and its audit row carries both prices and the approver"

# --- 30g. VAT on and off -------------------------------------------------
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$S30_SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"vat_registered":true,"vat_number":"GB123456789"}'
S30_G_ITEM="$(s30_item "S30 VAT Margin Box" 1 1000)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_TABLE\",\"qty\":1},{\"item\":\"$S30_G_ITEM\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1500,\"card_last4\":\"5555\"}]}")"
s30_expect "$S30_STATUS" 200 "" "a standard and a margin line while VAT registered"
S30_G_SALE="$(s30_field "sale.id")"
[ "$(s30_field vat_total)" = "83" ] || fail "VAT inside £5.00 at 20 percent came to '$(s30_field vat_total)', expected 83"
S30_G_LINES="$(s30_list sale_lines "sale='$S30_G_SALE'")"
S30_G_VAT="$(echo "$S30_G_LINES" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  process.stdout.write(rows.map((r) => `${r.tax_scheme}:${r.vat_rate}:${r.vat_amount}`).sort().join(","));
')"
[ "$S30_G_VAT" = "margin:0:0,standard:20:83" ] || fail "the lines' VAT reads '$S30_G_VAT', expected margin:0:0,standard:20:83"
[ "$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/sales/records/$S30_G_SALE" | jval vat_total)" = "83" ] \
  || fail "sales.vat_total was not stored"
s30_get "$STAFF_TOKEN" "/api/vault/sales/$S30_G_SALE/receipt" >/dev/null
[ "$(s30_field "receipt.vat.0.rate")" = "20" ] && [ "$(s30_field "receipt.vat.0.vat")" = "83" ] \
  && [ "$(s30_field "receipt.vat.0.net")" = "417" ] && [ "$(s30_field "receipt.vat.0.gross")" = "500" ] \
  || fail "the receipt's VAT summary is wrong: $(s30_field receipt.vat)"
[ "$(s30_field "receipt.margin_scheme")" = "true" ] || fail "the receipt does not say a line was margin scheme"
[ "$(s30_field "receipt.shop.vat_number")" = "GB123456789" ] || fail "the receipt does not carry the VAT number while registered"

# A ticket discount that does not divide evenly: each line's VAT has to be
# the VAT inside its share of the discount as the shared spread allocates it
# over the stored lines in "created,id" order, the order the refund
# breakdown and the X and Z report use, whatever order the request sent.
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_TABLE\",\"qty\":1},{\"product\":\"$S30_TABLE\",\"qty\":2},{\"product\":\"$S30_TABLE\",\"qty\":1}],\"discount\":7,\"discount_source\":\"manual\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1993,\"card_last4\":\"5555\"}]}")"
s30_expect "$S30_STATUS" 200 "" "three standard lines with an uneven ticket discount"
S30_G2_SALE="$(s30_field "sale.id")"
S30_G2_VAT="$(s30_field vat_total)"
S30_G2_CHECK="$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=sale='$S30_G2_SALE'" \
  --data-urlencode "sort=created,id" "$BASE/api/collections/sale_lines/records" | node -e '
    const saleline = require(process.argv[1] + "/pb/pb_hooks/lib/shared/saleline.js");
    const vat = require(process.argv[1] + "/pb/pb_hooks/lib/shared/vat.js");
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
    const split = saleline.breakdown(
      rows.map((r) => ({ id: r.id, qty: r.qty, unitPrice: r.unit_price, discount: r.discount, refundedQty: 0 })),
      7
    );
    const problems = [];
    let total = 0;
    for (const r of rows) {
      const want = vat.vatInside(split.byId[r.id].net, r.vat_rate);
      total += r.vat_amount;
      if (r.vat_amount !== want) problems.push(`${r.id} has ${r.vat_amount}, expected ${want}`);
    }
    if (String(total) !== process.argv[2]) problems.push(`the lines sum to ${total} but the sale says ${process.argv[2]}`);
    process.stdout.write(problems.join("; "));
  ' "$ROOT" "$S30_G2_VAT")"
[ -z "$S30_G2_CHECK" ] || fail "the lines' VAT does not follow the stored spread: $S30_G2_CHECK"
[ "$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/sales/records/$S30_G2_SALE" | jval vat_total)" = "$S30_G2_VAT" ] \
  || fail "sales.vat_total does not match the response's vat_total"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$S30_SETTINGS_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"vat_registered":false}'
s30_get "$STAFF_TOKEN" "/api/vault/sales/$S30_G_SALE/receipt" >/dev/null
[ "$(s30_field "receipt.shop.vat_number")" = "" ] || fail "the receipt carries a VAT number while not registered"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"product\":\"$S30_TABLE\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"5555\"}]}")"
s30_expect "$S30_STATUS" 200 "" "a standard line while not VAT registered"
[ "$(s30_field vat_total)" = "0" ] || fail "a sale carried VAT with VAT registration off"
ok "VAT is worked out inside standard lines only while registered, stored per line and on the sale, and summarised on the receipt"

# --- 30h. Voids are written as till events -------------------------------
S30_H_ITEM="$(s30_item "S30 Void Box" 1 900)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_H_ITEM\",\"qty\":1}],\"voided\":[{\"title\":\"Booster pack\",\"qty\":1,\"amount\":450},{\"title\":\"Sleeves\",\"qty\":2,\"amount\":300}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":900,\"card_last4\":\"6666\"}]}")"
s30_expect "$S30_STATUS" 200 "" "a sale with two voided lines"
# This session's only voids, so every void_line event on it is one of these.
S30_H_EVENTS="$(s30_list till_events "kind='void_line' && session='$S30_SESSION' && register='$S30_REGISTER'")"
S30_H_FOUND="$(echo "$S30_H_EVENTS" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  process.stdout.write(rows.map((r) => `${r.detail.title}:${r.detail.qty}:${r.amount}:${Object.keys(r.detail).sort().join("+")}:${r.staff}`).sort().join(","));
')"
[ "$S30_H_FOUND" = "Booster pack:1:450:qty+title:$S30_ADMIN_ID,Sleeves:2:300:qty+title:$S30_ADMIN_ID" ] \
  || fail "the voids were written as '$S30_H_FOUND'"
ok "lines removed from the ticket before payment are written as void_line till events on the session"

# --- 30i. Idempotent replay ---------------------------------------------
S30_I_ITEM="$(s30_item "S30 Replay Box" 1 700)"
S30_I_BODY="{\"client_id\":\"s30-replay-$$\",\"lines\":[{\"item\":\"$S30_I_ITEM\",\"qty\":1}],\"tenders\":[{\"method\":\"cash\",\"amount\":700,\"tendered\":1000}]}"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S30_I_BODY")"
s30_expect "$S30_STATUS" 200 "" "the first send of a client_id"
cp "$S30_DIR/last.json" "$S30_DIR/i1.json"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" "$S30_I_BODY")"
s30_expect "$S30_STATUS" 200 "" "the replay of a client_id"
for path in sale.id sale.number change vat_total receipt.number tenders.0.method tenders.0.tendered tenders.0.change; do
  [ "$(jval "$path" <"$S30_DIR/i1.json")" = "$(s30_field "$path")" ] \
    || fail "the replay's $path is '$(s30_field "$path")', the first send's '$(jval "$path" <"$S30_DIR/i1.json")'"
done
[ "$(s30_field change)" = "300" ] || fail "the replayed change is '$(s30_field change)', expected 300"
[ "$(s30_list sales "client_id='s30-replay-$$'" | jval totalItems)" = "1" ] || fail "a replayed client_id made a second sale"
ok "a replayed client_id returns the first sale's body, tenders, change, VAT and receipt included, and sells nothing twice"

# --- 30i2. A line's note is kept on the sale line ------------------------
S30_N_ITEM="$(s30_item "S30 Note Box" 1 400)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_N_ITEM\",\"qty\":1,\"note\":\"Signed by the artist\"}],\"tenders\":[{\"method\":\"cash\",\"amount\":400}]}")"
s30_expect "$S30_STATUS" 200 "" "a sale with a line note"
[ "$(s30_list sale_lines "item='$S30_N_ITEM'" | jval items.0.note)" = "Signed by the artist" ] \
  || fail "the line's note was not kept on the sale line"
ok "a line's note from the ticket is kept on its sale line"

# --- 30j. The sale lookup ------------------------------------------------
S30_A_BARCODE="$(echo "$S30_A_NUMBER" | tr -d '-')"
S30_STATUS="$(s30_get "$STAFF_TOKEN" "/api/vault/sales/lookup?number=$S30_A_NUMBER")"
s30_expect "$S30_STATUS" 200 "" "looking a sale up by its number"
[ "$(s30_field "sale.id")" = "$S30_A_SALE" ] || fail "the lookup found the wrong sale"
[ "$(s30_field "sale.register_name")" = "Counter" ] || fail "the lookup does not name the register"
[ "$(s30_field "sale.staff_name")" = "Check Admin" ] || fail "the lookup does not name who sold it"
[ "$(s30_field "sale.lines.0.title")" = "S30 Split Box" ] || fail "the lookup's line has no title"
[ "$(s30_field "sale.lines.0.refundable_qty")" = "1" ] && [ "$(s30_field "sale.lines.0.refundable_amount")" = "2500" ] \
  || fail "the lookup's line does not say what is refundable: $(s30_body)"
[ "$(s30_field "sale.tenders.1.card_last4")" = "4242" ] || fail "the lookup does not carry the sale's tenders"
S30_STATUS="$(s30_get "$STAFF_TOKEN" "/api/vault/sales/lookup?number=$S30_A_BARCODE")"
s30_expect "$S30_STATUS" 200 "" "looking a sale up by its barcode form"
[ "$(s30_field "sale.id")" = "$S30_A_SALE" ] || fail "the barcode form found the wrong sale"
S30_STATUS="$(s30_get "$STAFF_TOKEN" "/api/vault/sales/lookup?number=GG-S-999999")"
s30_expect "$S30_STATUS" 404 "No sale has the number GG-S-999999." "looking up a number nobody was given"
S30_STATUS="$(s30_get "$STAFF_TOKEN" "/api/vault/sales/lookup?number=hello")"
s30_expect "$S30_STATUS" 400 "Scan the receipt or type its number, for example GG-S-000456." "looking up something that is not a number"
ok "the sale lookup finds a sale by its number or its barcode, with what is still refundable, and says when there is none"

# --- 30k. Refunds with tenders -------------------------------------------
S30_K_A="$(s30_item "S30 Refund A" 1 1500)"
S30_K_B="$(s30_item "S30 Refund B" 1 2000)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_K_A\",\"qty\":1},{\"item\":\"$S30_K_B\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":3500,\"card_last4\":\"7777\"}]}")"
s30_expect "$S30_STATUS" 200 "" "the sale to refund"
S30_K_SALE="$(s30_field "sale.id")"
S30_K_NUMBER="$(s30_field "sale.number")"
S30_K_LINES="$(s30_list sale_lines "sale='$S30_K_SALE'")"
S30_K_LINE_A="$(echo "$S30_K_LINES" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).items;process.stdout.write(r.find((x)=>x.item===process.argv[1]).id)' "$S30_K_A")"
S30_K_LINE_B="$(echo "$S30_K_LINES" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).items;process.stdout.write(r.find((x)=>x.item===process.argv[1]).id)' "$S30_K_B")"

S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_K_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_LINE_A\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1500}]}")"
s30_expect "$S30_STATUS" 403 "A manager needs to approve this." "a refund from a plain staff member"
[ "$(s30_field capability)" = "refund" ] || fail "the refund refusal names '$(s30_field capability)'"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/$S30_K_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_LINE_A\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1000}]}")"
s30_expect "$S30_STATUS" 400 "The payments back come to £10.00 but the refund is £15.00." "refund tenders short of the refund"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/$S30_K_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_LINE_A\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"store_credit\",\"amount\":1500}]}")"
s30_expect "$S30_STATUS" 422 "This sale has no customer, so it cannot go back as store credit." "store credit back on a sale with no customer"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/$S30_K_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_LINE_A\",\"qty\":1}],\"reason\":\"Changed their mind\",\"refund_method\":\"sumup_card\"}")"
s30_expect "$S30_STATUS" 400 "SumUp is no longer used. Refund card payments on the Tide reader." "a legacy SumUp refund"

# The drawer cannot pay back more cash than it should hold.
S30_K_BIG="$(s30_item "S30 Refund Big" 1 90000)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_K_BIG\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":90000,\"card_last4\":\"8888\"}]}")"
s30_expect "$S30_STATUS" 200 "" "the big card sale"
S30_K_BIG_SALE="$(s30_field "sale.id")"
S30_K_BIG_LINE="$(s30_list sale_lines "sale='$S30_K_BIG_SALE'" | jval "items.0.id")"
S30_K_EXPECTED="$(s30_expected)"
[ "$S30_K_EXPECTED" -lt 90000 ] || fail "the drawer already holds $S30_K_EXPECTED, too much for the drawer-short check"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/$S30_K_BIG_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_BIG_LINE\",\"qty\":1}],\"reason\":\"Wrong item\",\"tenders\":[{\"method\":\"cash\",\"amount\":90000}]}")"
s30_expect "$S30_STATUS" 409 "The drawer should only hold $(s30_gbp "$S30_K_EXPECTED"). Refund the rest to card or store credit." "a cash refund the drawer cannot cover"
ok "a refund needs the refund capability, tenders that come to the refund, a customer for store credit, no SumUp, and cash the drawer holds"

S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/$S30_K_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_LINE_A\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":1500,\"card_last4\":\"7777\"}]}")"
s30_expect "$S30_STATUS" 200 "" "a refund to card"
[ "$(s30_field "refund.ref")" = "$S30_K_NUMBER-R1" ] || fail "the first refund's reference is '$(s30_field "refund.ref")', expected $S30_K_NUMBER-R1"
[ "$(s30_field "refund.amount")" = "1500" ] || fail "the first refund's amount is '$(s30_field "refund.amount")'"
[ "$(s30_field "refund.tenders.0.amount")" = "-1500" ] || fail "the refund's tender is not negative: $(s30_body)"
[ "$(s30_field "sale.status")" = "part_refunded" ] || fail "the sale is '$(s30_field "sale.status")' after one of two lines went back"
S30_K_R1="$(s30_list sale_tenders "sale='$S30_K_SALE' && refund_ref='$S30_K_NUMBER-R1'")"
[ "$(echo "$S30_K_R1" | jval totalItems)" = "1" ] || fail "the card refund wrote $(echo "$S30_K_R1" | jval totalItems) tender rows"
[ "$(echo "$S30_K_R1" | jval "items.0.method")" = "card_tide" ] && [ "$(echo "$S30_K_R1" | jval "items.0.amount")" = "-1500" ] \
  || fail "the card refund's tender row is wrong: $S30_K_R1"
[ "$(echo "$S30_K_R1" | jval "items.0.register")" = "$S30_REGISTER" ] && [ "$(echo "$S30_K_R1" | jval "items.0.session")" = "$S30_SESSION" ] \
  || fail "the refund's tender row has no register or session"
[ "$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/collections/items/records/$S30_K_A" | jval status)" = "in_stock" ] \
  || fail "the refunded item did not go back in stock"

S30_EXPECTED_BEFORE="$(s30_expected)"
S30_K_TOKEN="$(s30_override refund "$S30_CLERK_ID")"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_K_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_LINE_B\",\"qty\":1,\"restock\":false}],\"reason\":\"Damaged in the box\",\"tenders\":[{\"method\":\"cash\",\"amount\":2000}]}" \
  "X-GG-Override: $S30_K_TOKEN")"
s30_expect "$S30_STATUS" 200 "" "a plain staff member's cash refund with a manager's override"
[ "$(s30_field "refund.ref")" = "$S30_K_NUMBER-R2" ] || fail "the second refund's reference is '$(s30_field "refund.ref")', expected $S30_K_NUMBER-R2"
[ "$(s30_field "sale.status")" = "refunded" ] && [ "$(s30_field "sale.refund_count")" = "2" ] \
  || fail "after both lines the sale reads '$(s30_field "sale.status")' with refund_count '$(s30_field "sale.refund_count")'"
S30_K_B_ROW="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/collections/items/records/$S30_K_B")"
[ "$(echo "$S30_K_B_ROW" | jval status)" = "sold" ] && [ "$(echo "$S30_K_B_ROW" | jval qty)" = "0" ] \
  || fail "restock false still put the item back: $S30_K_B_ROW"
S30_K_MOVE="$(s30_list cash_movements "session='$S30_SESSION' && ref='$S30_K_NUMBER-R2'")"
[ "$(echo "$S30_K_MOVE" | jval "items.0.type")" = "refund" ] && [ "$(echo "$S30_K_MOVE" | jval "items.0.amount")" = "-2000" ] \
  || fail "the cash refund's drawer movement is wrong: $S30_K_MOVE"
[ "$(s30_expected)" = "$((S30_EXPECTED_BEFORE - 2000))" ] || fail "the drawer did not go down by the cash refunded"
S30_K_AUDIT="$(s30_list audit_log "action='sale_refund' && record='$S30_K_SALE'")"
S30_K_AUDIT_R2="$(echo "$S30_K_AUDIT" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const r = rows.find((x) => x.meta && x.meta.ref === process.argv[1]);
  process.stdout.write(r ? JSON.stringify(r.meta) : "");
' "$S30_K_NUMBER-R2")"
[ "$(echo "$S30_K_AUDIT_R2" | jval "approvals.0.approver")" = "$S30_ADMIN_ID" ] || fail "the refund's audit row does not name the approver: $S30_K_AUDIT_R2"
[ "$(echo "$S30_K_AUDIT_R2" | jval "lines.0.restock")" = "false" ] || fail "the refund's audit row does not record the restock choice"
echo "$S30_K_AUDIT_R2" | grep -qF "Damaged in the box" && fail "the refund reason reached audit_log meta"
[ "$(s30_list till_events "kind='override' && staff='$S30_CLERK_ID' && session='$S30_SESSION'" | jval totalItems)" = "3" ] \
  || fail "the refund's override wrote no override till event"
ok "refunds are numbered R1 and R2, write negative tenders with the register and session, restock unless told not to, move the drawer for cash, and audit the approver"

# --- 30l. A closed till refuses sales and refunds ------------------------
s30_close_till
S30_L_ITEM="$(s30_item "S30 Closed Box" 1 500)"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S30_L_ITEM\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":500,\"card_last4\":\"1234\"}]}")"
s30_expect "$S30_STATUS" 409 "Open the till first." "a card sale with the till closed"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/sales/$S30_K_BIG_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S30_K_BIG_LINE\",\"qty\":1}],\"reason\":\"Wrong item\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":90000}]}")"
s30_expect "$S30_STATUS" 409 "Open the till first." "a card refund with the till closed"
S30_STATUS="$(s30_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":5000}')"
s30_expect "$S30_STATUS" 200 "" "reopening the till"
S30_SESSION="$(s30_field "session.id")"
ok "with the till closed, a sale and a refund are both refused whatever the tender"

# --- 30m. The till catalogue ----------------------------------------------
S30_QUICK="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Quick'" "$BASE/api/collections/till_categories/records" | jval "items.0.id")"
S30_SEALED="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Sealed'" "$BASE/api/collections/till_categories/records" | jval "items.0.id")"
S30_M_LINE="$(s30_item "S30 Quick Key Sleeves" 5 450 accessory)"
curl -s -o /dev/null -X POST "$BASE/api/collections/till_keys/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"category\":\"$S30_QUICK\",\"position\":9,\"item\":\"$S30_M_LINE\",\"label\":\"Sleeves\"}"
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/till/catalogue")"
s30_expect "$S30_STATUS" 200 "" "the till catalogue"
S30_M_CHECK="$(s30_body | node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const problems = [];
  const cats = body.categories || [];
  if (!cats.length || cats[0].name !== "Quick") problems.push("Quick is not first");
  const sorts = cats.map((c) => c.sort);
  if (sorts.join() !== [...sorts].sort((a, b) => a - b).join()) problems.push("categories are not in sort order");
  const quick = cats.find((c) => c.name === "Quick") || { keys: [] };
  const positions = quick.keys.map((k) => k.position);
  if (positions.join() !== [...positions].sort((a, b) => a - b).join()) problems.push("keys are not in position order");
  const single = quick.keys.find((k) => k.product && k.product.name === "Single card");
  if (!single || single.product.open_price !== true || single.product.tax_scheme !== "margin") problems.push("Single card is not an open-price margin key");
  const table = quick.keys.find((k) => k.product && k.product.name === "Table time, 1 hour");
  if (!table || table.product.price !== 500 || table.product.open_price !== false) problems.push("Table time is not a priced key");
  if (quick.keys.some((k) => k.product && k.product.name.startsWith("Guild Membership"))) problems.push("a switched-off product has a key");
  const sleeves = quick.keys.find((k) => k.item && k.item.id === process.argv[1]);
  if (!sleeves || sleeves.label !== "Sleeves" || sleeves.item.qty !== 5 || sleeves.item.kind !== "accessory" || !sleeves.item.sku) problems.push("the stock line key is wrong");
  const sealed = cats.find((c) => c.name === "Sealed");
  if (!sealed || sealed.dynamic !== true) problems.push("Sealed is not dynamic");
  if (quick.dynamic !== false) problems.push("Quick is dynamic");
  process.stdout.write(problems.join("; "));
' "$S30_M_LINE")"
[ -z "$S30_M_CHECK" ] || fail "the till catalogue is wrong: $S30_M_CHECK"
ok "the till catalogue lists active categories by sort with their keys by position, products and stock lines expanded, switched-off products left out"

S30_M_BOX="$(s30_item "S30 Dynamic Booster Box" 2 9999)"
s30_item "S30 Dynamic Sold Out Box" 0 9999 >/dev/null
s30_item "S30 Dynamic Accessory" 2 999 accessory >/dev/null
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/till/category/$S30_SEALED/items?q=S30%20Dynamic")"
s30_expect "$S30_STATUS" 200 "" "a dynamic category's stock"
[ "$(s30_field total)" = "1" ] || fail "the Sealed list for 'S30 Dynamic' has $(s30_field total) rows, expected 1 (in stock, sealed only): $(s30_body)"
[ "$(s30_field "items.0.id")" = "$S30_M_BOX" ] && [ "$(s30_field "items.0.qty")" = "2" ] || fail "the Sealed list returned the wrong item: $(s30_body)"
[ "$(s30_field page)" = "1" ] || fail "the dynamic list does not say its page"
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/till/category/$S30_QUICK/items")"
s30_expect "$S30_STATUS" 400 "Quick has its own keys, not a stock list. Use the till catalogue." "the stock list of a category that is not dynamic"
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/till/category/nosuchcategory1/items")"
s30_expect "$S30_STATUS" 404 "That category is not on the till any more. Reload the till." "the stock list of a category that does not exist"
ok "a dynamic category lists in-stock stock lines of its kinds, searched by title, a page at a time"

# --- 30n. Receipts for a sale and for a refund ---------------------------
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_A_SALE/receipt")"
s30_expect "$S30_STATUS" 200 "" "a sale's receipt"
[ "$(s30_field "receipt.kind")" = "sale" ] && [ "$(s30_field "receipt.number")" = "$S30_A_NUMBER" ] \
  && [ "$(s30_field "receipt.barcode")" = "$S30_A_BARCODE" ] || fail "the sale receipt's kind, number or barcode is wrong: $(s30_body)"
[ "$(s30_field "receipt.register")" = "Counter" ] && [ "$(s30_field "receipt.staff")" = "Check" ] \
  || fail "the sale receipt does not name the till and the first name of who served"
[ "$(s30_field "receipt.total")" = "2500" ] && [ "$(s30_field "receipt.change")" = "1000" ] \
  || fail "the sale receipt's total or change is wrong"
[ "$(s30_field "receipt.tenders.0.label")" = "Cash" ] && [ "$(s30_field "receipt.tenders.1.card_last4")" = "4242" ] \
  || fail "the sale receipt's tenders are wrong"
[ "$(s30_field "receipt.shop.name")" = "GG Entertainment" ] || fail "the receipt has no shop name"
[ -n "$(s30_field "receipt.footer")" ] || fail "the receipt has no footer from settings.epos.receipt"
case "$(s30_field "receipt.portal_url")" in
  */account) ;;
  *) fail "the receipt's portal_url is '$(s30_field "receipt.portal_url")'" ;;
esac
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_K_SALE/receipt?refund=$S30_K_NUMBER-R1")"
s30_expect "$S30_STATUS" 200 "" "a refund's receipt"
[ "$(s30_field "receipt.kind")" = "refund" ] && [ "$(s30_field "receipt.number")" = "$S30_K_NUMBER-R1" ] \
  || fail "the refund receipt's kind or number is wrong: $(s30_body)"
[ "$(s30_field "receipt.refund.of_number")" = "$S30_K_NUMBER" ] && [ "$(s30_field "receipt.refund.reason")" = "Changed their mind" ] \
  || fail "the refund receipt does not say what it refunded and why"
[ "$(s30_field "receipt.total")" = "-1500" ] && [ "$(s30_field "receipt.tenders.0.amount")" = "-1500" ] \
  && [ "$(s30_field "receipt.lines.0.kind")" = "return" ] && [ "$(s30_field "receipt.lines.0.title")" = "S30 Refund A" ] \
  || fail "the refund receipt's lines and tenders are wrong: $(s30_body)"
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_K_SALE/receipt?refund=$S30_K_NUMBER-R9")"
s30_expect "$S30_STATUS" 404 "$S30_K_NUMBER-R9 is not a refund on $S30_K_NUMBER." "a refund receipt for a reference that does not exist"
ok "a sale's receipt and a refund's receipt carry the contract's ReceiptData, the refund's lines and tenders negative"

# --- 30o. Reprinting writes a till event --------------------------------
S30_O_BEFORE="$(s30_list till_events "kind='reprint' && staff='$S30_CLERK_ID'" | jval totalItems)"
S30_STATUS="$(s30_get "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_A_SALE/receipt?reprint=1")"
s30_expect "$S30_STATUS" 200 "" "a reprint"
S30_O_EVENTS="$(s30_list till_events "kind='reprint' && staff='$S30_CLERK_ID'")"
[ "$(echo "$S30_O_EVENTS" | jval totalItems)" = "$((S30_O_BEFORE + 1))" ] || fail "a reprint wrote no reprint till event"
S30_O_LAST=$(($(echo "$S30_O_EVENTS" | jval totalItems) - 1))
[ "$(echo "$S30_O_EVENTS" | jval "items.$S30_O_LAST.detail.sale")" = "$S30_A_NUMBER" ] \
  && [ "$(echo "$S30_O_EVENTS" | jval "items.$S30_O_LAST.register")" = "$S30_REGISTER" ] \
  && [ "$(echo "$S30_O_EVENTS" | jval "items.$S30_O_LAST.session")" = "$S30_SESSION" ] \
  || fail "the reprint event does not name the sale, the register and the open session: $S30_O_EVENTS"
s30_get "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_A_SALE/receipt" >/dev/null
[ "$(s30_list till_events "kind='reprint' && staff='$S30_CLERK_ID'" | jval totalItems)" = "$((S30_O_BEFORE + 1))" ] \
  || fail "reading a receipt without reprint=1 wrote a reprint event"
ok "a reprint is recorded as a reprint till event on the sale's register; reading a receipt is not"

# --- 30p. The receipt email, in test mode ---------------------------------
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_A_SALE/receipt/email" '{}')"
s30_expect "$S30_STATUS" 400 "There is no email address for this sale. Type one in." "emailing a walk-in sale's receipt with no address"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_A_SALE/receipt/email" '{"email":"shopper@example.com"}')"
s30_expect "$S30_STATUS" 202 "" "emailing a receipt to a typed address"
[ "$(s30_field sent_to)" = "s***@example.com" ] || fail "the email route answered sent_to '$(s30_field sent_to)', expected the masked address"
[ "$(s30_field test_mode)" = "true" ] && [ "$(s30_field sent)" = "false" ] || fail "the email route did not report test mode"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_A_SALE/receipt/email" '{"email":"not an address"}')"
s30_expect "$S30_STATUS" 400 "That email address does not look right. Check it and type it again." "emailing a receipt to a bad address"
S30_E_SALE_ID="$(s30_list sales "number='$S30_E_NUMBER'" | jval "items.0.id")"
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/sales/$S30_E_SALE_ID/receipt/email" '{}')"
s30_expect "$S30_STATUS" 202 "" "emailing a receipt to the sale's customer"
[ "$(s30_field sent_to)" = "s***@local.test" ] || fail "the customer's own address was not used: $(s30_body)"
S30_P_AUDIT="$(s30_list audit_log "action='sale_receipt_email'")"
[ "$(echo "$S30_P_AUDIT" | jval totalItems)" -ge 2 ] || fail "the receipt emails wrote no audit rows"
echo "$S30_P_AUDIT" | grep -qF "shopper@example.com" && fail "an email address reached audit_log"
ok "the receipt email needs an address, defaults to the customer's, answers 202 with the address masked, and logs instead of sending in test mode"

# --- 30q. The display's sale stages ---------------------------------------
S30_STATUS="$(s30_post "$S30_CLERK_TOKEN" "/api/vault/display" \
  '{"mode":"sale","payload":{"lines":[{"title":"Booster","qty":1,"unit_price":450}],"subtotal":450,"discount":0,"total":450,"stage":"card","amount_due":450,"change":0,"points_earned":4,"till_secret":"x"}}')"
s30_expect "$S30_STATUS" 200 "" "publishing a sale at the card stage"
S30_Q_ROW="$(curl -s "$BASE/api/collections/display_state/records?perPage=1" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$S30_Q_ROW" | jval "items.0.payload.stage")" = "card" ] && [ "$(echo "$S30_Q_ROW" | jval "items.0.payload.amount_due")" = "450" ] \
  && [ "$(echo "$S30_Q_ROW" | jval "items.0.payload.change")" = "0" ] && [ "$(echo "$S30_Q_ROW" | jval "items.0.payload.points_earned")" = "4" ] \
  || fail "the display did not keep the sale's stage fields: $S30_Q_ROW"
echo "$S30_Q_ROW" | grep -q "till_secret" && fail "the display kept a payload key the contract does not name"
s30_post "$S30_CLERK_TOKEN" "/api/vault/display" \
  '{"mode":"sale","payload":{"lines":[],"subtotal":0,"total":0,"stage":"paid","amount_due":"lots"}}' >/dev/null
S30_Q_ROW="$(curl -s "$BASE/api/collections/display_state/records?perPage=1" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$S30_Q_ROW" | jval "items.0.payload.stage")" = "" ] || fail "the display kept a stage that is not one of the four"
[ "$(echo "$S30_Q_ROW" | jval "items.0.payload.amount_due")" = "0" ] || fail "the display kept an amount_due that is not a number"
s30_post "$S30_CLERK_TOKEN" "/api/vault/display/clear" '{}' >/dev/null
ok "the display keeps a sale's stage, amount due, change and points earned, as one of four stages and numbers only"

# --- 30r. The money collections are locked down --------------------------
S30_R_SALE_LINE="$(s30_list sale_lines "sale='$S30_A_SALE'" | jval "items.0.id")"
S30_R_TENDER="$(s30_list sale_tenders "sale='$S30_A_SALE'" | jval "items.0.id")"
S30_R_MOVE="$(s30_list cash_movements "session='$S30_SESSION'" | jval "items.0.id")"
[ -n "$S30_R_MOVE" ] || S30_R_MOVE="$(s30_list cash_movements "id != ''" | jval "items.0.id")"
for pair in "sales:$S30_A_SALE" "sale_lines:$S30_R_SALE_LINE" "sale_tenders:$S30_R_TENDER" "cash_sessions:$S30_SESSION" "cash_movements:$S30_R_MOVE"; do
  S30_R_NAME="${pair%%:*}"
  S30_R_ID="${pair#*:}"
  [ -n "$S30_R_ID" ] || fail "no $S30_R_NAME row to try the lockdown against"
  S30_R_SCHEMA="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/$S30_R_NAME")"
  for rule in createRule updateRule deleteRule; do
    [ "$(echo "$S30_R_SCHEMA" | jval "$rule")" = "" ] || fail "$S30_R_NAME.$rule is '$(echo "$S30_R_SCHEMA" | jval "$rule")', expected null"
  done
  [ "$(echo "$S30_R_SCHEMA" | jval listRule)" = '@request.auth.collectionName = "staff"' ] || fail "$S30_R_NAME can no longer be listed by staff"
  for token in "$STAFF_TOKEN" "$S30_CLERK_TOKEN"; do
    S30_R_CREATE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/$S30_R_NAME/records" \
      -H "Authorization: $token" -H "Content-Type: application/json" -d '{}')"
    [ "$S30_R_CREATE" = "403" ] || fail "a staff token creating a $S30_R_NAME row got $S30_R_CREATE, expected 403"
    S30_R_UPDATE="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/collections/$S30_R_NAME/records/$S30_R_ID" \
      -H "Authorization: $token" -H "Content-Type: application/json" -d '{}')"
    [ "$S30_R_UPDATE" = "403" ] || fail "a staff token updating a $S30_R_NAME row got $S30_R_UPDATE, expected 403"
    S30_R_DELETE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/collections/$S30_R_NAME/records/$S30_R_ID" \
      -H "Authorization: $token")"
    [ "$S30_R_DELETE" = "403" ] || fail "a staff token deleting a $S30_R_NAME row got $S30_R_DELETE, expected 403"
  done
  S30_R_LIST="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/$S30_R_NAME/records?perPage=1" -H "Authorization: $S30_CLERK_TOKEN")"
  [ "$S30_R_LIST" = "200" ] || fail "a staff token listing $S30_R_NAME got $S30_R_LIST"
done
for S30_R_NAME in till_reports till_events till_overrides; do
  S30_R_SCHEMA="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/$S30_R_NAME")"
  for rule in createRule updateRule deleteRule; do
    [ "$(echo "$S30_R_SCHEMA" | jval "$rule")" = "" ] || fail "$S30_R_NAME.$rule is not null"
  done
done
[ "$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/sales/records/$S30_A_SALE" | jval total)" = "2500" ] \
  || fail "a refused write changed the sale"
ok "no staff token, admin or not, can create, update or delete sales, sale lines, tenders, cash sessions or cash movements through the collection API"

# A counter sale written any other way still belongs to the default register.
S30_R_DIRECT="$(curl -s -X POST "$BASE/api/collections/sales/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d '{"number":"GG-S-S30-DIRECT","subtotal":0,"discount":0,"total":0,"status":"complete"}')"
[ "$(echo "$S30_R_DIRECT" | jval register)" = "$S30_REGISTER" ] || fail "a counter sale written with no register was not given the default one: $S30_R_DIRECT"
[ "$(echo "$S30_R_DIRECT" | jval channel)" = "counter" ] || fail "a sale written with no channel is not a counter sale"
curl -s -o /dev/null -X DELETE "$BASE/api/collections/sales/records/$(echo "$S30_R_DIRECT" | jval id)" -H "Authorization: $SUPER_TOKEN"
ok "a counter sale created with no register gets the default register"

# --- 30s. SumUp is gone from the server ----------------------------------
for S30_S_ROUTE in "GET /api/vault/sumup/readers" "POST /api/vault/sumup/readers" "POST /api/vault/sumup/pull" \
  "GET /api/vault/sumup/reconcile" "POST /api/vault/sumup/checkouts" "GET /api/vault/sumup/checkouts/abc" \
  "POST /api/vault/sumup/checkouts/abc/cancel" "POST /api/vault/sumup/callback/abc" "GET /api/vault/exports/sumup.csv"; do
  S30_S_METHOD="${S30_S_ROUTE%% *}"
  S30_S_PATH="${S30_S_ROUTE#* }"
  S30_S_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X "$S30_S_METHOD" "$BASE$S30_S_PATH" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json")"
  [ "$S30_S_STATUS" = "404" ] || fail "$S30_S_ROUTE still answers ($S30_S_STATUS)"
done
S30_S_CRON="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/sumup_pull" -H "Authorization: $SUPER_TOKEN")"
[ "$S30_S_CRON" = "404" ] || fail "the sumup_pull cron still exists ($S30_S_CRON)"
S30_S_CONFIG="$(curl -s -H "Authorization: $S30_CLERK_TOKEN" "$BASE/api/vault/config")"
[ -z "$(echo "$S30_S_CONFIG" | jval settings.sumup)" ] || fail "GET /api/vault/config still serves settings.sumup"
ok "no SumUp route or cron answers any more, and the config no longer serves SumUp's settings"
