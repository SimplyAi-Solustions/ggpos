/**
 * Remote quotes: the photo sniffing, date formatting and line-total maths
 * behind quotes.pb.js. Kept out of that file per CLAUDE.md's "keep hooks
 * small".
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Four bytes at `at` as lower-case ASCII, or "" past the end. */
function tag(bytes, at) {
  if (bytes.length < at + 4) return "";
  var out = "";
  for (var i = at; i < at + 4; i++) out += String.fromCharCode(bytes[i] & 0xff);
  return out.toLowerCase();
}

/**
 * The real MIME type of a quote photo upload, sniffed from its first bytes
 * - never a client-supplied Content-Type or file extension, the same
 * reasoning idphotos.pb.js's own sniffMime uses for ID photos. Only the
 * three types quotes.photos actually accepts (docs/PLAN.md's data model);
 * "" for anything else, including the HEIC/HEIF forms the ID photo route
 * accepts, since a customer's own phone photo upload here is expected to
 * already be one of these three (the same constraint the file field itself
 * declares).
 */
function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return "";
  var b = bytes;
  if ((b[0] & 0xff) === 0xff && (b[1] & 0xff) === 0xd8 && (b[2] & 0xff) === 0xff) return "image/jpeg";
  if ((b[0] & 0xff) === 0x89 && (b[1] & 0xff) === 0x50 && (b[2] & 0xff) === 0x4e && (b[3] & 0xff) === 0x47) {
    return "image/png";
  }
  if (tag(b, 0) === "riff" && tag(b, 8) === "webp") return "image/webp";
  return "";
}

var EXT_FOR_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** A short random file name for a re-wrapped upload, extension from its sniffed mime. */
function photoFileName(mime) {
  return `quote-${$security.randomString(12)}.${EXT_FOR_MIME[mime] || "jpg"}`;
}

/** "27 Sep 2026" - day, short month, year. UTC, matching lib/receipts.js's
 * own ukDate on treating a stored UTC instant as the display date. */
function ukDateShort(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** settings.quote_expiry_days from now, or a 14-day fallback for an
 * unseeded settings row. */
function offerExpiry(app, settingsRow, from) {
  var days = settingsRow ? settingsRow.getInt("quote_expiry_days") : 0;
  if (!(days > 0)) days = 14;
  return new Date(from.getTime() + days * 86400000);
}

/**
 * Validate and normalise POST /api/vault/quotes/:id/offer's `lines` into
 * the shape quotes.lines stores, recomputing offer_total server-side (the
 * brief: "recomputed server-side", never trusted from the request).
 * Returns `{ok:false,message}` on the first bad line, or
 * `{ok:true,lines,offerTotal}`.
 */
function normalizeOfferLines(util, rawLines) {
  if (!rawLines || !rawLines.length) {
    return { ok: false, message: "Add at least one line before making an offer." };
  }
  var lines = [];
  var offerTotal = 0;
  for (var i = 0; i < rawLines.length; i++) {
    var raw = rawLines[i] || {};
    var title = util.asStr(raw.title);
    var card = util.asStr(raw.card);
    var retroTitle = util.asStr(raw.retro_title);
    if (!title && !card && !retroTitle) {
      return { ok: false, message: `Line ${i + 1} needs a card, a retro title, or a plain title.` };
    }
    var qty = util.asInt(raw.qty, 1);
    if (qty < 1) {
      return { ok: false, message: `Line ${i + 1}'s quantity must be at least 1.` };
    }
    var marketPrice = util.asInt(raw.market_price, 0);
    var offerPrice = util.asInt(raw.offer_price, -1);
    if (marketPrice < 0 || offerPrice < 0) {
      return { ok: false, message: `Line ${i + 1}'s prices must be in pence, zero or more.` };
    }
    var line = {
      card: card,
      retro_title: retroTitle,
      title: title,
      condition: util.asStr(raw.condition),
      finish: util.asStr(raw.finish),
      qty: qty,
      market_price: marketPrice,
      market_source: util.asStr(raw.market_source),
      offer_price: offerPrice,
    };
    lines.push(line);
    offerTotal += offerPrice * qty;
  }
  return { ok: true, lines: lines, offerTotal: offerTotal };
}

module.exports = {
  sniffImageMime: sniffImageMime,
  photoFileName: photoFileName,
  ukDateShort: ukDateShort,
  offerExpiry: offerExpiry,
  normalizeOfferLines: normalizeOfferLines,
};
