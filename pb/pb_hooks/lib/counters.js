/**
 * Sequential, human-readable numbers: GG-BI-000123 (trade-ins), GG-S-000456
 * (sales), GG-V-000012 (reward redemptions). Backed by the `counters`
 * collection (key/value), bumped in the same transaction as the record it
 * numbers so two concurrent requests never receive the same number.
 *
 * This module is transaction-agnostic: pass whichever app reference is the
 * current transaction boundary ($app inside a plain hook, or the txApp
 * handed to a $app.runInTransaction callback when several records must be
 * numbered and written together, as the trade-in and sale completion
 * routes will in a later phase).
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var PREFIXES = {
  trade_in: "GG-BI-",
  sale: "GG-S-",
  redemption: "GG-V-",
};

/**
 * Counters that are plain integers rather than formatted numbers: the X and
 * Z reports are numbered 1, 2, 3 (docs/api-contract-epos.md, section 3,
 * "till_reports").
 */
var PLAIN_KEYS = {
  x_report: true,
  z_report: true,
};

var PAD_WIDTH = 6;

function pad(n) {
  var s = String(n);
  while (s.length < PAD_WIDTH) s = "0" + s;
  return s;
}

/** Increment the counter row for `key` (created at zero if missing) and return the new value. */
function bump(app, key) {
  var collection = app.findCollectionByNameOrId("counters");
  var record;
  try {
    record = app.findFirstRecordByFilter(collection, "key = {:key}", { key: key });
  } catch (e) {
    // Not seeded (or a brand new key) - start it at zero.
    record = new Record(collection, { key: key, value: 0 });
  }

  var next = record.getInt("value") + 1;
  record.set("value", next);
  app.save(record);

  return next;
}

/**
 * Atomically increment the named counter and return its formatted number.
 * @param {any} app - $app or a txApp.
 * @param {"trade_in"|"sale"|"redemption"} key
 */
function nextNumber(app, key) {
  var prefix = PREFIXES[key];
  if (!prefix) throw new Error("Unknown counter key: " + key);
  return prefix + pad(bump(app, key));
}

/**
 * Atomically increment a plain integer counter and return the new value.
 * Bump it in the same transaction as the record it numbers, as nextNumber.
 * @param {any} app - $app or a txApp.
 * @param {"x_report"|"z_report"} key
 */
function nextValue(app, key) {
  if (!Object.prototype.hasOwnProperty.call(PLAIN_KEYS, key)) {
    throw new Error("Unknown counter key: " + key);
  }
  return bump(app, key);
}

module.exports = { nextNumber: nextNumber, nextValue: nextValue, PREFIXES: PREFIXES };
