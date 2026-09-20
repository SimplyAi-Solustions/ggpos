/**
 * Base64 for the hooks runtime.
 *
 * PocketBase's goja runtime has no atob/btoa and no base64 binding (only
 * toString/toBytes, which are raw byte conversions), so the ID photo and
 * signature routes carry their own codec. Both directions work on plain
 * arrays of byte values, which is what toBytes() returns and what
 * $filesystem.fileFromBytes() accepts.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse lookup, built once per module load. */
var LOOKUP = {};
for (var i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;

/**
 * Copy a value that behaves like a byte array (a Go []byte handed over by
 * toBytes(), or a plain JS array) into a real JS array of numbers.
 */
function toByteArray(bytes) {
  var out = [];
  var length = bytes.length;
  for (var i = 0; i < length; i++) out.push(bytes[i] & 0xff);
  return out;
}

/** Bytes to a standard, padded base64 string. */
function encode(bytes) {
  var b = toByteArray(bytes);
  var out = "";
  for (var i = 0; i < b.length; i += 3) {
    var b0 = b[i];
    var b1 = i + 1 < b.length ? b[i + 1] : 0;
    var b2 = i + 2 < b.length ? b[i + 2] : 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += i + 1 < b.length ? ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
    out += i + 2 < b.length ? ALPHABET.charAt(b2 & 63) : "=";
  }
  return out;
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
  for (var i = 0; i < text.length; i++) {
    var value = LOOKUP[text.charAt(i)];
    if (value === undefined) continue;
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
