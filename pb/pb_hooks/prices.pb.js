/// <reference path="../pb_data/types.d.ts" />

/**
 * prices.pb.js - card and retro-title valuation
 * (docs/api-contract.md, "Phase 3: lookup, prices and FX"):
 *
 *   GET  /api/vault/cards/:id/prices?finish=&condition=
 *   POST /api/vault/cards/:id/refresh-prices   { finish, condition }
 *   POST /api/vault/cards/:id/uk-comp          { finish, condition, price, url, sold_at }
 *   GET  /api/vault/retro/:id/prices?completeness=
 *   POST /api/vault/retro/:id/refresh-prices   { completeness }
 *   POST /api/vault/retro/:id/uk-comp          { completeness, price, url, sold_at }
 *
 * The GET routes only ever read `price_snapshots` - no adapter is called,
 * so a normal price check never makes an outbound call (pb/scripts/check.sh
 * runs these under a transport override to prove it). Only the
 * `refresh-prices` and `uk-comp` routes write anything: refresh-prices
 * calls every enabled adapter for the card's game (or PriceCharting for
 * retro) plus eBay, and uk-comp is a staff-entered row that needs no
 * adapter at all.
 *
 * `price_snapshots.finish` is reused for retro's "completeness"
 * (loose/boxed/cib) rather than adding a second column that would mean the
 * same thing for the other kind of row - see docs/PLAN.md's data model,
 * which gives price_snapshots one such column, not two. Every filter on it
 * below matches the exact value (`""` when the caller sends none), rather
 * than leaving it out of the filter: an unfiltered read would mix every
 * finish's snapshots together into one chosen price.
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
    try {
      e.app.findRecordById("cards", cardId);
    } catch (err) {
      throw e.notFoundError("Card not found. Check the id or add it manually.", null);
    }

    const finish = queryParam("finish");
    const condition = policy.normalizeCondition(queryParam("condition"));
    if (condition === null) {
      throw e.badRequestError("Pick a condition: NM, LP, MP, HP or DMG.", null);
    }

    const settingsRow = util.settings(e.app);
    const priority = pricingPriority(util, settingsRow);
    const multipliers = conditionMultipliers(util, settingsRow);

    const candidates = snapshotsFor(e.app, policy, "card", cardId, finish);
    const now = new Date();
    const result = policy.choose(candidates, priority, now);
    const conditionAdjusted = result.chosen
      ? policy.adjustForConditionSafe(result.chosen.gbp_market, condition, multipliers)
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
// POST /api/vault/cards/{id}/refresh-prices   { finish, condition }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cards/{id}/refresh-prices",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);
    const registry = require(`${__hooks}/adapters/registry.js`);

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
    const condition = policy.normalizeCondition(util.asStr(body.condition));
    if (condition === null) {
      throw e.badRequestError("Pick a condition: NM, LP, MP, HP or DMG.", null);
    }

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
        const queryText = [
          card.getString("name"),
          cardSet ? cardSet.getString("name") : "",
          card.getString("number"),
          finish,
          condition,
        ]
          .filter(Boolean)
          .join(" ");
        const cacheKey = `card:${cardId}:${finish}:${condition}`;
        const ebayRows = ebay.getPrices(
          statestore.forApp(e.app),
          apiKeys.ebay,
          queryText,
          cacheKey,
          ebay.haircutPctFromSettings(e.app),
          true // refresh-prices bypasses eBay's own 24-hour cache
        );
        raw = raw.concat(ebayRows);
      } catch (err) {
        console.log(`[prices] ebay getPrices failed for card ${cardId}: ${err}`);
      }
    }

    const sourcesWritten = [];
    for (let i = 0; i < raw.length; i++) {
      const snapshot = policy.fromAdapterCandidate(raw[i], fxRates, now);
      if (!snapshot) continue;
      const written = policy.writeSnapshotSafely(e.app, {
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
      if (written) sourcesWritten.push(snapshot.source);
    }

    auditLib.writeAuditLog(e.app, {
      actor: e.auth.id,
      action: "refresh_prices",
      collection: "cards",
      record: cardId,
      meta: { finish: finish, sources: sourcesWritten },
      ip: e.realIP(),
    });

    // Same body as the GET, read straight back from what was just written.
    const priority = pricingPriority(util, settingsRow);
    const multipliers = conditionMultipliers(util, settingsRow);
    const candidates = snapshotsFor(e.app, policy, "card", cardId, finish);
    const result = policy.choose(candidates, priority, now);
    const conditionAdjusted = result.chosen
      ? policy.adjustForConditionSafe(result.chosen.gbp_market, condition, multipliers)
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

    const staff = e.auth;
    const cardId = e.request.pathValue("id");
    try {
      e.app.findRecordById("cards", cardId);
    } catch (err) {
      throw e.notFoundError("Card not found. Check the id or add it manually.", null);
    }

    const body = util.body(e);
    const finish = util.asStr(body.finish);
    const condition = policy.normalizeCondition(util.asStr(body.condition));
    if (condition === null) {
      throw e.badRequestError("Pick a condition: NM, LP, MP, HP or DMG.", null);
    }

    const ukComp = validateUkComp(e, util, body);

    let snapshot = null;
    e.app.runInTransaction((txApp) => {
      snapshot = policy.writeSnapshot(txApp, {
        card: cardId,
        finish: finish,
        source: "uk_sold_manual",
        nativeCurrency: "GBP",
        nativeLow: ukComp.price,
        nativeMid: ukComp.price,
        nativeMarket: ukComp.price,
        nativeTrend: ukComp.price,
        fxRate: 1,
        fxDate: ukComp.soldAt,
        gbpMarket: ukComp.price,
        fetchedAt: ukComp.soldDate.toISOString(),
        evidenceUrl: ukComp.url,
      });

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "uk_comp",
        collection: "price_snapshots",
        record: snapshot.id,
        meta: { card: cardId, finish: finish, condition: condition, price: ukComp.price },
        ip: e.realIP(),
      });
    });

    const settingsRow = util.settings(e.app);
    const priority = pricingPriority(util, settingsRow);
    const multipliers = conditionMultipliers(util, settingsRow);
    const candidates = snapshotsFor(e.app, policy, "card", cardId, finish);
    const now = new Date();
    const result = policy.choose(candidates, priority, now);
    const conditionAdjusted = result.chosen
      ? policy.adjustForConditionSafe(result.chosen.gbp_market, condition, multipliers)
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
    const priority = retroPriority(util, settingsRow);

    const candidates = snapshotsFor(e.app, policy, "retro_title", retroId, completeness);
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
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);

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
          ebay.haircutPctFromSettings(e.app),
          true // refresh-prices bypasses eBay's own 24-hour cache
        );
        raw = raw.concat(ebayRows);
      } catch (err) {
        console.log(`[prices] ebay getPrices failed for retro_title ${retroId}: ${err}`);
      }
    }

    const sourcesWritten = [];
    for (let i = 0; i < raw.length; i++) {
      const snapshot = policy.fromAdapterCandidate(raw[i], fxRates, now);
      if (!snapshot) continue;
      const written = policy.writeSnapshotSafely(e.app, {
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
      if (written) sourcesWritten.push(snapshot.source);
    }

    auditLib.writeAuditLog(e.app, {
      actor: e.auth.id,
      action: "refresh_prices",
      collection: "retro_titles",
      record: retroId,
      meta: { completeness: completeness, sources: sourcesWritten },
      ip: e.realIP(),
    });

    // Same body as the GET, read straight back from what was just written.
    const priority = retroPriority(util, settingsRow);
    const candidates = snapshotsFor(e.app, policy, "retro_title", retroId, completeness);
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
    const ukComp = validateUkComp(e, util, body);

    let snapshot = null;
    e.app.runInTransaction((txApp) => {
      snapshot = policy.writeSnapshot(txApp, {
        retroTitle: retroId,
        finish: completeness,
        source: "uk_sold_manual",
        nativeCurrency: "GBP",
        nativeLow: ukComp.price,
        nativeMid: ukComp.price,
        nativeMarket: ukComp.price,
        nativeTrend: ukComp.price,
        fxRate: 1,
        fxDate: ukComp.soldAt,
        gbpMarket: ukComp.price,
        fetchedAt: ukComp.soldDate.toISOString(),
        evidenceUrl: ukComp.url,
      });

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "uk_comp",
        collection: "price_snapshots",
        record: snapshot.id,
        meta: { retro_title: retroId, completeness: completeness, price: ukComp.price },
        ip: e.realIP(),
      });
    });

    const settingsRow = util.settings(e.app);
    const priority = retroPriority(util, settingsRow);
    const candidates = snapshotsFor(e.app, policy, "retro_title", retroId, completeness);
    const now = new Date();
    const result = policy.choose(candidates, priority, now);

    return e.json(200, { chosen: result.chosen, sources: result.sources, condition_adjusted: null });
  },
  $apis.requireAuth("staff")
);
