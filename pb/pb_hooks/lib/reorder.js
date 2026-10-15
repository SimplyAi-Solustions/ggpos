/**
 * The supplier reorder report on the server (docs/api-contract-reorder.md,
 * section 3), behind GET /api/vault/reorder in reorder.pb.js: for the weekly
 * call with a supplier's rep, what of theirs is in stock, what sold in the
 * period, what is out, what to order and what customers have asked for.
 *
 * This file reads PocketBase and shapes what it finds into the pure module's
 * types (packages/shared/src/reorder.ts, through its generated copy in
 * lib/shared/reorder.js); the adding up is that module's, so the route and
 * the demo agree.
 *
 * - **Rows**: every stock row with `supplier` = the supplier, whatever its
 *   status. `onHand` is its `qty` while it is in stock, reserved or listed
 *   (the population every report agrees on, lib/reports/query.js
 *   STOCK_STATUS_FILTER), else 0.
 * - **Sold**: the units kept (sold less refunded) of the sale lines on those
 *   rows, on sales that occurred in the range. The lines are the margin
 *   report's own (`soldLines`), so the two never disagree.
 * - **Requests**: the supplier's open requests, oldest first.
 *
 * Money is whole pence. No cost is read or answered: any signed-in staff
 * member may see this.
 *
 * require() this from inside each handler - see pb/README.md on hook
 * isolation.
 */

var DATES_SENTENCE = "The dates do not make sense. Check the from and to dates.";
/** The longest range any report takes, both ends counted. */
var MAX_DAYS = 400;

function refusal(status, message) {
  return { ok: false, status: status, message: message };
}

/** A PocketBase date ("2026-10-09 14:00:00.000Z") as ISO text, "" when blank. */
function isoOf(value) {
  var text = String(value || "");
  if (!text) return "";
  var parsed = new Date(text.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

/** The statuses that count as on hand, read from the one filter every report shares. */
function heldStatuses() {
  var query = require(__hooks + "/lib/reports/query.js");
  var held = {};
  var pattern = /'([a-z_]+)'/g;
  var match = pattern.exec(query.STOCK_STATUS_FILTER);
  while (match) {
    held[match[1]] = true;
    match = pattern.exec(query.STOCK_STATUS_FILTER);
  }
  return held;
}

/**
 * The range to report on. Both ends left out is the last seven days ending
 * today in shop time (`defaultReorderPeriod`); a `to` alone gives the seven
 * days ending there, a `from` alone runs to today. Refused when either is
 * not a real YYYY-MM-DD date, when from is after to, or when the range is
 * longer than 400 days.
 */
function resolvePeriod(from, to) {
  var dates = require(__hooks + "/lib/reports/dates.js");
  var shared = require(__hooks + "/lib/shared/reorder.js");
  var bookings = require(__hooks + "/lib/shared/bookings.js");

  if ((from && !dates.isValidDateStr(from)) || (to && !dates.isValidDateStr(to))) {
    return refusal(400, DATES_SENTENCE);
  }
  var end = to || bookings.shopDateOf(new Date());
  var start = from || shared.defaultReorderPeriod(end).from;
  if (start > end || dates.daysBetweenInclusive(start, end) > MAX_DAYS) {
    return refusal(400, DATES_SENTENCE);
  }
  return { ok: true, from: start, to: end };
}

/** The supplier as the report names it. */
function supplierView(record) {
  return {
    id: record.id,
    name: record.getString("name"),
    accountNumber: record.getString("account_number"),
    repName: record.getString("rep_name"),
    repEmail: record.getString("rep_email"),
    repPhone: record.getString("rep_phone"),
  };
}

/** Every stock row of the supplier's as the pure module's ReorderItem. */
function readItems(app, supplierId) {
  var query = require(__hooks + "/lib/reports/query.js");
  var held = heldStatuses();
  var categoryLookup = query.cachedLookup(app, "categories");

  var rows = query.findAllByFilter(app, "items", "supplier = {:supplier}", "created,id", { supplier: supplierId });
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var category = categoryLookup(row.getString("category"));
    var target = row.getInt("shelf_target");
    out.push({
      id: row.id,
      sku: row.getString("sku"),
      title: row.getString("title") || row.getString("sku"),
      ean: row.getString("ean"),
      supplierCode: row.getString("supplier_code"),
      categoryPath: category ? category.getString("path") : "",
      onHand: held[row.getString("status")] ? Math.max(0, row.getInt("qty")) : 0,
      shelfTarget: target > 0 ? target : null,
      price: row.getInt("price"),
      updated: isoOf(row.getString("updated")),
    });
  }
  return out;
}

/**
 * Units kept of the supplier's rows in the range, one entry per sale line,
 * counted by the margin report's `soldLines` (a line refunded in full keeps
 * nothing and is left out).
 */
function readSold(app, util, itemIds, from, to) {
  var margin = require(__hooks + "/lib/reports/margin.js");
  var wanted = {};
  for (var i = 0; i < itemIds.length; i++) wanted[itemIds[i]] = true;

  var sold = [];
  var walked = margin.soldLines(app, util, from, to);
  for (var j = 0; j < walked.length; j++) {
    var itemId = walked[j].line.getString("item");
    if (!itemId || !wanted[itemId] || walked[j].soldQty <= 0) continue;
    sold.push({ itemId: itemId, qty: walked[j].soldQty });
  }
  return sold;
}

/** The supplier's open requests, oldest first, as StockRequestView. */
function readRequests(app, supplierId) {
  var query = require(__hooks + "/lib/reports/query.js");
  var shared = require(__hooks + "/lib/shared/reorder.js");

  var clauses = [];
  var params = { supplier: supplierId };
  for (var s = 0; s < shared.OPEN_REQUEST_STATUSES.length; s++) {
    clauses.push("status = {:s" + s + "}");
    params["s" + s] = shared.OPEN_REQUEST_STATUSES[s];
  }
  var rows = query.findAllByFilter(
    app,
    "stock_requests",
    "supplier = {:supplier} && (" + clauses.join(" || ") + ")",
    "created,id",
    params
  );

  var customerLookup = query.cachedLookup(app, "customers");
  var staffLookup = query.cachedLookup(app, "staff");
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var customer = customerLookup(row.getString("customer"));
    var maker = staffLookup(row.getString("created_by"));
    out.push({
      id: row.id,
      supplierId: row.getString("supplier"),
      title: row.getString("title"),
      qty: Math.max(1, row.getInt("qty")),
      customerId: customer ? customer.id : "",
      customerName: customer ? customer.getString("name") : "",
      customerCode: customer ? customer.getString("code") : "",
      contactName: row.getString("contact_name"),
      contactPhone: row.getString("contact_phone"),
      notes: row.getString("notes"),
      status: row.getString("status"),
      created: isoOf(row.getString("created")),
      statusChangedAt: isoOf(row.getString("status_changed_at")) || isoOf(row.getString("created")),
      createdByName: maker ? maker.getString("name") : "",
    });
  }
  return out;
}

/**
 * The report for `params.supplier` (an id) over `params.from` to `params.to`
 * (YYYY-MM-DD, either or both left out).
 * @returns {{ok: true, report: object} | {ok: false, status: number, message: string}}
 */
function build(app, util, params) {
  var shared = require(__hooks + "/lib/shared/reorder.js");

  var supplierId = params.supplier || "";
  if (!supplierId) return refusal(400, "Choose a supplier.");
  var supplier = null;
  try {
    supplier = app.findRecordById("suppliers", supplierId);
  } catch (err) {
    supplier = null;
  }
  if (!supplier) return refusal(404, "That supplier was not found.");

  var period = resolvePeriod(params.from || "", params.to || "");
  if (!period.ok) return period;

  var items = readItems(app, supplier.id);
  var ids = [];
  for (var i = 0; i < items.length; i++) ids.push(items[i].id);
  var sold = readSold(app, util, ids, period.from, period.to);
  var requests = readRequests(app, supplier.id);

  var lines = shared.buildReorderLines(items, sold);
  return {
    ok: true,
    report: {
      supplier: supplierView(supplier),
      from: period.from,
      to: period.to,
      lines: lines,
      totals: shared.reorderTotals(lines, requests),
      requests: requests,
    },
  };
}

module.exports = {
  build: build,
  resolvePeriod: resolvePeriod,
};
