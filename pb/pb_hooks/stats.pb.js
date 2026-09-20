/// <reference path="../pb_data/types.d.ts" />

/**
 * stats.pb.js - POST /api/vault/stats/rebuild?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (admin)
 *
 * Rebuilds daily_stats for a date range on demand: one upsert per day
 * through pb_hooks/lib/reports/daily.js's upsertDayRow, bounded to 400 days
 * like every other date-range route in this package
 * (docs/api-contract.md, Phase 4). Idempotent: rebuilding the same range
 * twice updates the same rows rather than duplicating them, since
 * upsertDayRow matches an existing row by date first.
 *
 * The nightly build itself is crons.pb.js's "stats" job, which calls the
 * same upsertDayRow for yesterday at 00:30 UTC; this route exists for a
 * backfill or a re-run after a correction, not the routine nightly case.
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
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);

    function queryParam(name) {
      let raw = "";
      try {
        const info = e.requestInfo();
        raw = util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        raw = "";
      }
      if (!raw) {
        try {
          raw = util.asStr(e.request.url.query().get(name));
        } catch (err) {
          raw = "";
        }
      }
      return raw;
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
    let count = 0;
    for (let i = 0; i < days.length; i++) {
      daily.upsertDayRow(e.app, days[i]);
      count += 1;
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "stats_rebuild",
      collection: "daily_stats",
      record: "",
      meta: { from: from, to: to, days: count },
      ip: e.realIP(),
    });

    return e.json(200, { from: from, to: to, days: count });
  },
  $apis.requireAuth("staff")
);
