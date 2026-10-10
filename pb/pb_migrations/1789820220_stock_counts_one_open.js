/// <reference path="../pb_data/types.d.ts" />

/**
 * Only one stock count may be open per location at a time - the same shape
 * as cash_sessions' own "one open session" rule
 * (1789819740_phase2_refunds_and_protection.js): a partial unique index, so
 * two staff members opening a count on the same location at the same
 * moment collide on the database itself rather than a race in application
 * code. The counter app already offers to resume an open count instead of
 * starting a second one; this is what makes that rule real. The unique
 * violation this can now raise on create is mapped to a plain 409 by
 * stockcounts.pb.js's own onRecordCreateRequest hook.
 */
migrate((app) => {
  const stockCounts = app.findCollectionByNameOrId("stock_counts");
  stockCounts.addIndex("idx_stock_counts_one_open", true, "location", "status = 'open'");
  app.save(stockCounts);
}, (app) => {
  const stockCounts = app.findCollectionByNameOrId("stock_counts");
  stockCounts.removeIndex("idx_stock_counts_one_open");
  app.save(stockCounts);
});
