/**
 * Shared PocketBase query helpers for lib/reports/*.js: a memoising lookup
 * by id (so grouping a thousand sale_lines by item does not run a thousand
 * uncached findRecordById calls against the same few hundred items), the
 * "what is this stock item currently worth" figure the nightly daily_stats
 * build and the stock report's price movers both need, and a small
 * grouping accumulator every by=<dimension> table in this package uses.
 *
 * require() this from inside each function that uses it, matching the rest
 * of pb_hooks - see pb/README.md on hook isolation.
 */

/** A get(id) that fetches `collection` by id once per id and remembers it. */
function cachedLookup(app, collection) {
  var cache = {};
  return function get(id) {
    if (!id) return null;
    if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
    var record = null;
    try {
      record = app.findRecordById(collection, id);
    } catch (err) {
      record = null;
    }
    cache[id] = record;
    return record;
  };
}

/**
 * The freshest price_snapshots row for a card or retro title *at exactly
 * `finish`*, whatever its source - "the latest snapshot" that the stock
 * value and price-movers figures both read (docs/PLAN.md's daily_stats row
 * and the Phase 4 brief's stock report).
 *
 * `finish` is matched exactly, including blank-matches-blank, the same rule
 * adapters/pricing_policy.js's own snapshotsFor uses: a blank finish never
 * matches every finish at once, so a holo item is never silently valued off
 * a normal-finish snapshot (or the reverse) just because that was the one
 * fetched most recently. Two finishes of the same card are two different
 * things to price.
 */
function latestSnapshot(app, filterField, id, finish) {
  if (!id) return null;
  try {
    var rows = app.findRecordsByFilter(
      "price_snapshots",
      filterField + " = {:id} && finish = {:finish}",
      "-fetched_at",
      1,
      0,
      { id: id, finish: finish || "" }
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * The per-unit market value a stock item is currently valued at: the latest
 * price_snapshots row for its card or retro title *and finish* when one
 * exists, else market_at_intake.
 *
 * `snapshotCache` is a plain object the caller keeps for the life of one
 * report build so two items of the same card and finish look the snapshot
 * up only once; pass a fresh {} per build. The cache key includes finish,
 * so a normal and a holo copy of the same card never share a cache slot.
 *
 * @returns {{perUnit: number, snapshot: (object|null)}} snapshot is the
 *   price_snapshots record when one was used, null when the fallback
 *   (market_at_intake) applied - the stock report's price-movers table only
 *   counts an item as a "mover" when a real snapshot backs the comparison.
 */
function currentMarketPerUnit(app, item, snapshotCache) {
  var cardId = item.getString("card");
  var retroId = item.getString("retro_title");
  var finish = item.getString("finish") || "";
  var owner = cardId ? "card:" + cardId : retroId ? "retro:" + retroId : "";
  var key = owner ? owner + ":" + finish : "";
  if (key) {
    if (Object.prototype.hasOwnProperty.call(snapshotCache, key)) {
      var cached = snapshotCache[key];
      if (cached) return { perUnit: cached.getInt("gbp_market"), snapshot: cached };
    } else {
      var snap = cardId
        ? latestSnapshot(app, "card", cardId, finish)
        : latestSnapshot(app, "retro_title", retroId, finish);
      snapshotCache[key] = snap;
      if (snap) return { perUnit: snap.getInt("gbp_market"), snapshot: snap };
    }
  }
  return { perUnit: item.getInt("market_at_intake"), snapshot: null };
}

/** Items currently held (the stock-value population every report agrees on). */
var STOCK_STATUS_FILTER = "(status = 'in_stock' || status = 'reserved' || status = 'listed_ebay')";

/** Whole days between a PocketBase date value and `at` (a Date), floor 0. */
function daysSince(value, at) {
  if (!value) return 0;
  var then = new Date(value);
  if (isNaN(then.getTime())) return 0;
  var days = Math.floor((at.getTime() - then.getTime()) / 86400000);
  return days < 0 ? 0 : days;
}

/**
 * Whole days between a PocketBase date value and `at`, or null when `value`
 * is blank - "unknown", never miscounted as "0 days old". The stock
 * report's ageing buckets and dead-stock list put an item with no
 * acquired_at into its own "unknown" bucket rather than defaulting it into
 * "0-30" (a blank date is not evidence of a fresh acquisition); the
 * channels report's listing ages use it the same way for a blank
 * listed_at/acquired_at pair.
 */
function daysSinceOrNull(value, at) {
  if (!value) return null;
  return daysSince(value, at);
}

/** Round a percentage figure (already *100, e.g. 55.3 for "55.3%") to 1dp, half-up. */
function roundPct(value) {
  var sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 10)) / 10;
}

/** Round a plain ratio (e.g. a 0..1 sell-through rate) to 3dp, half-up. */
function roundRatio(value) {
  var sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 1000)) / 1000;
}

/** ids are batched into groups of this size - see queryByIds. */
var ID_CHUNK_SIZE = 200;

/**
 * Every row of `collection` whose `field` is one of `ids`, fetched in as
 * few queries as possible rather than one query per id - the N+1 pattern
 * this replaces in buyins.js, margin.js and compliance.js (a trade-in's
 * lines, a sale's lines, an item sold from a trade-in, all looked up once
 * per parent id in a loop). `extraFilter` (its own {:name} params in
 * `extraParams`) is ANDed onto every chunk's own id-clause - still every
 * value through a {:param}, never an id or a filter fragment interpolated
 * into the filter text itself.
 *
 * ids are batched in groups of ID_CHUNK_SIZE so a very large id list still
 * produces a handful of queries, not one filter string of unbounded length.
 * A chunk whose query fails is skipped rather than failing the whole call.
 */
function queryByIds(app, collection, field, ids, extraFilter, extraParams, sort) {
  var out = [];
  if (!ids || ids.length === 0) return out;
  for (var start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    var chunk = ids.slice(start, start + ID_CHUNK_SIZE);
    var clauses = [];
    var params = {};
    for (var i = 0; i < chunk.length; i++) {
      var name = "v" + i;
      clauses.push(field + " = {:" + name + "}");
      params[name] = chunk[i];
    }
    var filter = "(" + clauses.join(" || ") + ")";
    if (extraFilter) {
      filter += " && (" + extraFilter + ")";
      var extraKeys = Object.keys(extraParams || {});
      for (var k = 0; k < extraKeys.length; k++) params[extraKeys[k]] = extraParams[extraKeys[k]];
    }
    try {
      var rows = app.findRecordsByFilter(collection, filter, sort || "", 0, 0, params);
      for (var r = 0; r < rows.length; r++) out.push(rows[r]);
    } catch (err) {
      // this chunk failed - skip it rather than losing every other chunk
    }
  }
  return out;
}

/** Rows are read in pages of this size - see findAllByFilter. */
var PAGE_SIZE = 500;

/**
 * Every row matching `filter`, read in fixed-size pages rather than one
 * unbounded (limit 0) call - a plain list load with no natural upper bound
 * (an open-ended want list, a compliance report over a long range) stays a
 * handful of bounded reads instead of one call trying to hold everything in
 * memory at once. Order is only meaningful within this call, not across a
 * later one - pass `sort` when the caller needs a stable order (it is
 * applied within PocketBase's own paging, so the result as a whole still
 * comes back in that order).
 */
function findAllByFilter(app, collection, filter, sort, params) {
  var out = [];
  var offset = 0;
  for (;;) {
    var page = [];
    try {
      page = app.findRecordsByFilter(collection, filter, sort || "", PAGE_SIZE, offset, params || {});
    } catch (err) {
      break;
    }
    for (var i = 0; i < page.length; i++) out.push(page[i]);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

/**
 * Every sale referenced by `lines` (sale_lines records, in "created,id"
 * order - see lib/shared/saleline.js's own note on why that order matters
 * to its discount-rounding remainder), grouped by sale and turned into one
 * saleline.breakdown() per sale. The sales themselves are fetched in one
 * batched query (queryByIds) rather than one findRecordById per sale, and
 * each sale's lines come from `lines` as already fetched rather than a
 * fresh per-sale query - the N+1 pattern this replaces in margin.js and
 * sales.js, both of which read the whole range's sale_lines once up front
 * and used to re-fetch every sale (and its lines all over again) one at a
 * time after that.
 *
 * @returns {[saleId]: {sale, breakdown}} - a sale whose own record could
 *   not be read (gone between the two reads, or inaccessible) is left out
 *   of the map, the same as a failed findRecordById would have been
 *   skipped one at a time before.
 */
function saleBreakdownsByLine(app, util, lines) {
  var saleline = require(`${__hooks}/lib/shared/saleline.js`);

  var linesBySale = {};
  var saleOrder = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var saleId = line.getString("sale");
    if (!saleId) continue;
    if (!Object.prototype.hasOwnProperty.call(linesBySale, saleId)) {
      linesBySale[saleId] = [];
      saleOrder.push(saleId);
    }
    linesBySale[saleId].push(line);
  }

  var sales = queryByIds(app, "sales", "id", saleOrder, "", {}, "");
  var saleById = {};
  for (var s = 0; s < sales.length; s++) saleById[sales[s].id] = sales[s];

  var out = {};
  for (var o = 0; o < saleOrder.length; o++) {
    var id = saleOrder[o];
    var saleRecord = saleById[id];
    if (!saleRecord) continue;
    out[id] = {
      sale: saleRecord,
      breakdown: saleline.breakdown(util.asSoldLines(linesBySale[id]), saleRecord.getInt("discount")),
    };
  }
  return out;
}

/**
 * A small accumulator for a by=<dimension> table: get(key, label) returns
 * (creating on first use) a plain {key, label} object a caller adds its own
 * numeric fields onto, and rows() returns them in first-seen order, so a
 * table's row order does not jump around between two builds of the same
 * report.
 */
function grouper() {
  var byKey = {};
  var order = [];
  return {
    get: function (key, label) {
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
        byKey[key] = { key: key, label: label };
        order.push(key);
      }
      return byKey[key];
    },
    rows: function () {
      var out = [];
      for (var i = 0; i < order.length; i++) out.push(byKey[order[i]]);
      return out;
    },
  };
}

module.exports = {
  cachedLookup: cachedLookup,
  latestSnapshot: latestSnapshot,
  currentMarketPerUnit: currentMarketPerUnit,
  STOCK_STATUS_FILTER: STOCK_STATUS_FILTER,
  daysSince: daysSince,
  daysSinceOrNull: daysSinceOrNull,
  roundPct: roundPct,
  roundRatio: roundRatio,
  queryByIds: queryByIds,
  findAllByFilter: findAllByFilter,
  saleBreakdownsByLine: saleBreakdownsByLine,
  grouper: grouper,
};
