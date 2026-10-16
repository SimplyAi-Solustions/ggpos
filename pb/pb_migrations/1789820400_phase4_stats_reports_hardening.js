/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 4 stats and reports, review round: fields the reports package's
 * fixes need, and tighter saved_reports rules.
 *
 * Added:
 *  - `daily_stats.sales_refunded`: the sum of `sales.refunded_total` for
 *    every sale that occurred that day (by `occurred_at`), so every
 *    revenue figure the reports package returns can be gross minus
 *    refunded rather than gross alone. `sales_total_by_payment` itself
 *    stays gross - what was actually taken by each payment method - and
 *    `sales_refunded` is the one figure every revenue total subtracts.
 *    See docs/api-contract.md's Phase 4 section.
 *  - `items.listed_at`: when an item's `status` most recently became
 *    `"listed_ebay"`, set by a small `onRecordUpdate` hook in
 *    `pb_hooks/items.pb.js` and cleared when `status` leaves
 *    `listed_ebay` again. Backfilled here to `updated` for every item
 *    currently listed, so the channels report's listing ages are never
 *    blank for stock already on eBay when this migration runs.
 *
 * Changed:
 *  - `saved_reports` rules: a staff member could create a row naming any
 *    `report_key` (including `compliance`, admin-only on the report route
 *    itself) with `recipients` of their own choosing, and the Monday cron
 *    would mail it - seller names and addresses included - to whoever
 *    they listed. Staff may now only list, view, create, update or delete
 *    their *own* rows (`owner = @request.auth.id`); an admin may do any
 *    of those to any row. Setting `recipients` or `schedule` - the two
 *    fields that decide whether and to whom a row is ever emailed - now
 *    needs `role = "admin"` either way, even on a staff member's own row,
 *    matching the `@request.body.<field>:isset = false` pattern
 *    `notifications`' own rule already uses. `lib/reports/scheduled.js`'s
 *    cron still checks the same thing again itself (defence in depth: a
 *    superuser-run cron bypasses collection rules entirely), so both
 *    layers agree independently.
 */
migrate(
  (app) => {
    // -------------------------------------------------------------------
    // daily_stats.sales_refunded
    // -------------------------------------------------------------------
    const dailyStats = app.findCollectionByNameOrId("daily_stats");
    dailyStats.fields.add(
      new Field({ name: "sales_refunded", type: "number", onlyInt: true, min: 0 })
    );
    app.save(dailyStats);

    // -------------------------------------------------------------------
    // items.listed_at, backfilled for stock already listed
    // -------------------------------------------------------------------
    const items = app.findCollectionByNameOrId("items");
    items.fields.add(new Field({ name: "listed_at", type: "date" }));
    app.save(items);

    app
      .db()
      .newQuery(
        "UPDATE items SET listed_at = updated WHERE status = 'listed_ebay' AND (listed_at = '' OR listed_at IS NULL)"
      )
      .execute();

    // -------------------------------------------------------------------
    // saved_reports: own rows only for staff, any row for admin;
    // recipients/schedule admin-only regardless of whose row
    // -------------------------------------------------------------------
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const OWN_OR_ADMIN = `${STAFF_ONLY} && (owner = @request.auth.id || @request.auth.role = "admin")`;
    const RECIPIENTS_SCHEDULE_ADMIN_ONLY =
      '(@request.auth.role = "admin" || (@request.body.recipients:isset = false && @request.body.schedule:isset = false))';

    const savedReports = app.findCollectionByNameOrId("saved_reports");
    savedReports.listRule = OWN_OR_ADMIN;
    savedReports.viewRule = OWN_OR_ADMIN;
    savedReports.createRule = `${OWN_OR_ADMIN} && ${RECIPIENTS_SCHEDULE_ADMIN_ONLY}`;
    savedReports.updateRule = `${OWN_OR_ADMIN} && ${RECIPIENTS_SCHEDULE_ADMIN_ONLY}`;
    savedReports.deleteRule = OWN_OR_ADMIN;
    app.save(savedReports);
  },
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';

    const savedReports = app.findCollectionByNameOrId("saved_reports");
    savedReports.listRule = STAFF_ONLY;
    savedReports.viewRule = STAFF_ONLY;
    savedReports.createRule = STAFF_ONLY;
    savedReports.updateRule = STAFF_ONLY;
    savedReports.deleteRule = STAFF_ONLY;
    app.save(savedReports);

    const items = app.findCollectionByNameOrId("items");
    items.fields.removeByName("listed_at");
    app.save(items);

    const dailyStats = app.findCollectionByNameOrId("daily_stats");
    dailyStats.fields.removeByName("sales_refunded");
    app.save(dailyStats);
  }
);
