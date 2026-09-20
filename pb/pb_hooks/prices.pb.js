/// <reference path="../pb_data/types.d.ts" />

/**
 * prices.pb.js - card and retro-title valuation
 * (docs/api-contract.md, "Phase 3: lookup, prices and FX"):
 *
 *   GET  /api/vault/cards/:id/prices?finish=&condition=
 *   POST /api/vault/cards/:id/refresh-prices   { finish }
 *   POST /api/vault/cards/:id/uk-comp          { finish, condition, price, url, sold_at }
 *   GET  /api/vault/retro/:id/prices?completeness=
 *
 * The GET routes only ever read `price_snapshots` - no adapter is called,
 * so a normal price check never makes an outbound call (pb/scripts/check.sh
 * runs these under GG_ADAPTER_TRANSPORT_MODE=offline_fail to prove it).
 * Only `refresh-prices` and `uk-comp` write anything: refresh-prices calls
 * every enabled adapter for the card's game plus eBay, and uk-comp is a
 * staff-entered row that needs no adapter at all.
 *
 * `price_snapshots.finish` is reused for retro's "completeness"
 * (loose/boxed/cib) rather than adding a second column that would mean the
 * same thing for the other kind of row - see docs/PLAN.md's data model,
 * which gives price_snapshots one such column, not two.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/cards/{id}/prices
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/cards/{id}/prices",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

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

    const cardId = e.request.pathValue("id");
    let card = null;
    try {
      card = e.app.findRecordById("cards", cardId);
    } catch (err) {
      throw e.notFoundError("Card not found. Check the id or add it manually.", null);
    }

    const finish = queryParam("finish");
    const condition = queryParam("condition") || "NM";

    const settingsRow = util.settings(e.app);
    const priority =
      (settingsRow && util.jsonField(settingsRow, "source_priority", null)) ||
      pricingShared.DEFAULT_TCG_PRIORITY;
    const multipliers =
      (settingsRow && util.jsonField(settingsRow, "condition_multipliers", null)) ||
      pricingShared.DEFAULT_CONDITION_MULTIPLIERS;

    const filter = finish ? "card = {:card} && finish = {:finish}" : "card = {:card}";
    const params = finish ? { card: cardId, finish: finish } : { card: cardId };
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("price_snapshots", filter, "-fetched_at", 100, 0, params);
    } catch (err) {
      rows = [];
    }

    const candidates = rows.map(policy.candidateFromSnapshot);
    const now = new Date();
    const result = policy.choose(candidates, priority, now);
    const conditionAdjusted = result.chosen
      ? pricingShared.adjustForCondition(result.chosen.gbp_market, condition, multipliers)
      : null;

    return e.json(200, {
      chosen: result.chosen,
      sources: result.sources,
      condition_adjusted: conditionAdjusted,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/cards/{id}/refresh-prices   { finish }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cards/{id}/refresh-prices",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const registry = require(`${__hooks}/adapters/registry.js`);
    const pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

    const cardId = e.request.pathValue("id");
    let card = null;
    try {
      card = e.app.findRecordById("cards", cardId);
    } catch (err) {
      throw e.notFoundError("Card not found. Check the id or add it manually.", null);
    }
    let cardSet = null;
    try {
      cardSet = e.app.findRecordById("card_sets", card.getString("set"));
    } catch (err) {
      cardSet = null;
    }
    let gameRow = null;
    try {
      gameRow = e.app.findRecordById("games", card.getString("game"));
    } catch (err) {
      gameRow = null;
    }
    const gameKey = gameRow ? gameRow.getString("key") : "";

    const body = util.body(e);
    const finish = util.asStr(body.finish);

    const settingsRow = util.settings(e.app);
    const apiKeys = (settingsRow && util.jsonField(settingsRow, "api_keys", {})) || {};
    const fxRates = policy.latestFxRates(e.app);
    const now = new Date();

    const adapterCard = {
      setCode: cardSet ? cardSet.getString("code") : "",
      number: card.getString("number"),
      externalIds: util.jsonField(card, "external_ids", {}) || {},
    };

    let raw = [];
    const adapter = registry.adapterForGame(gameKey);
    if (adapter) {
      try {
        raw = adapter.getPrices(adapterCard, finish) || [];
      } catch (err) {
        console.log(`[prices] ${gameKey} getPrices failed for card ${cardId}: ${err}`);
        raw = [];
      }
    }

    if (apiKeys.ebay && apiKeys.ebay.client_id && apiKeys.ebay.client_secret) {
      try {
        const ebay = require(`${__hooks}/adapters/ebay.js`);
        const statestore = require(`${__hooks}/adapters/statestore.js`);
        const queryText = [card.getString("name"), cardSet ? cardSet.getString("name") : "", card.getString("number"), finish]
          .filter(Boolean)
          .join(" ");
        const cacheKey = `card:${cardId}:${finish}`;
        const ebayRows = ebay.getPrices(
          statestore.forApp(e.app),
          apiKeys.ebay,
          queryText,
          cacheKey,
          ebay.haircutPctFromSettings(e.app)
        );
        raw = raw.concat(ebayRows);
      } catch (err) {
        console.log(`[prices] ebay getPrices failed for card ${cardId}: ${err}`);
      }
    }

    for (let i = 0; i < raw.length; i++) {
      const snapshot = policy.fromAdapterCandidate(raw[i], fxRates, now);
      if (!snapshot) continue;
      policy.writeSnapshot(e.app, {
        card: cardId,
        finish: finish,
        source: snapshot.source,
        nativeCurrency: snapshot.nativeCurrency,
        nativeLow: snapshot.nativeLow,
        nativeMid: snapshot.nativeMid,
        nativeMarket: snapshot.nativeMarket,
        nativeTrend: snapshot.nativeTrend,
        fxRate: snapshot.fxRate,
        fxDate: snapshot.fxDate,
        gbpMarket: snapshot.gbpMarket,
        fetchedAt: snapshot.fetchedAt,
        evidenceUrl: snapshot.evidenceUrl,
      });
    }

    // Same body as the GET, read straight back from what was just written.
    const priority =
      (settingsRow && util.jsonField(settingsRow, "source_priority", null)) ||
      pricingShared.DEFAULT_TCG_PRIORITY;
    const multipliers =
      (settingsRow && util.jsonField(settingsRow, "condition_multipliers", null)) ||
      pricingShared.DEFAULT_CONDITION_MULTIPLIERS;
    const filter = finish ? "card = {:card} && finish = {:finish}" : "card = {:card}";
    const params = finish ? { card: cardId, finish: finish } : { card: cardId };
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("price_snapshots", filter, "-fetched_at", 100, 0, params);
    } catch (err) {
      rows = [];
    }
    const candidates = rows.map(policy.candidateFromSnapshot);
    const result = policy.choose(candidates, priority, now);
    const conditionAdjusted = result.chosen
      ? pricingShared.adjustForCondition(result.chosen.gbp_market, "NM", multipliers)
      : null;

    return e.json(200, {
      chosen: result.chosen,
      sources: result.sources,
      condition_adjusted: conditionAdjusted,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/cards/{id}/uk-comp   { finish, condition, price, url, sold_at }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cards/{id}/uk-comp",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

    const staff = e.auth;
    const cardId = e.request.pathValue("id");
    let card = null;
    try {
      card = e.app.findRecordById("cards", cardId);
    } catch (err) {
      throw e.notFoundError("Card not found. Check the id or add it manually.", null);
    }

    const body = util.body(e);
    const finish = util.asStr(body.finish);
    const condition = util.asStr(body.condition) || "NM";
    const price = util.asInt(body.price, -1);
    const url = util.asStr(body.url);
    const soldAt = util.asStr(body.sold_at);

    if (price < 0) {
      throw e.badRequestError("Enter the sold price in pence.", null);
    }
    if (!/^https:\/\/(www\.)?ebay\.co\.uk\/itm\//i.test(url)) {
      throw e.badRequestError(
        "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...).",
        null
      );
    }
    const soldDate = new Date(soldAt + "T00:00:00.000Z");
    if (isNaN(soldDate.getTime())) {
      throw e.badRequestError("Enter the date it sold, as YYYY-MM-DD.", null);
    }
    const now = new Date();
    if (soldDate.getTime() > now.getTime()) {
      throw e.badRequestError("That sale date is in the future.", null);
    }
    const daysOld = (now.getTime() - soldDate.getTime()) / 86400000;
    if (daysOld > 30) {
      throw e.badRequestError(
        "That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days.",
        null
      );
    }

    let snapshot = null;
    e.app.runInTransaction((txApp) => {
      snapshot = policy.writeSnapshot(txApp, {
        card: cardId,
        finish: finish,
        source: "uk_sold_manual",
        nativeCurrency: "GBP",
        nativeLow: price,
        nativeMid: price,
        nativeMarket: price,
        nativeTrend: price,
        fxRate: 1,
        fxDate: soldAt,
        gbpMarket: price,
        fetchedAt: soldDate.toISOString(),
        evidenceUrl: url,
      });

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "uk_comp",
        collection: "price_snapshots",
        record: snapshot.id,
        meta: { card: cardId, finish: finish, condition: condition, price: price },
        ip: e.realIP(),
      });
    });

    const settingsRow = util.settings(e.app);
    const priority =
      (settingsRow && util.jsonField(settingsRow, "source_priority", null)) ||
      pricingShared.DEFAULT_TCG_PRIORITY;
    const multipliers =
      (settingsRow && util.jsonField(settingsRow, "condition_multipliers", null)) ||
      pricingShared.DEFAULT_CONDITION_MULTIPLIERS;
    const filter = finish ? "card = {:card} && finish = {:finish}" : "card = {:card}";
    const params = finish ? { card: cardId, finish: finish } : { card: cardId };
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("price_snapshots", filter, "-fetched_at", 100, 0, params);
    } catch (err) {
      rows = [];
    }
    const candidates = rows.map(policy.candidateFromSnapshot);
    const result = policy.choose(candidates, priority, now);
    const conditionAdjusted = result.chosen
      ? pricingShared.adjustForCondition(result.chosen.gbp_market, condition, multipliers)
      : null;

    return e.json(200, {
      chosen: result.chosen,
      sources: result.sources,
      condition_adjusted: conditionAdjusted,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/retro/{id}/prices?completeness=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/retro/{id}/prices",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

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

    const retroId = e.request.pathValue("id");
    try {
      e.app.findRecordById("retro_titles", retroId);
    } catch (err) {
      throw e.notFoundError("Retro title not found. Check the id or add it manually.", null);
    }

    const completeness = queryParam("completeness");
    const settingsRow = util.settings(e.app);
    const priority =
      (settingsRow && util.jsonField(settingsRow, "retro_source_priority", null)) ||
      pricingShared.DEFAULT_RETRO_PRIORITY;

    const filter = completeness
      ? "retro_title = {:id} && finish = {:completeness}"
      : "retro_title = {:id}";
    const params = completeness ? { id: retroId, completeness: completeness } : { id: retroId };
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("price_snapshots", filter, "-fetched_at", 100, 0, params);
    } catch (err) {
      rows = [];
    }

    const candidates = rows.map(policy.candidateFromSnapshot);
    const now = new Date();
    const result = policy.choose(candidates, priority, now);

    return e.json(200, { chosen: result.chosen, sources: result.sources, condition_adjusted: null });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/retro/{id}/refresh-prices   { completeness }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/retro/{id}/refresh-prices",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

    const retroId = e.request.pathValue("id");
    let title = null;
    try {
      title = e.app.findRecordById("retro_titles", retroId);
    } catch (err) {
      throw e.notFoundError("Retro title not found. Check the id or add it manually.", null);
    }

    const body = util.body(e);
    const completeness = util.asStr(body.completeness) || "loose";

    const settingsRow = util.settings(e.app);
    const apiKeys = (settingsRow && util.jsonField(settingsRow, "api_keys", {})) || {};
    const pricechartingKey = apiKeys.pricecharting;
    // PriceCharting is the one source this route exists to call - a clean
    // refusal up front (rather than silently doing nothing useful, or
    // silently falling back to eBay alone) matches "validate first, write
    // second" (pb/README.md).
    if (!pricechartingKey) {
      throw e.error(
        422,
        "PriceCharting is not set up. Add the key in Settings or enter a UK comp.",
        null
      );
    }

    let platformRow = null;
    try {
      platformRow = e.app.findRecordById("platforms", title.getString("platform"));
    } catch (err) {
      platformRow = null;
    }
    const platformKey = platformRow ? platformRow.getString("key") : "";

    const fxRates = policy.latestFxRates(e.app);
    const now = new Date();

    let raw = [];
    try {
      const pricecharting = require(`${__hooks}/adapters/pricecharting.js`);
      raw =
        pricecharting.getPrices(pricechartingKey, title.getString("name"), platformKey, completeness) ||
        [];
    } catch (err) {
      console.log(`[prices] pricecharting getPrices failed for retro_title ${retroId}: ${err}`);
      raw = [];
    }

    if (apiKeys.ebay && apiKeys.ebay.client_id && apiKeys.ebay.client_secret) {
      try {
        const ebay = require(`${__hooks}/adapters/ebay.js`);
        const statestore = require(`${__hooks}/adapters/statestore.js`);
        const queryText = [title.getString("name"), completeness].filter(Boolean).join(" ");
        const cacheKey = `retro:${retroId}:${completeness}`;
        const ebayRows = ebay.getPrices(
          statestore.forApp(e.app),
          apiKeys.ebay,
          queryText,
          cacheKey,
          ebay.haircutPctFromSettings(e.app)
        );
        raw = raw.concat(ebayRows);
      } catch (err) {
        console.log(`[prices] ebay getPrices failed for retro_title ${retroId}: ${err}`);
      }
    }

    for (let i = 0; i < raw.length; i++) {
      const snapshot = policy.fromAdapterCandidate(raw[i], fxRates, now);
      if (!snapshot) continue;
      policy.writeSnapshot(e.app, {
        retroTitle: retroId,
        finish: completeness,
        source: snapshot.source,
        nativeCurrency: snapshot.nativeCurrency,
        nativeLow: snapshot.nativeLow,
        nativeMid: snapshot.nativeMid,
        nativeMarket: snapshot.nativeMarket,
        nativeTrend: snapshot.nativeTrend,
        fxRate: snapshot.fxRate,
        fxDate: snapshot.fxDate,
        gbpMarket: snapshot.gbpMarket,
        fetchedAt: snapshot.fetchedAt,
        evidenceUrl: snapshot.evidenceUrl,
      });
    }

    // Same body as the GET, read straight back from what was just written.
    const priority =
      (settingsRow && util.jsonField(settingsRow, "retro_source_priority", null)) ||
      pricingShared.DEFAULT_RETRO_PRIORITY;
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "price_snapshots",
        "retro_title = {:id} && finish = {:completeness}",
        "-fetched_at",
        100,
        0,
        { id: retroId, completeness: completeness }
      );
    } catch (err) {
      rows = [];
    }
    const candidates = rows.map(policy.candidateFromSnapshot);
    const result = policy.choose(candidates, priority, now);

    return e.json(200, { chosen: result.chosen, sources: result.sources, condition_adjusted: null });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/retro/{id}/uk-comp   { completeness, price, url, sold_at }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/retro/{id}/uk-comp",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

    const staff = e.auth;
    const retroId = e.request.pathValue("id");
    try {
      e.app.findRecordById("retro_titles", retroId);
    } catch (err) {
      throw e.notFoundError("Retro title not found. Check the id or add it manually.", null);
    }

    const body = util.body(e);
    // completeness stands in for finish/condition here - retro has neither
    // (docs/api-contract.md's Phase 3 section).
    const completeness = util.asStr(body.completeness) || "loose";
    const price = util.asInt(body.price, -1);
    const url = util.asStr(body.url);
    const soldAt = util.asStr(body.sold_at);

    if (price < 0) {
      throw e.badRequestError("Enter the sold price in pence.", null);
    }
    if (!/^https:\/\/(www\.)?ebay\.co\.uk\/itm\//i.test(url)) {
      throw e.badRequestError(
        "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...).",
        null
      );
    }
    const soldDate = new Date(soldAt + "T00:00:00.000Z");
    if (isNaN(soldDate.getTime())) {
      throw e.badRequestError("Enter the date it sold, as YYYY-MM-DD.", null);
    }
    const now = new Date();
    if (soldDate.getTime() > now.getTime()) {
      throw e.badRequestError("That sale date is in the future.", null);
    }
    const daysOld = (now.getTime() - soldDate.getTime()) / 86400000;
    if (daysOld > 30) {
      throw e.badRequestError(
        "That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days.",
        null
      );
    }

    let snapshot = null;
    e.app.runInTransaction((txApp) => {
      snapshot = policy.writeSnapshot(txApp, {
        retroTitle: retroId,
        finish: completeness,
        source: "uk_sold_manual",
        nativeCurrency: "GBP",
        nativeLow: price,
        nativeMid: price,
        nativeMarket: price,
        nativeTrend: price,
        fxRate: 1,
        fxDate: soldAt,
        gbpMarket: price,
        fetchedAt: soldDate.toISOString(),
        evidenceUrl: url,
      });

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "uk_comp",
        collection: "price_snapshots",
        record: snapshot.id,
        meta: { retro_title: retroId, completeness: completeness, price: price },
        ip: e.realIP(),
      });
    });

    const settingsRow = util.settings(e.app);
    const priority =
      (settingsRow && util.jsonField(settingsRow, "retro_source_priority", null)) ||
      pricingShared.DEFAULT_RETRO_PRIORITY;
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "price_snapshots",
        "retro_title = {:id} && finish = {:completeness}",
        "-fetched_at",
        100,
        0,
        { id: retroId, completeness: completeness }
      );
    } catch (err) {
      rows = [];
    }
    const candidates = rows.map(policy.candidateFromSnapshot);
    const result = policy.choose(candidates, priority, now);

    return e.json(200, { chosen: result.chosen, sources: result.sources, condition_adjusted: null });
  },
  $apis.requireAuth("staff")
);
