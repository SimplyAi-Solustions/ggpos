/**
 * "compliance" report (admin): the buy-in register (trade-ins with seller
 * snapshots) as a table, and a pointer to the stock book export
 * (docs/PLAN.md, "Reporting" and "Security, GDPR and record keeping";
 * docs/api-contract.md, Phase 4). auditCsvRows backs the separate
 * GET /api/vault/reports/audit.csv (admin) export.
 *
 * require() this from inside reports.pb.js's handler - see pb/README.md.
 */

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var bounds = dates.rangeParams(params.from, params.to);

  // Paged (query.findAllByFilter) rather than one unbounded read: a long
  // compliance range (a year of trade-ins, for an audit) is the one load
  // in this report with no small natural cap.
  var tradeIns = query.findAllByFilter(
    app,
    "trade_ins",
    "status = 'completed' && completed_at >= {:start} && completed_at <= {:end}",
    "completed_at",
    bounds
  );

  var tradeInIds = [];
  for (var ti = 0; ti < tradeIns.length; ti++) {
    if (tradeIns[ti]) tradeInIds.push(tradeIns[ti].id);
  }
  // One batched query for every accepted line across every trade-in in
  // range, not one findRecordsByFilter per trade-in (query.queryByIds).
  var lines = query.queryByIds(app, "trade_in_lines", "trade_in", tradeInIds, "accepted = true", {}, "");
  var lineCountByTradeIn = {};
  for (var ln = 0; ln < lines.length; ln++) {
    var tid = lines[ln].getString("trade_in");
    lineCountByTradeIn[tid] = (lineCountByTradeIn[tid] || 0) + 1;
  }

  var table = [];
  for (var i = 0; i < tradeIns.length; i++) {
    var tradeIn = tradeIns[i];
    if (!tradeIn) continue;
    table.push({
      id: tradeIn.id,
      number: tradeIn.getString("number"),
      completed_at: tradeIn.getString("completed_at"),
      seller_name: tradeIn.getString("seller_name"),
      seller_address: tradeIn.getString("seller_address"),
      id_type: tradeIn.getString("seller_id_type"),
      items: lineCountByTradeIn[tradeIn.id] || 0,
      total_offer: tradeIn.getInt("total_offer"),
    });
  }

  var totals = {
    count: table.length,
    stock_book_url: "/api/vault/exports/stock-book?from=" + params.from + "&to=" + params.to,
  };

  return {
    series: [],
    table: table,
    totals: totals,
    csvColumns: [
      { key: "number", label: "Number" },
      { key: "completed_at", label: "Completed at" },
      { key: "seller_name", label: "Seller name" },
      { key: "seller_address", label: "Seller address" },
      { key: "id_type", label: "ID type" },
      { key: "items", label: "Items" },
      { key: "total_offer", label: "Total offer", money: true },
    ],
  };
}

/** Audit log rows for GET /api/vault/reports/audit.csv?from&to (admin). */
function auditCsvRows(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var bounds = dates.rangeParams(params.from, params.to);
  var rows = [];
  try {
    rows = app.findRecordsByFilter("audit_log", "created >= {:start} && created <= {:end}", "created", 0, 0, bounds);
  } catch (err) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var meta = "";
    try {
      meta = JSON.stringify(util.jsonField(row, "meta", {}) || {});
    } catch (err) {
      meta = "";
    }
    out.push({
      created: row.getString("created"),
      actor: row.getString("actor"),
      action: row.getString("action"),
      collection: row.getString("collection"),
      record: row.getString("record"),
      meta: meta,
      ip: row.getString("ip"),
    });
  }
  return out;
}

var AUDIT_CSV_COLUMNS = [
  { key: "created", label: "Created" },
  { key: "actor", label: "Actor" },
  { key: "action", label: "Action" },
  { key: "collection", label: "Collection" },
  { key: "record", label: "Record" },
  { key: "meta", label: "Meta" },
  { key: "ip", label: "IP" },
];

/** No totals key here is money in pence (total_offer is a per-row table
 * figure, not a totals one) - declared anyway so scheduled.js never has to
 * guess from a field name. */
var MONEY_FIELDS = {};

/** totals keys that are actually a function of params.from/to - both are:
 * count from the range-bound trade-ins query, stock_book_url built from
 * params.from/to directly. */
var PERIOD_SCOPED_TOTALS = { count: true, stock_book_url: true };

module.exports = {
  build: build,
  auditCsvRows: auditCsvRows,
  AUDIT_CSV_COLUMNS: AUDIT_CSV_COLUMNS,
  MONEY_FIELDS: MONEY_FIELDS,
  PERIOD_SCOPED_TOTALS: PERIOD_SCOPED_TOTALS,
};
