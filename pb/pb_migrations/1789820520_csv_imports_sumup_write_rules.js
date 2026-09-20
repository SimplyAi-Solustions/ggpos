/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 4 follow-up, web review: `csv_imports` and `sumup_transactions`
 * both let any staff token rewrite any field, a hole the counter screen
 * was actually using - it wrote `sumup_transactions.matched_sale`
 * directly for a manual match, and until now also rewrote
 * `csv_imports.errors` directly for a review-queue link (moved onto
 * `POST /api/vault/imports/:id/link`, `imports.pb.js`, this same phase).
 * Neither collection needs a general staff PATCH any more.
 *
 * Changed:
 *  - `csv_imports.updateRule`: staff may no longer update a row at all -
 *    every field on it (`status`, `rows_ok`, `errors`, `resolved_rows`,
 *    `rows_skipped`, ...) is now written only by `imports.pb.js`'s own
 *    routes, which run as `$app`/a transaction's `txApp` and so bypass
 *    collection API rules entirely, same as every other hook-only write
 *    in this build. Only an admin can still update one directly, for the
 *    rare hand fix. `listRule`, `viewRule`, `createRule` and `deleteRule`
 *    are unchanged - the review screen still lists and views through the
 *    collection API, and `GET /api/vault/imports/:id` (its own audited
 *    read) is a separate route layered on top of `viewRule`, not a
 *    replacement for it.
 *  - `sumup_transactions.updateRule`: a staff member may still update a
 *    row, but only to set `matched_sale` (the counter screen's manual
 *    match) - every other field (`sumup_id`, `transaction_code`,
 *    `timestamp`, `amount`, `payment_type`, `status`, `products`,
 *    `fetched_at`) is refused via the same `@request.body.<field>:isset
 *    = false` pattern `stock_counts.status` and `saved_reports.recipients`
 *    /`.schedule` already use, so a staff member cannot rewrite a
 *    transaction's own amount or status to manufacture a reconcile figure
 *    that never happened. An admin is unrestricted, the same shape as
 *    `saved_reports`' own admin carve-out.
 */
migrate(
  (app) => {
    const csvImports = app.findCollectionByNameOrId("csv_imports");
    csvImports.updateRule = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';
    app.save(csvImports);

    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const MATCHED_SALE_ONLY =
      "@request.body.sumup_id:isset = false && " +
      "@request.body.transaction_code:isset = false && " +
      "@request.body.timestamp:isset = false && " +
      "@request.body.amount:isset = false && " +
      "@request.body.payment_type:isset = false && " +
      "@request.body.status:isset = false && " +
      "@request.body.products:isset = false && " +
      "@request.body.fetched_at:isset = false";

    const sumupTransactions = app.findCollectionByNameOrId("sumup_transactions");
    sumupTransactions.updateRule = `${STAFF_ONLY} && (@request.auth.role = "admin" || (${MATCHED_SALE_ONLY}))`;
    app.save(sumupTransactions);
  },
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';

    const csvImports = app.findCollectionByNameOrId("csv_imports");
    csvImports.updateRule = STAFF_ONLY;
    app.save(csvImports);

    const sumupTransactions = app.findCollectionByNameOrId("sumup_transactions");
    sumupTransactions.updateRule = STAFF_ONLY;
    app.save(sumupTransactions);
  }
);
