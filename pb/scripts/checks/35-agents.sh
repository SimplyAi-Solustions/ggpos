# shellcheck shell=bash
# -----------------------------------------------------------------------
# 35. Agents, GG Vault's MCP endpoint and research requests (launch package
#     AG, docs/api-contract-launch.md, section 5): pb_hooks/agents.pb.js,
#     mcp.pb.js, research.pb.js and their lib/ modules.
#
#     Creating an agent and using its token on a staff route and on MCP;
#     initialize, tools/list and a tool call per area (stock, price check, a
#     UK sold comp, a research request claimed and completed with its comps
#     landing as UK sold comps, customers, a report, bookings availability
#     where the route is there yet, vault_api); a refusal coming back as a
#     tool error carrying GG Vault's own sentence; re-keying and switching off
#     killing the old token at once; an agent refused on the roster, a PIN, a
#     password sign-in, a manager approval and the step-up an ID photo needs;
#     the research webhook called and signed (against a tiny listener this
#     section starts); and audit rows naming the agent.
#
# Sourced by pb/scripts/check.sh into its own shell, after every earlier
# section: it shares $BASE, $SUPER_TOKEN, $TMP_DIR and the ok/fail/jval
# helpers. It makes its own staff, device, card and item (everything it
# defines starts with AG_ or ag_), and stops the listener before it returns.
# -----------------------------------------------------------------------

AG_DIR="$TMP_DIR/ag"
mkdir -p "$AG_DIR"
AG_TODAY="$(date -u +%Y-%m-%d)"
AG_PASSWORD="ag-check-password-0001"
AG_SECRET="ag-check-webhook-secret-0123456789"
AG_LISTENER_PID=""

AG_STEP_UP_REFUSAL="Confirm your password to continue."
AG_SAY_PASSWORD="Agents sign in with their token, not a password."
AG_SAY_PIN="Agents do not have a PIN. They use their token."
AG_SAY_UNLOCK="Agents cannot unlock a till. They use their own token."
AG_SAY_APPROVE="An agent cannot approve that. Ask somebody with a PIN to approve it."
AG_SAY_STEP_UP="An agent cannot confirm a password. A member of staff has to do this one."
AG_SAY_ID_PHOTO="Agents cannot open ID photos. A member of staff can, after confirming their password."
AG_SAY_STAFF_ROUTE="Manage agents in Settings, Agents."
AG_SAY_OFF="Switch the agent on before giving it a new token."
AG_SAY_NOT_EBAY="That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...)."

# --- helpers -------------------------------------------------------------

# $1 method, $2 path, $3 auth ("" for none), $4 JSON body ("" for none),
# then any extra headers. Sets AG_STATUS; the body is in $AG_DIR/last.json.
ag_call() {
  local method="$1" path="$2" auth="$3" body="$4"
  shift 4
  local args=(-s -o "$AG_DIR/last.json" -w '%{http_code}' --max-time 30 -X "$method" "$BASE$path")
  if [ -n "$auth" ]; then args+=(-H "Authorization: $auth"); fi
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  local header
  for header in "$@"; do args+=(-H "$header"); done
  AG_STATUS="$(curl "${args[@]}")"
}

ag_body() { cat "$AG_DIR/last.json"; }
ag_get() { jval "$1" <"$AG_DIR/last.json"; }

# $1 expected status, $2 expected message ("" to skip), $3 what was tried.
ag_expect() {
  [ "$AG_STATUS" = "$1" ] || fail "$3 returned $AG_STATUS, expected $1: $(ag_body)"
  if [ -n "$2" ]; then
    [ "$(ag_get message)" = "$2" ] || fail "$3 said '$(ag_get message)', expected '$2'"
  fi
}

# $1 a JS expression over the last body parsed as `r` -> its value.
ag_js() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "null");
    const v = (0, eval)("(r) => (" + process.argv[2] + ")")(r);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$AG_DIR/last.json" "$1"
}

# $1 token, $2 a JSON-RPC message -> sets AG_STATUS and the body, as an MCP client would post it.
ag_mcp() {
  ag_call POST /api/vault/mcp "Bearer $1" "$2" "Accept: application/json, text/event-stream"
}

# $1 token, $2 tool, $3 arguments JSON -> a tools/call; the tool's text is in $AG_DIR/tool.txt.
ag_tool() {
  ag_mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":\"ag-$2\",\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"
  [ "$AG_STATUS" = "200" ] || fail "the $2 tool call returned $AG_STATUS: $(ag_body)"
  ag_js 'r.result.content[0].text' >"$AG_DIR/tool.txt"
  AG_TOOL_ERROR="$(ag_js 'r.result.isError')"
}
ag_tool_text() { cat "$AG_DIR/tool.txt"; }
# $1 a JS expression over the tool's JSON answer parsed as `t`.
ag_tool_js() {
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = (0, eval)("(t) => (" + process.argv[2] + ")")(t);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$AG_DIR/tool.txt" "$1"
}

ag_make_staff() {
  # $1 name, $2 email, $3 role -> id
  curl -s -X POST "$BASE/api/collections/staff/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"$AG_PASSWORD\",\"passwordConfirm\":\"$AG_PASSWORD\",\"role\":\"$3\",\"active\":true}" | jval id
}
ag_sign_in() {
  curl -s -X POST "$BASE/api/collections/staff/auth-with-password" -H "Content-Type: application/json" \
    -d "{\"identity\":\"$1\",\"password\":\"$AG_PASSWORD\"}" | jval token
}
ag_step_up() {
  curl -s -X POST "$BASE/api/vault/step-up" -H "Authorization: $1" -H "Content-Type: application/json" \
    -d "{\"password\":\"$AG_PASSWORD\"}" | jval token
}
ag_record() {
  # $1 collection, $2 id, $3 field, read as the superuser
  curl -s "$BASE/api/collections/$1/records/$2" -H "Authorization: $SUPER_TOKEN" | jval "$3"
}
ag_audit() {
  # $1 filter -> the matching audit rows, newest first
  curl -s -G "$BASE/api/collections/audit_log/records" -H "Authorization: $SUPER_TOKEN" \
    --data-urlencode "filter=$1" --data-urlencode "sort=-created,-id" --data-urlencode "perPage=200"
}
ag_audit_count() { ag_audit "$1" | jval totalItems; }

ag_stop_listener() {
  if [ -n "$AG_LISTENER_PID" ] && kill -0 "$AG_LISTENER_PID" 2>/dev/null; then
    kill "$AG_LISTENER_PID" 2>/dev/null || true
    wait "$AG_LISTENER_PID" 2>/dev/null || true
  fi
  AG_LISTENER_PID=""
}

# --- 35a. Who is who ---------------------------------------------------------

AG_ADMIN="$(ag_make_staff "AG Admin" "ag-admin@local.test" admin)"
AG_SAM="$(ag_make_staff "AG Sam" "ag-sam@local.test" staff)"
AG_MO="$(ag_make_staff "AG Mo" "ag-mo@local.test" manager)"
[ -n "$AG_ADMIN" ] && [ -n "$AG_SAM" ] && [ -n "$AG_MO" ] || fail "could not create the section's staff"
AG_ADMIN_TOKEN="$(ag_sign_in ag-admin@local.test)"
AG_SAM_TOKEN="$(ag_sign_in ag-sam@local.test)"
AG_MO_TOKEN="$(ag_sign_in ag-mo@local.test)"
AG_ADMIN_STEP="$(ag_step_up "$AG_ADMIN_TOKEN")"
AG_MO_STEP="$(ag_step_up "$AG_MO_TOKEN")"
[ -n "$AG_ADMIN_TOKEN" ] && [ -n "$AG_SAM_TOKEN" ] && [ -n "$AG_ADMIN_STEP" ] && [ -n "$AG_MO_STEP" ] \
  || fail "could not sign the section's staff in"
[ "$(ag_record staff "$AG_SAM" kind)" = "person" ] || fail "a member of staff made through the collection API is not a person"

# A till of this section's own, for the roster, a PIN unlock and an approval.
ag_call POST /api/vault/till/devices "$AG_ADMIN_TOKEN" '{"label":"AG Counter"}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 201 "" "registering the section's till"
AG_DEVICE="$(ag_get device.id).$(ag_get secret)"
ag_call POST /api/vault/staff/me/pin "$AG_MO_TOKEN" '{"pin":"482613"}' "X-Step-Up: $AG_MO_STEP"
ag_expect 204 "" "the manager setting a PIN"
ok "the section's admin, staff, manager and till are ready"

# --- 35b. Creating an agent ----------------------------------------------------

ag_call GET /api/vault/agents "$AG_SAM_TOKEN" ""
[ "$AG_STATUS" = "403" ] || fail "a plain member of staff listed the agents ($AG_STATUS): $(ag_body)"
ag_call POST /api/vault/agents "$AG_SAM_TOKEN" '{"name":"Nope"}'
[ "$AG_STATUS" = "403" ] || fail "a plain member of staff created an agent ($AG_STATUS): $(ag_body)"
ag_call POST /api/vault/agents "$AG_ADMIN_TOKEN" '{"name":"Gandalf"}'
ag_expect 403 "$AG_STEP_UP_REFUSAL" "creating an agent without a step-up"
ag_call POST /api/vault/agents "$AG_ADMIN_TOKEN" '{"name":"   "}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 400 "Give the agent a name of 60 characters or fewer." "creating an agent with no name"
ag_call POST /api/vault/agents "$AG_ADMIN_TOKEN" '{"name":"Gandalf","note":"Hermes on the Mac Mini, through buzz-acp"}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 201 "" "creating an agent"
AG_AGENT="$(ag_get agent.id)"
AG_TOKEN="$(ag_get token)"
[ -n "$AG_AGENT" ] && [ -n "$AG_TOKEN" ] || fail "creating an agent answered no id or no token: $(ag_body)"
[ "$(ag_get agent.name)" = "Gandalf" ] && [ "$(ag_get agent.role)" = "admin" ] && [ "$(ag_get agent.active)" = "true" ] \
  || fail "the new agent is not an active admin called Gandalf: $(ag_body)"
[ "$(ag_get agent.note)" = "Hermes on the Mac Mini, through buzz-acp" ] || fail "the note was lost: $(ag_body)"
AG_EXPIRES="$(ag_get expires_at)"
node -e '
  const days = (new Date(process.argv[1]) - Date.now()) / 864e5;
  if (!(days > 364 && days < 366)) { console.error("expires in " + days + " days"); process.exit(1); }
' "$AG_EXPIRES" || fail "the agent's token does not last a year: $AG_EXPIRES"
node -e '
  const claims = JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url").toString());
  const days = (claims.exp * 1000 - Date.now()) / 864e5;
  if (claims.id !== process.argv[2] || claims.type !== "auth" || !(days > 364 && days < 366)) process.exit(1);
' "$AG_TOKEN" "$AG_AGENT" || fail "the token is not a year-long auth token for the agent"
for AG_NEEDLE in '"tokenKey"' '"password"' '"pin_hash"'; do
  grep -qF -- "$AG_NEEDLE" "$AG_DIR/last.json" && fail "creating an agent answered $AG_NEEDLE"
done
[ "$(ag_record staff "$AG_AGENT" kind)" = "agent" ] && [ "$(ag_record staff "$AG_AGENT" role)" = "admin" ] \
  || fail "the agent's row is not kind agent with the admin role"
[ -z "$(ag_record staff "$AG_AGENT" pin_hash)" ] || fail "a new agent has a PIN"
[ "$(ag_record staff "$AG_AGENT" must_change_password)" = "false" ] || fail "a new agent is held to a password change"
[ "$(ag_audit_count "action = 'agent_created' && record = '$AG_AGENT' && actor = '$AG_ADMIN'")" = "1" ] \
  || fail "creating the agent wrote no agent_created row by the admin"
[ "$(ag_audit_count "action = 'agent_token_issued' && record = '$AG_AGENT'")" = "1" ] \
  || fail "creating the agent wrote no agent_token_issued row"
ag_audit "record = '$AG_AGENT'" | grep -qF -- "$AG_TOKEN" && fail "the agent's token reached audit_log"
ag_call POST /api/vault/agents "$AG_ADMIN_TOKEN" '{"name":"gandalf"}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 409 "There is already an agent called gandalf. Give this one another name." "a second agent with the same name"
ag_call GET /api/vault/agents "$AG_ADMIN_TOKEN" ""
ag_expect 200 "" "listing the agents"
[ "$(ag_js "r.agents.filter((a) => a.id === '$AG_AGENT').length")" = "1" ] || fail "the agent is not in the list: $(ag_body)"
grep -qF -- "$AG_TOKEN" "$AG_DIR/last.json" && fail "the agent list answered the token again"
ok "an admin creates an agent with a step-up and gets a year-long token once, audited without it"

# --- 35c. The token on a staff route ------------------------------------------

ag_call GET /api/vault/me "Bearer $AG_TOKEN" ""
ag_expect 200 "" "the agent reading /me"
[ "$(ag_get id)" = "$AG_AGENT" ] && [ "$(ag_get role)" = "admin" ] || fail "/me is not the agent as an admin: $(ag_body)"
ag_call GET "/api/collections/items/records?perPage=1" "Bearer $AG_TOKEN" ""
ag_expect 200 "" "the agent listing stock through the collection API"
ag_call GET /api/vault/staff "$AG_TOKEN" ""
ag_expect 200 "" "the agent reading the staff list as an admin"
[ "$(ag_js "r.staff.filter((s) => s.id === '$AG_AGENT').length")" = "0" ] || fail "the staff list shows the agent: $(ag_body)"
ok "the agent's token works on staff routes, with the admin role, and the staff list leaves agents out"

# --- 35d. The MCP endpoint ---------------------------------------------------------

ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
ag_expect 200 "" "initialize"
[ "$(ag_get result.protocolVersion)" = "2025-06-18" ] || fail "initialize did not answer the client's protocol version: $(ag_body)"
[ "$(ag_get result.serverInfo.name)" = "ggvault" ] && [ -n "$(ag_get result.capabilities.tools)" ] \
  || fail "initialize did not name the server or offer tools: $(ag_body)"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}'
[ "$(ag_get result.protocolVersion)" = "2025-11-25" ] || fail "an unknown protocol version was not answered with the newest: $(ag_body)"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","method":"notifications/initialized"}'
ag_expect 202 "" "notifications/initialized"
[ -z "$(ag_body)" ] || fail "a notification got a body back: $(ag_body)"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":3,"method":"ping"}'
ag_expect 200 "" "ping"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":4,"method":"tools/list"}'
ag_expect 200 "" "tools/list"
for AG_NAME in stock_search stock_get stock_update category_tree card_search card_prices retro_search retro_prices \
  uk_comp_add research_list research_claim research_complete customer_search customer_get guild_join dashboard report \
  till_x bookings_availability bookings_list booking_create booking_move booking_cancel events_list event_create \
  tradeins_list tradein_get quotes_list quote_get quote_offer vault_api; do
  [ "$(ag_js "r.result.tools.filter((t) => t.name === '$AG_NAME' && t.description && t.inputSchema && t.inputSchema.type === 'object').length")" = "1" ] \
    || fail "tools/list has no described $AG_NAME with a JSON Schema"
done
ag_mcp "$AG_TOKEN" '[{"jsonrpc":"2.0","id":5,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":6,"method":"tools/list"}]'
ag_expect 200 "" "a batch"
[ "$(ag_js 'r.length')" = "2" ] && [ "$(ag_js 'r[0].id')" = "5" ] && [ "$(ag_js 'r[1].id')" = "6" ] \
  || fail "a batch did not answer its two requests and skip the notification: $(ag_body)"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":7,"method":"resources/list"}'
[ "$(ag_get error.code)" = "-32601" ] || fail "an unknown method was not -32601: $(ag_body)"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"fly","arguments":{}}}'
[ "$(ag_get error.code)" = "-32602" ] || fail "an unknown tool was not -32602: $(ag_body)"
ag_mcp "$AG_TOKEN" 'this is not json'
ag_expect 400 "" "a body that is not JSON"
[ "$(ag_get error.code)" = "-32700" ] || fail "a parse error was not -32700: $(ag_body)"
ag_call GET /api/vault/mcp "Bearer $AG_TOKEN" ""
ag_expect 405 "" "a GET on the MCP endpoint"
ag_call POST /api/vault/mcp "" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
ag_expect 401 "" "MCP with no token"
ag_call POST /api/vault/mcp "Bearer not-a-token" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
ag_expect 401 "" "MCP with a made-up token"
# A person's staff token works too.
ag_mcp "$AG_SAM_TOKEN" '{"jsonrpc":"2.0","id":9,"method":"ping"}'
ag_expect 200 "" "MCP with a person's staff token"
ok "MCP answers initialize, ping, tools/list and batches over JSON-RPC, 202 for notifications, and refuses no token"

# --- 35e. A tool call per area -------------------------------------------------------

AG_GAME="$(curl -s -G "$BASE/api/collections/games/records" --data-urlencode "filter=key = 'pokemon'" | jval items.0.id)"
AG_SET="$(curl -s -X POST "$BASE/api/collections/card_sets/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$AG_GAME\",\"code\":\"ag151\",\"name\":\"AG One Five One\"}" | jval id)"
AG_CARD="$(curl -s -X POST "$BASE/api/collections/cards/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"game\":\"$AG_GAME\",\"set\":\"$AG_SET\",\"number\":\"199\",\"name\":\"AG Charizard ex\",\"source\":\"manual\",\"finishes_available\":[\"holo\"]}" | jval id)"
AG_ITEM_JSON="$(curl -s -X POST "$BASE/api/collections/items/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"kind\":\"single\",\"game\":\"$AG_GAME\",\"card\":\"$AG_CARD\",\"title\":\"AG Charizard ex\",\"finish\":\"holo\",\"condition\":\"NM\",\"qty\":1,\"price\":5999,\"cost\":3000,\"status\":\"in_stock\"}")"
AG_ITEM="$(jval id <<<"$AG_ITEM_JSON")"
AG_SKU="$(jval sku <<<"$AG_ITEM_JSON")"
[ -n "$AG_CARD" ] && [ -n "$AG_ITEM" ] && [ -n "$AG_SKU" ] || fail "could not create the section's card and item: $AG_ITEM_JSON"

ag_tool "$AG_TOKEN" stock_search '{"query":"AG Charizard"}'
[ "$AG_TOOL_ERROR" = "false" ] || fail "stock_search failed: $(ag_tool_text)"
[ "$(ag_tool_js "t.items.filter((i) => i.sku === '$AG_SKU' && i.price === 5999 && i.price_gbp === '£59.99').length")" = "1" ] \
  || fail "stock_search did not find the item with its price in pence and pounds: $(ag_tool_text)"
ag_tool "$AG_TOKEN" stock_update "{\"sku\":\"$AG_SKU\",\"price_pence\":6499}"
[ "$AG_TOOL_ERROR" = "false" ] && [ "$(ag_tool_js 't.price')" = "6499" ] || fail "stock_update did not reprice the item: $(ag_tool_text)"
[ "$(ag_record items "$AG_ITEM" price)" = "6499" ] || fail "stock_update did not reach the item"
ag_tool "$AG_TOKEN" stock_get "{\"id\":\"$AG_ITEM\"}"
[ "$(ag_tool_js 't.card_detail.set')" = "AG One Five One" ] || fail "stock_get did not carry the card's set: $(ag_tool_text)"
grep -q 'image' "$AG_DIR/tool.txt" && fail "stock_get answered an image field: $(ag_tool_text)"

ag_tool "$AG_TOKEN" card_prices "{\"card\":\"$AG_CARD\",\"finish\":\"holo\"}"
[ "$AG_TOOL_ERROR" = "false" ] || fail "card_prices failed: $(ag_tool_text)"
# Sold five days ago, so the research comps below are newer than it.
AG_FIVE_DAYS="$(node -e 'process.stdout.write(new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10))')"
ag_tool "$AG_TOKEN" uk_comp_add "{\"card\":\"$AG_CARD\",\"finish\":\"holo\",\"price_pence\":4400,\"url\":\"https://www.ebay.co.uk/itm/350000000001\",\"sold_at\":\"$AG_FIVE_DAYS\"}"
[ "$AG_TOOL_ERROR" = "false" ] || fail "uk_comp_add failed: $(ag_tool_text)"
[ "$(ag_tool_js 't.chosen.source')" = "uk_sold_manual" ] && [ "$(ag_tool_js 't.chosen.gbp_market_gbp')" = "£44.00" ] \
  || fail "the comp the agent added is not the chosen price: $(ag_tool_text)"
[ "$(ag_audit_count "action = 'uk_comp' && actor = '$AG_AGENT'")" = "1" ] || fail "the agent's comp was not audited under the agent"

# A refusal comes back as a tool error carrying GG Vault's own sentence.
ag_tool "$AG_TOKEN" uk_comp_add "{\"card\":\"$AG_CARD\",\"price_pence\":4400,\"url\":\"https://example.com/listing\",\"sold_at\":\"$AG_TODAY\"}"
[ "$AG_TOOL_ERROR" = "true" ] || fail "a refused comp was not a tool error: $(ag_body)"
[ "$(ag_tool_text)" = "$AG_SAY_NOT_EBAY" ] || fail "the tool error did not carry GG Vault's sentence: $(ag_tool_text)"

AG_CUSTOMER="$(curl -s -X POST "$BASE/api/collections/customers/records" -H "Authorization: $SUPER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"AG Jo Bloggs","email":"ag-jo@local.test"}' | jval id)"
ag_tool "$AG_TOKEN" customer_search '{"query":"AG Jo"}'
[ "$(ag_tool_js "t.customers.filter((c) => c.id === '$AG_CUSTOMER').length")" = "1" ] || fail "customer_search did not find the customer: $(ag_tool_text)"
ag_tool "$AG_TOKEN" customer_get "{\"id\":\"$AG_CUSTOMER\"}"
[ "$(ag_tool_js 't.name')" = "AG Jo Bloggs" ] && [ "$(ag_tool_js 't.credit_balance')" = "0" ] \
  || fail "customer_get did not answer the customer and their balance: $(ag_tool_text)"

ag_tool "$AG_TOKEN" report "{\"key\":\"sales\",\"from\":\"$AG_TODAY\",\"to\":\"$AG_TODAY\"}"
[ "$AG_TOOL_ERROR" = "false" ] || fail "the sales report through MCP failed: $(ag_tool_text)"
ag_tool "$AG_TOKEN" report '{"key":"nosuchreport","from":"2026-01-01","to":"2026-01-02"}'
[ "$AG_TOOL_ERROR" = "true" ] || fail "an unknown report was not a tool error"
ag_tool "$AG_TOKEN" till_x '{}'
[ "$AG_TOOL_ERROR" = "false" ] || fail "till_x failed: $(ag_tool_text)"

# Bookings arrive with package BK; until then the tool answers the server's own 404 as a tool error.
ag_call GET "/api/vault/bookings/availability?date=$AG_TODAY" "$AG_ADMIN_TOKEN" ""
AG_BOOKINGS_ROUTE="$AG_STATUS"
ag_tool "$AG_TOKEN" bookings_availability "{\"date\":\"$AG_TODAY\"}"
if [ "$AG_BOOKINGS_ROUTE" = "200" ]; then
  [ "$AG_TOOL_ERROR" = "false" ] || fail "bookings_availability failed while the route answers: $(ag_tool_text)"
else
  [ "$AG_TOOL_ERROR" = "true" ] || fail "bookings_availability without the route was not a tool error"
fi

ag_tool "$AG_TOKEN" vault_api '{"method":"GET","path":"/api/vault/fx"}'
[ "$AG_TOOL_ERROR" = "false" ] && [ "$(ag_tool_js 't.base')" = "GBP" ] || fail "vault_api GET /api/vault/fx failed: $(ag_tool_text)"
ag_tool "$AG_TOKEN" vault_api '{"method":"GET","path":"/api/vault/mcp"}'
[ "$AG_TOOL_ERROR" = "true" ] || fail "vault_api called the MCP endpoint itself"
ag_tool "$AG_TOKEN" vault_api '{"method":"POST","path":"/api/vault/step-up","body":{"password":"x"}}'
[ "$AG_TOOL_ERROR" = "true" ] && [ "$(ag_tool_text)" = "$AG_SAY_STEP_UP" ] || fail "vault_api let the agent try a step-up: $(ag_tool_text)"

[ "$(ag_audit_count "action = 'mcp_call' && actor = '$AG_AGENT' && meta.tool = 'stock_search' && meta.ok = true")" -ge 1 ] \
  || fail "the stock_search call has no mcp_call row under the agent"
[ "$(ag_audit_count "action = 'mcp_call' && actor = '$AG_AGENT' && meta.tool = 'uk_comp_add' && meta.ok = false && meta.status = 400")" = "1" ] \
  || fail "the refused uk_comp_add has no mcp_call row saying so"
ag_audit "action = 'mcp_call' && actor = '$AG_AGENT'" | grep -qF "AG Jo" && fail "a tool call's arguments reached audit_log"
ok "a tool call per area works through the agent's own token, a refusal is a tool error in GG Vault's words, and each call is audited"

# --- 35f. Research, the webhook and comps landing as UK sold comps ---------------------

AG_LISTEN_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
node -e '
  const http = require("http"), fs = require("fs");
  const [port, out] = process.argv.slice(1);
  let n = 0;
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n += 1;
      fs.writeFileSync(out + "." + n, JSON.stringify({ path: req.url, headers: req.headers, body }));
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{}");
    });
  }).listen(Number(port), "127.0.0.1");
  setTimeout(() => process.exit(0), 120000);
' "$AG_LISTEN_PORT" "$AG_DIR/hook" &
AG_LISTENER_PID=$!
sleep 0.5

ag_call POST /api/vault/agents/webhook "$AG_SAM_TOKEN" '{"url":"http://127.0.0.1:1/x"}'
[ "$AG_STATUS" = "403" ] || fail "a plain member of staff set the webhook ($AG_STATUS)"
ag_call POST /api/vault/agents/webhook "$AG_ADMIN_TOKEN" '{"url":"ftp://example.com/x"}'
ag_expect 400 "Give the webhook an http or https address of 500 characters or fewer." "a webhook that is not http"
ag_call POST /api/vault/agents/webhook "$AG_ADMIN_TOKEN" '{"url":"http://example.com/x","secret":"short"}'
ag_expect 400 "Make the webhook secret 16 to 200 characters, or leave it blank to keep the one set." "a short webhook secret"
ag_call POST /api/vault/agents/webhook "$AG_ADMIN_TOKEN" "{\"url\":\"http://127.0.0.1:$AG_LISTEN_PORT/webhooks/ggvault\",\"secret\":\"$AG_SECRET\"}"
ag_expect 200 "" "setting the webhook"
[ "$(ag_get secret_set)" = "true" ] || fail "the webhook does not say a secret is set: $(ag_body)"
grep -qF -- "$AG_SECRET" "$AG_DIR/last.json" && fail "setting the webhook answered the secret"
ag_call GET /api/vault/agents/webhook "$AG_ADMIN_TOKEN" ""
[ "$(ag_get url)" = "http://127.0.0.1:$AG_LISTEN_PORT/webhooks/ggvault" ] && [ "$(ag_get secret_set)" = "true" ] \
  || fail "reading the webhook lost it: $(ag_body)"
grep -qF -- "$AG_SECRET" "$AG_DIR/last.json" && fail "reading the webhook answered the secret"
ag_call GET /api/vault/config "$AG_SAM_TOKEN" ""
grep -qF -- "$AG_SECRET" "$AG_DIR/last.json" && fail "GET /api/vault/config answered the webhook secret"
ag_audit "action = 'agent_webhook_set'" | grep -qF -- "$AG_SECRET" && fail "the webhook secret reached audit_log"
ok "an admin sets the research webhook; the secret is never answered, configured out or logged"

# A draft buy-in with one line, as the wizard writes it.
AG_TRADE="$(curl -s -X POST "$BASE/api/collections/trade_ins/records" -H "Authorization: $AG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer\":\"$AG_CUSTOMER\",\"status\":\"draft\",\"channel\":\"counter\"}" | jval id)"
AG_LINE="$(curl -s -X POST "$BASE/api/collections/trade_in_lines/records" -H "Authorization: $AG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trade_in\":\"$AG_TRADE\",\"card\":\"$AG_CARD\",\"kind\":\"single\",\"finish\":\"holo\",\"condition\":\"LP\",\"qty\":1,\"accepted\":true}" | jval id)"
[ -n "$AG_LINE" ] || fail "could not create the section's trade-in line"

ag_call POST /api/vault/research "$AG_SAM_TOKEN" '{}'
ag_expect 400 "Say what to research: a card, a retro title, an item, a trade-in line or some search words." "research with nothing to research"
ag_call POST /api/vault/research "$AG_SAM_TOKEN" '{"trade_in_line":"agnosuchline000"}'
ag_expect 404 "That trade-in line was not found. Save the line and try again." "research on an unknown line"
ag_call POST /api/vault/research "$AG_SAM_TOKEN" "{\"trade_in_line\":\"$AG_LINE\"}"
ag_expect 201 "" "research from a trade-in line"
AG_REQUEST="$(ag_get request.id)"
[ "$(ag_get request.status)" = "open" ] && [ "$(ag_get request.card)" = "$AG_CARD" ] && [ "$(ag_get request.finish)" = "holo" ] \
  && [ "$(ag_get request.condition)" = "LP" ] && [ "$(ag_get request.trade_in_line)" = "$AG_LINE" ] \
  || fail "the request did not take its card, finish and condition from the line: $(ag_body)"
[ "$(ag_get request.query)" = "AG Charizard ex AG One Five One 199 holo" ] || fail "the request's search words are wrong: $(ag_get request.query)"
[ "$(ag_get request.ebay_url)" = "https://www.ebay.co.uk/sch/i.html?_nkw=AG+Charizard+ex+AG+One+Five+One+199+holo&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1" ] \
  || fail "the request's eBay sold link is wrong: $(ag_get request.ebay_url)"
[ "$(ag_get request.requested_by.id)" = "$AG_SAM" ] || fail "the request does not name who asked: $(ag_body)"

# The webhook was called, signed both ways a receiver might check.
[ -f "$AG_DIR/hook.1" ] || fail "the webhook was not called for the new request"
node -e '
  const c = require("crypto"), fs = require("fs");
  const [file, secret, id] = process.argv.slice(1);
  const hook = JSON.parse(fs.readFileSync(file, "utf8"));
  const h = hook.headers, body = hook.body;
  const want = c.createHmac("sha256", secret).update(body).digest("hex");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (hook.path !== "/webhooks/ggvault") fail("posted to " + hook.path);
  if (h["x-gg-signature"] !== want) fail("X-GG-Signature is not the HMAC-SHA256 of the body");
  if (h["x-webhook-signature"] !== want) fail("X-Webhook-Signature is not the same signature");
  const v2 = c.createHmac("sha256", secret).update(h["x-webhook-timestamp"] + "." + body).digest("hex");
  if (h["x-webhook-signature-v2"] !== v2) fail("X-Webhook-Signature-V2 is not the timestamped signature");
  if (Math.abs(Date.now() / 1000 - Number(h["x-webhook-timestamp"])) > 60) fail("the timestamp is not now");
  if (h["x-gg-event"] !== "research.requested") fail("X-GG-Event is " + h["x-gg-event"]);
  const parsed = JSON.parse(body);
  if (parsed.event_type !== "research.requested" || parsed.data.id !== id) fail("the body is not the new request");
  if (!parsed.data.ebay_url) fail("the body carries no eBay link");
' "$AG_DIR/hook.1" "$AG_SECRET" "$AG_REQUEST" || fail "the research webhook was not called and signed as it should be"
[ "$(ag_audit_count "action = 'research_webhook' && record = '$AG_REQUEST' && meta.ok = true")" = "1" ] \
  || fail "the webhook call was not audited as delivered"
ag_audit "action = 'research_webhook'" | grep -qF -- "127.0.0.1:$AG_LISTEN_PORT" && fail "the webhook address reached audit_log"

# Asking again while it is open wakes nobody twice.
ag_call POST /api/vault/research "$AG_ADMIN_TOKEN" "{\"trade_in_line\":\"$AG_LINE\"}"
ag_expect 200 "" "asking again about the same line"
[ "$(ag_get request.id)" = "$AG_REQUEST" ] && [ "$(ag_get existing)" = "true" ] || fail "asking again made a second request: $(ag_body)"
[ ! -f "$AG_DIR/hook.2" ] || fail "asking again called the webhook again"
ok "a request from a trade-in line takes the line's card, finish and condition, wakes the agent once, signed, and answers the open one when asked again"

ag_call GET "/api/vault/research?status=open" "$AG_SAM_TOKEN" ""
ag_expect 200 "" "listing open research"
[ "$(ag_js "r.requests.filter((q) => q.id === '$AG_REQUEST').length")" = "1" ] || fail "the open list lacks the request: $(ag_body)"
ag_call GET "/api/vault/research?status=sideways" "$AG_SAM_TOKEN" ""
ag_expect 400 "Filter by open, claimed, done or cancelled." "a list by an unknown status"
ag_tool "$AG_TOKEN" research_list '{}'
[ "$(ag_tool_js "t.requests.filter((q) => q.id === '$AG_REQUEST').length")" = "1" ] || fail "research_list does not show the open request"
ag_tool "$AG_TOKEN" research_claim "{\"id\":\"$AG_REQUEST\"}"
[ "$AG_TOOL_ERROR" = "false" ] && [ "$(ag_tool_js 't.request.status')" = "claimed" ] && [ "$(ag_tool_js 't.request.claimed_by.name')" = "Gandalf" ] \
  || fail "the agent could not claim the request: $(ag_tool_text)"
ag_tool "$AG_TOKEN" research_claim "{\"id\":\"$AG_REQUEST\"}"
[ "$AG_TOOL_ERROR" = "false" ] || fail "claiming your own claim again was refused: $(ag_tool_text)"
ag_call POST "/api/vault/research/$AG_REQUEST/claim" "$AG_SAM_TOKEN" ""
ag_expect 409 "Gandalf has already claimed this one." "claiming somebody else's claim"
ag_call POST "/api/vault/research/$AG_REQUEST/complete" "$AG_SAM_TOKEN" '{"result":"x","comps":[]}'
ag_expect 409 "Gandalf has already claimed this one." "completing somebody else's claim"
[ "$(ag_audit_count "action = 'research_claimed' && record = '$AG_REQUEST' && actor = '$AG_AGENT'")" = "1" ] \
  || fail "the claim was not audited once under the agent"

AG_SOLD="$(node -e 'process.stdout.write(new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10))')"
AG_OLD="$(node -e 'process.stdout.write(new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10))')"
ag_tool "$AG_TOKEN" research_complete "{\"id\":\"$AG_REQUEST\",\"result\":\"x\",\"comps\":[{\"price_pence\":4600,\"sold_at\":\"$AG_OLD\",\"url\":\"https://www.ebay.co.uk/itm/350000000002\"}]}"
[ "$AG_TOOL_ERROR" = "true" ] && [ "$(ag_tool_text)" = "Comp 1: That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days." ] \
  || fail "an old comp was not refused in the uk-comp route's words: $(ag_tool_text)"
ag_call POST "/api/vault/research/$AG_REQUEST/complete" "Bearer $AG_TOKEN" '{"result":"x","comps":[{"price":46,"currency":"USD","sold_at":"2026-10-01","url":"https://www.ebay.co.uk/itm/1"}]}'
ag_expect 400 "Comp 1 is in USD. A UK sold comp is in pounds." "a comp in dollars"
ag_call POST "/api/vault/research/$AG_REQUEST/complete" "Bearer $AG_TOKEN" '{"result":"x","comps":[{"price":45.5,"sold_at":"2026-10-01","url":"https://www.ebay.co.uk/itm/1"}]}'
ag_expect 400 "Comp 1: give the price in whole pence, for example 1250 for £12.50." "a comp in pounds and pence"
[ "$(ag_record research_requests "$AG_REQUEST" status)" = "claimed" ] || fail "a refused completion changed the request"

ag_tool "$AG_TOKEN" research_complete "{\"id\":\"$AG_REQUEST\",\"result\":\"Two sold in the last week, both played holo copies.\",\"comps\":[{\"price_pence\":4650,\"sold_at\":\"$AG_SOLD\",\"url\":\"https://www.ebay.co.uk/itm/350000000003\",\"title\":\"AG Charizard ex 199 holo\",\"condition\":\"Used\"},{\"price_pence\":4900,\"sold_at\":\"$AG_TODAY\",\"url\":\"https://www.ebay.co.uk/itm/350000000004\",\"title\":\"AG Charizard ex holo 199\"}]}"
[ "$AG_TOOL_ERROR" = "false" ] || fail "completing the request failed: $(ag_tool_text)"
[ "$(ag_tool_js 't.request.status')" = "done" ] && [ "$(ag_tool_js 't.written')" = "2" ] && [ "$(ag_tool_js 't.request.comps.length')" = "2" ] \
  || fail "completing did not mark it done with two comps written: $(ag_tool_text)"
[ "$(ag_tool_js 't.request.comps[1].price_gbp')" = "£49.00" ] || fail "the comps are not in pounds as well as pence: $(ag_tool_text)"
[ "$(ag_tool_js 't.request.result')" = "Two sold in the last week, both played holo copies." ] || fail "the result was lost"
AG_SNAPS="$(curl -s -G "$BASE/api/collections/price_snapshots/records" -H "Authorization: $SUPER_TOKEN" \
  --data-urlencode "filter=card = '$AG_CARD' && finish = 'holo' && source = 'uk_sold_manual'" --data-urlencode "sort=-fetched_at")"
[ "$(jval totalItems <<<"$AG_SNAPS")" = "3" ] || fail "the comps did not land as UK sold comps beside the earlier one: $AG_SNAPS"
grep -qF "https://www.ebay.co.uk/itm/350000000004" <<<"$AG_SNAPS" || fail "a comp's evidence URL was not kept"
[ "$(jval items.0.native_currency <<<"$AG_SNAPS")" = "GBP" ] && [ "$(jval items.0.gbp_market <<<"$AG_SNAPS")" = "4900" ] \
  || fail "the newest comp is not 4900 pence in GBP: $AG_SNAPS"
ag_call GET "/api/vault/cards/$AG_CARD/prices?finish=holo&condition=LP" "$AG_SAM_TOKEN" ""
[ "$(ag_get chosen.source)" = "uk_sold_manual" ] && [ "$(ag_get chosen.gbp_market)" = "4900" ] \
  && [ "$(ag_get chosen.evidence_url)" = "https://www.ebay.co.uk/itm/350000000004" ] \
  || fail "the line's first price source is not the agent's newest comp: $(ag_body)"
[ "$(ag_audit_count "action = 'uk_comp' && actor = '$AG_AGENT' && meta.research = '$AG_REQUEST'")" = "2" ] \
  || fail "each comp was not audited as a uk_comp under the agent"
[ "$(ag_audit_count "action = 'research_completed' && record = '$AG_REQUEST' && actor = '$AG_AGENT' && meta.written = 2")" = "1" ] \
  || fail "the completion was not audited under the agent"
ag_call POST "/api/vault/research/$AG_REQUEST/complete" "Bearer $AG_TOKEN" '{"result":"again","comps":[]}'
ag_expect 409 "This request is done. Its comps are in the Research list." "completing a request twice"
ag_call POST "/api/vault/research/$AG_REQUEST/cancel" "$AG_SAM_TOKEN" ""
ag_expect 409 "This request is done. Its comps are in the Research list." "cancelling a done request"
ag_call GET "/api/vault/research?trade_in_line=$AG_LINE&status=done" "$AG_SAM_TOKEN" ""
[ "$(ag_js 'r.requests[0].comps.length')" = "2" ] && [ "$(ag_js 'r.requests[0].claimed_by.kind')" = "agent" ] \
  || fail "the line's done request does not show its comps and its agent: $(ag_body)"
ok "an agent claims and completes a request; each comp is checked by the uk-comp rule and lands as a UK sold comp, the line's first source"

# Words alone, with nothing to file comps under, and cancelling.
ag_call POST /api/vault/research "$AG_SAM_TOKEN" '{"query":"AG Pokemon 151 Elite Trainer Box"}'
ag_expect 201 "" "research on plain search words"
AG_WORDS="$(ag_get request.id)"
ag_call POST "/api/vault/research/$AG_WORDS/complete" "$AG_SAM_TOKEN" "{\"result\":\"One sold.\",\"comps\":[{\"price\":5200,\"sold_at\":\"$AG_TODAY\",\"url\":\"https://www.ebay.co.uk/itm/350000000005\"}]}"
ag_expect 200 "" "a person completing an open request"
[ "$(ag_get written)" = "0" ] && [ "$(ag_get request.claimed_by.id)" = "$AG_SAM" ] \
  || fail "comps on words alone were written somewhere, or the completer was not recorded: $(ag_body)"
ag_call POST /api/vault/research "$AG_SAM_TOKEN" "{\"card\":\"$AG_CARD\",\"condition\":\"XX\"}"
ag_expect 400 "Pick a condition: NM, LP, MP, HP or DMG." "research with an unknown condition"
ag_call POST /api/vault/research "$AG_SAM_TOKEN" "{\"item\":\"$AG_ITEM\"}"
ag_expect 201 "" "research from the item page"
AG_ITEM_REQUEST="$(ag_get request.id)"
[ "$(ag_get request.card)" = "$AG_CARD" ] && [ "$(ag_get request.finish)" = "holo" ] || fail "the item's request lost its card: $(ag_body)"
ag_call POST "/api/vault/research/$AG_ITEM_REQUEST/cancel" "$AG_SAM_TOKEN" ""
ag_expect 200 "" "cancelling an open request"
[ "$(ag_get request.status)" = "cancelled" ] || fail "the request was not cancelled"
ag_call POST "/api/vault/research/$AG_ITEM_REQUEST/claim" "Bearer $AG_TOKEN" ""
ag_expect 409 "This request was cancelled. Ask again if it is still needed." "claiming a cancelled request"
ag_call POST /api/collections/research_requests/records "$AG_ADMIN_TOKEN" '{"query":"forged","status":"done"}'
[ "$AG_STATUS" = "403" ] || fail "research_requests took a write through the collection API ($AG_STATUS)"
ok "research on words keeps its comps on the request, an item's takes its card, cancelling works, and the collection API takes no writes"

ag_stop_listener

# --- 35g. What an agent may not do ----------------------------------------------

ag_call GET /api/vault/till/roster "" "" "X-GG-Device: $AG_DEVICE"
ag_expect 200 "" "the roster"
[ "$(ag_js "r.staff.filter((s) => s.id === '$AG_AGENT').length")" = "0" ] || fail "the agent is on the roster: $(ag_body)"
[ "$(ag_js "r.staff.filter((s) => s.id === '$AG_MO').length")" = "1" ] || fail "the roster lost a person: $(ag_body)"
ag_call POST /api/vault/till/unlock "" "{\"staff\":\"$AG_AGENT\",\"pin\":\"1234\"}" "X-GG-Device: $AG_DEVICE"
ag_expect 403 "$AG_SAY_UNLOCK" "unlocking a till as the agent"
ag_call POST /api/vault/till/override "$AG_SAM_TOKEN" "{\"capability\":\"refund\",\"approver\":\"$AG_AGENT\",\"pin\":\"1234\"}" "X-GG-Device: $AG_DEVICE"
ag_expect 403 "$AG_SAY_APPROVE" "the agent as a manager's approver"
[ "$(ag_audit_count "action = 'override_granted' && meta.approver = '$AG_AGENT'")" = "0" ] || fail "an approval by the agent was granted"
ag_call POST "/api/vault/staff/$AG_AGENT/pin" "$AG_ADMIN_TOKEN" '{"pin":"135790"}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 403 "$AG_SAY_PIN" "an admin giving the agent a PIN"
ag_call POST /api/vault/staff/me/pin "Bearer $AG_TOKEN" '{"pin":"135790"}'
ag_expect 403 "$AG_SAY_PIN" "the agent setting its own PIN"
ag_call PATCH "/api/collections/staff/records/$AG_AGENT" "$SUPER_TOKEN" '{"pin_hash":"v1$0000"}'
[ "$AG_STATUS" = "400" ] || fail "a PIN hash was written to the agent's row ($AG_STATUS): $(ag_body)"
[ -z "$(ag_record staff "$AG_AGENT" pin_hash)" ] || fail "the agent holds a PIN hash"
ag_call POST "/api/vault/staff/$AG_AGENT/password" "$AG_ADMIN_TOKEN" '{"password":"a-password-for-an-agent"}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 403 "Agents do not have a password. They use their token." "an admin giving the agent a password"
ag_call PATCH "/api/vault/staff/$AG_AGENT" "$AG_ADMIN_TOKEN" '{"role":"staff"}' "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 403 "$AG_SAY_STAFF_ROUTE" "changing the agent through the staff routes"
AG_AGENT_EMAIL="$(ag_record staff "$AG_AGENT" email)"
ag_call POST /api/collections/staff/auth-with-password "" "{\"identity\":\"$AG_AGENT_EMAIL\",\"password\":\"anything-at-all-123\"}"
ag_expect 403 "$AG_SAY_PASSWORD" "a password sign-in as the agent"
ag_call POST /api/vault/step-up "Bearer $AG_TOKEN" '{"password":"anything-at-all-123"}'
ag_expect 403 "$AG_SAY_STEP_UP" "the agent asking for a step-up"
ag_call GET /api/vault/id-photo/agnosuchphoto00 "Bearer $AG_TOKEN" ""
ag_expect 403 "$AG_SAY_ID_PHOTO" "the agent opening an ID photo"
ag_call POST /api/vault/agents "Bearer $AG_TOKEN" '{"name":"Saruman"}'
ag_expect 403 "$AG_STEP_UP_REFUSAL" "the agent making another agent"
ag_call POST /api/collections/staff/records "$AG_ADMIN_TOKEN" '{"name":"AG Forged","email":"ag-forged@local.test","password":"ag-forged-password-1","passwordConfirm":"ag-forged-password-1","role":"admin","active":true,"kind":"agent"}'
ag_expect 400 "Add an agent in Settings, Agents." "an admin making an agent through the collection API"
ag_call PATCH "/api/collections/staff/records/$AG_SAM" "$AG_ADMIN_TOKEN" '{"kind":"agent"}'
ag_expect 400 "An account cannot change between a person and an agent." "an admin turning a person into an agent"
[ "$(ag_record staff "$AG_SAM" kind)" = "person" ] || fail "a person became an agent"
ok "an agent is never on the roster and cannot unlock, approve, hold a PIN or a password, sign in with one, step up or open an ID photo"

# --- 35h. Re-keying ------------------------------------------------------------------

ag_call POST "/api/vault/agents/$AG_AGENT/token" "$AG_ADMIN_TOKEN" ""
ag_expect 403 "$AG_STEP_UP_REFUSAL" "re-keying without a step-up"
ag_call POST "/api/vault/agents/agnosuchagent00/token" "$AG_ADMIN_TOKEN" "" "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 404 "That agent was not found." "re-keying an unknown agent"
ag_call POST "/api/vault/agents/$AG_SAM/token" "$AG_ADMIN_TOKEN" "" "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 404 "That agent was not found." "re-keying a person"
ag_call POST "/api/vault/agents/$AG_AGENT/token" "$AG_ADMIN_TOKEN" "" "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 200 "" "re-keying the agent"
AG_TOKEN2="$(ag_get token)"
[ -n "$AG_TOKEN2" ] && [ "$AG_TOKEN2" != "$AG_TOKEN" ] || fail "re-keying did not answer a new token"
ag_call GET /api/vault/me "Bearer $AG_TOKEN" ""
ag_expect 401 "" "the old token after a re-key"
ag_mcp "$AG_TOKEN" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
ag_expect 401 "" "the old token on MCP after a re-key"
ag_mcp "$AG_TOKEN2" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
ag_expect 200 "" "the new token on MCP"
[ "$(ag_audit_count "action = 'agent_token_issued' && record = '$AG_AGENT'")" = "2" ] || fail "the re-key was not audited"
ag_audit "record = '$AG_AGENT'" | grep -qF -- "$AG_TOKEN2" && fail "the new token reached audit_log"
ok "re-keying needs a step-up, answers a new token once, and the old one stops at once on every route"

# --- 35i. Switching off ------------------------------------------------------------------

ag_call PATCH "/api/vault/agents/$AG_AGENT" "$AG_ADMIN_TOKEN" '{"active":"no"}'
ag_expect 400 "Say whether the agent is on with true or false." "switching off with a word"
ag_call PATCH "/api/vault/agents/$AG_AGENT" "$AG_ADMIN_TOKEN" '{}'
ag_expect 400 "There is nothing to change. Send a name, a note or active." "an empty change"
ag_call PATCH "/api/vault/agents/$AG_AGENT" "$AG_ADMIN_TOKEN" '{"active":false}'
ag_expect 200 "" "switching the agent off"
[ "$(ag_get agent.active)" = "false" ] && [ -z "$(ag_get agent.token_expires_at)" ] \
  || fail "the switched-off agent still shows a live token: $(ag_body)"
ag_call GET /api/vault/me "Bearer $AG_TOKEN2" ""
ag_expect 401 "" "the token once the agent is off"
ag_mcp "$AG_TOKEN2" '{"jsonrpc":"2.0","id":1,"method":"ping"}'
ag_expect 401 "" "MCP once the agent is off"
ag_call POST "/api/vault/agents/$AG_AGENT/token" "$AG_ADMIN_TOKEN" "" "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 409 "$AG_SAY_OFF" "re-keying an agent that is off"
ag_call PATCH "/api/vault/agents/$AG_AGENT" "$AG_ADMIN_TOKEN" '{"active":true,"note":"Back on"}'
ag_expect 200 "" "switching the agent back on"
ag_call GET /api/vault/me "Bearer $AG_TOKEN2" ""
ag_expect 401 "" "the old token after switching back on"
ag_call POST "/api/vault/agents/$AG_AGENT/token" "$AG_ADMIN_TOKEN" "" "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 200 "" "a new token after switching back on"
AG_TOKEN3="$(ag_get token)"
ag_call GET /api/vault/me "Bearer $AG_TOKEN3" ""
ag_expect 200 "" "the newest token"
[ "$(ag_audit_count "action = 'agent_switched_off' && record = '$AG_AGENT' && actor = '$AG_ADMIN'")" = "1" ] \
  && [ "$(ag_audit_count "action = 'agent_switched_on' && record = '$AG_AGENT'")" = "1" ] \
  && [ "$(ag_audit_count "action = 'agent_updated' && record = '$AG_AGENT'")" = "1" ] \
  || fail "switching off and on and the note were not audited"

# Switching off through the collection API kills the token just the same.
ag_call PATCH "/api/collections/staff/records/$AG_AGENT" "$AG_ADMIN_TOKEN" '{"active":false}'
ag_expect 200 "" "switching the agent off through the collection API"
ag_call GET /api/vault/me "Bearer $AG_TOKEN3" ""
ag_expect 401 "" "the token once the agent is off through the collection API"
ag_call PATCH "/api/vault/agents/$AG_AGENT" "$AG_ADMIN_TOKEN" '{"active":true}'
ag_expect 200 "" "switching it back on"
ag_call POST "/api/vault/agents/$AG_AGENT/token" "$AG_ADMIN_TOKEN" "" "X-Step-Up: $AG_ADMIN_STEP"
ag_expect 200 "" "a token for the rest of the section"
AG_TOKEN4="$(ag_get token)"
ok "switching an agent off stops its token at once, by either route; on again, it needs a new token"

# --- 35j. Its last 50 actions --------------------------------------------------------------

ag_call GET "/api/vault/agents/$AG_AGENT/actions" "$AG_SAM_TOKEN" ""
[ "$AG_STATUS" = "403" ] || fail "a plain member of staff read the agent's actions ($AG_STATUS)"
ag_call GET "/api/vault/agents/$AG_AGENT/actions" "$AG_ADMIN_TOKEN" ""
ag_expect 200 "" "the agent's actions"
AG_ACTIONS="$(ag_js 'r.actions.length')"
[ "$AG_ACTIONS" -ge 20 ] && [ "$AG_ACTIONS" -le 50 ] || fail "the actions list has $AG_ACTIONS rows: $(ag_body)"
[ "$(ag_js "r.actions.filter((a) => a.action === 'research_completed').length")" = "1" ] \
  && [ "$(ag_js "r.actions.filter((a) => a.action === 'mcp_call' && a.detail.indexOf('research_complete') === 0).length")" -ge 1 ] \
  || fail "the actions list lacks the agent's research and tool calls: $(ag_body)"
[ "$(ag_js 'r.actions.every((a, i, all) => i === 0 || all[i - 1].created >= a.created)')" = "true" ] || fail "the actions are not newest first"
for AG_N in $(seq 1 30); do
  curl -s -o /dev/null -X POST "$BASE/api/vault/mcp" -H "Authorization: Bearer $AG_TOKEN4" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"category_tree","arguments":{"query":"zzz"}}}'
done
ag_call GET "/api/vault/agents/$AG_AGENT/actions" "$AG_ADMIN_TOKEN" ""
[ "$(ag_js 'r.actions.length')" = "50" ] || fail "the actions list is not capped at 50: $(ag_js 'r.actions.length')"
ag_call GET /api/vault/agents "$AG_ADMIN_TOKEN" ""
[ -n "$(ag_js "r.agents.find((a) => a.id === '$AG_AGENT').last_action_at")" ] || fail "the agent list does not say when it last acted"
ok "the Agents screen's list shows an agent's last 50 actions from the audit log, newest first"
