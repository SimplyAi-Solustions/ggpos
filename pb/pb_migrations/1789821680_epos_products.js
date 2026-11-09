/// <reference path="../pb_data/types.d.ts" />

/**
 * Vault stock as Epos Now products, and Epos Now till sales back into the
 * Vault. The Epos Now token stays on the shop Mac: a worker there
 * (deploy/mac/epos-stock-sync.mjs) drains the product queue and pulls the
 * till's sales. This server only queues, reports and applies.
 *
 * Additive only.
 *
 * items:
 *  - epos_product_id      the Epos Now product the Vault created for this
 *                         item. 0 = none. Set only by the worker (superuser).
 *                         The product also carries Sku "GGV-<sku>"; the worker
 *                         refuses to change any product that does not.
 *  - epos_synced_at       when Epos Now last confirmed the product matches.
 *  - epos_sale_price      int pence: the unit price of the last till sale
 *                         applied to this item.
 *  - epos_transaction_id  the Epos Now transaction of that sale.
 *  - epos_sold_at         when that sale happened (UTC).
 * Staff cannot set any of these through the collection API (the create and
 * update rules refuse them): epos_product_id decides which Epos Now product's
 * till sales mark the item sold, so only the worker, after checking the Sku,
 * may set it.
 *
 * settings (admin only, as before):
 *  - epos_category_map    { default: 0, game: { pokemon: 516834 }, kind: { graded: 0 } }.
 *                         A kind entry wins over a game entry, then default.
 *  - epos_tax_group_id    SalePriceTaxGroupId and CostPriceTaxGroupId for
 *                         Vault products. 0 = the default, 26457 "NoTax".
 *
 * epos_product_queue (superuser only; staff read it through the routes in
 * epos_products.pb.js):
 *  - item             the Vault item. Empty once the item is deleted.
 *  - sku              the item's SKU when queued, for the log and for an
 *                     archive after the item is gone.
 *  - epos_product_id  the product this row acts on. 0 on an upsert that has
 *                     not created its product yet, so a row left in sending
 *                     with 0 is a create whose outcome is unknown.
 *  - action           upsert | archive.
 *  - status           pending | sending | done | failed | needs_check.
 *  - attempts, last_error, synced_at, resolved_by.
 *
 * epos_sync_state (superuser only): key/value rows the worker keeps, the
 * sales cursor ("sales") and the cached Epos Now category list
 * ("categories").
 *
 * epos_sales_log (superuser only): one row per Vault-owned line on an Epos
 * Now till transaction. The unique index on (transaction_id, line) is what
 * stops a sale being applied twice.
 */
const EPOS_LOCK =
  " && @request.body.epos_product_id:isset = false && @request.body.epos_synced_at:isset = false" +
  " && @request.body.epos_sale_price:isset = false && @request.body.epos_transaction_id:isset = false" +
  " && @request.body.epos_sold_at:isset = false";

migrate(
  (app) => {
    const items = app.findCollectionByNameOrId("items");
    const staff = app.findCollectionByNameOrId("staff");
    const settings = app.findCollectionByNameOrId("settings");

    const itemFields = [
      { name: "epos_product_id", type: "number", onlyInt: true, min: 0 },
      { name: "epos_synced_at", type: "date" },
      { name: "epos_sale_price", type: "number", onlyInt: true },
      { name: "epos_transaction_id", type: "text", max: 40 },
      { name: "epos_sold_at", type: "date" },
    ];
    for (const f of itemFields) {
      if (!items.fields.getByName(f.name)) items.fields.add(new Field(f));
    }
    items.addIndex("idx_items_epos_product_id", false, "epos_product_id", "");
    for (const rule of ["createRule", "updateRule"]) {
      if (items[rule] && items[rule].indexOf(EPOS_LOCK) === -1) items[rule] = "(" + items[rule] + ")" + EPOS_LOCK;
    }
    app.save(items);

    if (!settings.fields.getByName("epos_category_map")) {
      settings.fields.add(new Field({ name: "epos_category_map", type: "json", maxSize: 20000 }));
    }
    if (!settings.fields.getByName("epos_tax_group_id")) {
      settings.fields.add(new Field({ name: "epos_tax_group_id", type: "number", onlyInt: true, min: 0 }));
    }
    app.save(settings);

    const autodates = [
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ];

    const queue = new Collection({
      name: "epos_product_queue",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "item", type: "relation", collectionId: items.id, maxSelect: 1, cascadeDelete: false },
        { name: "sku", type: "text", max: 20 },
        { name: "epos_product_id", type: "number", onlyInt: true, min: 0 },
        { name: "action", type: "select", required: true, maxSelect: 1, values: ["upsert", "archive"] },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["pending", "sending", "done", "failed", "needs_check"],
        },
        { name: "attempts", type: "number", onlyInt: true, min: 0 },
        { name: "last_error", type: "text", max: 2000 },
        { name: "synced_at", type: "date" },
        { name: "resolved_by", type: "relation", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        ...autodates,
      ],
    });
    queue.addIndex("idx_epos_product_queue_status", false, "status, created", "");
    queue.addIndex("idx_epos_product_queue_item", false, "item, status", "");
    app.save(queue);

    const state = new Collection({
      name: "epos_sync_state",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "key", type: "text", required: true, max: 40 },
        { name: "value", type: "json", maxSize: 2000000 },
        ...autodates,
      ],
    });
    state.addIndex("idx_epos_sync_state_key", true, "key", "");
    app.save(state);

    const log = new Collection({
      name: "epos_sales_log",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "transaction_id", type: "text", required: true, max: 40 },
        { name: "line", type: "text", required: true, max: 40 },
        { name: "product_id", type: "number", onlyInt: true, min: 0 },
        { name: "item", type: "relation", collectionId: items.id, maxSelect: 1, cascadeDelete: false },
        { name: "qty", type: "number", onlyInt: true },
        { name: "unit_price", type: "number", onlyInt: true },
        { name: "refund", type: "bool" },
        { name: "applied", type: "bool" },
        { name: "needs_check", type: "bool" },
        { name: "note", type: "text", max: 500 },
        { name: "occurred_at", type: "date" },
        { name: "resolved_at", type: "date" },
        { name: "resolved_by", type: "relation", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        ...autodates,
      ],
    });
    log.addIndex("idx_epos_sales_log_txn_line", true, "transaction_id, line", "");
    log.addIndex("idx_epos_sales_log_check", false, "needs_check, created", "");
    app.save(log);
  },
  (app) => {
    for (const name of ["epos_sales_log", "epos_sync_state", "epos_product_queue"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (err) {
        // Already gone.
      }
    }
    const items = app.findCollectionByNameOrId("items");
    items.removeIndex("idx_items_epos_product_id");
    for (const rule of ["createRule", "updateRule"]) {
      const v = items[rule];
      if (v && v.indexOf(EPOS_LOCK) !== -1) items[rule] = v.replace(EPOS_LOCK, "").replace(/^\((.*)\)$/, "$1");
    }
    for (const name of ["epos_product_id", "epos_synced_at", "epos_sale_price", "epos_transaction_id", "epos_sold_at"]) {
      items.fields.removeByName(name);
    }
    app.save(items);
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("epos_category_map");
    settings.fields.removeByName("epos_tax_group_id");
    app.save(settings);
  }
);
