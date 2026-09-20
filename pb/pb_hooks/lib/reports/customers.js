/**
 * "customers" report: new vs returning by period, top by spend and by
 * trade-in, credit liability outstanding, and want-list demand
 * (docs/PLAN.md, "Reporting"; docs/api-contract.md, Phase 4).
 *
 * Credit liability is the sum of every credit_ledger row up to the end of
 * the range, never customer_private.credit_balance's cache (CLAUDE.md: a
 * cached balance is never the number a report is built from) - and it adds
 * up correctly across every customer for free, since summing every ledger
 * row is the same total as summing each customer's own recomputed balance.
 *
 * require() this from inside reports.pb.js's handler - see pb/README.md.
 */

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var daily = require(`${__hooks}/lib/reports/daily.js`);

  var group = params.group;
  var days = dates.eachDay(params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  var totalNew = 0;
  var totalReturning = 0;
  for (var d = 0; d < days.length; d++) {
    var row = daily.rowForDate(app, days[d]);
    totalNew += row.new_customers;
    totalReturning += row.returning_customers;
    var label = dates.groupLabel(days[d], group);
    if (!byLabel[label]) {
      byLabel[label] = { new: 0, returning: 0 };
      labelOrder.push(label);
    }
    byLabel[label].new += row.new_customers;
    byLabel[label].returning += row.returning_customers;
  }
  var series = [];
  for (var l = 0; l < labelOrder.length; l++) series.push({ label: labelOrder[l], values: byLabel[labelOrder[l]] });

  // --- Top by spend (sales.total in range) and by trade-in (payout) -------
  var bounds = dates.rangeParams(params.from, params.to);
  var sales = [];
  try {
    sales = app.findRecordsByFilter(
      "sales",
      "customer != '' && occurred_at >= {:start} && occurred_at <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    sales = [];
  }
  var spendByCustomer = {};
  for (var s = 0; s < sales.length; s++) {
    var sale = sales[s];
    if (!sale) continue;
    var cid = sale.getString("customer");
    spendByCustomer[cid] = (spendByCustomer[cid] || 0) + sale.getInt("total");
  }

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
  var tradeInByCustomer = {};
  for (var t = 0; t < tradeIns.length; t++) {
    var tradeIn = tradeIns[t];
    if (!tradeIn) continue;
    var tcid = tradeIn.getString("customer");
    if (!tcid) continue;
    tradeInByCustomer[tcid] =
      (tradeInByCustomer[tcid] || 0) + tradeIn.getInt("payout_cash") + tradeIn.getInt("payout_credit");
  }

  var customerLookup = query.cachedLookup(app, "customers");
  function topN(map, limit) {
    var ids = Object.keys(map);
    ids.sort(function (a, b) {
      return map[b] - map[a];
    });
    var out = [];
    for (var i = 0; i < Math.min(limit, ids.length); i++) {
      var row = customerLookup(ids[i]);
      out.push({ customer: ids[i], name: row ? row.getString("name") : "", amount: map[ids[i]] });
    }
    return out;
  }
  var topBySpend = topN(spendByCustomer, 10);
  var topByTradeIn = topN(tradeInByCustomer, 10);

  // --- Credit liability outstanding, as of the end of the range -----------
  var creditRows = [];
  try {
    creditRows = app.findRecordsByFilter("credit_ledger", "created <= {:end}", "", 0, 0, { end: bounds.end });
  } catch (err) {
    creditRows = [];
  }
  var creditLiability = 0;
  for (var c = 0; c < creditRows.length; c++) {
    if (creditRows[c]) creditLiability += creditRows[c].getInt("amount");
  }

  // --- Want-list demand: open rows grouped by card, joined to stock -------
  var wantRows = [];
  try {
    wantRows = app.findRecordsByFilter("want_list", "status = 'open'", "", 0, 0);
  } catch (err) {
    wantRows = [];
  }
  var cardLookup = query.cachedLookup(app, "cards");
  var demand = {};
  var demandOrder = [];
  for (var w = 0; w < wantRows.length; w++) {
    var want = wantRows[w];
    if (!want) continue;
    var cardId = want.getString("card");
    var key = cardId || "text:" + want.getString("free_text");
    if (!demand[key]) {
      var cardRow = cardLookup(cardId);
      var label = cardRow ? cardRow.getString("name") + " #" + cardRow.getString("number") : want.getString("free_text");
      var inStock = false;
      if (cardId) {
        try {
          inStock =
            app.findRecordsByFilter(
              "items",
              "card = {:card} && (status = 'in_stock' || status = 'reserved' || status = 'listed_ebay')",
              "",
              1,
              0,
              { card: cardId }
            ).length > 0;
        } catch (err) {
          inStock = false;
        }
      }
      demand[key] = { key: key, card_id: cardId || "", label: label || "(unnamed)", count: 0, in_stock: inStock };
      demandOrder.push(key);
    }
    demand[key].count += 1;
  }
  var wantListDemand = [];
  for (var dk = 0; dk < demandOrder.length; dk++) wantListDemand.push(demand[demandOrder[dk]]);
  wantListDemand.sort(function (a, b) {
    return b.count - a.count;
  });

  var totals = {
    new: totalNew,
    returning: totalReturning,
    top_by_spend: topBySpend,
    top_by_trade_in: topByTradeIn,
    credit_liability: creditLiability,
    want_list_demand: wantListDemand,
  };

  var table = [];
  for (var tb = 0; tb < topBySpend.length; tb++) {
    table.push({ customer: topBySpend[tb].customer, label: topBySpend[tb].name, amount: topBySpend[tb].amount });
  }

  return {
    series: series,
    table: table,
    totals: totals,
    csvColumns: [
      { key: "label", label: "Customer" },
      { key: "amount", label: "Spend", money: true },
    ],
  };
}

module.exports = { build: build };
