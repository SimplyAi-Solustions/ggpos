/// <reference path="../pb_data/types.d.ts" />

/**
 * epos_products.pb.js - Vault items as Epos Now products, and till sales
 * back into the Vault (1789821680_epos_products.js, lib/eposproducts.js).
 * The worker on the shop Mac (deploy/mac/epos-stock-sync.mjs) makes every
 * Epos Now call; see deploy/mac/README.md.
 *
 * Item hooks: a create, or a change to what the product says while the item
 * is on the shelf, queues an upsert; leaving the shelf (sold, written off,
 * reserved, listed on eBay, returned) or being deleted queues an archive.
 *
 *   GET  /api/vault/stock/items/{id}/epos   (staff) the item's Epos Now status
 *   GET  /api/vault/stock/epos              (admin, manager) settings, the
 *                                            cached Epos categories, rows that
 *                                            need a person
 *   POST /api/vault/stock/epos/settings     (admin) { tax_group_id, category_map }
 *   POST /api/vault/stock/epos/resolve      (admin, manager) { kind: product|sale, id }
 *   POST /api/vault/stock/epos/backfill     (admin) queue every shelf item not on Epos Now
 *   POST /api/vault/epos/sales/apply        (superuser, the worker) one till sale line
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

onRecordCreate((e) => {
  e.next();
  try {
    require(`${__hooks}/lib/eposproducts.js`).enqueueFor(e.app, e.record, null);
  } catch (err) {
    console.log(`[epos_products] could not queue item ${e.record.id}: ${err}`);
  }
}, "items");

onRecordUpdate((e) => {
  const before = e.record.original();
  e.next();
  try {
    require(`${__hooks}/lib/eposproducts.js`).enqueueFor(e.app, e.record, before);
  } catch (err) {
    console.log(`[epos_products] could not queue item ${e.record.id}: ${err}`);
  }
}, "items");

onRecordDelete((e) => {
  const snapshot = e.record.clone();
  e.next();
  try {
    require(`${__hooks}/lib/eposproducts.js`).enqueueDeleted(e.app, snapshot);
  } catch (err) {
    console.log(`[epos_products] could not queue the archive for deleted item ${snapshot.id}: ${err}`);
  }
}, "items");

// ---------------------------------------------------------------------
// GET /api/vault/stock/items/{id}/epos
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/stock/items/{id}/epos",
  (e) => {
    const epos = require(`${__hooks}/lib/eposproducts.js`);
    let item;
    try {
      item = e.app.findRecordById("items", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Item not found. Refresh the list and try again.", null);
    }
    return e.json(200, { epos: epos.statusFor(e.app, item) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/stock/epos
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/stock/epos",
  (e) => {
    const epos = require(`${__hooks}/lib/eposproducts.js`);
    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw e.forbiddenError("Only an admin or a manager can open the Epos Now settings.", null);
    }

    const games = e.app.findRecordsByFilter("games", "id != ''", "name", 0, 0).map((g) => ({
      key: g.getString("key"),
      name: g.getString("name"),
    }));

    const cats = epos.stateValue(e.app, "categories");
    const categories = cats.value && Array.isArray(cats.value.items) ? cats.value.items : [];
    const sales = epos.stateValue(e.app, "sales");

    const checks = [];
    const rows = e.app.findRecordsByFilter(
      "epos_product_queue",
      "status = 'needs_check' || (status = 'failed' && attempts >= {:max})",
      "created",
      200,
      0,
      { max: epos.MAX_ATTEMPTS }
    );
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let title = "";
      if (r.getString("item")) {
        try {
          title = e.app.findRecordById("items", r.getString("item")).getString("title");
        } catch (err) {
          title = "";
        }
      }
      checks.push({
        kind: "product",
        id: r.id,
        item: r.getString("item") || null,
        sku: r.getString("sku"),
        title: title,
        action: r.getString("action"),
        status: r.getString("status"),
        epos_product_id: r.getInt("epos_product_id") || null,
        message: r.getString("last_error"),
        at: r.getString("updated"),
      });
    }
    const saleRows = e.app.findRecordsByFilter("epos_sales_log", "needs_check = true && resolved_at = ''", "created", 200, 0);
    for (let i = 0; i < saleRows.length; i++) {
      const r = saleRows[i];
      let title = "";
      let sku = "";
      if (r.getString("item")) {
        try {
          const it = e.app.findRecordById("items", r.getString("item"));
          title = it.getString("title");
          sku = it.getString("sku");
        } catch (err) {
          title = "";
        }
      }
      checks.push({
        kind: "sale",
        id: r.id,
        item: r.getString("item") || null,
        sku: sku,
        title: title,
        transaction_id: r.getString("transaction_id"),
        refund: r.getBool("refund"),
        qty: r.getInt("qty"),
        unit_price: r.getInt("unit_price"),
        epos_product_id: r.getInt("product_id") || null,
        message: r.getString("note"),
        at: r.getString("occurred_at") || r.getString("created"),
      });
    }

    const count = (filter) => {
      try {
        return e.app.findRecordsByFilter("epos_product_queue", filter, "", 0, 0).length;
      } catch (err) {
        return 0;
      }
    };

    return e.json(200, {
      settings: epos.readSettings(e.app),
      kinds: epos.KINDS,
      games: games,
      categories: categories,
      categories_refreshed_at: cats.updated,
      sales_polled_at: sales.value && sales.value.last_polled_at ? sales.value.last_polled_at : null,
      waiting: count("status = 'pending' || status = 'sending' || (status = 'failed' && attempts < 5)"),
      checks: checks,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/stock/epos/settings
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/stock/epos/settings",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const epos = require(`${__hooks}/lib/eposproducts.js`);
    if (e.auth.getString("role") !== "admin") {
      throw e.forbiddenError("Only an admin can change the Epos Now settings.", null);
    }
    const body = util.body(e);
    const tax = util.asInt(body.tax_group_id, 0);
    if (tax < 0 || tax > 2147483647) throw e.badRequestError("Enter an Epos Now tax group id, or 0 for NoTax.", null);
    const map = epos.cleanMap(body.category_map);

    let reset = 0;
    e.app.runInTransaction((txApp) => {
      let row = util.settings(txApp);
      if (!row) row = new Record(txApp.findCollectionByNameOrId("settings"));
      row.set("epos_tax_group_id", tax);
      row.set("epos_category_map", map);
      txApp.save(row);
      // Rows that stopped for want of a category get another go.
      const waiting = txApp.findRecordsByFilter(
        "epos_product_queue",
        "status = 'failed' && last_error ~ 'No Epos Now category'",
        "created",
        0,
        0
      );
      for (let i = 0; i < waiting.length; i++) {
        waiting[i].set("status", "pending");
        waiting[i].set("attempts", 0);
        waiting[i].set("last_error", "");
        txApp.save(waiting[i]);
        reset++;
      }
    });
    return e.json(200, { settings: epos.readSettings(e.app), requeued: reset });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/stock/epos/resolve
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/stock/epos/resolve",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw e.forbiddenError("Only an admin or a manager can resolve an Epos Now check.", null);
    }
    const body = util.body(e);
    const kind = util.asStr(body.kind);
    const id = util.asStr(body.id);
    if (!id || (kind !== "product" && kind !== "sale")) throw e.badRequestError("Pick a row to resolve.", null);

    if (kind === "sale") {
      let row;
      try {
        row = e.app.findRecordById("epos_sales_log", id);
      } catch (err) {
        throw e.notFoundError("That till sale was not found. Refresh and try again.", null);
      }
      row.set("needs_check", false);
      row.set("resolved_at", new Date().toISOString());
      row.set("resolved_by", e.auth.id);
      e.app.save(row);
      return e.json(200, { kind: kind, id: id, status: "resolved" });
    }

    let row;
    try {
      row = e.app.findRecordById("epos_product_queue", id);
    } catch (err) {
      throw e.notFoundError("That Epos Now row was not found. Refresh and try again.", null);
    }
    const status = row.getString("status");
    if (status !== "needs_check" && status !== "failed") {
      throw e.badRequestError("This row does not need a check any more.", null);
    }
    // Back to the queue. Before any create the worker looks for a product
    // with this Sku and adopts it, so a create that did go through is not
    // made twice.
    row.set("status", "pending");
    row.set("attempts", 0);
    row.set("last_error", "");
    row.set("resolved_by", e.auth.id);
    e.app.save(row);
    return e.json(200, { kind: kind, id: id, status: "pending" });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/stock/epos/backfill
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/stock/epos/backfill",
  (e) => {
    const epos = require(`${__hooks}/lib/eposproducts.js`);
    if (e.auth.getString("role") !== "admin") {
      throw e.forbiddenError("Only an admin can send all stock to Epos Now.", null);
    }
    let queued = 0;
    e.app.runInTransaction((txApp) => {
      const items = txApp.findRecordsByFilter(
        "items",
        "(status = 'in_stock' || status = '') && epos_product_id = 0",
        "created",
        0,
        0
      );
      for (let i = 0; i < items.length; i++) {
        let open = null;
        try {
          open = txApp.findFirstRecordByFilter(
            "epos_product_queue",
            "item = {:item} && (status = 'pending' || status = 'sending' || status = 'needs_check')",
            { item: items[i].id }
          );
        } catch (err) {
          open = null;
        }
        if (open) continue;
        epos.enqueue(txApp, items[i], "upsert", 0);
        queued++;
      }
    });
    return e.json(200, { queued: queued });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/epos/sales/apply (superuser: the shop Mac worker)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/epos/sales/apply",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const epos = require(`${__hooks}/lib/eposproducts.js`);
    const body = util.body(e);
    const line = {
      transaction_id: util.asStr(body.transaction_id),
      line: util.asStr(body.line),
      product_id: util.asInt(body.product_id, 0),
      qty: Number(body.qty),
      unit_price: Number(body.unit_price),
      refund: body.refund === true,
      occurred_at: util.asStr(body.occurred_at),
      flag: util.asStr(body.flag),
    };
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(line.transaction_id) || !/^[0-9A-Za-z_:-]{1,40}$/.test(line.line)) {
      throw e.badRequestError("transaction_id and line are required.", null);
    }
    if (!(line.product_id > 0)) throw e.badRequestError("product_id is required.", null);
    if (!Number.isSafeInteger(line.unit_price)) throw e.badRequestError("unit_price must be whole pence.", null);
    if (!Number.isSafeInteger(line.qty)) line.qty = 0;

    let out = null;
    e.app.runInTransaction((txApp) => {
      out = epos.applySale(txApp, line);
    });
    return e.json(200, out);
  },
  $apis.requireSuperuserAuth()
);
