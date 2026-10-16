// Which adapter module answers for which `games.key`, and the shared bits
// lookup.pb.js needs: resolving a game key to its `games` row, and turning
// a "set number" query into a canonical (game, set, number) the 30-day
// cache can actually hit.
"use strict";

var GAME_ADAPTERS = {
  pokemon: "tcgdex.js",
  mtg: "scryfall.js",
  yugioh: "ygoprodeck.js",
  onepiece: "optcg.js",
  lorcana: "lorcast.js",
};

var GAME_KEYS = Object.keys(GAME_ADAPTERS);

// A query token some players use that is not the adapter's own set id (see
// docs/api-contract.md's Phase 3 section) - "sv151" for TCGdex's "sv03.5".
// Keyed per game, lower-case.
var SET_ALIASES = {
  pokemon: { sv151: "sv03.5" },
};

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

function findCardSet(app, gameId, code) {
  return require(__hooks + "/adapters/storage.js").findCardSet(app, gameId, code);
}

function findCard(app, gameId, setId, number) {
  return require(__hooks + "/adapters/storage.js").findCard(app, gameId, setId, number);
}

/**
 * `findCard`, then a case-insensitive scan of the set's cards when the
 * exact-case match misses - the number a member of staff types does not
 * always match the case a card was stored under (docs/api-contract.md's
 * Phase 3 section: "Normalise the set and number ... case-insensitive
 * resolution").
 */
function findCardCaseInsensitive(app, gameId, setId, number) {
  if (!setId || !number) return null;
  var exact = findCard(app, gameId, setId, number);
  if (exact) return exact;
  var lower = String(number).toLowerCase();
  var rows = [];
  try {
    rows = app.findRecordsByFilter("cards", "game = {:game} && set = {:set}", "", 500, 0, {
      game: gameId,
      set: setId,
    });
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getString("number").toLowerCase() === lower) return rows[i];
  }
  return null;
}

/** The alias table, then a case-insensitive scan of this game's card_sets, or null. */
function resolveSetCode(app, gameId, gameKey, token) {
  var lower = token.toLowerCase();
  var alias = (SET_ALIASES[gameKey] || {})[lower];
  if (alias) return alias;
  var rows = [];
  try {
    rows = app.findRecordsByFilter("card_sets", "game = {:game}", "", 500, 0, { game: gameId });
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getString("code").toLowerCase() === lower) return rows[i].getString("code");
  }
  return null;
}

/**
 * `resolveSetCode`'s match, or the caller's own token when nothing
 * resolves yet - the exact lookup route still has to try the adapter with
 * whatever the caller typed the first time a set is seen.
 */
function canonicalSetCode(app, gameId, gameKey, token) {
  if (!token) return token;
  return resolveSetCode(app, gameId, gameKey, token) || token;
}

/**
 * A fresh install has no `card_sets` rows for a game yet, so
 * `resolveSetCode` (the alias table aside) can never match anything on the
 * very first lookup. Runs the adapter's own set sync once - the same write
 * the weekly cron does, pulled forward for this one game the moment it is
 * actually needed - and stamps `adapter_state` so a game whose sync keeps
 * failing is not retried on every request.
 */
function ensureSetsSynced(app, gameId, gameKey, adapter) {
  var hasSets = false;
  try {
    hasSets =
      app.findRecordsByFilter("card_sets", "game = {:game}", "", 1, 0, { game: gameId }).length > 0;
  } catch (err) {
    hasSets = false;
  }
  if (hasSets) return;

  var statestore = require(__hooks + "/adapters/statestore.js");
  var store = statestore.forApp(app);
  var stampKey = "set_sync_bootstrap:" + gameKey;
  if (store.get(stampKey)) return;
  store.set(stampKey, { at: new Date().toISOString() }, "");

  if (!adapter || !adapter.listSets) return;
  var sets = [];
  try {
    sets = adapter.listSets() || [];
  } catch (err) {
    console.log(`[registry] inline set sync failed for ${gameKey}: ${err}`);
    return;
  }
  for (var i = 0; i < sets.length; i++) {
    var s = sets[i];
    if (!s || !s.code) continue;
    try {
      var existing = null;
      try {
        existing = app.findFirstRecordByFilter("card_sets", "game = {:game} && code = {:code}", {
          game: gameId,
          code: s.code,
        });
      } catch (err) {
        existing = null;
      }
      var record =
        existing || new Record(app.findCollectionByNameOrId("card_sets"), { game: gameId, code: s.code });
      record.set("name", s.name || s.code);
      if (s.total) record.set("total", s.total);
      app.save(record);
    } catch (err) {
      console.log(`[registry] set "${s.code}" failed during inline sync for ${gameKey}: ${err}`);
    }
  }
}

/** Digits with an optional single letter suffix, or Lorcana's "n/total" (whose `n` is the real number). Null when `token` reads as a name word instead. */
function collectorNumber(gameKey, token) {
  if (gameKey === "lorcana") {
    var frac = token.match(/^(\d+)\/\d+$/);
    if (frac) return frac[1];
  }
  return /^\d+[A-Za-z]?$/.test(token) ? token : null;
}

/**
 * Recognise the "set number" forms from docs/api-contract.md's Phase 3
 * section: one hyphenated token for the games whose own card codes already
 * carry the set in them ("OP01-001", "CT13-EN003"), or two space-separated
 * tokens for the others ("sv151 199", "blb 223") - but only when the
 * second token actually looks like a collector number AND the first
 * resolves to a real set (the alias table, or a case-insensitive
 * `card_sets` match, running the set sync once inline first if this game
 * has no sets cached yet). A plain two-word name ("charizard ex",
 * "lightning bolt") therefore reads as a name search, not a bogus exact
 * lookup for set "charizard" or "lightning". Returns `{ set, number }` or
 * null.
 */
function resolveSetNumberQuery(app, gameId, gameKey, adapter, q) {
  var trimmed = (q || "").trim();
  if (!trimmed) return null;

  if (gameKey === "onepiece" || gameKey === "yugioh") {
    var hyphenated = trimmed.match(/^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/);
    if (hyphenated) return { set: hyphenated[1].toUpperCase(), number: hyphenated[2].toUpperCase() };
    return null;
  }

  var spaced = trimmed.match(/^(\S+)\s+(\S+)$/);
  if (!spaced) return null;
  var number = collectorNumber(gameKey, spaced[2]);
  if (!number) return null;

  var lower = spaced[1].toLowerCase();
  var alias = (SET_ALIASES[gameKey] || {})[lower];
  if (alias) return { set: alias, number: number };

  ensureSetsSynced(app, gameId, gameKey, adapter);
  var setCode = resolveSetCode(app, gameId, gameKey, spaced[1]);
  if (!setCode) return null;
  return { set: setCode, number: number };
}

module.exports = {
  GAME_KEYS: GAME_KEYS,
  SET_ALIASES: SET_ALIASES,
  adapterForGame: adapterForGame,
  gameRecord: gameRecord,
  findCardSet: findCardSet,
  findCard: findCard,
  findCardCaseInsensitive: findCardCaseInsensitive,
  canonicalSetCode: canonicalSetCode,
  resolveSetNumberQuery: resolveSetNumberQuery,
};
