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

  // A "Minor" sibling field (eBay's marketMinor/midMinor/lowMinor/trendMinor
  // - see adapters/ebay.js) carries an integer already in minor units and
  // is taken as-is: turning an already-integer GBP figure into a decimal
  // string and back only risks a float round-trip for nothing.
  function toMinor(field, minorField) {
    var direct = raw[minorField];
    if (direct !== undefined && direct !== null) return Math.round(Number(direct));
    var v = raw[field];
    if (v === null || v === undefined) return null;
    return isCents ? Math.round(Number(v)) : money.parseDecimalToMinor(String(v));
  }

  var nativeLow = toMinor("low", "lowMinor");
  var nativeMid = toMinor("mid", "midMinor");
  var nativeMarket = toMinor("market", "marketMinor");
  var nativeTrend = toMinor("trend", "trendMinor");
  if (nativeMarket === null) {
    console.log(
      `[pricing_policy] dropped a ${raw.source || "unknown"} candidate: unparseable market value "${raw.market}"`
    );
    return null;
  }
  if (nativeMarket < 0) {
    console.log(`[pricing_policy] dropped a ${raw.source || "unknown"} candidate: negative market value ${nativeMarket}`);
    return null;
  }

  var gbpMarket, fxRate, fxDate;
  if (raw.currency === "GBP") {
    gbpMarket = nativeMarket;
    fxRate = 1;
    fxDate = now.toISOString().slice(0, 10);
  } else {
    var rate = fxRates && fxRates[raw.currency];
    if (!rate) return null; // cannot convert safely without a rate - stays silent, per the contract
    fxRate = rate;
    fxDate = (fxRates && fxRates.date) || now.toISOString().slice(0, 10);
    gbpMarket = isCents
      ? money.usdCentsToGbpPence(nativeMarket, rate)
      : money.convertMinorToGbpPence(nativeMarket, raw.currency, rate);
  }

  // A non-http(s) evidence URL is dropped, not the whole candidate - the
  // price itself is still usable without a link to show for it.
  var evidenceUrl = raw.evidenceUrl || "";
  if (evidenceUrl && !/^https?:\/\//i.test(evidenceUrl)) evidenceUrl = "";

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
    evidenceUrl: evidenceUrl,
  };
}

/**
 * writeSnapshot, but never throws: an untrusted adapter candidate can carry
 * a value that fails price_snapshots' own field validation even after
 * fromAdapterCandidate's checks (an oversized number, for instance) - this
 * logs and skips that one row rather than failing an entire refresh-prices
 * batch over it.
 */
function writeSnapshotSafely(app, params) {
  try {
    return writeSnapshot(app, params);
  } catch (err) {
    console.log(`[pricing_policy] could not write a ${params.source || "unknown"} snapshot: ${err}`);
    return null;
  }
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

/**
 * The latest fx_rates row as {EUR, USD, date}, or null when there are no
 * rows at all. `date` prefers the row's own `date` column (the ECB rate's
 * own date, stamped by crons.pb.js's fx cron from Frankfurter's response)
 * and falls back to `fetched_at` only for a row written before that column
 * existed - fetch time is wrong at a weekend or a bank holiday, when
 * Frankfurter keeps serving Friday's rate under today's date.
 */
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
  var ownDate = rows[0].getString("date");
  return {
    EUR: quotes.EUR || null,
    USD: quotes.USD || null,
    date: ownDate || rows[0].getString("fetched_at").slice(0, 10),
  };
}

var VALID_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

/** "nm", " lp ", "DMG" all normalise; anything else (an "EX" from a different game's scale, say) is null so the caller can 400 rather than silently mis-price. Absent/blank defaults to "NM". */
function normalizeCondition(raw) {
  if (!raw) return "NM";
  var upper = String(raw).trim().toUpperCase();
  return VALID_CONDITIONS.indexOf(upper) >= 0 ? upper : null;
}

/**
 * adjustForCondition, guarded: packages/shared/src/pricing.ts's own
 * function returns NaN when `multipliers` is missing a key for `condition`
 * (a corrupted settings.condition_multipliers row, say), and a NaN in a
 * JSON response aborts encoding after the 200 status has already gone out,
 * leaving the client with a truncated body instead of a clean error. The
 * unadjusted market figure is a safer answer than a broken response.
 */
function adjustForConditionSafe(gbpMarket, condition, multipliers) {
  var pricingShared = require(__hooks + "/lib/shared/pricing.js");
  var adjusted = pricingShared.adjustForCondition(gbpMarket, condition, multipliers);
  return typeof adjusted === "number" && isFinite(adjusted) ? adjusted : gbpMarket;
}

/** `settingsRow`'s json field `name`, or `fallback` when the row or the field is missing. */
function jsonSetting(settingsRow, name, fallback) {
  if (!settingsRow) return fallback;
  var util = require(__hooks + "/lib/vaultutil.js");
  return util.jsonField(settingsRow, name, null) || fallback;
}

/** settings.source_priority, or packages/shared's own default. */
function tcgPriority(settingsRow) {
  var pricingShared = require(__hooks + "/lib/shared/pricing.js");
  return jsonSetting(settingsRow, "source_priority", pricingShared.DEFAULT_TCG_PRIORITY);
}

/** settings.retro_source_priority, or packages/shared's own default. */
function retroPriority(settingsRow) {
  var pricingShared = require(__hooks + "/lib/shared/pricing.js");
  return jsonSetting(settingsRow, "retro_source_priority", pricingShared.DEFAULT_RETRO_PRIORITY);
}

/** settings.condition_multipliers, or packages/shared's own default. */
function conditionMultipliers(settingsRow) {
  var pricingShared = require(__hooks + "/lib/shared/pricing.js");
  return jsonSetting(settingsRow, "condition_multipliers", pricingShared.DEFAULT_CONDITION_MULTIPLIERS);
}

/**
 * Every `price_snapshots` row for `ownerField` ("card" or "retro_title")
 * `ownerId`, at exactly `finish` (completeness reuses the same column - see
 * the file banner), as PriceCandidate[]. A blank `finish` matches rows
 * whose finish is itself blank, never every finish at once - a route that
 * forgot to ask for one must not have its chosen price silently mix a
 * holo snapshot in with a normal one.
 */
function snapshotsFor(app, ownerField, ownerId, finish) {
  var filter = ownerField + " = {:owner} && finish = {:finish}";
  var rows = [];
  try {
    rows = app.findRecordsByFilter("price_snapshots", filter, "-fetched_at", 100, 0, {
      owner: ownerId,
      finish: finish || "",
    });
  } catch (err) {
    rows = [];
  }
  return rows.map(candidateFromSnapshot);
}

/**
 * The uk-comp routes' shared validation (cards and retro alike): a
 * positive price under a sane ceiling, a real ebay.co.uk item link, and a
 * sale date that is not in the future and not more than 30 whole calendar
 * days old. Throws the house-style 400 through `e` on the first failure;
 * returns `{ price, url, soldAt, soldDate }` once everything holds.
 */
function validateUkComp(e, util, body) {
  var price = util.asInt(body.price, -1);
  var url = util.asStr(body.url);
  var soldAt = util.asStr(body.sold_at);

  if (price <= 0) {
    throw e.badRequestError("Enter the sold price in pence, over zero.", null);
  }
  if (price > 5000000) {
    throw e.badRequestError(
      "That price looks too high. Check it is in pence, not pounds, and try again.",
      null
    );
  }
  if (!/^https:\/\/(www\.)?ebay\.co\.uk\/itm\//i.test(url)) {
    throw e.badRequestError(
      "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...).",
      null
    );
  }
  var soldDate = new Date(soldAt + "T00:00:00.000Z");
  if (isNaN(soldDate.getTime())) {
    throw e.badRequestError("Enter the date it sold, as YYYY-MM-DD.", null);
  }

  // Whole calendar days, not a raw millisecond division: comparing "now"
  // (which carries the current time of day) against a sale date parsed at
  // midnight UTC would otherwise refuse a comp sold exactly 30 days ago
  // for anyone checking after midnight.
  var now = new Date();
  var nowMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (soldDate.getTime() > nowMidnight.getTime()) {
    throw e.badRequestError("That sale date is in the future.", null);
  }
  var wholeDays = Math.round((nowMidnight.getTime() - soldDate.getTime()) / 86400000);
  if (wholeDays > 30) {
    throw e.badRequestError(
      "That sale is more than 30 days old. A UK sold comp only counts as fresh within 30 days.",
      null
    );
  }

  return { price: price, url: url, soldAt: soldAt, soldDate: soldDate };
}

module.exports = {
  FRESHNESS: FRESHNESS,
  VALID_CONDITIONS: VALID_CONDITIONS,
  normalizeCondition: normalizeCondition,
  adjustForConditionSafe: adjustForConditionSafe,
  tcgPriority: tcgPriority,
  retroPriority: retroPriority,
  conditionMultipliers: conditionMultipliers,
  snapshotsFor: snapshotsFor,
  validateUkComp: validateUkComp,
  candidateFromSnapshot: candidateFromSnapshot,
  toRow: toRow,
  choose: choose,
  writeSnapshot: writeSnapshot,
  writeSnapshotSafely: writeSnapshotSafely,
  fromAdapterCandidate: fromAdapterCandidate,
  snapshotToCandidate: snapshotToCandidate,
  latestFxRates: latestFxRates,
};
