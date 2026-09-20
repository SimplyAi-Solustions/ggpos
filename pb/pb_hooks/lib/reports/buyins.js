/**
 * "buyins" report: spend by game or staff; average offer as a percent of
 * market; cash vs credit mix; items bought vs sold ratio; top sellers to
 * the shop (docs/PLAN.md, "Reporting"; docs/api-contract.md, Phase 4).
 *
 * Series and headline totals read daily_stats per day (daily.rowForDate);
 * the by=<dimension> table and the offer-percent, cash/credit mix and top
 * sellers figures read trade_ins/trade_in_lines directly for the range,
 * since daily_stats carries no dimension breakdown.
 *
 * require() this from inside reports.pb.js's handler (or another report
 * that reuses it) - see pb/README.md on pb_hooks isolation.
 */

var VALID_BY = { game: true, staff: true };

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var daily = require(`${__hooks}/lib/reports/daily.js`);

  var by = VALID_BY[params.by] ? params.by : "game";
  var group = params.group;

  // --- Series and headline totals from daily_stats -------------------------
  var days = dates.eachDay(params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  var totalSpend = 0;
  var totalCount = 0;
  var totalCash = 0;
  var totalCredit = 0;
  for (var d = 0; d < days.length; d++) {
    var row = daily.rowForDate(app, days[d]);
    var payout = row.buy_in_total_by_payout || {};
    var spend = (payout.cash || 0) + (payout.credit || 0);
    totalSpend += spend;
    totalCount += row.buy_in_count;
    totalCash += payout.cash || 0;
    totalCredit += payout.credit || 0;

    var label = dates.groupLabel(days[d], group);
    if (!byLabel[label]) {
      byLabel[label] = { spend: 0, count: 0 };
      labelOrder.push(label);
    }
    byLabel[label].spend += spend;
    byLabel[label].count += row.buy_in_count;
  }
  var series = [];
  for (var l = 0; l < labelOrder.length; l++) {
    series.push({ label: labelOrder[l], values: byLabel[labelOrder[l]] });
  }

  // --- Direct query: trade-ins completed in range, for dimensions --------
  var bounds = dates.rangeParams(params.from, params.to);
  var tradeIns = [];
  try {
    tradeIns = app.findRecordsByFilter(
      "trade_ins",
      "status = 'completed' && completed_at >= {:start} && completed_at <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    tradeIns = [];
  }

  var staffLookup = query.cachedLookup(app, "staff");
  var customerLookup = query.cachedLookup(app, "customers");
  var gameLookup = query.cachedLookup(app, "games");

  var groups = query.grouper();
  var topSellers = {};
  var tradeInIds = [];
  for (var t = 0; t < tradeIns.length; t++) {
    var tradeIn = tradeIns[t];
    if (!tradeIn) continue;
    tradeInIds.push(tradeIn.id);

    var tSpend = tradeIn.getInt("payout_cash") + tradeIn.getInt("payout_credit");
    var custId = tradeIn.getString("customer");
    if (custId) {
      if (!topSellers[custId]) topSellers[custId] = { customer: custId, count: 0, spend: 0 };
      topSellers[custId].count += 1;
      topSellers[custId].spend += tSpend;
    }

    if (by === "staff") {
      var staffId = tradeIn.getString("staff") || "";
      var staffRow = staffLookup(staffId);
      var staffBucket = groups.get(staffId, staffRow ? staffRow.getString("name") : "(unassigned)");
      staffBucket.spend = (staffBucket.spend || 0) + tSpend;
      staffBucket.count = (staffBucket.count || 0) + 1;
    }
  }

  // Lines carry the game and the offer-vs-market percent, one pass.
  var lines = [];
  for (var ti = 0; ti < tradeInIds.length; ti++) {
    try {
      var found = app.findRecordsByFilter(
        "trade_in_lines",
        "trade_in = {:id} && accepted = true",
        "",
        0,
        0,
        { id: tradeInIds[ti] }
      );
      for (var f = 0; f < found.length; f++) lines.push(found[f]);
    } catch (err) {
      // no lines for this trade-in
    }
  }

  var itemsBought = 0;
  var offerPctSum = 0;
  var offerPctCount = 0;
  for (var ln = 0; ln < lines.length; ln++) {
    var line = lines[ln];
    if (!line) continue;
    var qty = Math.max(1, line.getInt("qty"));
    itemsBought += qty;

    var marketPrice = line.getInt("market_price");
    var offerPrice = line.getInt("offer_price");
    var linePct = null;
    if (marketPrice > 0) {
      linePct = (offerPrice / marketPrice) * 100;
      offerPctSum += linePct;
      offerPctCount += 1;
    }

    if (by === "game") {
      var gameId = line.getString("game");
      var gameRow = gameLookup(gameId);
      var bucket = groups.get(gameId || "", gameRow ? gameRow.getString("name") : "(none)");
      bucket.spend = (bucket.spend || 0) + offerPrice * qty;
      bucket.count = (bucket.count || 0) + 1;
      if (linePct !== null) {
        bucket._offerPctSum = (bucket._offerPctSum || 0) + linePct;
        bucket._offerPctCount = (bucket._offerPctCount || 0) + 1;
      }
    }
  }

  // Items bought that have since sold - not bounded to this range, since
  // "items bought vs sold" (docs/PLAN.md) reads as a running conversion
  // rate for stock the shop has taken in, not a same-day coincidence.
  var itemsSold = 0;
  for (var it = 0; it < tradeInIds.length; it++) {
    try {
      itemsSold += app.findRecordsByFilter(
        "items",
        "trade_in_line.trade_in = {:id} && status = 'sold'",
        "",
        0,
        0,
        { id: tradeInIds[it] }
      ).length;
    } catch (err) {
      // ignore
    }
  }

  var table = groups.rows();
  for (var g = 0; g < table.length; g++) {
    var row2 = table[g];
    row2.avg_offer_pct = row2._offerPctCount > 0 ? Math.round((row2._offerPctSum / row2._offerPctCount) * 10) / 10 : 0;
    delete row2._offerPctSum;
    delete row2._offerPctCount;
  }

  var topSellerIds = Object.keys(topSellers);
  topSellerIds.sort(function (a, b) {
    return topSellers[b].count - topSellers[a].count;
  });
  var topSellersOut = [];
  for (var ts = 0; ts < Math.min(10, topSellerIds.length); ts++) {
    var seller = topSellers[topSellerIds[ts]];
    var customerRow = customerLookup(seller.customer);
    topSellersOut.push({
      customer: seller.customer,
      name: customerRow ? customerRow.getString("name") : "",
      count: seller.count,
      spend: seller.spend,
    });
  }

  var totals = {
    spend: totalSpend,
    count: totalCount,
    avg_offer_pct: offerPctCount > 0 ? Math.round((offerPctSum / offerPctCount) * 10) / 10 : 0,
    cash: totalCash,
    credit: totalCredit,
    items_bought: itemsBought,
    items_sold: itemsSold,
    sell_through_ratio: itemsBought > 0 ? Math.round((itemsSold / itemsBought) * 1000) / 1000 : 0,
    top_sellers: topSellersOut,
  };

  return {
    series: series,
    table: table,
    totals: totals,
    csvColumns: [
      { key: "label", label: "Group" },
      { key: "spend", label: "Spend", money: true },
      { key: "count", label: "Lines" },
      { key: "avg_offer_pct", label: "Avg offer %" },
    ],
  };
}

module.exports = { build: build, VALID_BY: VALID_BY };
