/// <reference path="../pb_data/types.d.ts" />

/**
 * fx.pb.js - GET /api/vault/fx  (staff)
 *
 * Reads the latest `fx_rates` row - never calls Frankfurter itself, that is
 * crons.pb.js's daily job (docs/PLAN.md, "Currency: GBP everywhere": "the
 * ECB reference rate from Frankfurter fetched daily at 07:00 and stored
 * with its date"). `rates` is GBP per one unit of the foreign currency
 * (adapters/frankfurter.js's own convention, e.g. `{"EUR": 0.8606}` reads
 * "one euro is worth 86.06 pence"), the same direction every money helper
 * in packages/shared/src/money.ts expects. Stale after 3 days, per the
 * same section; a database with no fx_rates row at all (a fresh install
 * before the first 07:00 cron run) reports stale with empty rates rather
 * than erroring.
 *
 * The handler runs in its own isolated goja context, so every require()
 * lives inside the handler body - see pb/README.md.
 */
routerAdd(
  "GET",
  "/api/vault/fx",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);

    const STALE_HOURS = 72;

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("fx_rates", "id != ''", "-fetched_at", 1, 0);
    } catch (err) {
      rows = [];
    }
    const row = rows[0] || null;

    if (!row) {
      return e.json(200, { base: "GBP", rates: {}, fetched_at: null, stale: true });
    }

    const fetchedAt = row.getString("fetched_at");
    const ageHours = (Date.now() - new Date(fetchedAt).getTime()) / 36e5;
    const quotes = util.jsonField(row, "quotes", {}) || {};

    return e.json(200, {
      base: row.getString("base") || "GBP",
      rates: quotes,
      fetched_at: fetchedAt,
      stale: !isFinite(ageHours) || ageHours > STALE_HOURS,
    });
  },
  $apis.requireAuth("staff")
);
