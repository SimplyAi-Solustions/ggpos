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
 * `by=category` (docs/api-contract-inventory.md, section 1.4) groups the
 * lines by their home branch in the category tree, one level at a time:
 * the top-level branches, or with `branch=<id>` that branch's child
 * branches plus an "In <name> itself" row for lines homed on the branch
 * itself, each row saying whether it has branches beneath it (`has_children`)
 * so the screen can drill down. A line's home is its till product's branch
 * or its stock line's.
 *
 * require() this from inside reports.pb.js's handler (or another report
 * that reuses it) - see pb/README.md on pb_hooks isolation.
 */

var VALID_BY = { game: true, kind: true, staff: true, payment: true, category: true };

/**
 * What `by=category` needs to place a line: the tree, and the branch being
 * drilled into (null for the top level, also for a `branch` that no longer
 * exists, the way an unknown `by` falls back rather than failing a saved view).
 */
function categoryView(app, branchId) {
  var categories = require(`${__hooks}/lib/categories.js`);
  var tree = categories.loadTree(app);
  return { tree: tree, branch: branchId ? tree.byId[branchId] || null : null };
}

/**
 * `{ key, label, path, has_children }` for a node as a row of the table. The
 * "In <name> itself" row (given its label) is the current level, so there is
 * nothing beneath it to drill into.
 */
function branchRow(node, label) {
  return {
    key: node.row.id,
    label: label || node.row.name,
    path: label ? node.path + " (itself)" : node.path,
    has_children: label ? false : node.children.length > 0,
  };
}

/**
 * The table row a line belongs to given its home branch id, or null when the
 * line is outside the branch being drilled into. At the top level a line with
 * no home branch at all is "(none)"; inside a branch every row is a child of
 * it, or the branch itself.
 */
function categoryRowFor(view, homeId) {
  var shared = require(`${__hooks}/lib/shared/categories.js`);
  var node = homeId ? view.tree.byId[homeId] : null;
  if (!view.branch) {
    if (!node) return { key: "", label: "(none)", path: "", has_children: false };
    var top = view.tree.byId[node.lineage.split("|")[1]];
    return branchRow(top);
  }
  if (!node || !shared.isWithin(node.lineage, view.branch.row.id)) return null;
  if (node.row.id === view.branch.row.id) return branchRow(node, "In " + node.row.name + " itself");
  // The ancestor one level below the branch: lineage is "|a|b|c|", depth counts from 0.
  var childId = node.lineage.split("|")[view.branch.depth + 2];
  return branchRow(view.tree.byId[childId]);
}

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var daily = require(`${__hooks}/lib/reports/daily.js`);
  var saleline = require(`${__hooks}/lib/shared/saleline.js`);
  var money = require(`${__hooks}/lib/shared/money.js`);
  var paymentLabels = require(`${__hooks}/lib/shared/epos-types.js`).TENDER_LABELS;

  var by = VALID_BY[params.by] ? params.by : "game";
  var group = params.group;

  // --- Series and totals: from the daily_stats row per day ----------------
  var days = dates.eachDay(params.from, params.to);
  var dayRows = daily.rowsForEachDay(app, params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  var totalRevenue = 0;
  var totalCount = 0;
  for (var d = 0; d < days.length; d++) {
    var row = dayRows[d];
    var gross = 0;
    var methods = Object.keys(row.sales_total_by_payment || {});
    for (var m = 0; m < methods.length; m++) gross += row.sales_total_by_payment[methods[m]] || 0;
    // Net of every refund against a sale that occurred this day, whichever
    // day the refund itself was processed on - daily.js's own
    // sales_refunded note and docs/api-contract.md's Phase 4 section.
    var revenue = gross - (row.sales_refunded || 0);

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
      values: { revenue: e.revenue, count: e.count, avg_basket: e.count > 0 ? money.roundHalfUp(e.revenue / e.count) : 0 },
    });
  }

  // --- Hour-of-day heatmap: every sale in range, by weekday and hour ------
  // sales.occurred_at, not created - see daily.js's own header note: an
  // eBay-import sale is booked on the order's own date, not the day the
  // import happened to run. The heatmap itself reads in UK civil time
  // (dates.toLondon): a staffing chart keyed to opening hours means more
  // read as "9am-5pm" the way the shop actually experiences it, not
  // shifted an hour out over BST - every day bucket elsewhere in this
  // package (the series above, group=day/week/month) stays plain UTC, only
  // the heatmap's own weekday and hour convert. See dates.js's own note.
  var heatmap = [];
  for (var wd = 0; wd < 7; wd++) heatmap.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  var bounds = dates.rangeParams(params.from, params.to);
  var salesInRange = [];
  try {
    salesInRange = app.findRecordsByFilter(
      "sales",
      "occurred_at >= {:start} && occurred_at <= {:end}",
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
    var occurredAt = new Date(sale.getString("occurred_at"));
    if (isNaN(occurredAt.getTime())) continue;
    var local = dates.toLondon(occurredAt);
    heatmap[dates.isoWeekday(local)][local.getUTCHours()] += 1;
  }

  // --- by=<dimension> table: net-of-discount, net-of-refund per line -----
  var staffLookup = query.cachedLookup(app, "staff");
  var itemLookup = query.cachedLookup(app, "items");
  var productLookup = query.cachedLookup(app, "till_products");
  var gameLookup = query.cachedLookup(app, "games");
  var categoryTree = by === "category" ? categoryView(app, params.branch || "") : null;

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
  // One batched sales fetch for every sale referenced in linesInRange,
  // grouping the lines already in hand rather than a findRecordById plus a
  // fresh sale_lines re-query per sale - see query.saleBreakdownsByLine.
  // "created,id" order above matters here: saleline.js's own discount
  // rounding puts any remainder on the last line of each sale, and that
  // has to be the same line the sale itself allocated it to.
  var breakdownsBySale = query.saleBreakdownsByLine(app, util, linesInRange);

  var groups = query.grouper();
  for (var i = 0; i < linesInRange.length; i++) {
    var line = linesInRange[i];
    if (!line) continue;
    var held = breakdownsBySale[line.getString("sale")];
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
      // The tender's own label, so a historic SumUp sale reads "Card
      // (SumUp)" beside the till's "Card" (docs/api-contract-epos.md,
      // section 5).
      label2 =
        key === "none" ? "(none)" : key === "mixed" ? "Mixed" : paymentLabels[key] || key;
    } else if (by === "staff") {
      key = held.sale.getString("staff") || "";
      var staffRow = staffLookup(key);
      label2 = staffRow ? staffRow.getString("name") : "(unassigned)";
    } else if (by === "category") {
      var homeRecord = line.getString("product")
        ? productLookup(line.getString("product"))
        : itemLookup(line.getString("item"));
      var home = categoryRowFor(categoryTree, homeRecord ? homeRecord.getString("category") : "");
      if (!home) continue;
      var homeBucket = groups.get(home.key, home.label);
      homeBucket.path = home.path;
      homeBucket.has_children = home.has_children;
      homeBucket.revenue = (homeBucket.revenue || 0) + soldNet;
      homeBucket.count = (homeBucket.count || 0) + 1;
      continue;
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
    avg_basket: totalCount > 0 ? money.roundHalfUp(totalRevenue / totalCount) : 0,
    heatmap: heatmap,
  };

  var table = groups.rows();
  var csvColumns = [
    { key: "label", label: "Group" },
    { key: "revenue", label: "Revenue", money: true },
    { key: "count", label: "Lines" },
  ];
  if (by === "category") {
    // Largest first, each row also carrying `net` (the contract's name for
    // the figure the other dimensions call `revenue`), and a CSV that names
    // each branch by its full path.
    for (var t = 0; t < table.length; t++) table[t].net = table[t].revenue;
    table.sort(function (a, b) {
      return b.net - a.net || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    });
    csvColumns = [
      { key: "path", label: "Branch" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "count", label: "Lines" },
    ];
  }

  return {
    series: series,
    table: table,
    totals: totals,
    csvColumns: csvColumns,
  };
}

/** totals keys that are pence, not a plain count - lib/reports/scheduled.js's
 * emailed totals read this instead of guessing from the field name. */
var MONEY_FIELDS = { revenue: true, avg_basket: true };

/** totals keys that are actually a function of params.from/to - every one
 * here is, so reports.pb.js's ?compare= shows all of them. See
 * lib/reports/stock.js's own note for a builder where that is not true. */
var PERIOD_SCOPED_TOTALS = { revenue: true, count: true, avg_basket: true, heatmap: true };

module.exports = {
  build: build,
  VALID_BY: VALID_BY,
  MONEY_FIELDS: MONEY_FIELDS,
  PERIOD_SCOPED_TOTALS: PERIOD_SCOPED_TOTALS,
};
