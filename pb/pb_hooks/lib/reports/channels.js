/**
 * "channels" report: in-store vs eBay sales, listing age of items on eBay,
 * and items whose eBay listing has ended (docs/PLAN.md, "Reporting";
 * docs/api-contract.md, Phase 4).
 *
 * sales.channel does not exist as a field yet - the exports/imports package
 * this same phase is adding it in, per this session's own brief. Every sale
 * reads as "counter" until it does, exactly as docs/PLAN.md's channels row
 * asks ("read sales.channel when present, else everything is counter").
 *
 * require() this from inside reports.pb.js's handler - see pb/README.md.
 */

function salesChannel(sale) {
  var value = "";
  try {
    value = sale.getString("channel");
  } catch (err) {
    value = "";
  }
  return value || "counter";
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
    var bucket = groups.get(channel, channel === "ebay" ? "eBay" : "In store");
    bucket.revenue = (bucket.revenue || 0) + sale.getInt("total");
    bucket.count = (bucket.count || 0) + 1;
    totalRevenue += sale.getInt("total");
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
    listingAges.push({
      item_id: item.id,
      sku: item.getString("sku"),
      title: item.getString("title"),
      days_listed: query.daysSince(item.getString("acquired_at"), now),
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

module.exports = { build: build };
