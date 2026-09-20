/// <reference path="../pb_data/types.d.ts" />

/**
 * sumup.pb.js - the SumUp transactions pull and the day's reconciliation.
 *
 *   POST /api/vault/sumup/pull        (admin)
 *   GET  /api/vault/sumup/reconcile   (staff)
 *
 * docs/PLAN.md, "SumUp integration": there is no webhook for a sale rung
 * through the SumUp app, so this pulls `GET .../transactions/history` and
 * `GET .../transactions?id=` (adapters/sumup.js) on demand here and on a
 * schedule from crons_sumup.pb.js, and matches each one to a `sales` row
 * (lib/sumup.js). See docs/api-contract.md's "Phase 4" section for the
 * shapes.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

routerAdd(
  "POST",
  "/api/vault/sumup/pull",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const sumupLib = require(`${__hooks}/lib/sumup.js`);

    const staff = util.requireAdmin(e);
    const result = sumupLib.pull(e.app, staff.id, e.realIP());
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

routerAdd(
  "GET",
  "/api/vault/sumup/reconcile",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const sumupLib = require(`${__hooks}/lib/sumup.js`);

    const date = csvLib.dateParam(e, "date");
    if (!date) {
      throw e.badRequestError("Pick a date, YYYY-MM-DD.", null);
    }

    const result = sumupLib.reconcile(e.app, date);
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);
