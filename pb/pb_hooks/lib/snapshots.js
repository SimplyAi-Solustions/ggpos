/**
 * lib/snapshots.js - thinning old `price_snapshots` rows, behind
 * snapshots.pb.js's `snapshots_rollup` cron and its admin route.
 *
 * services/pricesync writes a snapshot per card, finish and source every
 * night, so a shop's price history grows by tens of thousands of rows a
 * month and almost none of it is ever read: the valuation routes want
 * this week's figure, and a chart wants a point a week, not a point a
 * night. This keeps one row per (card or retro title, finish, source,
 * ISO week) once a snapshot is over ninety days old and deletes the rest.
 *
 * Two rules make that safe to run unattended:
 *
 *  - nothing inside the ninety days is touched at all, so every
 *    freshness window adapters/pricing_policy.js applies is unaffected;
 *  - the newest row of any (target, finish, source) is never deleted,
 *    whatever its age, so a card priced once, a year ago, still has that
 *    one price afterwards. It falls out of the per-week rule already (the
 *    newest row is the newest in its own week), and is guarded explicitly
 *    below as well, because "the price disappeared" is not a failure
 *    anybody would spot until they needed it.
 *
 * Deletes go in batches of 500, each batch in its own transaction, so a
 * first run on a database that has never been thinned does not hold one
 * transaction open over tens of thousands of rows. Idempotent: a second
 * run finds one row per week per target and deletes nothing.
 *
 * require() this from inside each handler/cron body, not at file top
 * level - see pb/README.md.
 */

var KEEP_DAYS = 90;
var DELETE_BATCH = 500;
var READ_PAGE = 1000;

/** PocketBase's own stored date shape ("2026-09-20 12:00:00.000Z"). */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

/** A stored date read back as a Date, whichever separator it carries. */
function parseStored(value) {
  if (!value) return null;
  var d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The ISO-8601 week a date falls in, as "2026-W38": Monday starts the
 * week and the week holding the year's first Thursday is week 1, so a
 * snapshot taken on 1 January groups with the December rows beside it
 * rather than opening a week of its own.
 */
function isoWeekKey(date) {
  var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  var day = d.getUTCDay() || 7; // Monday 1 ... Sunday 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + (week < 10 ? "0" + week : String(week));
}

/** What a snapshot is a price for: the card or the retro title, its finish and its source. */
function targetKey(row) {
  return (
    (row.getString("card") || "retro:" + row.getString("retro_title")) +
    "|" +
    row.getString("finish") +
    "|" +
    row.getString("source")
  );
}

/** Every row older than the cutoff, oldest first, read a page at a time. */
function oldRows(app, cutoff) {
  var all = [];
  var offset = 0;
  while (true) {
    var page = [];
    try {
      page = app.findRecordsByFilter(
        "price_snapshots",
        "fetched_at != '' && fetched_at < {:cutoff}",
        "fetched_at,id",
        READ_PAGE,
        offset,
        { cutoff: cutoff }
      );
    } catch (err) {
      page = [];
    }
    if (!page || page.length === 0) break;
    for (var i = 0; i < page.length; i++) {
      if (page[i]) all.push(page[i]);
    }
    if (page.length < READ_PAGE) break;
    offset += READ_PAGE;
  }
  return all;
}

/**
 * Thin the price history.
 *
 * @param {any} app - $app, or a txApp from a caller that already has one.
 * @param {Date} [now]
 * @returns {{scanned: number, kept: number, deleted: number}}
 */
function rollup(app, now) {
  var at = now || new Date();
  var cutoff = pbDate(new Date(at.getTime() - KEEP_DAYS * 86400000));
  var rows = oldRows(app, cutoff);

  // Oldest first, so the last row seen for a (target, week) is that
  // week's newest, and the last row seen for a target is that target's
  // newest old row - the one the "never delete the last price" rule
  // protects.
  var keepByWeek = {};
  var newestByTarget = {};
  for (var i = 0; i < rows.length; i++) {
    var fetched = parseStored(rows[i].getString("fetched_at"));
    if (!fetched) continue;
    var target = targetKey(rows[i]);
    keepByWeek[target + "|" + isoWeekKey(fetched)] = rows[i].id;
    newestByTarget[target] = rows[i].id;
  }

  var doomed = [];
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    var when = parseStored(row.getString("fetched_at"));
    if (!when) continue;
    var key = targetKey(row);
    if (keepByWeek[key + "|" + isoWeekKey(when)] === row.id) continue;
    if (newestByTarget[key] === row.id) continue;
    doomed.push(row);
  }

  var deleted = 0;
  for (var start = 0; start < doomed.length; start += DELETE_BATCH) {
    var batch = doomed.slice(start, start + DELETE_BATCH);
    try {
      app.runInTransaction(function (txApp) {
        for (var b = 0; b < batch.length; b++) {
          txApp.delete(batch[b]);
        }
      });
      deleted += batch.length;
    } catch (err) {
      console.log("[snapshots] a batch of " + batch.length + " could not be deleted: " + err);
    }
  }

  var result = { scanned: rows.length, kept: rows.length - deleted, deleted: deleted };
  console.log(
    "[snapshots] rollup scanned " +
      result.scanned +
      " snapshot(s) older than " +
      KEEP_DAYS +
      " days, kept " +
      result.kept +
      ", deleted " +
      result.deleted
  );
  return result;
}

module.exports = {
  KEEP_DAYS: KEEP_DAYS,
  DELETE_BATCH: DELETE_BATCH,
  pbDate: pbDate,
  isoWeekKey: isoWeekKey,
  targetKey: targetKey,
  rollup: rollup,
};
