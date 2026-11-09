/* Wallet token tests for pb/pb_hooks/lib/binders_wallet.js. Run: node --test pb/scripts/binders_wallet.test.cjs */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");

const W = require(path.join(__dirname, "../pb_hooks/lib/binders_wallet.js"));

// The same primitives the hook gets from PocketBase: hex HMAC-SHA256 and a
// constant-time compare.
const hs256 = (data, key) => crypto.createHmac("sha256", key).update(data).digest("hex");
const equal = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

const SECRET = "test-secret-please-ignore";
const NOW = 1_790_000_000;

test("a signed token verifies and carries the customer and a 2 minute expiry", () => {
  const token = W.signWalletToken("cust123", NOW, SECRET, hs256, "n1");
  assert.ok(token.startsWith("GGW1."));
  const got = W.verifyWalletToken(token, NOW, SECRET, hs256, equal);
  assert.ok(got);
  assert.equal(got.customer, "cust123");
  assert.equal(got.expires, NOW + W.TTL_SECONDS);
  assert.equal(W.TTL_SECONDS, 120);
});

test("the token dies at two minutes and not before", () => {
  const token = W.signWalletToken("cust123", NOW, SECRET, hs256, "n2");
  assert.ok(W.verifyWalletToken(token, NOW + 119, SECRET, hs256, equal));
  assert.equal(W.verifyWalletToken(token, NOW + 120, SECRET, hs256, equal), null);
  assert.equal(W.verifyWalletToken(token, NOW + 10_000, SECRET, hs256, equal), null);
});

test("tampering with any part kills it", () => {
  const token = W.signWalletToken("cust123", NOW, SECRET, hs256, "n3");
  const [prefix, payload, sig] = token.split(".");
  // another customer id under the same signature
  const forged = W.signWalletToken("victim99", NOW, SECRET, hs256, "n3").split(".")[1];
  assert.equal(W.verifyWalletToken(`${prefix}.${forged}.${sig}`, NOW, SECRET, hs256, equal), null);
  // wrong secret
  assert.equal(W.verifyWalletToken(token, NOW, "other-secret", hs256, equal), null);
  // clipped signature, wrong prefix, rubbish
  assert.equal(W.verifyWalletToken(`${prefix}.${payload}.${sig.slice(0, -2)}`, NOW, SECRET, hs256, equal), null);
  assert.equal(W.verifyWalletToken(`GGW9.${payload}.${sig}`, NOW, SECRET, hs256, equal), null);
  assert.equal(W.verifyWalletToken("", NOW, SECRET, hs256, equal), null);
  assert.equal(W.verifyWalletToken("a.b", NOW, SECRET, hs256, equal), null);
});

test("the payload carries no personal data, only the record id, expiry and nonce", () => {
  const token = W.signWalletToken("cust123", NOW, SECRET, hs256, "n4");
  const payload = JSON.parse(W.b64urlDecode(token.split(".")[1]));
  assert.deepEqual(Object.keys(payload).sort(), ["c", "e", "n"]);
});

test("base64url round-trips the payload alphabet", () => {
  const s = JSON.stringify({ c: "abc_XYZ-09", e: 123, n: "Zz9" });
  assert.equal(W.b64urlDecode(W.b64urlEncode(s)), s);
  assert.equal(W.b64urlDecode("not base64!!"), null);
});

test("balanceIsStale: missing, unparsable or older than a day", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(W.balanceIsStale("", now, 24), true);
  assert.equal(W.balanceIsStale("rubbish", now, 24), true);
  assert.equal(W.balanceIsStale("2026-11-09 11:00:00.000Z", now, 24), false);
  assert.equal(W.balanceIsStale("2026-11-08 11:59:00.000Z", now, 24), true);
});
