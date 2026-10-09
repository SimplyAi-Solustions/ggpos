# shellcheck shell=bash
# -----------------------------------------------------------------------
# 28. Till sessions, cashing up and the drawer (docs/api-contract-epos.md,
#     section 3): pb_hooks/till.pb.js, pb_hooks/lib/till.js and the shared
#     buildTillReport (packages/shared/src/till.ts).
#
# Sourced by check.sh into its own shell: $BASE, $SUPER_TOKEN, $STAFF_TOKEN,
# $TMP_DIR and the ok/fail/jval/jlen helpers are check.sh's. Everything here
# runs on three registers of its own, so the default register's session that
# earlier sections leave open is never touched, and the registers are
# switched off again at the end.
#
# Sales, sale lines and tender rows are written straight through the
# collection API as the superuser: the sale route that writes them belongs
# to another package, and what is being checked here is that the report
# adds up whatever the records say.
# -----------------------------------------------------------------------

T28_OUT="$TMP_DIR/t28.json"
T28_PASSWORD="till-check-password-28"

# t28_req METHOD PATH TOKEN [JSON BODY] [EXTRA HEADER]: the response body
# lands in $T28_OUT and the status code is printed.
t28_req() {
  local method="$1" path="$2" token="$3" body="${4:-}" header="${5:-}"
  local args=(-s -o "$T28_OUT" -w '%{http_code}' -X "$method" "$BASE$path")
  if [ -n "$token" ]; then args+=(-H "Authorization: $token"); fi
  if [ -n "$header" ]; then args+=(-H "$header"); fi
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  curl "${args[@]}"
}

# A value off the last response.
t28_val() { jval "$1" <"$T28_OUT"; }

# t28_status GOT WANT WHAT
t28_status() {
  [ "$1" = "$2" ] || fail "$3: status $1, wanted $2: $(cat "$T28_OUT")"
}

# t28_is PATH WANT WHAT: one value off the last response.
t28_is() {
  local got
  got="$(t28_val "$1")"
  [ "$got" = "$2" ] || fail "$3: $1 is '$got', wanted '$2': $(cat "$T28_OUT")"
}

# t28_refused STATUS WANT_STATUS MESSAGE WHAT: a refusal, in the contract's words.
t28_refused() {
  t28_status "$1" "$2" "$4"
  t28_is message "$3" "$4"
}

# t28_needs_override STATUS CAPABILITY WHAT: the 403 the counter asks for a PIN on.
t28_needs_override() {
  t28_status "$1" "403" "$3"
  t28_is message "A manager needs to approve this." "$3"
  t28_is needs_override "true" "$3"
  t28_is capability "$2" "$3"
}

# t28_match PATH WANT_JSON WHAT: every key in WANT_JSON matches the value at
# PATH in the last response. Objects are compared key by key (so the
# response may carry more), arrays and scalars whole.
t28_match() {
  node -e '
    const fs = require("fs");
    const [file, path, wantText] = process.argv.slice(1);
    let got = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of path.split(".").filter(Boolean)) got = got == null ? undefined : got[k];
    const canon = (v) =>
      Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
      : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
      : JSON.stringify(v === undefined ? null : v);
    const problems = [];
    const walk = (w, g, at) => {
      if (w && typeof w === "object" && !Array.isArray(w)) {
        if (!g || typeof g !== "object") return problems.push(at + ": wanted an object, got " + canon(g));
        for (const k of Object.keys(w)) walk(w[k], g[k], at + "." + k);
        return;
      }
      if (canon(w) !== canon(g)) problems.push(at + ": wanted " + canon(w) + ", got " + canon(g));
    };
    walk(JSON.parse(wantText), got, path || "$");
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  ' "$T28_OUT" "$1" "$2" || fail "$3"
}

# t28_create COLLECTION JSON: a row written as the superuser; prints its id.
t28_create() {
  local id
  id="$(curl -s -X POST "$BASE/api/collections/$1/records" -H "Authorization: $SUPER_TOKEN" \
    -H "Content-Type: application/json" -d "$2" | tee "$TMP_DIR/t28-create.json" | jval id)"
  [ -n "$id" ] || fail "could not create a $1 row: $(cat "$TMP_DIR/t28-create.json")"
  echo "$id"
}

# t28_rows COLLECTION FILTER: list rows as the superuser.
t28_rows() {
  curl -s -G "$BASE/api/collections/$1/records" -H "Authorization: $SUPER_TOKEN" \
    --data-urlencode "filter=$2" --data-urlencode "perPage=200" --data-urlencode "sort=created"
}

# t28_audit ACTION RECORD: the audit_log rows for one action on one record.
t28_audit() {
  t28_rows audit_log "action = \"$1\" && record = \"$2\""
}

t28_signin() {
  curl -s -X POST "$BASE/api/collections/staff/auth-with-password" -H "Content-Type: application/json" \
    -d "{\"identity\":\"$1\",\"password\":\"$T28_PASSWORD\"}" | jval token
}

# --- 28a. A member of staff, a manager and three tills -------------------
T28_STAFF_ID="$(t28_create staff "{\"email\":\"till-staff-28@local.test\",\"password\":\"$T28_PASSWORD\",\"passwordConfirm\":\"$T28_PASSWORD\",\"name\":\"Till Staff 28\",\"role\":\"staff\",\"active\":true}")"
T28_MANAGER_ID="$(t28_create staff "{\"email\":\"till-manager-28@local.test\",\"password\":\"$T28_PASSWORD\",\"passwordConfirm\":\"$T28_PASSWORD\",\"name\":\"Till Manager 28\",\"role\":\"manager\",\"active\":true}")"
T28_STAFF="$(t28_signin till-staff-28@local.test)"
T28_MANAGER="$(t28_signin till-manager-28@local.test)"
[ -n "$T28_STAFF" ] && [ -n "$T28_MANAGER" ] || fail "the till check's staff member and manager could not sign in"

# Sorted after the seeded Counter, so the default register stays as it was.
T28_R1="$(t28_create registers '{"name":"Check Till 28","active":true,"sort":281}')"
T28_R2="$(t28_create registers '{"name":"Check Till 28B","active":true,"sort":282}')"
T28_R3="$(t28_create registers '{"name":"Check Till 28C","active":true,"sort":283}')"
T28_DEFAULT_ID="$(curl -s -G "$BASE/api/collections/registers/records" -H "Authorization: $STAFF_TOKEN" \
  --data-urlencode "filter=active = true" --data-urlencode "sort=sort,created" --data-urlencode "perPage=1" | jval items.0.id)"
T28_DEFAULT_NAME="$(curl -s "$BASE/api/collections/registers/records/$T28_DEFAULT_ID" -H "Authorization: $STAFF_TOKEN" | jval name)"
[ -n "$T28_DEFAULT_ID" ] || fail "no default register to compare against"
ok "the till check has a member of staff, a manager and three tills of its own"

# --- 28b. Opening the till -------------------------------------------------
# 2 x £20, 3 x £10, 2 x £5, 5 x £1, 3 x 1p = £85.03
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" \
  "{\"register\":\"$T28_R1\",\"counts\":{\"2000\":2,\"1000\":3,\"500\":2,\"100\":5,\"1\":3},\"float\":99999}")"
t28_status "$T28_STATUS" 201 "opening the till with a count"
T28_S1="$(t28_val session.id)"
t28_match session "{\"register\":{\"id\":\"$T28_R1\",\"name\":\"Check Till 28\"},\"opened_by\":{\"id\":\"$T28_STAFF_ID\",\"name\":\"Till Staff 28\"},\"float\":8503,\"opening_counts\":{\"2000\":2,\"1000\":3,\"500\":2,\"100\":5,\"1\":3}}" \
  "the till opened with a count should take its float from the count"
T28_OPENED_AT="$(t28_val session.opened_at)"
[[ "$T28_OPENED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$ ]] || fail "opened_at '$T28_OPENED_AT' is not ISO 8601"
T28_AUDIT="$(t28_audit till_open "$T28_S1")"
[ "$(echo "$T28_AUDIT" | jval items.0.meta.float)" = "8503" ] && [ "$(echo "$T28_AUDIT" | jval items.0.meta.counted)" = "true" ] \
  || fail "opening the till left no till_open audit row with its float: $T28_AUDIT"
ok "the till opens with its float from the count (£85.03), the float field ignored, and is audited"

T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R1\",\"float\":1000}")"
t28_refused "$T28_STATUS" 409 "The till is already open. Close it with a Z report first." "a second open on the same till"
ok "a second open on the same till is refused with 409"

T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R2\",\"counts\":{\"300\":1}}")"
t28_refused "$T28_STATUS" 400 "The count has a note or coin that is not UK money. Count the drawer again." "a count with a coin that does not exist"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R2\",\"counts\":{\"1000\":-1}}")"
t28_refused "$T28_STATUS" 400 "Count each note and coin as a whole number, 0 or more." "a negative count"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R2\",\"float\":-500}")"
t28_refused "$T28_STATUS" 400 "Enter the float as a whole number of pence, 0 or more." "a negative float"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R2\",\"float\":12.5}")"
t28_refused "$T28_STATUS" 400 "Enter the float as a whole number of pence, 0 or more." "a float in fractions of a penny"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" '{"register":"nosuchregister1","float":1000}')"
t28_refused "$T28_STATUS" 404 "That register was not found." "opening a till that does not exist"
ok "a bad count, a negative or fractional float and an unknown till are refused"

T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R2\",\"float\":5000}")"
t28_status "$T28_STATUS" 201 "opening the second till with a float"
T28_S2="$(t28_val session.id)"
t28_is session.float 5000 "the second till's float"
t28_is session.opening_counts "" "the second till's opening count"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R3\",\"counts\":{}}")"
t28_status "$T28_STATUS" 201 "opening the third till with neither a count nor a float"
T28_S3="$(t28_val session.id)"
t28_is session.float 0 "a till opened with neither a count nor a float"
ok "a till opens with a float alone, and with neither a count nor a float the float is £0.00"

# --- 28c. The till as it stands --------------------------------------------
T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R1" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the current till"
t28_match "" "{\"register\":{\"id\":\"$T28_R1\",\"name\":\"Check Till 28\"},\"session\":{\"id\":\"$T28_S1\",\"float\":8503},\"running\":{\"id\":\"\",\"type\":\"x\",\"number\":0,\"session_id\":\"$T28_S1\",\"created_by\":{\"id\":\"$T28_STAFF_ID\",\"name\":\"Till Staff 28\"},\"sales\":{\"count\":0,\"net\":0},\"cash\":{\"opening_float\":8503,\"expected\":8503,\"counted\":null},\"counts\":null}}" \
  "the current till should carry its session and an unnumbered running report"
ok "the current till carries its session and a running report, numbered 0 and unsaved"

T28_STATUS="$(t28_req GET /api/vault/till/current "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the current till with no register named"
t28_is register.id "$T28_DEFAULT_ID" "the current till with no register named"
t28_is register.name "$T28_DEFAULT_NAME" "the current till with no register named"
T28_STATUS="$(t28_req GET "/api/vault/till/current?register=nosuchregister1" "$T28_STAFF")"
t28_refused "$T28_STATUS" 404 "That register was not found." "the current till of a register that does not exist"
T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R1" "")"
[ "$T28_STATUS" = "401" ] || fail "the current till without a token returned $T28_STATUS, wanted 401"
ok "with no register named the till is the default register's; an unknown one is 404 and no token is 401"

# --- 28d. X reports, numbered ----------------------------------------------
T28_STATUS="$(t28_req POST /api/vault/till/x "$T28_STAFF" "{\"register\":\"$T28_R1\"}")"
t28_status "$T28_STATUS" 201 "the first X report"
T28_X1="$(t28_val report.id)"
T28_X1_NUMBER="$(t28_val report.number)"
[ -n "$T28_X1" ] && [ "$T28_X1_NUMBER" -ge 1 ] || fail "the X report has no id or number: $(cat "$T28_OUT")"
t28_match report "{\"type\":\"x\",\"register\":{\"id\":\"$T28_R1\"},\"session_id\":\"$T28_S1\",\"cash\":{\"expected\":8503,\"counted\":null,\"variance\":null},\"counts\":null}" \
  "the first X report"
T28_STATUS="$(t28_req POST /api/vault/till/x "$T28_STAFF" "{\"register\":\"$T28_R1\"}")"
t28_status "$T28_STATUS" 201 "the second X report"
T28_X2_NUMBER="$(t28_val report.number)"
[ "$T28_X2_NUMBER" = "$((T28_X1_NUMBER + 1))" ] || fail "the second X report is number $T28_X2_NUMBER, wanted $((T28_X1_NUMBER + 1))"
T28_STATUS="$(t28_req GET "/api/collections/till_reports/records/$T28_X1" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "reading a saved X report through the collection API"
t28_is type x "the saved X report"
t28_is number "$T28_X1_NUMBER" "the saved X report"
t28_is data.id "$T28_X1" "the saved X report's own data"
[ "$(t28_audit till_x_report "$T28_X1" | jval items.0.meta.number)" = "$T28_X1_NUMBER" ] \
  || fail "the X report left no till_x_report audit row"
ok "X reports are saved and numbered in sequence ($T28_X1_NUMBER, $T28_X2_NUMBER), and audited"

# --- 28e. Paid in, paid out, bank drops and adjustments --------------------
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_in\",\"amount\":1500,\"reason\":\"Change from the bank\"}")"
t28_status "$T28_STATUS" 201 "a paid in"
t28_match "" "{\"movement\":{\"type\":\"paid_in\",\"amount\":1500,\"reason\":\"Change from the bank\",\"session\":\"$T28_S1\",\"register\":\"$T28_R1\",\"staff\":{\"id\":\"$T28_MANAGER_ID\",\"name\":\"Till Manager 28\"},\"approver\":null},\"print_job\":null}" \
  "a paid in"
T28_PAID_IN="$(t28_val movement.id)"
[ "$(t28_audit cash_paid_in "$T28_PAID_IN" | jval items.0.meta.amount)" = "1500" ] || fail "a paid in left no cash_paid_in audit row"

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":640,\"reason\":\"Milk\"}")"
t28_status "$T28_STATUS" 201 "a paid out"
t28_is movement.amount -640 "a paid out is stored negative"
[ "$(t28_audit cash_paid_out "$(t28_val movement.id)" | jval items.0.meta.amount)" = "-640" ] || fail "a paid out left no cash_paid_out audit row"

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"bank_drop\",\"amount\":5000,\"reason\":\"Midday drop\"}")"
t28_status "$T28_STATUS" 201 "a bank drop"
t28_is movement.amount -5000 "a bank drop is stored negative"
[ "$(t28_audit cash_bank_drop "$(t28_val movement.id)" | jval items.0.meta.amount)" = "-5000" ] || fail "a bank drop left no cash_bank_drop audit row"

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"adjustment\",\"amount\":-15,\"reason\":\"Miscounted the float\"}")"
t28_status "$T28_STATUS" 201 "a negative adjustment"
t28_is movement.amount -15 "an adjustment keeps its sign"
t28_is print_job "" "an adjustment does not open the drawer"
[ "$(t28_audit cash_adjustment "$(t28_val movement.id)" | jval items.0.meta.amount)" = "-15" ] || fail "an adjustment left no cash_adjustment audit row"
ok "paid in, paid out, a bank drop and an adjustment are stored signed, with the reason, and audited"

# 8503 + 1500 - 640 - 5000 - 15 = 4348
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":4349,\"reason\":\"Window cleaner\"}")"
t28_refused "$T28_STATUS" 409 "That is more than the £43.48 the drawer should hold." "a paid out of more than the drawer holds"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"bank_drop\",\"amount\":4349,\"reason\":\"Drop\"}")"
t28_refused "$T28_STATUS" 409 "That is more than the £43.48 the drawer should hold." "a bank drop of more than the drawer holds"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":200}")"
t28_refused "$T28_STATUS" 400 "Say what the money was for." "a paid out with no reason"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":200,\"reason\":\"   \"}")"
t28_refused "$T28_STATUS" 400 "Say what the money was for." "a paid out with a blank reason"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"cash_sale\",\"amount\":200,\"reason\":\"x\"}")"
t28_refused "$T28_STATUS" 400 "Choose paid in, paid out, bank drop or adjustment." "a movement of a type the till does not take"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_in\",\"amount\":0,\"reason\":\"x\"}")"
t28_refused "$T28_STATUS" 400 "Enter an amount above £0.00, in pence." "a paid in of nothing"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":-200,\"reason\":\"x\"}")"
t28_refused "$T28_STATUS" 400 "Enter an amount above £0.00, in pence." "a negative paid out"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"adjustment\",\"amount\":0,\"reason\":\"x\"}")"
t28_refused "$T28_STATUS" 400 "Enter the adjustment in pence, above or below £0.00." "an adjustment of nothing"
ok "money out past the drawer, a missing reason, an unknown type and an amount of nothing are refused"

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_STAFF" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":100,\"reason\":\"Stamps\"}")"
t28_needs_override "$T28_STATUS" paid_in_out "a member of staff paying out"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_STAFF" "{\"register\":\"$T28_R1\",\"type\":\"adjustment\",\"amount\":10,\"reason\":\"Found 10p\"}")"
t28_needs_override "$T28_STATUS" z_report "a member of staff adjusting the drawer"
ok "a member of staff is asked for a manager's approval to pay out (paid_in_out) and to adjust (z_report)"

# A manager's approval, as POST /api/vault/till/override would store it: only
# the sha256 of the token.
T28_TOKEN="t28-override-$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')"
T28_TOKEN_HASH="$(printf '%s' "$T28_TOKEN" | sha256sum | cut -d' ' -f1)"
T28_EXPIRES="$(node -e 'process.stdout.write(new Date(Date.now() + 5 * 60000).toISOString())')"
T28_EXPIRED="$(node -e 'process.stdout.write(new Date(Date.now() - 60000).toISOString())')"
T28_OVERRIDE_ID="$(t28_create till_overrides "{\"token_hash\":\"$T28_TOKEN_HASH\",\"capability\":\"paid_in_out\",\"requested_by\":\"$T28_STAFF_ID\",\"approver\":\"$T28_MANAGER_ID\",\"register\":\"$T28_R1\",\"expires_at\":\"$T28_EXPIRES\",\"context\":{\"amount\":100}}")"
T28_STALE_TOKEN="t28-stale-$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')"
T28_STALE_HASH="$(printf '%s' "$T28_STALE_TOKEN" | sha256sum | cut -d' ' -f1)"
t28_create till_overrides "{\"token_hash\":\"$T28_STALE_HASH\",\"capability\":\"paid_in_out\",\"requested_by\":\"$T28_STAFF_ID\",\"approver\":\"$T28_MANAGER_ID\",\"register\":\"$T28_R1\",\"expires_at\":\"$T28_EXPIRED\"}" >/dev/null

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_STAFF" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":100,\"reason\":\"Stamps\"}" "X-GG-Override: $T28_STALE_TOKEN")"
t28_needs_override "$T28_STATUS" paid_in_out "a member of staff paying out on an expired approval"

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_STAFF" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":100,\"reason\":\"Stamps\"}" "X-GG-Override: $T28_TOKEN")"
t28_status "$T28_STATUS" 201 "a member of staff paying out with a manager's approval"
T28_OVERRIDDEN="$(t28_val movement.id)"
t28_match movement "{\"amount\":-100,\"staff\":{\"id\":\"$T28_STAFF_ID\"},\"approver\":{\"id\":\"$T28_MANAGER_ID\",\"name\":\"Till Manager 28\"}}" \
  "the approved paid out should name both people"
T28_OVERRIDE_ROW="$(curl -s "$BASE/api/collections/till_overrides/records/$T28_OVERRIDE_ID" -H "Authorization: $SUPER_TOKEN")"
[ -n "$(echo "$T28_OVERRIDE_ROW" | jval used_at)" ] || fail "the approval was not marked used: $T28_OVERRIDE_ROW"
T28_USED_FOR="$(echo "$T28_OVERRIDE_ROW" | jval used_for)"
[[ "$T28_USED_FOR" == paid_out:* ]] || fail "the approval does not say what used it: $T28_OVERRIDE_ROW"
T28_EVENTS="$(t28_rows till_events "session = \"$T28_S1\" && kind = \"override\"")"
[ "$(echo "$T28_EVENTS" | jval totalItems)" = "1" ] \
  && [ "$(echo "$T28_EVENTS" | jval items.0.approver)" = "$T28_MANAGER_ID" ] \
  && [ "$(echo "$T28_EVENTS" | jval items.0.staff)" = "$T28_STAFF_ID" ] \
  && [ "$(echo "$T28_EVENTS" | jval items.0.detail.capability)" = "paid_in_out" ] \
  || fail "the approval left no override till event naming both people: $T28_EVENTS"
T28_AUDIT="$(t28_audit cash_paid_out "$T28_OVERRIDDEN")"
[ "$(echo "$T28_AUDIT" | jval items.0.actor)" = "$T28_STAFF_ID" ] \
  && [ "$(echo "$T28_AUDIT" | jval items.0.meta.approvals.0.approver)" = "$T28_MANAGER_ID" ] \
  && [ "$(echo "$T28_AUDIT" | jval items.0.meta.approvals.0.capability)" = "paid_in_out" ] \
  || fail "the approved paid out's audit row does not name both people: $T28_AUDIT"

T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_STAFF" "{\"register\":\"$T28_R1\",\"type\":\"paid_out\",\"amount\":100,\"reason\":\"Stamps again\"}" "X-GG-Override: $T28_TOKEN")"
t28_needs_override "$T28_STATUS" paid_in_out "a second paid out on an approval that was already used"
ok "a manager's approval lets a member of staff pay out once: marked used, an override till event and both names on the audit row"

# --- 28f. No sale and voids ------------------------------------------------
T28_STATUS="$(t28_req POST /api/vault/till/no-sale "$T28_STAFF" "{\"register\":\"$T28_R1\",\"reason\":\"Change for a note\"}")"
t28_needs_override "$T28_STATUS" no_sale "a member of staff opening the drawer"
T28_STATUS="$(t28_req POST /api/vault/till/no-sale "$T28_MANAGER" "{\"register\":\"$T28_R1\"}")"
t28_refused "$T28_STATUS" 400 "Say why the drawer needs opening." "a no sale with no reason"
T28_STATUS="$(t28_req POST /api/vault/till/no-sale "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"reason\":\"Change for a note\"}")"
t28_status "$T28_STATUS" 201 "a no sale"
t28_match "" "{\"event\":{\"kind\":\"no_sale\",\"amount\":0,\"register\":\"$T28_R1\",\"session\":\"$T28_S1\",\"detail\":{\"reason\":\"Change for a note\"},\"staff\":{\"id\":\"$T28_MANAGER_ID\"},\"approver\":null},\"print_job\":null}" \
  "a no sale"
T28_AUDIT="$(t28_audit till_no_sale "$(t28_val event.id)")"
[ "$(echo "$T28_AUDIT" | jval totalItems)" = "1" ] || fail "a no sale left no till_no_sale audit row"
echo "$T28_AUDIT" | grep -q "Change for a note" && fail "the no sale's reason reached audit_log: $T28_AUDIT"
ok "a no sale needs a manager and a reason, and is a till event with the reason kept out of audit_log"

T28_STATUS="$(t28_req POST /api/vault/till/void "$T28_STAFF" "{\"register\":\"$T28_R1\",\"ticket\":false,\"lines\":[{\"title\":\"Booster pack\",\"qty\":2,\"amount\":900},{\"title\":\"Sleeves\",\"qty\":1,\"amount\":350}]}")"
t28_status "$T28_STATUS" 201 "voiding two lines"
[ "$(jlen events <"$T28_OUT")" = "2" ] || fail "voiding two lines did not write two events: $(cat "$T28_OUT")"
t28_match events.0 "{\"kind\":\"void_line\",\"amount\":900,\"session\":\"$T28_S1\",\"detail\":{\"title\":\"Booster pack\",\"qty\":2},\"staff\":{\"id\":\"$T28_STAFF_ID\"}}" \
  "the first voided line"
t28_match events.1 "{\"kind\":\"void_line\",\"amount\":350,\"detail\":{\"title\":\"Sleeves\",\"qty\":1}}" "the second voided line"
T28_VOID_ID="$(t28_val events.0.id)"
[ "$(t28_audit till_void "$T28_VOID_ID" | jval items.0.meta.total)" = "1250" ] || fail "voiding lines left no till_void audit row"
T28_STATUS="$(t28_req POST /api/vault/till/void "$T28_STAFF" "{\"register\":\"$T28_R1\",\"ticket\":true,\"lines\":[{\"title\":\"Playmat\",\"qty\":1,\"amount\":2000},{\"title\":\"Dice\",\"qty\":3,\"amount\":300}]}")"
t28_status "$T28_STATUS" 201 "voiding a ticket"
[ "$(jlen events <"$T28_OUT")" = "1" ] || fail "voiding a ticket did not write one event: $(cat "$T28_OUT")"
t28_is events.0.kind void_ticket "a voided ticket"
t28_is events.0.amount 2300 "a voided ticket's value"
t28_is events.0.detail.lines.1.title Dice "a voided ticket keeps its lines"
T28_STATUS="$(t28_req POST /api/vault/till/void "$T28_STAFF" "{\"register\":\"$T28_R1\",\"ticket\":false,\"lines\":[]}")"
t28_refused "$T28_STATUS" 400 "List the lines that were taken off the ticket." "a void with no lines"
T28_STATUS="$(t28_req POST /api/vault/till/void "$T28_STAFF" "{\"register\":\"$T28_R1\",\"lines\":[{\"title\":\"\",\"qty\":1,\"amount\":100}]}")"
t28_refused "$T28_STATUS" 400 "Each removed line needs a title, a quantity of 1 or more and an amount of £0.00 or more." "a voided line with no title"
T28_STATUS="$(t28_req POST /api/vault/till/void "$T28_STAFF" "{\"register\":\"$T28_R1\",\"lines\":[{\"title\":\"Pack\",\"qty\":0,\"amount\":100}]}")"
t28_refused "$T28_STATUS" 400 "Each removed line needs a title, a quantity of 1 or more and an amount of £0.00 or more." "a voided line of no units"
ok "voided lines are one event each, a voided ticket one event with its lines, and both are audited"

# --- 28g. A day's trading, written straight to the records -----------------
T28_GAME="$(curl -s -G "$BASE/api/collections/games/records" -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=key = 'pokemon'" | jval items.0.id)"
T28_TABLE="$(curl -s -G "$BASE/api/collections/till_products/records" -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=name = 'Table time, 1 hour'" | jval items.0.id)"
[ -n "$T28_GAME" ] && [ -n "$T28_TABLE" ] || fail "the seeded game or till product is missing"
T28_SINGLE="$(t28_create items "{\"kind\":\"single\",\"game\":\"$T28_GAME\",\"condition\":\"NM\",\"qty\":0,\"status\":\"sold\",\"title\":\"Till check single\",\"price\":3000}")"
T28_SEALED="$(t28_create items "{\"kind\":\"sealed\",\"game\":\"$T28_GAME\",\"qty\":0,\"status\":\"sold\",\"title\":\"Till check booster box\",\"price\":2500}")"
T28_SELLER="$(t28_create customers '{"name":"Till Check Seller","source":"counter"}')"

# t28_sale NUMBER SESSION REGISTER STAFF DISCOUNT SUBTOTAL TOTAL: a sale row.
t28_sale() {
  t28_create sales "{\"number\":\"$1\",\"cash_session\":\"$2\",\"register\":\"$3\",\"staff\":\"$4\",\"discount\":$5,\"subtotal\":$6,\"total\":$7,\"payment\":\"mixed\",\"status\":\"complete\"}"
}
# t28_tender SALE METHOD AMOUNT SESSION REGISTER STAFF [REFUND_REF] [EXTRA JSON]
t28_tender() {
  t28_create sale_tenders "{\"sale\":\"$1\",\"method\":\"$2\",\"amount\":$3,\"session\":\"$4\",\"register\":\"$5\",\"staff\":\"$6\",\"refund_ref\":\"${7:-}\"${8:-}}" >/dev/null
}
# t28_move SESSION TYPE AMOUNT REF
t28_move() {
  t28_create cash_movements "{\"session\":\"$1\",\"type\":\"$2\",\"amount\":$3,\"ref\":\"$4\",\"staff\":\"$T28_STAFF_ID\"}" >/dev/null
}

# On the second till: a £9.00 cash sale, refunded later on the first.
T28_SALE0="$(t28_sale T28-S-0 "$T28_S2" "$T28_R2" "$T28_STAFF_ID" 0 900 900)"
t28_create sale_lines "{\"sale\":\"$T28_SALE0\",\"item\":\"$T28_SINGLE\",\"qty\":1,\"unit_price\":900,\"discount\":0,\"vat_rate\":0,\"tax_scheme\":\"margin\",\"status\":\"sold\"}" >/dev/null
t28_tender "$T28_SALE0" cash 900 "$T28_S2" "$T28_R2" "$T28_STAFF_ID"
t28_move "$T28_S2" cash_sale 900 T28-S-0

# On the first till. Sale 1: a £30.00 single and an hour's table time
# (£5.00, standard rated, 83p VAT), paid £15.00 cash (a £20 note, £5.00
# change) and £20.00 on the Tide reader.
T28_SALE1="$(t28_sale T28-S-1 "$T28_S1" "$T28_R1" "$T28_STAFF_ID" 0 3500 3500)"
t28_create sale_lines "{\"sale\":\"$T28_SALE1\",\"item\":\"$T28_SINGLE\",\"qty\":1,\"unit_price\":3000,\"discount\":0,\"vat_rate\":0,\"tax_scheme\":\"margin\",\"status\":\"sold\"}" >/dev/null
t28_create sale_lines "{\"sale\":\"$T28_SALE1\",\"product\":\"$T28_TABLE\",\"title\":\"Table time, 1 hour\",\"qty\":1,\"unit_price\":500,\"discount\":0,\"vat_rate\":20,\"vat_amount\":83,\"tax_scheme\":\"standard\",\"status\":\"sold\"}" >/dev/null
t28_tender "$T28_SALE1" cash 1500 "$T28_S1" "$T28_R1" "$T28_STAFF_ID" "" ',"tendered":2000,"change":500'
t28_tender "$T28_SALE1" card_tide 2000 "$T28_S1" "$T28_R1" "$T28_STAFF_ID" "" ',"card_last4":"4242"'
t28_move "$T28_S1" cash_sale 1500 T28-S-1
# Sale 2, by the manager: two booster boxes at £25.00 with £2.50 off the ticket, on card.
T28_SALE2="$(t28_sale T28-S-2 "$T28_S1" "$T28_R1" "$T28_MANAGER_ID" 250 5000 4750)"
t28_create sale_lines "{\"sale\":\"$T28_SALE2\",\"item\":\"$T28_SEALED\",\"qty\":2,\"unit_price\":2500,\"discount\":0,\"vat_rate\":0,\"tax_scheme\":\"margin\",\"status\":\"sold\"}" >/dev/null
t28_tender "$T28_SALE2" card_tide 4750 "$T28_S1" "$T28_R1" "$T28_MANAGER_ID" "" ',"card_last4":"1881"'
# Sale 3: a £12.00 single on store credit.
T28_SALE3="$(t28_sale T28-S-3 "$T28_S1" "$T28_R1" "$T28_STAFF_ID" 0 1200 1200)"
t28_create sale_lines "{\"sale\":\"$T28_SALE3\",\"item\":\"$T28_SINGLE\",\"qty\":1,\"unit_price\":1200,\"discount\":0,\"vat_rate\":0,\"tax_scheme\":\"margin\",\"status\":\"sold\"}" >/dev/null
t28_tender "$T28_SALE3" store_credit 1200 "$T28_S1" "$T28_R1" "$T28_STAFF_ID"
# The second till's sale refunded in cash on the first.
t28_tender "$T28_SALE0" cash -900 "$T28_S1" "$T28_R1" "$T28_MANAGER_ID" T28-S-0-R1
t28_move "$T28_S1" refund -900 T28-S-0-R1
# A £25.00 cash buy-in paid from the first till.
t28_create trade_ins "{\"number\":\"T28-BI-1\",\"customer\":\"$T28_SELLER\",\"status\":\"completed\",\"payout_type\":\"cash\",\"payout_cash\":2500,\"payout_credit\":0,\"cash_session\":\"$T28_S1\",\"channel\":\"counter\"}" >/dev/null
t28_move "$T28_S1" payout -2500 T28-BI-1
ok "a day's sales, tenders, a refund of another till's sale and a cash buy-in are on the records"

# --- 28h. The running report adds up, to the penny ------------------------
T28_SETTINGS_ID="$(curl -s "$BASE/api/collections/settings/records" -H "Authorization: $SUPER_TOKEN" | jval items.0.id)"
T28_VAT_WAS="$(curl -s "$BASE/api/collections/settings/records/$T28_SETTINGS_ID" -H "Authorization: $SUPER_TOKEN" | jval vat_registered)"
[ "$T28_VAT_WAS" = "true" ] || T28_VAT_WAS="false"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$T28_SETTINGS_ID" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"vat_registered":true}'

# Expected: 8503 + 1500 - 640 - 5000 - 15 - 100 (the approved paid out)
# + 1500 (cash sale) - 900 (refund) - 2500 (buy-in) = 2348.
# Net: 9700 gross - 250 discount - 900 refunded = 8550, over 3 sales 2850.
T28_WANT_RUNNING="{
  \"type\":\"x\",\"number\":0,\"id\":\"\",
  \"register\":{\"id\":\"$T28_R1\",\"name\":\"Check Till 28\"},
  \"session_id\":\"$T28_S1\",
  \"sales\":{\"count\":3,\"gross\":9700,\"discounts\":250,\"net\":8550,\"average_basket\":2850,
    \"vat\":[{\"rate\":20,\"net\":417,\"vat\":83,\"gross\":500}]},
  \"refunds\":{\"count\":1,\"total\":900},
  \"tenders\":[
    {\"method\":\"cash\",\"label\":\"Cash\",\"taken\":1500,\"refunded\":900,\"net\":600,\"count\":1},
    {\"method\":\"card_tide\",\"label\":\"Card\",\"taken\":6750,\"refunded\":0,\"net\":6750,\"count\":2},
    {\"method\":\"store_credit\",\"label\":\"Store credit\",\"taken\":1200,\"refunded\":0,\"net\":1200,\"count\":1}],
  \"cash\":{\"opening_float\":8503,\"cash_sales\":1500,\"cash_refunds\":900,\"paid_in\":1500,\"paid_out\":740,
    \"buy_in_payouts\":2500,\"bank_drops\":5000,\"adjustments\":-15,\"expected\":2348,\"counted\":null,\"variance\":null},
  \"card\":{\"till_total\":6750,\"reported_total\":null,\"variance\":null},
  \"voids\":{\"count\":3,\"total\":3550},
  \"no_sales\":{\"count\":1},
  \"overrides\":{\"count\":1},
  \"discounts\":{\"count\":1,\"total\":250},
  \"trade_ins\":{\"count\":1,\"cash_paid\":2500,\"credit_issued\":0,\"part_exchange_value\":0},
  \"by_category\":[{\"category\":\"Sealed\",\"net\":4750,\"count\":2},{\"category\":\"Singles\",\"net\":4200,\"count\":2},{\"category\":\"Services\",\"net\":500,\"count\":1}],
  \"by_staff\":[{\"staff_id\":\"$T28_MANAGER_ID\",\"name\":\"Till Manager 28\",\"net\":4750,\"count\":1},{\"staff_id\":\"$T28_STAFF_ID\",\"name\":\"Till Staff 28\",\"net\":4700,\"count\":2}],
  \"counts\":null,\"notes\":\"\"
}"
T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R1" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the running report"
t28_match running "$T28_WANT_RUNNING" "the running report does not add up"
[ -n "$(t28_val running.first_sale_at)" ] && [ -n "$(t28_val running.last_sale_at)" ] || fail "the running report has no first or last sale time"

T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R2" "$T28_STAFF")"
t28_match running "{\"sales\":{\"count\":1,\"net\":900},\"refunds\":{\"count\":0,\"total\":0},\"cash\":{\"expected\":5900}}" \
  "the refunded sale's own till should still show the sale and not the refund"
ok "the running report adds up to the penny: tenders, refunds, VAT, the drawer, voids, no sales, overrides, buy-ins, categories and staff"

T28_STATUS="$(t28_req POST /api/vault/till/x "$T28_STAFF" "{\"register\":\"$T28_R1\"}")"
t28_status "$T28_STATUS" 201 "an X report after a day's trading"
T28_X3="$(t28_val report.id)"
t28_match report "{\"type\":\"x\",\"number\":$((T28_X2_NUMBER + 1)),\"sales\":{\"net\":8550},\"cash\":{\"expected\":2348},\"tenders\":[{\"method\":\"cash\",\"label\":\"Cash\",\"taken\":1500,\"refunded\":900,\"net\":600,\"count\":1},{\"method\":\"card_tide\",\"label\":\"Card\",\"taken\":6750,\"refunded\":0,\"net\":6750,\"count\":2},{\"method\":\"store_credit\",\"label\":\"Store credit\",\"taken\":1200,\"refunded\":0,\"net\":1200,\"count\":1}]}" \
  "the saved X report should say what the running report says"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$T28_SETTINGS_ID" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"vat_registered\":$T28_VAT_WAS}"
ok "a saved X report says what the running report says"

# --- 28i. The legacy cash-session routes, per register ----------------------
T28_STATUS="$(t28_req GET "/api/vault/cash-sessions/current?register=$T28_R2" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the legacy current session for a named register"
t28_match "" "{\"session\":{\"id\":\"$T28_S2\",\"register\":\"$T28_R2\",\"float\":5000},\"expected\":5900}" \
  "the legacy current session should be the named register's"
T28_STATUS="$(t28_req GET "/api/vault/cash-sessions/current?register=nosuchregister1" "$T28_STAFF")"
t28_refused "$T28_STATUS" 404 "That register was not found." "the legacy current session of a register that does not exist"
T28_STATUS="$(t28_req GET /api/vault/cash-sessions/current "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the legacy current session with no register named"
T28_LEGACY_REGISTER="$(t28_val session.register)"
[ -z "$T28_LEGACY_REGISTER" ] || [ "$T28_LEGACY_REGISTER" = "$T28_DEFAULT_ID" ] \
  || fail "the legacy current session with no register named is on '$T28_LEGACY_REGISTER', not the default register"
T28_STATUS="$(t28_req POST "/api/vault/cash-sessions/$T28_S2/close" "$T28_STAFF" "{\"counted\":5900,\"register\":\"$T28_R1\"}")"
t28_refused "$T28_STATUS" 409 "That cash session belongs to another till. Close it from that till." "closing one till's session from another"
ok "the legacy routes read a named register's session, the default register's without one, and close only their own"

# --- 28j. The Z report's refusals ------------------------------------------
T28_Z_COUNTS='{"1000":1,"200":1,"100":1,"5":3,"2":1,"1":1}'
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"card_reported_total\":6800}")"
t28_refused "$T28_STATUS" 400 "Count the drawer before closing the till." "a Z with no count"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":{},\"card_reported_total\":6800}")"
t28_refused "$T28_STATUS" 400 "Count the drawer before closing the till." "a Z with an empty count"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":{\"1000\":1.5},\"card_reported_total\":6800}")"
t28_refused "$T28_STATUS" 400 "Count each note and coin as a whole number, 0 or more." "a Z with half a note"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":null}")"
t28_refused "$T28_STATUS" 400 "Enter the Tide card total for today from the Tide app." "a Z with no Tide total after card sales"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":\"68.00\"}")"
t28_refused "$T28_STATUS" 400 "Enter the Tide card total as a whole number of pence." "a Z with a Tide total in pounds"

T28_PARKED_A="$(t28_create parked_tickets "{\"register\":\"$T28_R1\",\"label\":\"Table 4\",\"staff\":\"$T28_STAFF_ID\",\"total\":1200,\"payload\":{},\"item_ids\":[]}")"
T28_PARKED_B="$(t28_create parked_tickets "{\"register\":\"$T28_R1\",\"label\":\"Sam's order\",\"staff\":\"$T28_STAFF_ID\",\"total\":800,\"payload\":{},\"item_ids\":[]}")"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":6800}")"
t28_refused "$T28_STATUS" 409 "Two tickets are parked on Check Till 28. Complete or delete them before closing the till." "a Z with two parked tickets"
curl -s -o /dev/null -X DELETE "$BASE/api/collections/parked_tickets/records/$T28_PARKED_A" -H "Authorization: $SUPER_TOKEN"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":6800}")"
t28_refused "$T28_STATUS" 409 "One ticket is parked on Check Till 28. Complete or delete it before closing the till." "a Z with one parked ticket"
curl -s -o /dev/null -X DELETE "$BASE/api/collections/parked_tickets/records/$T28_PARKED_B" -H "Authorization: $SUPER_TOKEN"

T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":6800,\"bank_drop\":2349}")"
t28_refused "$T28_STATUS" 409 "That is more than the £23.48 the drawer should hold." "a Z with a bank drop of more than the drawer holds"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_STAFF" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":6800}")"
t28_needs_override "$T28_STATUS" z_report "a member of staff running the Z"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R3\",\"counts\":{\"5000\":0},\"notes\":\"$(printf 'n%.0s' $(seq 1 2001))\"}")"
t28_refused "$T28_STATUS" 400 "Keep the notes to 2,000 characters." "a Z with notes over 2,000 characters"
[ "$(t28_rows cash_sessions "id = \"$T28_S1\" && closed_at = \"\"" | jval totalItems)" = "1" ] || fail "a refused Z closed the session"
ok "a Z is refused with no count, a bad count, no Tide total after card sales, parked tickets, too big a bank drop and without z_report"

# --- 28k. The Z report -----------------------------------------------------
# A £10.00 bank drop comes out first, so the drawer should hold 2348 - 1000
# = 1348; it holds 1000 + 200 + 100 + 15 + 2 + 1 = 1318, 30p short. Tide
# says £68.00 against the till's £67.50 on card, 50p over.
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":6800,\"bank_drop\":1000,\"notes\":\"Counted twice.\"}")"
t28_status "$T28_STATUS" 201 "the Z report"
T28_Z1="$(t28_val report.id)"
T28_Z1_NUMBER="$(t28_val report.number)"
t28_match report "{\"type\":\"z\",\"session_id\":\"$T28_S1\",\"created_by\":{\"id\":\"$T28_MANAGER_ID\",\"name\":\"Till Manager 28\"},
  \"sales\":{\"count\":3,\"gross\":9700,\"discounts\":250,\"net\":8550,\"average_basket\":2850,\"vat\":[]},
  \"cash\":{\"opening_float\":8503,\"bank_drops\":6000,\"expected\":1348,\"counted\":1318,\"variance\":-30},
  \"card\":{\"till_total\":6750,\"reported_total\":6800,\"variance\":50},
  \"counts\":$T28_Z_COUNTS,\"notes\":\"Counted twice.\"}" \
  "the Z report's figures"
t28_match session "{\"id\":\"$T28_S1\",\"register\":{\"id\":\"$T28_R1\"},\"float\":8503}" "the Z report's session"
T28_SESSION_ROW="$(curl -s "$BASE/api/collections/cash_sessions/records/$T28_S1" -H "Authorization: $SUPER_TOKEN")"
echo "$T28_SESSION_ROW" >"$T28_OUT"
t28_match "" "{\"closed_by\":\"$T28_MANAGER_ID\",\"expected\":1348,\"counted\":1318,\"variance\":-30,\"card_till_total\":6750,\"card_reported_total\":6800,\"card_variance\":50,\"z_report\":\"$T28_Z1\",\"notes\":\"Counted twice.\",\"closing_counts\":$T28_Z_COUNTS}" \
  "the closed session should carry the Z's figures and link to it"
[ -n "$(t28_val closed_at)" ] || fail "the Z left the session open: $T28_SESSION_ROW"
T28_DROP="$(t28_rows cash_movements "session = \"$T28_S1\" && type = \"bank_drop\" && amount = -1000")"
[ "$(echo "$T28_DROP" | jval totalItems)" = "1" ] && [ "$(echo "$T28_DROP" | jval items.0.reason)" = "Bank drop at cashing up" ] \
  || fail "the Z's bank drop is not a movement on the session: $T28_DROP"
T28_AUDIT="$(t28_audit till_z_report "$T28_Z1")"
[ "$(echo "$T28_AUDIT" | jval items.0.meta.variance)" = "-30" ] && [ "$(echo "$T28_AUDIT" | jval items.0.meta.card_variance)" = "50" ] \
  && [ "$(echo "$T28_AUDIT" | jval items.0.meta.bank_drop)" = "1000" ] \
  || fail "the Z left no till_z_report audit row with its variances: $T28_AUDIT"
echo "$T28_AUDIT" | grep -q "Counted twice" && fail "the Z's notes reached audit_log: $T28_AUDIT"
ok "the Z closes the session 30p short in cash and 50p over on card, with its bank drop, count and report linked"

T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R1" "$T28_STAFF")"
t28_is session "" "the current till after the Z"
t28_is running "" "the running report after the Z"
T28_STATUS="$(t28_req POST /api/vault/till/movement "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"type\":\"paid_in\",\"amount\":100,\"reason\":\"Late\"}")"
t28_refused "$T28_STATUS" 409 "Open the till first." "a paid in after the Z"
T28_STATUS="$(t28_req POST /api/vault/till/no-sale "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"reason\":\"Late\"}")"
t28_refused "$T28_STATUS" 409 "Open the till first." "a no sale after the Z"
T28_STATUS="$(t28_req POST /api/vault/till/void "$T28_STAFF" "{\"register\":\"$T28_R1\",\"lines\":[{\"title\":\"Pack\",\"qty\":1,\"amount\":450}]}")"
t28_refused "$T28_STATUS" 409 "Open the till first." "a void after the Z"
T28_STATUS="$(t28_req POST /api/vault/till/x "$T28_STAFF" "{\"register\":\"$T28_R1\"}")"
t28_refused "$T28_STATUS" 409 "Open the till first." "an X after the Z"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":$T28_Z_COUNTS,\"card_reported_total\":6800}")"
t28_refused "$T28_STATUS" 409 "Open the till first." "a second Z"
ok "once the Z has closed the till, every route but open and the reads says to open it first"

# --- 28l. The report history ----------------------------------------------
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=$T28_R1" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the report history"
t28_is total 4 "the first till's report history (three X and a Z)"
t28_match "items.0" "{\"id\":\"$T28_Z1\",\"type\":\"z\",\"number\":$T28_Z1_NUMBER,\"register_name\":\"Check Till 28\",\"created_by_name\":\"Till Manager 28\",\"net\":8550,\"cash_variance\":-30,\"card_variance\":50}" \
  "the newest report in the history should be the Z"
t28_match "items.1" "{\"id\":\"$T28_X3\",\"type\":\"x\",\"net\":8550,\"cash_variance\":null,\"card_variance\":null}" \
  "an X in the history has no variances"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=$T28_R1&type=z" "$T28_STAFF")"
t28_is total 1 "the first till's Z reports"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=$T28_R1&per_page=1&page=2" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "the second page of the history"
t28_match "" "{\"page\":2,\"per_page\":1,\"total\":4}" "the second page of the history"
[ "$(jlen items <"$T28_OUT")" = "1" ] && [ "$(t28_val items.0.id)" = "$T28_X3" ] || fail "the second page is not the newest X: $(cat "$T28_OUT")"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?type=q" "$T28_STAFF")"
t28_refused "$T28_STATUS" 400 "Choose x or z for the report type." "a report history of an unknown type"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=nosuchregister1" "$T28_STAFF")"
t28_refused "$T28_STATUS" 404 "That register was not found." "the report history of a register that does not exist"

T28_STATUS="$(t28_req GET "/api/vault/till/reports/$T28_Z1" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "a report by id"
t28_match report "{\"id\":\"$T28_Z1\",\"type\":\"z\",\"number\":$T28_Z1_NUMBER,\"cash\":{\"expected\":1348,\"counted\":1318,\"variance\":-30},\"notes\":\"Counted twice.\"}" \
  "a Z read back by id"
T28_STATUS="$(t28_req GET "/api/vault/till/reports/nosuchreport123" "$T28_STAFF")"
t28_refused "$T28_STATUS" 404 "That report was not found. Check the list and try again." "a report that does not exist"
ok "the report history lists newest first with the variances, filters by till and type, pages, and reads a report back"

# --- 28m. A Z report cannot be changed or deleted, by anybody --------------
T28_STATUS="$(t28_req PATCH "/api/collections/till_reports/records/$T28_Z1" "$STAFF_TOKEN" '{"notes":"x","number":999}')"
[ "$T28_STATUS" = "403" ] || [ "$T28_STATUS" = "404" ] || fail "an admin changing a Z through the collection API got $T28_STATUS: $(cat "$T28_OUT")"
T28_STATUS="$(t28_req DELETE "/api/collections/till_reports/records/$T28_Z1" "$STAFF_TOKEN")"
[ "$T28_STATUS" = "403" ] || [ "$T28_STATUS" = "404" ] || fail "an admin deleting a Z through the collection API got $T28_STATUS: $(cat "$T28_OUT")"
T28_STATUS="$(t28_req POST "/api/collections/till_reports/records" "$STAFF_TOKEN" "{\"type\":\"z\",\"number\":9999,\"register\":\"$T28_R1\",\"session\":\"$T28_S1\"}")"
[ "$T28_STATUS" = "403" ] || [ "$T28_STATUS" = "400" ] || fail "an admin writing a Z through the collection API got $T28_STATUS: $(cat "$T28_OUT")"
# Beneath the collection rules: till.pb.js refuses a Z at the record level,
# so a superuser (and any hook) is refused too.
T28_STATUS="$(t28_req PATCH "/api/collections/till_reports/records/$T28_Z1" "$SUPER_TOKEN" '{"number":999}')"
t28_refused "$T28_STATUS" 403 "A Z report cannot be changed or deleted." "a superuser changing a Z report"
T28_STATUS="$(t28_req DELETE "/api/collections/till_reports/records/$T28_Z1" "$SUPER_TOKEN")"
t28_refused "$T28_STATUS" 403 "A Z report cannot be changed or deleted." "a superuser deleting a Z report"
T28_STATUS="$(t28_req GET "/api/collections/till_reports/records/$T28_Z1" "$SUPER_TOKEN")"
t28_status "$T28_STATUS" 200 "the Z report after the attempts on it"
t28_is number "$T28_Z1_NUMBER" "the Z report's number after the attempts on it"
t28_is data.cash.variance -30 "the Z report's figures after the attempts on it"
ok "a Z report cannot be changed or deleted through the collection API, by an admin or a superuser"

# --- 28n. The other two tills close, numbered in sequence ------------------
# The second till took no card, so no Tide total is needed: £50 + £5 + 2 x
# £2 + 20p = 5920 against 5900 expected, 20p over.
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R2\",\"counts\":{\"5000\":1,\"500\":1,\"200\":2,\"20\":1}}")"
t28_status "$T28_STATUS" 201 "the second till's Z"
t28_match report "{\"number\":$((T28_Z1_NUMBER + 1)),\"sales\":{\"count\":1,\"net\":900},\"cash\":{\"expected\":5900,\"counted\":5920,\"variance\":20},\"card\":{\"till_total\":0,\"reported_total\":null,\"variance\":null}}" \
  "the second till's Z"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R3\",\"counts\":{\"5000\":0}}")"
t28_status "$T28_STATUS" 201 "the third till's Z"
t28_match report "{\"number\":$((T28_Z1_NUMBER + 2)),\"cash\":{\"opening_float\":0,\"expected\":0,\"counted\":0,\"variance\":0}}" "the third till's Z"
T28_LAST_Z="$(t28_val report.number)"
T28_COUNTERS="$(curl -s -G "$BASE/api/collections/counters/records" -H "Authorization: $STAFF_TOKEN" --data-urlencode "filter=key = 'x_report' || key = 'z_report'" --data-urlencode "sort=key")"
[ "$(echo "$T28_COUNTERS" | jval items.0.value)" = "$((T28_X2_NUMBER + 1))" ] && [ "$(echo "$T28_COUNTERS" | jval items.1.value)" = "$T28_LAST_Z" ] \
  || fail "the x_report and z_report counters do not stand at the last numbers issued: $T28_COUNTERS"

T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R1\",\"float\":10000}")"
t28_status "$T28_STATUS" 201 "reopening the first till after its Z"
T28_S1B="$(t28_val session.id)"
[ "$T28_S1B" != "$T28_S1" ] || fail "reopening the till reused the closed session"
T28_STATUS="$(t28_req POST /api/vault/till/z "$T28_MANAGER" "{\"register\":\"$T28_R1\",\"counts\":{\"5000\":2}}")"
t28_status "$T28_STATUS" 201 "closing the reopened till"
t28_match report "{\"number\":$((T28_LAST_Z + 1)),\"sales\":{\"count\":0},\"refunds\":{\"count\":0},\"cash\":{\"expected\":10000,\"variance\":0}}" \
  "a new session's Z starts from nothing"
ok "the other tills' Z reports follow in sequence, the counters stand at the last numbers, and a till reopens after its Z"

# --- 28o. Who may call the till at all -------------------------------------
T28_CUSTOMER_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$T28_SELLER" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$T28_CUSTOMER_TOKEN" ] || fail "could not impersonate the till check's customer"
T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R1" "$T28_CUSTOMER_TOKEN")"
t28_status "$T28_STATUS" 403 "a customer reading the till"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_CUSTOMER_TOKEN" "{\"register\":\"$T28_R1\",\"float\":1000}")"
t28_status "$T28_STATUS" 403 "a customer opening the till"
T28_STATUS="$(t28_req GET /api/vault/till/reports "$T28_CUSTOMER_TOKEN")"
t28_status "$T28_STATUS" 403 "a customer reading the report history"

t28_create staff "{\"email\":\"till-gone-28@local.test\",\"password\":\"$T28_PASSWORD\",\"passwordConfirm\":\"$T28_PASSWORD\",\"name\":\"Till Gone 28\",\"role\":\"admin\",\"active\":true}" >/dev/null
T28_GONE="$(t28_signin till-gone-28@local.test)"
T28_GONE_ID="$(curl -s -G "$BASE/api/collections/staff/records" -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=email = 'till-gone-28@local.test'" | jval items.0.id)"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/staff/records/$T28_GONE_ID" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"active":false}'
T28_STATUS="$(t28_req GET "/api/vault/till/current?register=$T28_R1" "$T28_GONE")"
t28_refused "$T28_STATUS" 403 "This account is inactive. Ask an admin to reactivate it." "a deactivated admin's token reading the till"
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_GONE" "{\"register\":\"$T28_R1\",\"float\":1000}")"
t28_refused "$T28_STATUS" 403 "This account is inactive. Ask an admin to reactivate it." "a deactivated admin's token opening the till"
ok "a customer cannot reach the till, and a deactivated staff member's token is refused"

# An admin can raise a capability under settings.epos.permissions. With
# x_report raised to manager, reading the history needs an approval too, and
# the approval is spent by the read: an override is single use whatever it
# approves.
T28_SETTINGS_ROW="$(curl -s "$BASE/api/collections/settings/records/$T28_SETTINGS_ID" -H "Authorization: $SUPER_TOKEN")"
T28_EPOS_WAS="$(echo "$T28_SETTINGS_ROW" | node -e 'let d="";process.stdin.on("data",(c)=>(d+=c));process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(d).epos ?? null)))')"
T28_EPOS_STRICT="$(node -e 'const e = JSON.parse(process.argv[1]) || {}; e.permissions = Object.assign({}, e.permissions, { x_report: "manager" }); process.stdout.write(JSON.stringify(e))' "$T28_EPOS_WAS")"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$T28_SETTINGS_ID" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"epos\":$T28_EPOS_STRICT}"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=$T28_R1" "$T28_STAFF")"
t28_needs_override "$T28_STATUS" x_report "a member of staff reading the history once x_report is a manager's"
T28_READ_TOKEN="t28-read-$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')"
T28_READ_HASH="$(printf '%s' "$T28_READ_TOKEN" | sha256sum | cut -d' ' -f1)"
T28_READ_OVERRIDE="$(t28_create till_overrides "{\"token_hash\":\"$T28_READ_HASH\",\"capability\":\"x_report\",\"requested_by\":\"$T28_STAFF_ID\",\"approver\":\"$T28_MANAGER_ID\",\"register\":\"$T28_R1\",\"expires_at\":\"$T28_EXPIRES\"}")"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=$T28_R1" "$T28_STAFF" "" "X-GG-Override: $T28_READ_TOKEN")"
t28_status "$T28_STATUS" 200 "a member of staff reading the history with a manager's approval"
t28_is total 5 "the first till's history read with an approval (three X and two Z)"
[ "$(curl -s "$BASE/api/collections/till_overrides/records/$T28_READ_OVERRIDE" -H "Authorization: $SUPER_TOKEN" | jval used_for)" = "till_reports" ] \
  || fail "the approval for reading the history was not marked used"
[ "$(t28_rows till_events "register = \"$T28_R1\" && kind = \"override\" && approver = \"$T28_MANAGER_ID\" && detail.capability = \"x_report\"" | jval totalItems)" = "1" ] \
  || fail "the approval for reading the history left no override till event"
T28_STATUS="$(t28_req GET "/api/vault/till/reports/$T28_Z1" "$T28_STAFF" "" "X-GG-Override: $T28_READ_TOKEN")"
t28_needs_override "$T28_STATUS" x_report "a second read on an approval already spent"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/settings/records/$T28_SETTINGS_ID" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"epos\":$T28_EPOS_WAS}"
T28_STATUS="$(t28_req GET "/api/vault/till/reports/$T28_Z1" "$T28_STAFF")"
t28_status "$T28_STATUS" 200 "a member of staff reading a report once x_report is back to staff"
ok "with x_report raised to manager a read needs an approval, and the read spends it"

# Switch the check's tills off, so later sections see the shop as it was.
for T28_R in "$T28_R1" "$T28_R2" "$T28_R3"; do
  curl -s -o /dev/null -X PATCH "$BASE/api/collections/registers/records/$T28_R" -H "Authorization: $SUPER_TOKEN" \
    -H "Content-Type: application/json" -d '{"active":false}'
done
T28_STATUS="$(t28_req POST /api/vault/till/open "$T28_STAFF" "{\"register\":\"$T28_R1\",\"float\":1000}")"
t28_refused "$T28_STATUS" 409 "That register is switched off. Switch it on under Settings first." "opening a till that is switched off"
T28_STATUS="$(t28_req GET "/api/vault/till/reports?register=$T28_R1&type=z" "$T28_STAFF")"
t28_is total 2 "a switched-off till's Z reports"
ok "a switched-off till cannot be opened, and its reports stay readable"
