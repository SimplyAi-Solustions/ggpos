/**
 * "channels" report: in-store vs eBay sales, listing age of items on eBay,
 * and items whose eBay listing has ended (docs/PLAN.md, "Reporting";
 * docs/api-contract.md, Phase 4).
 *
 * sales.channel (the exports/imports package's own field) is "ebay" for a
 * sale created from an eBay order import, blank for an ordinary counter
 * sale - docs/PLAN.md's channels row: "read sales.channel when present,
 * else everything is counter".
 *
 * require() this from inside reports.pb.js's handler - see pb/README.md.
 */

function salesChannel(sale) {
  return sale.getString("channel") || "counter";
}

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);

  var bounds = dates.rangeParams(params.from, params.to);
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

  var groups = query.grouper();
  var totalRevenue = 0;
  var totalCount = 0;
  for (var i = 0; i < sales.length; i++) {
    var sale = sales[i];
    if (!sale) continue;
    var channel = salesChannel(sale);
    // Net of that sale's own refunds - the same net-of-refunds rule every
    // revenue figure in this package follows (docs/api-contract.md, Phase 4).
    var net = sale.getInt("total") - sale.getInt("refunded_total");
    var bucket = groups.get(channel, channel === "ebay" ? "eBay" : "In store");
    bucket.revenue = (bucket.revenue || 0) + net;
    bucket.count = (bucket.count || 0) + 1;
    totalRevenue += net;
    totalCount += 1;
  }
  var rows = groups.rows();
  var byChannel = {};
  for (var r = 0; r < rows.length; r++) byChannel[rows[r].key] = rows[r].revenue;

  // --- Listing age: items currently listed_ebay ----------------------------
  var now = new Date();
  var listed = [];
  try {
    listed = app.findRecordsByFilter("items", "status = 'listed_ebay'", "", 0, 0);
  } catch (err) {
    listed = [];
  }
  var listingAges = [];
  for (var l = 0; l < listed.length; l++) {
    var item = listed[l];
    if (!item) continue;
    // listed_at (items.pb.js's own onRecordUpdate hook, set the moment
    // status most recently became listed_ebay, backfilled by this phase's
    // migration for every row already listed) is the true listing age;
    // acquired_at is the fallback for the rare row neither hook nor
    // backfill has reached.
    var listedAt = item.getString("listed_at") || item.getString("acquired_at");
    listingAges.push({
      item_id: item.id,
      sku: item.getString("sku"),
      title: item.getString("title"),
      days_listed: query.daysSinceOrNull(listedAt, now),
    });
  }

  // --- Items ended: were listed, are not any more, updated in range -------
  //
  // "Was on eBay" is (ebay_listing_id != '' || ebay_sku != ''), not
  // ebay_listing_id alone: nothing in this backend ever writes
  // ebay_listing_id (docs/PLAN.md's eBay round trip is only planned, not
  // built), and a Card Uploader listing carries ebay_sku - the field
  // items.pb.js and the exports package actually populate.
  var endedCount = 0;
  try {
    endedCount = app.findRecordsByFilter(
      "items",
      "(ebay_listing_id != '' || ebay_sku != '') && status != 'listed_ebay' && updated >= {:start} && updated <= {:end}",
      "",
      0,
      0,
      bounds
    ).length;
  } catch (err) {
    endedCount = 0;
  }

  var totals = {
    revenue: totalRevenue,
    count: totalCount,
    by_channel: byChannel,
    listing_ages: listingAges,
    items_ended: endedCount,
  };

  return {
    series: [],
    table: rows,
    totals: totals,
    csvColumns: [
      { key: "label", label: "Channel" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "count", label: "Sales" },
    ],
  };
}

/** totals keys that are pence, not a plain count - lib/reports/scheduled.js's
 * emailed totals read this instead of guessing from the field name.
 * by_channel is an object, not a top-level number, so it is already left
 * out of the emailed totals whatever this says - see scheduled.js. */
var MONEY_FIELDS = { revenue: true };

/** totals keys that are actually a function of params.from/to.
 * listing_ages is left out: it lists every item currently listed_ebay, no
 * date filter at all - "as things stand", not a period figure. */
var PERIOD_SCOPED_TOTALS = { revenue: true, count: true, by_channel: true, items_ended: true };

module.exports = { build: build, MONEY_FIELDS: MONEY_FIELDS, PERIOD_SCOPED_TOTALS: PERIOD_SCOPED_TOTALS };
