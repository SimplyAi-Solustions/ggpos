// The valuation policy behind GET/POST /api/vault/cards/:id/prices and
// /api/vault/retro/:id/prices: turning `price_snapshots` rows (or a fresh
// adapter candidate) into packages/shared/src/pricing.ts's PriceCandidate
// shape, running the shared chooseMarketPrice exactly as docs/PLAN.md's
// "Market value, UK first, always in GBP" describes, and shaping the
// result into docs/api-contract.md's Phase 3 response rows. Required fresh
// inside every handler body, like every other pb_hooks module.
"use strict";

/**
 * Freshness windows this build uses (docs/api-contract.md's Phase 3
 * section): UK sold comp 30 days, eBay asking 24 hours, Cardmarket and
 * TCGplayer 3 days, PriceCharting (either region) 3 days. Deliberately not
 * packages/shared/src/pricing.ts's own DEFAULT_FRESHNESS (its
 * ebay_uk_asking is 48 hours) - chooseMarketPrice takes a policy as its
 * fourth argument for exactly this reason, so the contract's own numbers
 * are what actually govern here rather than that module's general default.
 */
var FRESHNESS = {
  maxAgeHours: {
    uk_sold_manual: 30 * 24,
    ebay_uk_asking: 24,
    cardmarket: 72,
    tcgplayer: 72,
    pricecharting_pal: 72,
    pricecharting_ntsc: 72,
  },
};

/** A saved price_snapshots record as packages/shared/src/pricing.ts's PriceCandidate. */
function candidateFromSnapshot(row) {
  var fxRateRaw = row.get("fx_rate");
  return {
    source: row.getString("source"),
    gbpMarket: row.getInt("gbp_market"),
    fetchedAt: row.getString("fetched_at"),
    nativeCurrency: row.getString("native_currency"),
    nativeAmount: row.getInt("native_market"),
    fxRate: fxRateRaw || null,
    fxDate: row.getString("fx_date") || null,
    evidenceUrl: row.getString("evidence_url") || "",
  };
}

/** One PriceCandidate as a docs/api-contract.md Phase 3 response row. */
function toRow(candidate, stale) {
  return {
    source: candidate.source,
    gbp_market: candidate.gbpMarket,
    native_currency: candidate.nativeCurrency,
    native_market: candidate.nativeAmount,
    fx_rate: candidate.fxRate,
    fx_date: candidate.fxDate,
    fetched_at: candidate.fetchedAt,
    stale: stale,
    evidence_url: candidate.evidenceUrl || "",
  };
}

/**
 * candidates: PriceCandidate[]; priority: PriceSource[] (settings.source_priority
 * or .retro_source_priority). Returns { chosen: row|null, sources: row[] },
 * "sources" being one row per source that has a value, in priority order,
 * every stale one flagged rather than hidden (docs/api-contract.md).
 */
function choose(candidates, priority, now) {
  var pricing = require(__hooks + "/lib/shared/pricing.js");
  var result = pricing.chooseMarketPrice(candidates, priority, now, FRESHNESS);

  var sources = result.considered.map(function (entry) {
    return toRow(entry.candidate, entry.status === "stale");
  });

  var chosenRow = null;
  if (result.chosen) {
    var found = null;
    for (var i = 0; i < result.considered.length; i++) {
      if (result.considered[i].candidate === result.chosen) {
        found = result.considered[i];
        break;
      }
    }
    // chooseMarketPrice's own fallback path (nothing at all was fresh) sets
    // `chosen` without an entry in `considered` only when a candidate for a
    // source outside `priority` was the overall freshest - vanishingly
    // unlikely (every source this build writes is in the seeded priority
    // list) but handled rather than silently dropped, per "stale rows are
    // still returned and flagged, never hidden".
    chosenRow = toRow(result.chosen, found ? found.status === "stale" : true);
    if (!found) sources.push(chosenRow);
  }

  return { chosen: chosenRow, sources: sources };
}

/** Write one price_snapshots row and hand back its id. */
function writeSnapshot(app, params) {
  var record = new Record(app.findCollectionByNameOrId("price_snapshots"), {
    card: params.card || "",
    retro_title: params.retroTitle || "",
    finish: params.finish || "",
    source: params.source,
    native_currency: params.nativeCurrency,
    native_low: params.nativeLow || 0,
    native_mid: params.nativeMid || 0,
    native_market: params.nativeMarket || 0,
    native_trend: params.nativeTrend || 0,
    fx_rate: params.fxRate === null || params.fxRate === undefined ? null : params.fxRate,
    fx_date: params.fxDate || null,
    gbp_market: params.gbpMarket,
    fetched_at: params.fetchedAt,
    evidence_url: params.evidenceUrl || "",
  });
  app.save(record);
  return record;
}

/**
 * One adapter's raw candidate ({source, currency, low, mid, market, trend,
 * fetchedAt, evidenceUrl}) turned into writeSnapshot()'s param shape, with
 * the GBP conversion done exactly once, here. Every native amount is a
 * decimal string parsed with packages/shared/src/money.ts's
 * parseDecimalToMinor, except PriceCharting's `pricecharting_pal` /
 * `pricecharting_ntsc`, which arrive as integer US cents and are never
 * turned into a string first (CLAUDE.md, "Pricing"). Returns null when the
 * candidate has no usable market figure, or a foreign amount with no FX
 * rate available yet to convert it.
 *
 * `fxRates` is `{ EUR: <gbp per EUR>, USD: <gbp per USD>, date: "..." }`
 * (adapters/frankfurter.js's own convention - GBP per one unit of the
 * foreign currency, never the other way round).
 */
function fromAdapterCandidate(raw, fxRates, now) {
  var money = require(__hooks + "/lib/shared/money.js");
  var isCents = raw.source === "pricecharting_pal" || raw.source === "pricecharting_ntsc";

  function toMinor(v) {
    if (v === null || v === undefined) return null;
    return isCents ? Math.round(Number(v)) : money.parseDecimalToMinor(String(v));
  }

  var nativeLow = toMinor(raw.low);
  var nativeMid = toMinor(raw.mid);
  var nativeMarket = toMinor(raw.market);
  var nativeTrend = toMinor(raw.trend);
  if (nativeMarket === null) return null;

  var gbpMarket, fxRate, fxDate;
  if (raw.currency === "GBP") {
    gbpMarket = nativeMarket;
    fxRate = 1;
    fxDate = now.toISOString().slice(0, 10);
  } else {
    var rate = fxRates && fxRates[raw.currency];
    if (!rate) return null; // cannot convert safely without a rate
    fxRate = rate;
    fxDate = (fxRates && fxRates.date) || now.toISOString().slice(0, 10);
    gbpMarket = isCents
      ? money.usdCentsToGbpPence(nativeMarket, rate)
      : money.convertMinorToGbpPence(nativeMarket, raw.currency, rate);
  }

  return {
    source: raw.source,
    nativeCurrency: raw.currency,
    nativeLow: nativeLow,
    nativeMid: nativeMid,
    nativeMarket: nativeMarket,
    nativeTrend: nativeTrend,
    fxRate: fxRate,
    fxDate: fxDate,
    gbpMarket: gbpMarket,
    fetchedAt: raw.fetchedAt || now.toISOString(),
    evidenceUrl: raw.evidenceUrl || "",
  };
}

/** The same snapshot-shaped object as a PriceCandidate, before it is even saved. */
function snapshotToCandidate(snapshot) {
  return {
    source: snapshot.source,
    gbpMarket: snapshot.gbpMarket,
    fetchedAt: snapshot.fetchedAt,
    nativeCurrency: snapshot.nativeCurrency,
    nativeAmount: snapshot.nativeMarket,
    fxRate: snapshot.fxRate,
    fxDate: snapshot.fxDate,
    evidenceUrl: snapshot.evidenceUrl,
  };
}

/** The latest fx_rates row as {EUR, USD, date}, or null when there are no rows at all. */
function latestFxRates(app) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("fx_rates", "id != ''", "-fetched_at", 1, 0);
  } catch (err) {
    rows = [];
  }
  if (!rows[0]) return null;
  var util = require(__hooks + "/lib/vaultutil.js");
  var quotes = util.jsonField(rows[0], "quotes", {}) || {};
  return {
    EUR: quotes.EUR || null,
    USD: quotes.USD || null,
    date: rows[0].getString("fetched_at").slice(0, 10),
  };
}

module.exports = {
  FRESHNESS: FRESHNESS,
  candidateFromSnapshot: candidateFromSnapshot,
  toRow: toRow,
  choose: choose,
  writeSnapshot: writeSnapshot,
  fromAdapterCandidate: fromAdapterCandidate,
  snapshotToCandidate: snapshotToCandidate,
  latestFxRates: latestFxRates,
};
