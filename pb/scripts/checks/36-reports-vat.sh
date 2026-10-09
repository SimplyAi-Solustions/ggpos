# shellcheck shell=bash
# -----------------------------------------------------------------------
# 36. Reports, Excel and VAT (docs/api-contract-launch.md, section 3):
#     the treatment and rate each line is charged at (its own, else its
#     branch's), nothing charged before vat_registered_from, the dashboard's
#     figures against hand-worked sales with costs, a refund and discounts,
#     the dashboard agreeing with the margin, stock and buy-ins reports, the
#     VAT return's rows and boxes for a quarter of those sales, a quarter
#     before registration answering 0 with its note, the hand-entered
#     purchase figures for boxes 4 and 7, and every refusal.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR,
# $ROOT and the ok/fail/jval helpers. Other sections' sales of today are
# on file too, so the dashboard and the return are read before and after
# this section's sales and the difference is what is checked. It leaves the
# VAT settings off, the category tree and the till as it found them.
# -----------------------------------------------------------------------

S36_DIR="$TMP_DIR/s36"
mkdir -p "$S36_DIR"
S36_SHARED="$ROOT/pb/pb_hooks/lib/shared"

# --- helpers -------------------------------------------------------------

# $1 token, $2 method, $3 path, [$4 JSON body] -> the status code; the body
# is left in $S36_DIR/last.json.
s36_call() {
  if [ -n "${4:-}" ]; then
    curl -s -o "$S36_DIR/last.json" -w '%{http_code}' -X "$2" "$BASE$3" \
      -H "Authorization: $1" -H "Content-Type: application/json" -d "$4"
  else
    curl -s -o "$S36_DIR/last.json" -w '%{http_code}' -X "$2" "$BASE$3" -H "Authorization: $1"
  fi
}
s36_body() { cat "$S36_DIR/last.json"; }
s36_field() { jval "$1" <"$S36_DIR/last.json"; }

# $1 status, $2 expected status, $3 expected message ("" for any), $4 what was tried.
s36_expect() {
  [ "$1" = "$2" ] || fail "$4 returned $1, expected $2: $(s36_body)"
  if [ -n "$3" ]; then
    [ "$(s36_field message)" = "$3" ] || fail "$4 said '$(s36_field message)', expected '$3'"
  fi
}

# $1 collection, $2 filter -> the superuser's list of matching records.
s36_list() {
  curl -s -G -H "Authorization: $SUPER_TOKEN" --data-urlencode "filter=$2" \
    --data-urlencode "perPage=500" --data-urlencode "sort=created,id" "$BASE/api/collections/$1/records"
}

# $1 JSON body -> a new item's id (the superuser writes, so a blank scheme is allowed).
s36_item() {
  curl -s -X POST "$BASE/api/collections/items/records" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d "$1" | jval id
}

# $1 JSON patch for the settings record.
s36_settings() {
  curl -s -o "$S36_DIR/settings.json" -X PATCH "$BASE/api/collections/settings/records/$S36_SETTINGS_ID" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d "$1"
  [ -n "$(jval id <"$S36_DIR/settings.json")" ] || fail "the settings patch $1 did not save: $(cat "$S36_DIR/settings.json")"
}

# Save the last body under a name.
s36_keep() { cp "$S36_DIR/last.json" "$S36_DIR/$1.json"; }

# $1 a JavaScript expression over `a` (an earlier body by name) and `b` (a
# later one) -> its value, as JSON for an object.
s36_js() {
  node -e '
    const fs = require("fs");
    const read = (name) => (name ? JSON.parse(fs.readFileSync(process.argv[2] + "/" + name + ".json", "utf8")) : null);
    const a = read(process.argv[3]);
    const b = read(process.argv[4]);
    const v = eval(process.argv[1]);
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$1" "$S36_DIR" "${2:-}" "${3:-}"
}

# The default register's open session, or "".
s36_session() {
  curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval "session.id"
}

# --- setup ---------------------------------------------------------------

S36_GAME="$(curl -s "$BASE/api/collections/games/records?filter=key%3D%27pokemon%27" -H "Authorization: $STAFF_TOKEN" | jval "items.0.id")"
[ -n "$S36_GAME" ] || fail "36: the seeded pokemon game is missing"
S36_SETTINGS_ID="$(curl -s "$BASE/api/collections/settings/records?perPage=1" -H "Authorization: $SUPER_TOKEN" | jval "items.0.id")"
[ -n "$S36_SETTINGS_ID" ] || fail "36: no settings record"

# Today and tomorrow in shop time (what vat_registered_from is compared
# with), UTC days either side for the dashboard, and this quarter.
S36_TODAY="$(node -e "process.stdout.write(require('$S36_SHARED/bookings.js').shopDateOf(new Date()))")"
S36_TOMORROW="$(node -e "process.stdout.write(require('$S36_SHARED/vatreturn.js').dayAfter('$S36_TODAY'))")"
S36_FROM="$(node -e "const d=new Date(Date.now()-86400000);process.stdout.write(d.toISOString().slice(0,10))")"
S36_TO="$(node -e "const d=new Date(Date.now()+86400000);process.stdout.write(d.toISOString().slice(0,10))")"
S36_PERIOD="$(node -e "process.stdout.write(require('$S36_SHARED/vatreturn.js').quarterOf('$S36_TODAY', 1).period)")"
S36_PREVIOUS="$(node -e "const q=require('$S36_SHARED/vatreturn.js');process.stdout.write(q.shiftQuarter(q.quarterOf('$S36_TODAY', 1), -1, 1).period)")"

# A plain staff member, who may not see reports (reports_view is a manager's).
S36_CLERK_EMAIL="s36-clerk@local.test"
S36_CLERK_PASSWORD="s36-clerk-password-123"
curl -s -o /dev/null -X POST "$BASE/api/collections/staff/records" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$S36_CLERK_EMAIL\",\"password\":\"$S36_CLERK_PASSWORD\",\"passwordConfirm\":\"$S36_CLERK_PASSWORD\",\"name\":\"S36 Clerk\",\"role\":\"staff\",\"active\":true}"
S36_CLERK_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" \
  -H "Content-Type: application/json" -d "{\"identity\":\"$S36_CLERK_EMAIL\",\"password\":\"$S36_CLERK_PASSWORD\"}" | jval token)"
[ -n "$S36_CLERK_TOKEN" ] || fail "36: could not sign the clerk in"

# The till, open as found or opened here (and closed again at the end).
S36_TILL_WAS_OPEN="$(s36_session)"
if [ -z "$S36_TILL_WAS_OPEN" ]; then
  S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/cash-sessions/open" '{"float":20000}')"
  s36_expect "$S36_STATUS" 200 "" "opening the till"
fi

# A top-level branch whose default is reduced, 5 percent.
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/collections/categories/records" \
  '{"name":"S36 Reduced branch","active":true,"default_tax_scheme":"standard","default_vat_rate":5}')"
s36_expect "$S36_STATUS" 200 "" "making the reduced branch"
S36_BRANCH="$(s36_field id)"

s36_stock() {
  # $1 title, $2 qty, $3 cost, $4 price, $5 scheme ("" for none), $6 rate, $7 branch or ""
  local category=""
  if [ -n "$7" ]; then category=",\"category\":\"$7\""; fi
  s36_item "{\"kind\":\"sealed\",\"game\":\"$S36_GAME\",\"title\":\"$1\",\"qty\":$2,\"cost\":$3,\"price\":$4,\"status\":\"in_stock\",\"tax_scheme\":\"$5\",\"vat_rate\":$6,\"source\":\"supplier\"$category}"
}

S36_A="$(s36_stock "S36 Margin box" 1 40000 70000 margin 0 "$S36_BRANCH")"
S36_B="$(s36_stock "S36 Standard deck" 1 1000 2400 standard 0 "$S36_BRANCH")"
S36_C="$(s36_stock "S36 Branch drink" 2 500 1050 "" 0 "$S36_BRANCH")"
S36_D="$(s36_stock "S36 Zero book" 1 100 300 zero 0 "$S36_BRANCH")"
S36_F="$(s36_stock "S36 Standard sleeves" 3 600 1200 standard 0 "$S36_BRANCH")"
S36_G="$(s36_stock "S36 Margin card" 1 4500 5000 margin 0 "$S36_BRANCH")"
S36_Y1="$(s36_stock "S36 Early standard" 1 200 1200 standard 0 "")"
S36_Y2="$(s36_stock "S36 Early margin" 1 1000 3000 margin 0 "")"
for S36_ID in "$S36_A" "$S36_B" "$S36_C" "$S36_D" "$S36_F" "$S36_G" "$S36_Y1" "$S36_Y2"; do
  [ -n "$S36_ID" ] || fail "36: an item did not save"
done
S36_STATUS="$(s36_call "$SUPER_TOKEN" POST "/api/collections/till_products/records" \
  "{\"name\":\"S36 Exempt service\",\"kind\":\"service\",\"price\":800,\"tax_scheme\":\"exempt\",\"vat_rate\":0,\"category\":\"$S36_BRANCH\",\"active\":true}")"
s36_expect "$S36_STATUS" 200 "" "making the exempt till product"
S36_E="$(s36_field id)"

# --- 36a. Nothing is charged before vat_registered_from ------------------
s36_settings "{\"vat_registered\":true,\"vat_registered_from\":\"$S36_TOMORROW 00:00:00.000Z\",\"vat_standard_rate\":20,\"vat_period_start_month\":1}"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_FROM&to=$S36_TO")"
s36_expect "$S36_STATUS" 200 "" "the dashboard before the early sale"
s36_keep early0
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S36_Y1\",\"qty\":1},{\"item\":\"$S36_Y2\",\"qty\":1}],\"tenders\":[{\"method\":\"card_tide\",\"amount\":4200,\"card_last4\":\"3636\"}]}")"
s36_expect "$S36_STATUS" 200 "" "a sale the day before VAT registration starts"
[ "$(s36_field vat_total)" = "0" ] || fail "a sale before vat_registered_from carried VAT: $(s36_field vat_total)"
S36_Y_SALE="$(s36_field "sale.id")"
S36_Y_LINES="$(s36_list sale_lines "sale='$S36_Y_SALE'" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  process.stdout.write(rows.map((r) => `${r.tax_scheme}:${r.vat_rate}:${r.vat_amount}`).sort().join(","));
')"
[ "$S36_Y_LINES" = "margin:0:0,standard:0:0" ] || fail "the early sale's lines read $S36_Y_LINES"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_FROM&to=$S36_TO")"
s36_keep early1
[ "$(s36_js "b.sales.net - a.sales.net" early0 early1)" = "4200" ] || fail "the early sale did not reach the dashboard's net"
[ "$(s36_js "b.sales.vat - a.sales.vat" early0 early1)" = "0" ] \
  || fail "the dashboard counted VAT on a sale before registration: $(s36_js "b.sales.vat - a.sales.vat" early0 early1)"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PERIOD")"
s36_expect "$S36_STATUS" 200 "" "the return while registration starts tomorrow"
[ "$(s36_js "b.rows.filter((r) => r.sale === '$S36_Y_SALE').length" "" last)" = "0" ] \
  || fail "the early sale is in the VAT return"
S36_NOTE="$(node -e "
  const q = require('$S36_SHARED/vatreturn.js');
  process.stdout.write(q.vatScopeNote(q.vatQuarter('$S36_PERIOD', 1), { registered: true, from: '$S36_TOMORROW' }));
")"
[ "$(s36_field note)" = "$S36_NOTE" ] || fail "the return's note reads '$(s36_field note)', expected '$S36_NOTE'"
ok "a sale before vat_registered_from is charged no VAT, adds no VAT to the dashboard, stays out of the return, and the note says when registration starts"

# --- 36b. Each line charged by its own treatment, else its branch's ------
s36_settings "{\"vat_registered_from\":\"$S36_TODAY 00:00:00.000Z\"}"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_FROM&to=$S36_TO&compare=previous")"
s36_expect "$S36_STATUS" 200 "" "the dashboard before this section's sales"
s36_keep dash0
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PERIOD")"
s36_expect "$S36_STATUS" 200 "" "the return before this section's sales"
s36_keep vat0

# Sale 1, hand-worked. Lines before the ticket discount: margin box 700.00,
# standard deck 24.00 less 4.00 off the line, two branch drinks at 10.50,
# a zero-rated book 3.00 and the exempt service 8.00: 752.00. A ticket
# discount of 75.20 is 10 percent of every line exactly, so the nets are
# 630.00, 18.00, 18.90, 2.70 and 7.20 (676.80) whichever order the lines are
# stored in. VAT at the till: 18.00 x 20/120 = 3.00, 18.90 x 5/105 = 0.90;
# the margin box, the book and the service carry none.
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S36_A\",\"qty\":1},{\"item\":\"$S36_B\",\"qty\":1,\"discount\":400},{\"item\":\"$S36_C\",\"qty\":2},{\"item\":\"$S36_D\",\"qty\":1},{\"product\":\"$S36_E\",\"qty\":1}],\"discount\":7520,\"discount_source\":\"manual\",\"tenders\":[{\"method\":\"card_tide\",\"amount\":67680,\"card_last4\":\"3636\"}]}")"
s36_expect "$S36_STATUS" 200 "" "sale 1, one line of each treatment"
S36_S1="$(s36_field "sale.id")"
S36_S1_NUMBER="$(s36_field "sale.number")"
[ "$(s36_field vat_total)" = "390" ] || fail "sale 1 carried VAT of $(s36_field vat_total), expected 390"
S36_S1_LINES="$(s36_list sale_lines "sale='$S36_S1'" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const ids = process.argv.slice(1);
  const name = { [ids[0]]: "A", [ids[1]]: "B", [ids[2]]: "C", [ids[3]]: "D", [ids[4]]: "E" };
  process.stdout.write(rows.map((r) => `${name[r.item || r.product]}:${r.tax_scheme}:${r.vat_rate}:${r.vat_amount}`).sort().join(","));
' "$S36_A" "$S36_B" "$S36_C" "$S36_D" "$S36_E")"
[ "$S36_S1_LINES" = "A:margin:0:0,B:standard:20:300,C:standard:5:90,D:zero:0:0,E:exempt:0:0" ] \
  || fail "sale 1's lines read $S36_S1_LINES"
ok "each line is charged by its own treatment (margin, standard 20%, zero, exempt), a line with none by its branch's reduced 5%, inside the ticket discount's spread"

# Sale 2: two standard sleeves at 12.00 (VAT 4.00) and a margin card at
# 50.00 that cost 45.00, paid in cash; then one sleeve and the card go back.
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/sales/complete" \
  "{\"lines\":[{\"item\":\"$S36_F\",\"qty\":2},{\"item\":\"$S36_G\",\"qty\":1}],\"tenders\":[{\"method\":\"cash\",\"amount\":7400}]}")"
s36_expect "$S36_STATUS" 200 "" "sale 2, to refund part of"
S36_S2="$(s36_field "sale.id")"
[ "$(s36_field vat_total)" = "400" ] || fail "sale 2 carried VAT of $(s36_field vat_total), expected 400"
S36_S2_ROWS="$(s36_list sale_lines "sale='$S36_S2'")"
S36_F_LINE="$(echo "$S36_S2_ROWS" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).items;process.stdout.write(r.find((x)=>x.item===process.argv[1]).id)' "$S36_F")"
S36_G_LINE="$(echo "$S36_S2_ROWS" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).items;process.stdout.write(r.find((x)=>x.item===process.argv[1]).id)' "$S36_G")"
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/sales/$S36_S2/refund" \
  "{\"lines\":[{\"sale_line\":\"$S36_F_LINE\",\"qty\":1},{\"sale_line\":\"$S36_G_LINE\",\"qty\":1}],\"reason\":\"Changed their mind\",\"tenders\":[{\"method\":\"cash\",\"amount\":6200}]}")"
s36_expect "$S36_STATUS" 200 "" "refunding a sleeve and the margin card"
S36_REFUND_REF="$(s36_field "refund.ref")"

# --- 36c. The dashboard, hand-worked -------------------------------------
# Sale 1: gross 756.00 (before the 4.00 line discount), discounts 79.20,
# net 676.80. VAT 3.00 + 0.90 at the till and the margin box's 230.00
# margin at 1/6, 38.33: 42.23. Cost 400.00 + 10.00 + 2 x 5.00 + 1.00 =
# 421.00. Sale 2: gross 74.00, refunds 62.00 (12.00 + 50.00), net 12.00;
# VAT on the one sleeve kept 2.00 (the card went back, so its margin VAT
# with it); cost 6.00. Both: gross 830.00, discounts 79.20, refunds 62.00,
# net 688.80, VAT 44.23, cost 427.00, profit 688.80 - 44.23 - 427.00 =
# 217.57, two sales.
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_FROM&to=$S36_TO&compare=previous")"
s36_expect "$S36_STATUS" 200 "" "the dashboard after this section's sales"
s36_keep dash1
S36_DELTA="$(s36_js "[
  b.sales.gross - a.sales.gross, b.sales.discounts - a.sales.discounts, b.sales.refunds - a.sales.refunds,
  b.sales.net - a.sales.net, b.sales.vat - a.sales.vat, b.cost - a.cost, b.profit - a.profit,
  b.sales.count - a.sales.count
].join(',')" dash0 dash1)"
[ "$S36_DELTA" = "83000,7920,6200,68880,4423,42700,21757,2" ] \
  || fail "the dashboard moved by gross,discounts,refunds,net,vat,cost,profit,count $S36_DELTA, expected 83000,7920,6200,68880,4423,42700,21757,2"
[ "$(s36_js "b.sales.net === b.sales.gross - b.sales.discounts - b.sales.refunds && b.profit === b.sales.net - b.sales.vat - b.cost" "" dash1)" = "true" ] \
  || fail "the dashboard's net or profit does not follow from its own parts"
[ "$(s36_js "b.sales.average === (b.sales.count ? Math.sign(b.sales.net) * Math.floor(Math.abs(b.sales.net / b.sales.count) + 0.5) : 0)" "" dash1)" = "true" ] \
  || fail "the average sale is not net over count, half-up"
# The branch holds this section's sales alone: net 688.80, cost 427.00,
# profit 217.57, 217.57 / (688.80 - 44.23) = 33.8 percent.
S36_ROW="$(s36_js "(() => { const r = b.by_category.find((c) => c.id === '$S36_BRANCH'); return r ? [r.label, r.net, r.cost, r.profit, r.margin_pct].join(',') : 'missing' })()" "" dash1)"
[ "$S36_ROW" = "S36 Reduced branch,68880,42700,21757,33.8" ] || fail "the branch row reads $S36_ROW"
# The margin box: net 630.00, profit 630.00 - 38.33 - 400.00 = 191.67, one unit.
S36_TOP="$(s36_js "(() => { const r = b.top_items.find((i) => i.title === 'S36 Margin box'); return r ? [r.net, r.profit, r.count, r.sku !== ''].join(',') : 'missing' })()" "" dash1)"
[ "$S36_TOP" = "63000,19167,1,true" ] || fail "the margin box's top item row reads $S36_TOP"
[ "$(s36_js "b.top_items.length <= 10 && b.top_items.every((r, i, all) => i === 0 || all[i - 1].net >= r.net)" "" dash1)" = "true" ] \
  || fail "the top items are not at most ten, largest first"
S36_PAID="$(s36_js "(() => { const n = (d, m) => (d.payments.find((p) => p.method === m) || { net: 0 }).net; return [n(b, 'card_tide') - n(a, 'card_tide'), n(b, 'cash') - n(a, 'cash')].join(',') })()" dash0 dash1)"
[ "$S36_PAID" = "67680,1200" ] || fail "the payment mix moved by card,cash $S36_PAID, expected 67680,1200"
[ "$(s36_js "(() => { const d = b.series.find((s) => s.date === '$(node -e "process.stdout.write(new Date().toISOString().slice(0,10))")'); const c = a.series.find((s) => s.date === d.date); return [d.net - c.net, d.cost - c.cost, d.profit - c.profit].join(',') })()" dash0 dash1)" = "68880,42700,21757" ] \
  || fail "today's point on the series did not move by this section's net, cost and profit"
[ "$(s36_js "b.series.length === 3 && b.compare && b.compare.from < b.from && typeof b.compare.sales.net === 'number' && typeof b.compare.buy_ins.spend === 'number'" "" dash1)" = "true" ] \
  || fail "the series or the previous period is missing: $(s36_js "b.compare" "" dash1)"
ok "the dashboard's sales, discounts, refunds, VAT, cost and profit move by the hand-worked figures, with the branch row, the top item, the payment mix and the day's point"

# The dashboard agrees with the margin, stock and buy-ins reports to the penny.
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/margin?from=$S36_FROM&to=$S36_TO")"
s36_keep margin
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/stock?from=$S36_FROM&to=$S36_TO")"
s36_keep stock
[ "$(s36_js "[a.totals.revenue === b.sales.net, a.totals.cost === b.cost].join()" margin dash1)" = "true,true" ] \
  || fail "the dashboard's net and cost are not the margin report's revenue and cost: $(s36_js "[a.totals.revenue, b.sales.net, a.totals.cost, b.cost].join()" margin dash1)"
[ "$(s36_js "a.totals.value_cost === b.stock.cost" stock dash1)" = "true" ] \
  || fail "the dashboard's stock at cost is not the stock report's value at cost"
# Buy-ins are read live, as the buy-ins report's own trade-in query reads
# them: cash, credit and part-exchange on every trade-in completed in range.
S36_BOUGHT="$(s36_list trade_ins "status='completed' && completed_at >= '$S36_FROM 00:00:00.000Z' && completed_at <= '$S36_TO 23:59:59.999Z'" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  let spend = 0;
  for (const t of d.items) spend += (t.payout_cash || 0) + (t.payout_credit || 0) + (t.part_exchange_value || 0);
  process.stdout.write([spend, d.totalItems].join(","));
')"
[ "$(s36_js "[b.buy_ins.spend, b.buy_ins.count].join(',')" "" dash1)" = "$S36_BOUGHT" ] \
  || fail "the dashboard's buy-ins read $(s36_js "[b.buy_ins.spend, b.buy_ins.count].join(',')" "" dash1), the completed trade-ins come to $S36_BOUGHT"
S36_HELD="$(s36_list items "status='in_stock' || status='reserved' || status='listed_ebay'" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (d.totalItems > d.items.length) { process.stdout.write("too many"); process.exit(0); }
  let cost = 0, retail = 0, units = 0;
  for (const i of d.items) { const q = Math.max(0, i.qty || 0); cost += (i.cost || 0) * q; retail += (i.price || 0) * q; units += q; }
  process.stdout.write([cost, retail, units].join(","));
')"
[ "$(s36_js "[b.stock.cost, b.stock.retail, b.stock.items].join(',')" "" dash1)" = "$S36_HELD" ] \
  || fail "the stock value reads $(s36_js "[b.stock.cost, b.stock.retail, b.stock.items].join(',')" "" dash1), held stock comes to $S36_HELD"
# The margin report's VAT estimate is the margin scheme's VAT, line by line:
# it moved by the margin box's 38.33 (the margin card went back).
[ "$(s36_js "a.totals.vat_estimate >= 3833" margin)" = "true" ] || fail "the margin report's VAT estimate missed the margin box"
ok "the dashboard agrees with the margin report's revenue and cost and the stock report's value at cost, its buy-ins are the completed trade-ins and its stock is the held stock"

# --- 36d. The VAT return, hand-worked ------------------------------------
# This section's rows: the seven lines of the two sales as sold, and the
# refund's two. Standard 20%: 18.00 + 24.00 - 12.00 = 30.00 gross, VAT
# 3.00 + 4.00 - 2.00 = 5.00. Reduced 5%: 18.90, VAT 0.90. Zero: 2.70.
# Exempt: 7.20. Margin: 630.00 + 50.00 - 50.00 = 630.00, cost 400.00,
# margin 230.00, VAT 38.33 + 8.33 - 8.33 = 38.33. Box 1 moves by 44.23,
# the same as the dashboard's VAT; sales excluding VAT by 688.80 - 44.23 =
# 644.57.
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PERIOD")"
s36_expect "$S36_STATUS" 200 "" "the return after this section's sales"
s36_keep vat1
S36_MINE="$(s36_js "(() => {
  const mine = b.rows.filter((r) => r.sale === '$S36_S1' || r.sale === '$S36_S2');
  const by = {};
  for (const r of mine) {
    const g = (by[r.group] = by[r.group] || { gross: 0, vat: 0, net: 0, cost: 0 });
    g.gross += r.gross; g.vat += r.vat; g.net += r.net; g.cost += r.cost;
  }
  return [
    mine.length, mine.filter((r) => r.kind === 'refund').length,
    Object.keys(by).sort().map((k) => k + '=' + by[k].gross + '/' + by[k].vat + '/' + by[k].net + '/' + by[k].cost).join(' '),
  ].join('|')
})()" "" vat1)"
[ "$S36_MINE" = "9|2|exempt=720/0/720/0 margin=63000/3833/59167/40000 reduced:5=1890/90/1800/0 standard:20=3000/500/2500/0 zero=270/0/270/0" ] \
  || fail "this section's return rows read $S36_MINE"
S36_REFUND_ROWS="$(s36_js "b.rows.filter((r) => r.kind === 'refund' && r.sale === '$S36_S2').map((r) => [r.ref, r.treatment, r.gross, r.vat, r.cost].join(':')).sort().join(',')" "" vat1)"
[ "$S36_REFUND_ROWS" = "$S36_REFUND_REF:margin:-5000:-83:-4500,$S36_REFUND_REF:standard:-1200:-200:0" ] \
  || fail "the refund's rows read $S36_REFUND_ROWS"
[ "$(s36_js "[b.boxes.box1 - a.boxes.box1, b.sales_ex_vat - a.sales_ex_vat].join(',')" vat0 vat1)" = "4423,64457" ] \
  || fail "box 1 and sales excluding VAT moved by $(s36_js "[b.boxes.box1 - a.boxes.box1, b.sales_ex_vat - a.sales_ex_vat].join(',')" vat0 vat1), expected 4423,64457"
[ "$(s36_js "[b.margin.sales - a.margin.sales, b.margin.cost - a.margin.cost, b.margin.margin - a.margin.margin, b.margin.vat - a.margin.vat].join(',')" vat0 vat1)" = "63000,40000,23000,3833" ] \
  || fail "the margin scheme working moved by $(s36_js "[b.margin.sales - a.margin.sales, b.margin.cost - a.margin.cost, b.margin.margin - a.margin.margin, b.margin.vat - a.margin.vat].join(',')" vat0 vat1)"
[ "$(s36_js "b.boxes.box3 === b.boxes.box1 + b.boxes.box2 && b.boxes.box6 === Math.trunc(b.sales_ex_vat / 100) * 100 && b.boxes.box2 === 0 && b.boxes.box8 === 0 && b.boxes.box9 === 0 && b.registered === true && b.by_rate.reduce((s, r) => s + r.vat, 0) === b.boxes.box1" "" vat1)" = "true" ] \
  || fail "the boxes do not follow from each other: $(s36_js "b.boxes" "" vat1)"
S36_NOTE="$(node -e "
  const q = require('$S36_SHARED/vatreturn.js');
  process.stdout.write(q.vatScopeNote(q.vatQuarter('$S36_PERIOD', 1), { registered: true, from: '$S36_TODAY' }));
")"
[ "$(s36_field note)" = "$S36_NOTE" ] || fail "the return's note reads '$(s36_field note)', expected '$S36_NOTE'"
[ "$(s36_js "b.rows.filter((r) => r.sale === '$S36_S1' && r.kind === 'sale').every((r) => r.ref === '$S36_S1_NUMBER' && r.date === '$S36_TODAY')" "" vat1)" = "true" ] \
  || fail "sale 1's rows do not carry its number and today's date"
ok "the VAT return's rows, by-rate figures, margin scheme working and box 1 move by the hand-worked figures, the refund counting in the quarter it was given"

# Boxes 4 and 7: entered by hand, admin only, kept per quarter and audited.
S36_STATUS="$(s36_call "$S36_CLERK_TOKEN" POST "/api/vault/reports/vat/purchases" "{\"period\":\"$S36_PERIOD\",\"vat\":12345,\"net\":98765}")"
s36_expect "$S36_STATUS" 403 "A manager needs to approve this." "purchase figures from a plain staff member"
[ "$(s36_field capability)" = "settings_manage" ] || fail "the purchases refusal names '$(s36_field capability)'"
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/reports/vat/purchases" "{\"period\":\"2026-Q5\",\"vat\":1,\"net\":1}")"
s36_expect "$S36_STATUS" 400 "Pick a quarter, as 2026-Q4." "purchase figures for a quarter that is not one"
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/reports/vat/purchases" "{\"period\":\"$S36_PERIOD\",\"vat\":-1,\"net\":1}")"
s36_expect "$S36_STATUS" 400 "Enter the purchase figures in pence, as whole numbers of 0 or more." "negative purchase figures"
S36_STATUS="$(s36_call "$STAFF_TOKEN" POST "/api/vault/reports/vat/purchases" "{\"period\":\"$S36_PERIOD\",\"vat\":12345,\"net\":98765}")"
s36_expect "$S36_STATUS" 200 "" "the purchase figures"
S36_ADMIN_NAME="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/me" | jval name)"
[ "$(s36_js "[b.boxes.box4, b.boxes.box7, b.purchases.vat, b.purchases.net, b.purchases.by, b.boxes.box5 === Math.abs(b.boxes.box3 - b.boxes.box4), b.box5_reclaim === (b.boxes.box4 > b.boxes.box3)].join(',')" "" last)" = "12345,98700,12345,98765,$S36_ADMIN_NAME,true,true" ] \
  || fail "boxes 4, 5 and 7 read $(s36_js "[b.boxes.box4, b.boxes.box5, b.boxes.box7, b.purchases.by].join(',')" "" last)"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PERIOD")"
[ "$(s36_field boxes.box4)" = "12345" ] || fail "box 4 did not keep for the quarter"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PREVIOUS")"
[ "$(s36_field boxes.box4)" = "0" ] || fail "another quarter took this quarter's box 4"
[ "$(s36_list audit_log "action='vat_purchases'" | jval "items.0.meta.vat")" = "12345" ] || fail "the purchase figures were not audited"
ok "boxes 4 and 7 are entered by an admin per quarter, box 7 in whole pounds, box 5 the difference either way, audited, and refused for staff, a bad quarter and a negative figure"

# --- 36e. A quarter before registration, and VAT off ---------------------
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PREVIOUS")"
s36_expect "$S36_STATUS" 200 "" "the quarter before registration"
S36_NOTE="$(node -e "
  const q = require('$S36_SHARED/vatreturn.js');
  process.stdout.write('The shop is VAT registered from ' + q.longDate('$S36_TODAY') + ', after this quarter, so every box is 0.');
")"
[ "$(s36_js "[Object.values(b.boxes).every((v) => v === 0), b.registered, b.rows.length, b.note].join('|')" "" last)" = "true|false|0|$S36_NOTE" ] \
  || fail "the quarter before registration reads $(s36_js "[JSON.stringify(b.boxes), b.registered, b.note].join('|')" "" last)"
s36_settings '{"vat_registered":false}'
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=$S36_PERIOD")"
[ "$(s36_js "[Object.values(b.boxes).every((v) => v === 0), b.note].join('|')" "" last)" = "true|The shop is not VAT registered, so every box is 0." ] \
  || fail "the return with VAT off reads $(s36_body)"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat")"
s36_expect "$S36_STATUS" 200 "" "the return with no period"
[ "$(s36_field period)" = "$S36_PERIOD" ] || fail "the return with no period is for $(s36_field period), not this quarter"
ok "a quarter before registration and a return with VAT off answer every box 0 with a note, and no period means this quarter"

# --- 36f. Refusals ---------------------------------------------------------
S36_STATUS="$(s36_call "$S36_CLERK_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_FROM&to=$S36_TO")"
s36_expect "$S36_STATUS" 403 "A manager needs to approve this." "the dashboard for a plain staff member"
[ "$(s36_field capability)" = "reports_view" ] || fail "the dashboard refusal names '$(s36_field capability)'"
S36_STATUS="$(s36_call "$S36_CLERK_TOKEN" GET "/api/vault/reports/vat?period=$S36_PERIOD")"
s36_expect "$S36_STATUS" 403 "A manager needs to approve this." "the return for a plain staff member"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_FROM")"
s36_expect "$S36_STATUS" 400 "Pick a date range. Both from and to are needed, as YYYY-MM-DD." "the dashboard with no to date"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=$S36_TO&to=$S36_FROM")"
s36_expect "$S36_STATUS" 400 "The from date is after the to date. Swap them over." "the dashboard with its dates swapped"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/dashboard?from=2024-01-01&to=2026-01-01")"
s36_expect "$S36_STATUS" 400 "Pick a range of up to 400 days." "the dashboard over two years"
S36_STATUS="$(s36_call "$STAFF_TOKEN" GET "/api/vault/reports/vat?period=2026-13")"
s36_expect "$S36_STATUS" 400 "Pick a quarter, as 2026-Q4." "the return for a period that is not a quarter"
S36_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault/reports/dashboard?from=$S36_FROM&to=$S36_TO")"
[ "$S36_STATUS" = "401" ] || fail "the dashboard without a token returned $S36_STATUS"
ok "the dashboard and the return need reports_view and a signed-in member of staff, and refuse a bad range or quarter in words"

# --- cleanup ---------------------------------------------------------------
s36_settings '{"vat_registered":false,"vat_registered_from":"","vat_standard_rate":20,"vat_period_start_month":1}'
for S36_ID in "$S36_A" "$S36_B" "$S36_C" "$S36_D" "$S36_F" "$S36_G"; do
  curl -s -o /dev/null -X PATCH "$BASE/api/collections/items/records/$S36_ID" \
    -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"category":""}'
done
curl -s -o /dev/null -X PATCH "$BASE/api/collections/till_products/records/$S36_E" \
  -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" -d '{"category":"","active":false}'
S36_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/collections/categories/records/$S36_BRANCH" -H "Authorization: $STAFF_TOKEN")"
[ "$S36_STATUS" = "204" ] || fail "could not delete the check branch: $S36_STATUS"
if [ -z "$S36_TILL_WAS_OPEN" ]; then
  S36_SID="$(s36_session)"
  S36_EXPECTED="$(curl -s -H "Authorization: $STAFF_TOKEN" "$BASE/api/vault/cash-sessions/current" | jval expected)"
  curl -s -o /dev/null -X POST "$BASE/api/vault/cash-sessions/$S36_SID/close" \
    -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d "{\"counted\":$S36_EXPECTED}"
fi
ok "section 36 leaves VAT off, the check branch gone and the till as it found it"
