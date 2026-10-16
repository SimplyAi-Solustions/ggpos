/// <reference path="../pb_data/types.d.ts" />

/**
 * `sales.occurred_at`: the date a sale happened, as distinct from `created`,
 * which is only when the database row was written.
 *
 * For a counter sale the two are the same instant: the hook on `sales` in
 * `pb_hooks/sales.pb.js` fills `occurred_at` with now when a create leaves
 * it blank. For an eBay orders import they differ, and that is the point:
 * a file imported on a Friday covering a week of orders books each sale on
 * the order's own date, not on the Friday the import ran. Every report and
 * every `daily_stats` row groups, filters and ranges sales on this field
 * (docs/api-contract.md, "Phase 4: stats and reports"), so it is indexed.
 *
 * Rows from before the field existed are backfilled to `created`, so the
 * reports never need a fallback.
 */
migrate(
  (app) => {
    const sales = app.findCollectionByNameOrId("sales");
    sales.fields.add(new Field({ name: "occurred_at", type: "date" }));
    sales.addIndex("idx_sales_occurred_at", false, "occurred_at", "");
    app.save(sales);

    app
      .db()
      .newQuery("UPDATE sales SET occurred_at = created WHERE occurred_at = '' OR occurred_at IS NULL")
      .execute();
  },
  (app) => {
    const sales = app.findCollectionByNameOrId("sales");
    sales.removeIndex("idx_sales_occurred_at");
    sales.fields.removeByName("occurred_at");
    app.save(sales);
  }
);
