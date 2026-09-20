/**
 * "sales" report: revenue by day/week/month; by game, kind, staff or
 * payment method; average basket; an hour-of-day heatmap for staffing
 * (docs/PLAN.md, "Reporting"; docs/api-contract.md, Phase 4).
 *
 * The period series and totals read pb_hooks/lib/reports/daily.js's
 * daily_stats row per day (falling back to a fresh, unsaved computation for
 * any day the nightly cron has not reached yet - see daily.js's
 * rowForDate). The by=<dimension> table reads sale_lines directly, because
 * daily_stats carries no per-game/kind/staff breakdown: each line's
 * net-of-discount, net-of-refund contribution comes from the shared
 * saleline evaluator, the same one the stock book and the refund route use,
 * so this can never disagree with either of them about what a line
 * actually made.
 *
 * require() this from inside reports.pb.js's handler (or another report
 * that reuses it) - see pb/README.md on pb_hooks isolation.
 */

var VALID_BY = { game: true, kind: true, staff: true, payment: true };

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var daily = require(`${__hooks}/lib/reports/daily.js`);
  var saleline = require(`${__hooks}/lib/shared/saleline.js`);

  var by = VALID_BY[params.by] ? params.by : "game";
  var group = params.group;

  // --- Series and totals: from the daily_stats row per day ----------------
  var days = dates.eachDay(params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  var totalRevenue = 0;
  var totalCount = 0;
  for (var d = 0; d < days.length; d++) {
    var row = daily.rowForDate(app, days[d]);
    var revenue = 0;
    var methods = Object.keys(row.sales_total_by_payment || {});
    for (var m = 0; m < methods.length; m++) revenue += row.sales_total_by_payment[methods[m]] || 0;

    var label = dates.groupLabel(days[d], group);
    if (!byLabel[label]) {
      byLabel[label] = { revenue: 0, count: 0 };
      labelOrder.push(label);
    }
    byLabel[label].revenue += revenue;
    byLabel[label].count += row.sales_count;

    totalRevenue += revenue;
    totalCount += row.sales_count;
  }
  var series = [];
  for (var l = 0; l < labelOrder.length; l++) {
    var e = byLabel[labelOrder[l]];
    series.push({
      label: labelOrder[l],
      values: { revenue: e.revenue, count: e.count, avg_basket: e.count > 0 ? Math.round(e.revenue / e.count) : 0 },
    });
  }

  // --- Hour-of-day heatmap: every sale in range, by weekday and hour ------
  var heatmap = [];
  for (var wd = 0; wd < 7; wd++) heatmap.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  var bounds = dates.rangeParams(params.from, params.to);
  var salesInRange = [];
  try {
    salesInRange = app.findRecordsByFilter(
      "sales",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    salesInRange = [];
  }
  for (var s = 0; s < salesInRange.length; s++) {
    var sale = salesInRange[s];
    if (!sale) continue;
    var created = new Date(sale.getString("created"));
    if (isNaN(created.getTime())) continue;
    heatmap[dates.isoWeekday(created)][created.getUTCHours()] += 1;
  }

  // --- by=<dimension> table: net-of-discount, net-of-refund per line -----
  var staffLookup = query.cachedLookup(app, "staff");
  var itemLookup = query.cachedLookup(app, "items");
  var gameLookup = query.cachedLookup(app, "games");
  var saleCache = {};

  function saleBreakdown(saleId) {
    if (Object.prototype.hasOwnProperty.call(saleCache, saleId)) return saleCache[saleId];
    var result = null;
    try {
      var saleRecord = app.findRecordById("sales", saleId);
      var rows = util.saleLineRows(app, saleId);
      result = {
        sale: saleRecord,
        breakdown: saleline.breakdown(util.asSoldLines(rows), saleRecord.getInt("discount")),
      };
    } catch (err) {
      result = null;
    }
    saleCache[saleId] = result;
    return result;
  }

  var linesInRange = [];
  try {
    linesInRange = app.findRecordsByFilter(
      "sale_lines",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    linesInRange = [];
  }

  var groups = query.grouper();
  for (var i = 0; i < linesInRange.length; i++) {
    var line = linesInRange[i];
    if (!line) continue;
    var held = saleBreakdown(line.getString("sale"));
    if (!held) continue;
    var entry = held.breakdown.byId[line.id];
    if (!entry) continue;
    var soldNet = entry.net - saleline.cumNet(entry.net, entry.qty, entry.refundedQty);

    var key = "";
    var label2 = "";
    if (by === "payment") {
      // Blank payment is an eBay-import sale (eBay took the money) -
      // "none", the same bucket name daily_stats.sales_total_by_payment
      // uses, never blank and never folded into some other method.
      key = held.sale.getString("payment") || "none";
      label2 = key === "none" ? "(none)" : key;
    } else if (by === "staff") {
      key = held.sale.getString("staff") || "";
      var staffRow = staffLookup(key);
      label2 = staffRow ? staffRow.getString("name") : "(unassigned)";
    } else {
      var item = itemLookup(line.getString("item"));
      if (by === "kind") {
        key = item ? item.getString("kind") : "";
        label2 = key || "(unknown)";
      } else {
        var gameId = item ? item.getString("game") : "";
        var gameRow = gameLookup(gameId);
        key = gameId || "";
        label2 = gameRow ? gameRow.getString("name") : "(none)";
      }
    }
    var bucket = groups.get(key, label2);
    bucket.revenue = (bucket.revenue || 0) + soldNet;
    bucket.count = (bucket.count || 0) + 1;
  }

  var totals = {
    revenue: totalRevenue,
    count: totalCount,
    avg_basket: totalCount > 0 ? Math.round(totalRevenue / totalCount) : 0,
    heatmap: heatmap,
  };

  return {
    series: series,
    table: groups.rows(),
    totals: totals,
    csvColumns: [
      { key: "label", label: "Group" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "count", label: "Lines" },
    ],
  };
}

module.exports = { build: build, VALID_BY: VALID_BY };
