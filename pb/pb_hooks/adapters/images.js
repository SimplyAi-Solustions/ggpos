// Re-hosting a card's artwork into PocketBase, so labels and receipts never
// depend on a third party still hosting the same URL (docs/PLAN.md, "Card
// images and market prices": "a local copy saved when an item is created").
//
// Two ways in:
//  - lookup.pb.js calls cacheImageBytes() immediately for a source that
//    forbids hotlinking (YGOPRODeck, OPTCG - hotlinking gets IPs banned),
//    with bytes the adapter already fetched itself through the overridable
//    http() transport, so the bare provider URL is never even written to
//    `cards.image_small` / `.image_large` transiently.
//  - items.pb.js's onRecordCreate calls cacheImageFromUrl() lazily, the
//    first time an item is created against a card whose image is still a
//    bare third-party URL (TCGdex, Scryfall, Lorcast link their images
//    directly - PLAN.md says hotlinking those is fine - but a receipt or a
//    label printed years later should not depend on that host still being
//    up).
//
// This module is goja-only (it needs $filesystem and $app.settings(), which
// do not exist under plain Node), unlike the adapters themselves. Nothing
// in here throws: every caller's own failure must not block the request it
// came from (an item create, a lookup) - see the callers for why.
"use strict";

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

/**
 * Fetch `url` straight into `record`'s `image_file` field with
 * $filesystem.fileFromURL (goja's own fetch-into-file helper - no need to
 * round-trip through $http.send and fileFromBytes ourselves), then point
 * `image_small` and `image_large` at the resulting local URL. Returns true
 * on success, false on any failure - never throws.
 */
function cacheImageFromUrl(app, record, url, timeoutSeconds) {
  if (!url) return false;
  try {
    var file = $filesystem.fileFromURL(url, timeoutSeconds || 15);
    record.set("image_file", file);
    app.save(record);
    var stored = record.get("image_file");
    var filename = Array.isArray(stored) ? stored[0] : stored;
    if (!filename) return false;
    var localUrl = publicFileUrl(app, record, filename);
    record.set("image_small", localUrl);
    record.set("image_large", localUrl);
    app.save(record);
    return true;
  } catch (err) {
    console.log("[adapters/images] could not cache " + url + " for card " + record.id + ": " + err);
    return false;
  }
}

/**
 * Store bytes the caller already fetched (YGOPRODeck, OPTCG: their getImage()
 * fetches through the overridable http() transport so it stays testable
 * under plain Node, then hands the raw bytes here to go straight into
 * PocketBase without ever touching a bare hotlink URL). Returns true on
 * success, false on any failure - never throws.
 */
function cacheImageBytes(app, record, bytes, filenameHint) {
  if (!bytes || !bytes.length) return false;
  try {
    var file = $filesystem.fileFromBytes(bytes, filenameHint || "card.jpg");
    record.set("image_file", file);
    app.save(record);
    var stored = record.get("image_file");
    var filename = Array.isArray(stored) ? stored[0] : stored;
    if (!filename) return false;
    var localUrl = publicFileUrl(app, record, filename);
    record.set("image_small", localUrl);
    record.set("image_large", localUrl);
    app.save(record);
    return true;
  } catch (err) {
    console.log("[adapters/images] could not store image bytes for card " + record.id + ": " + err);
    return false;
  }
}

/**
 * Opportunistic lazy cache: items.pb.js's onRecordCreate calls this after
 * saving a new item that links a card. A no-op when the card has no image,
 * already has a locally cached one, or the fetch fails for any reason - a
 * failed fetch must never block the item create it came from.
 */
function ensureCardImageCached(app, cardId) {
  if (!cardId) return;
  var card = null;
  try {
    card = app.findRecordById("cards", cardId);
  } catch (err) {
    return;
  }
  var candidate = card.getString("image_large") || card.getString("image_small");
  if (!isBareRemoteUrl(app, candidate)) return;
  cacheImageFromUrl(app, card, candidate, 15);
}

module.exports = {
  isBareRemoteUrl: isBareRemoteUrl,
  publicFileUrl: publicFileUrl,
  cacheImageFromUrl: cacheImageFromUrl,
  cacheImageBytes: cacheImageBytes,
  ensureCardImageCached: ensureCardImageCached,
};
