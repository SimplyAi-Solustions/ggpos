// Write-through helpers shared by lookup.pb.js and prices.pb.js: turn one
// adapter's normalized search result into `card_sets` / `cards` rows, and
// read a `cards` row back out as the row shape docs/api-contract.md's
// Phase 3 section promises. Plain functions on a CommonJS module, required
// fresh inside every handler body (pb/README.md's isolated-context rule).
//
// "Normalized" card shape every catalogue adapter's search()/getBySetNumber()
// resolves to (see adapters/tcgdex.js and friends):
//   {
//     number, name, rarity, type, finishesAvailable: string[],
//     setCode, setName,
//     imageSmall, imageLarge,       // already-hostable URLs (may be "")
//     rehostImage: bool,            // true = the URL above must not be kept
//                                   // (YGOPRODeck/OPTCG hotlink bans) - the
//                                   // caller re-hosts before it ever writes
//                                   // image_small/image_large
//     imageBytes, imageFilename,    // present only when rehostImage is true
//     tcgplayerId, cardmarketId,    // strings, "" when the source has none
//     externalIds: object,
//   }
"use strict";

var FRESH_DAYS = 30;

function normalizedSearchText(name, number, setCode) {
  return [name, number, setCode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** True when `lastSyncedIso` is under FRESH_DAYS old. False for anything unusable. */
function isFresh(lastSyncedIso, now) {
  if (!lastSyncedIso) return false;
  var last = new Date(lastSyncedIso).getTime();
  if (!isFinite(last)) return false;
  return (now.getTime() - last) / 86400000 < FRESH_DAYS;
}

/** Find the card_sets row for (gameId, code), or null. */
function findCardSet(app, gameId, code) {
  if (!code) return null;
  try {
    return app.findFirstRecordByFilter("card_sets", "game = {:game} && code = {:code}", {
      game: gameId,
      code: code,
    });
  } catch (err) {
    return null;
  }
}

/** Find or create the card_sets row for (gameId, code), refreshing its name. */
function upsertCardSet(app, gameId, code, name) {
  var existing = findCardSet(app, gameId, code);
  if (existing) {
    if (name && existing.getString("name") !== name) {
      existing.set("name", name);
      app.save(existing);
    }
    return existing;
  }
  var record = new Record(app.findCollectionByNameOrId("card_sets"), {
    game: gameId,
    code: code,
    name: name || code,
  });
  app.save(record);
  return record;
}

/** Find the cards row for (gameId, setId, number), or null. */
function findCard(app, gameId, setId, number) {
  if (!setId || !number) return null;
  try {
    return app.findFirstRecordByFilter(
      "cards",
      "game = {:game} && set = {:set} && number = {:number}",
      { game: gameId, set: setId, number: number }
    );
  } catch (err) {
    return null;
  }
}

/**
 * Find or create the cards row for (gameId, setRecord, normalized.number)
 * and write through every field the adapter gave us. Image handling:
 *  - a normal source (rehostImage falsy): image_small/image_large are set
 *    to whatever hostable URL the adapter returned;
 *  - a hotlink-banned source (rehostImage true, imageBytes present): the
 *    image is re-hosted into `cards.image_file` first, through
 *    adapters/images.js, and image_small/image_large are set to the
 *    resulting local URL instead - the bare provider URL is never written.
 */
function upsertCard(app, gameId, setRecord, normalized, nowIso) {
  var existing = findCard(app, gameId, setRecord.id, normalized.number);
  var record = existing;
  if (!record) {
    record = new Record(app.findCollectionByNameOrId("cards"), {
      game: gameId,
      set: setRecord.id,
      number: normalized.number,
    });
  }

  if (normalized.name) record.set("name", normalized.name);
  if (normalized.rarity) record.set("rarity", normalized.rarity);
  if (normalized.type) record.set("type", normalized.type);
  if (normalized.finishesAvailable) record.set("finishes_available", normalized.finishesAvailable);
  if (normalized.tcgplayerId) record.set("tcgplayer_id", String(normalized.tcgplayerId));
  if (normalized.cardmarketId) record.set("cardmarket_id", String(normalized.cardmarketId));
  record.set("external_ids", normalized.externalIds || {});
  record.set("source", "api");
  record.set(
    "search_text",
    normalizedSearchText(normalized.name, normalized.number, setRecord.getString("code"))
  );
  record.set("last_synced", nowIso);

  if (normalized.rehostImage && normalized.imageBytes && normalized.imageBytes.length) {
    app.save(record); // needs an id before baseFilesPath() means anything
    var images = require(__hooks + "/adapters/images.js");
    images.cacheImageBytes(app, record, normalized.imageBytes, normalized.imageFilename);
  } else {
    if (normalized.imageSmall) record.set("image_small", normalized.imageSmall);
    if (normalized.imageLarge) record.set("image_large", normalized.imageLarge);
    app.save(record);
  }
  return record;
}

/** A cards record as the row shape docs/api-contract.md's Phase 3 section promises. */
function cardToRow(app, record) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var setRecord = null;
  try {
    setRecord = app.findRecordById("card_sets", record.getString("set"));
  } catch (err) {
    setRecord = null;
  }
  return {
    id: record.id,
    game: record.getString("game"),
    set: record.getString("set"),
    set_code: setRecord ? setRecord.getString("code") : "",
    set_name: setRecord ? setRecord.getString("name") : "",
    number: record.getString("number"),
    name: record.getString("name"),
    rarity: record.getString("rarity"),
    image_small: record.getString("image_small"),
    image_large: record.getString("image_large"),
    finishes_available: util.jsonField(record, "finishes_available", []) || [],
    external_ids: util.jsonField(record, "external_ids", {}) || {},
    last_synced: record.getString("last_synced"),
  };
}

module.exports = {
  FRESH_DAYS: FRESH_DAYS,
  isFresh: isFresh,
  findCardSet: findCardSet,
  upsertCardSet: upsertCardSet,
  findCard: findCard,
  upsertCard: upsertCard,
  cardToRow: cardToRow,
};
