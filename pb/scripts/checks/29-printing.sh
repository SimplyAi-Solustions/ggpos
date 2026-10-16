# shellcheck shell=bash
# 29. Printing: Star CloudPRNT printers, print jobs and the cash drawer
# (docs/api-contract-epos.md, section 6; pb_hooks/printing.pb.js and
# pb_hooks/lib/printing.js).
#
# Sourced by pb/scripts/check.sh into its own shell, so $BASE, $ROOT,
# $SUPER_TOKEN, $STAFF_TOKEN (an admin), $TMP_DIR and ok/fail/jval are all
# here. It plays both sides: staff calling the routes with a token, and a
# printer polling with only the secret in its URL. Nothing here prints.

PR_DIR="$TMP_DIR/printing"
mkdir -p "$PR_DIR"
PR_STATUS=""

# One request. The body lands in $PR_DIR/body, the headers in
# $PR_DIR/headers, the status in $PR_STATUS, and every body is also appended
# to all-responses.log so the last check can prove no secret was ever in one.
pr_call() {
  local method="$1" path="$2"
  shift 2
  PR_STATUS="$(curl -s -o "$PR_DIR/body" -D "$PR_DIR/headers" -w '%{http_code}' \
    -X "$method" "$BASE$path" "$@")"
  cat "$PR_DIR/body" >>"$PR_DIR/all-responses.log"
  echo >>"$PR_DIR/all-responses.log"
}
pr_body() { jval "$1" <"$PR_DIR/body"; }
pr_header() {
  grep -i "^$1:" "$PR_DIR/headers" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//' || true
}
# A staff call with a token and a JSON body (or none).
pr_staff() {
  local token="$1" method="$2" path="$3" data="${4:-}"
  if [ -n "$data" ]; then
    pr_call "$method" "$path" -H "Authorization: $token" -H "Content-Type: application/json" -d "$data"
  else
    pr_call "$method" "$path" -H "Authorization: $token"
  fi
}
# A printer's poll.
pr_poll() {
  pr_call POST "/api/vault/cloudprnt/$1" -H "Content-Type: application/json" -d "$2"
}
pr_super() { curl -s "$BASE$1" -H "Authorization: $SUPER_TOKEN"; }
pr_expect() {
  [ "$PR_STATUS" = "$1" ] || fail "$2 (got $PR_STATUS, wanted $1): $(cat "$PR_DIR/body")"
}

# -----------------------------------------------------------------------
# 29a. The pure parts, in plain Node: MAC and encodings parsing, the PNG
# reader, and the white PNG a drawer kick is sent as, decoded back.
# -----------------------------------------------------------------------
node -e '
const assert = require("assert");
const zlib = require("zlib");
const p = require(process.argv[1]);

assert.strictEqual(p.normaliseMac("00-11-E5-06-04-FF"), "00:11:e5:06:04:ff");
assert.strictEqual(p.normaliseMac("0011e50604ff"), "00:11:e5:06:04:ff");
assert.strictEqual(p.normaliseMac("00:11:e5:06:04"), "");
assert.strictEqual(p.normaliseMac("zz:11:e5:06:04:ff"), "");
assert.deepStrictEqual(
  p.parseEncodings("image/png; Image/JPEG; application/vnd.star.line;;text/plain; image/png"),
  ["image/png", "image/jpeg", "application/vnd.star.line", "text/plain"]
);
assert.strictEqual(p.decodeStatus("200%20OK"), "200 OK");
// The two textbook CRC-32 and Adler-32 vectors.
const nine = Array.from(Buffer.from("123456789"));
assert.strictEqual(p.crc32(nine), 0xcbf43926);
assert.strictEqual(p.adler32(Array.from(Buffer.from("Wikipedia"))), 0x11e60398);

for (const width of [576, 384]) {
  const bytes = Buffer.from(p.whitePng(width));
  assert.deepStrictEqual(p.pngSize(Array.from(bytes)), { width, height: 1 });
  // Walk the chunks, check every CRC, inflate the pixels.
  let at = 8;
  let idat = Buffer.alloc(0);
  const seen = [];
  while (at < bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + len);
    const crc = bytes.readUInt32BE(at + 8 + len);
    assert.strictEqual(crc, p.crc32(Array.from(bytes.subarray(at + 4, at + 8 + len))), type + " crc");
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    seen.push(type);
    at += 12 + len;
  }
  assert.deepStrictEqual(seen, ["IHDR", "IDAT", "IEND"]);
  const pixels = zlib.inflateSync(idat);
  assert.strictEqual(pixels.length, width + 1);
  assert.strictEqual(pixels[0], 0);
  assert.ok(pixels.subarray(1).every((b) => b === 255), "every pixel white");
}
assert.strictEqual(p.pngSize([1, 2, 3]), null);
' "$ROOT/pb/pb_hooks/lib/printing.js" || fail "lib/printing.js pure helpers"
ok "the MAC, encodings, CRC and PNG helpers behave, and the drawer PNG decodes as one white row at each width"

# -----------------------------------------------------------------------
# Test images: receipts at each width, a wrong width, and an oversize one.
# -----------------------------------------------------------------------
cat >"$PR_DIR/mkpng.js" <<'EOF'
// node mkpng.js <lib/printing.js> <out> <width> <height> [noise]
const zlib = require("zlib");
const fs = require("fs");
const crypto = require("crypto");
const lib = require(process.argv[2]);
const out = process.argv[3];
const width = Number(process.argv[4]);
const height = Number(process.argv[5]);
const noise = process.argv[6] === "noise";

const raw = Buffer.alloc((width + 1) * height);
for (let y = 0; y < height; y++) {
  raw[y * (width + 1)] = 0;
  for (let x = 0; x < width; x++) {
    // Bars in the top half, white below: something a printer could print.
    raw[y * (width + 1) + 1 + x] = noise ? crypto.randomInt(256) : y < height / 2 && (x >> 3) % 2 === 0 ? 0 : 255;
  }
}
const idat = noise ? zlib.deflateSync(raw, { level: 0 }) : zlib.deflateSync(raw);

function be32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([be32(data.length), body, be32(lib.crc32(Array.from(body)))]);
}
const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 0, 0, 0, 0])]);
fs.writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ])
);
EOF
LIB_PRINTING="$ROOT/pb/pb_hooks/lib/printing.js"
node "$PR_DIR/mkpng.js" "$LIB_PRINTING" "$PR_DIR/r576.png" 576 60
node "$PR_DIR/mkpng.js" "$LIB_PRINTING" "$PR_DIR/r384.png" 384 60
node "$PR_DIR/mkpng.js" "$LIB_PRINTING" "$PR_DIR/r800.png" 800 20
node "$PR_DIR/mkpng.js" "$LIB_PRINTING" "$PR_DIR/huge.png" 576 4000 noise
echo "this is not an image" >"$PR_DIR/not-a-png.png"
[ "$(wc -c <"$PR_DIR/huge.png")" -gt 2097152 ] || fail "the oversize test image is not over 2 MB"

# -----------------------------------------------------------------------
# Registers and a plain staff member (the superuser makes both).
# -----------------------------------------------------------------------
COUNTER_ID="$(pr_super "/api/collections/registers/records?filter=name%3D%27Counter%27" | jval items.0.id)"
[ -n "$COUNTER_ID" ] || fail "the seeded Counter register is missing"
BACK_ID="$(curl -s -X POST "$BASE/api/collections/registers/records" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Back office","active":true,"sort":50}' | jval id)"
SPARE_ID="$(curl -s -X POST "$BASE/api/collections/registers/records" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Spare","active":true,"sort":60}' | jval id)"
[ -n "$BACK_ID" ] && [ -n "$SPARE_ID" ] || fail "could not create the extra registers"

PR_PLAIN_EMAIL="printing-plain@local.test"
PR_PLAIN_PASSWORD="plainstaffpassword123"
curl -s -o /dev/null -X POST "$BASE/api/collections/staff/records" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$PR_PLAIN_EMAIL\",\"password\":\"$PR_PLAIN_PASSWORD\",\"passwordConfirm\":\"$PR_PLAIN_PASSWORD\",\"name\":\"Plain Staff\",\"role\":\"staff\",\"active\":true}"
PLAIN_TOKEN="$(curl -s -X POST "$BASE/api/collections/staff/auth-with-password" -H "Content-Type: application/json" \
  -d "{\"identity\":\"$PR_PLAIN_EMAIL\",\"password\":\"$PR_PLAIN_PASSWORD\"}" | jval token)"
[ -n "$PLAIN_TOKEN" ] || fail "could not sign in the plain staff member"

# -----------------------------------------------------------------------
# 29b. Adding a printer
# -----------------------------------------------------------------------
pr_staff "$PLAIN_TOKEN" POST /api/vault/printers \
  "{\"name\":\"Nope\",\"mac\":\"00:11:e5:06:04:01\",\"register\":\"$COUNTER_ID\"}"
pr_expect 403 "a plain staff member added a printer"
pr_call POST /api/vault/printers -H "Content-Type: application/json" \
  -d "{\"name\":\"Nope\",\"mac\":\"00:11:e5:06:04:01\",\"register\":\"$COUNTER_ID\"}"
pr_expect 401 "an unsigned call added a printer"
ok "adding a printer is admin only: a plain staff member gets 403 and no token gets 401"

pr_staff "$STAFF_TOKEN" POST /api/vault/printers "{\"name\":\"\",\"mac\":\"00:11:e5:06:04:01\",\"register\":\"$COUNTER_ID\"}"
pr_expect 400 "a nameless printer was accepted"
pr_staff "$STAFF_TOKEN" POST /api/vault/printers "{\"name\":\"X\",\"mac\":\"not a mac\",\"register\":\"$COUNTER_ID\"}"
pr_expect 400 "a bad MAC was accepted"
echo "$(pr_body message)" | grep -q "MAC address" || fail "the MAC refusal does not say what to type: $(cat "$PR_DIR/body")"
pr_staff "$STAFF_TOKEN" POST /api/vault/printers "{\"name\":\"X\",\"mac\":\"00:11:e5:06:04:01\",\"register\":\"$COUNTER_ID\",\"paper_width\":72}"
pr_expect 400 "a 72 mm paper width was accepted"
pr_staff "$STAFF_TOKEN" POST /api/vault/printers '{"name":"X","mac":"00:11:e5:06:04:01","register":"nosuchregister1"}'
pr_expect 404 "an unknown register was accepted"
ok "a printer needs a name, a real MAC, 80 or 58 mm paper and a register that exists"

# Printer A on the Counter, the MAC typed the way a label prints it.
pr_staff "$STAFF_TOKEN" POST /api/vault/printers \
  "{\"name\":\"Counter printer\",\"mac\":\"00-11-E5-06-04-FF\",\"register\":\"$COUNTER_ID\",\"model\":\"Star TSP143IV\"}"
pr_expect 201 "could not add printer A"
A_ID="$(pr_body printer.id)"
A_URL="$(pr_body url)"
A_TOKEN="${A_URL##*/}"
[ "${#A_TOKEN}" = "32" ] || fail "the printer URL token is not 32 characters: $A_URL"
echo "$A_URL" | grep -q "/api/vault/cloudprnt/$A_TOKEN\$" || fail "the printer URL is not .../api/vault/cloudprnt/<token>: $A_URL"
[ "$(pr_body printer.mac)" = "00:11:e5:06:04:ff" ] || fail "the MAC was not stored lower-case with colons: $(cat "$PR_DIR/body")"
[ "$(pr_body printer.paper_width)" = "80" ] || fail "paper width did not default to 80"
[ "$(pr_body printer.register_name)" = "Counter" ] || fail "the printer does not carry its register's name"
[ "$(pr_body printer.online)" = "false" ] || fail "a printer that has never polled is online"
grep -q "token_hash" "$PR_DIR/body" && fail "the add response carries token_hash"
ok "an admin adds a printer: the MAC is normalised, paper defaults to 80 and the URL carries a 32 character token"

pr_staff "$STAFF_TOKEN" POST /api/vault/printers \
  "{\"name\":\"Again\",\"mac\":\"00:11:E5:06:04:FF\",\"register\":\"$COUNTER_ID\"}"
pr_expect 409 "a second printer with the same MAC was added"
ok "a MAC address can belong to one printer only"

# Only the sha256 is stored: hash the token here and compare with the row.
A_HASH="$(printf '%s' "$A_TOKEN" | sha256sum | cut -d' ' -f1)"
A_ROW="$(pr_super "/api/collections/printers/records/$A_ID?fields=*,token_hash")"
[ "$(echo "$A_ROW" | jval token_hash)" = "$A_HASH" ] || fail "printers.token_hash is not the sha256 of the URL token: $A_ROW"
echo "$A_ROW" | grep -qF "$A_TOKEN" && fail "the printer row holds the raw token"
ok "only the sha256 of the token is stored"

PR_AUDIT="$(pr_super "/api/collections/audit_log/records?filter=action%3D%27printer_added%27")"
[ "$(echo "$PR_AUDIT" | jval totalItems)" = "1" ] || fail "adding a printer left $(echo "$PR_AUDIT" | jval totalItems) printer_added rows: $PR_AUDIT"
[ "$(echo "$PR_AUDIT" | jval items.0.record)" = "$A_ID" ] || fail "printer_added does not name the printer"
echo "$PR_AUDIT" | grep -qF "$A_TOKEN" && fail "printer_added carries the token"
echo "$PR_AUDIT" | grep -qF "$A_HASH" && fail "printer_added carries the token hash"
ok "adding a printer is audited as printer_added, with no token or hash in the row"

# -----------------------------------------------------------------------
# 29c. The poll
# -----------------------------------------------------------------------
POLL_BODY='{"status":"23 6 0 0 0 0 0 0 0","printerMAC":"00:11:E5:06:04:FF","uniqueID":"counter","statusCode":"200%20OK","printingInProgress":false,"clientAction":null}'
pr_poll "$A_TOKEN" "$POLL_BODY"
pr_expect 200 "the printer's first poll"
[ "$(pr_body jobReady)" = "false" ] || fail "an idle printer was told a job was ready: $(cat "$PR_DIR/body")"
[ "$(pr_body clientAction.0.request)" = "Encodings" ] || fail "the first poll did not ask for the printer's encodings: $(cat "$PR_DIR/body")"
ok "a poll with no job answers jobReady false and asks once for the printer's Encodings"

A_SEEN="$(pr_super "/api/collections/printers/records/$A_ID")"
[ "$(echo "$A_SEEN" | jval last_status)" = "200 OK" ] || fail "last_status is not the decoded statusCode: $A_SEEN"
[ -n "$(echo "$A_SEEN" | jval last_poll_at)" ] || fail "last_poll_at was not recorded"
pr_staff "$STAFF_TOKEN" GET /api/vault/printers
pr_expect 200 "the printers list"
[ "$(pr_body printers.0.online)" = "true" ] || fail "a printer that just polled is not online: $(cat "$PR_DIR/body")"
[ "$(pr_body printers.0.last_status)" = "200 OK" ] || fail "the list does not carry last_status"
[ "$(pr_body printers.0.register_name)" = "Counter" ] || fail "the list does not carry the register name"
grep -q "token_hash" "$PR_DIR/body" && fail "the printers list carries token_hash"
ok "a poll records last_poll_at and the decoded last_status, and the list shows the printer online"

# The answer to the Encodings action comes back in the next poll.
pr_poll "$A_TOKEN" '{"printerMAC":"00:11:e5:06:04:ff","statusCode":"200%20OK","clientAction":[{"request":"Encodings","result":"image/png; image/jpeg; text/plain"}]}'
pr_expect 200 "the poll carrying the encodings"
[ "$(pr_super "/api/collections/printers/records/$A_ID" | jval encodings.2)" = "text/plain" ] \
  || fail "the encodings were not stored: $(pr_super "/api/collections/printers/records/$A_ID")"
pr_poll "$A_TOKEN" "$POLL_BODY"
pr_expect 200 "a poll after the encodings are known"
[ "$(pr_body jobReady)" = "false" ] || fail "an idle printer was told a job was ready"
grep -q "clientAction" "$PR_DIR/body" && fail "the printer was asked for its encodings a second time: $(cat "$PR_DIR/body")"
ok "the Encodings answer is stored and the printer is not asked again"

pr_poll "$A_TOKEN" '{"printerMAC":"00:11:e5:06:04:aa","statusCode":"200%20OK"}'
pr_expect 404 "a poll with the wrong MAC"
[ ! -s "$PR_DIR/body" ] || fail "the wrong-MAC 404 has a body: $(cat "$PR_DIR/body")"
pr_poll "$A_TOKEN" '{"statusCode":"200%20OK"}'
pr_expect 404 "a poll with no MAC"
pr_poll "abcdefghijklmnopqrstuvwxyz012345" "$POLL_BODY"
pr_expect 404 "a poll with an unknown token"
[ ! -s "$PR_DIR/body" ] || fail "the unknown-token 404 has a body"
pr_poll "short" "$POLL_BODY"
pr_expect 404 "a poll with a malformed token"
ok "a wrong MAC, no MAC or an unknown token is a bare 404 with no body"

# A firmware that sends the poll under another Content-Type is still heard.
pr_call POST "/api/vault/cloudprnt/$A_TOKEN" -H "Content-Type: text/plain" -d "$POLL_BODY"
pr_expect 200 "a poll sent as text/plain"
[ "$(pr_body jobReady)" = "false" ] || fail "the text/plain poll was not read"
ok "a poll is read from the raw body whatever Content-Type it arrives under"

# -----------------------------------------------------------------------
# 29d. Queueing a PNG, and every way it is refused
# -----------------------------------------------------------------------
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r800.png;type=image/png" -F kind=receipt -F "register=$COUNTER_ID"
pr_expect 400 "an 800 pixel image was queued on an 80 mm printer"
echo "$(pr_body message)" | grep -q "576" || fail "the width refusal does not say what width is wanted: $(cat "$PR_DIR/body")"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r384.png;type=image/png" -F kind=receipt -F "register=$COUNTER_ID"
pr_expect 400 "a 384 pixel image was queued on an 80 mm printer"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/not-a-png.png;type=image/png" -F kind=receipt -F "register=$COUNTER_ID"
pr_expect 400 "a text file was queued as a PNG"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/huge.png;type=image/png" -F kind=receipt -F "register=$COUNTER_ID"
pr_expect 400 "an image over 2 MB was queued"
echo "$(pr_body message)" | grep -q "2 MB" || fail "the size refusal does not say the limit: $(cat "$PR_DIR/body")"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" -F kind=receipt -F "register=$COUNTER_ID"
pr_expect 400 "a job with neither an image nor text was queued"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=banana -F "register=$COUNTER_ID"
pr_expect 400 "an unknown kind was queued"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=receipt -F copies=4 -F "register=$COUNTER_ID"
pr_expect 400 "four copies were queued"
pr_call POST /api/vault/print/jobs -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=receipt
pr_expect 401 "an unsigned call queued a job"
[ "$(pr_super "/api/collections/print_jobs/records?perPage=1" | jval totalItems)" = "0" ] \
  || fail "a refused job left a row behind"
ok "a wrong-width, non-PNG, oversize, empty, unknown-kind or four-copy job is refused and nothing is queued"

pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=receipt -F ref=sale_abc -F drawer=true -F copies=2
pr_expect 201 "a 576 pixel image on the default register"
J1="$(pr_body job.id)"
[ "$(pr_body job.status)" = "queued" ] || fail "a new job is not queued: $(cat "$PR_DIR/body")"
[ "$(pr_body job.kind)" = "receipt" ] && [ "$(pr_body job.ref)" = "sale_abc" ] && [ "$(pr_body job.printer)" = "$A_ID" ] \
  || fail "the job does not carry its kind, ref and printer: $(cat "$PR_DIR/body")"
[ "$(pr_body job.register)" = "$COUNTER_ID" ] || fail "the job does not carry the register"
PR_JOBS="$(pr_super "/api/collections/print_jobs/records?sort=created&filter=printer%3D%27$A_ID%27")"
[ "$(echo "$PR_JOBS" | jval totalItems)" = "2" ] || fail "two copies made $(echo "$PR_JOBS" | jval totalItems) jobs: $PR_JOBS"
[ "$(echo "$PR_JOBS" | jval items.0.drawer)" = "true" ] && [ "$(echo "$PR_JOBS" | jval items.1.drawer)" = "false" ] \
  || fail "the drawer should open on the first copy only: $PR_JOBS"
J2="$(echo "$PR_JOBS" | jval items.1.id)"
ok "a 576 pixel PNG is queued on the register's printer, and copies makes that many jobs with the drawer on the first only"

# -----------------------------------------------------------------------
# 29e. The printer collects it
# -----------------------------------------------------------------------
pr_poll "$A_TOKEN" "$POLL_BODY"
pr_expect 200 "a poll with a job waiting"
[ "$(pr_body jobReady)" = "true" ] && [ "$(pr_body mediaTypes.0)" = "image/png" ] \
  || fail "the poll does not offer the PNG: $(cat "$PR_DIR/body")"
grep -q "clientAction" "$PR_DIR/body" && fail "a client action was sent in the same answer as a job"
ok "a poll with a job waiting says jobReady with its media type, and never carries a client action"

pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=text/plain&mac=00:11:e5:06:04:ff"
pr_expect 415 "a text request for a PNG job"
[ "$(pr_super "/api/collections/print_jobs/records/$J1" | jval status)" = "queued" ] \
  || fail "an unsupported type claimed the job"
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:aa"
pr_expect 404 "a GET with the wrong MAC"
ok "a type the job is not in is 415 and claims nothing; a wrong MAC is 404"

pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 200 "the job fetch"
cp "$PR_DIR/body" "$PR_DIR/served1.png"
cmp -s "$PR_DIR/served1.png" "$PR_DIR/r576.png" || fail "the served PNG is not the PNG that was queued"
[ "$(pr_header content-type)" = "image/png" ] || fail "Content-Type is '$(pr_header content-type)'"
[ "$(pr_header x-star-cashdrawer)" = "start" ] || fail "X-Star-CashDrawer is '$(pr_header x-star-cashdrawer)', wanted start"
[ "$(pr_header x-star-cut)" = "full; feed=true" ] || fail "X-Star-Cut is '$(pr_header x-star-cut)'"
[ "$(pr_header x-star-imageditherpattern)" = "none" ] || fail "X-Star-ImageDitherPattern is '$(pr_header x-star-imageditherpattern)'"
PR_J1="$(pr_super "/api/collections/print_jobs/records/$J1")"
[ "$(echo "$PR_J1" | jval status)" = "printing" ] && [ "$(echo "$PR_J1" | jval attempts)" = "1" ] && [ -n "$(echo "$PR_J1" | jval claimed_at)" ] \
  || fail "fetching did not mark the job printing with a claim: $PR_J1"
ok "the GET serves the queued PNG byte for byte with image/png and the drawer, cut and dither headers, and marks it printing"

pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 200 "the printer fetching the same job again"
cmp -s "$PR_DIR/body" "$PR_DIR/r576.png" || fail "the second fetch served something else"
[ "$(pr_super "/api/collections/print_jobs/records/$J1" | jval attempts)" = "1" ] \
  || fail "fetching the same job twice counted as two attempts"
pr_poll "$A_TOKEN" "$POLL_BODY"
[ "$(pr_body jobReady)" = "true" ] || fail "a job that is printing is no longer offered"
ok "fetching a job again changes nothing, and a printing job is still offered until it is finished"

pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK"
pr_expect 200 "the printer's DELETE with code=OK"
PR_J1="$(pr_super "/api/collections/print_jobs/records/$J1")"
[ "$(echo "$PR_J1" | jval status)" = "done" ] && [ -n "$(echo "$PR_J1" | jval printed_at)" ] \
  || fail "code=OK did not mark the job done with printed_at: $PR_J1"
ok "DELETE with code=OK marks the job done and stamps printed_at"

# The second copy: fetched and confirmed through GET ...&delete.
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 200 "the second copy"
[ "$(pr_header x-star-cashdrawer)" = "none" ] || fail "the second copy opens the drawer too"
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK&delete"
pr_expect 200 "the GET form of the delete"
[ "$(pr_super "/api/collections/print_jobs/records/$J2" | jval status)" = "done" ] \
  || fail "GET with delete did not finish the job"
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 404 "a fetch with nothing queued"
[ ! -s "$PR_DIR/body" ] || fail "the empty-queue 404 has a body"
pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK"
pr_expect 200 "a stray DELETE with nothing in flight"
ok "a printer told deleteMethod GET can finish a job with GET ...&delete, and an empty queue is 404"

# -----------------------------------------------------------------------
# 29f. Failures requeue the job, and the third marks it failed
# -----------------------------------------------------------------------
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=gift_receipt -F "printer=$A_ID"
pr_expect 201 "queueing a job by printer id"
JF="$(pr_body job.id)"
[ "$(pr_body job.kind)" = "gift_receipt" ] || fail "the job kind was not kept"
for attempt in 1 2 3; do
  pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
  pr_expect 200 "fetch $attempt of the failing job"
  pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=PaperEmpty$attempt"
  pr_expect 200 "failure $attempt reported"
  PR_JF="$(pr_super "/api/collections/print_jobs/records/$JF")"
  [ "$(echo "$PR_JF" | jval attempts)" = "$attempt" ] || fail "attempts after failure $attempt is $(echo "$PR_JF" | jval attempts)"
  [ "$(echo "$PR_JF" | jval error)" = "PaperEmpty$attempt" ] || fail "the printer's code was not kept as the error: $PR_JF"
  if [ "$attempt" -lt 3 ]; then
    [ "$(echo "$PR_JF" | jval status)" = "queued" ] || fail "failure $attempt did not put the job back in the queue: $PR_JF"
  else
    [ "$(echo "$PR_JF" | jval status)" = "failed" ] || fail "the third failure did not mark the job failed: $PR_JF"
  fi
done
pr_poll "$A_TOKEN" "$POLL_BODY"
[ "$(pr_body jobReady)" = "false" ] || fail "a failed job is still offered to the printer"
ok "a failure code requeues the job with its error and counts attempts; the third failure marks it failed and stops it being offered"

pr_staff "$STAFF_TOKEN" POST "/api/vault/print/jobs/$JF/retry"
pr_expect 200 "retrying a failed job"
[ "$(pr_body job.status)" = "queued" ] && [ "$(pr_body job.attempts)" = "0" ] && [ -z "$(pr_body job.error)" ] \
  || fail "retry did not reset the job: $(cat "$PR_DIR/body")"
pr_staff "$STAFF_TOKEN" POST "/api/vault/print/jobs/$JF/retry"
pr_expect 409 "retrying a queued job"
pr_staff "$STAFF_TOKEN" POST "/api/vault/print/jobs/$J1/retry"
pr_expect 409 "retrying a job that already printed"
pr_staff "$STAFF_TOKEN" POST "/api/vault/print/jobs/nosuchjob00001/retry"
pr_expect 404 "retrying a job that does not exist"
ok "retry puts a failed job back with its attempts cleared and refuses a job that is queued, done or unknown"

# Finish it so the queue is clean.
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK"
[ "$(pr_super "/api/collections/print_jobs/records/$JF" | jval status)" = "done" ] || fail "the retried job did not finish"

# -----------------------------------------------------------------------
# 29g. Text jobs
# -----------------------------------------------------------------------
pr_staff "$STAFF_TOKEN" POST /api/vault/print/jobs "{\"text\":\"Test print\\nLine two\",\"kind\":\"test\",\"register\":\"$COUNTER_ID\",\"cut\":false}"
pr_expect 201 "queueing a text job"
JT="$(pr_body job.id)"
pr_poll "$A_TOKEN" "$POLL_BODY"
[ "$(pr_body mediaTypes.0)" = "text/plain" ] || fail "the poll does not offer text/plain: $(cat "$PR_DIR/body")"
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=text/plain&mac=00:11:e5:06:04:ff"
pr_expect 200 "fetching the text job"
[ "$(pr_header content-type)" = "text/plain" ] || fail "text Content-Type is '$(pr_header content-type)'"
[ "$(head -1 "$PR_DIR/body")" = "Test print" ] && [ "$(sed -n 2p "$PR_DIR/body")" = "Line two" ] || fail "the text body is wrong: $(cat "$PR_DIR/body")"
[ "$(pr_header x-star-cut)" = "none" ] || fail "cut false should send X-Star-Cut: none, got '$(pr_header x-star-cut)'"
pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK"
[ "$(pr_super "/api/collections/print_jobs/records/$JT" | jval status)" = "done" ] || fail "the text job did not finish"
ok "a JSON text job is served as text/plain with the cut header it asked for"

# -----------------------------------------------------------------------
# 29h. The drawer: a register with no printer, then both encodings paths
# -----------------------------------------------------------------------
pr_staff "$STAFF_TOKEN" POST /api/vault/print/drawer "{\"register\":\"$SPARE_ID\"}"
pr_expect 409 "the drawer on a register with no printer"
[ "$(pr_body message)" = "No receipt printer is set up for Spare. Add one under Settings, Printers." ] \
  || fail "the no-printer sentence is wrong: $(cat "$PR_DIR/body")"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=receipt -F "register=$SPARE_ID"
pr_expect 409 "a job on a register with no printer"
[ "$(pr_body message)" = "No receipt printer is set up for Spare. Add one under Settings, Printers." ] \
  || fail "the job no-printer sentence is wrong: $(cat "$PR_DIR/body")"
pr_staff "$STAFF_TOKEN" POST /api/vault/print/drawer '{"register":"nosuchregister1"}'
pr_expect 404 "the drawer on an unknown register"
ok "queueDrawerKick returns null for a register with no printer: the drawer and job routes answer 409 with the contract's sentence"

# Printer A listed no star.line, so the kick is the one-pixel PNG.
pr_staff "$STAFF_TOKEN" POST /api/vault/print/drawer '{}'
pr_expect 201 "the drawer on the default register"
JD="$(pr_body job.id)"
[ "$(pr_body job.kind)" = "drawer" ] && [ "$(pr_body job.printer)" = "$A_ID" ] || fail "the drawer job is wrong: $(cat "$PR_DIR/body")"
pr_poll "$A_TOKEN" "$POLL_BODY"
[ "$(pr_body mediaTypes.0)" = "image/png" ] || fail "a printer without star.line was offered '$(pr_body mediaTypes.0)'"
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 200 "the drawer kick fetch"
[ "$(pr_header x-star-cashdrawer)" = "start" ] || fail "the drawer kick does not open the drawer"
[ "$(pr_header x-star-cut)" = "none" ] || fail "the drawer kick cuts the paper: '$(pr_header x-star-cut)'"
node -e '
const assert = require("assert");
const fs = require("fs");
const zlib = require("zlib");
const bytes = fs.readFileSync(process.argv[1]);
assert.deepStrictEqual(Array.from(bytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.strictEqual(bytes.readUInt32BE(16), 576, "width");
assert.strictEqual(bytes.readUInt32BE(20), 1, "height");
const len = bytes.readUInt32BE(33);
assert.strictEqual(bytes.toString("latin1", 37, 41), "IDAT");
const pixels = zlib.inflateSync(bytes.subarray(41, 41 + len));
assert.strictEqual(pixels.length, 577);
assert.ok(pixels.subarray(1).every((b) => b === 255));
' "$PR_DIR/body" || fail "the drawer PNG is not a one-pixel-tall white row 576 across"
pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK"
[ "$(pr_super "/api/collections/print_jobs/records/$JD" | jval status)" = "done" ] || fail "the drawer job did not finish"
ok "a drawer kick on a printer without star.line is a one-pixel white PNG at the paper width, drawer start, no cut"

# Printer B: 58 mm paper on the Back office. Its encodings are not known
# yet, so the first kick is the PNG (384 wide); once it lists star.line the
# next one is the single drawer command.
pr_staff "$STAFF_TOKEN" POST /api/vault/printers \
  "{\"name\":\"Back printer\",\"mac\":\"00:11:e5:06:04:aa\",\"register\":\"$BACK_ID\",\"paper_width\":58}"
pr_expect 201 "adding printer B"
B_ID="$(pr_body printer.id)"
B_TOKEN="$(pr_body url)"
B_TOKEN="${B_TOKEN##*/}"
B_POLL='{"printerMAC":"00:11:e5:06:04:aa","statusCode":"200%20OK"}'

pr_staff "$STAFF_TOKEN" POST /api/vault/print/drawer "{\"register\":\"$BACK_ID\"}"
pr_expect 201 "the drawer on printer B before its encodings are known"
pr_poll "$B_TOKEN" "$B_POLL"
[ "$(pr_body jobReady)" = "true" ] && [ "$(pr_body mediaTypes.0)" = "image/png" ] \
  || fail "printer B with unknown encodings was not offered the PNG: $(cat "$PR_DIR/body")"
pr_call GET "/api/vault/cloudprnt/$B_TOKEN?uid=back&type=image/png&mac=00:11:e5:06:04:aa"
pr_expect 200 "printer B's drawer PNG"
node -e '
const bytes = require("fs").readFileSync(process.argv[1]);
if (bytes.readUInt32BE(16) !== 384 || bytes.readUInt32BE(20) !== 1) process.exit(1);
' "$PR_DIR/body" || fail "the 58 mm drawer PNG is not 384 pixels wide"
pr_call DELETE "/api/vault/cloudprnt/$B_TOKEN?uid=back&mac=00:11:e5:06:04:aa&code=OK"

pr_poll "$B_TOKEN" '{"printerMAC":"00:11:e5:06:04:aa","clientAction":[{"request":"Encodings","result":"image/png; application/vnd.star.line; text/plain"}]}'
pr_staff "$STAFF_TOKEN" POST /api/vault/print/drawer "{\"register\":\"$BACK_ID\"}"
pr_expect 201 "the drawer on printer B once it lists star.line"
JB="$(pr_body job.id)"
pr_poll "$B_TOKEN" "$B_POLL"
[ "$(pr_body mediaTypes.0)" = "application/vnd.star.line" ] \
  || fail "a printer that lists star.line was offered '$(pr_body mediaTypes.0)'"
pr_call GET "/api/vault/cloudprnt/$B_TOKEN?uid=back&type=application/vnd.star.line&mac=00:11:e5:06:04:aa"
pr_expect 200 "printer B's Star Line drawer command"
[ "$(pr_header content-type)" = "application/vnd.star.line" ] || fail "Star Line Content-Type is '$(pr_header content-type)'"
[ "$(wc -c <"$PR_DIR/body" | tr -d ' ')" = "1" ] && [ "$(od -An -tx1 "$PR_DIR/body" | tr -d ' \n')" = "07" ] \
  || fail "the Star Line drawer job is not the single drawer command (0x07): $(od -An -tx1 "$PR_DIR/body")"
pr_call DELETE "/api/vault/cloudprnt/$B_TOKEN?uid=back&mac=00:11:e5:06:04:aa&code=OK"
[ "$(pr_super "/api/collections/print_jobs/records/$JB" | jval status)" = "done" ] || fail "the Star Line job did not finish"
ok "a drawer kick on a printer that lists star.line is the single drawer command, served as application/vnd.star.line"

# The 58 mm printer takes 384 pixels and refuses 576.
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r576.png;type=image/png" -F kind=receipt -F "register=$BACK_ID"
pr_expect 400 "576 pixels on 58 mm paper"
echo "$(pr_body message)" | grep -q "384" || fail "the 58 mm refusal does not say 384: $(cat "$PR_DIR/body")"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r384.png;type=image/png" -F kind=receipt -F "register=$BACK_ID"
pr_expect 201 "384 pixels on 58 mm paper"
ok "58 mm paper takes 384 pixels and refuses 576"

# A printer that is switched off is not a register's printer.
pr_staff "$PLAIN_TOKEN" PATCH "/api/vault/printers/$B_ID" '{"active":false}'
pr_expect 403 "a plain staff member edited a printer"
pr_staff "$STAFF_TOKEN" PATCH "/api/vault/printers/$B_ID" '{"active":false}'
pr_expect 200 "switching printer B off"
pr_staff "$STAFF_TOKEN" POST /api/vault/print/drawer "{\"register\":\"$BACK_ID\"}"
pr_expect 409 "the drawer on a register whose only printer is off"
pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
  -F "file=@$PR_DIR/r384.png;type=image/png" -F kind=receipt -F "printer=$B_ID"
pr_expect 409 "a job addressed to a printer that is off"
pr_poll "$B_TOKEN" "$B_POLL"
[ "$(pr_body jobReady)" = "false" ] || fail "a printer that is switched off was offered a job"
pr_call GET "/api/vault/cloudprnt/$B_TOKEN?uid=back&type=image/png&mac=00:11:e5:06:04:aa"
pr_expect 404 "a switched-off printer fetching a job"
pr_staff "$STAFF_TOKEN" PATCH "/api/vault/printers/$B_ID" '{"active":true}'
pr_expect 200 "switching printer B back on"
ok "a printer that is switched off is nobody's printer: the drawer is 409 and it is offered nothing"

# -----------------------------------------------------------------------
# 29i. Editing: rename, the MAC clash, the audit row
# -----------------------------------------------------------------------
pr_staff "$STAFF_TOKEN" PATCH "/api/vault/printers/$B_ID" '{"name":"Back office printer","mac":"00:11:E5:06:04:FF"}'
pr_expect 409 "moving printer B onto printer A's MAC"
pr_staff "$STAFF_TOKEN" PATCH "/api/vault/printers/$B_ID" '{"name":"Back office printer"}'
pr_expect 200 "renaming printer B"
[ "$(pr_body printer.name)" = "Back office printer" ] || fail "the rename did not stick"
PR_AUDIT="$(pr_super "/api/collections/audit_log/records?sort=-created&filter=action%3D%27printer_updated%27")"
[ "$(echo "$PR_AUDIT" | jval items.0.record)" = "$B_ID" ] && [ "$(echo "$PR_AUDIT" | jval items.0.meta.fields.0)" = "name" ] \
  || fail "the rename is not audited as printer_updated with the field name: $PR_AUDIT"
pr_staff "$STAFF_TOKEN" PATCH /api/vault/printers/nosuchprinter1 '{"name":"x"}'
pr_expect 404 "editing a printer that does not exist"
ok "editing a printer is audited as printer_updated with the field names, and a MAC clash is 409"

# -----------------------------------------------------------------------
# 29j. Rotating the URL
# -----------------------------------------------------------------------
pr_staff "$PLAIN_TOKEN" POST "/api/vault/printers/$A_ID/rotate"
pr_expect 403 "a plain staff member rotated a URL"
pr_staff "$STAFF_TOKEN" POST "/api/vault/printers/$A_ID/rotate"
pr_expect 200 "rotating printer A's URL"
A_URL2="$(pr_body url)"
A_TOKEN2="${A_URL2##*/}"
[ "${#A_TOKEN2}" = "32" ] && [ "$A_TOKEN2" != "$A_TOKEN" ] || fail "rotating did not give a new 32 character token: $A_URL2"
pr_poll "$A_TOKEN" "$POLL_BODY"
pr_expect 404 "the old URL after a rotate"
[ ! -s "$PR_DIR/body" ] || fail "the old URL's 404 has a body"
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 404 "a fetch on the old URL"
pr_poll "$A_TOKEN2" "$POLL_BODY"
pr_expect 200 "the new URL after a rotate"
PR_AUDIT="$(pr_super "/api/collections/audit_log/records?filter=action%3D%27printer_rotated%27")"
[ "$(echo "$PR_AUDIT" | jval items.0.record)" = "$A_ID" ] || fail "rotating is not audited as printer_rotated: $PR_AUDIT"
echo "$PR_AUDIT" | grep -qF "$A_TOKEN2" && fail "printer_rotated carries the new token"
ok "rotating gives a new URL once, the old URL is a bare 404, and it is audited as printer_rotated"
A_TOKEN="$A_TOKEN2"

# -----------------------------------------------------------------------
# 29k. The list, online, and nothing secret in any response
# -----------------------------------------------------------------------
pr_staff "$STAFF_TOKEN" GET /api/vault/printers
pr_expect 200 "the printers list"
[ "$(pr_body printers.0.name)" = "Back office printer" ] || fail "the list is not sorted by name: $(cat "$PR_DIR/body")"
PR_ONLINE_A="$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).printers;console.log(l.find(p=>p.id===process.argv[2]).online)' "$PR_DIR/body" "$A_ID")"
[ "$PR_ONLINE_A" = "true" ] || fail "printer A polled just now but is not online"
pr_staff "$PLAIN_TOKEN" GET /api/vault/printers
pr_expect 200 "a plain staff member reading the printers list"

# Backdate A's last poll: more than 30 seconds ago is offline.
curl -s -o /dev/null -X PATCH "$BASE/api/collections/printers/records/$A_ID" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"last_poll_at":"2020-01-01 00:00:00.000Z"}'
pr_staff "$STAFF_TOKEN" GET /api/vault/printers
PR_ONLINE_A="$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).printers;console.log(l.find(p=>p.id===process.argv[2]).online)' "$PR_DIR/body" "$A_ID")"
[ "$PR_ONLINE_A" = "false" ] || fail "a printer that last polled in 2020 is online"
pr_poll "$A_TOKEN" "$POLL_BODY"
pr_staff "$STAFF_TOKEN" GET /api/vault/printers
PR_ONLINE_A="$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).printers;console.log(l.find(p=>p.id===process.argv[2]).online)' "$PR_DIR/body" "$A_ID")"
[ "$PR_ONLINE_A" = "true" ] || fail "a poll did not bring the printer back online"
ok "online means polled in the last 30 seconds: a stale poll reads offline and a fresh one online"

# The collection API: staff can list and view, never see the hash, never write.
PR_COLL="$(curl -s "$BASE/api/collections/printers/records" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$PR_COLL" | jval totalItems)" = "2" ] || fail "staff cannot list printers through the collection API: $PR_COLL"
echo "$PR_COLL" | grep -q "token_hash" && fail "the collection API lists token_hash to staff"
PR_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/collections/printers/records/$A_ID" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" -d '{"name":"Hacked"}')"
[ "$PR_CODE" = "403" ] || fail "a staff token wrote a printer through the collection API ($PR_CODE)"
PR_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/print_jobs/records" \
  -H "Authorization: $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"printer\":\"$A_ID\",\"kind\":\"receipt\",\"format\":\"text/plain\",\"status\":\"queued\"}")"
[ "$PR_CODE" = "403" ] || fail "a staff token created a print job through the collection API ($PR_CODE)"
PR_JOBVIEW="$(curl -s "$BASE/api/collections/print_jobs/records/$J1" -H "Authorization: $STAFF_TOKEN")"
[ "$(echo "$PR_JOBVIEW" | jval id)" = "$J1" ] || fail "staff cannot view a print job: $PR_JOBVIEW"
ok "staff can list and view printers and jobs through the collection API, without token_hash, and cannot write either"

# The job list route, filtered.
pr_staff "$STAFF_TOKEN" GET "/api/vault/print/jobs?register=$COUNTER_ID&status=done&per_page=2"
pr_expect 200 "the job list"
[ "$(pr_body per_page)" = "2" ] && [ "$(pr_body page)" = "1" ] || fail "the job list does not echo its paging: $(cat "$PR_DIR/body")"
PR_DONE_TOTAL="$(pr_body total)"
[ "$PR_DONE_TOTAL" -ge 4 ] || fail "the job list counts $PR_DONE_TOTAL done jobs on the Counter, wanted at least 4"
[ "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).items.length)' "$PR_DIR/body")" = "2" ] \
  || fail "per_page 2 did not return two jobs"
pr_staff "$STAFF_TOKEN" GET "/api/vault/print/jobs?status=sideways"
pr_expect 400 "an unknown status filter"
pr_call GET "/api/vault/print/jobs"
pr_expect 401 "the job list without a token"
grep -q "token_hash" "$PR_DIR/body" && fail "the job list carries token_hash"
ok "the job list filters by register and status, pages, and needs a token"

# -----------------------------------------------------------------------
# 29l. The tidy cron: stuck jobs, and old files
# -----------------------------------------------------------------------
PR_COLL_ID="$(pr_super "/api/collections/print_jobs" | jval id)"
make_job() { # make_job <file> -> prints the new job id
  pr_call POST /api/vault/print/jobs -H "Authorization: $STAFF_TOKEN" \
    -F "file=@$PR_DIR/$1;type=image/png" -F kind=receipt -F "printer=$A_ID"
  pr_body job.id
}
JS1="$(make_job r576.png)"
JS2="$(make_job r576.png)"
JS3="$(make_job r576.png)"
# S1: printing for ten minutes on its first try; S2: printing on its third; S3: done eight days ago.
curl -s -o /dev/null -X PATCH "$BASE/api/collections/print_jobs/records/$JS1" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"status":"printing","attempts":1,"claimed_at":"2020-01-01 00:10:00.000Z"}'
curl -s -o /dev/null -X PATCH "$BASE/api/collections/print_jobs/records/$JS2" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"status":"printing","attempts":3,"claimed_at":"2020-01-01 00:10:00.000Z"}'
curl -s -o /dev/null -X PATCH "$BASE/api/collections/print_jobs/records/$JS3" -H "Authorization: $SUPER_TOKEN" \
  -H "Content-Type: application/json" -d '{"status":"done","attempts":1,"printed_at":"2020-01-01 00:10:00.000Z"}'
PR_FILE3="$(pr_super "/api/collections/print_jobs/records/$JS3" | jval file)"
[ -n "$PR_FILE3" ] && [ -f "$TMP_DIR/storage/$PR_COLL_ID/$JS3/$PR_FILE3" ] || fail "the job under test has no file on disk to clear"

PR_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/print_jobs_tidy" -H "Authorization: $SUPER_TOKEN")"
[ "$PR_CODE" = "204" ] || fail "could not run the print_jobs_tidy cron ($PR_CODE)"
# The cron runs in the background; give it a moment to finish.
for _ in $(seq 1 50); do
  [ "$(pr_super "/api/collections/print_jobs/records/$JS1" | jval status)" = "queued" ] && break
  sleep 0.2
done
PR_S1="$(pr_super "/api/collections/print_jobs/records/$JS1")"
PR_S2="$(pr_super "/api/collections/print_jobs/records/$JS2")"
PR_S3="$(pr_super "/api/collections/print_jobs/records/$JS3")"
[ "$(echo "$PR_S1" | jval status)" = "queued" ] || fail "a job printing for over two minutes was not put back: $PR_S1"
[ "$(echo "$PR_S2" | jval status)" = "failed" ] || fail "a stuck job on its third try was not marked failed: $PR_S2"
[ "$(echo "$PR_S3" | jval status)" = "done" ] || fail "the tidy pass changed a finished job's status: $PR_S3"
[ -z "$(echo "$PR_S3" | jval file)" ] || fail "a job done over seven days ago still has its file field: $PR_S3"
[ ! -e "$TMP_DIR/storage/$PR_COLL_ID/$JS3/$PR_FILE3" ] || fail "the PNG of a job done over seven days ago is still on disk"
ok "the print_jobs_tidy cron requeues a stuck job (failing it on the third try) and deletes the PNG of a job done over seven days ago"

# A job that was claimed a moment ago is left alone: S1 is back in the queue
# and is the oldest, so this fetch takes it.
pr_call GET "/api/vault/cloudprnt/$A_TOKEN?uid=counter&type=image/png&mac=00:11:e5:06:04:ff"
pr_expect 200 "fetching the requeued job"
PR_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/crons/print_jobs_tidy" -H "Authorization: $SUPER_TOKEN")"
[ "$PR_CODE" = "204" ] || fail "could not run the print_jobs_tidy cron again ($PR_CODE)"
sleep 1
[ "$(pr_super "/api/collections/print_jobs/records/$JS1" | jval status)" = "printing" ] \
  || fail "the tidy pass touched a job that was claimed a moment ago"
# Finish it so nothing is left in A's queue.
pr_call DELETE "/api/vault/cloudprnt/$A_TOKEN?uid=counter&mac=00:11:e5:06:04:ff&code=OK"
[ "$(pr_super "/api/collections/print_jobs/records/$JS1" | jval status)" = "done" ] || fail "the requeued job did not finish"
ok "a job claimed a moment ago is not reclaimed by the tidy pass"

# -----------------------------------------------------------------------
# 29m. The rate limit on the printer's path, and removing a printer
# -----------------------------------------------------------------------
PR_SETTINGS="$(pr_super "/api/settings")"
echo "$PR_SETTINGS" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  const s = JSON.parse(d).rateLimits;
  const rule = (s.rules || []).find((r) => r.label === "/api/vault/cloudprnt/");
  if (!s.enabled || !rule || rule.maxRequests !== 120 || rule.duration !== 60) process.exit(1);
});' || fail "the cloudprnt prefix is not rate limited at 120 a minute: $PR_SETTINGS"
ok "the printer's path is rate limited at 120 requests a minute"

pr_staff "$PLAIN_TOKEN" DELETE "/api/vault/printers/$B_ID"
pr_expect 403 "a plain staff member removed a printer"
pr_staff "$STAFF_TOKEN" DELETE "/api/vault/printers/$B_ID"
pr_expect 204 "removing printer B"
pr_poll "$B_TOKEN" "$B_POLL"
pr_expect 404 "printer B polling after it was removed"
pr_staff "$STAFF_TOKEN" GET /api/vault/printers
PR_COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).printers.length)' "$PR_DIR/body")"
[ "$PR_COUNT" = "1" ] || fail "the removed printer is still listed: $(cat "$PR_DIR/body")"
[ "$(pr_super "/api/collections/print_jobs/records?filter=printer%3D%27$B_ID%27" | jval totalItems)" = "0" ] \
  || fail "the removed printer's jobs were left behind"
PR_AUDIT="$(pr_super "/api/collections/audit_log/records?filter=action%3D%27printer_removed%27")"
[ "$(echo "$PR_AUDIT" | jval items.0.record)" = "$B_ID" ] && [ "$(echo "$PR_AUDIT" | jval items.0.meta.name)" = "Back office printer" ] \
  || fail "removing is not audited as printer_removed: $PR_AUDIT"
pr_staff "$STAFF_TOKEN" DELETE "/api/vault/printers/$B_ID"
pr_expect 404 "removing a printer twice"
ok "removing a printer is admin only, takes its URL and jobs with it, and is audited as printer_removed"

# -----------------------------------------------------------------------
# 29n. No response ever carried a hash, and only the add and rotate
# responses carried a token
# -----------------------------------------------------------------------
if grep -q "token_hash" "$PR_DIR/all-responses.log"; then
  fail "a response carried token_hash"
fi
PR_LEAKS="$(grep -cF "$B_TOKEN" "$PR_DIR/all-responses.log" || true)"
# B's URL appears once, in the response that added it.
[ "$PR_LEAKS" = "1" ] || fail "printer B's token appears in $PR_LEAKS responses, wanted exactly the one that created it"
PR_LEAKS="$(grep -cF "$A_TOKEN2" "$PR_DIR/all-responses.log" || true)"
[ "$PR_LEAKS" = "1" ] || fail "printer A's rotated token appears in $PR_LEAKS responses, wanted exactly the rotate response"
ok "token_hash is in no response, and a URL token appears only in the response that created it"
