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

/**
 * GET /api/vault/exports/sumup.csv?since=YYYY-MM-DD&dry_run=1  (staff)
 *
 * SumUp's own CSV import layout (docs/csv-formats.md, "SumUp item
 * import"), for `retro`, `sealed`, `accessory` and `other` items that are
 * still `in_stock` and either have never been exported
 * (`sumup_synced_at` empty) or have changed since `since`
 * (`updated >= since`); leaving `since` off selects only items never
 * exported. The item name is prefixed with our own SKU (display form)
 * so a SumUp sale can be matched back to it by eye, and by
 * `lib/sumup.js`'s own transactions-pull matching. `dry_run=1` builds
 * the same file but sets no `sumup_synced_at`, for a preview that does
 * not stop those rows appearing again on the next real export.
 */
routerAdd(
  "GET",
  "/api/vault/exports/sumup.csv",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const sku = require(`${__hooks}/lib/shared/sku.js`);

    const staff = e.auth;

    // The one home for the UK standard rate this build has: sales.pb.js
    // hardcodes the same figure the same way for a standard-scheme sale
    // line's own vat_rate, since settings carries no separate "the
    // standard rate" field of its own.
    const STANDARD_VAT_RATE = 20;

    const sinceRaw = csvLib.dateParam(e, "since");
    const dryRun = csvLib.queryParam(e, "dry_run") === "1";

    let filter =
      'status = "in_stock" && (kind = "retro" || kind = "sealed" || kind = "accessory" || kind = "other")';
    const params = {};
    if (sinceRaw) {
      filter += ' && (sumup_synced_at = "" || updated >= {:since})';
      params.since = `${sinceRaw} 00:00:00.000Z`;
    } else {
      filter += ' && sumup_synced_at = ""';
    }

    let items = [];
    try {
      items = e.app.findRecordsByFilter("items", filter, "created", 0, 0, params);
    } catch (err) {
      items = [];
    }

    let games = [];
    try {
      games = e.app.findRecordsByFilter("games", "id != ''", "", 0, 0);
    } catch (err) {
      games = [];
    }
    const gameNameById = {};
    for (let i = 0; i < games.length; i++) {
      if (games[i]) gameNameById[games[i].id] = games[i].getString("name");
    }

    const settingsRow = util.settings(e.app);
    const vatRegistered = settingsRow ? settingsRow.getBool("vat_registered") : false;

    function humanKind(kind) {
      if (kind === "retro") return "Retro";
      if (kind === "sealed") return "Sealed";
      if (kind === "accessory") return "Accessory";
      return "Other";
    }

    let csvText = csvLib.row([
      "Item name",
      "Description",
      "Category",
      "Price",
      "SKU",
      "Barcode",
      "Quantity",
      "Tax rate (%)",
      "Variations",
      "Option set 1",
      "Option set 2",
      "Option set 3",
      "Option set 4",
      "Modifiers",
      "Display colour",
    ]);

    const toSync = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      const encodedSku = item.getString("sku");
      const displaySku = sku.displayCode(encodedSku);
      const title = item.getString("title") || "";
      const gameName = gameNameById[item.getString("game")] || "";
      const kind = item.getString("kind");
      const taxScheme = item.getString("tax_scheme") || "margin";
      const taxRate = taxScheme === "margin" ? 0 : vatRegistered ? STANDARD_VAT_RATE : 0;
      const ean = item.getString("ean");
      const barcode = (kind === "sealed" || kind === "accessory") && ean ? ean : encodedSku;

      const description = [gameName, item.getString("set_code"), item.getString("condition")]
        .filter((part) => !!part)
        .join(" ");

      csvText += csvLib.row([
        `${displaySku} ${title}`.trim(),
        description,
        gameName || humanKind(kind),
        csvLib.pounds(item.getInt("price")),
        encodedSku,
        barcode,
        item.getInt("qty"),
        taxRate,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
      toSync.push(item.id);
    }

    if (!dryRun) {
      const nowIso = util.nowIso();
      for (let i = 0; i < toSync.length; i++) {
        try {
          const live = e.app.findRecordById("items", toSync[i]);
          live.set("sumup_synced_at", nowIso);
          e.app.save(live);
        } catch (err) {
          // The item vanished between the read and the write - nothing to sync.
        }
      }
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_sumup_csv",
      collection: "items",
      record: "",
      meta: { since: sinceRaw, dry_run: dryRun, items: items.length },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", 'attachment; filename="sumup-export.csv"');
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csvText);
  },
  $apis.requireAuth("staff")
);

/**
 * GET /api/vault/exports/ebay-listings.csv?ids=<comma list>  (staff)
 *
 * A listing file for ebay.co.uk in GBP for the given in-stock items -
 * docs/csv-formats.md, "eBay listing export", for the column set and why
 * two of them are always blank. Marks nothing: no id, however many times
 * it is exported this way, ever changes.
 */
routerAdd(
  "GET",
  "/api/vault/exports/ebay-listings.csv",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;

    const idsRaw = csvLib.queryParam(e, "ids");
    const ids = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => !!s);
    if (ids.length === 0) {
      throw e.badRequestError("Pick at least one item to list on eBay.", null);
    }

    const settingsRow = util.settings(e.app);
    const shopTown = settingsRow ? settingsRow.getString("shop_town") : "";
    const shopPostcode = settingsRow ? settingsRow.getString("shop_postcode") : "";

    let csvText = csvLib.row([
      "Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193)",
      "Custom label (SKU)",
      "Title",
      "Description",
      "Category",
      "ConditionID",
      "Format",
      "Duration",
      "StartPrice",
      "Quantity",
      "ImageURL",
      "Location",
      "PostalCode",
    ]);

    let written = 0;
    for (let i = 0; i < ids.length; i++) {
      let item = null;
      try {
        item = e.app.findRecordById("items", ids[i]);
      } catch (err) {
        item = null;
      }
      if (!item || item.getString("status") !== "in_stock") continue;

      const customLabel = item.getString("ebay_sku") || item.getString("sku");
      const title = (item.getString("title") || "").slice(0, 80);
      const description = [item.getString("set_code"), item.getString("condition")]
        .filter((part) => !!part)
        .join(" ");

      let imageUrl = "";
      try {
        const photos = item.get("photos");
        const fileName = Array.isArray(photos) ? photos[0] : photos;
        if (fileName) imageUrl = `/api/files/${item.baseFilesPath()}/${fileName}`;
      } catch (err) {
        imageUrl = "";
      }

      csvText += csvLib.row([
        "Add",
        customLabel,
        title,
        description,
        "",
        "",
        "FixedPrice",
        "GTC",
        csvLib.pounds(item.getInt("price")),
        item.getInt("qty"),
        imageUrl,
        shopTown,
        shopPostcode,
      ]);
      written += 1;
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_ebay_listings_csv",
      collection: "items",
      record: "",
      meta: { ids: ids, written: written },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", 'attachment; filename="ebay-listings.csv"');
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csvText);
  },
  $apis.requireAuth("staff")
);

/**
 * GET /api/vault/exports/inventory.csv?status=&game=&kind=  (staff)
 *
 * Every item matching the given filters (all optional), in the column
 * order docs/csv-formats.md's "Inventory export" already sketches.
 */
routerAdd(
  "GET",
  "/api/vault/exports/inventory.csv",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;

    const statusParam = csvLib.queryParam(e, "status");
    const kindParam = csvLib.queryParam(e, "kind");
    const gameParam = csvLib.queryParam(e, "game");

    const clauses = [];
    const params = {};
    if (statusParam) {
      clauses.push("status = {:status}");
      params.status = statusParam;
    }
    if (kindParam) {
      clauses.push("kind = {:kind}");
      params.kind = kindParam;
    }
    if (gameParam) {
      let gameId = "__none__";
      try {
        gameId = e.app.findFirstRecordByFilter("games", "key = {:key}", { key: gameParam }).id;
      } catch (err) {
        gameId = "__none__"; // an unknown game key matches nothing, rather than erroring
      }
      clauses.push("game = {:game}");
      params.game = gameId;
    }
    const filter = clauses.length ? clauses.join(" && ") : "id != ''";

    let items = [];
    try {
      items = e.app.findRecordsByFilter("items", filter, "sku", 0, 0, params);
    } catch (err) {
      items = [];
    }

    let games = [];
    try {
      games = e.app.findRecordsByFilter("games", "id != ''", "", 0, 0);
    } catch (err) {
      games = [];
    }
    const gameNameById = {};
    for (let i = 0; i < games.length; i++) {
      if (games[i]) gameNameById[games[i].id] = games[i].getString("name");
    }

    let locations = [];
    try {
      locations = e.app.findRecordsByFilter("locations", "id != ''", "", 0, 0);
    } catch (err) {
      locations = [];
    }
    const locationNameById = {};
    for (let i = 0; i < locations.length; i++) {
      if (locations[i]) locationNameById[locations[i].id] = locations[i].getString("name");
    }

    let csvText = csvLib.row([
      "SKU",
      "Kind",
      "Game",
      "Title",
      "Set code",
      "Number",
      "Finish",
      "Language",
      "Condition",
      "Completeness",
      "Cosmetic grade",
      "Tested",
      "Region",
      "Grade company",
      "Grade",
      "Certificate number",
      "EAN",
      "Quantity",
      "Cost",
      "Market value at intake",
      "Sell price",
      "Tax scheme",
      "Status",
      "Location",
      "Source",
      "Acquired date",
      "Supplier reference",
    ]);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      csvText += csvLib.row([
        item.getString("sku"),
        item.getString("kind"),
        gameNameById[item.getString("game")] || "",
        item.getString("title"),
        item.getString("set_code"),
        item.getString("number"),
        item.getString("finish"),
        item.getString("language"),
        item.getString("condition"),
        item.getString("completeness"),
        item.getString("cosmetic_grade"),
        item.getBool("tested") ? "Yes" : "",
        item.getString("region"),
        item.getString("grade_company"),
        item.getString("grade"),
        item.getString("cert_no"),
        item.getString("ean"),
        item.getInt("qty"),
        csvLib.pounds(item.getInt("cost")),
        csvLib.pounds(item.getInt("market_at_intake")),
        csvLib.pounds(item.getInt("price")),
        item.getString("tax_scheme"),
        item.getString("status"),
        locationNameById[item.getString("location")] || "",
        item.getString("source"),
        (item.getString("acquired_at") || "").slice(0, 10),
        item.getString("supplier_ref"),
      ]);
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_inventory_csv",
      collection: "items",
      record: "",
      meta: { status: statusParam, game: gameParam, kind: kindParam, items: items.length },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", 'attachment; filename="inventory.csv"');
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csvText);
  },
  $apis.requireAuth("staff")
);

/**
 * GET /api/vault/exports/sales.csv?from=YYYY-MM-DD&to=YYYY-MM-DD  (staff)
 *
 * One row per sale line for every sale in the range, in the column order
 * docs/csv-formats.md's "Sales export" already sketches.
 */
routerAdd(
  "GET",
  "/api/vault/exports/sales.csv",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;

    const from = csvLib.dateParam(e, "from");
    const to = csvLib.dateParam(e, "to");
    if (!from || !to) {
      throw e.badRequestError("Pick a date range. Both from and to are needed, as YYYY-MM-DD.", null);
    }
    if (from > to) {
      throw e.badRequestError("The from date is after the to date. Swap them over.", null);
    }

    let sales = [];
    try {
      sales = e.app.findRecordsByFilter(
        "sales",
        "created >= {:from} && created <= {:to}",
        "created",
        0,
        0,
        { from: `${from} 00:00:00.000Z`, to: `${to} 23:59:59.999Z` }
      );
    } catch (err) {
      sales = [];
    }

    const staffNameCache = {};
    function staffName(id) {
      if (!id) return "";
      if (staffNameCache[id] !== undefined) return staffNameCache[id];
      let name = "";
      try {
        name = e.app.findRecordById("staff", id).getString("name");
      } catch (err) {
        name = "";
      }
      staffNameCache[id] = name;
      return name;
    }

    const customerNameCache = {};
    function customerName(id) {
      if (!id) return "";
      if (customerNameCache[id] !== undefined) return customerNameCache[id];
      let name = "";
      try {
        name = e.app.findRecordById("customers", id).getString("name");
      } catch (err) {
        name = "";
      }
      customerNameCache[id] = name;
      return name;
    }

    let csvText = csvLib.row([
      "Sale number",
      "Date",
      "Staff",
      "Customer",
      "SKU",
      "Item title",
      "Quantity",
      "Unit price",
      "Discount",
      "VAT rate",
      "Tax scheme",
      "Payment method",
      "Sale total",
      "Line status",
    ]);
    let rows = 0;

    for (let s = 0; s < sales.length; s++) {
      const sale = sales[s];
      if (!sale) continue;

      let lines = [];
      try {
        lines = util.saleLineRows(e.app, sale.id);
      } catch (err) {
        lines = [];
      }

      for (let l = 0; l < lines.length; l++) {
        const line = lines[l];
        if (!line) continue;

        let item = null;
        try {
          item = e.app.findRecordById("items", line.getString("item"));
        } catch (err) {
          item = null;
        }

        csvText += csvLib.row([
          sale.getString("number"),
          (sale.getString("created") || "").slice(0, 10),
          staffName(sale.getString("staff")),
          customerName(sale.getString("customer")),
          item ? item.getString("sku") : "",
          item ? item.getString("title") : "",
          line.getInt("qty"),
          csvLib.pounds(line.getInt("unit_price")),
          csvLib.pounds(line.getInt("discount")),
          line.getFloat("vat_rate"),
          line.getString("tax_scheme"),
          sale.getString("payment"),
          csvLib.pounds(sale.getInt("total")),
          line.getString("status"),
        ]);
        rows += 1;
      }
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_sales_csv",
      collection: "sales",
      record: "",
      meta: { from: from, to: to, sales: sales.length, rows: rows },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", `attachment; filename="sales-${from}-${to}.csv"`);
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csvText);
  },
  $apis.requireAuth("staff")
);

/**
 * GET /api/vault/exports/buy-in-register.csv?from=YYYY-MM-DD&to=YYYY-MM-DD  (admin)
 *
 * One row per accepted trade-in line completed in the range, seller
 * snapshot included, in the column order docs/csv-formats.md's "Buy-in
 * register export" already sketches. Payout type, cash amount and credit
 * amount are the whole trade-in's own figures, repeated on every line -
 * see that file for why.
 */
routerAdd(
  "GET",
  "/api/vault/exports/buy-in-register.csv",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);

    const from = csvLib.dateParam(e, "from");
    const to = csvLib.dateParam(e, "to");
    if (!from || !to) {
      throw e.badRequestError("Pick a date range. Both from and to are needed, as YYYY-MM-DD.", null);
    }
    if (from > to) {
      throw e.badRequestError("The from date is after the to date. Swap them over.", null);
    }

    let tradeIns = [];
    try {
      tradeIns = e.app.findRecordsByFilter(
        "trade_ins",
        'status = "completed" && completed_at >= {:from} && completed_at <= {:to}',
        "completed_at",
        0,
        0,
        { from: `${from} 00:00:00.000Z`, to: `${to} 23:59:59.999Z` }
      );
    } catch (err) {
      tradeIns = [];
    }

    const staffNameCache = {};
    function staffName(id) {
      if (!id) return "";
      if (staffNameCache[id] !== undefined) return staffNameCache[id];
      let name = "";
      try {
        name = e.app.findRecordById("staff", id).getString("name");
      } catch (err) {
        name = "";
      }
      staffNameCache[id] = name;
      return name;
    }

    const customerNameCache = {};
    function customerName(id) {
      if (!id) return "";
      if (customerNameCache[id] !== undefined) return customerNameCache[id];
      let name = "";
      try {
        name = e.app.findRecordById("customers", id).getString("name");
      } catch (err) {
        name = "";
      }
      customerNameCache[id] = name;
      return name;
    }

    let csvText = csvLib.row([
      "Trade-in number",
      "Date",
      "Staff",
      "Customer",
      "Seller name",
      "Seller address",
      "ID type",
      "ID last four digits",
      "ID expiry",
      "Item description",
      "Condition",
      "Quantity",
      "Market price",
      "Offer price",
      "Payout type",
      "Cash amount",
      "Credit amount",
      "Signature reference",
    ]);
    let rows = 0;

    for (let t = 0; t < tradeIns.length; t++) {
      const tradeIn = tradeIns[t];
      if (!tradeIn) continue;

      let lines = [];
      try {
        lines = e.app.findRecordsByFilter(
          "trade_in_lines",
          "trade_in = {:tradeIn}",
          "created,id",
          0,
          0,
          { tradeIn: tradeIn.id }
        );
      } catch (err) {
        lines = [];
      }

      for (let l = 0; l < lines.length; l++) {
        const line = lines[l];
        if (!line) continue;

        let description = line.getString("free_text_title");
        const cardId = line.getString("card");
        const retroTitleId = line.getString("retro_title");
        if (cardId) {
          try {
            const card = e.app.findRecordById("cards", cardId);
            const number = card.getString("number");
            description = number ? `${card.getString("name")} #${number}` : card.getString("name");
          } catch (err) {
            // Card since deleted - fall back to whatever free text is on the line.
          }
        } else if (retroTitleId) {
          try {
            description = e.app.findRecordById("retro_titles", retroTitleId).getString("name");
          } catch (err) {
            // Retro title since deleted.
          }
        }

        csvText += csvLib.row([
          tradeIn.getString("number"),
          (tradeIn.getString("completed_at") || "").slice(0, 10),
          staffName(tradeIn.getString("staff")),
          customerName(tradeIn.getString("customer")),
          tradeIn.getString("seller_name"),
          tradeIn.getString("seller_address"),
          tradeIn.getString("seller_id_type"),
          tradeIn.getString("seller_id_last4"),
          (tradeIn.getString("seller_id_expiry") || "").slice(0, 10),
          description,
          line.getString("condition") || line.getString("completeness"),
          line.getInt("qty"),
          csvLib.pounds(line.getInt("market_price")),
          csvLib.pounds(line.getInt("offer_price")),
          tradeIn.getString("payout_type"),
          csvLib.pounds(tradeIn.getInt("payout_cash")),
          csvLib.pounds(tradeIn.getInt("payout_credit")),
          tradeIn.getString("signature"),
        ]);
        rows += 1;
      }
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_buy_in_register_csv",
      collection: "trade_ins",
      record: "",
      meta: { from: from, to: to, trade_ins: tradeIns.length, rows: rows },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", `attachment; filename="buy-in-register-${from}-${to}.csv"`);
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csvText);
  },
  $apis.requireAuth("staff")
);

/**
 * GET /api/vault/exports/end-listings.csv  (staff)
 *
 * Every item with an ebay_listing_id whose status is sold, so the
 * listings can be ended by hand on eBay - docs/csv-formats.md,
 * "End-listings export". Marks nothing; POST .../items/end-listings below
 * is the one route that clears them.
 */
routerAdd(
  "GET",
  "/api/vault/exports/end-listings.csv",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;

    let items = [];
    try {
      items = e.app.findRecordsByFilter(
        "items",
        'status = "sold" && ebay_listing_id != ""',
        "sku",
        0,
        0
      );
    } catch (err) {
      items = [];
    }

    let csvText = csvLib.row(["SKU", "Title", "eBay listing ID", "eBay SKU", "Sale date", "Sale number"]);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      let saleNumber = "";
      let saleDate = "";
      try {
        const lines = e.app.findRecordsByFilter(
          "sale_lines",
          "item = {:item}",
          "-created",
          1,
          0,
          { item: item.id }
        );
        if (lines && lines.length && lines[0]) {
          const sale = e.app.findRecordById("sales", lines[0].getString("sale"));
          saleNumber = sale.getString("number");
          saleDate = (sale.getString("created") || "").slice(0, 10);
        }
      } catch (err) {
        // No sale line found (or since deleted) - leave the two columns blank.
      }

      csvText += csvLib.row([
        item.getString("sku"),
        item.getString("title"),
        item.getString("ebay_listing_id"),
        item.getString("ebay_sku"),
        saleDate,
        saleNumber,
      ]);
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "export_end_listings_csv",
      collection: "items",
      record: "",
      meta: { items: items.length },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set("Content-Disposition", 'attachment; filename="end-listings.csv"');
    header.set("Cache-Control", "no-store");

    return e.blob(200, "text/csv; charset=utf-8", csvText);
  },
  $apis.requireAuth("staff")
);

/**
 * POST /api/vault/items/end-listings  (staff)
 *
 * `{ "ids": [...] }` - once those listings are actually ended on eBay by
 * hand, clears `ebay_listing_id` and `ebay_sku` on each so it drops off
 * end-listings.csv. An id that does not exist, or has no
 * `ebay_listing_id` to clear, is silently skipped rather than failing the
 * whole request.
 */
routerAdd(
  "POST",
  "/api/vault/items/end-listings",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const body = util.body(e);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) {
      throw e.badRequestError("Pick at least one listing to end.", null);
    }

    const ended = [];
    e.app.runInTransaction((txApp) => {
      for (let i = 0; i < ids.length; i++) {
        let item = null;
        try {
          item = txApp.findRecordById("items", util.asStr(ids[i]));
        } catch (err) {
          continue;
        }
        if (!item.getString("ebay_listing_id")) continue;
        item.set("ebay_listing_id", "");
        item.set("ebay_sku", "");
        txApp.save(item);
        ended.push(item.id);
      }

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "end_ebay_listings",
        collection: "items",
        record: "",
        meta: { ids: ended },
        ip: e.realIP(),
      });
    });

    return e.json(200, { ended: ended });
  },
  $apis.requireAuth("staff")
);
