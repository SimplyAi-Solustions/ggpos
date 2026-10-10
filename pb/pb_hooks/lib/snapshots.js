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
// One run never walks more than this many old rows, so the first pass on a
// database that has never been thinned converges over a few weekly runs
// rather than holding the whole process for one very long one.
var MAX_SCAN = 50000;

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

/**
 * One page of rows older than the cutoff, oldest first, continued from
 * the last row of the previous page.
 *
 * Keyset paging, not an offset: an offset walk is quadratic over a table
 * this size, and deleting as it goes would make the offsets lie. The
 * cursor is (fetched_at, id), so a page boundary landing in the middle of
 * a group of rows sharing one `fetched_at` still continues correctly.
 */
function pageAfter(app, cutoff, cursor) {
  var filter = "fetched_at != '' && fetched_at < {:cutoff}";
  var params = { cutoff: cutoff };
  if (cursor) {
    filter += " && (fetched_at > {:last} || (fetched_at = {:last} && id > {:lastId}))";
    params.last = cursor.fetchedAt;
    params.lastId = cursor.id;
  }
  try {
    return app.findRecordsByFilter("price_snapshots", filter, "fetched_at,id", READ_PAGE, 0, params) || [];
  } catch (err) {
    console.log("[snapshots] could not read a page of snapshots: " + err);
    return [];
  }
}

/**
 * Thin the price history.
 *
 * Streams: a page of rows at a time, and only ids are kept between pages
 * (one per target per week, plus one per target), so memory scales with
 * how many distinct cards, finishes and sources the shop has priced and
 * not with how many nights it has been running. Deletes go out in batches
 * of `DELETE_BATCH`, each in its own transaction, as soon as a batch is
 * full rather than at the end.
 *
 * A run stops after `MAX_SCAN` rows and says so (`capped`), so the first
 * run on a database that has never been thinned converges over a few
 * weekly runs instead of holding the process for one very long one.
 *
 * @param {any} app - $app, or a txApp from a caller that already has one.
 * @param {Date} [now]
 * @returns {{scanned: number, kept: number, deleted: number, capped: boolean}}
 */
function rollup(app, now) {
  var at = now || new Date();
  var cutoff = pbDate(new Date(at.getTime() - KEEP_DAYS * 86400000));

  // Rows arrive oldest first, so the newest row of a (target, week) and
  // the newest old row of a target are both simply the last one seen.
  // Each is kept, and whatever it displaces is deleted, which is what
  // makes one pass enough.
  var keepByWeek = {};
  var newestByTarget = {};
  var scanned = 0;
  var deleted = 0;
  var capped = false;
  var batch = [];
  var cursor = null;

  function flush() {
    if (batch.length === 0) return;
    var going = batch;
    batch = [];
    try {
      app.runInTransaction(function (txApp) {
        for (var b = 0; b < going.length; b++) {
          txApp.delete(going[b]);
        }
      });
      deleted += going.length;
    } catch (err) {
      console.log("[snapshots] a batch of " + going.length + " could not be deleted: " + err);
    }
  }

  while (scanned < MAX_SCAN) {
    var page = pageAfter(app, cutoff, cursor);
    if (page.length === 0) break;

    for (var i = 0; i < page.length; i++) {
      var row = page[i];
      if (!row) continue;
      cursor = { fetchedAt: row.getString("fetched_at"), id: row.id };
      var when = parseStored(row.getString("fetched_at"));
      if (!when) continue;
      scanned += 1;

      var target = targetKey(row);
      var weekKey = target + "|" + isoWeekKey(when);
      var displaced = keepByWeek[weekKey];
      keepByWeek[weekKey] = row;
      newestByTarget[target] = row;

      // The row this one displaces as its week's newest goes. It can
      // never be the last price this target has: the row displacing it
      // shares the target, is at least as new, and survives at least
      // until something newer still displaces it, so every target keeps
      // its newest row whatever its age. That is checked here rather
      // than assumed, because a price quietly disappearing is not
      // something anybody would notice until they needed it.
      if (displaced && displaced.id !== row.id) {
        var survivorIsNewer = String(row.getString("fetched_at")) >= String(displaced.getString("fetched_at"));
        if (survivorIsNewer && targetKey(displaced) === target) {
          batch.push(displaced);
          if (batch.length >= DELETE_BATCH) flush();
        }
      }
      if (scanned >= MAX_SCAN) {
        capped = true;
        break;
      }
    }

    if (page.length < READ_PAGE) break;
  }

  flush();

  var result = { scanned: scanned, kept: scanned - deleted, deleted: deleted, capped: capped };
  console.log(
    "[snapshots] rollup scanned " +
      result.scanned +
      " snapshot(s) older than " +
      KEEP_DAYS +
      " days, kept " +
      result.kept +
      ", deleted " +
      result.deleted +
      (result.capped ? " (stopped at the " + MAX_SCAN + " row cap; the next run carries on)" : "")
  );
  return result;
}

module.exports = {
  KEEP_DAYS: KEEP_DAYS,
  DELETE_BATCH: DELETE_BATCH,
  MAX_SCAN: MAX_SCAN,
  pbDate: pbDate,
  isoWeekKey: isoWeekKey,
  targetKey: targetKey,
  rollup: rollup,
};
