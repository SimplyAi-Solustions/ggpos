/**
 * The reports dashboard (docs/api-contract-launch.md, section 3,
 * `GET /api/vault/reports/dashboard?from=&to=&compare=previous`): sales,
 * cost and profit over a range, by day and by top-level branch, the top
 * items, the payment mix, buy-in spend and stock value.
 *
 * Gathering only. The lines come from the margin report's own walk
 * (lib/reports/margin.js `soldLines`), so the dashboard's net and cost are
 * that report's revenue and cost to the penny; a line's branch is placed by
 * the sales report's category view, so the branches are that report's top
 * level; the stock figures are the stock report's population and cost; and
 * the buy-ins are the buy-ins report's own trade-in query. Each line's VAT
 * is lib/shared/vat.js `keptLine`, and the adding up is
 * lib/shared/dashboard.js, which the demo uses too.
 *
 * Day buckets are UTC days, as in every other report.
 *
 * require() this from inside the handler - see pb/README.md on pb_hooks
 * isolation.
 */

/** A sale's payments, net of refunds: its tender rows, or for a sale from before tenders its payment field. */
function paymentsOf(app, sales) {
  var query = require(`${__hooks}/lib/reports/query.js`);
  var labels = require(`${__hooks}/lib/shared/epos-types.js`).TENDER_LABELS;

  var ids = [];
  for (var i = 0; i < sales.length; i++) if (sales[i]) ids.push(sales[i].id);
  var rows = query.queryByIds(app, "sale_tenders", "sale", ids, "", {}, "");
  var bySale = {};
  for (var r = 0; r < rows.length; r++) {
    if (!rows[r]) continue;
    var saleId = rows[r].getString("sale");
    if (!bySale[saleId]) bySale[saleId] = [];
    bySale[saleId].push(rows[r]);
  }

  function labelOf(method) {
    if (method === "mixed") return "Mixed";
    if (method === "none") return "(none)";
    return labels[method] || method;
  }

  var out = [];
  for (var s = 0; s < sales.length; s++) {
    var sale = sales[s];
    if (!sale) continue;
    var tenders = bySale[sale.id];
    if (tenders && tenders.length) {
      // Refund rows are negative, so each method nets itself off.
      for (var t = 0; t < tenders.length; t++) {
        var method = tenders[t].getString("method");
        out.push({ method: method, label: labelOf(method), amount: tenders[t].getInt("amount") });
      }
    } else {
      // Before tenders: the sale's own payment, as the sales report reads
      // it, net of its refunds. Blank is an eBay order (eBay took the money).
      var legacy = sale.getString("payment") || "none";
      out.push({
        method: legacy,
        label: labelOf(legacy),
        amount: sale.getInt("total") - sale.getInt("refunded_total"),
      });
    }
  }
  return out;
}

/**
 * The shared dashboard's input for one range. `withStock` reads the held
 * stock too, which a comparison period does not need (stock is as it stands
 * now, so it has no previous period).
 */
function inputFor(app, util, from, to, withStock) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var margin = require(`${__hooks}/lib/reports/margin.js`);
  var salesReport = require(`${__hooks}/lib/reports/sales.js`);
  var stock = require(`${__hooks}/lib/reports/stock.js`);
  var vat = require(`${__hooks}/lib/shared/vat.js`);

  var settings = util.settings(app);
  var registration = {
    registered: settings ? settings.getBool("vat_registered") : false,
    from: settings ? settings.getString("vat_registered_from") : "",
  };
  var standardRate = vat.standardRateOf(settings ? settings.getFloat("vat_standard_rate") : 0);
  var view = salesReport.categoryView(app, "");
  var productLookup = query.cachedLookup(app, "till_products");

  var lines = [];
  var walked = margin.soldLines(app, util, from, to);
  for (var i = 0; i < walked.length; i++) {
    var held = walked[i];
    var line = held.line;
    var occurred = held.sale.getString("occurred_at");
    var kept = vat.keptLine(
      {
        net: held.entry.net,
        qty: held.entry.qty,
        unitCost: held.unitCost,
        scheme: line.getString("tax_scheme") || "margin",
        rate: line.getFloat("vat_rate"),
      },
      held.entry.refundedQty,
      { inScope: vat.vatApplies(registration, margin.pbDate(occurred)), standardRate: standardRate }
    );

    var productId = line.getString("product");
    var product = productId ? productLookup(productId) : null;
    var home = product ? product.getString("category") : held.item ? held.item.getString("category") : "";
    var branch = salesReport.categoryRowFor(view, home);

    // The line before any discount: saleline's gross already has the
    // line's own discount off it.
    var listGross = held.entry.gross + line.getInt("discount");
    lines.push({
      date: occurred.slice(0, 10),
      gross: listGross,
      discount: listGross - held.entry.net,
      refunded: held.entry.net - held.soldNet,
      vat: kept.vat,
      cost: held.cost,
      qty: held.soldQty,
      branch: { id: branch ? branch.key : "", label: branch ? branch.label : "(none)" },
      key: product ? "product:" + product.id : "item:" + line.getString("item"),
      title: product
        ? product.getString("name")
        : line.getString("title") || (held.item ? held.item.getString("title") || held.item.getString("sku") : "Item"),
      sku: held.item ? held.item.getString("sku") : "",
    });
  }

  var bounds = dates.rangeParams(from, to);
  var sales = query.findAllByFilter(app, "sales", "occurred_at >= {:start} && occurred_at <= {:end}", "", bounds);

  // The buy-ins report's own query and spend: cash, credit and part-exchange.
  var tradeIns = query.findAllByFilter(
    app,
    "trade_ins",
    "status = 'completed' && completed_at >= {:start} && completed_at <= {:end}",
    "",
    bounds
  );
  var spend = 0;
  for (var t = 0; t < tradeIns.length; t++) {
    if (!tradeIns[t]) continue;
    spend +=
      tradeIns[t].getInt("payout_cash") + tradeIns[t].getInt("payout_credit") + tradeIns[t].getInt("part_exchange_value");
  }

  return {
    from: from,
    to: to,
    saleCount: sales.length,
    lines: lines,
    payments: paymentsOf(app, sales),
    buyIns: { spend: spend, count: tradeIns.length },
    stock: withStock ? stock.heldTotals(app) : { cost: 0, retail: 0, items: 0 },
  };
}

/** The contract's body for a range, with the previous period's headline when `compare` is "previous". */
function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var shared = require(`${__hooks}/lib/shared/dashboard.js`);

  var body = shared.summariseDashboard(inputFor(app, util, params.from, params.to, true));
  if (params.compare === "previous") {
    var prev = dates.previousPeriod(params.from, params.to);
    var headline = shared.dashboardHeadline(inputFor(app, util, prev.from, prev.to, false));
    body.compare = {
      from: prev.from,
      to: prev.to,
      sales: headline.sales,
      cost: headline.cost,
      profit: headline.profit,
      margin_pct: headline.margin_pct,
      buy_ins: headline.buy_ins,
    };
  }
  return body;
}

module.exports = { build: build, inputFor: inputFor };
