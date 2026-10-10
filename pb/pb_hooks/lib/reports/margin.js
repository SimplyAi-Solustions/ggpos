/**
 * "margin" report: gross margin per period and by game, kind or staff (sale
 * price net of refunds minus cost), the margin-scheme VAT estimate, and
 * markdowns (docs/PLAN.md, "Reporting"; docs/api-contract.md, Phase 4).
 *
 * Margin-scheme VAT estimate: HMRC's margin scheme charges VAT on the
 * standard rate's fraction (one sixth at 20 percent) of each margin-scheme
 * line's POSITIVE margin, line by line and rounded half-up per line, through
 * lib/shared/vat.js's `marginVat`, the same figure the dashboard and the VAT
 * return use (docs/api-contract-launch.md, section 3). It reads zero for a
 * sale outside the VAT registration (VAT off, or before
 * `settings.vat_registered_from`).
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

/**
 * Every line of every sale that occurred in the range (`sale.occurred_at`,
 * UTC days), in "created,id" order, as kept after its refunds: the line,
 * its sale, its as-sold breakdown (lib/shared/saleline.js, the arithmetic
 * the refund route and the stock book use), the units and the net kept, the
 * stock item and what the units kept cost. A line refunded in full is
 * included with nothing kept. This report and the dashboard
 * (lib/reports/dashboard.js) both walk the range through this one function,
 * so their revenue and cost agree to the penny.
 *
 * @returns {Array<{line, sale, entry, soldQty, soldNet, item, unitCost, cost}>}
 */
function soldLines(app, util, from, to) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var saleline = require(`${__hooks}/lib/shared/saleline.js`);

  var bounds = dates.rangeParams(from, to);
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
  // One batched sales fetch for every sale referenced in linesInRange,
  // grouping the lines already in hand rather than a findRecordById plus a
  // fresh sale_lines re-query per sale - see query.saleBreakdownsByLine.
  var breakdownsBySale = query.saleBreakdownsByLine(app, util, linesInRange);

  var out = [];
  for (var i = 0; i < linesInRange.length; i++) {
    var line = linesInRange[i];
    if (!line) continue;
    var held = breakdownsBySale[line.getString("sale")];
    if (!held) continue;
    var entry = held.breakdown.byId[line.id];
    if (!entry) continue;
    var soldQty = saleline.remainingQty(entry);
    var item = itemLookup(line.getString("item"));
    var unitCost = item ? item.getInt("cost") : 0;
    out.push({
      line: line,
      sale: held.sale,
      entry: entry,
      soldQty: soldQty,
      soldNet: entry.net - saleline.cumNet(entry.net, entry.qty, entry.refundedQty),
      item: item,
      unitCost: unitCost,
      cost: unitCost * soldQty,
    });
  }
  return out;
}

/** A PocketBase date ("2026-10-09 14:00:00.000Z") as a Date. */
function pbDate(value) {
  return new Date(String(value || "").replace(" ", "T"));
}

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var vat = require(`${__hooks}/lib/shared/vat.js`);

  var by = VALID_BY[params.by] ? params.by : "game";
  var group = params.group;

  var staffLookup = query.cachedLookup(app, "staff");
  var gameLookup = query.cachedLookup(app, "games");

  // The margin scheme's VAT, line by line, exactly as the dashboard and the
  // VAT return work it: inside the registration only (lib/shared/vat.js).
  var settingsRow = util.settings(app);
  var registration = {
    registered: settingsRow ? settingsRow.getBool("vat_registered") : false,
    from: settingsRow ? settingsRow.getString("vat_registered_from") : "",
  };
  var standardRate = vat.standardRateOf(settingsRow ? settingsRow.getFloat("vat_standard_rate") : 0);

  var byDay = {};
  var groups = query.grouper();
  var totalRevenue = 0;
  var totalCost = 0;
  var vatEstimate = 0;

  var walked = soldLines(app, util, params.from, params.to);
  for (var i = 0; i < walked.length; i++) {
    var held = walked[i];
    var line = held.line;
    if (held.soldQty <= 0) continue; // refunded in full: nothing was sold

    var soldNet = held.soldNet;
    var item = held.item;
    var cost = held.cost;
    var margin = soldNet - cost;

    totalRevenue += soldNet;
    totalCost += cost;
    if (
      line.getString("tax_scheme") === "margin" &&
      vat.vatApplies(registration, pbDate(held.sale.getString("occurred_at")))
    ) {
      vatEstimate += vat.marginVat(margin, standardRate);
    }

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
    table[g].margin_pct = table[g].revenue > 0 ? query.roundPct((table[g].margin / table[g].revenue) * 100) : 0;
  }

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
    margin_pct: totalRevenue > 0 ? query.roundPct((totalMargin / totalRevenue) * 100) : 0,
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

/** totals keys that are pence, not a plain count or percent -
 * lib/reports/scheduled.js's emailed totals read this instead of guessing
 * from the field name. */
var MONEY_FIELDS = { revenue: true, cost: true, margin: true, vat_estimate: true, markdown_value: true };

/**
 * totals keys that are actually a function of params.from/to.
 * markdown_count/markdown_value are left out: they come from every item
 * currently priced below its market_at_intake, with no date filter at all
 * (this file's own "Markdowns" note above) - a snapshot of stock as it
 * stands, not something a "previous period" figure could meaningfully
 * differ on.
 */
var PERIOD_SCOPED_TOTALS = {
  revenue: true,
  cost: true,
  margin: true,
  margin_pct: true,
  vat_estimate: true,
};

module.exports = {
  build: build,
  soldLines: soldLines,
  pbDate: pbDate,
  VALID_BY: VALID_BY,
  MONEY_FIELDS: MONEY_FIELDS,
  PERIOD_SCOPED_TOTALS: PERIOD_SCOPED_TOTALS,
};
