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
 * An item can leave in more than one piece - a box of three sold one at a
 * time, or sold and then partly refunded - so the register is one row per
 * sale line for the quantity that is still sold, plus one row for whatever
 * is still on the shelf. The purchase columns repeat on every row of an
 * item, which is how a margin scheme stock book is meant to read: each row
 * is one purchase and one disposal, and the margin on that row is that
 * disposal's price less that quantity's share of the cost.
 *
 * The sale price on a row is the line's net (its share of the sale-level
 * discount already taken off, see lib/shared/saleline.js) less whatever has
 * already been refunded off it, so the register and the refunds agree to
 * the penny. A fully refunded line is left out: nothing was sold.
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
    const saleline = require(`${__hooks}/lib/shared/saleline.js`);

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

    // One breakdown per sale, however many of its lines turn up: the
    // sale-level discount allocation has to be worked out over all of a
    // sale's lines, not just the ones in this range.
    const saleCache = {};
    function saleFor(saleId) {
      if (saleCache[saleId] !== undefined) return saleCache[saleId];
      let entry = null;
      try {
        const sale = e.app.findRecordById("sales", saleId);
        const rows = util.saleLineRows(e.app, sale.id);
        entry = {
          sale: sale,
          breakdown: saleline.breakdown(util.asSoldLines(rows), sale.getInt("discount")),
        };
      } catch (err) {
        entry = null;
      }
      saleCache[saleId] = entry;
      return entry;
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
    let rows = 0;

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

      const unitCost = item.getInt("cost");
      const description = [
        item.getString("title"),
        item.getString("set_code"),
        item.getString("condition"),
      ]
        .filter(function (part) {
          return !!part;
        })
        .join(" ");

      /** Purchase columns, repeated on every row this item produces. */
      function purchaseCells() {
        return [
          item.getString("sku"),
          (item.getString("acquired_at") || "").slice(0, 10),
          purchaseRef,
          sellerName,
          sellerAddress,
          description,
        ];
      }

      let saleLines = [];
      try {
        saleLines = e.app.findRecordsByFilter(
          "sale_lines",
          "item = {:item}",
          "created,id",
          0,
          0,
          { item: item.id }
        );
      } catch (err) {
        saleLines = [];
      }

      let soldRows = 0;
      for (let n = 0; n < saleLines.length; n++) {
        const saleLine = saleLines[n];
        if (!saleLine) continue;

        const held = saleFor(saleLine.getString("sale"));
        if (!held) continue;
        const entry = held.breakdown.byId[saleLine.id];
        if (!entry) continue;

        const soldQty = saleline.remainingQty(entry);
        if (soldQty <= 0) continue; // refunded in full: nothing was sold

        // What is still paid on the line: its net less whatever the refunds
        // have already handed back, which is how sales.pb.js priced them.
        const refundedAmount = saleline.cumNet(entry.net, entry.qty, entry.refundedQty);
        const salePrice = entry.net - refundedAmount;
        const rowCost = unitCost * soldQty;

        csv += util.csvRow(
          purchaseCells().concat([
            util.poundsCell(rowCost),
            (held.sale.getString("created") || "").slice(0, 10),
            held.sale.getString("number"),
            util.poundsCell(salePrice),
            util.poundsCell(salePrice - rowCost),
          ])
        );
        rows += 1;
        soldRows += 1;
      }

      // Whatever is still on the shelf, with the sale columns blank. An item
      // that never sold at all still gets its row, so nothing drops out of
      // the register.
      const remaining = Math.max(0, item.getInt("qty"));
      if (remaining > 0 || soldRows === 0) {
        csv += util.csvRow(
          purchaseCells().concat([util.poundsCell(unitCost * remaining), "", "", "", ""])
        );
        rows += 1;
      }
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_stock_book",
      collection: "items",
      record: "",
      meta: { from: from, to: to, items: items.length, rows: rows },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", `attachment; filename="stock-book-${from}-${to}.csv"`);
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csv);
  },
  $apis.requireAuth("staff")
);
