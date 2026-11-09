# shellcheck shell=bash
# -----------------------------------------------------------------------
# 40. Store credit from a Vault deal, queued for Epos Now
#     (1789821560_epos_credit_queue.js, lib/eposcredit.js): completing a
#     deal with credit queues exactly one pending row in the same
#     transaction, a cash-only deal queues none, the queue is superuser
#     only, a customer cannot set their own epos_customer_id, and
#     GET /api/vault/deals/{id}/epos-credit reports the status.
#
# Sourced by pb/scripts/check.sh after section 39, whose completed deal
# ($S39_DEAL, 5000 cash + 6324 credit) and seller ($S39_SELLER) it reuses.
# -----------------------------------------------------------------------

S40_DIR="$TMP_DIR/s40"
mkdir -p "$S40_DIR"
s40_get() { # $1 token, $2 path -> status; body in last.json
  curl -s -o "$S40_DIR/last.json" -w '%{http_code}' "$BASE$2" -H "Authorization: $1"
}

# --- 40a. The queue collection is superuser only --------------------------
S40_SCHEMA="$(curl -s "$BASE/api/collections/epos_credit_queue" -H "Authorization: $SUPER_TOKEN")"
[ "$(echo "$S40_SCHEMA" | jval name)" = "epos_credit_queue" ] || fail "40a: epos_credit_queue missing"
for rule in listRule viewRule createRule updateRule deleteRule; do
  [ "$(echo "$S40_SCHEMA" | jval "$rule")" = "" ] || fail "40a: epos_credit_queue.$rule is not null"
done
[ "$(s40_get "$STAFF_TOKEN" "/api/collections/epos_credit_queue/records")" = "403" ] \
  || fail "40a: staff could list epos_credit_queue: $(cat "$S40_DIR/last.json")"
ok "40a: epos_credit_queue exists and is superuser only"

# --- 40b. Section 39's completion queued one pending row -----------------
S40_ROWS="$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=trade_in = '$S39_DEAL'" \
  "$BASE/api/collections/epos_credit_queue/records")"
[ "$(echo "$S40_ROWS" | jval totalItems)" = "1" ] || fail "40b: expected one queue row: $S40_ROWS"
[ "$(echo "$S40_ROWS" | jval items.0.amount)" = "6324" ] || fail "40b: amount $(echo "$S40_ROWS" | jval items.0.amount)"
[ "$(echo "$S40_ROWS" | jval items.0.status)" = "pending" ] || fail "40b: status $(echo "$S40_ROWS" | jval items.0.status)"
[ "$(echo "$S40_ROWS" | jval items.0.customer)" = "$S39_SELLER" ] || fail "40b: customer"
S40_ROW="$(echo "$S40_ROWS" | jval items.0.id)"
ok "40b: a deal completed with £63.24 credit queued one pending row of 6324"

# A second row for the same deal is refused by the unique index.
S40_DUP="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/epos_credit_queue/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$S39_DEAL\",\"customer\":\"$S39_SELLER\",\"amount\":6324,\"status\":\"pending\"}")"
[ "$S40_DUP" = "400" ] || fail "40b: a second queue row for the same deal returned $S40_DUP, expected 400"
ok "40b: a deal cannot be queued twice"

# --- 40c. The status route --------------------------------------------------
[ "$(s40_get "$STAFF_TOKEN" "/api/vault/deals/$S39_DEAL/epos-credit")" = "200" ] \
  || fail "40c: epos-credit: $(cat "$S40_DIR/last.json")"
[ "$(jval epos_credit.status <"$S40_DIR/last.json")" = "pending" ] || fail "40c: status"
[ "$(jval epos_credit.synced <"$S40_DIR/last.json")" = "false" ] || fail "40c: synced"
[ "$(jval epos_credit.message <"$S40_DIR/last.json")" = "Waiting to sync £63.24 to Epos Now." ] \
  || fail "40c: message '$(jval epos_credit.message <"$S40_DIR/last.json")'"

curl -s -o /dev/null -X PATCH "$BASE/api/collections/epos_credit_queue/records/$S40_ROW" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"done","epos_customer_id":42,"epos_balance_after":7324,"sent_at":"2026-11-09 15:00:00.000Z"}'
s40_get "$STAFF_TOKEN" "/api/vault/deals/$S39_DEAL/epos-credit" >/dev/null
[ "$(jval epos_credit.message <"$S40_DIR/last.json")" = "Credit added to Epos Now: £63.24" ] \
  || fail "40c: done message '$(jval epos_credit.message <"$S40_DIR/last.json")'"
[ "$(jval epos_credit.epos_balance_after <"$S40_DIR/last.json")" = "7324" ] || fail "40c: balance after"
[ "$(s40_get "$STAFF_TOKEN" "/api/vault/deals/nosuchdeal00000/epos-credit")" = "404" ] || fail "40c: unknown deal not 404"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/deals/$S39_DEAL/epos-credit")" = "401" ] \
  || fail "40c: no token was not 401"
ok "40c: GET /api/vault/deals/{id}/epos-credit reports waiting, then added, to staff only"

# --- 40d. A cash-only deal queues nothing ----------------------------------
S40_BODY="{\"customer\":\"$S39_SELLER\",\"status\":\"draft\",\"trade_pct\":80,\"cash_pct\":70}"
S40_DEAL="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d "$S40_BODY" | jval id)"
[ -n "$S40_DEAL" ] || fail "40d: could not create a deal"
curl -s -o /dev/null -X POST "$BASE/api/collections/trade_in_lines/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$S40_DEAL\",\"kind\":\"single\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Cash card\",\"condition\":\"NM\",\"qty\":1,\"market_price\":1000,\"market_source\":\"uk_sold_manual\",\"market_currency\":\"GBP\",\"accepted\":true}"
S40_STATUS="$(curl -s -o "$S40_DIR/cash.json" -w '%{http_code}' -X POST "$BASE/api/vault/deals/$S40_DEAL/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"cash_taken":700,"credit_given":0,"terms_accepted":true}')"
[ "$S40_STATUS" = "200" ] || fail "40d: cash-only completion: $(cat "$S40_DIR/cash.json")"
[ "$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=trade_in = '$S40_DEAL'" \
  "$BASE/api/collections/epos_credit_queue/records" | jval totalItems)" = "0" ] || fail "40d: a cash-only deal was queued"
s40_get "$STAFF_TOKEN" "/api/vault/deals/$S40_DEAL/epos-credit" >/dev/null
[ "$(jval epos_credit.status <"$S40_DIR/last.json")" = "none" ] || fail "40d: status for a cash-only deal"
ok "40d: a cash-only deal queues nothing and reports none"

# --- 40e. A refused completion queues nothing ------------------------------
S40_COUNT_BEFORE="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/epos_credit_queue/records" | jval totalItems)"
curl -s -o /dev/null -X POST "$BASE/api/vault/deals/$S39_DEAL/complete" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d '{"cash_taken":0,"credit_given":12000,"terms_accepted":true}'
[ "$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/epos_credit_queue/records" | jval totalItems)" = "$S40_COUNT_BEFORE" ] \
  || fail "40e: a refused completion queued a row"
ok "40e: a refused completion queues nothing"

# --- 40f. epos_customer_id on customers, staff-set only --------------------
S40_CUST_STATUS="$(curl -s -o "$S40_DIR/cust.json" -w '%{http_code}' -X PATCH "$BASE/api/collections/customers/records/$S39_SELLER" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"epos_customer_id":42}')"
[ "$S40_CUST_STATUS" = "200" ] && [ "$(jval epos_customer_id <"$S40_DIR/cust.json")" = "42" ] \
  || fail "40f: staff could not set epos_customer_id: $(cat "$S40_DIR/cust.json")"
S40_RULE="$(curl -s "$BASE/api/collections/customers" -H "Authorization: $SUPER_TOKEN" | jval updateRule)"
case "$S40_RULE" in
  *"@request.body.epos_customer_id:isset = false"*) ;;
  *) fail "40f: customers.updateRule does not stop a customer setting epos_customer_id: $S40_RULE" ;;
esac
ok "40f: staff can link a customer to Epos Now, a customer cannot change their own link"
