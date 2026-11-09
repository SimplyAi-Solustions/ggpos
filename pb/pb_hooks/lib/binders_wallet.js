/**
 * Wallet QR tokens for the My Vault wallet card.
 *
 * A token is "GGW1.<base64url payload>.<hex hmac-sha256>": the payload is
 * {c: customer id, e: expiry epoch seconds, n: nonce} and nothing else - no
 * name, no email, no balance. The customer side mints one every minute and
 * it dies after two, so a screenshot is worthless within minutes. The staff
 * scanner (Gandalf's, later) verifies with the same shared secret from the
 * wallet_keys collection.
 *
 * The hmac and compare functions are injected so the same code runs under
 * goja ($security.hs256, $security.equal) and under node for the tests
 * (pb/scripts/binders_wallet.test.cjs).
 */

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url of an ASCII string (the payload JSON is ASCII by design). */
function b64urlEncode(s) {
  var out = "";
  for (var i = 0; i < s.length; i += 3) {
    var a = s.charCodeAt(i);
    var b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    var c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    out += B64.charAt(a >> 2);
    out += B64.charAt(((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4));
    if (!isNaN(b)) out += B64.charAt(((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6));
    if (!isNaN(c)) out += B64.charAt(c & 63);
  }
  return out;
}

function b64urlDecode(s) {
  var out = "";
  var bits = 0;
  var have = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64.indexOf(s.charAt(i));
    if (v < 0) return null;
    bits = (bits << 6) | v;
    have += 6;
    if (have >= 8) {
      have -= 8;
      out += String.fromCharCode((bits >> have) & 255);
    }
  }
  return out;
}

var PREFIX = "GGW1";
var TTL_SECONDS = 120;

/**
 * Signs a wallet token for one customer. `hs256(data, key)` must return the
 * hex HMAC-SHA256 of data; `nonce` keeps two tokens in the same second
 * different.
 */
function signWalletToken(customerId, nowSeconds, secret, hs256, nonce) {
  var payload = JSON.stringify({
    c: String(customerId),
    e: Math.floor(nowSeconds) + TTL_SECONDS,
    n: String(nonce || ""),
  });
  var body = PREFIX + "." + b64urlEncode(payload);
  return body + "." + hs256(body, secret);
}

/**
 * Verifies a wallet token: shape, signature, expiry. Returns
 * {customer, expires} or null. `equal(a, b)` must be a constant-time string
 * compare.
 */
function verifyWalletToken(token, nowSeconds, secret, hs256, equal) {
  if (typeof token !== "string" || token.length > 400) return null;
  var parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  var body = parts[0] + "." + parts[1];
  if (!equal(hs256(body, secret), parts[2])) return null;
  var raw = b64urlDecode(parts[1]);
  if (!raw) return null;
  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.c !== "string" || !payload.c) return null;
  if (typeof payload.e !== "number" || Math.floor(nowSeconds) >= payload.e) return null;
  return { customer: payload.c, expires: payload.e };
}

/** True when a mirror row's balance is too old for the wallet to show. */
function balanceIsStale(balanceAtIso, nowMs, maxAgeHours) {
  if (!balanceAtIso) return true;
  var at = Date.parse(String(balanceAtIso).replace(" ", "T"));
  if (isNaN(at)) return true;
  return nowMs - at > (maxAgeHours || 24) * 3600 * 1000;
}

module.exports = {
  PREFIX: PREFIX,
  TTL_SECONDS: TTL_SECONDS,
  b64urlEncode: b64urlEncode,
  b64urlDecode: b64urlDecode,
  signWalletToken: signWalletToken,
  verifyWalletToken: verifyWalletToken,
  balanceIsStale: balanceIsStale,
};
