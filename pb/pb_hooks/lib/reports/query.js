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
 * The freshest price_snapshots row for a card or retro title, whatever its
 * source or finish/completeness - "the latest snapshot" that the stock
 * value and price-movers figures both read (docs/PLAN.md's daily_stats row
 * and the Phase 4 brief's stock report).
 */
function latestSnapshot(app, filterField, id) {
  if (!id) return null;
  try {
    var rows = app.findRecordsByFilter(
      "price_snapshots",
      filterField + " = {:id}",
      "-fetched_at",
      1,
      0,
      { id: id }
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * The per-unit market value a stock item is currently valued at: the latest
 * price_snapshots row for its card or retro title when one exists, else
 * market_at_intake.
 *
 * `snapshotCache` is a plain object the caller keeps for the life of one
 * report build so two items of the same card look the snapshot up only
 * once; pass a fresh {} per build.
 *
 * @returns {{perUnit: number, snapshot: (object|null)}} snapshot is the
 *   price_snapshots record when one was used, null when the fallback
 *   (market_at_intake) applied - the stock report's price-movers table only
 *   counts an item as a "mover" when a real snapshot backs the comparison.
 */
function currentMarketPerUnit(app, item, snapshotCache) {
  var cardId = item.getString("card");
  var retroId = item.getString("retro_title");
  var key = cardId ? "card:" + cardId : retroId ? "retro:" + retroId : "";
  if (key) {
    if (Object.prototype.hasOwnProperty.call(snapshotCache, key)) {
      var cached = snapshotCache[key];
      if (cached) return { perUnit: cached.getInt("gbp_market"), snapshot: cached };
    } else {
      var snap = cardId
        ? latestSnapshot(app, "card", cardId)
        : latestSnapshot(app, "retro_title", retroId);
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
  grouper: grouper,
};
