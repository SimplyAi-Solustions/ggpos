/// <reference path="../pb_data/types.d.ts" />

/**
 * exports.pb.js - GET /api/vault/exports/stock-book?from&to  (**admin**)
 *
 * The VAT margin scheme record: every margin-scheme item acquired in the
 * range, with the seller it came from and the sale it left on. Columns are
 * the "Stock book export" row of docs/csv-formats.md; money is written as
 * plain pounds with two decimals, no symbol, so a spreadsheet reads it as a
 * number (docs/PLAN.md, "Currency: GBP everywhere").
 *
 * The handler runs in its own isolated goja context, so every require()
 * lives inside the handler body - see pb/README.md.
 */
routerAdd(
  "GET",
  "/api/vault/exports/stock-book",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);

    /** A YYYY-MM-DD query value, or "" when absent or unusable. */
    function dateParam(name) {
      let raw = "";
      try {
        const info = e.requestInfo();
        raw = util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        raw = "";
      }
      if (!raw) {
        try {
          raw = util.asStr(e.request.url.query().get(name));
        } catch (err) {
          raw = "";
        }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
      return raw;
    }

    const from = dateParam("from");
    const to = dateParam("to");
    if (!from || !to) {
      throw e.badRequestError(
        "Pick a date range. Both from and to are needed, as YYYY-MM-DD.",
        null
      );
    }
    if (from > to) {
      throw e.badRequestError("The from date is after the to date. Swap them over.", null);
    }

    // acquired_at is a timestamp, so the range runs to the end of the `to`
    // day rather than to midnight at its start.
    const items = e.app.findRecordsByFilter(
      "items",
      'tax_scheme = "margin" && acquired_at >= {:from} && acquired_at <= {:to}',
      "acquired_at",
      0,
      0,
      { from: from + " 00:00:00.000Z", to: to + " 23:59:59.999Z" }
    );

    let csv = util.csvRow([
      "Stock number",
      "Purchase date",
      "Purchase reference",
      "Seller name",
      "Seller address",
      "Description",
      "Cost",
      "Sale date",
      "Sale reference",
      "Sale price",
      "Margin",
    ]);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      // The seller snapshot lives on the trade-in the line belongs to.
      let sellerName = "";
      let sellerAddress = "";
      let purchaseRef = "";
      const lineId = item.getString("trade_in_line");
      if (lineId) {
        try {
          const line = e.app.findRecordById("trade_in_lines", lineId);
          const tradeIn = e.app.findRecordById("trade_ins", line.getString("trade_in"));
          sellerName = tradeIn.getString("seller_name");
          sellerAddress = tradeIn.getString("seller_address");
          purchaseRef = tradeIn.getString("number");
        } catch (err) {
          // A trade-in that has since been deleted leaves the columns blank
          // rather than dropping the stock line out of the register.
        }
      }
      if (!purchaseRef) purchaseRef = item.getString("supplier_ref");

      let saleDate = "";
      let saleRef = "";
      let salePrice = null;
      try {
        const saleLine = e.app.findFirstRecordByFilter(
          "sale_lines",
          'item = {:item} && status = "sold"',
          { item: item.id }
        );
        const sale = e.app.findRecordById("sales", saleLine.getString("sale"));
        saleDate = (sale.getString("created") || "").slice(0, 10);
        saleRef = sale.getString("number");
        salePrice =
          saleLine.getInt("unit_price") * Math.max(1, saleLine.getInt("qty")) -
          saleLine.getInt("discount");
      } catch (err) {
        salePrice = null;
      }

      const cost = item.getInt("cost");
      const description = [
        item.getString("title"),
        item.getString("set_code"),
        item.getString("condition"),
      ]
        .filter(function (part) {
          return !!part;
        })
        .join(" ");

      csv += util.csvRow([
        item.getString("sku"),
        (item.getString("acquired_at") || "").slice(0, 10),
        purchaseRef,
        sellerName,
        sellerAddress,
        description,
        util.poundsCell(cost),
        saleDate,
        saleRef,
        salePrice === null ? "" : util.poundsCell(salePrice),
        salePrice === null ? "" : util.poundsCell(salePrice - cost),
      ]);
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_stock_book",
      collection: "items",
      record: "",
      meta: { from: from, to: to, rows: items.length },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", `attachment; filename="stock-book-${from}-${to}.csv"`);
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csv);
  },
  $apis.requireAuth("staff")
);
