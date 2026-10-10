/// <reference path="../pb_data/types.d.ts" />

/**
 * `sales.client_id`: the offline queue's idempotency key. The counter PWA
 * generates one per sale before it ever reaches the server, so a queued
 * "mark sold" that gets replayed after a reconnect (docs/PLAN.md,
 * "Offline") cannot create the same sale twice - see
 * `POST /api/vault/sales/complete` in sales.pb.js and docs/api-contract.md's
 * "Sales" section.
 *
 * Optional (most callers never send one, hence a partial unique index
 * rather than a plain unique one - the same shape as `trade_ins.number` in
 * 1789819680_phase2_fields.js), so any number of rows may sit at `""`
 * while the ones that do carry a client_id stay unique.
 */
migrate((app) => {
  const sales = app.findCollectionByNameOrId("sales");
  sales.fields.add(new Field({ name: "client_id", type: "text", max: 64 }));
  sales.addIndex("idx_sales_client_id_unique", true, "client_id", "client_id != ''");
  app.save(sales);
}, (app) => {
  const sales = app.findCollectionByNameOrId("sales");
  sales.removeIndex("idx_sales_client_id_unique");
  sales.fields.removeByName("client_id");
  app.save(sales);
});
