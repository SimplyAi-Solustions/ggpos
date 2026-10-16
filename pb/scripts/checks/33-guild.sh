# shellcheck shell=bash
# -----------------------------------------------------------------------
# 33. The GG Guild and loyalty offers (docs/api-contract-launch.md,
#     section 2): joining an existing customer and a new one, every
#     refusal with its sentence and status, the welcome bonus once whatever
#     path a customer joins by (the route, the collection API, My Vault), a
#     non-member's sale and buy-in credit earning nothing and a member's
#     earning, an offer on a branch matching a line in a sub-branch and not
#     a line elsewhere, an item offer and a product offer, the new condition
#     shapes refused when wrong, a paid-plan offer, the Guild+ tier the
#     migration seeds, the paid plan product granting it (and joining a
#     customer who buys it), and a member's refund reversing as before.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR
# and the ok/fail/jval helpers. It leaves the default register's till open
# or closed as it found it, every offer it made deleted and the Guild
# Membership product as it was.
# -----------------------------------------------------------------------

S33_DIR="$TMP_DIR/s33"
mkdir -p "$S33_DIR"

# --- helpers -------------------------------------------------------------

# $1 METHOD, $2 token, $3 path, [$4 JSON body] -> the status code; the body
# is left in $S33_DIR/last.json.
s33_call() {
  local data=()
  if [ -n "${4:-}" ]; then data=(-d "$4"); fi
  curl -s -o "$S33_DIR/last.json" -w '%{http_code}' -X "$1" "$BASE$3" \
    -H "Authorization: $2" -H "Content-Type: application/json" ${data[@]+"${data[@]}"}
}
s33_post() { s33_call POST "$1" "$2" "$3"; }
s33_get() { s33_call GET "$1" "$2"; }
s33_body() { cat "$S33_DIR/last.json"; }
s33_field() { jval "$1" <"$S33_DIR/last.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
s33_expect() {
  [ "$1" = "$2" ] || fail "$4 returned $1, expected $2: $(s33_body)"
  if [ -n "$3" ]; then
    [ "$(s33_field message)" = "$3" ] || fail "$4 said '$(s33_field message)', expected '$3'"
  fi
}

# $1 collection, $2 filter -> the superuser's list of matching records.
s33_list() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    --data-urlencode "perPage=200" --data-urlencode "sort=created,id" "$BASE/api/collections/$1/records"
}
s33_count() { s33_list "$1" "$2" | jval totalItems; }

# $1 collection, $2 id, $3 field -> that field as the superuser reads it.
s33_rec() {
  curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/$1/records/$2" | jval "$3"
}

# $1 name, [$2 email] -> a customer made through the collection API without joining.
s33_customer() {
  local email=""
  if [ -n "${2:-}" ]; then email=",\"email\":\"$2\""; fi
  curl -s -X POST "$BASE/api/collections/customers/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"source\":\"counter\"$email}" | jval id
}

# $1 title, $2 price, [$3 branch id] -> a stock row of one, in stock.
s33_item() {
  local category=""
  if [ -n "${3:-}" ]; then category=",\"category\":\"$3\""; fi
  curl -s -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"kind\":\"other\",\"game\":\"$S33_GAME\",\"title\":\"$1\",\"qty\":1,\"cost\":100,\"price\":$2,\"status\":\"in_stock\",\"tax_scheme\":\"margin\",\"source\":\"supplier\"$category}" \
    | jval id
}

# $1 customer ("" for none), $2 lines JSON, $3 total -> the status; a card sale.
s33_sell() {
  local customer=""
  if [ -n "$1" ]; then customer=",\"customer\":\"$1\""; fi
  s33_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
    "{\"lines\":$2$customer,\"tenders\":[{\"method\":\"card_tide\",\"amount\":$3,\"card_last4\":\"3333\"}]}"
}

# $1 JSON body -> a loyalty_rules row made by the admin, its id.
s33_offer() {
  local id
  id="$(curl -s -X POST "$BASE/api/collections/loyalty_rules/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$1" | jval id)"
  [ -n "$id" ] || fail "could not create the offer $1"
  echo "$id" >> "$S33_DIR/offers.txt"
  echo "$id"
}
s33_offer_off() {
  curl -s -o /dev/null -X PATCH "$BASE/api/collections/loyalty_rules/records/$1" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"active":false}'
}

# $1 branch key -> its id.
s33_branch() {
  curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=key='$1'" \
    "$BASE/api/collections/categories/records" | jval "items.0.id"
}

s33_session() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id"
}

# --- setup ---------------------------------------------------------------

S33_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$S33_GAME" ] || fail "33: the seeded pokemon game is missing"
S33_WELCOME="$(curl -s "$BASE/api/collections/loyalty_programme/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.welcome_bonus")"
[ "$S33_WELCOME" = "100" ] || fail "33: the seeded welcome bonus is '$S33_WELCOME', expected 100"
S33_TILL_WAS_OPEN="$(s33_session)"
if [ -z "$S33_TILL_WAS_OPEN" ]; then
  S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":5000}')"
  s33_expect "$S33_STATUS" 200 "" "opening the till for section 33"
fi
: > "$S33_DIR/offers.txt"

# --- 33a. A customer made without joining is not a member ---------------
S33_GUS="$(s33_customer "Gus Guild" "gus-guild@local.test")"
[ -n "$S33_GUS" ] || fail "could not create the customer who joins later"
[ -z "$(s33_rec customers "$S33_GUS" guild_joined_at)" ] || fail "a customer made without joining has a joined date"
[ "$(s33_count points_ledger "customer='$S33_GUS'")" = "0" ] || fail "a customer made without joining got points"
[ "$(s33_count notifications "customer='$S33_GUS' && type='welcome'")" = "0" ] || fail "a customer made without joining got the welcome notification"
S33_A_ITEM="$(s33_item "S33 Before joining" 3000)"
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"item\":\"$S33_A_ITEM\",\"qty\":1}]" 3000)"
s33_expect "$S33_STATUS" 200 "" "a sale to a customer who has not joined"
[ "$(s33_field points_earned)" = "0" ] || fail "a non-member's sale earned $(s33_field points_earned) points"
[ "$(s33_count points_ledger "customer='$S33_GUS' && reason='earn_sale'")" = "0" ] || fail "a non-member's sale wrote an earn_sale row"
ok "a customer made without joining has no joined date, no welcome bonus, and their sale earns nothing"

# --- 33b. Joining an existing customer -----------------------------------
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" "{\"customer\":\"$S33_GUS\",\"marketing_consent\":true,\"birthday_month\":4}")"
s33_expect "$S33_STATUS" 200 "" "joining an existing customer"
[ "$(s33_field "customer.id")" = "$S33_GUS" ] || fail "the join answered another customer: $(s33_body)"
[ "$(s33_field "customer.name")" = "Gus Guild" ] || fail "the join's customer has no name: $(s33_body)"
[ -n "$(s33_field "customer.code")" ] || fail "the join's customer has no code"
[ "$(s33_field welcome_points)" = "100" ] || fail "the join's welcome_points is '$(s33_field welcome_points)', expected 100"
[ "$(s33_field points_balance)" = "100" ] || fail "the join's points_balance is '$(s33_field points_balance)', expected 100"
[ -n "$(s33_rec customers "$S33_GUS" guild_joined_at)" ] || fail "joining did not set guild_joined_at"
[ "$(s33_rec customers "$S33_GUS" marketing_consent)" = "true" ] || fail "joining did not keep the marketing consent"
[ "$(s33_rec customers "$S33_GUS" birthday_month)" = "4" ] || fail "joining did not keep the birthday month"
[ "$(s33_count points_ledger "customer='$S33_GUS' && reason='welcome'")" = "1" ] || fail "joining did not write one welcome row"
S33_NOTE="$(s33_list notifications "customer='$S33_GUS' && type='welcome'")"
[ "$(echo "$S33_NOTE" | jval totalItems)" = "1" ] || fail "joining did not write one welcome notification"
[ "$(echo "$S33_NOTE" | jval "items.0.title")" = "Welcome to GG Guild" ] || fail "the Guild card notification is titled '$(echo "$S33_NOTE" | jval "items.0.title")'"
echo "$S33_NOTE" | grep -q "100 points are on your card. Your Guild card is GGC-" \
  || fail "the Guild card notification does not carry the bonus and the code: $S33_NOTE"
S33_AUDIT="$(s33_list audit_log "action='guild_join' && record='$S33_GUS'")"
[ "$(echo "$S33_AUDIT" | jval totalItems)" = "1" ] || fail "joining wrote $(echo "$S33_AUDIT" | jval totalItems) guild_join audit rows"
[ "$(echo "$S33_AUDIT" | jval "items.0.meta.welcome_points")" = "100" ] || fail "the guild_join audit row does not carry the bonus"
echo "$S33_AUDIT" | grep -q "gus-guild" && fail "the guild_join audit row carries the customer's email"
ok "joining an existing customer sets the date, consent and birthday month, posts the welcome bonus, writes the Guild card notification and one audit row"

S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" "{\"customer\":\"$S33_GUS\",\"marketing_consent\":true}")"
s33_expect "$S33_STATUS" 409 "Gus Guild is already in the Guild." "joining a member again"
[ "$(s33_count points_ledger "customer='$S33_GUS' && reason='welcome'")" = "1" ] || fail "joining twice paid the welcome bonus twice"
ok "a member joining again is refused with 409 and no second bonus"

S33_B_ITEM="$(s33_item "S33 After joining" 3000)"
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"item\":\"$S33_B_ITEM\",\"qty\":1}]" 3000)"
s33_expect "$S33_STATUS" 200 "" "a member's sale"
[ "$(s33_field points_earned)" = "300" ] || fail "a member's £30.00 sale earned $(s33_field points_earned) points, expected 300"
[ "$(s33_count points_ledger "customer='$S33_GUS' && reason='earn_sale'")" = "1" ] || fail "a member's sale wrote no earn_sale row"
S33_B_SALE="$(s33_field "sale.id")"
ok "once they have joined, the same customer's sale earns its points"

# A member's refund reverses what the sale earned, as before.
S33_B_LINE="$(s33_list sale_lines "sale='$S33_B_SALE'" | jval "items.0.id")"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/sales/$S33_B_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$S33_B_LINE\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":3000}]}")"
s33_expect "$S33_STATUS" 200 "" "refunding a member's sale"
S33_REVERSED="$(s33_list points_ledger "customer='$S33_GUS' && reason='refund_reverse'")"
[ "$(echo "$S33_REVERSED" | jval "items.0.delta")" = "-300" ] || fail "the refund reversed '$(echo "$S33_REVERSED" | jval "items.0.delta")' points, expected -300"
ok "refunding a member's sale reverses the points it earned"

# --- 33c. Joining a new customer, and every refusal ----------------------
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"Nia New","email":"Nia-New@local.test","marketing_consent":false,"birthday_month":5}')"
s33_expect "$S33_STATUS" 200 "" "joining a new customer by email"
S33_NIA="$(s33_field "customer.id")"
S33_NIA_CODE="$(s33_field "customer.code")"
echo "$S33_NIA_CODE" | grep -Eq '^GGC[0-9A-HJKMNP-TV-Z]{6}$' || fail "the new member's code '$S33_NIA_CODE' is not a customer code"
[ "$(s33_field welcome_points)" = "100" ] && [ "$(s33_field points_balance)" = "100" ] || fail "the new member's bonus is wrong: $(s33_body)"
[ "$(s33_rec customers "$S33_NIA" email)" = "nia-new@local.test" ] || fail "the new member's email is '$(s33_rec customers "$S33_NIA" email)'"
[ "$(s33_rec customers "$S33_NIA" source)" = "counter" ] || fail "the new member's source is not counter"
[ "$(s33_rec customers "$S33_NIA" birthday_month)" = "5" ] || fail "the new member's birthday month did not land"
[ -n "$(s33_rec customers "$S33_NIA" guild_joined_at)" ] || fail "the new member has no joined date"
[ "$(s33_count customer_private "customer='$S33_NIA'")" = "1" ] || fail "the new member has no customer_private row"
[ "$(s33_list audit_log "action='guild_join' && record='$S33_NIA'" | jval "items.0.meta.created")" = "true" ] || fail "the new member's audit row does not say they were made"
ok "a new customer is made and joins in one step, with a card code, the bonus and the audit row"

S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"Pip Phone","phone":"07700 900555","marketing_consent":false}')"
s33_expect "$S33_STATUS" 200 "" "joining a new customer by phone"
S33_PIP="$(s33_field "customer.id")"
[ "$(s33_rec customers "$S33_PIP" phone)" = "07700 900555" ] || fail "the phone-only member's phone did not land"
ok "a name and a phone number are enough to join"

S33_MISSING="Add a name and an email or a phone number."
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"marketing_consent":false}')"
s33_expect "$S33_STATUS" 400 "$S33_MISSING" "joining with nothing"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"No Contact","marketing_consent":false}')"
s33_expect "$S33_STATUS" 400 "$S33_MISSING" "joining with a name alone"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"email":"no-name@local.test","marketing_consent":false}')"
s33_expect "$S33_STATUS" 400 "$S33_MISSING" "joining with an email and no name"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"Bad Email","email":"not-an-email","marketing_consent":false}')"
s33_expect "$S33_STATUS" 400 "That email address does not look right. Check it and try again." "joining with a bad email"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"Bad Month","email":"bad-month@local.test","marketing_consent":false,"birthday_month":13}')"
s33_expect "$S33_STATUS" 400 "A birthday month is a number from 1 to 12." "joining with a thirteenth month"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"customer":"nosuchcustomer1","marketing_consent":false}')"
s33_expect "$S33_STATUS" 404 "That customer no longer exists. Search again." "joining a customer who does not exist"

S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"Nina Again","email":"NIA-NEW@local.test","marketing_consent":false}')"
s33_expect "$S33_STATUS" 409 "Nia New already has that email. Open their record instead." "joining with an email somebody has"
[ "$(s33_field "customer.id")" = "$S33_NIA" ] && [ "$(s33_field "customer.code")" = "$S33_NIA_CODE" ] && [ "$(s33_field "customer.name")" = "Nia New" ] \
  || fail "the email clash does not name the customer who holds it: $(s33_body)"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" '{"name":"Pippa Again","phone":"+44 7700 900555","marketing_consent":false}')"
s33_expect "$S33_STATUS" 409 "Pip Phone already has that phone number. Open their record instead." "joining with a phone number somebody has"
[ "$(s33_field "customer.id")" = "$S33_PIP" ] || fail "the phone clash does not name the customer who holds it: $(s33_body)"
[ "$(s33_count customers "name='Nina Again' || name='Pippa Again' || name='No Contact' || name='Bad Email' || name='Bad Month'")" = "0" ] \
  || fail "a refused join made a customer anyway"

S33_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/vault/guild/join" -H "Content-Type: application/json" -d '{"name":"Anon","email":"anon@local.test"}')"
[ "$S33_STATUS" = "401" ] || fail "joining with no sign-in returned $S33_STATUS, expected 401"
S33_GUS_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$S33_GUS" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$S33_GUS_TOKEN" ] || fail "could not impersonate the joined customer"
S33_STATUS="$(s33_post "$S33_GUS_TOKEN" "/api/vault/guild/join" '{"name":"Sneaky","email":"sneaky@local.test"}')"
[ "$S33_STATUS" = "403" ] || fail "a customer token on the staff join route returned $S33_STATUS, expected 403"
ok "every join refusal says its own sentence and status, a clash names the customer who holds the email or phone, and nothing is made"

# --- 33d. The welcome bonus once, whatever the path ----------------------
# Through the collection API: setting the date joins them, from now.
S33_UMA="$(s33_customer "Uma Update" "uma-update@local.test")"
S33_STATUS="$(s33_call PATCH "$STAFF_TOKEN" "/api/collections/customers/records/$S33_UMA" '{"guild_joined_at":"2020-01-01 00:00:00.000Z"}')"
s33_expect "$S33_STATUS" 200 "" "joining through the collection API"
S33_UMA_JOINED="$(s33_rec customers "$S33_UMA" guild_joined_at)"
case "$S33_UMA_JOINED" in 2020-*|"") fail "the collection API kept the sent date '$S33_UMA_JOINED' rather than now" ;; esac
[ "$(s33_count points_ledger "customer='$S33_UMA' && reason='welcome'")" = "1" ] || fail "joining through the collection API did not post the bonus once"
s33_call PATCH "$STAFF_TOKEN" "/api/collections/customers/records/$S33_UMA" '{"guild_joined_at":"2030-01-01 00:00:00.000Z"}' >/dev/null
[ "$(s33_rec customers "$S33_UMA" guild_joined_at)" = "$S33_UMA_JOINED" ] || fail "a member's joined date moved"
s33_call PATCH "$STAFF_TOKEN" "/api/collections/customers/records/$S33_UMA" '{"guild_joined_at":""}' >/dev/null
[ "$(s33_rec customers "$S33_UMA" guild_joined_at)" = "$S33_UMA_JOINED" ] || fail "a member's joined date was cleared"
s33_call PATCH "$STAFF_TOKEN" "/api/collections/customers/records/$S33_UMA" '{"name":"Uma Updated"}' >/dev/null
[ "$(s33_rec customers "$S33_UMA" guild_joined_at)" = "$S33_UMA_JOINED" ] || fail "an ordinary edit moved the joined date"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" "{\"customer\":\"$S33_UMA\",\"marketing_consent\":false}")"
s33_expect "$S33_STATUS" 409 "Uma Updated is already in the Guild." "the join route after the collection API"
[ "$(s33_count points_ledger "customer='$S33_UMA' && reason='welcome'")" = "1" ] || fail "a second path paid the welcome bonus again"

# Created as a member: the date is now and the bonus is paid once.
S33_CARA="$(curl -s -X POST "$BASE/api/collections/customers/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Cara Created","email":"cara-created@local.test","source":"counter","guild_joined_at":"2020-01-01 00:00:00.000Z"}' | jval id)"
case "$(s33_rec customers "$S33_CARA" guild_joined_at)" in 2020-*|"") fail "a customer created in the Guild kept the sent date" ;; esac
[ "$(s33_count points_ledger "customer='$S33_CARA' && reason='welcome'")" = "1" ] || fail "a customer created in the Guild did not get one bonus"
ok "joining through the collection API stamps now, pays the bonus once, and the date never moves or clears after"

# My Vault: the terms first, then the join, then never again.
S33_MO="$(s33_customer "Mo Vault" "mo-vault@local.test")"
S33_MO_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$S33_MO" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$S33_MO_TOKEN" ] || fail "could not impersonate the My Vault customer"
S33_STATUS="$(s33_get "$S33_MO_TOKEN" "/api/vault/me/guild")"
s33_expect "$S33_STATUS" 200 "" "My Vault's Guild for a customer who has not joined"
[ "$(s33_field member)" = "false" ] && [ -z "$(s33_field joined_at)" ] && [ "$(s33_field welcome_bonus)" = "100" ] \
  || fail "My Vault's Guild does not say they have not joined: $(s33_body)"
S33_STATUS="$(s33_post "$S33_MO_TOKEN" "/api/vault/me/guild/join" '{"marketing_consent":true}')"
s33_expect "$S33_STATUS" 400 "Read the Guild terms and agree to them to join." "joining in My Vault without the terms"
S33_STATUS="$(s33_post "$S33_MO_TOKEN" "/api/vault/me/guild/join" '{"terms_accepted":true,"marketing_consent":true}')"
s33_expect "$S33_STATUS" 200 "" "joining in My Vault"
[ "$(s33_field welcome_points)" = "100" ] && [ "$(s33_field points_balance)" = "100" ] && [ -n "$(s33_field joined_at)" ] \
  || fail "My Vault's join answered $(s33_body)"
[ "$(s33_rec customers "$S33_MO" marketing_consent)" = "true" ] || fail "My Vault's join did not keep the consent"
S33_STATUS="$(s33_post "$S33_MO_TOKEN" "/api/vault/me/guild/join" '{"terms_accepted":true}')"
s33_expect "$S33_STATUS" 409 "You are already in the Guild." "joining in My Vault twice"
S33_STATUS="$(s33_get "$S33_MO_TOKEN" "/api/vault/me/guild")"
[ "$(s33_field member)" = "true" ] && [ -n "$(s33_field joined_at)" ] || fail "My Vault's Guild does not show them joined: $(s33_body)"
[ "$(s33_count points_ledger "customer='$S33_MO' && reason='welcome'")" = "1" ] || fail "My Vault's join paid the bonus more than once"
[ "$(s33_list audit_log "action='guild_join' && record='$S33_MO'" | jval "items.0.meta.by")" = "customer" ] || fail "My Vault's join was not audited as the customer's"

# A customer setting their own date through the collection API is refused:
# the Guild page asks for the terms first.
S33_KAI="$(s33_customer "Kai Self" "kai-self@local.test")"
S33_KAI_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$S33_KAI" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$S33_KAI_TOKEN" ] || fail "could not sign in as the self-join customer"
S33_STATUS="$(s33_call PATCH "$S33_KAI_TOKEN" "/api/collections/customers/records/$S33_KAI" '{"guild_joined_at":"2020-01-01 00:00:00.000Z"}')"
s33_expect "$S33_STATUS" 403 "Join the Guild on the Guild page in My Vault. It asks you to accept the terms first." "a customer joining through their own record"
[ -z "$(s33_rec customers "$S33_KAI" guild_joined_at)" ] || fail "a customer's own record update joined them"
[ "$(s33_count points_ledger "customer='$S33_KAI'")" = "0" ] || fail "a refused self-join paid points"
ok "My Vault asks for the terms, joins once with the bonus once, and says so; a customer's own record update cannot join them"

# --- 33e. A non-member's buy-in credit earns nothing; a member's earns ----
S33_SIGNATURE="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
# $1 customer -> the part-exchange's response status: £5.00 of stock against
# a £20.00 trade, the £15.00 surplus as store credit.
s33_part_exchange() {
  local trade item
  trade="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"customer\":\"$1\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
  [ -n "$trade" ] || fail "could not draft the part-exchange"
  curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"trade_in\":\"$trade\",\"game\":\"$S33_GAME\",\"market_currency\":\"GBP\",\"kind\":\"single\",\"free_text_title\":\"S33 Trade card\",\"condition\":\"NM\",\"qty\":1,\"market_price\":3000,\"offer_price\":2000,\"accepted\":true}"
  item="$(s33_item "S33 Part-exchange buy" 500)"
  s33_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
    "{\"lines\":[{\"item\":\"$item\",\"qty\":1}],\"customer\":\"$1\",\"trade_in\":\"$trade\",\"trade_settlement\":{\"terms_accepted\":true,\"signature\":\"$S33_SIGNATURE\",\"surplus\":\"credit\"},\"tenders\":[]}"
}
S33_SID="$(s33_customer "Sid Seller")"
S33_STATUS="$(s33_part_exchange "$S33_SID")"
s33_expect "$S33_STATUS" 200 "" "a part-exchange for a customer who has not joined"
[ "$(s33_count points_ledger "customer='$S33_SID'")" = "0" ] || fail "a non-member's part-exchange earned points: $(s33_list points_ledger "customer='$S33_SID'")"
[ "$(s33_count credit_ledger "customer='$S33_SID' && amount=1500")" = "1" ] || fail "the non-member's surplus did not go on as store credit"
S33_STATUS="$(s33_part_exchange "$S33_GUS")"
s33_expect "$S33_STATUS" 200 "" "a part-exchange for a member"
[ "$(s33_field "trade_in.payout_credit")" = "1500" ] || fail "the member's surplus credit is '$(s33_field "trade_in.payout_credit")'"
[ "$(s33_count points_ledger "customer='$S33_GUS' && reason='earn_trade_in' && delta=75")" = "1" ] \
  || fail "a member's £15.00 credit surplus did not earn 75 points: $(s33_list points_ledger "customer='$S33_GUS' && reason='earn_trade_in'")"
[ "$(s33_count points_ledger "customer='$S33_GUS' && reason='earn_sale' && delta=50")" = "1" ] || fail "the member's part-exchange sale did not earn on its whole value"
ok "a part-exchange's credit points follow the member rule: none for a customer who has not joined, the surplus's for a member"

# --- 33f. Offers: a branch, an item, a product ----------------------------
S33_CARDS="$(s33_branch tcg)"
S33_POKEMON="$(s33_branch tcg.pokemon)"
S33_SINGLES="$(s33_branch tcg.pokemon.singles)"
S33_RETRO="$(s33_branch retro)"
[ -n "$S33_POKEMON" ] && [ -n "$S33_SINGLES" ] && [ -n "$S33_RETRO" ] || fail "33: the seeded branches are missing"

S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/collections/loyalty_rules/records" '{"name":"Bad","type":"multiplier","value":2,"active":false,"conditions":{"categories":"tcg"}}')"
s33_expect "$S33_STATUS" 400 "Conditions.categories must be a list of branch ids from the category tree." "an offer's branches that are not a list"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/collections/loyalty_rules/records" '{"name":"Bad","type":"multiplier","value":2,"active":false,"conditions":{"items":[1]}}')"
s33_expect "$S33_STATUS" 400 "Conditions.items must be a list of stock item ids." "an offer's items that are not ids"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/collections/loyalty_rules/records" '{"name":"Bad","type":"multiplier","value":2,"active":false,"conditions":{"products":{}}}')"
s33_expect "$S33_STATUS" 400 "Conditions.products must be a list of till product ids." "an offer's products that are not a list"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/collections/loyalty_rules/records" '{"name":"Bad","type":"multiplier","value":2,"active":false,"conditions":{"paidMembersOnly":"yes"}}')"
s33_expect "$S33_STATUS" 400 "Conditions.paidMembersOnly is true or false." "an offer's paid-plan switch that is not a switch"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/collections/loyalty_rules/records" '{"name":"Bad","type":"multiplier","value":2,"active":false,"conditions":{"branch":["x"]}}')"
s33_expect "$S33_STATUS" 400 'Conditions has no "branch" setting. Use games, kinds, categories, items, products, minSpend, weekdays or paidMembersOnly.' "an offer with an unknown condition"
ok "an offer's branches, items, products and paid-plan switch are refused in the wrong shape, naming the key"

S33_OFFER_BRANCH="$(s33_offer "{\"name\":\"S33 Double Pokemon\",\"type\":\"multiplier\",\"value\":2,\"active\":true,\"priority\":10,\"conditions\":{\"categories\":[\"$S33_POKEMON\"]}}")"
S33_F_SINGLE="$(s33_item "S33 Pokemon single" 1000 "$S33_SINGLES")"
S33_F_RETRO="$(s33_item "S33 Retro cart" 1000 "$S33_RETRO")"
S33_F_CARDS="$(s33_item "S33 Cards top" 1000 "$S33_CARDS")"
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"item\":\"$S33_F_SINGLE\",\"qty\":1},{\"item\":\"$S33_F_RETRO\",\"qty\":1},{\"item\":\"$S33_F_CARDS\",\"qty\":1}]" 3000)"
s33_expect "$S33_STATUS" 200 "" "a sale under a branch offer"
# The Pokémon single, two levels under the offer's branch, doubles to 200;
# the retro cart and the stock filed above Pokémon stay at 100 each.
[ "$(s33_field points_earned)" = "400" ] || fail "the branch offer earned $(s33_field points_earned) points, expected 400"
S33_STATUS="$(s33_sell "" "[{\"item\":\"$(s33_item "S33 Walk-in single" 1000 "$S33_SINGLES")\",\"qty\":1}]" 1000)"
[ "$(s33_field points_earned)" = "0" ] || fail "a walk-in sale under the branch offer earned points"
s33_offer_off "$S33_OFFER_BRANCH"
ok "an offer on a branch doubles a line two branches beneath it and leaves a line elsewhere, and one above it, alone"

S33_G_ITEM="$(s33_item "S33 Bonus ETB" 1000)"
S33_G_OTHER="$(s33_item "S33 Plain ETB" 1000)"
S33_OFFER_ITEM="$(s33_offer "{\"name\":\"S33 ETB bonus\",\"type\":\"fixed_bonus\",\"value\":150,\"active\":true,\"priority\":10,\"conditions\":{\"items\":[\"$S33_G_ITEM\"]}}")"
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"item\":\"$S33_G_OTHER\",\"qty\":1}]" 1000)"
[ "$(s33_field points_earned)" = "100" ] || fail "another item earned the item offer's bonus: $(s33_field points_earned)"
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"item\":\"$S33_G_ITEM\",\"qty\":1}]" 1000)"
[ "$(s33_field points_earned)" = "250" ] || fail "the item offer earned $(s33_field points_earned) points, expected 250"
s33_offer_off "$S33_OFFER_ITEM"

S33_TABLE="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Table time, 1 hour'" "$BASE/api/collections/till_products/records" | jval "items.0.id")"
[ -n "$S33_TABLE" ] || fail "33: the seeded table time product is missing"
S33_OFFER_PRODUCT="$(s33_offer "{\"name\":\"S33 Triple table time\",\"type\":\"multiplier\",\"value\":3,\"active\":true,\"priority\":10,\"conditions\":{\"products\":[\"$S33_TABLE\"]}}")"
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"product\":\"$S33_TABLE\",\"qty\":2}]" 1000)"
s33_expect "$S33_STATUS" 200 "" "a sale under a product offer"
[ "$(s33_field points_earned)" = "300" ] || fail "the product offer earned $(s33_field points_earned) points on £10.00 of table time, expected 300"
s33_offer_off "$S33_OFFER_PRODUCT"
ok "an item offer adds its bonus on that item only, and a product offer multiplies that till product"

# --- 33g. The paid upgrade: Guild+ and the Guild Membership product -------
S33_PLUS="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name='Guild+' && paid_plan=true" "$BASE/api/collections/loyalty_tiers/records" | jval "items.0.id")"
[ -n "$S33_PLUS" ] || fail "the migration did not seed the Guild+ paid-plan tier"
[ "$(s33_rec loyalty_tiers "$S33_PLUS" sort)" = "25" ] || fail "Guild+ is not between Regular and Legend"
S33_MEMBERSHIP="$(curl -s -G -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=kind='membership'" "$BASE/api/collections/till_products/records" | jval "items.0.id")"
[ -n "$S33_MEMBERSHIP" ] || fail "33: the Guild Membership product is missing"
S33_MEMBERSHIP_WAS="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/till_products/records/$S33_MEMBERSHIP")"
# Section 30 tries the product with no tier and switches it off again; put
# it back as the launch migration leaves it.
curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S33_MEMBERSHIP" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d "{\"active\":true,\"membership_tier\":\"$S33_PLUS\",\"price\":2400}"
ok "the migration seeds the Guild+ paid plan between Regular and Legend"

S33_PAID_ONLY="$(s33_offer '{"name":"S33 Guild+ double","type":"multiplier","value":2,"active":false,"priority":10,"conditions":{"paidMembersOnly":true}}')"

# A member buys Guild+: the membership on Guild+, and their tier with it.
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"product\":\"$S33_MEMBERSHIP\",\"qty\":1}]" 2400)"
s33_expect "$S33_STATUS" 200 "" "selling Guild+ to a member"
[ "$(s33_field points_earned)" = "240" ] || fail "a member's £24.00 membership earned $(s33_field points_earned) points, expected 240"
S33_GUS_PLAN="$(s33_list memberships "customer='$S33_GUS'")"
[ "$(echo "$S33_GUS_PLAN" | jval "items.0.tier")" = "$S33_PLUS" ] && [ "$(echo "$S33_GUS_PLAN" | jval "items.0.status")" = "active" ] \
  || fail "the sold plan is not an active Guild+ membership: $S33_GUS_PLAN"
[ "$(s33_list customer_private "customer='$S33_GUS'" | jval "items.0.tier")" = "$S33_PLUS" ] || fail "buying Guild+ did not put the member on the Guild+ tier"
ok "the Guild Membership product sells Guild+ and the member's tier follows"

# Somebody who has not joined buys it: they join with the sale, bonus included.
S33_PAT="$(s33_customer "Pat Plus" "pat-plus@local.test")"
S33_STATUS="$(s33_sell "$S33_PAT" "[{\"product\":\"$S33_MEMBERSHIP\",\"qty\":1}]" 2400)"
s33_expect "$S33_STATUS" 200 "" "selling Guild+ to a customer who has not joined"
[ -n "$(s33_rec customers "$S33_PAT" guild_joined_at)" ] || fail "buying Guild+ did not join the customer"
[ "$(s33_field points_earned)" = "240" ] || fail "the joining sale earned $(s33_field points_earned) points, expected 240"
[ "$(s33_field points_balance)" = "340" ] || fail "the joining customer holds $(s33_field points_balance) points, expected the 100 bonus and 240"
[ "$(s33_count points_ledger "customer='$S33_PAT' && reason='welcome'")" = "1" ] || fail "joining with the sale did not post one welcome bonus"
S33_PAT_SALE_AUDIT="$(s33_list audit_log "action='sale_complete' && record='$(s33_field "sale.id")'")"
[ "$(echo "$S33_PAT_SALE_AUDIT" | jval "items.0.meta.guild_join.welcome_points")" = "100" ] || fail "the sale's audit row does not say it joined the customer"
ok "a customer who buys Guild+ without having joined joins with the sale: the bonus, and the sale's points"

# An offer kept for paid-plan members: Guild+ doubles, a plain member does not.
curl -s -o /dev/null -X PATCH "$BASE/api/collections/loyalty_rules/records/$S33_PAID_ONLY" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"active":true}'
S33_STATUS="$(s33_sell "$S33_GUS" "[{\"item\":\"$(s33_item "S33 Plus buy" 1000)\",\"qty\":1}]" 1000)"
# 100 base, doubled by the offer, then Guild+'s own 1.25 times.
[ "$(s33_field points_earned)" = "250" ] || fail "a Guild+ member earned $(s33_field points_earned) points under the paid-plan offer, expected 250"
S33_STATUS="$(s33_sell "$S33_NIA" "[{\"item\":\"$(s33_item "S33 Plain buy" 1000)\",\"qty\":1}]" 1000)"
[ "$(s33_field points_earned)" = "100" ] || fail "a plain member earned $(s33_field points_earned) points under the paid-plan offer, expected 100"
s33_offer_off "$S33_PAID_ONLY"
ok "an offer kept for paid-plan members applies to Guild+ and not to a plain member"

# --- 33h. A referral pays only once both sides are in the Guild ---------
# Gus joined in 33b. Rae is carded with his code but has not joined: her
# sale leaves the referral pending and pays nobody; once she joins, her
# next sale pays both sides.
S33_GUS_CODE="$(s33_rec customers "$S33_GUS" code)"
S33_RAE="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"Rae Referred\",\"email\":\"rae-referred@local.test\",\"source\":\"counter\",\"referred_by\":\"$S33_GUS_CODE\"}" | jval id)"
[ -n "$S33_RAE" ] || fail "could not card the referred customer"
S33_RAE_REFERRAL="$(s33_list referrals "referee='$S33_RAE'" | jval "items.0.id")"
[ -n "$S33_RAE_REFERRAL" ] || fail "carding a customer with a member's code wrote no referral"
S33_STATUS="$(s33_sell "$S33_RAE" "[{\"item\":\"$(s33_item "S33 Referred before joining" 1500)\",\"qty\":1}]" 1500)"
s33_expect "$S33_STATUS" 200 "" "a sale to a referred customer who has not joined"
[ "$(s33_rec referrals "$S33_RAE_REFERRAL" status)" = "pending" ] \
  || fail "a non-member's sale moved their referral to '$(s33_rec referrals "$S33_RAE_REFERRAL" status)', expected pending"
[ "$(s33_count points_ledger "reason='referral' && ref='$S33_RAE_REFERRAL'")" = "0" ] \
  || fail "a non-member's sale paid referral points"
S33_STATUS="$(s33_post "$STAFF_TOKEN" "/api/vault/guild/join" "{\"customer\":\"$S33_RAE\",\"marketing_consent\":false}")"
s33_expect "$S33_STATUS" 200 "" "joining the referred customer"
S33_STATUS="$(s33_sell "$S33_RAE" "[{\"item\":\"$(s33_item "S33 Referred after joining" 1500)\",\"qty\":1}]" 1500)"
s33_expect "$S33_STATUS" 200 "" "the referred customer's first sale as a member"
[ "$(s33_rec referrals "$S33_RAE_REFERRAL" status)" = "earned" ] \
  || fail "a member's first sale left their referral '$(s33_rec referrals "$S33_RAE_REFERRAL" status)', expected earned"
[ "$(s33_count points_ledger "reason='referral' && ref='$S33_RAE_REFERRAL' && customer='$S33_GUS'")" = "1" ] \
  || fail "the referrer was not paid once the referee joined"
[ "$(s33_count points_ledger "reason='referral' && ref='$S33_RAE_REFERRAL' && customer='$S33_RAE'")" = "1" ] \
  || fail "the referee was not paid once they joined"
ok "a referral stays pending through a non-member's sale and pays both sides on their first sale after joining"

# --- teardown --------------------------------------------------------------
while read -r S33_ID; do
  [ -n "$S33_ID" ] && curl -s -o /dev/null -X DELETE "$BASE/api/collections/loyalty_rules/records/$S33_ID" -H "Authorization: $SUPER_TOKEN"
done < "$S33_DIR/offers.txt"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S33_MEMBERSHIP" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"active\":$(echo "$S33_MEMBERSHIP_WAS" | jval active),\"membership_tier\":\"$(echo "$S33_MEMBERSHIP_WAS" | jval membership_tier)\",\"price\":$(echo "$S33_MEMBERSHIP_WAS" | jval price)}"
[ "$(s33_count loyalty_rules "name ~ 'S33 '")" = "0" ] || fail "section 33 left offers behind"
if [ -z "$S33_TILL_WAS_OPEN" ]; then
  S33_SID_OPEN="$(s33_session)"
  S33_EXPECTED="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected)"
  [ -n "$S33_SID_OPEN" ] && curl -s -o /dev/null -X POST "$BASE/api/vault/cash-sessions/$S33_SID_OPEN/close" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"counted\":$S33_EXPECTED}"
fi
ok "section 33 deletes its offers and leaves the membership product and the till as it found them"
