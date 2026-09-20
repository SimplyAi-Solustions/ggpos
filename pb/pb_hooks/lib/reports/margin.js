/**
 * "margin" report: gross margin per period and by game, kind or staff (sale
 * price net of refunds minus cost), the margin-scheme VAT estimate, and
 * markdowns (docs/PLAN.md, "Reporting"; docs/api-contract.md, Phase 4).
 *
 * Margin-scheme VAT estimate: HMRC's margin scheme charges VAT on one sixth
 * of the POSITIVE margin on margin-scheme lines (the VAT fraction of the
 * standard 20 percent rate: margin/6 = margin * 20/120). This is an
 * estimate for the reports screen, not a return, and reads zero whenever
 * settings.vat_registered is off - CLAUDE.md's "Pricing" section treats a
 * concrete VAT figure as a business decision, never invented.
 *
 * Markdowns use price versus market_at_intake as the proxy the brief asks
 * for: an item whose current price sits below what it was taken in at
 * counts as marked down. This is a proxy, not a record of every price
 * change actually made - said so here and in docs/api-contract.md.
 *
 * require() this from inside reports.pb.js's handler (or another report
 * that reuses it) - see pb/README.md on pb_hooks isolation.
 */

var VALID_BY = { game: true, kind: true, staff: true };

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var saleline = require(`${__hooks}/lib/shared/saleline.js`);
  var money = require(`${__hooks}/lib/shared/money.js`);

  var by = VALID_BY[params.by] ? params.by : "game";
  var group = params.group;
  var bounds = dates.rangeParams(params.from, params.to);

  var linesInRange = [];
  try {
    linesInRange = app.findRecordsByFilter(
      "sale_lines",
      "sale.occurred_at >= {:start} && sale.occurred_at <= {:end}",
      "created,id",
      0,
      0,
      bounds
    );
  } catch (err) {
    linesInRange = [];
  }

  var itemLookup = query.cachedLookup(app, "items");
  var staffLookup = query.cachedLookup(app, "staff");
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

  var byDay = {};
  var groups = query.grouper();
  var totalRevenue = 0;
  var totalCost = 0;
  var vatableMargin = 0; // positive margin on margin-scheme lines only

  for (var i = 0; i < linesInRange.length; i++) {
    var line = linesInRange[i];
    if (!line) continue;
    var held = saleBreakdown(line.getString("sale"));
    if (!held) continue;
    var entry = held.breakdown.byId[line.id];
    if (!entry) continue;
    var soldQty = saleline.remainingQty(entry);
    if (soldQty <= 0) continue; // refunded in full: nothing was sold

    var soldNet = entry.net - saleline.cumNet(entry.net, entry.qty, entry.refundedQty);
    var item = itemLookup(line.getString("item"));
    var unitCost = item ? item.getInt("cost") : 0;
    var cost = unitCost * soldQty;
    var margin = soldNet - cost;

    totalRevenue += soldNet;
    totalCost += cost;
    if (line.getString("tax_scheme") === "margin" && margin > 0) vatableMargin += margin;

    var dayKey = (held.sale.getString("occurred_at") || "").slice(0, 10);
    if (dayKey) {
      if (!byDay[dayKey]) byDay[dayKey] = { revenue: 0, cost: 0 };
      byDay[dayKey].revenue += soldNet;
      byDay[dayKey].cost += cost;
    }

    var key = "";
    var label = "";
    if (by === "staff") {
      key = held.sale.getString("staff") || "";
      var staffRow = staffLookup(key);
      label = staffRow ? staffRow.getString("name") : "(unassigned)";
    } else if (by === "kind") {
      key = item ? item.getString("kind") : "";
      label = key || "(unknown)";
    } else {
      var gameId = item ? item.getString("game") : "";
      key = gameId || "";
      var gameRow = gameLookup(gameId);
      label = gameRow ? gameRow.getString("name") : "(none)";
    }
    var bucket = groups.get(key, label);
    bucket.revenue = (bucket.revenue || 0) + soldNet;
    bucket.cost = (bucket.cost || 0) + cost;
    bucket.margin = (bucket.margin || 0) + margin;
  }

  var dayKeys = dates.eachDay(params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  for (var d = 0; d < dayKeys.length; d++) {
    var dayEntry = byDay[dayKeys[d]] || { revenue: 0, cost: 0 };
    var label2 = dates.groupLabel(dayKeys[d], group);
    if (!byLabel[label2]) {
      byLabel[label2] = { revenue: 0, cost: 0 };
      labelOrder.push(label2);
    }
    byLabel[label2].revenue += dayEntry.revenue;
    byLabel[label2].cost += dayEntry.cost;
  }
  var series = [];
  for (var l = 0; l < labelOrder.length; l++) {
    var e = byLabel[labelOrder[l]];
    series.push({ label: labelOrder[l], values: { revenue: e.revenue, cost: e.cost, margin: e.revenue - e.cost } });
  }

  var table = groups.rows();
  for (var g = 0; g < table.length; g++) {
    table[g].margin_pct = table[g].revenue > 0 ? Math.round((table[g].margin / table[g].revenue) * 1000) / 10 : 0;
  }

  var settingsRow = util.settings(app);
  var vatRegistered = settingsRow ? settingsRow.getBool("vat_registered") : false;
  var vatEstimate = vatRegistered ? money.roundHalfUp(vatableMargin / 6) : 0;

  // --- Markdowns: current price below the market it was taken in at ------
  var markdownItems = [];
  try {
    markdownItems = app.findRecordsByFilter(
      "items",
      "price > 0 && market_at_intake > 0 && price < market_at_intake",
      "",
      0,
      0
    );
  } catch (err) {
    markdownItems = [];
  }
  var markdownValue = 0;
  for (var mi = 0; mi < markdownItems.length; mi++) {
    markdownValue += markdownItems[mi].getInt("market_at_intake") - markdownItems[mi].getInt("price");
  }

  var totalMargin = totalRevenue - totalCost;
  var totals = {
    revenue: totalRevenue,
    cost: totalCost,
    margin: totalMargin,
    margin_pct: totalRevenue > 0 ? Math.round((totalMargin / totalRevenue) * 1000) / 10 : 0,
    vat_estimate: vatEstimate,
    markdown_count: markdownItems.length,
    markdown_value: markdownValue,
  };

  return {
    series: series,
    table: table,
    totals: totals,
    csvColumns: [
      { key: "label", label: "Group" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "cost", label: "Cost", money: true },
      { key: "margin", label: "Margin", money: true },
      { key: "margin_pct", label: "Margin %" },
    ],
  };
}

module.exports = { build: build, VALID_BY: VALID_BY };
