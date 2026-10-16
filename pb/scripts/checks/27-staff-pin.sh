# shellcheck shell=bash
# -----------------------------------------------------------------------
# 27. Staff, PINs, registered tills and manager approval (EPOS package B1)
#
# docs/api-contract-epos.md, section 2: pb_hooks/till_auth.pb.js,
# pb_hooks/staff_admin.pb.js, pb_hooks/lib/pins.js, pb_hooks/lib/devices.js
# and the password sign-in that clears a PIN lock in pb_hooks/staff.pb.js.
#
# Sourced by check.sh into its own shell, so it shares the main server
# ($BASE), $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR, $ID_PHOTO_KEY
# and the ok/fail/jval helpers. Everything this file defines starts with
# B1_ or b1_. It creates the staff it needs with the superuser token, and
# starts one short-lived server of its own with no GG_ID_PHOTO_KEY (kept in
# $KEYLESS_PID so check.sh's cleanup stops it if a check fails), stopped
# again before the file returns.
#
# The three rate limits these routes sit behind are burst once against the
# shipped figures, then raised for the body of the section (which unlocks
# and signs in far more often in a minute than a counter would) and put
# back at the end, exactly as section 25 does for its own.
# -----------------------------------------------------------------------

B1_DEVICE_REFUSAL="This device is not registered as a till. Sign in with a password and register it under Settings."
B1_KEYLESS="PINs are not available because the server key is not set."
B1_LOCKED="Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN."
B1_INACTIVE="This account is inactive. Ask an admin to reactivate it."
B1_STEP_UP="Confirm your password to continue."
B1_ADMIN_ONLY="Only an admin can do this. Ask Richard to run it for you."
B1_MANAGER_ONLY="Only a manager or an admin can do this. Ask one to sign in."
B1_PASSWORD_RULE="Choose a password of at least 12 characters, and not the one you are using now."
B1_LAST_ADMIN="There has to be at least one active admin."
B1_PASSWORD="b1-check-password-0001"
B1_URL="$BASE"

# --- helpers -------------------------------------------------------------

b1_call() {
  # $1 method, $2 path, $3 auth token, $4 device header, $5 step-up token,
  # $6 JSON body (each "" for none). Sets B1_STATUS and B1_BODY.
  local args=(-s -o "$TMP_DIR/b1-body.json" -w '%{http_code}' --max-time 20 -X "$1" "$B1_URL$2")
  if [ -n "${3:-}" ]; then args+=(-H "Authorization: $3"); fi
  if [ -n "${4:-}" ]; then args+=(-H "X-GG-Device: $4"); fi
  if [ -n "${5:-}" ]; then args+=(-H "X-Step-Up: $5"); fi
  if [ -n "${6:-}" ]; then args+=(-H "Content-Type: application/json" -d "$6"); fi
  B1_STATUS="$(curl "${args[@]}")"
  B1_BODY="$(cat "$TMP_DIR/b1-body.json")"
}

b1_expect() {
  # $1 expected status, $2 expected message ("" to skip), $3 what was asked
  [ "$B1_STATUS" = "$1" ] || fail "$3 returned $B1_STATUS, expected $1: $B1_BODY"
  if [ -n "$2" ]; then
    local said
    said="$(jval message <<<"$B1_BODY")"
    [ "$said" = "$2" ] || fail "$3 said '$said', expected '$2'"
  fi
}

b1_get() { jval "$1" <<<"$B1_BODY"; }

b1_clean() {
  # The last response carries no PIN hash, password, token key or device
  # secret hash, under any spelling PocketBase or this package would use.
  local needle
  for needle in '"pin_hash"' 'v1$' '"password"' '"passwordConfirm"' '"tokenKey"' '"secret_hash"' '"token_hash"'; do
    if grep -qF -- "$needle" <<<"$B1_BODY"; then
      fail "$1 returned $needle: $B1_BODY"
    fi
  done
}

b1_record() {
  # $1 collection, $2 id, $3 field: read as the superuser, hidden fields included
  curl -s "$BASE/api/collections/$1/records/$2" -H "Authorization: $SUPER_TOKEN" | jval "$3"
}

b1_audit() {
  # $1 action, $2 record id ("" for any) -> the rows, newest first
  local filter="action = \"$1\""
  if [ -n "${2:-}" ]; then filter="$filter && record = \"$2\""; fi
  curl -s -G "$BASE/api/collections/audit_log/records" -H "Authorization: $SUPER_TOKEN" \
    --data-urlencode "filter=$filter" --data-urlencode "sort=-created,-id" --data-urlencode "perPage=200"
}

b1_audit_count() { b1_audit "$1" "${2:-}" | jval totalItems; }

b1_make_staff() {
  # $1 name, $2 email, $3 role -> id. Active, with $B1_PASSWORD.
  curl -s -X POST "$BASE/api/collections/staff/records" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"$B1_PASSWORD\",\"passwordConfirm\":\"$B1_PASSWORD\",\"role\":\"$3\",\"active\":true}" \
    | jval id
}

b1_sign_in() {
  # $1 email, $2 password (default $B1_PASSWORD) -> the whole auth response
  curl -s -X POST "$B1_URL/api/collections/staff/auth-with-password" -H "Content-Type: application/json" \
    -d "{\"identity\":\"$1\",\"password\":\"${2:-$B1_PASSWORD}\"}"
}

b1_step_up() {
  # $1 token, $2 password (default $B1_PASSWORD) -> a step-up token
  curl -s -X POST "$B1_URL/api/vault/step-up" -H "Authorization: $1" -H "Content-Type: application/json" \
    -d "{\"password\":\"${2:-$B1_PASSWORD}\"}" | jval token
}

b1_pin_hash() {
  # $1 staff id, $2 PIN -> the hash the contract says is stored
  node -e '
    const c = require("crypto");
    const [key, id, pin] = process.argv.slice(1);
    const pepper = c.createHmac("sha256", key).update("gg-pin-pepper-v1").digest("hex");
    process.stdout.write("v1$" + c.createHmac("sha256", pepper).update(id + ":" + pin).digest("hex"));
  ' "$ID_PHOTO_KEY" "$1" "$2"
}

b1_sha256() {
  node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$1"
}

b1_unlock() {
  # $1 device header, $2 staff id, $3 PIN
  b1_call POST /api/vault/till/unlock "" "$1" "" "{\"staff\":\"$2\",\"pin\":\"$3\"}"
}

b1_limit() {
  # $1 rate limit label -> its maxRequests
  curl -s "$BASE/api/settings" -H "Authorization: $SUPER_TOKEN" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const rule = (JSON.parse(d).rateLimits.rules || []).find((r) => r.label === process.argv[1]);
      process.stdout.write(rule ? String(rule.maxRequests) : "");
    });
  ' "$1"
}

b1_set_limits() {
  # $1 JSON object { label: maxRequests }. Changing the rules also resets
  # PocketBase's own counters, which is what lets the section go on straight
  # after the bursts below.
  local patch status
  patch="$(curl -s "$BASE/api/settings" -H "Authorization: $SUPER_TOKEN" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const settings = JSON.parse(d);
      const want = JSON.parse(process.argv[1]);
      const rules = settings.rateLimits.rules.map((r) =>
        Object.prototype.hasOwnProperty.call(want, r.label) ? { ...r, maxRequests: want[r.label] } : r
      );
      process.stdout.write(JSON.stringify({ rateLimits: { ...settings.rateLimits, rules: rules } }));
    });
  ' "$1")"
  status="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/settings" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d "$patch")"
  [ "$status" = "200" ] || fail "could not set the rate limits to $1 ($status)"
}

b1_burst() {
  # $1 how many, $2 path, $3 auth token ("" for none) -> one status per line
  local n=0
  while [ "$n" -lt "$1" ]; do
    if [ -n "$3" ]; then
      curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 -X POST "$BASE$2" \
        -H "Authorization: $3" -H "Content-Type: application/json" -d '{}'
    else
      curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 -X POST "$BASE$2" \
        -H "Content-Type: application/json" -d '{}'
    fi
    n=$((n + 1))
  done
}

# --- 27a. The rate limits on unlock and approval -------------------------
B1_UNLOCK_LIMIT="$(b1_limit "POST /api/vault/till/unlock")"
B1_OVERRIDE_LIMIT="$(b1_limit "POST /api/vault/till/override")"
B1_AUTH_LIMIT="$(b1_limit "*:auth")"
[ "$B1_UNLOCK_LIMIT" = "30" ] || fail "the unlock rate limit is '$B1_UNLOCK_LIMIT', expected the contract's 30 a minute"
[ "$B1_OVERRIDE_LIMIT" = "30" ] || fail "the approval rate limit is '$B1_OVERRIDE_LIMIT', expected 30 a minute"

B1_UNLOCK_BURST="$(b1_burst 40 /api/vault/till/unlock "")"
[ "$(head -n1 <<<"$B1_UNLOCK_BURST")" = "401" ] \
  || fail "an unlock from an unregistered browser did not start with the device 401: $(sort <<<"$B1_UNLOCK_BURST" | uniq -c | tr '\n' ' ')"
grep -q '^429$' <<<"$B1_UNLOCK_BURST" \
  || fail "forty unlocks in a row never tripped the 30 a minute limit: $(sort <<<"$B1_UNLOCK_BURST" | uniq -c | tr '\n' ' ')"
B1_OVERRIDE_BURST="$(b1_burst 40 /api/vault/till/override "$STAFF_TOKEN")"
grep -q '^429$' <<<"$B1_OVERRIDE_BURST" \
  || fail "forty approvals in a row never tripped the 30 a minute limit: $(sort <<<"$B1_OVERRIDE_BURST" | uniq -c | tr '\n' ' ')"
ok "PIN unlock and manager approval are rate limited to 30 a minute"

b1_set_limits '{"POST /api/vault/till/unlock":10000,"POST /api/vault/till/override":10000,"*:auth":10000}'

# --- 27b. The people ------------------------------------------------------
B1_MO="$(b1_make_staff "Mo Khan" b1-mo@local.test manager)"
B1_KIT="$(b1_make_staff "Kit Lane" b1-kit@local.test manager)"
B1_SAM="$(b1_make_staff "Sam Bell" b1-sam@local.test staff)"
B1_ANA="$(b1_make_staff "Ana Ruiz" b1-ana@local.test staff)"
B1_LOU="$(b1_make_staff "Lou Park" b1-lou@local.test staff)"
B1_IVY="$(b1_make_staff "Ivy Shaw" b1-ivy@local.test staff)"
for B1_ID in "$B1_MO" "$B1_KIT" "$B1_SAM" "$B1_ANA" "$B1_LOU" "$B1_IVY"; do
  [ -n "$B1_ID" ] || fail "could not create the B1 staff members"
done
B1_ADMIN="$(curl -s "$BASE/api/vault/me" -H "Authorization: $STAFF_TOKEN" | jval id)"
[ -n "$B1_ADMIN" ] || fail "could not read the check admin's own id"
B1_MO_TOKEN="$(b1_sign_in b1-mo@local.test | jval token)"
B1_SAM_TOKEN="$(b1_sign_in b1-sam@local.test | jval token)"
B1_LOU_TOKEN="$(b1_sign_in b1-lou@local.test | jval token)"
B1_IVY_TOKEN="$(b1_sign_in b1-ivy@local.test | jval token)"
[ -n "$B1_MO_TOKEN" ] && [ -n "$B1_SAM_TOKEN" ] && [ -n "$B1_LOU_TOKEN" ] && [ -n "$B1_IVY_TOKEN" ] \
  || fail "the B1 staff members could not sign in"
B1_ADMIN_STEP="$(b1_step_up "$STAFF_TOKEN" "$STAFF_PASSWORD")"
B1_MO_STEP="$(b1_step_up "$B1_MO_TOKEN")"
B1_SAM_STEP="$(b1_step_up "$B1_SAM_TOKEN")"
[ -n "$B1_ADMIN_STEP" ] && [ -n "$B1_MO_STEP" ] && [ -n "$B1_SAM_STEP" ] || fail "could not take step-up tokens"

B1_COUNTER="$(curl -s -G "$BASE/api/collections/registers/records" -H "Authorization: $STAFF_TOKEN" \
  --data-urlencode "filter=name = \"Counter\"" | jval items.0.id)"
[ -n "$B1_COUNTER" ] || fail "the seeded Counter register was not found"
B1_SPARE="$(curl -s -X POST "$BASE/api/collections/registers/records" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"B1 Spare","active":false,"sort":90}' | jval id)"
[ -n "$B1_SPARE" ] || fail "could not create a switched-off register"
ok "B1 staff, tokens and a switched-off register are in place"

# --- 27c. Registering a till ----------------------------------------------
b1_call POST /api/vault/till/devices "$B1_SAM_TOKEN" "" "$B1_SAM_STEP" '{"label":"B1 Counter Mac"}'
b1_expect 403 "$B1_MANAGER_ONLY" "registering a device as plain staff"
b1_call POST /api/vault/till/devices "$B1_MO_TOKEN" "" "" '{"label":"B1 Counter Mac"}'
b1_expect 403 "$B1_STEP_UP" "registering a device without step-up"
b1_call POST /api/vault/till/devices "$B1_MO_TOKEN" "" "$B1_MO_STEP" '{"label":"  "}'
b1_expect 400 "Give this device a name, such as Counter Mac." "registering a device with no label"
b1_call POST /api/vault/till/devices "$B1_MO_TOKEN" "" "$B1_MO_STEP" '{"label":"B1 Lost","register":"b1nosuchregist"}'
b1_expect 404 "That register was not found." "registering a device to an unknown register"
b1_call POST /api/vault/till/devices "$B1_MO_TOKEN" "" "$B1_MO_STEP" "{\"label\":\"B1 Spare Mac\",\"register\":\"$B1_SPARE\"}"
b1_expect 409 "That register is switched off. Switch it on under Settings first." "registering a device to a switched-off register"
ok "registering a till needs a manager, step-up, a label and a register that is switched on"

b1_call POST /api/vault/till/devices "$B1_MO_TOKEN" "" "$B1_MO_STEP" "{\"label\":\"B1 Counter Mac\",\"register\":\"$B1_COUNTER\"}"
b1_expect 201 "" "registering a device"
B1_DEV1_ID="$(b1_get device.id)"
B1_DEV1_SECRET="$(b1_get secret)"
[ -n "$B1_DEV1_ID" ] || fail "the registration returned no device id: $B1_BODY"
[[ "$B1_DEV1_SECRET" =~ ^[0-9a-f]{64}$ ]] || fail "the device secret is not 64 hex characters: $B1_BODY"
[ "$(b1_get device.register)" = "$B1_COUNTER" ] || fail "the device is not on the register it was registered to: $B1_BODY"
[ "$(b1_get device.register_name)" = "Counter" ] || fail "the registration does not name the register: $B1_BODY"
[ "$(b1_get device.label)" = "B1 Counter Mac" ] || fail "the registration lost the label: $B1_BODY"
[ -n "$(b1_get device.created)" ] || fail "the registration has no created date: $B1_BODY"
B1_DEV1="$B1_DEV1_ID.$B1_DEV1_SECRET"
[ "$(b1_record register_devices "$B1_DEV1_ID" secret_hash)" = "$(b1_sha256 "$B1_DEV1_SECRET")" ] \
  || fail "register_devices.secret_hash is not the sha256 of the secret handed out"
[ "$(b1_record register_devices "$B1_DEV1_ID" created_by)" = "$B1_MO" ] || fail "the device does not record who registered it"
B1_ROWS="$(b1_audit till_device_registered "$B1_DEV1_ID")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] || fail "registering a device left no till_device_registered row: $B1_ROWS"
[ "$(jval items.0.actor <<<"$B1_ROWS")" = "$B1_MO" ] || fail "the till_device_registered row does not name the manager: $B1_ROWS"
[ "$(jval items.0.meta.register <<<"$B1_ROWS")" = "$B1_COUNTER" ] || fail "the till_device_registered row does not name the register: $B1_ROWS"
grep -qF -- "$B1_DEV1_SECRET" <<<"$B1_ROWS" && fail "the device secret reached audit_log"
grep -qF -- "$(b1_sha256 "$B1_DEV1_SECRET")" <<<"$B1_ROWS" && fail "the device secret's hash reached audit_log"
ok "a registered till gets a 64 hex secret once, stored only as its sha256, and is audited without it"

# An admin is a manager too, and no register means the default one.
b1_call POST /api/vault/till/devices "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"label":"B1 Tablet"}'
b1_expect 201 "" "registering a device as an admin with no register"
[ "$(b1_get device.register)" = "$B1_COUNTER" ] || fail "a device registered with no register did not land on the default register: $B1_BODY"
B1_DEV2_ID="$(b1_get device.id)"
B1_DEV2="$B1_DEV2_ID.$(b1_get secret)"
b1_call GET "/api/collections/register_devices/records/$B1_DEV1_ID" "$B1_MO_TOKEN"
b1_expect 200 "" "a manager reading a device through the collection API"
b1_clean "a manager reading a device through the collection API"
b1_call POST /api/collections/register_devices/records "$STAFF_TOKEN" "" "" "{\"register\":\"$B1_COUNTER\",\"label\":\"B1 Forged\",\"secret_hash\":\"$(b1_sha256 forged)\"}"
[ "$B1_STATUS" = "403" ] || [ "$B1_STATUS" = "400" ] || fail "an admin wrote a register_devices row through the collection API ($B1_STATUS): $B1_BODY"
ok "a device registered with no register takes the default one, and the collection API neither shows the secret hash nor writes a device"

# --- 27d. Is this browser still a till? -----------------------------------
b1_call GET /api/vault/till/device "" "$B1_DEV1"
b1_expect 200 "" "the device check"
[ "$(b1_get device.id)" = "$B1_DEV1_ID" ] || fail "the device check named another device: $B1_BODY"
[ "$(b1_get device.label)" = "B1 Counter Mac" ] || fail "the device check lost the label: $B1_BODY"
[ "$(b1_get device.register)" = "$B1_COUNTER" ] || fail "the device check lost the register: $B1_BODY"
[ "$(b1_get device.register_name)" = "Counter" ] || fail "the device check lost the register name: $B1_BODY"
[ "$(b1_get register.id)" = "$B1_COUNTER" ] && [ "$(b1_get register.name)" = "Counter" ] && [ "$(b1_get register.active)" = "true" ] \
  || fail "the device check's register is wrong: $B1_BODY"
b1_clean "the device check"
B1_SEEN="$(b1_record register_devices "$B1_DEV1_ID" last_seen)"
[ -n "$B1_SEEN" ] || fail "the device check did not set last_seen"
b1_call GET /api/vault/till/device "" "$B1_DEV1"
[ "$(b1_record register_devices "$B1_DEV1_ID" last_seen)" = "$B1_SEEN" ] \
  || fail "last_seen was written again within a minute"
ok "the device check answers with the device and its register, and touches last_seen at most once a minute"

b1_call GET /api/vault/till/device
b1_expect 401 "$B1_DEVICE_REFUSAL" "the device check with no header"
b1_call GET /api/vault/till/device "" "not-a-device"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the device check with a malformed header"
b1_call GET /api/vault/till/device "" "$B1_DEV1_ID.$(b1_sha256 wrong-secret)"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the device check with the wrong secret"
b1_call GET /api/vault/till/device "" "$B1_DEV2_ID.$B1_DEV1_SECRET"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the device check with another device's secret"
b1_call GET /api/vault/till/device "" "b1nosuchdevice0.$B1_DEV1_SECRET"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the device check for an unknown device"
ok "an unknown, malformed or mismatched device is refused with the contract's 401"

# --- 27e. The devices list ------------------------------------------------
b1_call GET /api/vault/till/devices "$B1_SAM_TOKEN"
b1_expect 403 "$B1_MANAGER_ONLY" "listing devices as plain staff"
b1_call GET /api/vault/till/devices "$B1_MO_TOKEN"
b1_expect 200 "" "listing devices as a manager"
b1_clean "the devices list"
[ "$(b1_get devices.0.id)" = "$B1_DEV2_ID" ] || fail "the devices list is not newest first: $B1_BODY"
B1_LISTED="$(node -e '
  const d = JSON.parse(process.argv[1]).devices.find((x) => x.id === process.argv[2]);
  process.stdout.write(d ? [d.register, d.register_name, d.label, d.created_by_name, d.last_seen ? "seen" : "", d.revoked_at === null ? "live" : "revoked"].join("|") : "");
' "$B1_BODY" "$B1_DEV1_ID")"
[ "$B1_LISTED" = "$B1_COUNTER|Counter|B1 Counter Mac|Mo Khan|seen|live" ] \
  || fail "the devices list entry for the Mac is wrong ($B1_LISTED): $B1_BODY"
ok "a manager lists the tills newest first with who registered each, when it was last seen and whether it is revoked"

# --- 27f. The roster -------------------------------------------------------
b1_call GET /api/vault/till/roster
b1_expect 401 "$B1_DEVICE_REFUSAL" "the roster with no device"
b1_call GET /api/vault/till/roster "$STAFF_TOKEN"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the roster with an admin token and no device"
b1_call GET /api/vault/till/roster "" "$B1_DEV1"
b1_expect 200 "" "the roster"
b1_clean "the roster"
[ "$(b1_get register.id)" = "$B1_COUNTER" ] && [ "$(b1_get register.name)" = "Counter" ] \
  || fail "the roster does not name the device's register: $B1_BODY"
B1_ACTIVE_COUNT="$(curl -s -G "$BASE/api/collections/staff/records" -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=active = true" --data-urlencode "perPage=1" | jval totalItems)"
[ "$(jlen staff <<<"$B1_BODY")" = "$B1_ACTIVE_COUNT" ] \
  || fail "the roster has $(jlen staff <<<"$B1_BODY") names, expected every active member of staff ($B1_ACTIVE_COUNT)"
node -e '
  const names = JSON.parse(process.argv[1]).staff.map((s) => s.name.toLowerCase());
  const sorted = names.slice().sort();
  if (names.join("\n") !== sorted.join("\n")) { console.error(names.join(", ")); process.exit(1); }
' "$B1_BODY" || fail "the roster is not sorted by name"
B1_MO_ENTRY="$(node -e '
  const s = JSON.parse(process.argv[1]).staff.find((x) => x.id === process.argv[2]);
  process.stdout.write(s ? [s.name, s.initials, s.role, s.pin_set, s.pin_length, s.pin_locked, Object.keys(s).sort().join(",")].join("|") : "");
' "$B1_BODY" "$B1_MO")"
[ "$B1_MO_ENTRY" = "Mo Khan|MK|manager|false|0|false|id,initials,name,pin_length,pin_locked,pin_set,role" ] \
  || fail "the roster entry for Mo Khan is wrong ($B1_MO_ENTRY): $B1_BODY"
ok "the roster lists every active member of staff by name, with initials and PIN state and nothing else"

# --- 27g. Setting PINs ------------------------------------------------------
b1_call POST /api/vault/staff/me/pin "$B1_SAM_TOKEN" "" "" '{"pin":"2580"}'
b1_expect 403 "$B1_STEP_UP" "setting your own PIN without step-up"
b1_call POST /api/vault/staff/me/pin "$B1_SAM_TOKEN" "" "$B1_SAM_STEP" '{"pin":"1234"}'
b1_expect 400 "Choose a PIN that is not a run or a repeat, such as 1234 or 0000." "setting a run as a PIN"
b1_call POST /api/vault/staff/me/pin "$B1_SAM_TOKEN" "" "$B1_SAM_STEP" '{"pin":"12345"}'
b1_expect 400 "A PIN is 4 or 6 digits." "setting a 5 digit PIN"
b1_call POST /api/vault/staff/me/pin "$B1_SAM_TOKEN" "" "$B1_SAM_STEP" '{"pin":2580}'
b1_expect 400 "A PIN is 4 or 6 digits." "setting a PIN sent as a number"
b1_call POST /api/vault/staff/me/pin "$B1_SAM_TOKEN" "" "$B1_SAM_STEP" '{"pin":"2580"}'
b1_expect 204 "" "setting your own PIN"
[ "$(b1_record staff "$B1_SAM" pin_hash)" = "$(b1_pin_hash "$B1_SAM" 2580)" ] \
  || fail "staff.pin_hash is not v1\$ + hs256(id:pin, hs256(\"gg-pin-pepper-v1\", key))"
[ "$(b1_record staff "$B1_SAM" pin_length)" = "4" ] || fail "pin_length is not 4 after a 4 digit PIN"
[ -n "$(b1_record staff "$B1_SAM" pin_set_at)" ] || fail "pin_set_at was not set"
B1_ROWS="$(b1_audit pin_set "$B1_SAM")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.actor <<<"$B1_ROWS")" = "$B1_SAM" ] \
  || fail "setting your own PIN left no pin_set row by its owner: $B1_ROWS"
grep -qF -- "2580" <<<"$B1_ROWS" && fail "the PIN reached audit_log"
grep -qF -- 'v1$' <<<"$B1_ROWS" && fail "the PIN hash reached audit_log"
ok "a member of staff sets their own PIN with step-up, under the PIN rules, stored as the contract's keyed hash"

b1_call POST /api/vault/staff/me/pin "$B1_MO_TOKEN" "" "$B1_MO_STEP" '{"pin":"135790"}'
b1_expect 204 "" "setting a 6 digit PIN"
[ "$(b1_record staff "$B1_MO" pin_length)" = "6" ] || fail "pin_length is not 6 after a 6 digit PIN"

b1_call POST "/api/vault/staff/$B1_LOU/pin" "$B1_SAM_TOKEN" "" "$B1_SAM_STEP" '{"pin":"4826"}'
b1_expect 403 "$B1_ADMIN_ONLY" "plain staff setting somebody else's PIN"
b1_call POST "/api/vault/staff/$B1_LOU/pin" "$B1_MO_TOKEN" "" "$B1_MO_STEP" '{"pin":"4826"}'
b1_expect 403 "$B1_ADMIN_ONLY" "a manager setting somebody else's PIN"
b1_call POST "/api/vault/staff/$B1_LOU/pin" "$STAFF_TOKEN" "" "" '{"pin":"4826"}'
b1_expect 403 "$B1_STEP_UP" "an admin setting a PIN without step-up"
b1_call POST "/api/vault/staff/b1nosuchstaff00/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"4826"}'
b1_expect 404 "That member of staff was not found." "an admin setting an unknown member's PIN"
b1_call POST "/api/vault/staff/$B1_LOU/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"0000"}'
b1_expect 400 "Choose a PIN that is not a run or a repeat, such as 1234 or 0000." "an admin setting a repeat as a PIN"
b1_call POST "/api/vault/staff/$B1_LOU/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"4826"}'
b1_expect 204 "" "an admin setting somebody's PIN"
b1_call POST "/api/vault/staff/$B1_IVY/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"9157"}'
b1_expect 204 "" "an admin setting another PIN"
B1_ROWS="$(b1_audit pin_set "$B1_LOU")"
[ "$(jval items.0.actor <<<"$B1_ROWS")" = "$B1_ADMIN" ] && [ "$(jval items.0.meta.by <<<"$B1_ROWS")" = "$B1_ADMIN" ] \
  || fail "an admin setting a PIN left no pin_set row naming the admin: $B1_ROWS"
[ "$(b1_record staff "$B1_LOU" pin_hash)" = "$(b1_pin_hash "$B1_LOU" 4826)" ] || fail "the admin-set PIN is not hashed for its owner"
ok "only an admin with step-up sets somebody else's PIN, under the same rules, audited as theirs"

b1_call GET "/api/collections/staff/records?perPage=200" "$STAFF_TOKEN"
b1_expect 200 "" "an admin listing staff through the collection API"
b1_clean "an admin listing staff through the collection API"
b1_call GET "/api/collections/staff/records/$B1_SAM" "$STAFF_TOKEN"
b1_clean "an admin viewing a staff record through the collection API"
b1_call GET /api/vault/till/roster "" "$B1_DEV1"
B1_SAM_ENTRY="$(node -e '
  const s = JSON.parse(process.argv[1]).staff.find((x) => x.id === process.argv[2]);
  const m = JSON.parse(process.argv[1]).staff.find((x) => x.id === process.argv[3]);
  process.stdout.write([s.pin_set, s.pin_length, m.pin_set, m.pin_length].join("|"));
' "$B1_BODY" "$B1_SAM" "$B1_MO")"
[ "$B1_SAM_ENTRY" = "true|4|true|6" ] || fail "the roster does not show the PINs and their lengths ($B1_SAM_ENTRY)"
ok "pin_hash stays out of the collection API, and the roster shows each PIN's length"

# --- 27h. Unlocking ---------------------------------------------------------
b1_call POST /api/vault/till/unlock "" "$B1_DEV1" "" '{"pin":"2580"}'
b1_expect 400 "Choose your name first." "unlocking with no name"
b1_call POST /api/vault/till/unlock "" "$B1_DEV1" "" "{\"staff\":\"$B1_SAM\"}"
b1_expect 400 "Key your PIN." "unlocking with no PIN"
b1_unlock "$B1_DEV1" b1nosuchstaff00 2580
b1_expect 404 "" "unlocking as an unknown member of staff"
b1_unlock "$B1_DEV1" "$B1_ANA" 2580
b1_expect 409 "Ana Ruiz has no PIN yet. Sign in with a password to set one." "unlocking with no PIN set"
b1_unlock "" "$B1_SAM" 2580
b1_expect 401 "$B1_DEVICE_REFUSAL" "unlocking from an unregistered browser"
ok "unlock refuses a missing name or PIN, an unknown person, nobody's PIN and an unregistered browser"

b1_unlock "$B1_DEV1" "$B1_SAM" 2580
b1_expect 200 "" "unlocking with the right PIN"
b1_clean "the unlock response"
B1_SAM_PIN_TOKEN="$(b1_get token)"
[ -n "$B1_SAM_PIN_TOKEN" ] || fail "the unlock returned no token: $B1_BODY"
[ "$(b1_get record.id)" = "$B1_SAM" ] && [ "$(b1_get record.collectionName)" = "staff" ] \
  || fail "the unlock did not return Sam's own record as a sign-in does: $B1_BODY"
[ "$(curl -s "$BASE/api/vault/me" -H "Authorization: $B1_SAM_PIN_TOKEN" | jval id)" = "$B1_SAM" ] \
  || fail "the token from a PIN unlock does not work as Sam's"
B1_ROWS="$(b1_audit pin_unlock "$B1_SAM")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] || fail "an unlock left no pin_unlock row: $B1_ROWS"
[ "$(jval items.0.meta.device <<<"$B1_ROWS")" = "$B1_DEV1_ID" ] && [ "$(jval items.0.meta.register <<<"$B1_ROWS")" = "$B1_COUNTER" ] \
  || fail "the pin_unlock row does not name the device and the register: $B1_ROWS"
ok "the right PIN on a registered till returns the same { token, record } a password sign-in does, audited with the device and register"

b1_unlock "$B1_DEV1" "$B1_SAM" 1357
b1_expect 401 "That PIN is not right. 4 tries left." "a first wrong PIN"
b1_unlock "$B1_DEV1" "$B1_SAM" 1357
b1_expect 401 "That PIN is not right. 3 tries left." "a second wrong PIN"
[ "$(b1_record staff "$B1_SAM" pin_failures)" = "2" ] || fail "two wrong PINs did not leave pin_failures at 2"
b1_unlock "$B1_DEV1" "$B1_SAM" 2580
b1_expect 200 "" "the right PIN after two wrong ones"
[ "$(b1_record staff "$B1_SAM" pin_failures)" = "0" ] || fail "the right PIN did not reset pin_failures"
B1_ROWS="$(b1_audit pin_failed "$B1_SAM")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "2" ] || fail "two wrong PINs did not leave two pin_failed rows: $B1_ROWS"
[ "$(jval items.0.actor <<<"$B1_ROWS")" = "device:$B1_DEV1_ID" ] || fail "a wrong unlock PIN is not put down to the device: $B1_ROWS"
[ "$(jval items.0.meta.device <<<"$B1_ROWS")" = "$B1_DEV1_ID" ] && [ "$(jval items.0.meta.register <<<"$B1_ROWS")" = "$B1_COUNTER" ] \
  || fail "the pin_failed row does not name the device and the register: $B1_ROWS"
grep -qF -- "1357" <<<"$B1_ROWS" && fail "a wrong PIN reached audit_log"
ok "a wrong PIN counts down from five, audited with the device and register, and the right one resets the count"

# Two wrong PINs at the same moment both count.
curl -s -o "$TMP_DIR/b1-race-a.json" -X POST "$BASE/api/vault/till/unlock" -H "X-GG-Device: $B1_DEV1" \
  -H "Content-Type: application/json" -d "{\"staff\":\"$B1_SAM\",\"pin\":\"9753\"}" &
B1_RACE_A=$!
curl -s -o "$TMP_DIR/b1-race-b.json" -X POST "$BASE/api/vault/till/unlock" -H "X-GG-Device: $B1_DEV1" \
  -H "Content-Type: application/json" -d "{\"staff\":\"$B1_SAM\",\"pin\":\"9753\"}" &
B1_RACE_B=$!
wait "$B1_RACE_A" "$B1_RACE_B"
[ "$(b1_record staff "$B1_SAM" pin_failures)" = "2" ] \
  || fail "two wrong PINs sent at once left pin_failures at $(b1_record staff "$B1_SAM" pin_failures), expected 2"
B1_RACE_SAID="$( (jval message <"$TMP_DIR/b1-race-a.json"; echo; jval message <"$TMP_DIR/b1-race-b.json"; echo) | sort | tr '\n' '|')"
[ "$B1_RACE_SAID" = "That PIN is not right. 3 tries left.|That PIN is not right. 4 tries left.|" ] \
  || fail "two wrong PINs at once did not count one after the other: $B1_RACE_SAID"
b1_unlock "$B1_DEV1" "$B1_SAM" 2580
b1_expect 200 "" "the right PIN after the race"
ok "two wrong PINs sent at the same moment both count"

# Five wrong PINs lock it; locked, even the right PIN is refused and counts nothing.
for B1_LEFT in 4 3 2; do
  b1_unlock "$B1_DEV1" "$B1_LOU" 1593
  b1_expect 401 "That PIN is not right. $B1_LEFT tries left." "a wrong PIN with $B1_LEFT left"
done
b1_unlock "$B1_DEV1" "$B1_LOU" 1593
b1_expect 401 "That PIN is not right. 1 try left." "the fourth wrong PIN"
b1_unlock "$B1_DEV1" "$B1_LOU" 1593
b1_expect 423 "$B1_LOCKED" "the fifth wrong PIN"
[ "$(b1_record staff "$B1_LOU" pin_locked)" = "true" ] || fail "the fifth wrong PIN did not set pin_locked"
b1_unlock "$B1_DEV1" "$B1_LOU" 4826
b1_expect 423 "$B1_LOCKED" "the right PIN while locked"
b1_unlock "$B1_DEV1" "$B1_LOU" 1593
b1_expect 423 "$B1_LOCKED" "a wrong PIN while locked"
[ "$(b1_record staff "$B1_LOU" pin_failures)" = "5" ] || fail "attempts while locked moved pin_failures off 5"
[ "$(b1_audit_count pin_locked "$B1_LOU")" = "1" ] || fail "locking a PIN left no single pin_locked row"
B1_ROWS="$(b1_audit pin_failed "$B1_LOU")"
B1_FAILED="$(node -e '
  const rows = JSON.parse(process.argv[1]).items;
  process.stdout.write(rows.filter((r) => !r.meta.locked).length + "|" + rows.filter((r) => r.meta.locked).length);
' "$B1_ROWS")"
[ "$B1_FAILED" = "4|2" ] || fail "expected four counted pin_failed rows and two attempts while locked, got $B1_FAILED: $B1_ROWS"
b1_call GET /api/vault/till/roster "" "$B1_DEV1"
[ "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).staff.find((x) => x.id === process.argv[2]).pin_locked))' "$B1_BODY" "$B1_LOU")" = "true" ] \
  || fail "the roster does not show Lou's PIN as locked"
ok "the fifth wrong PIN locks it with 423; while locked every attempt is 423 and counts nothing"

# A token refresh is not a password sign-in and clears nothing.
b1_call POST /api/collections/staff/auth-refresh "$B1_LOU_TOKEN"
b1_expect 200 "" "Lou refreshing a token"
[ "$(b1_record staff "$B1_LOU" pin_locked)" = "true" ] || fail "a token refresh cleared a PIN lock"
# A password sign-in does.
B1_LOU_AUTH="$(b1_sign_in b1-lou@local.test)"
[ -n "$(jval token <<<"$B1_LOU_AUTH")" ] || fail "Lou could not sign in with a password: $B1_LOU_AUTH"
[ "$(jval record.pin_locked <<<"$B1_LOU_AUTH")" = "false" ] && [ "$(jval record.pin_failures <<<"$B1_LOU_AUTH")" = "0" ] \
  || fail "the password sign-in response still shows the PIN locked: $B1_LOU_AUTH"
B1_LOU_TOKEN="$(jval token <<<"$B1_LOU_AUTH")"
[ "$(b1_record staff "$B1_LOU" pin_locked)" = "false" ] && [ "$(b1_record staff "$B1_LOU" pin_failures)" = "0" ] \
  || fail "a password sign-in did not clear pin_locked and pin_failures"
B1_ROWS="$(b1_audit pin_lock_cleared "$B1_LOU")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.meta.was_locked <<<"$B1_ROWS")" = "true" ] \
  && [ "$(jval items.0.meta.method <<<"$B1_ROWS")" = "password" ] \
  || fail "clearing a lock with a password left no pin_lock_cleared row: $B1_ROWS"
b1_unlock "$B1_DEV1" "$B1_LOU" 4826
b1_expect 200 "" "the right PIN after a password sign-in"
b1_sign_in b1-lou@local.test >/dev/null
[ "$(b1_audit_count pin_lock_cleared "$B1_LOU")" = "1" ] || fail "a password sign-in with nothing to clear still wrote a row"
ok "a password sign-in clears a PIN lock and is audited; a token refresh does not, and a clean sign-in writes nothing"

# An admin's PIN reset clears the lock too.
for B1_N in 1 2 3 4 5; do b1_unlock "$B1_DEV1" "$B1_LOU" 1593; done
b1_expect 423 "$B1_LOCKED" "the fifth wrong PIN again"
b1_call POST "/api/vault/staff/$B1_LOU/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"7391"}'
b1_expect 204 "" "an admin resetting a locked PIN"
[ "$(b1_record staff "$B1_LOU" pin_locked)" = "false" ] && [ "$(b1_record staff "$B1_LOU" pin_failures)" = "0" ] \
  || fail "an admin PIN reset did not clear the lock"
[ "$(b1_audit pin_set "$B1_LOU" | jval items.0.meta.unlocked)" = "true" ] || fail "the reset's pin_set row does not say it cleared a lock"
b1_unlock "$B1_DEV1" "$B1_LOU" 4826
b1_expect 401 "That PIN is not right. 4 tries left." "the old PIN after a reset"
b1_unlock "$B1_DEV1" "$B1_LOU" 7391
b1_expect 200 "" "the new PIN after a reset"
ok "an admin's PIN reset clears the lock, and only the new PIN works"

# --- 27i. Manager approval ----------------------------------------------------
B1_OVERRIDE='{"capability":"refund","approver":"'"$B1_MO"'","pin":"135790","context":{"sale":"b1-sale-0001","amount":1500,"reason":"Faulty pack"}}'
b1_call POST /api/vault/till/override "" "$B1_DEV1" "" "$B1_OVERRIDE"
b1_expect 401 "" "an approval with no staff token"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "" "" "$B1_OVERRIDE"
b1_expect 401 "$B1_DEVICE_REFUSAL" "an approval from an unregistered browser"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"fly","approver":"'"$B1_MO"'","pin":"135790"}'
b1_expect 400 "" "an approval for an unknown capability"
for B1_CAP in staff_manage settings_manage; do
  b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"'"$B1_CAP"'","approver":"'"$B1_ADMIN"'","pin":"135790"}'
  b1_expect 403 "That needs an admin signed in." "an approval for $B1_CAP"
done
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","pin":"135790"}'
b1_expect 400 "Choose who is approving this." "an approval naming no approver"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"'"$B1_MO"'"}'
b1_expect 400 "Key the approver's PIN." "an approval with no PIN"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"'"$B1_MO"'","pin":"135790","context":{"amount":12.5}}'
b1_expect 400 "The amount must be a whole number of pence." "an approval with a fractional amount"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"b1nosuchstaff00","pin":"135790"}'
b1_expect 404 "" "an approval by an unknown approver"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"void_line","approver":"'"$B1_SAM"'","pin":"2580"}'
b1_expect 403 "You cannot approve your own request. Ask somebody else to key their PIN." "approving your own request"
ok "an approval needs a staff token, a registered till, a known capability other than the two admin ones, an approver and a PIN"

b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"'"$B1_LOU"'","pin":"1593"}'
b1_expect 403 "Lou Park cannot approve that. Ask somebody who can give a refund." "an approval by somebody without the capability"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"z_report","approver":"'"$B1_LOU"'","pin":"1593"}'
b1_expect 403 "Lou Park cannot approve that. Ask somebody who can run the Z report and cash up." "a Z report approval by plain staff"
[ "$(b1_record staff "$B1_LOU" pin_failures)" = "0" ] || fail "a PIN for somebody who could not approve anyway was counted"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"'"$B1_KIT"'","pin":"2468"}'
b1_expect 409 "Kit Lane has no PIN yet. Sign in with a password to set one." "an approval by a manager with no PIN"
ok "an approver must hold the capability (checked before their PIN is tried) and have a PIN"

b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"'"$B1_MO"'","pin":"864200"}'
b1_expect 401 "That PIN is not right. 4 tries left." "an approval with the approver's wrong PIN"
[ "$(b1_record staff "$B1_MO" pin_failures)" = "1" ] || fail "a wrong approval PIN did not count toward the approver's own failures"
B1_ROWS="$(b1_audit pin_failed "$B1_MO")"
[ "$(jval items.0.actor <<<"$B1_ROWS")" = "$B1_SAM" ] && [ "$(jval items.0.meta.purpose <<<"$B1_ROWS")" = "override" ] \
  && [ "$(jval items.0.meta.capability <<<"$B1_ROWS")" = "refund" ] \
  || fail "a wrong approval PIN is not audited against the approver, by the requester: $B1_ROWS"

B1_BEFORE_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" "$B1_OVERRIDE"
b1_expect 200 "" "an approval with the right PIN"
B1_GRANT_TOKEN="$(b1_get token)"
B1_GRANT_EXPIRES="$(b1_get expires_at)"
[ -n "$B1_GRANT_TOKEN" ] || fail "the approval returned no token: $B1_BODY"
[ "$(b1_get capability)" = "refund" ] && [ "$(b1_get approver.id)" = "$B1_MO" ] && [ "$(b1_get approver.name)" = "Mo Khan" ] \
  || fail "the approval body is wrong: $B1_BODY"
node -e '
  const before = Number(process.argv[1]);
  const at = Date.parse(process.argv[2]);
  const ahead = at - before;
  if (!(ahead > 4.5 * 60000 && ahead < 5.5 * 60000)) { console.error(process.argv[2]); process.exit(1); }
' "$B1_BEFORE_MS" "$B1_GRANT_EXPIRES" || fail "the approval does not expire five minutes ahead: $B1_GRANT_EXPIRES"
[ "$(b1_record staff "$B1_MO" pin_failures)" = "0" ] || fail "the approver's right PIN did not reset their failures"

B1_GRANT_ROW="$(curl -s -G "$BASE/api/collections/till_overrides/records" -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=token_hash = \"$(b1_sha256 "$B1_GRANT_TOKEN")\"")"
[ "$(jval totalItems <<<"$B1_GRANT_ROW")" = "1" ] || fail "no till_overrides row has token_hash = sha256(token): $B1_GRANT_ROW"
B1_GRANT="$(node -e '
  const r = JSON.parse(process.argv[1]).items[0];
  process.stdout.write([r.capability, r.requested_by, r.approver, r.register, r.device, r.context.sale, r.context.amount, r.context.reason, r.used_at, Date.parse(r.expires_at.replace(" ", "T")) === Date.parse(process.argv[2])].join("|"));
' "$B1_GRANT_ROW" "$B1_GRANT_EXPIRES")"
[ "$B1_GRANT" = "refund|$B1_SAM|$B1_MO|$B1_COUNTER|$B1_DEV1_ID|b1-sale-0001|1500|Faulty pack||true" ] \
  || fail "the till_overrides row is wrong ($B1_GRANT): $B1_GRANT_ROW"
B1_GRANT_ID="$(jval items.0.id <<<"$B1_GRANT_ROW")"
B1_ROWS="$(b1_audit override_granted "$B1_GRANT_ID")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] || fail "an approval left no override_granted row: $B1_ROWS"
[ "$(jval items.0.actor <<<"$B1_ROWS")" = "$B1_SAM" ] && [ "$(jval items.0.meta.approver <<<"$B1_ROWS")" = "$B1_MO" ] \
  && [ "$(jval items.0.meta.capability <<<"$B1_ROWS")" = "refund" ] && [ "$(jval items.0.meta.device <<<"$B1_ROWS")" = "$B1_DEV1_ID" ] \
  || fail "the override_granted row does not name both people, the capability and the device: $B1_ROWS"
grep -qF -- "$B1_GRANT_TOKEN" <<<"$B1_ROWS" && fail "the approval token reached audit_log"
grep -qF -- "135790" <<<"$B1_ROWS" && fail "the approver's PIN reached audit_log"
grep -qF -- "Faulty pack" <<<"$B1_ROWS" && fail "the free-text reason reached audit_log"
b1_call GET /api/collections/till_overrides/records "$STAFF_TOKEN"
[ "$B1_STATUS" = "403" ] || fail "an admin read till_overrides through the collection API ($B1_STATUS): $B1_BODY"
ok "the right approver PIN issues a five minute token, stored as its sha256 with the capability, both people, the till and the context, audited without the token"

# The approver's own failures lock the approver, through the approval route.
b1_call POST "/api/vault/staff/$B1_KIT/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"2468"}'
b1_expect 204 "" "an admin setting Kit's PIN"
for B1_N in 1 2 3 4; do
  b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"no_sale","approver":"'"$B1_KIT"'","pin":"9999"}'
done
b1_expect 401 "That PIN is not right. 1 try left." "the approver's fourth wrong PIN"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"no_sale","approver":"'"$B1_KIT"'","pin":"9999"}'
b1_expect 423 "$B1_LOCKED" "the approver's fifth wrong PIN"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"no_sale","approver":"'"$B1_KIT"'","pin":"2468"}'
b1_expect 423 "$B1_LOCKED" "a locked approver's right PIN"
b1_unlock "$B1_DEV1" "$B1_KIT" 2468
b1_expect 423 "$B1_LOCKED" "unlocking as an approver locked through approvals"
[ "$(b1_audit_count pin_locked "$B1_KIT")" = "1" ] || fail "locking an approver left no pin_locked row"
ok "an approver's wrong PINs count toward their own lock, which then refuses both approval and unlock"

# --- 27j. Revoking a till -----------------------------------------------------
b1_call DELETE "/api/vault/till/devices/$B1_DEV2_ID" "$B1_SAM_TOKEN"
b1_expect 403 "$B1_MANAGER_ONLY" "revoking a device as plain staff"
b1_call DELETE /api/vault/till/devices/b1nosuchdevice0 "$B1_MO_TOKEN"
b1_expect 404 "That device was not found." "revoking an unknown device"
b1_call DELETE "/api/vault/till/devices/$B1_DEV2_ID" "$B1_MO_TOKEN"
b1_expect 204 "" "revoking a device"
[ -n "$(b1_record register_devices "$B1_DEV2_ID" revoked_at)" ] || fail "revoking a device did not set revoked_at"
B1_ROWS="$(b1_audit till_device_revoked "$B1_DEV2_ID")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.actor <<<"$B1_ROWS")" = "$B1_MO" ] \
  || fail "revoking a device left no till_device_revoked row by the manager: $B1_ROWS"
b1_call GET /api/vault/till/device "" "$B1_DEV2"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the device check on a revoked device"
b1_call GET /api/vault/till/roster "" "$B1_DEV2"
b1_expect 401 "$B1_DEVICE_REFUSAL" "the roster on a revoked device"
b1_unlock "$B1_DEV2" "$B1_SAM" 2580
b1_expect 401 "$B1_DEVICE_REFUSAL" "unlocking on a revoked device"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV2" "" "$B1_OVERRIDE"
b1_expect 401 "$B1_DEVICE_REFUSAL" "an approval on a revoked device"
b1_call DELETE "/api/vault/till/devices/$B1_DEV2_ID" "$B1_MO_TOKEN"
b1_expect 204 "" "revoking a device twice"
[ "$(b1_audit_count till_device_revoked "$B1_DEV2_ID")" = "1" ] || fail "revoking a device twice wrote a second row"
b1_call GET /api/vault/till/devices "$B1_MO_TOKEN"
[ -n "$(node -e 'const d = JSON.parse(process.argv[1]).devices.find((x) => x.id === process.argv[2]); process.stdout.write(d && d.revoked_at ? d.revoked_at : "")' "$B1_BODY" "$B1_DEV2_ID")" ] \
  || fail "the devices list does not show the revoked device as revoked: $B1_BODY"
b1_call GET /api/vault/till/device "" "$B1_DEV1"
b1_expect 200 "" "the other device after a revoke"
ok "a manager revokes a till once and audited; its next device request, roster, unlock or approval is 401, and the other till carries on"

# --- 27k. Staff management ----------------------------------------------------
b1_call GET /api/vault/staff "$B1_MO_TOKEN"
b1_expect 403 "$B1_ADMIN_ONLY" "a manager listing staff"
b1_call GET /api/vault/staff "$STAFF_TOKEN"
b1_expect 200 "" "an admin listing staff"
b1_clean "the staff list"
B1_SAM_ROW="$(node -e '
  const s = JSON.parse(process.argv[1]).staff.find((x) => x.id === process.argv[2]);
  process.stdout.write([s.name, s.email, s.role, s.active, s.pin_set, s.pin_locked, s.must_change_password, s.created ? "dated" : "", Object.keys(s).sort().join(",")].join("|"));
' "$B1_BODY" "$B1_SAM")"
[ "$B1_SAM_ROW" = "Sam Bell|b1-sam@local.test|staff|true|true|false|false|dated|active,created,email,id,must_change_password,name,pin_locked,pin_set,role" ] \
  || fail "the staff list's entry for Sam is wrong ($B1_SAM_ROW)"
ok "only an admin lists staff, with the contract's fields and no secrets"

B1_NEW='{"name":"Nia Cole","email":"b1-nia@local.test","role":"staff","password":"b1-temporary-pass-01"}'
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "" "$B1_NEW"
b1_expect 403 "$B1_STEP_UP" "adding staff without step-up"
b1_call POST /api/vault/staff "$B1_MO_TOKEN" "" "$B1_MO_STEP" "$B1_NEW"
b1_expect 403 "$B1_ADMIN_ONLY" "a manager adding staff"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Nia Cole","email":"b1-nia@local.test","role":"staff","password":"short-pass"}'
b1_expect 400 "$B1_PASSWORD_RULE" "adding staff with a short password"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Nia Cole","email":"b1-nia@local.test","role":"boss","password":"b1-temporary-pass-01"}'
b1_expect 400 "Choose a role: staff, manager or admin." "adding staff with an unknown role"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Nia Cole","email":"not-an-email","role":"staff","password":"b1-temporary-pass-01"}'
b1_expect 400 "Enter a valid email address." "adding staff with a bad email"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":" ","email":"b1-nia@local.test","role":"staff","password":"b1-temporary-pass-01"}'
b1_expect 400 "Enter their name." "adding staff with no name"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Sam Again","email":"B1-SAM@local.test","role":"staff","password":"b1-temporary-pass-01"}'
b1_expect 409 "Somebody already uses that email." "adding staff with an email already in use"
# An address saved from /_/ keeps its case; the same address in lower case
# is still somebody already using it.
B1_MIXED="$(b1_make_staff "Max Ford" B1-Max.Ford@Local.Test staff)"
[ -n "$B1_MIXED" ] || fail "could not create a staff member with a mixed-case email"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Max Again","email":"b1-max.ford@local.test","role":"staff","password":"b1-temporary-pass-01"}'
b1_expect 409 "Somebody already uses that email." "adding staff whose email is on file in another case"
b1_call POST /api/vault/staff "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" "$B1_NEW"
b1_expect 201 "" "adding staff"
b1_clean "adding staff"
B1_NIA="$(b1_get staff.id)"
[ -n "$B1_NIA" ] || fail "adding staff returned no id: $B1_BODY"
[ "$(b1_get staff.name)|$(b1_get staff.email)|$(b1_get staff.role)|$(b1_get staff.active)|$(b1_get staff.must_change_password)|$(b1_get staff.pin_set)" \
  = "Nia Cole|b1-nia@local.test|staff|true|true|false" ] || fail "the new staff member is wrong: $B1_BODY"
B1_ROWS="$(b1_audit staff_created "$B1_NIA")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.meta.by <<<"$B1_ROWS")" = "$B1_ADMIN" ] \
  || fail "adding staff left no staff_created row naming the admin: $B1_ROWS"
grep -qF -- "b1-temporary-pass-01" <<<"$B1_ROWS" && fail "the new password reached audit_log"
ok "an admin with step-up adds a member of staff, under the 12 character rule, with must_change_password set"

# The new member signs in, is held on the password screen, and leaves it
# through their own password route. A PIN unlock gets them the same token.
B1_NIA_AUTH="$(b1_sign_in b1-nia@local.test b1-temporary-pass-01)"
B1_NIA_TOKEN="$(jval token <<<"$B1_NIA_AUTH")"
[ -n "$B1_NIA_TOKEN" ] && [ "$(jval record.must_change_password <<<"$B1_NIA_AUTH")" = "true" ] \
  || fail "the new member could not sign in, or the flag was not on their record: $B1_NIA_AUTH"
b1_call GET /api/vault/me "$B1_NIA_TOKEN"
b1_expect 403 "Set a new password before doing anything else." "a new member reaching anything else first"
b1_call POST "/api/vault/staff/$B1_NIA/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"pin":"3141"}'
b1_expect 204 "" "an admin setting the new member's PIN"
b1_unlock "$B1_DEV1" "$B1_NIA" 3141
b1_expect 200 "" "unlocking as a member who must change their password"
[ "$(b1_get record.must_change_password)" = "true" ] || fail "the PIN unlock did not hand the flag back for the counter's guard: $B1_BODY"
# The till still answers with that locked token attached, so somebody else
# can switch user there.
b1_call GET /api/vault/till/roster "$B1_NIA_TOKEN" "$B1_DEV1"
b1_expect 200 "" "the roster with a locked account's token attached"
b1_call GET /api/vault/till/device "$B1_NIA_TOKEN" "$B1_DEV1"
b1_expect 200 "" "the device check with a locked account's token attached"
b1_call POST /api/vault/till/unlock "$B1_NIA_TOKEN" "$B1_DEV1" "" "{\"staff\":\"$B1_SAM\",\"pin\":\"2580\"}"
b1_expect 200 "" "switching user with a locked account's token attached"
[ "$(b1_get record.id)" = "$B1_SAM" ] || fail "switching user from a locked account did not sign Sam in: $B1_BODY"
b1_call POST /api/vault/till/override "$B1_NIA_TOKEN" "$B1_DEV1" "" '{"capability":"refund","approver":"'"$B1_MO"'","pin":"135790"}'
b1_expect 403 "Set a new password before doing anything else." "an approval requested by a locked account"
b1_call POST /api/vault/staff/me/password "$B1_NIA_TOKEN" "" "" '{"old_password":"not-my-password-1","password":"b1-nia-own-password-1"}'
b1_expect 400 "That is not your current password." "changing your password with the wrong old one"
b1_call POST /api/vault/staff/me/password "$B1_NIA_TOKEN" "" "" '{"old_password":"b1-temporary-pass-01","password":"b1-temporary-pass-01"}'
b1_expect 400 "$B1_PASSWORD_RULE" "changing your password to the same one"
b1_call POST /api/vault/staff/me/password "$B1_NIA_TOKEN" "" "" '{"old_password":"b1-temporary-pass-01","password":"too-short"}'
b1_expect 400 "$B1_PASSWORD_RULE" "changing your password to a short one"
b1_call POST /api/vault/staff/me/password "$B1_NIA_TOKEN" "" "" '{"old_password":"b1-temporary-pass-01","password":"b1-nia-own-password-1"}'
b1_expect 204 "" "changing your own password"
b1_call GET /api/vault/me "$B1_NIA_TOKEN"
b1_expect 401 "" "the old token after a password change"
[ "$(b1_record staff "$B1_NIA" must_change_password)" = "false" ] || fail "an own password change did not clear must_change_password"
B1_ROWS="$(b1_audit staff_password_changed "$B1_NIA")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.meta.fields <<<"$B1_ROWS")" = "password,must_change_password" ] \
  || fail "an own password change left no staff_password_changed row with its fields: $B1_ROWS"
grep -qF -- "b1-nia-own-password-1" <<<"$B1_ROWS" && fail "the new password reached audit_log"
B1_NIA_AUTH="$(b1_sign_in b1-nia@local.test b1-nia-own-password-1)"
[ "$(jval record.must_change_password <<<"$B1_NIA_AUTH")" = "false" ] || fail "the new member could not sign in with their own password: $B1_NIA_AUTH"
ok "a new member is held on the password screen, unlocks by PIN with the flag still on, and clears it through their own password route"

b1_call POST /api/vault/staff/me/password "$B1_SAM_TOKEN" "" "" '{"old_password":"'"$B1_PASSWORD"'","password":"b1-sam-new-password-1"}'
b1_expect 204 "" "plain staff changing their own password"
B1_SAM_TOKEN="$(b1_sign_in b1-sam@local.test b1-sam-new-password-1 | jval token)"
[ -n "$B1_SAM_TOKEN" ] || fail "Sam could not sign in with the new password"
ok "plain staff change their own password without the admin-only collection rule"

b1_call PATCH "/api/vault/staff/$B1_NIA" "$B1_MO_TOKEN" "" "$B1_MO_STEP" '{"name":"Nia Cole-Hart"}'
b1_expect 403 "$B1_ADMIN_ONLY" "a manager editing staff"
b1_call PATCH "/api/vault/staff/$B1_NIA" "$STAFF_TOKEN" "" "" '{"name":"Nia Cole-Hart"}'
b1_expect 403 "$B1_STEP_UP" "editing staff without step-up"
b1_call PATCH /api/vault/staff/b1nosuchstaff00 "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Nobody"}'
b1_expect 404 "That member of staff was not found." "editing an unknown member"
b1_call PATCH "/api/vault/staff/$B1_NIA" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{}'
b1_expect 400 "There is nothing to change. Send a name, a role or active." "an edit with nothing in it"
b1_call PATCH "/api/vault/staff/$B1_NIA" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"role":"boss"}'
b1_expect 400 "Choose a role: staff, manager or admin." "an edit to an unknown role"
b1_call PATCH "/api/vault/staff/$B1_NIA" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"active":"no"}'
b1_expect 400 "Say whether the account is active with true or false." "an edit with a non-boolean active"
b1_call PATCH "/api/vault/staff/$B1_NIA" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Nia Cole-Hart","role":"manager"}'
b1_expect 200 "" "renaming and promoting a member"
b1_clean "editing staff"
[ "$(b1_get staff.name)|$(b1_get staff.role)" = "Nia Cole-Hart|manager" ] || fail "the edit did not save: $B1_BODY"
B1_ROWS="$(b1_audit staff_updated "$B1_NIA")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.meta.fields <<<"$B1_ROWS")" = "name,role" ] \
  && [ "$(jval items.0.meta.by <<<"$B1_ROWS")" = "$B1_ADMIN" ] \
  || fail "an edit left no staff_updated row with the changed field names: $B1_ROWS"
b1_call PATCH "/api/vault/staff/$B1_NIA" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"name":"Nia Cole-Hart"}'
b1_expect 200 "" "an edit that changes nothing"
[ "$(b1_audit_count staff_updated "$B1_NIA")" = "1" ] || fail "an edit that changed nothing was audited"
ok "an admin with step-up renames and changes roles, audited by field name, and an edit that changes nothing writes nothing"

b1_call PATCH "/api/vault/staff/$B1_IVY" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"active":false}'
b1_expect 200 "" "deactivating a member"
[ "$(b1_get staff.active)" = "false" ] || fail "the deactivation did not save: $B1_BODY"
b1_call GET /api/vault/me "$B1_IVY_TOKEN"
b1_expect 401 "" "a deactivated member's old token"
b1_call GET /api/vault/till/roster "" "$B1_DEV1"
grep -qF -- "$B1_IVY" <<<"$B1_BODY" && fail "a deactivated member is still on the roster: $B1_BODY"
b1_unlock "$B1_DEV1" "$B1_IVY" 9157
b1_expect 403 "$B1_INACTIVE" "unlocking as a deactivated member"
b1_call POST /api/vault/till/override "$B1_SAM_TOKEN" "$B1_DEV1" "" '{"capability":"void_line","approver":"'"$B1_IVY"'","pin":"9157"}'
b1_expect 403 "$B1_INACTIVE" "an approval by a deactivated member"
b1_call PATCH "/api/vault/staff/$B1_IVY" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"active":true}'
b1_expect 200 "" "reactivating a member"
[ "$(b1_audit staff_updated "$B1_IVY" | jval totalItems)" = "2" ] || fail "deactivating and reactivating did not leave two staff_updated rows"
b1_unlock "$B1_DEV1" "$B1_IVY" 9157
b1_expect 200 "" "unlocking after reactivation"
ok "deactivating somebody ends their tokens and takes them off the roster, unlock (403) and approval (403); reactivating restores them"

b1_call POST "/api/vault/staff/$B1_LOU/password" "$B1_MO_TOKEN" "" "$B1_MO_STEP" '{"password":"b1-lou-temporary-02"}'
b1_expect 403 "$B1_ADMIN_ONLY" "a manager setting a password"
b1_call POST "/api/vault/staff/$B1_LOU/password" "$STAFF_TOKEN" "" "" '{"password":"b1-lou-temporary-02"}'
b1_expect 403 "$B1_STEP_UP" "setting a password without step-up"
b1_call POST /api/vault/staff/b1nosuchstaff00/password "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"password":"b1-lou-temporary-02"}'
b1_expect 404 "That member of staff was not found." "setting an unknown member's password"
b1_call POST "/api/vault/staff/$B1_ADMIN/password" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"password":"b1-admin-temporary-02"}'
b1_expect 400 "Change your own password from your account, with your current one." "an admin resetting their own password"
b1_call POST "/api/vault/staff/$B1_LOU/password" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"password":"b1-short"}'
b1_expect 400 "$B1_PASSWORD_RULE" "setting a short password"
b1_call POST "/api/vault/staff/$B1_LOU/password" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"password":"'"$B1_PASSWORD"'"}'
b1_expect 400 "$B1_PASSWORD_RULE" "setting the password they already have"
b1_call POST "/api/vault/staff/$B1_LOU/password" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP" '{"password":"b1-lou-temporary-02"}'
b1_expect 204 "" "an admin setting a temporary password"
[ "$(b1_record staff "$B1_LOU" must_change_password)" = "true" ] || fail "a temporary password did not set must_change_password"
b1_call GET /api/vault/me "$B1_LOU_TOKEN"
b1_expect 401 "" "the member's old token after a password reset"
[ "$(b1_sign_in b1-lou@local.test b1-lou-temporary-02 | jval record.must_change_password)" = "true" ] \
  || fail "the member could not sign in with the temporary password"
B1_ROWS="$(b1_audit staff_password_set "$B1_LOU")"
[ "$(jval totalItems <<<"$B1_ROWS")" = "1" ] && [ "$(jval items.0.meta.by <<<"$B1_ROWS")" = "$B1_ADMIN" ] \
  && [ "$(jval items.0.meta.fields <<<"$B1_ROWS")" = "password,must_change_password" ] \
  || fail "a temporary password left no staff_password_set row naming the admin: $B1_ROWS"
grep -qF -- "b1-lou-temporary-02" <<<"$B1_ROWS" && fail "the temporary password reached audit_log"
ok "an admin with step-up sets a temporary password under the same rule, which ends the member's tokens and sets must_change_password"

# --- 27l. Clearing PINs ----------------------------------------------------------
B1_SAM_STEP="$(b1_step_up "$B1_SAM_TOKEN" b1-sam-new-password-1)"
b1_call DELETE /api/vault/staff/me/pin "$B1_SAM_TOKEN"
b1_expect 403 "$B1_STEP_UP" "clearing your own PIN without step-up"
b1_call DELETE /api/vault/staff/me/pin "$B1_SAM_TOKEN" "" "$B1_SAM_STEP"
b1_expect 204 "" "clearing your own PIN"
[ "$(b1_record staff "$B1_SAM" pin_hash)|$(b1_record staff "$B1_SAM" pin_length)|$(b1_record staff "$B1_SAM" pin_set_at)" = "|0|" ] \
  || fail "clearing a PIN left the hash, the length or the date behind"
[ "$(b1_audit pin_cleared "$B1_SAM" | jval items.0.actor)" = "$B1_SAM" ] || fail "clearing your own PIN left no pin_cleared row"
b1_unlock "$B1_DEV1" "$B1_SAM" 2580
b1_expect 409 "Sam Bell has no PIN yet. Sign in with a password to set one." "unlocking after clearing your PIN"
b1_call DELETE "/api/vault/staff/$B1_MO/pin" "$B1_SAM_TOKEN" "" "$B1_SAM_STEP"
b1_expect 403 "$B1_ADMIN_ONLY" "plain staff clearing somebody's PIN"
b1_call DELETE "/api/vault/staff/$B1_MO/pin" "$STAFF_TOKEN"
b1_expect 403 "$B1_STEP_UP" "an admin clearing a PIN without step-up"
b1_call DELETE "/api/vault/staff/$B1_MO/pin" "$STAFF_TOKEN" "" "$B1_ADMIN_STEP"
b1_expect 204 "" "an admin clearing somebody's PIN"
[ "$(b1_audit pin_cleared "$B1_MO" | jval items.0.meta.by)" = "$B1_ADMIN" ] || fail "an admin clearing a PIN left no pin_cleared row naming them"
b1_call GET /api/vault/till/roster "" "$B1_DEV1"
B1_CLEARED="$(node -e '
  const all = JSON.parse(process.argv[1]).staff;
  const s = all.find((x) => x.id === process.argv[2]);
  const m = all.find((x) => x.id === process.argv[3]);
  process.stdout.write([s.pin_set, s.pin_length, m.pin_set, m.pin_length].join("|"));
' "$B1_BODY" "$B1_SAM" "$B1_MO")"
[ "$B1_CLEARED" = "false|0|false|0" ] || fail "the roster still shows a cleared PIN ($B1_CLEARED)"
ok "a PIN is cleared by its owner or an admin with step-up, audited, and the roster draws no dots for it"

# A last sweep: no response in this section carried a PIN hash, and none of
# the hashes is anywhere the collection API shows an admin.
b1_call GET "/api/collections/staff/records?perPage=200&fields=*" "$STAFF_TOKEN"
b1_clean "an admin asking the collection API for every staff field"
ok "pin_hash never reaches an admin through the collection API, even asking for every field"

# --- 27m. No server key, and the last admin ----------------------------------------
# A server of this section's own with no GG_ID_PHOTO_KEY in its environment
# (env -u, in case the shell running check.sh has one). The PID goes in
# KEYLESS_PID and the data under $TMP_DIR so check.sh's cleanup stops and
# removes both if a check fails.
B1_KL_DIR="$TMP_DIR/b1-keyless"
mkdir -p "$B1_KL_DIR"
B1_KL_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
B1_URL="http://127.0.0.1:$B1_KL_PORT"
"$PB" --dir "$B1_KL_DIR" superuser upsert "$SUPER_EMAIL" "$SUPER_PASSWORD" >/dev/null
env -u GG_ID_PHOTO_KEY "$PB" serve \
  --dir "$B1_KL_DIR" \
  --hooksDir "$HOOKS_DIR" \
  --hooksWatch=false \
  --migrationsDir "$MIGRATIONS_DIR" \
  --publicDir "$PUBLIC_DIR" \
  --http "127.0.0.1:$B1_KL_PORT" \
  >"$B1_KL_DIR/server.log" 2>&1 &
KEYLESS_PID=$!
B1_KL_UP=""
for _ in $(seq 1 100); do
  if curl -s -o /dev/null "$B1_URL/api/health"; then
    B1_KL_UP=1
    break
  fi
  sleep 0.2
done
[ -n "$B1_KL_UP" ] || fail "the B1 keyless server never became healthy: $(cat "$B1_KL_DIR/server.log")"
B1_KL_SUPER="$(curl -s -X POST "$B1_URL/api/collections/_superusers/auth-with-password" -H "Content-Type: application/json" \
  -d "{\"identity\":\"$SUPER_EMAIL\",\"password\":\"$SUPER_PASSWORD\"}" | jval token)"
B1_KL_ADMIN="$(curl -s -X POST "$B1_URL/api/collections/staff/records" -H "Authorization: $B1_KL_SUPER" -H "Content-Type: application/json" \
  -d "{\"name\":\"Only Admin\",\"email\":\"b1-only@local.test\",\"password\":\"$B1_PASSWORD\",\"passwordConfirm\":\"$B1_PASSWORD\",\"role\":\"admin\",\"active\":true}" | jval id)"
[ -n "$B1_KL_ADMIN" ] || fail "could not create the keyless server's admin"
B1_KL_TOKEN="$(b1_sign_in b1-only@local.test | jval token)"
B1_KL_STEP="$(b1_step_up "$B1_KL_TOKEN")"
[ -n "$B1_KL_TOKEN" ] && [ -n "$B1_KL_STEP" ] || fail "the keyless server's admin could not sign in and step up"
b1_call POST /api/vault/till/devices "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"label":"B1 Keyless Mac"}'
b1_expect 201 "" "registering a till on the keyless server"
B1_KL_DEV="$(b1_get device.id).$(b1_get secret)"

b1_unlock "$B1_KL_DEV" "$B1_KL_ADMIN" 2580
b1_expect 500 "$B1_KEYLESS" "unlocking with no server key"
b1_call POST /api/vault/till/override "$B1_KL_TOKEN" "$B1_KL_DEV" "" '{"capability":"refund","approver":"'"$B1_KL_ADMIN"'","pin":"2580"}'
b1_expect 500 "$B1_KEYLESS" "an approval with no server key"
b1_call POST /api/vault/staff/me/pin "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"pin":"2580"}'
b1_expect 500 "$B1_KEYLESS" "setting your own PIN with no server key"
b1_call DELETE /api/vault/staff/me/pin "$B1_KL_TOKEN" "" "$B1_KL_STEP"
b1_expect 500 "$B1_KEYLESS" "clearing your own PIN with no server key"
b1_call POST "/api/vault/staff/$B1_KL_ADMIN/pin" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"pin":"2580"}'
b1_expect 500 "$B1_KEYLESS" "an admin setting a PIN with no server key"
b1_call DELETE "/api/vault/staff/$B1_KL_ADMIN/pin" "$B1_KL_TOKEN" "" "$B1_KL_STEP"
b1_expect 500 "$B1_KEYLESS" "an admin clearing a PIN with no server key"
[ -z "$(curl -s "$B1_URL/api/collections/staff/records/$B1_KL_ADMIN" -H "Authorization: $B1_KL_SUPER" | jval pin_hash)" ] \
  || fail "the keyless server stored a PIN hash anyway"
ok "with no GG_ID_PHOTO_KEY every PIN route is 500 with the contract's sentence and nothing is stored"

b1_kl_audit_count() {
  curl -s -G "$B1_URL/api/collections/audit_log/records" -H "Authorization: $B1_KL_SUPER" \
    --data-urlencode "filter=action = \"$1\"" --data-urlencode "perPage=1" | jval totalItems
}
b1_call PATCH "/api/vault/staff/$B1_KL_ADMIN" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"role":"manager"}'
b1_expect 409 "$B1_LAST_ADMIN" "demoting the only admin"
b1_call PATCH "/api/vault/staff/$B1_KL_ADMIN" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"active":false}'
b1_expect 409 "$B1_LAST_ADMIN" "deactivating the only admin"
[ "$(curl -s "$B1_URL/api/collections/staff/records/$B1_KL_ADMIN" -H "Authorization: $B1_KL_SUPER" | jval role)" = "admin" ] \
  || fail "a refused demotion changed the role anyway"
[ "$(b1_kl_audit_count staff_updated)" = "0" ] || fail "a refused demotion was audited as an update"
B1_KL_SECOND="$(curl -s -X POST "$B1_URL/api/collections/staff/records" -H "Authorization: $B1_KL_SUPER" -H "Content-Type: application/json" \
  -d "{\"name\":\"Second Admin\",\"email\":\"b1-second@local.test\",\"password\":\"$B1_PASSWORD\",\"passwordConfirm\":\"$B1_PASSWORD\",\"role\":\"admin\",\"active\":true}" | jval id)"
[ -n "$B1_KL_SECOND" ] || fail "could not create a second admin on the keyless server"
b1_call PATCH "/api/vault/staff/$B1_KL_SECOND" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"active":false}'
b1_expect 200 "" "deactivating an admin who is not the last"
b1_call PATCH "/api/vault/staff/$B1_KL_ADMIN" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"role":"staff"}'
b1_expect 409 "$B1_LAST_ADMIN" "demoting the last active admin while another admin is inactive"
b1_call PATCH "/api/vault/staff/$B1_KL_SECOND" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"active":true}'
b1_expect 200 "" "reactivating the second admin"
b1_call PATCH "/api/vault/staff/$B1_KL_ADMIN" "$B1_KL_TOKEN" "" "$B1_KL_STEP" '{"role":"manager"}'
b1_expect 200 "" "demoting an admin while another is active"
[ "$(b1_kl_audit_count staff_updated)" = "3" ] || fail "the allowed edits did not leave three staff_updated rows"
ok "the change that would leave no active admin is refused with 409, whether by role or by deactivation"

kill "$KEYLESS_PID" 2>/dev/null || true
wait "$KEYLESS_PID" 2>/dev/null || true
KEYLESS_PID=""
rm -rf "$B1_KL_DIR"
B1_URL="$BASE"

# --- 27n. Put things back ----------------------------------------------------------
curl -s -o /dev/null -X DELETE "$BASE/api/collections/registers/records/$B1_SPARE" -H "Authorization: $SUPER_TOKEN"
b1_set_limits "{\"POST /api/vault/till/unlock\":$B1_UNLOCK_LIMIT,\"POST /api/vault/till/override\":$B1_OVERRIDE_LIMIT,\"*:auth\":$B1_AUTH_LIMIT}"
[ "$(b1_limit "POST /api/vault/till/unlock")|$(b1_limit "POST /api/vault/till/override")|$(b1_limit "*:auth")" \
  = "$B1_UNLOCK_LIMIT|$B1_OVERRIDE_LIMIT|$B1_AUTH_LIMIT" ] || fail "the rate limits were not put back to the shipped figures"
ok "the rate limits are back to the shipped figures and the switched-off register is gone"
