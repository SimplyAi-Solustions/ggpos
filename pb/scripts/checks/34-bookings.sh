# shellcheck shell=bash
# -----------------------------------------------------------------------
# 34. Bookings (docs/api-contract-launch.md, section 4): availability
#     around opening hours, a closed day and the clock change; booking, the
#     clash sentence, moving, cancelling with and without the deposit, no-
#     shows, check-in and check-out; a customer booking online for
#     themselves and refused for an offline resource or someone else;
#     member pricing; walk-in sessions on the clock with the grace minutes;
#     paying a booking at the till and refunding it; an event's capacity,
#     waitlist, free entries and check-in by the customer's QR; the weekly
#     repeats and the reminders made by their crons; two tills racing for
#     one slot and one balance; the hooks on events, resources and the
#     shop's hours; and the audit rows.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR,
# $ROOT and the ok/fail/jval helpers. It leaves the default register's till
# open, as section 30 does, and removes every resource, event and booking it
# made; the shop's opening hours go back as they were.
# -----------------------------------------------------------------------

BK_DIR="$TMP_DIR/s34"
mkdir -p "$BK_DIR"
BK_SHARED="$ROOT/packages/shared/src/bookings.ts"

# --- helpers -------------------------------------------------------------

# $1 token ("" for none), $2 path, $3 JSON body -> the status; body in last.json.
bk_post() {
  local auth=()
  if [ -n "$1" ]; then auth=(-H "Authorization: $1"); fi
  curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE$2" \
    ${auth[@]+"${auth[@]}"} -H "Content-Type: application/json" -d "$3"
}

# $1 token ("" for none), $2 path -> the status; body in last.json.
bk_get() {
  local auth=()
  if [ -n "$1" ]; then auth=(-H "Authorization: $1"); fi
  curl -s -o "$BK_DIR/last.json" -w '%{http_code}' ${auth[@]+"${auth[@]}"} "$BASE$2"
}

# $1 token, $2 path, $3 JSON body -> the status of a PATCH; body in last.json.
bk_patch() {
  curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X PATCH "$BASE$2" \
    -H "Authorization: $1" -H "Content-Type: application/json" -d "$3"
}

bk_body() { cat "$BK_DIR/last.json"; }
bk_field() { jval "$1" <"$BK_DIR/last.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
bk_expect() {
  [ "$1" = "$2" ] || fail "$4 returned $1, expected $2: $(bk_body)"
  if [ -n "$3" ]; then
    [ "$(bk_field message)" = "$3" ] || fail "$4 said '$(bk_field message)', expected '$3'"
  fi
}

# $1 collection, $2 filter -> the superuser's list of matching records.
bk_list() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    --data-urlencode "perPage=500" --data-urlencode "sort=created" "$BASE/api/collections/$1/records"
}

# $1 collection, $2 id -> one record as the superuser sees it.
bk_record() {
  curl -s -H "Authorization: $SUPER_TOKEN" "$BASE/api/collections/$1/records/$2"
}

# The shared bookings maths, in node: $1 a JS expression over `b` (the
# shared module) and `a` (the remaining arguments).
bk_node() {
  local expr="$1"
  shift
  node --experimental-strip-types -e "
    const b = require('$BK_SHARED');
    const a = process.argv.slice(1);
    process.stdout.write(String($expr));
  " "$@" 2>/dev/null
}

# $1 ISO -> "18:00", shop time.
bk_clock() { bk_node 'b.shopClock(a[0])' "$1"; }

# $1 ISO -> "Fri 16 Oct", shop time, as the routes write it.
bk_day() {
  bk_node '(() => { const d = b.shopDateOf(new Date(a[0])); const t = new Date(d + "T00:00:00Z");
    return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.getUTCDay()] + " " + t.getUTCDate() + " " +
      ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][t.getUTCMonth()]; })()' "$1"
}

# $1 shop date, $2 shop clock -> the UTC instant, ISO.
bk_at() { bk_node 'b.shopTimeToUtc(a[0], a[1]).toISOString()' "$1" "$2"; }

# $1 pence -> £1,234.56, through the shared formatter itself.
bk_gbp() {
  node --experimental-strip-types -e "
    const { formatGBP } = require('$ROOT/packages/shared/src/money.ts');
    process.stdout.write(formatGBP(Number(process.argv[1])));
  " "$1" 2>/dev/null
}

# $1 name, $2 kind, $3 extra JSON fields (no braces) -> a resource id, made by the admin.
bk_resource() {
  curl -s -X POST "$BASE/api/collections/resources/records" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"kind\":\"$2\",\"active\":true,$3}" | jval id
}

# $1 token, $2 resource, $3 starts, $4 ends, [$5 extra JSON fields] -> the status; the booking in last.json.
bk_book() {
  bk_post "$1" "/api/vault/bookings" \
    "{\"resource\":\"$2\",\"starts_at\":\"$3\",\"ends_at\":\"$4\"${5:+,$5}}"
}

# $1 lines JSON, $2 card amount -> the status of a card sale; the body in last.json.
bk_sell() {
  bk_post "$STAFF_TOKEN" "/api/vault/sales/complete" \
    "{\"lines\":$1,\"tenders\":[{\"method\":\"card_tide\",\"amount\":$2,\"card_last4\":\"3434\"}]}"
}

# $1 action, $2 record -> how many audit rows of that action name the record.
bk_audits() {
  bk_list audit_log "action='$1' && record='$2'" | jval totalItems
}

# $1 cron name: run it now and give it a moment (the route answers 204 and
# runs the job in the background).
bk_cron() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/$1" -H "Authorization: $SUPER_TOKEN")"
  [ "$code" = "204" ] || fail "POST /api/crons/$1 returned $code, expected 204"
}

# $1 collection, $2 filter, $3 count wanted -> waits up to ~10s for that many rows.
bk_wait_rows() {
  local tries=0 n=0
  while [ "$tries" -lt 40 ]; do
    n="$(bk_list "$1" "$2" | jval totalItems)"
    if [ "${n:-0}" -ge "$3" ] 2>/dev/null; then
      echo "$n"
      return 0
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  echo "${n:-0}"
}

# --- setup ---------------------------------------------------------------

# Dates, all from the shared shop clock: today and tomorrow in the shop,
# a day a month out, the hour now is in, and next year's summer Monday and
# the October clock change with the Saturday before and the Monday after.
eval "$(bk_node '(() => {
  const now = new Date();
  const today = b.shopDateOf(now);
  const y = now.getUTCFullYear() + 1;
  const lastOct = new Date(Date.UTC(y, 10, 0));
  const change = b.addDays(lastOct.toISOString().slice(0, 10), -lastOct.getUTCDay());
  let mon = y + "-07-01";
  while (b.weekdayOf(mon) !== "mon") mon = b.addDays(mon, 1);
  const hour = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  return [
    "BK_TODAY=" + today,
    "BK_TOMORROW=" + b.addDays(today, 1),
    "BK_LATER=" + b.addDays(today, 30),
    "BK_SUMMER_MON=" + mon,
    "BK_SUMMER_SUN=" + b.addDays(mon, -1),
    "BK_CHANGE_SUN=" + change,
    "BK_CHANGE_SAT=" + b.addDays(change, -1),
    "BK_CHANGE_MON=" + b.addDays(change, 1),
    "BK_HOUR=" + hour.toISOString(),
    "BK_HOUR_END=" + new Date(hour.getTime() + 3600000).toISOString(),
  ].join("\n");
})()')"
[ -n "${BK_TODAY:-}" ] && [ -n "${BK_CHANGE_SUN:-}" ] || fail "34: could not work out the dates"

BK_ADMIN_ID="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval id)"
[ -n "$BK_ADMIN_ID" ] || fail "34: could not read the admin's own id"
BK_SETTINGS_ID="$(curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$BK_SETTINGS_ID" ] || fail "34: could not read the settings row"
BK_HOURS_BEFORE="$(bk_record settings "$BK_SETTINGS_ID" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(d).opening_hours ?? null)))')"

# The shop's hours for these checks: 10:00 to 20:00, 11:00 to 17:00 on Sundays.
BK_STATUS="$(bk_patch "$STAFF_TOKEN" "/api/collections/settings/records/$BK_SETTINGS_ID" \
  '{"opening_hours":{"mon":[["10:00","20:00"]],"tue":[["10:00","20:00"]],"wed":[["10:00","20:00"]],"thu":[["10:00","20:00"]],"fri":[["10:00","20:00"]],"sat":[["10:00","20:00"]],"sun":[["11:00","17:00"]]}}')"
bk_expect "$BK_STATUS" 200 "" "setting the shop's opening hours"

BK_ALL_DAY='{"sun":[["00:00","24:00"]],"mon":[["00:00","24:00"]],"tue":[["00:00","24:00"]],"wed":[["00:00","24:00"]],"thu":[["00:00","24:00"]],"fri":[["00:00","24:00"]],"sat":[["00:00","24:00"]]}'
BK_TABLE="$(bk_resource "BK Table 1" table "\"capacity\":4,\"slot_minutes\":60,\"price\":500,\"member_price\":400,\"deposit\":200,\"online\":true,\"sort\":1,\"hours\":$BK_ALL_DAY")"
BK_TABLE2="$(bk_resource "BK Table 2" table "\"capacity\":6,\"slot_minutes\":60,\"price\":500,\"online\":true,\"sort\":2,\"hours\":$BK_ALL_DAY")"
BK_SPLIT="$(bk_resource "BK Table Hours" table '"capacity":4,"slot_minutes":60,"price":500,"online":true,"sort":3,"hours":{"mon":[["10:00","13:00"],["14:00","18:00"]],"tue":[["10:00","13:00"],["14:00","18:00"]],"wed":[["10:00","13:00"],["14:00","18:00"]],"thu":[["10:00","13:00"],["14:00","18:00"]],"fri":[["10:00","13:00"],["14:00","18:00"]],"sat":[["10:00","13:00"],["14:00","18:00"]]}')"
BK_ROOM="$(bk_resource "BK Room" room '"capacity":12,"slot_minutes":60,"price":2000,"deposit":1000,"online":false,"sort":4')"
BK_PC="$(bk_resource "BK PC 1" pc "\"capacity\":1,\"slot_minutes\":60,\"price\":300,\"member_price\":250,\"online\":true,\"sort\":5,\"hours\":$BK_ALL_DAY")"
for v in BK_TABLE BK_TABLE2 BK_SPLIT BK_ROOM BK_PC; do
  [ -n "${!v}" ] || fail "34: could not make the resource $v"
done

# A plain staff member, a Guild member and a customer who has not joined.
BK_CLERK_EMAIL="s34-clerk@local.test"
BK_CLERK_PASSWORD="s34-clerk-password-123"
curl -s -o /dev/null -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$BK_CLERK_EMAIL\",\"password\":\"$BK_CLERK_PASSWORD\",\"passwordConfirm\":\"$BK_CLERK_PASSWORD\",\"name\":\"Kit Bookings\",\"role\":\"staff\",\"active\":true}"
BK_CLERK_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" -d "{\"identity\":\"$BK_CLERK_EMAIL\",\"password\":\"$BK_CLERK_PASSWORD\"}" | jval token)"
[ -n "$BK_CLERK_TOKEN" ] || fail "34: the plain staff member could not sign in"

BK_MEMBER="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"Morgan Guild\",\"email\":\"s34-member@local.test\",\"phone\":\"07700900341\",\"source\":\"counter\",\"guild_joined_at\":\"2026-01-01 10:00:00.000Z\"}" | jval id)"
BK_PLAIN="$(curl -s -X POST "$BASE/api/collections/customers/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Riley Plain","email":"s34-plain@local.test","source":"counter"}' | jval id)"
[ -n "$BK_MEMBER" ] && [ -n "$BK_PLAIN" ] || fail "34: could not make the check customers"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/customers/records/$BK_PLAIN" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"guild_joined_at":""}'
[ "$(bk_record customers "$BK_PLAIN" | jval guild_joined_at)" = "" ] || fail "34: the plain customer is in the Guild"
BK_MEMBER_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$BK_MEMBER" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
BK_PLAIN_TOKEN="$(curl -s -X POST "$BASE/api/collections/customers/impersonate/$BK_PLAIN" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{}' | jval token)"
[ -n "$BK_MEMBER_TOKEN" ] && [ -n "$BK_PLAIN_TOKEN" ] || fail "34: could not sign the check customers in"

# An open till on the default register, for paying at the till.
if [ -z "$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id")" ]; then
  BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/cash-sessions/open" '{"float":5000}')"
  bk_expect "$BK_STATUS" 200 "" "opening the till for the booking checks"
fi
ok "34: the resources, customers, shop hours and an open till are ready"

# --- 34a. Availability around opening hours, a closed day, the clock change --
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_SUMMER_MON&kind=table")"
bk_expect "$BK_STATUS" 200 "" "staff availability on a summer Monday"
bk_split_slots() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const r = d.resources.find((x) => x.resource.id === process.argv[1]);
    process.stdout.write(r ? r.slots.map((s) => s.starts_at.slice(11, 16) + (s.free ? "" : "x")).join(",") : "none");
  ' "$1" <"$BK_DIR/last.json"
}
[ "$(bk_split_slots "$BK_SPLIT")" = "09:00,10:00,11:00,13:00,14:00,15:00,16:00" ] \
  || fail "a summer Monday's slots for 10:00 to 13:00 and 14:00 to 18:00 are '$(bk_split_slots "$BK_SPLIT")' (UTC), expected 09:00 to 11:00 and 13:00 to 16:00"
[ "$(bk_field "date")" = "$BK_SUMMER_MON" ] || fail "availability did not echo its date"
[ "$(bk_split_slots "$BK_ROOM")" = "none" ] || fail "kind=table listed the room"
[ "$(bk_field "resources.0.resource.member_price")" = "400" ] || fail "availability lost the member price: $(bk_body)"
[ "$(bk_field "resources.0.resource.deposit")" = "200" ] || fail "availability lost the deposit"

BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_SUMMER_SUN")"
bk_expect "$BK_STATUS" 200 "" "staff availability on a Sunday"
[ "$(bk_split_slots "$BK_SPLIT")" = "" ] || fail "a resource with no Sunday hours offered '$(bk_split_slots "$BK_SPLIT")' on a Sunday"
[ "$(bk_split_slots "$BK_ROOM")" = "10:00,11:00,12:00,13:00,14:00,15:00" ] \
  || fail "the room on the shop's Sunday hours (11:00 to 17:00 BST) offered '$(bk_split_slots "$BK_ROOM")'"

BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_CHANGE_SAT")"
[ "$(bk_split_slots "$BK_SPLIT")" = "09:00,10:00,11:00,13:00,14:00,15:00,16:00" ] \
  || fail "the Saturday before the clock change is not on BST: '$(bk_split_slots "$BK_SPLIT")'"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_CHANGE_SUN")"
[ "$(bk_split_slots "$BK_SPLIT")" = "" ] || fail "the clock change Sunday is closed for the split table"
[ "$(bk_split_slots "$BK_ROOM")" = "11:00,12:00,13:00,14:00,15:00,16:00" ] \
  || fail "the clock change Sunday's 11:00 to 17:00 is not on GMT: '$(bk_split_slots "$BK_ROOM")'"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_CHANGE_MON")"
[ "$(bk_split_slots "$BK_SPLIT")" = "10:00,11:00,12:00,14:00,15:00,16:00,17:00" ] \
  || fail "the Monday after the clock change is not on GMT: '$(bk_split_slots "$BK_SPLIT")'"

BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_SUMMER_MON&party=5")"
[ "$(bk_split_slots "$BK_TABLE")" = "none" ] || fail "a party of 5 was offered a table for 4"
[ "$(bk_split_slots "$BK_TABLE2")" != "none" ] || fail "a party of 5 was not offered the table for 6"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=16-10-2026")"
bk_expect "$BK_STATUS" 400 "Pick a day, for example 2026-10-16." "availability for a date that is not one"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_SUMMER_MON&kind=boat")"
bk_expect "$BK_STATUS" 400 "Pick a kind: table, pc, console or room." "availability for a kind that is not one"
ok "availability lays slots inside each resource's hours or the shop's, none on a closed day, on BST before the October change and GMT after, filtered by kind and party"

# A booking and an event that takes the table both make their slots busy.
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_SPLIT" "$(bk_at "$BK_SUMMER_MON" 11:00)" "$(bk_at "$BK_SUMMER_MON" 12:00)" '"name":"Avery Hours"')"
bk_expect "$BK_STATUS" 200 "" "booking the split table at 11:00"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK Painting Night\",\"starts_at\":\"$(bk_at "$BK_SUMMER_MON" 15:00)\",\"ends_at\":\"$(bk_at "$BK_SUMMER_MON" 16:00)\",\"status\":\"published\",\"capacity\":8,\"resources\":[\"$BK_SPLIT\"]}")"
bk_expect "$BK_STATUS" 200 "" "an event taking the split table"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_SUMMER_MON")"
[ "$(bk_split_slots "$BK_SPLIT")" = "09:00,10:00x,11:00,13:00,14:00x,15:00,16:00" ] \
  || fail "the booking at 11:00 and the event at 15:00 BST did not make their slots busy: '$(bk_split_slots "$BK_SPLIT")'"
ok "a live booking and a published event that takes the resource both make their slots busy"

# The public route: online resources only, started slots not free, no detail.
BK_STATUS="$(bk_get "" "/api/public/availability?date=$BK_SUMMER_MON")"
bk_expect "$BK_STATUS" 200 "" "public availability with no sign-in"
[ "$(bk_split_slots "$BK_ROOM")" = "none" ] || fail "the public route listed a resource that is not bookable online"
[ "$(bk_split_slots "$BK_SPLIT")" = "09:00,10:00x,11:00,13:00,14:00x,15:00,16:00" ] || fail "the public route disagrees with the staff one"
grep -q "Avery" "$BK_DIR/last.json" && fail "the public availability carries a booking's name"
BK_STATUS="$(bk_get "" "/api/public/availability?date=$BK_TODAY&kind=table")"
BK_PAST_FREE="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const r = d.resources.find((x) => x.resource.id === process.argv[1]);
  process.stdout.write(String(r.slots[0].free));' "$BK_TABLE" <"$BK_DIR/last.json")"
[ "$BK_PAST_FREE" = "false" ] || fail "the public route offered today's first slot, which has started"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/availability?date=$BK_TODAY&kind=table")"
BK_PAST_FREE="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const r = d.resources.find((x) => x.resource.id === process.argv[1]);
  process.stdout.write(String(r.slots[0].free));' "$BK_TABLE" <"$BK_DIR/last.json")"
[ "$BK_PAST_FREE" = "true" ] || fail "staff availability hid today's first slot, which staff may still book"
BK_STATUS="$(bk_get "$BK_MEMBER_TOKEN" "/api/vault/bookings/availability?date=$BK_TODAY")"
[ "$BK_STATUS" = "403" ] || [ "$BK_STATUS" = "401" ] || fail "a customer read the staff availability ($BK_STATUS)"
ok "the public availability needs no sign-in, shows only online resources and no booking detail, and never offers a slot that has started"

# --- 34b. Book, the clash sentence, hours and slot refusals ---------------
BK_L18="$(bk_at "$BK_LATER" 18:00)"
BK_L19="$(bk_at "$BK_LATER" 19:00)"
BK_L20="$(bk_at "$BK_LATER" 20:00)"
BK_L21="$(bk_at "$BK_LATER" 21:00)"
BK_L22="$(bk_at "$BK_LATER" 22:00)"
BK_STATUS="$(bk_book "$BK_CLERK_TOKEN" "$BK_TABLE" "$BK_L18" "$BK_L20" '"name":"Jo Phone","phone":"07700900123","party_size":3,"source":"phone","notes":"Birthday"')"
bk_expect "$BK_STATUS" 200 "" "booking a table for two hours"
BK_B1="$(bk_field id)"
[ "$(bk_field status)" = "held" ] || fail "a booking with a deposit due is '$(bk_field status)', expected held"
[ "$(bk_field price)" = "1000" ] || fail "two slots at £5.00 came to '$(bk_field price)'"
[ "$(bk_field deposit)" = "200" ] || fail "the deposit is '$(bk_field deposit)', expected 200"
[ "$(bk_field balance)" = "1000" ] || fail "the balance is '$(bk_field balance)'"
[ "$(bk_field source)" = "phone" ] || fail "the source is '$(bk_field source)', expected phone"
[ "$(bk_field resource.name)" = "BK Table 1" ] || fail "the booking does not name its table"
[ "$(bk_field name)" = "Jo Phone" ] || fail "the booking lost its name"
[ "$(bk_field party_size)" = "3" ] || fail "the booking lost its party size"
[ "$(bk_field notes)" = "Birthday" ] || fail "the staff note is missing"
[ "$(bk_audits booking_create "$BK_B1")" = "1" ] || fail "the booking left no booking_create audit row"

BK_CLASH="BK Table 1 is booked from $(bk_clock "$BK_L18") to $(bk_clock "$BK_L20"). Pick another time or another table."
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L19" "$BK_L20" '"name":"Second Try"')"
bk_expect "$BK_STATUS" 409 "$BK_CLASH" "booking over a booked hour"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_SPLIT" "$(bk_at "$BK_SUMMER_MON" 13:00)" "$(bk_at "$BK_SUMMER_MON" 14:00)" '"name":"Lunch Hour"')"
bk_expect "$BK_STATUS" 400 "BK Table Hours is not open then. Pick a time within its hours." "booking the hour the table is shut"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L20" "$(bk_at "$BK_LATER" 20:30)" '"name":"Half Hour"')"
bk_expect "$BK_STATUS" 400 "BK Table 1 books in 60-minute slots." "booking half a slot"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L20" "$BK_L21" '"name":"Big Party","party_size":5')"
bk_expect "$BK_STATUS" 400 "BK Table 1 takes up to 4. Pick a bigger one or split the party." "a party bigger than the table"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L20" "$BK_L21" '')"
bk_expect "$BK_STATUS" 400 "Add a name for the booking, or pick the customer." "a booking with nobody on it"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L20" "$BK_L21" '"name":"Bad Mail","email":"not-an-email"')"
bk_expect "$BK_STATUS" 400 "That email address does not look right. Check it and try again." "a booking with a bad email"
ok "a booking is priced by the slot with its deposit and held until paid; a clash is 409 with the contract's sentence, and the hours, slot, party and name refusals say what to do"

# Member pricing, booked by staff: a member pays the member price.
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE2" "$BK_L18" "$BK_L20" "\"customer\":\"$BK_MEMBER\"")"
bk_expect "$BK_STATUS" 200 "" "booking table 2 for a member"
BK_B_MEMBER2="$(bk_field id)"
[ "$(bk_field price)" = "1000" ] || fail "table 2 has no member price, so a member pays '$(bk_field price)', expected 1000"
[ "$(bk_field status)" = "confirmed" ] || fail "a booking with no deposit is '$(bk_field status)', expected confirmed"
[ "$(bk_field customer.member)" = "true" ] || fail "the booking does not say its customer is a member"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L21" "$BK_L22" "\"customer\":\"$BK_MEMBER\"")"
bk_expect "$BK_STATUS" 200 "" "booking table 1 for a member"
BK_B_MEMBER1="$(bk_field id)"
[ "$(bk_field price)" = "400" ] || fail "a member's hour on table 1 came to '$(bk_field price)', expected the member price 400"
[ "$(bk_field name)" = "Morgan Guild" ] || fail "a customer's booking is not under their name"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$(bk_at "$BK_LATER" 10:00)" "$(bk_at "$BK_LATER" 11:00)" "\"customer\":\"$BK_PLAIN\"")"
bk_expect "$BK_STATUS" 200 "" "booking table 1 for a customer who has not joined"
BK_B_PLAIN="$(bk_field id)"
[ "$(bk_field price)" = "500" ] || fail "a customer outside the Guild paid '$(bk_field price)', expected the full 500"
ok "members pay the member price and everyone else the full price"

# --- 34c. Move ------------------------------------------------------------
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1/move" "{\"starts_at\":\"$BK_L19\",\"ends_at\":\"$BK_L20\"}")"
bk_expect "$BK_STATUS" 200 "" "moving a booking inside its own time"
[ "$(bk_field starts_at)" = "$BK_L19" ] || fail "the moved booking starts at '$(bk_field starts_at)'"
[ "$(bk_field price)" = "500" ] || fail "the moved booking was not repriced for one slot: '$(bk_field price)'"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1/move" "{\"starts_at\":\"$BK_L21\",\"ends_at\":\"$BK_L22\"}")"
bk_expect "$BK_STATUS" 409 "BK Table 1 is booked from $(bk_clock "$BK_L21") to $(bk_clock "$BK_L22"). Pick another time or another table." "moving onto another booking"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1/move" "{\"starts_at\":\"$BK_L19\",\"ends_at\":\"$BK_L20\",\"resource\":\"$BK_TABLE2\"}")"
bk_expect "$BK_STATUS" 409 "BK Table 2 is booked from $(bk_clock "$BK_L18") to $(bk_clock "$BK_L20"). Pick another time or another table." "moving onto another table's booking"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1/move" "{\"starts_at\":\"$BK_L18\",\"ends_at\":\"$BK_L19\",\"resource\":\"$BK_SPLIT\"}")"
bk_expect "$BK_STATUS" 400 "BK Table Hours is not open then. Pick a time within its hours." "moving outside the new table's hours"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1/move" "{\"starts_at\":\"$BK_L18\",\"ends_at\":\"$BK_L20\"}")"
bk_expect "$BK_STATUS" 200 "" "moving a booking back to two hours"
[ "$(bk_audits booking_move "$BK_B1")" = "2" ] || fail "two moves left $(bk_audits booking_move "$BK_B1") booking_move rows"
ok "a booking moves to a free time or table, repriced, and a move onto anything booked is the same 409"

# --- 34d. Paying at the till, and refunding ------------------------------
BK_B1_LABEL="BK Table 1, $(bk_day "$BK_L18") $(bk_clock "$BK_L18")"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\",\"unit_price\":200}]" 200)"
bk_expect "$BK_STATUS" 200 "" "paying a booking's deposit at the till"
BK_PAY1_SALE="$(bk_field sale.id)"
BK_PAY1_LINE="$(bk_list sale_lines "sale='$BK_PAY1_SALE'" | jval "items.0.id")"
[ "$(bk_list sale_lines "sale='$BK_PAY1_SALE'" | jval "items.0.booking")" = "$BK_B1" ] || fail "the sale line is not linked to the booking"
[ "$(bk_list sale_lines "sale='$BK_PAY1_SALE'" | jval "items.0.title")" = "$BK_B1_LABEL" ] \
  || fail "the booking line's title is '$(bk_list sale_lines "sale='$BK_PAY1_SALE'" | jval "items.0.title")', expected '$BK_B1_LABEL'"
BK_ROW="$(bk_record bookings "$BK_B1")"
[ "$(echo "$BK_ROW" | jval paid)" = "200" ] || fail "the deposit paid shows as '$(echo "$BK_ROW" | jval paid)'"
[ "$(echo "$BK_ROW" | jval status)" = "confirmed" ] || fail "paying confirmed nothing: the booking is '$(echo "$BK_ROW" | jval status)'"
[ "$(bk_audits booking_paid "$BK_B1")" = "1" ] || fail "the payment left no booking_paid audit row"

BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\",\"unit_price\":900}]" 900)"
bk_expect "$BK_STATUS" 409 "$BK_B1_LABEL has £8.00 left to pay. Change the amount." "paying more than is left"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\",\"unit_price\":500},{\"booking\":\"$BK_B1\",\"unit_price\":400}]" 900)"
bk_expect "$BK_STATUS" 409 "$BK_B1_LABEL has £3.00 left to pay. Change the amount." "two lines for one booking past its price"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\",\"qty\":2,\"unit_price\":100}]" 200)"
bk_expect "$BK_STATUS" 400 "A booking goes on the ticket once. Key the amount instead." "a booking twice on one line"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\"}]" 800)"
bk_expect "$BK_STATUS" 200 "" "paying the balance with no amount keyed"
BK_PAY2_SALE="$(bk_field sale.id)"
BK_PAY2_LINE="$(bk_list sale_lines "sale='$BK_PAY2_SALE'" | jval "items.0.id")"
[ "$(bk_record bookings "$BK_B1" | jval paid)" = "1000" ] || fail "the balance did not settle the booking"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\",\"unit_price\":100}]" 100)"
bk_expect "$BK_STATUS" 409 "$BK_B1_LABEL is paid in full. Take it off the ticket." "paying a booking paid in full"

BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1")"
bk_expect "$BK_STATUS" 200 "" "reading a paid booking"
[ "$(bk_field balance)" = "0" ] || fail "a paid booking still shows a balance of '$(bk_field balance)'"
[ "$(node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.payments.map(p=>p.amount).join(","))' <"$BK_DIR/last.json")" = "200,800" ] \
  || fail "the booking's payments are not the two lines: $(bk_body)"

# A refund of the balance line takes it back off `paid`.
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/sales/$BK_PAY2_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$BK_PAY2_LINE\",\"qty\":1}],\"reason\":\"Paid twice by mistake\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":800,\"card_last4\":\"3434\"}]}")"
bk_expect "$BK_STATUS" 200 "" "refunding the balance line"
[ "$(bk_record bookings "$BK_B1" | jval paid)" = "200" ] || fail "refunding the balance left paid at '$(bk_record bookings "$BK_B1" | jval paid)', expected 200"
[ "$(bk_audits booking_unpaid "$BK_B1")" = "1" ] || fail "the refund left no booking_unpaid audit row"

# A product line of the Booking kind with no booking is refused.
BK_PRODUCT="$(curl -s -X POST "$BASE/api/collections/till_products/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"BK Booking","kind":"booking","price":0,"tax_scheme":"standard","vat_rate":20,"active":true}' | jval id)"
[ -n "$BK_PRODUCT" ] || fail "could not make a Booking till product"
BK_STATUS="$(bk_sell "[{\"product\":\"$BK_PRODUCT\",\"unit_price\":500}]" 500)"
bk_expect "$BK_STATUS" 400 "Line 1 is the Booking key with no booking. Pick the booking to take payment for." "the Booking key with no booking"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B_PLAIN\",\"product\":\"$BK_PRODUCT\",\"unit_price\":500}]" 500)"
bk_expect "$BK_STATUS" 200 "" "paying a booking on the Booking key"
[ "$(bk_list sale_lines "sale='$(bk_field sale.id)'" | jval "items.0.product")" = "$BK_PRODUCT" ] || fail "the booking line is not on the Booking product"
[ "$(bk_record bookings "$BK_B_PLAIN" | jval paid)" = "500" ] || fail "the booking paid on the Booking key shows '$(bk_record bookings "$BK_B_PLAIN" | jval paid)'"
ok "a booking's deposit and balance sell as booking lines that mark paid and confirm it, never past its price, and a refund takes the line back off paid"

# --- 34e. Cancel with and without the deposit -----------------------------
# B1 has £2.00 paid, its deposit: kept, nothing to refund.
BK_STATUS="$(bk_post "$BK_CLERK_TOKEN" "/api/vault/bookings/$BK_B1/cancel" '{"keep_deposit":true}')"
bk_expect "$BK_STATUS" 200 "" "cancelling a booking and keeping its deposit"
[ "$(bk_field status)" = "cancelled" ] || fail "the cancelled booking is '$(bk_field status)'"
[ "$(bk_field kept)" = "200" ] || fail "keeping the deposit kept '$(bk_field kept)', expected 200"
[ "$(jlen refunds <"$BK_DIR/last.json")" = "0" ] || fail "keeping the deposit still lists refunds: $(bk_body)"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B1/cancel" '{}')"
bk_expect "$BK_STATUS" 409 "This booking is cancelled." "cancelling twice"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B1\",\"unit_price\":100}]" 100)"
bk_expect "$BK_STATUS" 409 "$BK_B1_LABEL is cancelled. Take it off the ticket." "paying a cancelled booking"

# A booking with its deposit paid, cancelled with the deposit refunded.
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_L19" "$BK_L21" '"name":"Sam Refund"')"
bk_expect "$BK_STATUS" 200 "" "booking the freed hours again"
BK_B2="$(bk_field id)"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_B2\",\"unit_price\":200}]" 200)"
bk_expect "$BK_STATUS" 200 "" "paying the second booking's deposit"
BK_PAY3_SALE="$(bk_field sale.id)"
BK_PAY3_NUMBER="$(bk_field sale.number)"
BK_PAY3_LINE="$(bk_list sale_lines "sale='$BK_PAY3_SALE'" | jval "items.0.id")"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B2/cancel" '{"keep_deposit":false}')"
bk_expect "$BK_STATUS" 200 "" "cancelling a booking and refunding its deposit"
[ "$(bk_field kept)" = "0" ] || fail "refunding the deposit still kept '$(bk_field kept)'"
[ "$(bk_field refunds.0.sale.id)" = "$BK_PAY3_SALE" ] || fail "the refund does not name the sale that took the deposit: $(bk_body)"
[ "$(bk_field refunds.0.sale.number)" = "$BK_PAY3_NUMBER" ] || fail "the refund does not carry the sale's number"
[ "$(bk_field refunds.0.lines.0.sale_line)" = "$BK_PAY3_LINE" ] || fail "the refund does not name the deposit's line"
[ "$(bk_field refunds.0.amount)" = "200" ] || fail "the refund is for '$(bk_field refunds.0.amount)', expected 200"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/sales/$BK_PAY3_SALE/refund" \
  "{\"lines\":[{\"sale_line\":\"$BK_PAY3_LINE\",\"qty\":1}],\"reason\":\"Booking cancelled\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":200,\"card_last4\":\"3434\"}]}")"
bk_expect "$BK_STATUS" 200 "" "refunding the deposit through the till's refund route"
[ "$(bk_record bookings "$BK_B2" | jval paid)" = "0" ] || fail "the refunded deposit is still on paid"
BK_CANCEL_META="$(bk_list audit_log "action='booking_cancel' && record='$BK_B2'" | jval "items.0.meta.keep_deposit")"
[ "$BK_CANCEL_META" = "false" ] || fail "the booking_cancel row does not say the deposit was refunded"
ok "cancelling keeps the deposit or lists the sale lines to refund through the till, and the refund takes them off paid"

# --- 34f. A customer books online, for themselves only --------------------
BK_STATUS="$(bk_book "$BK_MEMBER_TOKEN" "$BK_TABLE" "$(bk_at "$BK_LATER" 12:00)" "$(bk_at "$BK_LATER" 13:00)" '"party_size":2')"
bk_expect "$BK_STATUS" 200 "" "a member booking a table online"
BK_ONLINE="$(bk_field id)"
[ "$(bk_field status)" = "held" ] || fail "an online booking is '$(bk_field status)', expected held until paid at the till"
[ "$(bk_field source)" = "online" ] || fail "an online booking's source is '$(bk_field source)'"
[ "$(bk_field price)" = "400" ] || fail "a member booking online paid '$(bk_field price)', expected the member price 400"
[ "$(bk_field customer.id)" = "$BK_MEMBER" ] || fail "the online booking is not the customer's own"
[ "$(bk_list notifications "customer='$BK_MEMBER' && type='booking_made'" | jval totalItems)" = "1" ] \
  || fail "the customer was not told their booking is held"
BK_STATUS="$(bk_book "$BK_PLAIN_TOKEN" "$BK_TABLE" "$(bk_at "$BK_LATER" 13:00)" "$(bk_at "$BK_LATER" 14:00)" '')"
bk_expect "$BK_STATUS" 200 "" "a customer outside the Guild booking online"
[ "$(bk_field price)" = "500" ] || fail "a customer outside the Guild paid '$(bk_field price)' online, expected 500"
BK_ONLINE_PLAIN="$(bk_field id)"
BK_STATUS="$(bk_book "$BK_MEMBER_TOKEN" "$BK_ROOM" "$(bk_at "$BK_LATER" 12:00)" "$(bk_at "$BK_LATER" 13:00)" '')"
bk_expect "$BK_STATUS" 403 "BK Room cannot be booked online. Ring the shop to book it." "a customer booking an offline resource"
BK_STATUS="$(bk_book "$BK_MEMBER_TOKEN" "$BK_TABLE" "$(bk_at "$BK_LATER" 14:00)" "$(bk_at "$BK_LATER" 15:00)" "\"customer\":\"$BK_PLAIN\"")"
bk_expect "$BK_STATUS" 403 "You can only book for yourself." "a customer booking for somebody else"
BK_STATUS="$(bk_book "$BK_MEMBER_TOKEN" "$BK_TABLE" "$BK_HOUR" "$BK_HOUR_END" '')"
bk_expect "$BK_STATUS" 400 "That time has passed. Pick a later slot." "a customer booking a slot that has started"
BK_STATUS="$(bk_book "$BK_MEMBER_TOKEN" "$BK_TABLE" "$(bk_at "$BK_LATER" 12:00)" "$(bk_at "$BK_LATER" 13:00)" '')"
bk_expect "$BK_STATUS" 409 "BK Table 1 is booked from 12:00 to 13:00. Pick another time or another table." "a customer booking a taken slot"
BK_STATUS="$(bk_book "" "$BK_TABLE" "$(bk_at "$BK_LATER" 15:00)" "$(bk_at "$BK_LATER" 16:00)" '"name":"Anon"')"
[ "$BK_STATUS" = "401" ] || fail "booking with no sign-in returned $BK_STATUS, expected 401"

BK_STATUS="$(bk_get "$BK_MEMBER_TOKEN" "/api/vault/bookings/$BK_ONLINE")"
bk_expect "$BK_STATUS" 200 "" "a customer reading their own booking"
[ "$(bk_field resource.name)" = "BK Table 1" ] || fail "the customer's own booking does not name the table"
[ "$(bk_field payments)" = "" ] || fail "a customer's own booking carries the staff's payments list"
BK_STATUS="$(bk_get "$BK_PLAIN_TOKEN" "/api/vault/bookings/$BK_ONLINE")"
bk_expect "$BK_STATUS" 404 "That booking was not found." "a customer reading somebody else's booking"
BK_STATUS="$(bk_get "$BK_MEMBER_TOKEN" "/api/vault/me/bookings")"
bk_expect "$BK_STATUS" 200 "" "a customer listing their own bookings"
node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const ids = d.bookings.map((x) => x.id);
  if (!ids.includes(process.argv[1])) process.exit(1);
  if (d.bookings.some((x) => x.customer && x.customer.id !== process.argv[2])) process.exit(2);
  if (d.bookings.some((x) => x.notes)) process.exit(3);
' "$BK_ONLINE" "$BK_MEMBER" <"$BK_DIR/last.json" || fail "a customer's own list is wrong: $(bk_body)"
BK_STATUS="$(bk_post "$BK_PLAIN_TOKEN" "/api/vault/bookings/$BK_ONLINE/cancel" '{}')"
bk_expect "$BK_STATUS" 404 "That booking was not found." "a customer cancelling somebody else's booking"
BK_STATUS="$(bk_post "$BK_PLAIN_TOKEN" "/api/vault/bookings/$BK_ONLINE_PLAIN/cancel" '{}')"
bk_expect "$BK_STATUS" 200 "" "a customer cancelling their own booking"
[ "$(bk_field status)" = "cancelled" ] || fail "the customer's cancelled booking is '$(bk_field status)'"
[ "$(bk_list audit_log "action='booking_cancel' && record='$BK_ONLINE_PLAIN'" | jval "items.0.meta.by")" = "customer" ] \
  || fail "the customer's cancellation is not audited as theirs"
# A paid one goes back through the shop.
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_ONLINE\",\"unit_price\":100}]" 100)"
bk_expect "$BK_STATUS" 200 "" "part-paying the member's online booking"
[ "$(bk_record bookings "$BK_ONLINE" | jval status)" = "confirmed" ] || fail "paying confirmed nothing on the online booking"
BK_STATUS="$(bk_post "$BK_MEMBER_TOKEN" "/api/vault/bookings/$BK_ONLINE/cancel" '{}')"
bk_expect "$BK_STATUS" 409 "This booking has £1.00 paid. Ring the shop to cancel it, so it can be refunded." "a customer cancelling a paid booking"
ok "a customer books an online resource for themselves at their price, held for the till, sees and cancels only their own, and is refused an offline resource, someone else, a past slot or a paid cancellation"

# --- 34g. No-show, check-in and check-out ---------------------------------
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$BK_HOUR" "$BK_HOUR_END" '"name":"Late Larry"')"
bk_expect "$BK_STATUS" 200 "" "staff booking the hour that has started"
BK_NOSHOW="$(bk_field id)"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B_MEMBER1/no-show" '{}')"
bk_expect "$BK_STATUS" 409 "This booking has not started yet. Cancel it instead." "a no-show before the booking starts"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_NOSHOW/no-show" '{}')"
bk_expect "$BK_STATUS" 200 "" "marking a no-show"
[ "$(bk_field status)" = "no_show" ] || fail "the no-show is '$(bk_field status)'"
[ "$(bk_audits booking_no_show "$BK_NOSHOW")" = "1" ] || fail "the no-show left no audit row"

BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B_MEMBER1/check-in" '{}')"
bk_expect "$BK_STATUS" 409 "This booking is for $(bk_day "$BK_L21"). Check it in on the day." "checking in a booking for another day"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE2" "$BK_HOUR" "$BK_HOUR_END" '"name":"Table Tess","party_size":4')"
bk_expect "$BK_STATUS" 200 "" "booking table 2 for this hour"
BK_TODAY_B="$(bk_field id)"
BK_STATUS="$(bk_post "$BK_CLERK_TOKEN" "/api/vault/bookings/$BK_TODAY_B/check-in" '{}')"
bk_expect "$BK_STATUS" 200 "" "checking a booking in"
[ "$(bk_field status)" = "checked_in" ] || fail "the checked-in booking is '$(bk_field status)'"
[ -n "$(bk_field checked_in_at)" ] || fail "check-in did not stamp checked_in_at"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_TODAY_B/check-in" '{}')"
bk_expect "$BK_STATUS" 409 "This booking is already checked in." "checking in twice"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_TODAY_B/move" "{\"starts_at\":\"$BK_L21\",\"ends_at\":\"$BK_L22\"}")"
bk_expect "$BK_STATUS" 409 "This booking has checked in. Check it out first." "moving a booking that has checked in"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_TODAY_B/check-out" '{}')"
bk_expect "$BK_STATUS" 200 "" "checking a table booking out"
[ "$(bk_field status)" = "completed" ] || fail "the checked-out booking is '$(bk_field status)'"
[ "$(bk_field charge.price)" = "500" ] || fail "a table keeps its booked price at check-out, got '$(bk_field charge.price)'"
[ "$(bk_field charge.balance)" = "500" ] || fail "the charge's balance is '$(bk_field charge.balance)'"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_TODAY_B/check-out" '{}')"
bk_expect "$BK_STATUS" 409 "This booking has already checked out." "checking out twice"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_B_MEMBER2/check-out" '{}')"
bk_expect "$BK_STATUS" 409 "This booking has not checked in." "checking out a booking that never checked in"
for action in booking_check_in booking_check_out; do
  [ "$(bk_audits "$action" "$BK_TODAY_B")" = "1" ] || fail "$action left no audit row"
done
ok "a no-show waits for the start, check-in is on the day and once, a table checks out at its booked price, and each is audited"

# --- 34h. Walk-in sessions and the grace minutes --------------------------
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/walk-in" "{\"resource\":\"$BK_PC\"}")"
bk_expect "$BK_STATUS" 200 "" "starting a walk-in session"
BK_W1="$(bk_field id)"
[ "$(bk_field status)" = "checked_in" ] || fail "a walk-in session is '$(bk_field status)', expected checked_in"
[ "$(bk_field name)" = "Walk-in" ] || fail "a bare walk-in is called '$(bk_field name)'"
[ "$(bk_field price)" = "0" ] || fail "a walk-in starts at '$(bk_field price)', expected 0 until check-out"
BK_W1_START="$(bk_field starts_at)"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/walk-in" "{\"resource\":\"$BK_PC\"}")"
[ "$BK_STATUS" = "409" ] || fail "a second walk-in on a station in use returned $BK_STATUS: $(bk_body)"
case "$(bk_field message)" in
  "BK PC 1 is booked from "*" Pick another time or another PC.") ;;
  *) fail "the station in use said '$(bk_field message)'" ;;
esac
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/walk-in" "{\"resource\":\"$BK_TABLE\"}")"
bk_expect "$BK_STATUS" 400 "Walk-in sessions run on PC and console stations. Book a table or room instead." "a walk-in on a table"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings/stations")"
bk_expect "$BK_STATUS" 200 "" "the stations strip"
node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const s = d.stations.find((x) => x.resource.id === process.argv[1]);
  if (!s || !s.session || s.session.id !== process.argv[2]) process.exit(1);
  if (d.stations.some((x) => x.resource.kind !== "pc" && x.resource.kind !== "console")) process.exit(2);
' "$BK_PC" "$BK_W1" <"$BK_DIR/last.json" || fail "the stations strip does not show the running session: $(bk_body)"

# Seventy minutes in is still one slot: the part slot is not past the grace.
BK_BACK70="$(node -e 'process.stdout.write(new Date(Date.now() - 70 * 60000 - 20000).toISOString())')"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/bookings/records/$BK_W1" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"starts_at\":\"$BK_BACK70\",\"checked_in_at\":\"$BK_BACK70\"}"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_W1/check-out" '{}')"
bk_expect "$BK_STATUS" 200 "" "checking out a 70-minute walk-in"
[ "$(bk_field charge.minutes)" = "70" ] || fail "the session ran '$(bk_field charge.minutes)' minutes, expected 70"
[ "$(bk_field charge.slots)" = "1" ] || fail "70 minutes is one slot with 10 minutes of grace, got '$(bk_field charge.slots)'"
[ "$(bk_field charge.price)" = "300" ] || fail "one slot at £3.00 came to '$(bk_field charge.price)'"
[ "$(bk_field price)" = "300" ] || fail "the session's price is '$(bk_field price)' after check-out"
[ "$(bk_field status)" = "completed" ] || fail "the checked-out session is '$(bk_field status)'"

# Seventy-two minutes, for a member, is two slots at the member price.
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/walk-in" "{\"resource\":\"$BK_PC\",\"customer\":\"$BK_MEMBER\"}")"
bk_expect "$BK_STATUS" 200 "" "a member's walk-in once the station is free"
BK_W2="$(bk_field id)"
BK_BACK72="$(node -e 'process.stdout.write(new Date(Date.now() - 72 * 60000 - 20000).toISOString())')"
curl -s -o /dev/null -X PATCH "$BASE/api/collections/bookings/records/$BK_W2" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d "{\"starts_at\":\"$BK_BACK72\",\"checked_in_at\":\"$BK_BACK72\"}"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_W2/check-out" '{}')"
bk_expect "$BK_STATUS" 200 "" "checking out a 72-minute walk-in"
[ "$(bk_field charge.slots)" = "2" ] || fail "72 minutes is two slots past the grace, got '$(bk_field charge.slots)'"
[ "$(bk_field charge.price)" = "500" ] || fail "two member slots at £2.50 came to '$(bk_field charge.price)'"
[ "$(bk_field charge.balance)" = "500" ] || fail "the session's balance for the till is '$(bk_field charge.balance)'"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_W2\"}]" 500)"
bk_expect "$BK_STATUS" 200 "" "paying the walk-in's charge at the till"
BK_ROW="$(bk_record bookings "$BK_W2")"
[ "$(echo "$BK_ROW" | jval paid)" = "500" ] || fail "the session's charge did not settle it"
[ "$(echo "$BK_ROW" | jval status)" = "completed" ] || fail "paying a finished session changed its status to '$(echo "$BK_ROW" | jval status)'"
[ "$(bk_audits booking_walk_in "$BK_W2")" = "1" ] || fail "the walk-in left no booking_walk_in audit row"
ok "a walk-in session starts on a free station, refuses a second, charges whole slots past the grace minutes at the member price, and its charge sells at the till"

# --- 34i. Events: capacity by party size, the waitlist, check-in by QR ----
BK_E_START="$(bk_at "$BK_LATER" 18:00)"
BK_E_END="$(bk_at "$BK_LATER" 21:00)"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $BK_CLERK_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK League\",\"starts_at\":\"$BK_E_START\",\"ends_at\":\"$BK_E_END\",\"status\":\"published\",\"capacity\":4}")"
[ "$BK_STATUS" = "400" ] || [ "$BK_STATUS" = "403" ] || fail "a plain staff member created an event ($BK_STATUS)"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK League\",\"format\":\"Swiss, 3 rounds\",\"starts_at\":\"$BK_E_START\",\"ends_at\":\"$BK_E_START\",\"status\":\"published\",\"capacity\":4,\"entry_fee\":500,\"member_fee\":300,\"online\":true}")"
bk_expect "$BK_STATUS" 400 "The event has to end after it starts." "an event that ends as it starts"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK League\",\"format\":\"Swiss, 3 rounds\",\"starts_at\":\"$BK_E_START\",\"ends_at\":\"$BK_E_END\",\"status\":\"published\",\"capacity\":4,\"entry_fee\":500,\"member_fee\":300,\"online\":true,\"resources\":[\"$BK_TABLE2\"]}")"
bk_expect "$BK_STATUS" 409 "BK Table 2 is booked from $(bk_clock "$BK_L18") to $(bk_clock "$BK_L20"). Pick another time or another table." "publishing an event onto a booked table"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK League\",\"format\":\"Swiss, 3 rounds\",\"starts_at\":\"$BK_E_START\",\"ends_at\":\"$BK_E_END\",\"status\":\"published\",\"capacity\":4,\"entry_fee\":500,\"member_fee\":300,\"online\":true}")"
bk_expect "$BK_STATUS" 200 "" "an admin publishing an event"
BK_EV="$(bk_field id)"
[ "$(bk_audits event_create "$BK_EV")" = "1" ] || fail "the event left no event_create audit row"

BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"customer\":\"$BK_PLAIN\",\"party_size\":2}")"
bk_expect "$BK_STATUS" 200 "" "entering a customer and a friend"
BK_EN1="$(bk_field id)"
[ "$(bk_field kind)" = "event" ] || fail "an entry is a booking of kind '$(bk_field kind)'"
[ "$(bk_field price)" = "1000" ] || fail "two entries at £5.00 came to '$(bk_field price)'"
[ "$(bk_field status)" = "confirmed" ] || fail "a staff entry is '$(bk_field status)'"
[ "$(bk_field starts_at)" = "$BK_E_START" ] || fail "the entry does not carry the event's start"
BK_STATUS="$(bk_post "$BK_MEMBER_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\"}")"
bk_expect "$BK_STATUS" 200 "" "a member entering online"
BK_EN2="$(bk_field id)"
[ "$(bk_field price)" = "300" ] || fail "a member's entry came to '$(bk_field price)', expected the member fee 300"
[ "$(bk_field status)" = "held" ] || fail "an online entry is '$(bk_field status)', expected held"
BK_STATUS="$(bk_post "$BK_MEMBER_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\"}")"
bk_expect "$BK_STATUS" 409 "You are already entered in BK League." "a member entering twice"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"name\":\"Pat Pair\",\"party_size\":2}")"
bk_expect "$BK_STATUS" 409 "BK League has 1 place left. Make the party smaller or add them to the waitlist." "a party of 2 for 1 place"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"name\":\"Pat Pair\",\"party_size\":2,\"waitlist\":true}")"
bk_expect "$BK_STATUS" 200 "" "putting a party of 2 on the waitlist"
BK_EN3="$(bk_field id)"
[ "$(bk_field status)" = "held" ] || fail "a waitlisted entry is '$(bk_field status)'"
[ "$(bk_field waitlist_position)" = "1" ] || fail "the first on the waitlist is at '$(bk_field waitlist_position)'"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"name\":\"Solo Sol\"}")"
bk_expect "$BK_STATUS" 409 "BK League is full. Add them to the waitlist instead." "one more when the waitlist has started"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"name\":\"Solo Sol\",\"waitlist\":true}")"
bk_expect "$BK_STATUS" 200 "" "a party of 1 joining the waitlist behind a party of 2"
BK_EN4="$(bk_field id)"
[ "$(bk_field waitlist_position)" = "2" ] || fail "a party of 1 jumped the queue: position '$(bk_field waitlist_position)'"
BK_EN3_LABEL="BK League, $(bk_day "$BK_E_START")"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_EN3\",\"unit_price\":1000}]" 1000)"
bk_expect "$BK_STATUS" 409 "$BK_EN3_LABEL is on the waitlist. Take payment when a place frees." "paying a waitlisted entry"

BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/events/$BK_EV")"
bk_expect "$BK_STATUS" 200 "" "reading the event with its entries"
[ "$(bk_field event.entered)" = "3" ] || fail "the event shows '$(bk_field event.entered)' entered, expected 3"
[ "$(bk_field event.waitlist)" = "2" ] || fail "the event shows '$(bk_field event.waitlist)' waiting, expected 2"
[ "$(bk_field event.places_left)" = "0" ] || fail "the event shows '$(bk_field event.places_left)' places left"
[ "$(jlen entries <"$BK_DIR/last.json")" = "4" ] || fail "the event lists $(jlen entries <"$BK_DIR/last.json") entries, expected 4"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/events?from=$BK_LATER&to=$BK_LATER")"
bk_expect "$BK_STATUS" 200 "" "the staff events list"
node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const e = d.events.find((x) => x.id === process.argv[1]);
  if (!e || e.waitlist !== 2 || e.entered !== 3 || e.format !== "Swiss, 3 rounds") process.exit(1);
' "$BK_EV" <"$BK_DIR/last.json" || fail "the staff events list is wrong: $(bk_body)"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings?event=$BK_EV")"
[ "$(jlen bookings <"$BK_DIR/last.json")" = "4" ] || fail "the bookings list for the event has $(jlen bookings <"$BK_DIR/last.json") entries"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_EN2/move" "{\"starts_at\":\"$BK_L21\",\"ends_at\":\"$BK_L22\"}")"
bk_expect "$BK_STATUS" 400 "An event entry moves with its event. Cancel it and enter another event instead." "moving an event entry"

# A place frees: the party of 2 moves up, then the party of 1 behind it.
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_EN1/cancel" '{"keep_deposit":false}')"
bk_expect "$BK_STATUS" 200 "" "cancelling an entry of two"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/events/$BK_EV")"
[ "$(bk_field event.waitlist)" = "0" ] || fail "two places freed and the waitlist is still '$(bk_field event.waitlist)'"
[ "$(bk_field event.entered)" = "4" ] || fail "after the waitlist moved up the event shows '$(bk_field event.entered)' entered"
BK_STATUS="$(bk_sell "[{\"booking\":\"$BK_EN3\"}]" 1000)"
bk_expect "$BK_STATUS" 200 "" "paying the entry that came off the waitlist"
[ "$(bk_record bookings "$BK_EN3" | jval status)" = "confirmed" ] || fail "paying did not confirm the entry off the waitlist"

# Public events show places and nothing about who entered.
BK_STATUS="$(bk_get "" "/api/public/events?from=$BK_LATER&to=$BK_LATER")"
bk_expect "$BK_STATUS" 200 "" "the public events list"
node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const e = d.events.find((x) => x.id === process.argv[1]);
  if (!e || e.places_left !== 0 || e.member_fee !== 300) process.exit(1);
' "$BK_EV" <"$BK_DIR/last.json" || fail "the public events list is wrong: $(bk_body)"
grep -q "Pat Pair\|Morgan\|Riley" "$BK_DIR/last.json" && fail "the public events list names an entrant"

# Event changes through the collection API: entries follow its time, and it
# is cancelled through its route.
BK_E_START2="$(bk_at "$BK_LATER" 17:00)"
BK_STATUS="$(bk_patch "$STAFF_TOKEN" "/api/collections/booking_events/records/$BK_EV" "{\"starts_at\":\"$BK_E_START2\"}")"
bk_expect "$BK_STATUS" 200 "" "moving the event an hour earlier"
[ "$(bk_record bookings "$BK_EN2" | jval starts_at | sed 's/ /T/')" = "$BK_E_START2" ] || fail "the entries did not follow the event's new time"
[ "$(bk_audits event_update "$BK_EV")" = "1" ] || fail "the change left no event_update audit row"
BK_STATUS="$(bk_patch "$STAFF_TOKEN" "/api/collections/booking_events/records/$BK_EV" '{"status":"cancelled"}')"
bk_expect "$BK_STATUS" 400 "Cancel an event from Bookings, so its entries are cancelled and told." "cancelling an event through the collection API"
ok "an event's entries count party sizes against its capacity, members pay the member fee, the waitlist keeps its order and moves up when places free, entries follow the event's time, and the public list names nobody"

# Check-in by the customer's QR, on an event today.
BK_TE_START="$BK_HOUR"
BK_TE_END="$(node -e 'process.stdout.write(new Date(Date.parse(process.argv[1]) + 3 * 3600000).toISOString())' "$BK_HOUR")"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK Tonight\",\"starts_at\":\"$BK_TE_START\",\"ends_at\":\"$BK_TE_END\",\"status\":\"published\",\"capacity\":10,\"entry_fee\":0}")"
bk_expect "$BK_STATUS" 200 "" "an event that has started today"
BK_TEV="$(bk_field id)"
BK_STATUS="$(bk_post "$BK_MEMBER_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_TEV\"}")"
bk_expect "$BK_STATUS" 403 "BK Tonight takes entries at the counter. Ring the shop to enter." "entering an event that takes no online entries"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_TEV\",\"customer\":\"$BK_MEMBER\"}")"
bk_expect "$BK_STATUS" 200 "" "entering the member at the counter after it started"
BK_TEN="$(bk_field id)"
[ "$(bk_field status)" = "confirmed" ] || fail "a free entry is '$(bk_field status)'"
BK_QR="$(bk_record customers "$BK_MEMBER" | jval qr_token)"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/events/$BK_TEV/check-in" '{"qr":"https://ggpos.example/c/not-a-real-token"}')"
bk_expect "$BK_STATUS" 404 "That card was not found. Scan it again or type the code." "checking in an unknown card"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/events/$BK_TEV/check-in" "{\"customer\":\"$BK_PLAIN\"}")"
bk_expect "$BK_STATUS" 404 "Riley Plain is not entered in BK Tonight. Add them as an entry first." "checking in somebody not entered"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/events/$BK_TEV/check-in" "{\"qr\":\"https://ggpos.example/c/$BK_QR\"}")"
bk_expect "$BK_STATUS" 200 "" "checking the member in by their QR"
[ "$(bk_field id)" = "$BK_TEN" ] || fail "the QR checked in a different entry"
[ "$(bk_field status)" = "checked_in" ] || fail "the entry checked in by QR is '$(bk_field status)'"
[ "$(bk_list audit_log "action='booking_check_in' && record='$BK_TEN'" | jval "items.0.meta.via")" = "qr" ] \
  || fail "the QR check-in is not audited as one"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/events/$BK_TEV/check-in" "{\"qr\":\"$BK_QR\"}")"
bk_expect "$BK_STATUS" 409 "This booking is already checked in." "checking the member in twice"
ok "check-in by the customer's QR finds their entry and checks it in once, and an unknown card or someone not entered is said plainly"

# A free entry from the tier's perk, and given back when it is cancelled.
BK_PASS_TIER="$(curl -s -X POST "$BASE/api/collections/loyalty_tiers/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"BK Pass","threshold_points":0,"colour_token":"tier-pass","sort":45,"paid_plan":true,"perks":[{"type":"free_event_entries","value":2,"perMonth":true}]}' | jval id)"
[ -n "$BK_PASS_TIER" ] || fail "could not make the free-entry tier"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/memberships" "{\"customer\":\"$BK_MEMBER\",\"tier\":\"$BK_PASS_TIER\",\"months\":1,\"price\":0}")"
bk_expect "$BK_STATUS" 200 "" "giving the member the free-entry tier"
BK_MEMBERSHIP="$(bk_field membership.id)"
[ -n "$BK_MEMBERSHIP" ] || BK_MEMBERSHIP="$(bk_field id)"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK Draft Night\",\"starts_at\":\"$(bk_at "$BK_LATER" 10:00)\",\"ends_at\":\"$(bk_at "$BK_LATER" 12:00)\",\"status\":\"published\",\"capacity\":10,\"entry_fee\":800}")"
bk_expect "$BK_STATUS" 200 "" "an event with an entry fee"
BK_FEV="$(bk_field id)"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_FEV\",\"customer\":\"$BK_MEMBER\",\"party_size\":2,\"free_entry\":true}")"
bk_expect "$BK_STATUS" 200 "" "entering the member and a friend with a free entry"
BK_FEN1="$(bk_field id)"
[ "$(bk_field price)" = "800" ] || fail "one free entry of two at £8.00 came to '$(bk_field price)', expected 800"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_FEV\",\"name\":\"No Card\",\"free_entry\":true}")"
bk_expect "$BK_STATUS" 400 "Pick the customer to use their free entry." "a free entry with no customer"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings/$BK_FEN1/cancel" '{}')"
bk_expect "$BK_STATUS" 200 "" "cancelling the free entry"
[ "$(bk_list audit_log "action='booking_cancel' && record='$BK_FEN1'" | jval "items.0.meta.free_entry_back")" = "true" ] \
  || fail "cancelling the free entry did not give it back"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_FEV\",\"customer\":\"$BK_MEMBER\",\"free_entry\":true}")"
bk_expect "$BK_STATUS" 200 "" "the free entry used again"
[ "$(bk_field price)" = "0" ] || fail "a free entry for one came to '$(bk_field price)'"
[ "$(bk_field status)" = "confirmed" ] || fail "a free entry is '$(bk_field status)'"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_TEV\",\"customer\":\"$BK_PLAIN\",\"free_entry\":true}")"
[ "$BK_STATUS" = "422" ] || fail "a free entry for a customer whose tier has none returned $BK_STATUS: $(bk_body)"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"customer\":\"$BK_MEMBER\",\"free_entry\":true,\"waitlist\":true}")"
[ "$BK_STATUS" = "409" ] || fail "a second entry for the member to an event they are in returned $BK_STATUS"
ok "a tier's free event entries take one player's fee off at the counter, count against the month, and come back when the entry is cancelled"

# Cancelling an event: managers only; every entry cancelled and told.
BK_STATUS="$(bk_post "$BK_CLERK_TOKEN" "/api/vault/events/$BK_EV/cancel" '{}')"
bk_expect "$BK_STATUS" 403 "Only a manager can cancel an event. Ask one to do it." "a plain staff member cancelling an event"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/events/$BK_EV/cancel" '{}')"
bk_expect "$BK_STATUS" 200 "" "cancelling the event"
[ "$(bk_field event.status)" = "cancelled" ] || fail "the event is '$(bk_field event.status)'"
[ "$(bk_field cancelled)" = "3" ] || fail "cancelling the event cancelled $(bk_field cancelled) entries, expected 3"
[ "$(bk_field refunds.0.amount)" = "1000" ] || fail "the refunds do not list the paid entry: $(bk_body)"
[ "$(bk_list bookings "event='$BK_EV' && status!='cancelled'" | jval totalItems)" = "0" ] || fail "an entry of the cancelled event is still live"
[ "$(bk_list notifications "customer='$BK_MEMBER' && type='booking_cancelled'" | jval totalItems)" -ge 1 ] \
  || fail "the member was not told the event is cancelled"
[ "$(bk_audits event_cancel "$BK_EV")" = "1" ] || fail "the cancellation left no event_cancel audit row"
BK_STATUS="$(bk_post "$STAFF_TOKEN" "/api/vault/bookings" "{\"event\":\"$BK_EV\",\"name\":\"Too Late\"}")"
bk_expect "$BK_STATUS" 409 "BK League is cancelled." "entering a cancelled event"
ok "only a manager cancels an event, which cancels and tells every entry and lists the refunds"

# --- 34j. The race: two tills, one slot; two tills, one balance -----------
for n in 1 2 3; do
  BK_RS="$(bk_at "$BK_LATER" "0$((n + 1)):00")"
  BK_RE="$(bk_at "$BK_LATER" "0$((n + 2)):00")"
  BK_RACE_BODY="{\"resource\":\"$BK_TABLE\",\"starts_at\":\"$BK_RS\",\"ends_at\":\"$BK_RE\",\"name\":\"Racer $n\"}"
  curl -s -o "$BK_DIR/race-a.json" -w '%{http_code}' -X POST "$BASE/api/vault/bookings" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$BK_RACE_BODY" >"$BK_DIR/race-a.code" &
  BK_PA=$!
  curl -s -o "$BK_DIR/race-b.json" -w '%{http_code}' -X POST "$BASE/api/vault/bookings" \
    -H "Authorization: $BK_CLERK_TOKEN" -H "Content-Type: application/json" -d "$BK_RACE_BODY" >"$BK_DIR/race-b.code" &
  BK_PB=$!
  wait "$BK_PA" "$BK_PB"
  BK_CODES="$(printf '%s\n%s\n' "$(cat "$BK_DIR/race-a.code")" "$(cat "$BK_DIR/race-b.code")" | sort | tr '\n' ' ')"
  [ "$BK_CODES" = "200 409 " ] || fail "race $n: two tills booking one slot answered '$BK_CODES', expected one 200 and one 409"
  BK_LOSER="$BK_DIR/race-a.json"
  [ "$(cat "$BK_DIR/race-a.code")" = "200" ] && BK_LOSER="$BK_DIR/race-b.json"
  [ "$(jval message <"$BK_LOSER")" = "BK Table 1 is booked from $(bk_clock "$BK_RS") to $(bk_clock "$BK_RE"). Pick another time or another table." ] \
    || fail "race $n: the till that lost said '$(jval message <"$BK_LOSER")'"
  [ "$(bk_list bookings "resource='$BK_TABLE' && starts_at='$(echo "$BK_RS" | sed 's/T/ /')' && status!='cancelled'" | jval totalItems)" = "1" ] \
    || fail "race $n: the slot holds more than one booking"
done

BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE2" "$(bk_at "$BK_LATER" 10:00)" "$(bk_at "$BK_LATER" 12:00)" '"name":"Pay Race"')"
bk_expect "$BK_STATUS" 200 "" "a booking for the payment race"
BK_PR="$(bk_field id)"
BK_PAY_BODY="{\"lines\":[{\"booking\":\"$BK_PR\"}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":1000,\"card_last4\":\"3434\"}]}"
curl -s -o "$BK_DIR/pay-a.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$BK_PAY_BODY" >"$BK_DIR/pay-a.code" &
BK_PA=$!
curl -s -o "$BK_DIR/pay-b.json" -w '%{http_code}' -X POST "$BASE/api/vault/sales/complete" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "$BK_PAY_BODY" >"$BK_DIR/pay-b.code" &
BK_PB=$!
wait "$BK_PA" "$BK_PB"
BK_CODES="$(printf '%s\n%s\n' "$(cat "$BK_DIR/pay-a.code")" "$(cat "$BK_DIR/pay-b.code")" | sort | tr '\n' ' ')"
[ "$BK_CODES" = "200 409 " ] || fail "two tills paying one balance answered '$BK_CODES': $(cat "$BK_DIR/pay-a.json") $(cat "$BK_DIR/pay-b.json")"
[ "$(bk_record bookings "$BK_PR" | jval paid)" = "1000" ] || fail "the raced booking shows paid '$(bk_record bookings "$BK_PR" | jval paid)', expected 1000"
ok "two tills booking one slot at once get one booking and the clash sentence, and two tills paying one balance get one sale"

# --- 34k. The weekly repeats, made ahead by the cron ----------------------
BK_WK_START="$(bk_at "$BK_TOMORROW" 18:00)"
BK_WK_END="$(bk_at "$BK_TOMORROW" 21:00)"
BK_WK14="$(bk_at "$(bk_node 'b.addDays(a[0], 14)' "$BK_TOMORROW")" 18:00)"
BK_WK14_END="$(bk_at "$(bk_node 'b.addDays(a[0], 14)' "$BK_TOMORROW")" 19:00)"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE2" "$BK_WK14" "$BK_WK14_END" '"name":"In The Way"')"
bk_expect "$BK_STATUS" 200 "" "a booking on table 2 in two weeks' time"
BK_STATUS="$(curl -s -o "$BK_DIR/last.json" -w '%{http_code}' -X POST "$BASE/api/collections/booking_events/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"BK Weekly\",\"starts_at\":\"$BK_WK_START\",\"ends_at\":\"$BK_WK_END\",\"status\":\"published\",\"capacity\":8,\"entry_fee\":300,\"online\":true,\"repeat_weekly\":true,\"resources\":[\"$BK_TABLE2\"]}")"
bk_expect "$BK_STATUS" 200 "" "a weekly event"
BK_WK="$(bk_field id)"
bk_cron booking_events_repeat
BK_MADE="$(bk_wait_rows booking_events "repeat_of='$BK_WK'" 3)"
[ "$BK_MADE" = "3" ] || fail "the repeat cron made $BK_MADE weekly events in the next four weeks, expected 3"
BK_REPEATS="$(bk_list booking_events "repeat_of='$BK_WK'")"
node --experimental-strip-types -e "
  const b = require('$BK_SHARED');
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8')).items;
  const start = process.argv[1];
  const want = [7, 14, 21].map((k) => b.shopTimeToUtc(b.addDays(b.shopDateOf(new Date(start)), k), '18:00').toISOString());
  const got = d.map((x) => new Date(x.starts_at.replace(' ', 'T')).toISOString()).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(got, want); process.exit(1); }
  for (const x of d) {
    if (b.shopClock(new Date(x.starts_at.replace(' ', 'T')).toISOString()) !== '18:00') process.exit(2);
    if (x.repeat_weekly) process.exit(3);
    if (x.name !== 'BK Weekly' || x.capacity !== 8 || x.entry_fee !== 300) process.exit(4);
  }
  const clash = d.find((x) => new Date(x.starts_at.replace(' ', 'T')).toISOString() === want[1]);
  if (!clash || clash.status !== 'draft') process.exit(5);
  if (d.filter((x) => x.status === 'published').length !== 2) process.exit(6);
" "$BK_WK_START" <<<"$BK_REPEATS" 2>/dev/null || fail "the weekly repeats are wrong: $BK_REPEATS"
[ "$(bk_list notifications "type='event_repeat_clash'" | jval totalItems)" -ge 1 ] || fail "the shop was not told a repeat landed on a booking"
bk_cron booking_events_repeat
sleep 1
[ "$(bk_list booking_events "repeat_of='$BK_WK'" | jval totalItems)" = "3" ] || fail "running the repeat cron again made more weekly events"
[ "$(bk_list audit_log "action='event_repeat'" | jval totalItems)" = "3" ] || fail "the repeats are not audited once each"
ok "the repeat cron makes each weekly event in the next four weeks once, at the same shop clock time, and a repeat landing on a booked table is a draft the shop is told about"

# --- 34l. The day-before reminders ----------------------------------------
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$(bk_at "$BK_TOMORROW" 12:00)" "$(bk_at "$BK_TOMORROW" 14:00)" "\"customer\":\"$BK_MEMBER\"")"
bk_expect "$BK_STATUS" 200 "" "a member's booking tomorrow"
BK_RM1="$(bk_field id)"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$(bk_at "$BK_TOMORROW" 15:00)" "$(bk_at "$BK_TOMORROW" 16:00)" '"name":"Email Only","email":"s34-email-only@local.test"')"
bk_expect "$BK_STATUS" 200 "" "a booking tomorrow with only an email"
BK_RM2="$(bk_field id)"
BK_STATUS="$(bk_book "$STAFF_TOKEN" "$BK_TABLE" "$(bk_at "$BK_TOMORROW" 16:00)" "$(bk_at "$BK_TOMORROW" 17:00)" '"name":"Phone Only","phone":"07700900999"')"
BK_RM3="$(bk_field id)"
bk_cron bookings_remind
[ "$(bk_wait_rows audit_log "action='booking_reminder' && (record='$BK_RM1' || record='$BK_RM2')" 2)" = "2" ] \
  || fail "the reminder cron did not remind both of tomorrow's bookings"
[ "$(bk_audits booking_reminder "$BK_RM3")" = "0" ] || fail "a booking with no customer or email was 'reminded'"
BK_REMINDER="$(bk_list notifications "customer='$BK_MEMBER' && type='booking_reminder'")"
[ "$(echo "$BK_REMINDER" | jval totalItems)" = "1" ] || fail "the member has $(echo "$BK_REMINDER" | jval totalItems) reminders, expected 1"
[ "$(echo "$BK_REMINDER" | jval items.0.body)" = "BK Table 1 is booked for you tomorrow, $(bk_day "$(bk_at "$BK_TOMORROW" 12:00)"), from 12:00 to 14:00. £8.00 is left to pay at the till." ] \
  || fail "the reminder says '$(echo "$BK_REMINDER" | jval items.0.body)'"
bk_cron bookings_remind
sleep 1
[ "$(bk_list notifications "customer='$BK_MEMBER' && type='booking_reminder'" | jval totalItems)" = "1" ] || fail "a second run reminded the member again"
[ "$(bk_list audit_log "action='booking_reminder' && record='$BK_RM2'" | jval totalItems)" = "1" ] || fail "a second run emailed the booking again"
ok "the reminder cron tells tomorrow's bookings once each, by notification and email, with what is left to pay"

# --- 34m. Hours checked on save, and the staff list -----------------------
BK_STATUS="$(bk_patch "$STAFF_TOKEN" "/api/collections/resources/records/$BK_SPLIT" '{"hours":{"mon":[["18:00","10:00"]]}}')"
bk_expect "$BK_STATUS" 400 "On Monday, 18:00 to 10:00 ends before it starts. Check the times." "saving hours that end before they start"
BK_STATUS="$(bk_patch "$STAFF_TOKEN" "/api/collections/settings/records/$BK_SETTINGS_ID" '{"opening_hours":{"funday":[]}}')"
bk_expect "$BK_STATUS" 400 "There is no day called funday. Use mon, tue, wed, thu, fri, sat or sun." "saving shop hours with a day that is not one"
BK_STATUS="$(bk_patch "$STAFF_TOKEN" "/api/collections/resources/records/$BK_SPLIT" '{"note":"By the window"}')"
bk_expect "$BK_STATUS" 200 "" "a manager editing a resource"
[ "$(bk_list audit_log "action='resource_update' && record='$BK_SPLIT'" | jval "items.0.meta.fields.0")" = "note" ] \
  || fail "editing a resource is not audited by field"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings?from=$BK_LATER&to=$BK_LATER&resource=$BK_TABLE")"
bk_expect "$BK_STATUS" 200 "" "the day's bookings for one table"
node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.bookings.length) process.exit(1);
  if (d.bookings.some((x) => !x.resource || x.resource.id !== process.argv[1])) process.exit(2);
  const s = d.bookings.map((x) => x.starts_at);
  if (JSON.stringify(s) !== JSON.stringify(s.slice().sort())) process.exit(3);
' "$BK_TABLE" <"$BK_DIR/last.json" || fail "the day's list is wrong: $(bk_body)"
BK_STATUS="$(bk_get "$STAFF_TOKEN" "/api/vault/bookings?from=$BK_TODAY&to=$(bk_node 'b.addDays(a[0], 60)' "$BK_TODAY")")"
bk_expect "$BK_STATUS" 400 "Ask for six weeks at most." "a list longer than six weeks"
ok "opening hours are checked as they are saved, a resource's changes are audited, and the day list is in time order"

# --- 34n. Audit rows carry no customer detail ------------------------------
BK_AUDIT_ALL="$(bk_list audit_log "action~'booking_' || action~'event_'")"
for secret in "Morgan Guild" "s34-member@local.test" "07700900341" "Jo Phone" "07700900123" "s34-email-only" "Birthday"; do
  echo "$BK_AUDIT_ALL" | grep -qF "$secret" && fail "an audit row carries '$secret'"
done
for action in booking_create booking_move booking_cancel booking_no_show booking_check_in booking_check_out booking_walk_in booking_paid booking_unpaid booking_reminder event_create event_update event_cancel event_repeat resource_create resource_update; do
  [ "$(bk_list audit_log "action='$action'" | jval totalItems)" -ge 1 ] || fail "there is no $action audit row"
done
ok "every booking and event change is audited, with no customer's name, phone, email or note in the rows"

# --- tidy up ---------------------------------------------------------------
# The membership off the member and the tier gone; every booking, event and
# resource this section made removed (their sale lines keep their sales); the
# shop's hours back as they were.
curl -s -o /dev/null -X POST "$BASE/api/vault/memberships/$BK_MEMBERSHIP/cancel" -H "Authorization: $STAFF_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
curl -s -o /dev/null -X DELETE "$BASE/api/collections/loyalty_tiers/records/$BK_PASS_TIER" -H "Authorization: $SUPER_TOKEN"
curl -s -o /dev/null -X DELETE "$BASE/api/collections/till_products/records/$BK_PRODUCT" -H "Authorization: $SUPER_TOKEN"
BK_ALL_RESOURCES="'$BK_TABLE','$BK_TABLE2','$BK_SPLIT','$BK_ROOM','$BK_PC'"
for id in $(bk_list bookings "resource='$BK_TABLE' || resource='$BK_TABLE2' || resource='$BK_SPLIT' || resource='$BK_ROOM' || resource='$BK_PC' || event.name~'BK '" \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.items.map(x=>x.id).join(" "))'); do
  curl -s -o /dev/null -X DELETE "$BASE/api/collections/bookings/records/$id" -H "Authorization: $SUPER_TOKEN"
done
for id in $(bk_list booking_events "name~'BK ' && repeat_of!=''" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.items.map(x=>x.id).join(" "))') \
  $(bk_list booking_events "name~'BK '" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.items.map(x=>x.id).join(" "))'); do
  curl -s -o /dev/null -X DELETE "$BASE/api/collections/booking_events/records/$id" -H "Authorization: $SUPER_TOKEN"
done
for id in $BK_TABLE $BK_TABLE2 $BK_SPLIT $BK_ROOM $BK_PC; do
  curl -s -o /dev/null -X DELETE "$BASE/api/collections/resources/records/$id" -H "Authorization: $SUPER_TOKEN"
done
BK_STATUS="$(bk_patch "$SUPER_TOKEN" "/api/collections/settings/records/$BK_SETTINGS_ID" "{\"opening_hours\":$BK_HOURS_BEFORE}")"
bk_expect "$BK_STATUS" 200 "" "putting the shop's hours back"
[ "$(bk_list resources "name~'BK '" | jval totalItems)" = "0" ] || fail "section 34 left resources behind"
[ "$(bk_list booking_events "name~'BK '" | jval totalItems)" = "0" ] || fail "section 34 left events behind"
[ "$(bk_list bookings "id!=''" | jval totalItems)" = "0" ] || fail "section 34 left bookings behind"
unset BK_ALL_RESOURCES
ok "section 34 leaves no resource, event or booking behind and the shop's hours as it found them"
