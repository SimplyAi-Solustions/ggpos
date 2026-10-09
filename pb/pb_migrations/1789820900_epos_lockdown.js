/// <reference path="../pb_data/types.d.ts" />

/**
 * The money collections locked down (docs/api-contract-epos.md, section 4,
 * "Locked down"; docs/EPOS-PLAN.md, "the raw collection API is closed for
 * money records").
 *
 * `sales`, `sale_lines`, `sale_tenders`, `cash_sessions` and
 * `cash_movements` can no longer be created, updated or deleted by any staff
 * token through the collection API: every rule is `null`, so a sale, a
 * drawer or a refund only ever changes through a route that checks it and
 * audits it (the sale, refund, cash session and till routes, which run as
 * the app and bypass rules). List and view stay staff-only, as before.
 * Admin and superuser repairs go through `/_/`. `till_reports`,
 * `till_events` and `till_overrides` were route-only from the start
 * (1789820860_epos_schema.js).
 *
 * `down()` puts back what each had before:
 * - `sales`, `sale_lines`, `cash_sessions`, `cash_movements`: create,
 *   update and delete were staff-only (1789819440_selling_cash_collections.js).
 *   `sales.updateRule` had a clause refusing a staff write of
 *   `sumup_checkout` (1789820700_phase7_extras.js); SumUp is gone, so it
 *   goes back to plain staff-only.
 * - `sale_tenders`: every write was already `null` (1789820860_epos_schema.js).
 */

const STAFF_ONLY = '@request.auth.collectionName = "staff"';

const LOCKED = ["sales", "sale_lines", "sale_tenders", "cash_sessions", "cash_movements"];

const BEFORE = {
  sales: STAFF_ONLY,
  sale_lines: STAFF_ONLY,
  sale_tenders: null,
  cash_sessions: STAFF_ONLY,
  cash_movements: STAFF_ONLY,
};

migrate(
  (app) => {
    LOCKED.forEach((name) => {
      const collection = app.findCollectionByNameOrId(name);
      collection.listRule = STAFF_ONLY;
      collection.viewRule = STAFF_ONLY;
      collection.createRule = null;
      collection.updateRule = null;
      collection.deleteRule = null;
      app.save(collection);
    });
  },
  (app) => {
    LOCKED.forEach((name) => {
      const collection = app.findCollectionByNameOrId(name);
      collection.createRule = BEFORE[name];
      collection.updateRule = BEFORE[name];
      collection.deleteRule = BEFORE[name];
      app.save(collection);
    });
  }
);
