// PocketBase glue for vault_snapshots.pb.js: snapshotting one card through
// the existing adapters (its game's catalogue adapter, eBay when a key is
// set), seeding the Cardmarket trend points once, the daily job's card
// selection, the "already hold" count and the grading fee config. Required
// inside each handler body, like every other pb_hooks module.
"use strict";

function util() {
  return require(__hooks + "/lib/vaultutil.js");
}

function pure() {
  return require(__hooks + "/lib/vault_snapshots.js");
}

/** settings.grading with every default filled in, so a half-edited row still prices. */
var GRADING_DEFAULTS = {
  ace_standard_pence: 1500,
  psa_value_pence: 2500,
  postage_pence: 800,
  min_profit_pence: 1000,
  fees_checked_on: "",
};

function gradingConfig(app, settingsRow) {
  var u = util();
  var row = settingsRow || u.settings(app);
  var raw = row ? u.jsonField(row, "grading", null) : null;
  var out = {};
  for (var key in GRADING_DEFAULTS) {
    var value = raw && raw[key];
    if (key === "fees_checked_on") out[key] = u.asStr(value).slice(0, 10);
    else out[key] = Math.max(0, u.asInt(value, GRADING_DEFAULTS[key]));
  }
  return out;
}

/** Items still held against a card: in stock, reserved or listed on eBay. */
function heldCount(app, cardId) {
  if (!cardId) return 0;
  try {
    return app.findRecordsByFilter(
      "items",
      "card = {:card} && (status = 'in_stock' || status = 'reserved' || status = 'listed_ebay')",
      "",
      0,
      0,
      { card: cardId }
    ).length;
  } catch (err) {
    return 0;
  }
}

/** One card_scans row, best effort: a failure never fails the scan it records. */
function recordScan(app, cardId, staffId, kind) {
  if (!cardId) return;
  try {
    var record = new Record(app.findCollectionByNameOrId("card_scans"), {
      card: cardId,
      staff: staffId || "",
      kind: kind || "view",
    });
    app.save(record);
  } catch (err) {
    console.log("[vault_snapshots] could not record a card scan: " + err);
  }
}

/** The adapter_state stamp a snapshot leaves, so the same card is not read twice in a day. */
function stampKey(cardId) {
  return "cardintel_snapshot:" + cardId;
}

/**
 * Snapshot one card: its game's adapter for the spot Cardmarket and
 * TCGplayer figures (converted to GBP through the latest FX row, exactly as
 * refresh-prices does), the Cardmarket averages seeded once as dated trend
 * points, and the three graded slabs from UK eBay listings when a key is
 * set. Rate limited through an adapter_state stamp of SNAPSHOT_TTL_HOURS;
 * `force` ignores it (an admin's manual run). Returns what happened, never
 * throws for one card.
 */
function snapshotCard(app, card, opts) {
  var p = pure();
  var u = util();
  var policy = require(__hooks + "/adapters/pricing_policy.js");
  var registry = require(__hooks + "/adapters/registry.js");
  var statestore = require(__hooks + "/adapters/statestore.js");
  var scanDb = require(__hooks + "/lib/vault_scan_db.js");
  var options = opts || {};
  var now = options.now || new Date();
  var store = statestore.forApp(app);
  var result = { card: card.id, written: 0, seeded: 0, graded: 0, skipped: false, ebay: "off", errors: [] };

  if (!options.force && store.get(stampKey(card.id))) {
    result.skipped = true;
    return result;
  }

  var settingsRow = options.settingsRow || u.settings(app);
  var apiKeys = (settingsRow && u.jsonField(settingsRow, "api_keys", {})) || {};
  var fxRates = options.fxRates || policy.latestFxRates(app);

  var cardSet = null;
  try {
    cardSet = app.findRecordById("card_sets", card.getString("set"));
  } catch (err) {
    cardSet = null;
  }
  var gameRow = null;
  try {
    gameRow = app.findRecordById("games", card.getString("game"));
  } catch (err) {
    gameRow = null;
  }
  var gameKey = gameRow ? gameRow.getString("key") : "";
  var finish = scanDb.marketFor(app, card).finish || "";

  // Spot prices from the game's own adapter.
  var raw = [];
  var adapter = registry.adapterForGame(gameKey);
  if (adapter && adapter.getPrices) {
    try {
      raw = adapter.getPrices(
        {
          setCode: cardSet ? cardSet.getString("code") : "",
          number: card.getString("number"),
          externalIds: u.jsonField(card, "external_ids", {}) || {},
        },
        finish
      ) || [];
    } catch (err) {
      result.errors.push(gameKey + " getPrices: " + err);
      raw = [];
    }
  }

  var hasSeed = false;
  try {
    hasSeed =
      app.findRecordsByFilter("price_snapshots", "card = {:card} && finish = {:finish} && basis != ''", "", 1, 0, {
        card: card.id,
        finish: finish,
      }).length > 0;
  } catch (err) {
    hasSeed = false;
  }

  if (raw.length && !fxRates) {
    // Cardmarket and TCGplayer are foreign; with no fx_rates row yet (the
    // 07:00 fx cron has not run on a fresh install) every one is dropped
    // rather than converted by guesswork. Say so instead of writing nothing silently.
    result.errors.push("no FX rate stored yet: foreign prices skipped until the fx cron has run");
  }
  for (var i = 0; i < raw.length; i++) {
    var snapshot = policy.fromAdapterCandidate(raw[i], fxRates, now);
    if (!snapshot) continue;
    var written = policy.writeSnapshotSafely(app, {
      card: card.id,
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
      fetchedAt: now.toISOString(),
      evidenceUrl: snapshot.evidenceUrl,
    });
    if (written) result.written += 1;

    // The Cardmarket averages, once per card and finish: three dated
    // points, each the average of its own window placed at that window's
    // middle, labelled by `basis` so a reader knows what it is.
    if (raw[i].source === "cardmarket" && raw[i].averages && !hasSeed) {
      var points = p.seedPoints(raw[i].averages);
      for (var j = 0; j < points.length; j++) {
        var seed = policy.fromAdapterCandidate(
          { source: "cardmarket", currency: "EUR", low: null, mid: null, market: points[j].value, trend: null, evidenceUrl: "" },
          fxRates,
          now
        );
        if (!seed) continue;
        var seedRow = policy.writeSnapshotSafely(app, {
          card: card.id,
          finish: finish,
          source: "cardmarket",
          nativeCurrency: "EUR",
          nativeMarket: seed.nativeMarket,
          fxRate: seed.fxRate,
          fxDate: seed.fxDate,
          gbpMarket: seed.gbpMarket,
          fetchedAt: p.daysBefore(now, points[j].daysAgo),
          evidenceUrl: "",
          basis: points[j].basis,
        });
        if (seedRow) result.seeded += 1;
      }
      hasSeed = true;
    }
  }

  // Graded slabs from UK listings, when the shop has an eBay key.
  if (apiKeys.ebay && apiKeys.ebay.client_id && apiKeys.ebay.client_secret) {
    result.ebay = "on";
    try {
      var ebay = require(__hooks + "/adapters/ebay.js");
      var words = p.ebayWords({
        name: card.getString("name"),
        setName: cardSet ? cardSet.getString("name") : "",
        number: card.getString("number"),
        finish: finish,
      });
      var gradedRows = ebay.getGradedPrices(store, apiKeys.ebay, words, "card:" + card.id + ":" + finish, ebay.haircutPctFromSettings(app), !!options.force);
      for (var g = 0; g < gradedRows.length; g++) {
        var gradedSnapshot = policy.fromAdapterCandidate(gradedRows[g], fxRates, now);
        if (!gradedSnapshot) continue;
        var gradedWritten = policy.writeSnapshotSafely(app, {
          card: card.id,
          finish: finish,
          source: gradedSnapshot.source,
          nativeCurrency: "GBP",
          nativeLow: gradedSnapshot.nativeLow,
          nativeMid: gradedSnapshot.nativeMid,
          nativeMarket: gradedSnapshot.nativeMarket,
          fxRate: 1,
          fxDate: gradedSnapshot.fxDate,
          gbpMarket: gradedSnapshot.gbpMarket,
          fetchedAt: now.toISOString(),
          evidenceUrl: gradedSnapshot.evidenceUrl,
          grader: gradedRows[g].grader,
          grade: gradedRows[g].grade,
        });
        if (gradedWritten) result.graded += 1;
      }
    } catch (err) {
      result.errors.push("ebay graded: " + err);
    }
  }

  store.set(stampKey(card.id), { at: now.toISOString(), written: result.written, graded: result.graded }, new Date(now.getTime() + p.SNAPSHOT_TTL_HOURS * 3600000).toISOString());
  return result;
}

function ids(rows, field) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var value = rows[i] && rows[i].getString(field);
    if (value) out.push(value);
  }
  return out;
}

/** The three pools the daily job selects from: held stock, open deal lines, cards scanned lately. */
function cardPools(app, now) {
  var p = pure();
  var stock = [];
  var deals = [];
  var scans = [];
  try {
    stock = ids(
      app.findRecordsByFilter("items", "card != '' && (status = 'in_stock' || status = 'reserved' || status = 'listed_ebay')", "-updated", 2000, 0),
      "card"
    );
  } catch (err) {
    console.log("[vault_snapshots] stock pool failed: " + err);
  }
  try {
    var open = app.findRecordsByFilter("trade_ins", "status = 'draft' || status = 'offered' || status = 'accepted'", "-updated", 300, 0);
    for (var i = 0; i < open.length; i++) {
      if (!open[i]) continue;
      var lines = app.findRecordsByFilter("trade_in_lines", "trade_in = {:deal} && card != ''", "", 200, 0, { deal: open[i].id });
      deals = deals.concat(ids(lines, "card"));
    }
  } catch (err) {
    console.log("[vault_snapshots] deals pool failed: " + err);
  }
  try {
    var since = p.pbDate(new Date(now.getTime() - p.SCAN_WINDOW_DAYS * 86400000));
    scans = ids(app.findRecordsByFilter("card_scans", "created >= {:since}", "-created", 2000, 0, { since: since }), "card");
  } catch (err) {
    console.log("[vault_snapshots] scans pool failed: " + err);
  }
  return { stock: stock, deals: deals, scans: scans };
}

/** Card ids stamped as snapshotted inside the TTL, so a run never reads them again. */
function recentlyDone(app, cardIds) {
  var statestore = require(__hooks + "/adapters/statestore.js");
  var store = statestore.forApp(app);
  var done = [];
  for (var i = 0; i < cardIds.length; i++) {
    if (store.get(stampKey(cardIds[i]))) done.push(cardIds[i]);
  }
  return done;
}

/** The daily job: select, then snapshot each card in turn. One bad card never stops the rest. */
function runDaily(app, now, force) {
  var p = pure();
  var u = util();
  var policy = require(__hooks + "/adapters/pricing_policy.js");
  var at = now || new Date();
  var pools = cardPools(app, at);
  var all = pools.stock.concat(pools.deals, pools.scans);
  var selection = p.selectCards(pools, force ? [] : recentlyDone(app, all), p.RUN_LIMIT);
  var settingsRow = u.settings(app);
  var fxRates = policy.latestFxRates(app);
  var summary = { selected: selection.cards.length, candidates: selection.total, capped: selection.capped, written: 0, seeded: 0, graded: 0, skipped: 0, failed: 0 };
  for (var i = 0; i < selection.cards.length; i++) {
    var card = null;
    try {
      card = app.findRecordById("cards", selection.cards[i].id);
    } catch (err) {
      summary.failed += 1;
      continue;
    }
    var result = snapshotCard(app, card, { now: at, settingsRow: settingsRow, fxRates: fxRates, force: !!force });
    summary.written += result.written;
    summary.seeded += result.seeded;
    summary.graded += result.graded;
    if (result.skipped) summary.skipped += 1;
    if (result.errors.length) summary.failed += 1;
  }
  return summary;
}

module.exports = {
  GRADING_DEFAULTS: GRADING_DEFAULTS,
  gradingConfig: gradingConfig,
  heldCount: heldCount,
  recordScan: recordScan,
  stampKey: stampKey,
  snapshotCard: snapshotCard,
  cardPools: cardPools,
  runDaily: runDaily,
};
