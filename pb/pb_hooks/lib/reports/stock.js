/**
 * "stock" report: value at cost vs market, ageing buckets, sell-through by
 * game and set, dead stock, and price movers over 15 percent (docs/PLAN.md,
 * "Reporting"; docs/api-contract.md, Phase 4).
 *
 * Everything here except sell-through is point in time (as stock stands
 * when the report runs), not a historical reconstruction of what was held
 * on a past date - said so plainly in docs/api-contract.md.
 *
 * The primary `table` (and the CSV export) is price movers: a card or
 * retro title whose latest price_snapshots figure differs from what its
 * stock was taken in at by more than 15 percent either way, with the item
 * id so the app can offer a one-click reprice. Ageing buckets, sell-through
 * and dead stock are real arrays too, under `totals` - docs/api-contract.md
 * says exactly where each one lives.
 *
 * require() this from inside reports.pb.js's handler (or another report
 * that reuses it) - see pb/README.md on pb_hooks isolation.
 */

var VALID_BY = { game: true, set: true };
var MOVER_THRESHOLD_PCT = 15;
var DEAD_STOCK_DAYS = 180;

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);

  var now = new Date();
  var snapshotCache = {};

  var stockItems = [];
  try {
    stockItems = app.findRecordsByFilter("items", query.STOCK_STATUS_FILTER, "", 0, 0);
  } catch (err) {
    stockItems = [];
  }

  var valueCost = 0;
  var valueMarket = 0;
  var buckets = [
    { bucket: "0-30", min: 0, max: 30, count: 0, value_cost: 0, value_market: 0 },
    { bucket: "31-90", min: 31, max: 90, count: 0, value_cost: 0, value_market: 0 },
    { bucket: "91-180", min: 91, max: 180, count: 0, value_cost: 0, value_market: 0 },
    { bucket: "180+", min: 181, max: Infinity, count: 0, value_cost: 0, value_market: 0 },
  ];
  var deadStock = [];
  var movers = [];

  for (var i = 0; i < stockItems.length; i++) {
    var item = stockItems[i];
    if (!item) continue;
    var qty = Math.max(0, item.getInt("qty"));
    var cost = item.getInt("cost") * qty;
    var market = query.currentMarketPerUnit(app, item, snapshotCache);
    var marketValue = market.perUnit * qty;
    valueCost += cost;
    valueMarket += marketValue;

    var days = query.daysSince(item.getString("acquired_at"), now);
    for (var b = 0; b < buckets.length; b++) {
      if (days >= buckets[b].min && days <= buckets[b].max) {
        buckets[b].count += 1;
        buckets[b].value_cost += cost;
        buckets[b].value_market += marketValue;
        break;
      }
    }
    if (days > DEAD_STOCK_DAYS) {
      deadStock.push({
        item_id: item.id,
        sku: item.getString("sku"),
        title: item.getString("title"),
        days_held: days,
        cost: cost,
        market: marketValue,
      });
    }

    var intake = item.getInt("market_at_intake");
    if (market.snapshot && intake > 0) {
      var pct = ((market.perUnit - intake) / intake) * 100;
      if (Math.abs(pct) > MOVER_THRESHOLD_PCT) {
        movers.push({
          item_id: item.id,
          sku: item.getString("sku"),
          title: item.getString("title"),
          market_at_intake: intake,
          latest_market: market.perUnit,
          pct_change: Math.round(pct * 10) / 10,
        });
      }
    }
  }
  movers.sort(function (a, b) {
    return Math.abs(b.pct_change) - Math.abs(a.pct_change);
  });

  // --- Sell-through: stock rows acquired in range, sold since or not -----
  // Counts stock rows, not individual units: a sealed line of qty n is one
  // row, and PLAN.md's "sale decrements qty" means a partly-sold line's
  // original quantity is not recoverable from its current qty, so a
  // multi-quantity row only counts as sold once it has sold out completely
  // (status reaches "sold" at qty 0) - a row-level proxy, documented here
  // and in docs/api-contract.md rather than claimed as unit-level.
  var by = VALID_BY[params.by] ? params.by : "game";
  var bounds = dates.rangeParams(params.from, params.to);
  var acquired = [];
  try {
    acquired = app.findRecordsByFilter(
      "items",
      "acquired_at >= {:start} && acquired_at <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    acquired = [];
  }
  var gameLookup = query.cachedLookup(app, "games");
  var groups = query.grouper();
  for (var a = 0; a < acquired.length; a++) {
    var acqItem = acquired[a];
    if (!acqItem) continue;
    var key, label;
    if (by === "set") {
      key = acqItem.getString("set_code") || "";
      label = key || "(none)";
    } else {
      var gameId = acqItem.getString("game");
      key = gameId || "";
      var gameRow = gameLookup(gameId);
      label = gameRow ? gameRow.getString("name") : "(none)";
    }
    var bucket2 = groups.get(key, label);
    bucket2.acquired = (bucket2.acquired || 0) + 1;
    bucket2.sold = (bucket2.sold || 0) + (acqItem.getString("status") === "sold" ? 1 : 0);
  }
  var sellThrough = groups.rows();
  for (var st = 0; st < sellThrough.length; st++) {
    sellThrough[st].rate =
      sellThrough[st].acquired > 0 ? Math.round((sellThrough[st].sold / sellThrough[st].acquired) * 1000) / 1000 : 0;
  }

  var totals = {
    value_cost: valueCost,
    value_market: valueMarket,
    unrealised_gain: valueMarket - valueCost,
    ageing_buckets: buckets,
    sell_through: sellThrough,
    dead_stock: deadStock,
    price_movers_count: movers.length,
  };

  return {
    series: [],
    table: movers,
    totals: totals,
    csvColumns: [
      { key: "sku", label: "SKU" },
      { key: "title", label: "Title" },
      { key: "market_at_intake", label: "Market at intake", money: true },
      { key: "latest_market", label: "Latest market", money: true },
      { key: "pct_change", label: "Change %" },
      { key: "item_id", label: "Item id" },
    ],
  };
}

module.exports = { build: build, VALID_BY: VALID_BY };
