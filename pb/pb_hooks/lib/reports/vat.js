/**
 * The VAT return (docs/api-contract-launch.md, section 3,
 * `GET /api/vault/reports/vat?period=2026-Q4`): the rows of a quarter,
 * gathered here and added up by lib/shared/vatreturn.js, which the demo
 * uses too.
 *
 * - The quarter is in shop time (Europe/London), from
 *   `settings.vat_period_start_month`, and only its part inside the
 *   registration is read: VAT switched on, on or after
 *   `settings.vat_registered_from`.
 * - Every line of a sale made in that part is a row as it was sold: its net
 *   after discounts, its VAT at the rate it was charged, or for a margin
 *   scheme line the margin's VAT (lib/shared/vat.js `keptLine`).
 * - Every refund given in that part, of a sale made inside the
 *   registration, is a row of its own: what the line came to after it less
 *   what it came to before it, through the same `keptLine`, so a return
 *   once sent never changes and the quarters add up to what was kept. The
 *   refund's lines and quantities are the `sale_refund` audit row's, the
 *   record lib/salerefund.js keeps of every refund.
 * - Boxes 4 and 7 come from purchases, entered by hand per quarter until
 *   purchases are recorded, kept in `adapter_state` under
 *   "vat_purchases:<period>" (a small server-side key/value store; no
 *   schema change).
 *
 * require() this from inside each handler - see pb/README.md on pb_hooks
 * isolation.
 */

var PURCHASES_KEY = "vat_purchases:";

/** The shop's VAT settings. */
function vatSettings(app, util) {
  var vat = require(`${__hooks}/lib/shared/vat.js`);
  var row = util.settings(app);
  var month = row ? row.getInt("vat_period_start_month") : 0;
  return {
    registration: {
      registered: row ? row.getBool("vat_registered") : false,
      from: row ? row.getString("vat_registered_from") : "",
    },
    standardRate: vat.standardRateOf(row ? row.getFloat("vat_standard_rate") : 0),
    startMonth: month >= 1 && month <= 12 ? month : 1,
  };
}

/** A Date as PocketBase stores and compares it. */
function pbForm(date) {
  return date.toISOString().replace("T", " ");
}

/** A PocketBase date as a Date. */
function pbDate(value) {
  return new Date(String(value || "").replace(" ", "T"));
}

/** The hand-entered purchase figures for a period, zero when none. */
function purchasesFor(app, util, period) {
  var store = require(`${__hooks}/adapters/statestore.js`).forApp(app);
  var value = store.get(PURCHASES_KEY + period);
  if (!value || typeof value !== "object") return { vat: 0, net: 0, updated: "", by: "" };
  return {
    vat: util.asInt(value.vat, 0),
    net: util.asInt(value.net, 0),
    updated: util.asStr(value.updated),
    by: util.asStr(value.by_name),
  };
}

/** Save a period's purchase figures. */
function savePurchases(app, period, figures, staff) {
  var store = require(`${__hooks}/adapters/statestore.js`).forApp(app);
  store.set(PURCHASES_KEY + period, {
    vat: figures.vat,
    net: figures.net,
    updated: new Date().toISOString(),
    by: staff.id,
    by_name: staff.getString("name"),
  });
}

/** What a sale line is called on the return, and its SKU. */
function describe(line, item, product) {
  return {
    title: line.getString("title") || (product ? product.getString("name") : "") || (item ? item.getString("title") : "") || "Item",
    sku: item ? item.getString("sku") : "",
  };
}

/** The as-sold figures `keptLine` reads for a line. */
function asSold(line, entry, item) {
  return {
    net: entry.net,
    qty: entry.qty,
    unitCost: item ? item.getInt("cost") : 0,
    scheme: line.getString("tax_scheme") || "margin",
    rate: line.getFloat("vat_rate"),
  };
}

/**
 * Every row of the quarter from `scopeStart` to its last day: the lines of
 * the sales made, then the refunds given, in date order.
 */
function rowsFor(app, util, quarter, scopeStart, settings) {
  var query = require(`${__hooks}/lib/reports/query.js`);
  var vat = require(`${__hooks}/lib/shared/vat.js`);
  var bookings = require(`${__hooks}/lib/shared/bookings.js`);
  var vatreturn = require(`${__hooks}/lib/shared/vatreturn.js`);

  var bounds = {
    start: pbForm(bookings.shopTimeToUtc(scopeStart, "00:00")),
    end: pbForm(bookings.shopTimeToUtc(vatreturn.dayAfter(quarter.to), "00:00")),
  };
  var options = { inScope: true, standardRate: settings.standardRate };
  var itemLookup = query.cachedLookup(app, "items");
  var productLookup = query.cachedLookup(app, "till_products");
  var rows = [];

  // --- The sales made ----------------------------------------------------
  var lines = [];
  try {
    lines = app.findRecordsByFilter(
      "sale_lines",
      "sale.occurred_at >= {:start} && sale.occurred_at < {:end}",
      "created,id",
      0,
      0,
      bounds
    );
  } catch (err) {
    lines = [];
  }
  var breakdowns = query.saleBreakdownsByLine(app, util, lines);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var held = breakdowns[line.getString("sale")];
    var entry = held ? held.breakdown.byId[line.id] : null;
    if (!entry) continue;
    var item = itemLookup(line.getString("item"));
    var product = productLookup(line.getString("product"));
    var kept = vat.keptLine(asSold(line, entry, item), 0, options);
    var about = describe(line, item, product);
    rows.push({
      kind: "sale",
      ref: held.sale.getString("number"),
      sale: held.sale.id,
      date: bookings.shopDateOf(pbDate(held.sale.getString("occurred_at"))),
      title: about.title,
      sku: about.sku,
      scheme: line.getString("tax_scheme") || "margin",
      rate: line.getFloat("vat_rate"),
      gross: kept.gross,
      vat: kept.vat,
      cost: kept.cost,
    });
  }

  // --- The refunds given -------------------------------------------------
  var given = query.findAllByFilter(
    app,
    "audit_log",
    "action = 'sale_refund' && created >= {:start} && created < {:end}",
    "created,id",
    bounds
  );
  var inQuarter = {};
  var saleIds = [];
  for (var g = 0; g < given.length; g++) {
    if (!given[g]) continue;
    inQuarter[given[g].id] = true;
    var saleId = given[g].getString("record");
    if (saleIds.indexOf(saleId) < 0) saleIds.push(saleId);
  }
  if (saleIds.length) {
    var sales = query.queryByIds(app, "sales", "id", saleIds, "", {}, "");
    var saleLines = query.queryByIds(app, "sale_lines", "sale", saleIds, "", {}, "created,id");
    // queryByIds sorts within each chunk; one sale's lines are always in one
    // chunk, so each sale's lines keep their "created,id" order.
    var splits = query.saleBreakdownsByLine(app, util, saleLines);
    var lineById = {};
    for (var l = 0; l < saleLines.length; l++) if (saleLines[l]) lineById[saleLines[l].id] = saleLines[l];
    var everyRefund = query.queryByIds(app, "audit_log", "record", saleIds, "action = 'sale_refund'", {}, "created,id");
    everyRefund.sort(function (a, b) {
      var ca = a.getString("created");
      var cb = b.getString("created");
      return ca < cb ? -1 : ca > cb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    var saleById = {};
    for (var s = 0; s < sales.length; s++) if (sales[s]) saleById[sales[s].id] = sales[s];
    // Units of each line already back before the refund being read.
    var back = {};
    for (var r = 0; r < everyRefund.length; r++) {
      var audit = everyRefund[r];
      if (!audit) continue;
      var sale = saleById[audit.getString("record")];
      var split = sale ? splits[sale.id] : null;
      var meta = util.jsonField(audit, "meta", {}) || {};
      var refunded = meta.lines && meta.lines.length ? meta.lines : [];
      // A sale outside the registration carried no VAT, so its refund
      // takes none back.
      var counts =
        !!sale && !!inQuarter[audit.id] && vat.vatApplies(settings.registration, pbDate(sale.getString("occurred_at")));
      for (var m = 0; m < refunded.length; m++) {
        var lineId = util.asStr(refunded[m].sale_line);
        var qty = util.asInt(refunded[m].qty, 0);
        var before = back[lineId] || 0;
        back[lineId] = before + qty;
        if (!counts || qty <= 0) continue;
        var refundLine = lineById[lineId];
        var refundEntry = split && refundLine ? split.breakdown.byId[lineId] : null;
        if (!refundEntry) continue;
        var refundItem = itemLookup(refundLine.getString("item"));
        var refundProduct = productLookup(refundLine.getString("product"));
        var figures = asSold(refundLine, refundEntry, refundItem);
        var was = vat.keptLine(figures, before, options);
        var now = vat.keptLine(figures, before + qty, options);
        var said = describe(refundLine, refundItem, refundProduct);
        rows.push({
          kind: "refund",
          ref: util.asStr(meta.ref) || sale.getString("number"),
          sale: sale.id,
          date: bookings.shopDateOf(pbDate(audit.getString("created"))),
          title: said.title,
          sku: said.sku,
          scheme: refundLine.getString("tax_scheme") || "margin",
          rate: refundLine.getFloat("vat_rate"),
          gross: now.gross - was.gross,
          vat: now.vat - was.vat,
          cost: now.cost - was.cost,
        });
      }
    }
  }

  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "sale" ? -1 : 1;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
  return rows;
}

/**
 * The return for a period ("2026-Q4"), or null when the period is not one.
 * A quarter with none of it inside the registration answers every box 0
 * with the note saying why.
 */
function build(app, util, period) {
  var vatreturn = require(`${__hooks}/lib/shared/vatreturn.js`);
  var settings = vatSettings(app, util);
  var quarter = vatreturn.vatQuarter(period, settings.startMonth);
  if (!quarter) return null;
  var scopeStart = vatreturn.vatScopeStart(quarter, settings.registration);
  return vatreturn.buildVatReturn({
    quarter: quarter,
    registration: settings.registration,
    standardRate: settings.standardRate,
    rows: scopeStart === null ? [] : rowsFor(app, util, quarter, scopeStart, settings),
    purchases: purchasesFor(app, util, quarter.period),
  });
}

/** The quarter today (shop time) is in, as "2026-Q4". */
function currentPeriod(app, util) {
  var vatreturn = require(`${__hooks}/lib/shared/vatreturn.js`);
  var bookings = require(`${__hooks}/lib/shared/bookings.js`);
  return vatreturn.quarterOf(bookings.shopDateOf(new Date()), vatSettings(app, util).startMonth).period;
}

module.exports = {
  build: build,
  currentPeriod: currentPeriod,
  savePurchases: savePurchases,
  vatSettings: vatSettings,
};
