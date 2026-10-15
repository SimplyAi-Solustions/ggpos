/// <reference path="../pb_data/types.d.ts" />

/**
 * reorder.pb.js - GET /api/vault/reorder  (any signed-in staff member)
 *
 *   ?supplier=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The supplier reorder report (docs/api-contract-reorder.md, section 3): for
 * the weekly call with a supplier's rep, the supplier's products with what is
 * in stock, what sold in the range, what is out and how many to order to
 * bring the shelf back to its target, the figures across the top, and the
 * customer requests still open. `from` and `to` default to the last seven
 * days. It shows prices and never cost, so it needs no capability.
 *
 *   400 "Choose a supplier."                                  no `supplier`
 *   404 "That supplier was not found."                        an unknown id
 *   400 "The dates do not make sense. Check the from and to dates."
 *                       a malformed date, from after to, or over 400 days
 *
 * The answer is the shared module's `ReorderReport`; the reading is
 * lib/reorder.js and the adding up packages/shared/src/reorder.ts.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */
routerAdd(
  "GET",
  "/api/vault/reorder",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const reorder = require(`${__hooks}/lib/reorder.js`);

    perms.caller(e);

    const result = reorder.build(e.app, util, {
      supplier: csvLib.queryParam(e, "supplier"),
      from: csvLib.queryParam(e, "from"),
      to: csvLib.queryParam(e, "to"),
    });
    if (!result.ok) throw e.error(result.status, result.message, null);
    return e.json(200, result.report);
  },
  $apis.requireAuth("staff")
);
