/**
 * Vault items as Epos Now products (1789821680_epos_products.js).
 *
 * The worker on the shop Mac (deploy/mac/epos-stock-sync.mjs) holds the
 * Epos Now token and makes every Epos call. This file only:
 *  - queues an upsert or an archive when an item changes (enqueueFor);
 *  - reports an item's Epos Now status to staff (statusFor);
 *  - applies one till sale line, once (applySale);
 *  - reads and writes the settings the worker uses.
 *
 * require() inside the handler body (pb/README.md on pb_hooks isolation).
 */

var MAX_ATTEMPTS = 5;
var DEFAULT_TAX_GROUP = 26457;
var SKU_PREFIX = "GGV-";
var KINDS = ["single", "graded", "retro", "sealed", "accessory", "other"];
// The fields that change what the Epos Now product says.
var WATCHED = ["title", "price", "cost", "qty", "sku", "kind", "game", "grade_company", "grade"];

/** On Epos Now and sellable at the till: only stock that is on the shelf. */
function sellable(status) {
  return status === "in_stock" || status === "";
}

function openRowFor(app, itemId) {
  try {
    return app.findFirstRecordByFilter(
      "epos_product_queue",
      "item = {:item} && (status = 'pending' || status = 'failed')",
      { item: itemId }
    );
  } catch (err) {
    return null;
  }
}

/**
 * Queue `action` for an item, collapsing duplicates: a pending or failed row
 * for the same item is turned into this action (pending, attempts reset)
 * rather than a second row being added. A row in sending or needs_check is
 * left alone; the worker holds back an item's new rows until it is settled.
 */
function enqueue(app, record, action, productId) {
  var existing = record.id ? openRowFor(app, record.id) : null;
  var row = existing;
  if (!row) {
    row = new Record(app.findCollectionByNameOrId("epos_product_queue"));
    if (record.id) row.set("item", record.id);
  }
  row.set("sku", record.getString("sku"));
  row.set("epos_product_id", productId || 0);
  row.set("action", action);
  row.set("status", "pending");
  row.set("attempts", 0);
  row.set("last_error", "");
  app.save(row);
  return row;
}

/**
 * Decide what an item change means for Epos Now. `before` is the original
 * record on an update, null on a create.
 */
function enqueueFor(app, record, before) {
  var nowSellable = sellable(record.getString("status"));
  var productId = record.getInt("epos_product_id");
  if (!before) {
    if (nowSellable) enqueue(app, record, "upsert", productId);
    return;
  }
  var wasSellable = sellable(before.getString("status"));
  if (nowSellable) {
    var changed = !wasSellable;
    for (var i = 0; i < WATCHED.length && !changed; i++) {
      if (String(before.get(WATCHED[i])) !== String(record.get(WATCHED[i]))) changed = true;
    }
    if (changed) enqueue(app, record, "upsert", productId);
    return;
  }
  if (wasSellable && (productId > 0 || openRowFor(app, record.id))) {
    enqueue(app, record, "archive", productId);
  }
}

/** An item was deleted: archive its product, if it had one. */
function enqueueDeleted(app, record) {
  var productId = record.getInt("epos_product_id");
  if (!(productId > 0)) return;
  var row = new Record(app.findCollectionByNameOrId("epos_product_queue"));
  row.set("sku", record.getString("sku"));
  row.set("epos_product_id", productId);
  row.set("action", "archive");
  row.set("status", "pending");
  row.set("attempts", 0);
  app.save(row);
}

function latestRow(app, itemId) {
  try {
    var rows = app.findRecordsByFilter("epos_product_queue", "item = {:item}", "-created", 1, 0, { item: itemId });
    return rows.length ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/** True when a row needs a person: needs_check, or failed with no tries left. */
function stuck(row) {
  var status = row.getString("status");
  return status === "needs_check" || (status === "failed" && row.getInt("attempts") >= MAX_ATTEMPTS);
}

/**
 * An item's Epos Now status for the item page:
 *   status  synced | waiting | needs_check | archived | none
 */
function statusFor(app, item) {
  var productId = item.getInt("epos_product_id");
  var syncedAt = item.getString("epos_synced_at");
  var row = latestRow(app, item.id);
  var base = {
    epos_product_id: productId || null,
    synced_at: syncedAt || null,
    sold_on_till: item.getString("epos_transaction_id")
      ? {
          transaction_id: item.getString("epos_transaction_id"),
          unit_price: item.getInt("epos_sale_price"),
          sold_at: item.getString("epos_sold_at") || null,
        }
      : null,
  };
  if (row && stuck(row)) {
    base.status = "needs_check";
    base.message = "Needs a check. An admin can see why under Stock, Epos Now.";
    base.last_error = row.getString("last_error") || null;
    return base;
  }
  if (row && (row.getString("status") === "pending" || row.getString("status") === "sending" || row.getString("status") === "failed")) {
    base.status = "waiting";
    base.message = row.getString("action") === "archive" ? "Waiting to come off Epos Now." : "Waiting to sync to Epos Now.";
    return base;
  }
  if (productId > 0 && row && row.getString("action") === "archive") {
    base.status = "archived";
    base.message = "Off Epos Now: archived when it left stock.";
    return base;
  }
  if (productId > 0) {
    base.status = "synced";
    base.message = "On Epos Now.";
    return base;
  }
  base.status = "none";
  base.message = sellable(item.getString("status")) ? "Not on Epos Now yet." : "Not on Epos Now.";
  return base;
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

function cleanMap(raw) {
  var out = { default: 0, game: {}, kind: {} };
  if (!raw || typeof raw !== "object") return out;
  var def = Number(raw.default);
  out.default = isFinite(def) && def > 0 ? Math.floor(def) : 0;
  var parts = ["game", "kind"];
  for (var p = 0; p < parts.length; p++) {
    var src = raw[parts[p]];
    if (!src || typeof src !== "object") continue;
    for (var key in src) {
      var n = Number(src[key]);
      if (!/^[a-z0-9_-]{1,40}$/.test(key)) continue;
      if (parts[p] === "kind" && KINDS.indexOf(key) === -1) continue;
      if (isFinite(n) && n > 0) out[parts[p]][key] = Math.floor(n);
    }
  }
  return out;
}

function readSettings(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var row = util.settings(app);
  if (!row) return { tax_group_id: DEFAULT_TAX_GROUP, category_map: cleanMap(null) };
  var tax = row.getInt("epos_tax_group_id");
  return {
    tax_group_id: tax > 0 ? tax : DEFAULT_TAX_GROUP,
    category_map: cleanMap(util.jsonField(row, "epos_category_map", null)),
  };
}

function stateValue(app, key) {
  var util = require(__hooks + "/lib/vaultutil.js");
  try {
    var row = app.findFirstRecordByFilter("epos_sync_state", "key = {:key}", { key: key });
    return { value: util.jsonField(row, "value", null), updated: row.getString("updated") };
  } catch (err) {
    return { value: null, updated: null };
  }
}

// ---------------------------------------------------------------------
// Till sales
// ---------------------------------------------------------------------

/**
 * Apply one till sale line, inside the caller's transaction. The unique
 * index on (transaction_id, line) means the same line can only ever be
 * logged, and so applied, once. `line` is validated by the route.
 * Returns { result: applied | duplicate | flagged | unmatched, log }.
 */
function applySale(txApp, line) {
  try {
    var seen = txApp.findFirstRecordByFilter(
      "epos_sales_log",
      "transaction_id = {:t} && line = {:l}",
      { t: line.transaction_id, l: line.line }
    );
    return { result: "duplicate", log: seen.id };
  } catch (err) {
    // Not seen yet.
  }

  var log = new Record(txApp.findCollectionByNameOrId("epos_sales_log"));
  log.set("transaction_id", line.transaction_id);
  log.set("line", line.line);
  log.set("product_id", line.product_id);
  log.set("qty", line.qty);
  log.set("unit_price", line.unit_price);
  log.set("refund", line.refund);
  log.set("applied", false);
  if (line.occurred_at) log.set("occurred_at", line.occurred_at);

  function flag(note, result) {
    log.set("needs_check", true);
    log.set("note", note);
    txApp.save(log);
    return { result: result || "flagged", log: log.id };
  }

  var matches = [];
  try {
    matches = txApp.findRecordsByFilter("items", "epos_product_id = {:p}", "created", 2, 0, { p: line.product_id });
  } catch (err) {
    matches = [];
  }
  if (matches.length === 0) return flag("No Vault item has this Epos Now product.", "unmatched");
  if (matches.length > 1) return flag("Several Vault items share this Epos Now product. Check them by hand.");
  var item = matches[0];
  log.set("item", item.id);

  if (line.flag) return flag(String(line.flag).slice(0, 400));
  if (line.refund) {
    return flag("Refunded at the till. Check the item and put it back in stock by hand if it is back on the shelf.");
  }
  if (!(line.qty > 0)) return flag("The till line has no whole quantity to take off.");
  var status = item.getString("status");
  if (!sellable(status)) {
    return flag("Sold on the till but the Vault already has it as " + (status || "unknown") + ". Check for a double sale.");
  }

  var held = item.getInt("qty");
  if (held <= 0) held = 1; // a single with qty left blank is one card
  var left = held - line.qty;
  var note = "";
  if (left < 0) {
    note = "The till sold " + line.qty + " but the Vault held " + held + ". Count it.";
    left = 0;
  }
  item.set("qty", left);
  if (left === 0) item.set("status", "sold");
  item.set("epos_sale_price", line.unit_price);
  item.set("epos_transaction_id", line.transaction_id);
  if (line.occurred_at) item.set("epos_sold_at", line.occurred_at);
  txApp.save(item);

  log.set("applied", true);
  if (note) {
    log.set("needs_check", true);
    log.set("note", note);
  } else {
    log.set("note", left === 0 ? "Marked sold." : "Quantity now " + left + ".");
  }
  txApp.save(log);
  return { result: note ? "flagged" : "applied", log: log.id };
}

module.exports = {
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  DEFAULT_TAX_GROUP: DEFAULT_TAX_GROUP,
  SKU_PREFIX: SKU_PREFIX,
  KINDS: KINDS,
  sellable: sellable,
  enqueue: enqueue,
  enqueueFor: enqueueFor,
  enqueueDeleted: enqueueDeleted,
  statusFor: statusFor,
  stuck: stuck,
  cleanMap: cleanMap,
  readSettings: readSettings,
  stateValue: stateValue,
  applySale: applySale,
};
