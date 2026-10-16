/**
 * Base64 for the hooks runtime.
 *
 * PocketBase's goja runtime has no atob/btoa and no base64 binding (only
 * toString/toBytes, which are raw byte conversions), so the signature data
 * URL on a buy-in carries its own codec. Both directions work on plain
 * arrays of byte values, which is what toBytes() returns and what
 * $filesystem.fileFromBytes() accepts.
 *
 * ID photos do NOT come through here any more: $security.encrypt takes an
 * Array<number> directly and $security.decrypt's result goes back to bytes
 * with toBytes(), so a photo is never turned into a string at all (see
 * idphotos.pb.js).
 *
 * Both directions are linear. The previous encode() built its result with
 * `out += ...` one character at a time, which goja turns into a fresh
 * string allocation per character: 200 KB took about 15 seconds. Everything
 * here now accumulates into an array and joins once, and the decode lookup
 * is an array indexed by character code rather than an object keyed by a
 * one-character string, so neither direction allocates per byte.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Character code to 6-bit value; -1 for anything outside the alphabet. */
var LOOKUP = [];
for (var slot = 0; slot < 128; slot++) LOOKUP.push(-1);
for (var i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/**
 * Copy a value that behaves like a byte array (a Go []byte handed over by
 * toBytes(), or a plain JS array) into a real JS array of numbers.
 */
function toByteArray(bytes) {
  var out = [];
  var length = bytes.length;
  for (var n = 0; n < length; n++) out.push(bytes[n] & 0xff);
  return out;
}

/** Bytes to a standard, padded base64 string. */
function encode(bytes) {
  var b = toByteArray(bytes);
  var parts = [];
  for (var n = 0; n < b.length; n += 3) {
    var b0 = b[n];
    var b1 = n + 1 < b.length ? b[n + 1] : 0;
    var b2 = n + 2 < b.length ? b[n + 2] : 0;
    parts.push(ALPHABET.charAt(b0 >> 2));
    parts.push(ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4)));
    parts.push(n + 1 < b.length ? ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=");
    parts.push(n + 2 < b.length ? ALPHABET.charAt(b2 & 63) : "=");
  }
  return parts.join("");
}

/**
 * A padded or unpadded base64 string to an array of byte values. Anything
 * outside the alphabet (newlines from a wrapped payload, the "=" padding)
 * is skipped rather than rejected.
 */
function decode(text) {
  var out = [];
  var buffer = 0;
  var bits = 0;
  for (var n = 0; n < text.length; n++) {
    var code = text.charCodeAt(n);
    var value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * Split a data URL ("data:image/png;base64,iVBOR...") into its MIME type
 * and decoded bytes. Returns null when the input is not a base64 data URL.
 */
function fromDataUrl(value) {
  if (!value || typeof value !== "string") return null;
  var match = /^data:([^;,]*)(;[^,]*)?;base64,([\s\S]*)$/.exec(value);
  if (!match) return null;
  return { mime: match[1] || "application/octet-stream", bytes: decode(match[3]) };
}

module.exports = {
  encode: encode,
  decode: decode,
  fromDataUrl: fromDataUrl,
  toByteArray: toByteArray,
};
