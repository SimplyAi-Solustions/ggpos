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
 * route, since a search built that way really is an exact lookup (only
 * when the second token actually looks like a collector number and the
 * first resolves to a real set - registry.js's resolveSetNumberQuery). A
 * plain name search always asks the adapter, because discovering a card
 * that is not in the database yet is the entire point of it.
 *
 * These routes write no audit row: a catalogue search or an exact lookup
 * is a read against public reference data (`cards`/`card_sets` list and
 * view rules are public - 1789819260_catalogue_collections.js), the same
 * reasoning `config.pb.js` and the id-document lookup already use. Only
 * `POST .../refresh-prices` (prices.pb.js) writes anything worth auditing.
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

    /** Write one adapter result through to cards/card_sets and shape it for the response, or null when this one row cannot be written through (a blank set code, a validation failure) - one bad row must never fail the whole search. */
    function writeThrough(found) {
      try {
        const setRecord = storage.upsertCardSet(e.app, gameRecord.id, found.setCode, found.setName);
        if (!setRecord) return null;
        const cardRecord = storage.upsertCard(e.app, gameRecord.id, setRecord, found, now.toISOString());
        return storage.cardToRow(e.app, cardRecord);
      } catch (err) {
        console.log(`[lookup] could not write through a ${game} search result: ${err}`);
        return null;
      }
    }

    const exact = registry.resolveSetNumberQuery(e.app, gameRecord.id, game, adapter, q);
    if (exact) {
      const canonicalSet = registry.canonicalSetCode(e.app, gameRecord.id, game, exact.set);
      const setRecord = registry.findCardSet(e.app, gameRecord.id, canonicalSet);
      const cardRecord = setRecord
        ? registry.findCardCaseInsensitive(e.app, gameRecord.id, setRecord.id, exact.number)
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
      const written = found ? writeThrough(found) : null;
      return e.json(200, { cards: written ? [written] : [] });
    }

    let results = [];
    try {
      results = adapter.search(q) || [];
    } catch (err) {
      // One Piece has no free-text search at all - a name-shaped query is
      // a 422 there, not a silent empty result staff would read as "no
      // such card" (optcg.js's search()).
      const optcg = require(`${__hooks}/adapters/optcg.js`);
      if (err && err.message === optcg.NEEDS_CODE_MESSAGE) {
        throw e.error(422, optcg.NEEDS_CODE_MESSAGE, null);
      }
      results = [];
    }
    const rows = [];
    for (let i = 0; i < results.length && rows.length < 25; i++) {
      const found = results[i];
      if (!found || !found.number) continue;
      const row = writeThrough(found);
      if (row) rows.push(row);
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
    // Case-insensitive, canonical-code resolution: the path segment is
    // whatever a member of staff (or a barcode scanner) typed, which is
    // not always the exact case a set or a card was stored under, and a
    // mismatch there would silently miss the 30-day cache on every call.
    const canonicalSet = registry.canonicalSetCode(e.app, gameRecord.id, game, setParam);
    let setRecord = registry.findCardSet(e.app, gameRecord.id, canonicalSet);
    let cardRecord = setRecord
      ? registry.findCardCaseInsensitive(e.app, gameRecord.id, setRecord.id, number)
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

    try {
      setRecord = storage.upsertCardSet(e.app, gameRecord.id, found.setCode || canonicalSet, found.setName);
      if (!setRecord) {
        throw e.notFoundError(`Card not found in ${setParam}. Check the number or add it manually.`, null);
      }
      cardRecord = storage.upsertCard(e.app, gameRecord.id, setRecord, found, now.toISOString());
    } catch (err) {
      if (err && err.status) throw err; // an ApiError we just threw above
      console.log(`[lookup] could not write through the exact match for ${game}/${setParam}/${number}: ${err}`);
      throw e.notFoundError(`Card not found in ${setParam}. Check the number or add it manually.`, null);
    }
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
      // Swallowing this into an empty 200 used to read as "no such title"
      // when IGDB itself was the one that failed - a member of staff
      // cannot tell those two apart without this being a distinct error.
      console.log(`[retro/lookup] IGDB search failed: ${err}`);
      throw e.error(502, "IGDB did not answer. Try again, or add the title manually.", null);
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
        try {
          record = new Record(e.app.findCollectionByNameOrId("retro_titles"), {
            platform: platformRecord.id,
            name: found.name,
            external_ids: found.externalIds,
          });
          // Cover art is fetched once, only for a title this database has
          // never seen before, through the same validated, sniffed path
          // every re-hosted image goes through (adapters/images.js) -
          // IGDB allows hotlinking, but `cover` is a PocketBase file field
          // (unlike cards.image_small/image_large), so it needs an actual
          // file either way, and never on every repeat hit of a search a
          // member of staff has already resolved once.
          if (found.cover) {
            const images = require(`${__hooks}/adapters/images.js`);
            images.cacheImageFromUrl(e.app, record, found.cover, 15);
          } else {
            e.app.save(record);
          }
        } catch (err) {
          console.log(`[retro/lookup] could not write through "${found.name}": ${err}`);
          record = null;
        }
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
