/// <reference path="../pb_data/types.d.ts" />

/**
 * stats.pb.js - POST /api/vault/stats/rebuild?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (admin)
 *
 * Rebuilds daily_stats for a date range on demand through
 * pb_hooks/lib/reports/daily.js's upsertDayRows, bounded to 400 days like
 * every other date-range route in this package (docs/api-contract.md,
 * Phase 4). Idempotent: rebuilding the same range twice updates the same
 * rows rather than duplicating them, since upsertDayRow matches an existing
 * row by date first. upsertDayRows also shares one stock valuation scan
 * across the whole range rather than one per day - see its own note.
 *
 * One bad day (an unreadable record, a query error) does not fail the rest
 * of the range: upsertDayRows tries each day on its own and collects
 * failures rather than sinking the whole rebuild, so the response and the
 * audit row both always reflect what actually happened - {from, to, days
 * (how many rows were written), failed (which dates were not, and why)}.
 *
 * The nightly build itself is crons.pb.js's "stats" job, which rebuilds the
 * last 7 UTC days at 00:30 UTC; this route exists for a longer backfill or
 * a re-run after a correction, not the routine nightly case.
 *
 * The handler runs in its own isolated goja context, so every require()
 * lives inside it - see pb/README.md.
 */
routerAdd(
  "POST",
  "/api/vault/stats/rebuild",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const dates = require(`${__hooks}/lib/reports/dates.js`);
    const daily = require(`${__hooks}/lib/reports/daily.js`);
    // lib/csv.js (the exports/imports package's own file, not this
    // package's lib/reports/csv.js), reused for its queryParam rather than
    // a second local copy of the same two-tier lookup.
    const sharedCsvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);

    function queryParam(name) {
      return sharedCsvLib.queryParam(e, name);
    }

    const from = queryParam("from");
    const to = queryParam("to");
    if (!dates.isValidDateStr(from) || !dates.isValidDateStr(to)) {
      throw e.badRequestError("Pick a date range. Both from and to are needed, as YYYY-MM-DD.", null);
    }
    if (from > to) {
      throw e.badRequestError("The from date is after the to date. Swap them over.", null);
    }
    if (dates.daysBetweenInclusive(from, to) > 400) {
      throw e.badRequestError("Pick a range of up to 400 days.", null);
    }

    const days = dates.eachDay(from, to);
    const result = daily.upsertDayRows(e.app, days);

    // Always audited, whether every day succeeded or not - a partial
    // rebuild is still a real change to daily_stats and still worth a
    // record of who ran it and what came of it.
    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "stats_rebuild",
      collection: "daily_stats",
      record: "",
      meta: { from: from, to: to, days: result.ok.length, failed: result.failed.length },
      ip: e.realIP(),
    });

    return e.json(200, { from: from, to: to, days: result.ok.length, failed: result.failed });
  },
  $apis.requireAuth("staff")
);
