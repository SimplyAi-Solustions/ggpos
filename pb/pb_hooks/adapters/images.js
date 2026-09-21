// Re-hosting artwork into PocketBase, so labels, receipts and the retro
// title picker never depend on a third party still hosting the same URL
// (docs/PLAN.md, "Card images and market prices": "a local copy saved when
// an item is created").
//
// Three ways in, all through the same validated, sniffed path:
//  - lookup.pb.js calls cacheImageBytes() immediately for a source that
//    forbids hotlinking (YGOPRODeck, OPTCG - hotlinking gets IPs banned),
//    with bytes the adapter already fetched itself through the overridable
//    http() transport, so the bare provider URL is never even written to
//    `cards.image_small` / `.image_large` transiently.
//  - lookup.pb.js's retro route calls cacheImageFromUrl() for an IGDB
//    cover the first time a title is seen (IGDB allows hotlinking, but
//    `retro_titles.cover` is a PocketBase file field either way).
//  - The image queue (enqueueImageCache() from items.pb.js's
//    onRecordCreate, drained by crons.pb.js's "image_queue" cron) calls
//    cacheImageFromUrl() lazily for TCGdex/Scryfall/Lorcast images, the
//    first time an item is created against a card whose image is still a
//    bare third-party URL. Never inline in the create itself - a slow or
//    unreachable image host must never hold open whatever transaction
//    created the item (docs/PLAN.md; a buy-in creates its items inside one
//    $app.runInTransaction, so a hook that runs during that create shares
//    its txApp, and a network call there would stall every other writer
//    until it times out).
//
// Every fetched image is capped at 2 MB and sniffed from its own first
// bytes the same way idphotos.pb.js sniffs an ID photo - never trusted
// from a Content-Type header or a URL's own extension alone, and never
// larger than this shop ever needs to print.
//
// This module is goja-only (it needs $filesystem, $app.settings() and
// $os.readFile, which do not exist under plain Node), unlike the adapters
// themselves. Nothing in here throws: every caller's own failure must not
// block the request it came from (an item create, a lookup, a cron run).
"use strict";

var MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB
var DEFAULT_TIMEOUT_SECONDS = 15;

/** Four bytes at `at` as lower-case ASCII, or "" when they run past the end - same helper idphotos.pb.js uses. */
function tag(bytes, at) {
  if (bytes.length < at + 4) return "";
  var out = "";
  for (var i = at; i < at + 4; i++) out += String.fromCharCode(bytes[i] & 0xff);
  return out.toLowerCase();
}

/**
 * The real MIME type of an image, from its first bytes - the same
 * sniffing idphotos.pb.js does for an ID photo, plus AVIF (Lorcast's
 * format). Returns "" for anything that is not one of the four image
 * types cards.image_file / retro_titles.cover accept.
 */
function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return "";
  var b = bytes;
  if ((b[0] & 0xff) === 0xff && (b[1] & 0xff) === 0xd8 && (b[2] & 0xff) === 0xff) return "image/jpeg";
  if ((b[0] & 0xff) === 0x89 && (b[1] & 0xff) === 0x50 && (b[2] & 0xff) === 0x4e && (b[3] & 0xff) === 0x47) {
    return "image/png";
  }
  if (tag(b, 0) === "riff" && tag(b, 8) === "webp") return "image/webp";
  if (tag(b, 4) === "ftyp") {
    var brand = tag(b, 8);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return "";
}

/** Byte length, size cap, and sniffed type all in one place - shared by both entry points below. */
function validateImageBytes(bytes) {
  if (!bytes || !bytes.length) return { ok: false, reason: "empty response" };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `over the ${MAX_IMAGE_BYTES} byte cap (was ${bytes.length})` };
  }
  var mime = sniffImageMime(bytes);
  if (!mime) return { ok: false, reason: "not a recognised image format" };
  return { ok: true, mime: mime };
}

/** A filename with the right extension for `mime`, so the stored file at least looks like what it is. */
function filenameFor(prefix, mime) {
  var ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[mime] || "img";
  return prefix + "." + ext;
}

/** True for an http(s) URL that is not already one of our own file URLs. */
function isBareRemoteUrl(app, url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    var appUrl = app.settings().meta.appURL || "";
    if (appUrl && url.indexOf(appUrl) === 0) return false;
  } catch (err) {
    // No settings available (e.g. a throwaway test app) - fall through and
    // treat the URL as remote, which is the safe default.
  }
  return true;
}

/** The public URL PocketBase serves `filename` at, off `record`. */
function publicFileUrl(app, record, filename) {
  var appUrl = "";
  try {
    appUrl = app.settings().meta.appURL || "";
  } catch (err) {
    appUrl = "";
  }
  return appUrl + "/api/files/" + record.baseFilesPath() + "/" + filename;
}

/** Common tail: store validated `bytes` on `record[fieldName]`, then point `urlFields` at the resulting local URL. */
function storeValidatedBytes(app, record, fieldName, urlFields, bytes, filenamePrefix) {
  var check = validateImageBytes(bytes);
  if (!check.ok) {
    console.log(`[adapters/images] refused an image for ${record.id || "(unsaved)"}.${fieldName}: ${check.reason}`);
    return false;
  }
  try {
    var file = $filesystem.fileFromBytes(bytes, filenameFor(filenamePrefix, check.mime));
    record.set(fieldName, file);
    app.save(record); // needs an id (and the file written) before baseFilesPath() means anything
    var stored = record.get(fieldName);
    var filename = Array.isArray(stored) ? stored[0] : stored;
    if (!filename) return false;
    var localUrl = publicFileUrl(app, record, filename);
    for (var i = 0; i < urlFields.length; i++) record.set(urlFields[i], localUrl);
    if (urlFields.length) app.save(record);
    return true;
  } catch (err) {
    console.log(`[adapters/images] could not store an image for ${record.id}.${fieldName}: ${err}`);
    return false;
  }
}

/**
 * Fetch `url` through the overridable http() transport (never
 * $filesystem.fileFromURL directly - that gives no chance to check the
 * size or sniff the bytes before they are already stored), validate it,
 * and store it on `record[fieldName]`, pointing `urlFields` (e.g.
 * `["image_small", "image_large"]`, or `[]` for a plain file field like
 * `retro_titles.cover` with no URL sibling) at the result. Returns true on
 * success, false on any failure - never throws.
 */
function cacheImageFromUrl(app, record, fieldName, urlFields, url, timeoutSeconds) {
  if (!url) return false;
  try {
    var http = require(__hooks + "/adapters/http.js");
    var res = http.request({ url: url, method: "GET", timeoutSeconds: timeoutSeconds || DEFAULT_TIMEOUT_SECONDS });
    if (res.statusCode !== 200) {
      console.log(`[adapters/images] ${res.statusCode} fetching an image for ${record.id}: ${http.stripQuery(url)}`);
      return false;
    }
    return storeValidatedBytes(app, record, fieldName, urlFields, res.body, fieldName);
  } catch (err) {
    console.log(`[adapters/images] could not fetch an image for ${record.id}: ${err}`);
    return false;
  }
}

/**
 * Store bytes the caller already fetched (YGOPRODeck, OPTCG: their
 * getImage()/getBySetNumber() fetch through the overridable http()
 * transport so they stay testable under plain Node, then hand the raw
 * bytes here). Always `cards.image_file`, since only cards re-host bytes
 * this way today. Returns true on success, false on any failure.
 */
function cacheImageBytes(app, record, bytes, filenameHint) {
  return storeValidatedBytes(app, record, "image_file", ["image_small", "image_large"], bytes, "card");
}

/**
 * Opportunistic lazy cache for a card whose image is still a bare
 * third-party URL. Drained by crons.pb.js's "image_queue" cron - see
 * enqueueImageCache() below for why an item-create hook only ever queues,
 * never fetches.
 */
function ensureCardImageCached(app, cardId, timeoutSeconds) {
  if (!cardId) return false;
  var card = null;
  try {
    card = app.findRecordById("cards", cardId);
  } catch (err) {
    return false;
  }
  var candidate = card.getString("image_large") || card.getString("image_small");
  if (!isBareRemoteUrl(app, candidate)) return false;
  return cacheImageFromUrl(app, card, "image_file", ["image_small", "image_large"], candidate, timeoutSeconds);
}

/**
 * Record-only: items.pb.js's onRecordCreate calls this instead of fetching
 * anything itself. `e.app` there can be a transaction's own txApp (a buy-in
 * creates every item inside one $app.runInTransaction), so a network call
 * at that point would hold the whole transaction open for as long as the
 * image host takes to answer - a slow or unreachable host would then time
 * out the buy-in itself. Queueing is a single fast, local write; the
 * network call happens later, off the create path entirely, when the
 * "image_queue" cron drains it.
 */
function enqueueImageCache(app, cardId) {
  if (!cardId) return;
  try {
    var statestore = require(__hooks + "/adapters/statestore.js");
    var store = statestore.forApp(app);
    var queue = store.get("image_queue") || [];
    if (queue.indexOf(cardId) < 0) {
      queue.push(cardId);
      store.set("image_queue", queue, "");
    }
  } catch (err) {
    console.log(`[adapters/images] could not queue an image cache for card ${cardId}: ${err}`);
  }
}

/**
 * Drains the whole "image_queue" adapter_state entry, once: each card gets
 * one attempt with a short per-image timeout, and the queue is cleared
 * regardless of outcome (a URL that keeps failing is not worth retrying
 * every five minutes forever - the lazy cache tries again on the next item
 * create against that same card anyway).
 */
function drainImageQueue(app, timeoutSeconds) {
  var statestore = require(__hooks + "/adapters/statestore.js");
  var store = statestore.forApp(app);
  var queue = store.get("image_queue") || [];
  var cached = 0;
  for (var i = 0; i < queue.length; i++) {
    try {
      if (ensureCardImageCached(app, queue[i], timeoutSeconds)) cached += 1;
    } catch (err) {
      console.log(`[adapters/images] queue drain failed for card ${queue[i]}: ${err}`);
    }
  }
  if (queue.length) store.set("image_queue", [], "");
  return { processed: queue.length, cached: cached };
}

module.exports = {
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  sniffImageMime: sniffImageMime,
  validateImageBytes: validateImageBytes,
  isBareRemoteUrl: isBareRemoteUrl,
  publicFileUrl: publicFileUrl,
  cacheImageFromUrl: cacheImageFromUrl,
  cacheImageBytes: cacheImageBytes,
  ensureCardImageCached: ensureCardImageCached,
  enqueueImageCache: enqueueImageCache,
  drainImageQueue: drainImageQueue,
};
