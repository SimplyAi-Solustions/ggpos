/// <reference path="../pb_data/types.d.ts" />

/**
 * lookup.pb.js - the catalogue and retro-title lookup routes
 * (docs/api-contract.md, "Phase 3: lookup, prices and FX"):
 *
 *   GET /api/vault/lookup?game=<key>&q=<text>
 *   GET /api/vault/lookup/{game}/{set}/{number}
 *   GET /api/vault/retro/lookup?q=<text>&platform=<key>
 *
 * Every route searches the matching adapter (pb_hooks/adapters/*.js),
 * writes what it finds through to `cards`/`card_sets` (or `retro_titles`),
 * and returns the row shape the contract promises. A card whose
 * `last_synced` is under 30 days old is served straight from the database,
 * with no outbound call at all - adapters/storage.js's isFresh() is the
 * whole cache: the "set number" forms ("sv151 199", "blb 223", "OP01-001",
 * "CT13-EN003") get this treatment through the same code path as the exact
 * route, since a search built that way really is an exact lookup. A plain
 * name search always asks the adapter, because discovering a card that is
 * not in the database yet is the entire point of it.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/lookup?game=&q=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/lookup",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const registry = require(`${__hooks}/adapters/registry.js`);
    const storage = require(`${__hooks}/adapters/storage.js`);

    function queryParam(name) {
      let value = "";
      try {
        const info = e.requestInfo();
        value = util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        value = "";
      }
      if (!value) {
        try {
          value = util.asStr(e.request.url.query().get(name));
        } catch (err) {
          // Leave it blank.
        }
      }
      return value;
    }

    const game = queryParam("game").toLowerCase();
    const q = queryParam("q");

    const adapter = registry.adapterForGame(game);
    if (!adapter) {
      throw e.badRequestError(
        `Unknown game "${game}". Pick one of ${registry.GAME_KEYS.join(", ")}.`,
        null
      );
    }
    if (!q) {
      throw e.badRequestError("Type a card name, or a set and number, to search.", null);
    }

    const gameRecord = registry.gameRecord(e.app, game);
    if (!gameRecord) {
      throw e.badRequestError(`Unknown game "${game}". Pick one of ${registry.GAME_KEYS.join(", ")}.`, null);
    }
    const now = new Date();

    /** Write one adapter result through to cards/card_sets and shape it for the response. */
    function writeThrough(found) {
      const setRecord = storage.upsertCardSet(e.app, gameRecord.id, found.setCode, found.setName);
      const cardRecord = storage.upsertCard(e.app, gameRecord.id, setRecord, found, now.toISOString());
      return storage.cardToRow(e.app, cardRecord);
    }

    const exact = registry.parseSetNumberQuery(game, q);
    if (exact) {
      const setRecord = registry.findCardSet(e.app, gameRecord.id, exact.set);
      const cardRecord = setRecord
        ? registry.findCard(e.app, gameRecord.id, setRecord.id, exact.number)
        : null;
      if (cardRecord && storage.isFresh(cardRecord.getString("last_synced"), now)) {
        return e.json(200, { cards: [storage.cardToRow(e.app, cardRecord)] });
      }
      let found = null;
      try {
        found = adapter.getBySetNumber(exact.set, exact.number);
      } catch (err) {
        found = null;
      }
      return e.json(200, { cards: found ? [writeThrough(found)] : [] });
    }

    let results = [];
    try {
      results = adapter.search(q) || [];
    } catch (err) {
      results = [];
    }
    const rows = [];
    for (let i = 0; i < results.length && rows.length < 25; i++) {
      const found = results[i];
      if (!found || !found.number) continue;
      rows.push(writeThrough(found));
    }
    return e.json(200, { cards: rows });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/lookup/{game}/{set}/{number}
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/lookup/{game}/{set}/{number}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const registry = require(`${__hooks}/adapters/registry.js`);
    const storage = require(`${__hooks}/adapters/storage.js`);

    const game = util.asStr(e.request.pathValue("game")).toLowerCase();
    const setParam = util.asStr(e.request.pathValue("set"));
    const number = util.asStr(e.request.pathValue("number"));

    const adapter = registry.adapterForGame(game);
    if (!adapter) {
      throw e.badRequestError(
        `Unknown game "${game}". Pick one of ${registry.GAME_KEYS.join(", ")}.`,
        null
      );
    }
    const gameRecord = registry.gameRecord(e.app, game);
    if (!gameRecord) {
      throw e.badRequestError(`Unknown game "${game}". Pick one of ${registry.GAME_KEYS.join(", ")}.`, null);
    }

    const now = new Date();
    let setRecord = registry.findCardSet(e.app, gameRecord.id, setParam);
    let cardRecord = setRecord
      ? registry.findCard(e.app, gameRecord.id, setRecord.id, number)
      : null;

    // Fresh in the database: no outbound call at all.
    if (cardRecord && storage.isFresh(cardRecord.getString("last_synced"), now)) {
      return e.json(200, { cards: [storage.cardToRow(e.app, cardRecord)] });
    }

    let found = null;
    try {
      found = adapter.getBySetNumber(setParam, number);
    } catch (err) {
      found = null;
    }
    if (!found) {
      const setName = setRecord ? setRecord.getString("name") : setParam;
      throw e.notFoundError(`Card not found in ${setName}. Check the number or add it manually.`, null);
    }

    setRecord = storage.upsertCardSet(e.app, gameRecord.id, found.setCode || setParam, found.setName);
    cardRecord = storage.upsertCard(e.app, gameRecord.id, setRecord, found, now.toISOString());
    return e.json(200, { cards: [storage.cardToRow(e.app, cardRecord)] });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/retro/lookup?q=&platform=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/retro/lookup",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const igdb = require(`${__hooks}/adapters/igdb.js`);
    const statestore = require(`${__hooks}/adapters/statestore.js`);

    function queryParam(name) {
      let value = "";
      try {
        const info = e.requestInfo();
        value = util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        value = "";
      }
      if (!value) {
        try {
          value = util.asStr(e.request.url.query().get(name));
        } catch (err) {
          // Leave it blank.
        }
      }
      return value;
    }

    const q = queryParam("q");
    const platformKey = queryParam("platform").toLowerCase();
    if (!q) {
      throw e.badRequestError("Type a game title to search.", null);
    }

    const settings = util.settings(e.app);
    const apiKeys = settings ? util.jsonField(settings, "api_keys", {}) || {} : {};
    const igdbKey = apiKeys.igdb || null;
    if (!igdbKey || !igdbKey.client_id || !igdbKey.client_secret) {
      throw e.error(
        422,
        "Retro title search needs an IGDB key. Add settings.api_keys.igdb first.",
        null
      );
    }

    const platformId = platformKey ? igdb.platformIgdbId(platformKey) : null;
    let results = [];
    try {
      results = igdb.search(
        statestore.forApp(e.app),
        igdbKey.client_id,
        igdbKey.client_secret,
        q,
        platformId
      );
    } catch (err) {
      results = [];
    }

    let platformRecord = null;
    if (platformKey) {
      try {
        platformRecord = e.app.findFirstRecordByFilter("platforms", "key = {:key}", {
          key: platformKey,
        });
      } catch (err) {
        platformRecord = null;
      }
    }

    const rows = [];
    for (let i = 0; i < results.length && rows.length < 25; i++) {
      const found = results[i];
      if (!found || !found.name) continue;

      // Dedupe on platform + name (both plain fields, safe to filter on -
      // retro_titles has no indexed external-id field to match against
      // instead). Without a platform to scope the search, dedupe on name
      // alone: still correct, just a little less precise across platforms.
      let existing = null;
      try {
        existing = platformRecord
          ? e.app.findFirstRecordByFilter("retro_titles", "platform = {:platform} && name = {:name}", {
              platform: platformRecord.id,
              name: found.name,
            })
          : e.app.findFirstRecordByFilter("retro_titles", "name = {:name}", { name: found.name });
      } catch (err) {
        existing = null;
      }

      let record = existing;
      // `platform` is required on retro_titles, so a brand new row can only
      // be written through when the caller named one; otherwise this stays
      // a preview-only search result (id: "").
      if (!record && platformRecord) {
        record = new Record(e.app.findCollectionByNameOrId("retro_titles"), {
          platform: platformRecord.id,
          name: found.name,
          external_ids: found.externalIds,
        });
        // Cover art is fetched once, only for a title this database has
        // never seen before - IGDB allows hotlinking, but `cover` is a
        // PocketBase file field (unlike cards.image_small/image_large),
        // so it needs an actual file either way, and never on every repeat
        // hit of a search a member of staff has already resolved once.
        if (found.cover) {
          try {
            record.set("cover", $filesystem.fileFromURL(found.cover, 15));
          } catch (err) {
            // A slow or unreachable image host must not block the search
            // result itself - see adapters/images.js's callers for the
            // same reasoning.
          }
        }
        e.app.save(record);
      }

      rows.push({
        id: record ? record.id : "",
        platform: record ? record.getString("platform") : platformRecord ? platformRecord.id : "",
        name: found.name,
        region: record ? record.getString("region") : "",
        cover: record ? record.getString("cover") : "",
        external_ids: found.externalIds,
      });
    }

    return e.json(200, { titles: rows });
  },
  $apis.requireAuth("staff")
);
