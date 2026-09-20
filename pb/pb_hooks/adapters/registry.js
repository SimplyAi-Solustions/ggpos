// Which adapter module answers for which `games.key`, and the small bits
// of PocketBase glue lookup.pb.js and prices.pb.js both need: resolving a
// game key to its `games` row, and recognising the "set number" query
// forms docs/api-contract.md's Phase 3 section names ("sv151 199",
// "blb 223", "OP01-001", "CT13-EN003") so a search that is really an exact
// lookup gets the cache-first, no-network-when-fresh path.
"use strict";

var GAME_ADAPTERS = {
  pokemon: "tcgdex.js",
  mtg: "scryfall.js",
  yugioh: "ygoprodeck.js",
  onepiece: "optcg.js",
  lorcana: "lorcast.js",
};

var GAME_KEYS = Object.keys(GAME_ADAPTERS);

/** The adapter module for a `games.key`, or null when the game is unknown. */
function adapterForGame(gameKey) {
  var file = GAME_ADAPTERS[gameKey];
  if (!file) return null;
  return require(__hooks + "/adapters/" + file);
}

/** The `games` row for `key`, or null. */
function gameRecord(app, gameKey) {
  try {
    return app.findFirstRecordByFilter("games", "key = {:key}", { key: gameKey });
  } catch (err) {
    return null;
  }
}

/** Same lookup, off the already-loaded `card_sets`/`cards` finders. */
function findCardSet(app, gameId, code) {
  return require(__hooks + "/adapters/storage.js").findCardSet(app, gameId, code);
}

function findCard(app, gameId, setId, number) {
  return require(__hooks + "/adapters/storage.js").findCard(app, gameId, setId, number);
}

/**
 * Recognise the "set number" forms from docs/api-contract.md's Phase 3
 * section: two space-separated tokens for Pokemon/MTG/Lorcana set codes
 * ("sv151 199", "blb 223"), or one hyphenated token for the games whose own
 * card codes already carry the set in them ("OP01-001", "CT13-EN003").
 * Returns { set, number } or null when `q` reads as a plain name search.
 */
function parseSetNumberQuery(gameKey, q) {
  var trimmed = (q || "").trim();
  if (!trimmed) return null;

  if (gameKey === "onepiece" || gameKey === "yugioh") {
    var hyphenated = trimmed.match(/^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/);
    if (hyphenated) return { set: hyphenated[1].toUpperCase(), number: hyphenated[2].toUpperCase() };
    return null;
  }

  var spaced = trimmed.match(/^(\S+)\s+(\S+)$/);
  if (spaced) return { set: spaced[1], number: spaced[2] };
  return null;
}

module.exports = {
  GAME_KEYS: GAME_KEYS,
  adapterForGame: adapterForGame,
  gameRecord: gameRecord,
  findCardSet: findCardSet,
  findCard: findCard,
  parseSetNumberQuery: parseSetNumberQuery,
};
