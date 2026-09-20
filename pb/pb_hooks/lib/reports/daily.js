/**
 * daily_stats: one day's row, computed straight from the ledgers and rows -
 * never a cached balance (CLAUDE.md; docs/PLAN.md's Phase 4 brief). UTC day
 * boundaries throughout.
 *
 * buildDayRow is the pure builder: given an app and a YYYY-MM-DD date, it
 * returns the daily_stats field values for that day and writes nothing
 * itself. upsertDayRow is the only thing that saves one, by date, never a
 * duplicate - crons.pb.js's "stats" job and POST /api/vault/stats/rebuild
 * (stats.pb.js) both call it and nothing else does. rowForDate is the
 * read-through the reports use: the stored row when one exists, else a
 * fresh (unsaved) computation, so a report never reads as all zero just
 * because the nightly cron has not reached that day yet.
 *
 * require() this from inside each handler/cron that uses it - see
 * pb/README.md on pb_hooks isolation.
 */

/**
 * The stock valuation ("what is held stock worth right now") that every
 * daily_stats row's stock_value_cost/stock_value_market carries. This is
 * always "as stock stands when this runs", never a historical
 * reconstruction of a past day (docs/api-contract.md says so plainly), so
 * it comes out identical whichever day's row is asking for it.
 *
 * A full scan of every held item plus a price_snapshots lookup per item is
 * real work; computing it once here and threading it through buildDayRow's
 * own `stockValuation` parameter (see below) is what keeps a multi-day
 * rebuild - the nightly cron's last-7-UTC-days sweep, POST
 * /api/vault/stats/rebuild over a longer range, or a report falling back to
 * several unbuilt days at once - from re-running that scan once per day for
 * an answer that would come out the same every time. Call this once per
 * rebuild/read and pass the result to every buildDayRow call it covers;
 * upsertDayRows and rowsForEachDay below do exactly that.
 */
function currentStockValuation(app) {
  var query = require(`${__hooks}/lib/reports/query.js`);
  var stockItems = [];
  try {
    stockItems = app.findRecordsByFilter("items", query.STOCK_STATUS_FILTER, "", 0, 0);
  } catch (err) {
    stockItems = [];
  }
  var cost = 0;
  var market = 0;
  var snapshotCache = {};
  for (var i = 0; i < stockItems.length; i++) {
    var item = stockItems[i];
    if (!item) continue;
    var qty = Math.max(0, item.getInt("qty"));
    cost += item.getInt("cost") * qty;
    var perUnit = query.currentMarketPerUnit(app, item, snapshotCache);
    market += perUnit.perUnit * qty;
  }
  return { cost: cost, market: market };
}

/**
 * date, sales_count, ... daily_stats field values for one UTC day.
 *
 * `stockValuation`, when given ({cost, market} from currentStockValuation),
 * is used as-is instead of scanning the stock table again - pass it when
 * building more than one day in the same rebuild. Left out, a single day's
 * own fresh scan is used, so calling this directly for one day still works
 * with no caller-side setup.
 */
function buildDayRow(app, dateStr, stockValuation) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);

  var bounds = dates.rangeParams(dateStr, dateStr);

  // --- Sales: rung up that day, by payment method --------------------------
  //
  // A sale imported from an eBay order (docs/PLAN.md's "Card Uploader and
  // the eBay round trip"; sales.channel/.external_ref) has no shop-side
  // payment at all - eBay took the money - so sales.payment is left blank
  // on those rows, never "mixed" (which means the shop itself split a
  // payment across methods). "none" is its own bucket so that revenue is
  // never dropped or folded into a bucket that would misstate how it was
  // actually paid; totals.revenue still sums every bucket, "none" included.
  // sales.occurred_at (not created) is the sale's own date: created is
  // when the database row was written, which for an eBay order import is
  // whenever the import ran, not the day the order was actually placed.
  // occurred_at is backfilled to created for rows from before it existed,
  // set to now for an ordinary counter sale, and set to the order's own
  // date by the eBay orders import - every sales figure below reads it.
  var sales = [];
  try {
    sales = app.findRecordsByFilter(
      "sales",
      "occurred_at >= {:start} && occurred_at <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    sales = [];
  }
  // sales_refunded sums sales.refunded_total for every sale that occurred
  // this day, whichever day the refund itself was actually processed on -
  // the same "belongs to the day the sale occurred" rule items_out already
  // follows below. A sale refunded weeks later still moves this day's
  // net-of-refunds figure when this row is next rebuilt; sales_total_by_
  // payment itself stays gross (what was actually taken by each method),
  // so every revenue total the reports package returns is gross minus this
  // one field, computed the one place both live - see
  // docs/api-contract.md's Phase 4 section.
  var salesTotalByPayment = { sumup_card: 0, cash: 0, store_credit: 0, points: 0, mixed: 0, none: 0 };
  var salesRefunded = 0;
  for (var i = 0; i < sales.length; i++) {
    var sale = sales[i];
    if (!sale) continue;
    var method = sale.getString("payment");
    if (method === "") method = "none";
    else if (!Object.prototype.hasOwnProperty.call(salesTotalByPayment, method)) method = "mixed";
    salesTotalByPayment[method] += sale.getInt("total");
    salesRefunded += sale.getInt("refunded_total");
  }

  // --- Buy-ins: completed that day, by payout type -------------------------
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
  var buyInTotalByPayout = { cash: 0, credit: 0 };
  for (var t = 0; t < tradeIns.length; t++) {
    if (!tradeIns[t]) continue;
    buyInTotalByPayout.cash += tradeIns[t].getInt("payout_cash");
    buyInTotalByPayout.credit += tradeIns[t].getInt("payout_credit");
  }

  // --- Items in: acquired that day ------------------------------------------
  var itemsInCount = 0;
  try {
    itemsInCount = app.findRecordsByFilter(
      "items",
      "acquired_at >= {:start} && acquired_at <= {:end}",
      "",
      0,
      0,
      bounds
    ).length;
  } catch (err) {
    itemsInCount = 0;
  }

  // --- Items out: units sold that day, net of every refund since ----------
  // A line "belongs" to the day its sale occurred (sales.occurred_at,
  // reached here through the relation), not the day the row was written.
  var saleLines = [];
  try {
    saleLines = app.findRecordsByFilter(
      "sale_lines",
      "sale.occurred_at >= {:start} && sale.occurred_at <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    saleLines = [];
  }
  var itemsOut = 0;
  for (var s = 0; s < saleLines.length; s++) {
    if (!saleLines[s]) continue;
    var net = saleLines[s].getInt("qty") - saleLines[s].getInt("refunded_qty");
    if (net > 0) itemsOut += net;
  }

  // --- Stock value: shared across a whole rebuild - see currentStockValuation ---
  var valuation = stockValuation || currentStockValuation(app);
  var stockValueCost = valuation.cost;
  var stockValueMarket = valuation.market;

  // --- Credit ledger: issued (money in) vs redeemed (money out) -----------
  var creditRows = [];
  try {
    creditRows = app.findRecordsByFilter(
      "credit_ledger",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    creditRows = [];
  }
  var creditIssued = 0;
  var creditRedeemed = 0;
  for (var c = 0; c < creditRows.length; c++) {
    if (!creditRows[c]) continue;
    var amount = creditRows[c].getInt("amount");
    if (amount > 0) creditIssued += amount;
    else creditRedeemed += -amount;
  }

  // --- Points ledger: earned vs redeemed, the same way ---------------------
  var pointsRows = [];
  try {
    pointsRows = app.findRecordsByFilter(
      "points_ledger",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    pointsRows = [];
  }
  var pointsEarned = 0;
  var pointsRedeemed = 0;
  for (var p = 0; p < pointsRows.length; p++) {
    if (!pointsRows[p]) continue;
    var delta = pointsRows[p].getInt("delta");
    if (delta > 0) pointsEarned += delta;
    else pointsRedeemed += -delta;
  }

  // --- Cash variance: sessions closed that day ------------------------------
  var closedSessions = [];
  try {
    closedSessions = app.findRecordsByFilter(
      "cash_sessions",
      "closed_at >= {:start} && closed_at <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    closedSessions = [];
  }
  var cashVariance = 0;
  for (var cs = 0; cs < closedSessions.length; cs++) {
    if (closedSessions[cs]) cashVariance += closedSessions[cs].getInt("variance");
  }

  // --- New vs returning customers -------------------------------------------
  var newCustomers = 0;
  try {
    newCustomers = app.findRecordsByFilter(
      "customers",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    ).length;
  } catch (err) {
    newCustomers = 0;
  }

  var activeCustomerIds = {};
  for (var sc = 0; sc < sales.length; sc++) {
    var scid = sales[sc] ? sales[sc].getString("customer") : "";
    if (scid) activeCustomerIds[scid] = true;
  }
  for (var tc = 0; tc < tradeIns.length; tc++) {
    var tcid = tradeIns[tc] ? tradeIns[tc].getString("customer") : "";
    if (tcid) activeCustomerIds[tcid] = true;
  }
  var returningCustomers = 0;
  var activeIds = Object.keys(activeCustomerIds);
  for (var a = 0; a < activeIds.length; a++) {
    var id = activeIds[a];
    var hadEarlierSale = false;
    try {
      hadEarlierSale =
        app.findRecordsByFilter(
          "sales",
          "customer = {:id} && occurred_at < {:start}",
          "",
          1,
          0,
          { id: id, start: bounds.start }
        ).length > 0;
    } catch (err) {
      hadEarlierSale = false;
    }
    var hadEarlierTradeIn = false;
    if (!hadEarlierSale) {
      try {
        hadEarlierTradeIn =
          app.findRecordsByFilter(
            "trade_ins",
            "customer = {:id} && status = 'completed' && completed_at < {:start}",
            "",
            1,
            0,
            { id: id, start: bounds.start }
          ).length > 0;
      } catch (err) {
        hadEarlierTradeIn = false;
      }
    }
    if (hadEarlierSale || hadEarlierTradeIn) returningCustomers += 1;
  }

  return {
    sales_count: sales.length,
    sales_total_by_payment: salesTotalByPayment,
    buy_in_count: tradeIns.length,
    buy_in_total_by_payout: buyInTotalByPayout,
    items_in: itemsInCount,
    items_out: itemsOut,
    stock_value_cost: stockValueCost,
    stock_value_market: stockValueMarket,
    credit_issued: creditIssued,
    credit_redeemed: creditRedeemed,
    points_earned: pointsEarned,
    points_redeemed: pointsRedeemed,
    cash_variance: cashVariance,
    new_customers: newCustomers,
    returning_customers: returningCustomers,
  };
}

/** The stored daily_stats row for `dateStr` as plain fields, matched by a
 * same-day range (never text equality - see this file's header). */
function findStoredRow(app, dateStr) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var bounds = dates.rangeParams(dateStr, dateStr);
  try {
    var rows = app.findRecordsByFilter(
      "daily_stats",
      "date >= {:start} && date <= {:end}",
      "",
      1,
      0,
      bounds
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * The daily_stats fields for `dateStr`: the stored row when one exists,
 * else a fresh computation that is not persisted. Every report's period
 * series and totals read this rather than the raw builder, so a day the
 * nightly cron has not reached yet still reports correctly.
 */
function rowForDate(app, dateStr) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var existing = findStoredRow(app, dateStr);
  if (existing) {
    return {
      sales_count: existing.getInt("sales_count"),
      sales_total_by_payment: util.jsonField(existing, "sales_total_by_payment", {}) || {},
      buy_in_count: existing.getInt("buy_in_count"),
      buy_in_total_by_payout: util.jsonField(existing, "buy_in_total_by_payout", {}) || {},
      items_in: existing.getInt("items_in"),
      items_out: existing.getInt("items_out"),
      stock_value_cost: existing.getInt("stock_value_cost"),
      stock_value_market: existing.getInt("stock_value_market"),
      credit_issued: existing.getInt("credit_issued"),
      credit_redeemed: existing.getInt("credit_redeemed"),
      points_earned: existing.getInt("points_earned"),
      points_redeemed: existing.getInt("points_redeemed"),
      cash_variance: existing.getInt("cash_variance"),
      new_customers: existing.getInt("new_customers"),
      returning_customers: existing.getInt("returning_customers"),
    };
  }
  return buildDayRow(app, dateStr);
}

/**
 * Upsert one daily_stats row for `dateStr` from buildDayRow, matched by date
 * so a second rebuild of the same day updates the same row rather than
 * creating a duplicate.
 */
function upsertDayRow(app, dateStr) {
  var fields = buildDayRow(app, dateStr);
  var record = findStoredRow(app, dateStr);
  if (!record) {
    record = new Record(app.findCollectionByNameOrId("daily_stats"), { date: dateStr });
  }
  var keys = Object.keys(fields);
  for (var i = 0; i < keys.length; i++) record.set(keys[i], fields[keys[i]]);
  app.save(record);
  return record;
}

module.exports = {
  buildDayRow: buildDayRow,
  rowForDate: rowForDate,
  upsertDayRow: upsertDayRow,
};
