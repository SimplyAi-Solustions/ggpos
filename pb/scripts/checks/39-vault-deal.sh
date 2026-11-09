# shellcheck shell=bash
# -----------------------------------------------------------------------
# 39. The Vault deal calculator (docs/vault-rebuild-api.md, "Deals"):
#     the new trade_ins / trade_in_lines fields, the server-stamped final
#     overrides, per-line rates (null means the sweep), all priced by the
#     canonical packages/shared/src/deal.ts, GET /api/vault/deals,
#     and POST /api/vault/deals/{id}/complete without a till session: items
#     booked in, the split recorded, the ID gate on any cash, no cash
#     movement, credit ledger, points or session link.
#
# Sourced by pb/scripts/check.sh after every earlier section; shares $BASE,
# $SUPER_TOKEN, $STAFF_TOKEN, $GAME_ID, $TMP_DIR and the ok/fail/jval helpers.
# -----------------------------------------------------------------------

S39_DIR="$TMP_DIR/s39"
mkdir -p "$S39_DIR"

s39_req() { # $1 method, $2 path, [$3 JSON body] -> status; body in last.json
  local data=()
  if [ -n "${3:-}" ]; then data=(-d "$3"); fi
  curl -s -o "$S39_DIR/last.json" -w '%{http_code}' -X "$1" "$BASE$2" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" ${data[@]+"${data[@]}"}
}
s39_field() { jval "$1" <"$S39_DIR/last.json"; }
s39_count() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" "$BASE/api/collections/$1/records" | jval totalItems
}

S39_STAFF_ID="$(curl -s "$BASE/api/collections/staff/auth-refresh" -X POST -H "Authorization: $STAFF_TOKEN" | jval record.id)"
[ -n "$S39_STAFF_ID" ] || fail "39: could not read the staff id"

# A Guild member, so points would be earned on the old route.
[ "$(s39_req POST /api/collections/customers/records '{"name":"Deal Seller","source":"counter","guild_joined_at":"2026-01-01 00:00:00.000Z"}')" = "200" ] \
  || fail "39: could not create the seller: $(cat "$S39_DIR/last.json")"
S39_SELLER="$(s39_field id)"

# --- 39a. A deal with sweep rates and a server-stamped override --------
S39_BODY="{\"customer\":\"$S39_SELLER\",\"status\":\"draft\",\"trade_pct\":80,\"cash_pct\":70,\"override_by\":\"someoneelse\"}"
[ "$(s39_req POST /api/collections/trade_ins/records "$S39_BODY")" = "200" ] \
  || fail "39a: could not create a deal: $(cat "$S39_DIR/last.json")"
S39_DEAL="$(s39_field id)"
[ -z "$(s39_field override_by)" ] || fail "39a: override_by was taken from the body"
ok "39a: a draft deal stores trade_pct and cash_pct, and ignores a client override_by"

# Lines: one single at £100 on the sweep, two at £25.50 with a 90% trade rate.
S39_BODY="{\"trade_in\":\"$S39_DEAL\",\"kind\":\"single\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Deal card A\",\"condition\":\"NM\",\"qty\":1,\"market_price\":10000,\"market_source\":\"uk_sold_manual\",\"market_currency\":\"GBP\",\"accepted\":true,\"trade_pct\":null}"
[ "$(s39_req POST /api/collections/trade_in_lines/records "$S39_BODY")" = "200" ] \
  || fail "39a: line 1: $(cat "$S39_DIR/last.json")"
S39_BODY="{\"trade_in\":\"$S39_DEAL\",\"kind\":\"single\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Deal card B\",\"condition\":\"LP\",\"qty\":2,\"market_price\":2550,\"market_source\":\"cardmarket\",\"market_currency\":\"GBP\",\"accepted\":true,\"trade_pct\":90}"
[ "$(s39_req POST /api/collections/trade_in_lines/records "$S39_BODY")" = "200" ] \
  || fail "39a: line 2: $(cat "$S39_DIR/last.json")"
S39_LINE2="$(s39_field id)"
[ "$(s39_req PATCH "/api/collections/trade_in_lines/records/$S39_LINE2" '{"cash_pct":250}')" = "400" ] \
  || fail "39a: a 250% line rate was not refused"
ok "39a: per-line rates take null or a percent, and 250 is refused"

# trade: 8000 + 2295 x 2 = 12590; cash: 7000 + 1785 x 2 = 10570
[ "$(s39_req GET "/api/vault/deals/$S39_DEAL")" = "200" ] || fail "39b: GET deal: $(cat "$S39_DIR/last.json")"
[ "$(s39_field deal.trade_total)" = "12590" ] || fail "39b: trade_total $(s39_field deal.trade_total), expected 12590"
[ "$(s39_field deal.cash_total)" = "10570" ] || fail "39b: cash_total $(s39_field deal.cash_total), expected 10570"
[ "$(s39_field deal.lines.1.trade_custom)" = "true" ] || fail "39b: line 2 not marked trade_custom"
ok "39b: GET /api/vault/deals/{id} prices the sweep and the per-line rate"

# A final trade override of £120: stamped with who and when.
[ "$(s39_req PATCH "/api/collections/trade_ins/records/$S39_DEAL" '{"trade_override_kind":"amount","trade_override_pence":12000,"override_reason":"Round number"}')" = "200" ] \
  || fail "39c: override: $(cat "$S39_DIR/last.json")"
[ "$(s39_field override_by)" = "$S39_STAFF_ID" ] || fail "39c: override_by '$(s39_field override_by)', expected $S39_STAFF_ID"
[ -n "$(s39_field override_at)" ] || fail "39c: override_at not stamped"
s39_req GET "/api/vault/deals/$S39_DEAL" >/dev/null
[ "$(s39_field deal.trade_total)" = "12000" ] || fail "39c: overridden trade_total $(s39_field deal.trade_total)"
# The canonical overrides are per side: the cash side stays as calculated.
[ "$(s39_field deal.cash_total)" = "10570" ] || fail "39c: cash_total $(s39_field deal.cash_total), expected 10570"
[ "$(s39_field deal.calculated_trade)" = "12590" ] || fail "39c: calculated_trade $(s39_field deal.calculated_trade)"
[ "$(s39_field deal.overrides.trade.pence)" = "12000" ] || fail "39c: overrides.trade not reported"
ok "39c: a trade override is stamped by the server and leaves the cash side as calculated"

# A cash override as a percentage of market: 60% of 15100 = 9060. Then clear it.
[ "$(s39_req PATCH "/api/collections/trade_ins/records/$S39_DEAL" '{"cash_override_kind":"pct","cash_override_pct":60}')" = "200" ] \
  || fail "39c: cash pct override: $(cat "$S39_DIR/last.json")"
s39_req GET "/api/vault/deals/$S39_DEAL" >/dev/null
[ "$(s39_field deal.cash_total)" = "9060" ] || fail "39c: cash pct override gave $(s39_field deal.cash_total), expected 9060"
[ "$(s39_field deal.trade_total)" = "12000" ] || fail "39c: the trade side moved with the cash override"
[ "$(s39_req PATCH "/api/collections/trade_ins/records/$S39_DEAL" '{"cash_override_kind":""}')" = "200" ] \
  || fail "39c: clearing the cash override: $(cat "$S39_DIR/last.json")"
[ "$(s39_field cash_override_pct)" = "0" ] || fail "39c: clearing the cash override left its pct"
[ "$(s39_field override_by)" = "$S39_STAFF_ID" ] || fail "39c: clearing one side dropped override_by while the other is set"
ok "39c: the cash side takes a pct override on its own, and clearing it leaves the trade override"

# --- 39d. Refusals -------------------------------------------------------
S39_SESSIONS_BEFORE="$(s39_count cash_movements "id != ''")"
S39_CREDIT_BEFORE="$(s39_count credit_ledger "customer = '$S39_SELLER'")"
S39_POINTS_BEFORE="$(s39_count points_ledger "customer = '$S39_SELLER'")"

[ "$(s39_req POST "/api/vault/deals/$S39_DEAL/complete" '{"cash_taken":5000,"credit_given":9000,"terms_accepted":true}')" = "400" ] \
  || fail "39d: a split that does not add up was not refused: $(cat "$S39_DIR/last.json")"
# 5000 cash leaves 12000 x (10570 - 5000) / 10570 = 6323.56 -> 6324 credit (splitDeal)
[ "$(s39_req POST "/api/vault/deals/$S39_DEAL/complete" '{"cash_taken":5000,"credit_given":6324,"terms_accepted":true}')" = "422" ] \
  || fail "39d: cash with no ID on file was not refused with 422: $(cat "$S39_DIR/last.json")"
case "$(s39_field message)" in
  *ID*|*address*) ;;
  *) fail "39d: cash refusal did not mention the ID: $(s39_field message)" ;;
esac
[ "$(s39_req POST "/api/vault/deals/$S39_DEAL/complete" '{"cash_taken":0,"credit_given":12000}')" = "422" ] \
  || fail "39d: completing without terms was not refused"
ok "39d: a wrong split, cash without ID on file and missing terms are refused"

# --- 39e. ID on file, then a part-cash, part-credit completion ---------
S39_ID_JSON="$(curl -s -X POST "$BASE/api/vault/customers/$S39_SELLER/id-check" \
  -H "Authorization: $STAFF_TOKEN" \
  -F "photo=@$TMP_DIR/id.png;type=image/png" -F "id_type=passport" -F "id_expiry=2030-06-30" \
  -F "id_ref_last4=4321" -F "dob=1985-03-03" -F "address=2 Cavendish Walk, Bolsover")"
[ -n "$(echo "$S39_ID_JSON" | jval id_document)" ] || fail "39e: id-check failed: $S39_ID_JSON"

[ "$(s39_req POST "/api/vault/deals/$S39_DEAL/complete" '{"cash_taken":5000,"credit_given":6324,"terms_accepted":true}')" = "200" ] \
  || fail "39e: completing the deal: $(cat "$S39_DIR/last.json")"
cp "$S39_DIR/last.json" "$S39_DIR/done.json"
[ "$(s39_field trade_in.payout_type)" = "mixed" ] || fail "39e: payout_type $(s39_field trade_in.payout_type)"
[ -n "$(s39_field trade_in.number)" ] || fail "39e: no number"
[ -n "$(s39_field items.2.sku)" ] && [ -z "$(s39_field items.3.sku)" ] || fail "39e: expected 3 items: $(cat "$S39_DIR/last.json")"
ok "39e: the deal completed with no till session as $(s39_field trade_in.number), three items booked in"

S39_TI="$(curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/trade_ins/records/$S39_DEAL")"
[ "$(echo "$S39_TI" | jval payout_cash)" = "5000" ] || fail "39f: payout_cash"
[ "$(echo "$S39_TI" | jval payout_credit)" = "6324" ] || fail "39f: payout_credit"
[ "$(echo "$S39_TI" | jval deal_trade_total)" = "12000" ] || fail "39f: deal_trade_total"
[ "$(echo "$S39_TI" | jval deal_cash_total)" = "10570" ] || fail "39f: deal_cash_total"
[ "$(echo "$S39_TI" | jval calculated_trade)" = "12590" ] || fail "39f: calculated_trade"
[ "$(echo "$S39_TI" | jval calculated_cash)" = "10570" ] || fail "39f: calculated_cash"
[ "$(echo "$S39_TI" | jval id_checked)" = "true" ] || fail "39f: id_checked not set"
[ -n "$(echo "$S39_TI" | jval id_document)" ] || fail "39f: id_document not linked"
[ -z "$(echo "$S39_TI" | jval cash_session)" ] || fail "39f: a cash session was linked"
ok "39f: the split, deal totals, override snapshot and ID check are on the trade-in, with no cash session"

[ "$(s39_count cash_movements "id != ''")" = "$S39_SESSIONS_BEFORE" ] || fail "39g: a cash movement was written"
[ "$(s39_count credit_ledger "customer = '$S39_SELLER'")" = "$S39_CREDIT_BEFORE" ] || fail "39g: a credit ledger row was written"
[ "$(s39_count points_ledger "customer = '$S39_SELLER'")" = "$S39_POINTS_BEFORE" ] || fail "39g: points were written"
ok "39g: no cash movement, credit ledger or points rows"

# Item costs sum to what was paid, 5000 + 6324 (payoutLines: 7196 + 2 x 2064).
S39_COST="$(curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=trade_in_line.trade_in = '$S39_DEAL'" \
  "$BASE/api/collections/items/records" | node -e '
  let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
    const j=JSON.parse(d); process.stdout.write(String(j.items.reduce((s,i)=>s+i.cost*i.qty,0)));});')"
[ "$S39_COST" = "11324" ] || fail "39h: item costs sum to $S39_COST, expected 11324"
[ "$(s39_count audit_log "action = 'vault_deal_complete' && record = '$S39_DEAL'")" = "1" ] || fail "39h: no audit row"
ok "39h: item costs add up to what was paid, and the completion is audited"

[ "$(s39_req POST "/api/vault/deals/$S39_DEAL/complete" '{"cash_taken":0,"credit_given":12000,"terms_accepted":true}')" = "409" ] \
  || fail "39i: completing twice was not refused with 409"
ok "39i: a completed deal cannot be completed again"

# --- 39j. All credit on a fresh deal, no ID needed ---------------------
s39_req POST /api/collections/customers/records '{"name":"Credit Seller","source":"counter"}' >/dev/null
S39_SELLER2="$(s39_field id)"
s39_req POST /api/collections/trade_ins/records "{\"customer\":\"$S39_SELLER2\",\"status\":\"draft\"}" >/dev/null
S39_DEAL2="$(s39_field id)"
s39_req POST /api/collections/trade_in_lines/records "{\"trade_in\":\"$S39_DEAL2\",\"kind\":\"sealed\",\"game\":\"$GAME_ID\",\"free_text_title\":\"Booster box\",\"qty\":3,\"market_price\":9000,\"accepted\":true}" >/dev/null
# default 80%: 7200 x 3 = 21600
[ "$(s39_req POST "/api/vault/deals/$S39_DEAL2/complete" '{"cash_taken":0,"credit_given":21600,"terms_accepted":true}')" = "200" ] \
  || fail "39j: all-credit completion: $(cat "$S39_DIR/last.json")"
[ "$(s39_field trade_in.payout_type)" = "credit" ] || fail "39j: payout_type"
[ -z "$(s39_field items.1.sku)" ] || fail "39j: a sealed line of 3 should be one stock row"
ok "39j: an all-credit deal at the default 80% completes with no ID and no session"
