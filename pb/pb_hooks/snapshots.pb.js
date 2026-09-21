/// <reference path="../pb_data/types.d.ts" />

/**
 * snapshots.pb.js - thinning the price history.
 *
 *   POST /api/vault/prices/rollup   (admin)
 *   cron snapshots_rollup           (Sunday 02:30)
 *
 * The work itself is lib/snapshots.js's `rollup`; both callers below are
 * thin wrappers over it, the same shape sumup.pb.js is over lib/sumup.js.
 * 02:30 on a Sunday puts it half an hour clear of crons.pb.js's own
 * weekly `prices` set sync at 03:00, so the two never walk the catalogue
 * at the same time.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

routerAdd(
  "POST",
  "/api/vault/prices/rollup",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const snapshots = require(`${__hooks}/lib/snapshots.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);
    const result = snapshots.rollup(e.app, new Date());

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "snapshots_rollup",
      collection: "price_snapshots",
      record: "",
      meta: {
        scanned: result.scanned,
        kept: result.kept,
        deleted: result.deleted,
        capped: result.capped,
      },
      ip: e.realIP(),
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

cronAdd("snapshots_rollup", "30 2 * * 0", () => {
  const snapshots = require(`${__hooks}/lib/snapshots.js`);
  try {
    snapshots.rollup($app, new Date());
  } catch (err) {
    console.log(`[cron:snapshots_rollup] failed: ${err}`);
  }
});
