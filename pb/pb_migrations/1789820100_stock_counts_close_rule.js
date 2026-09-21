/// <reference path="../pb_data/types.d.ts" />

/**
 * `stock_counts.status` cannot be set through the collection API at all
 * (any value, not only "closed"): `POST /api/vault/stock-counts/:id/close`
 * (stockcounts.pb.js) is the only way a count closes, because closing also
 * has to set every line's variance, optionally move stock and write an
 * audit row, all in one transaction - see docs/api-contract.md's "Stock
 * counts" section.
 *
 * `@request.body.status:isset` is PocketBase's own "was this field present
 * in the request body at all" filter modifier, so a staff member can still
 * create a count (setting status to "open" at create time is unaffected -
 * only updateRule changes here) and freely update its `location` or other
 * fields; only "status" is refused on update, in either direction.
 */
migrate((app) => {
  const stockCounts = app.findCollectionByNameOrId("stock_counts");
  stockCounts.updateRule =
    '@request.auth.collectionName = "staff" && @request.body.status:isset = false';
  app.save(stockCounts);
}, (app) => {
  const stockCounts = app.findCollectionByNameOrId("stock_counts");
  stockCounts.updateRule = '@request.auth.collectionName = "staff"';
  app.save(stockCounts);
});
