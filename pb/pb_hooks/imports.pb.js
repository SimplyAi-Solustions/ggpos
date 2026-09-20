/// <reference path="../pb_data/types.d.ts" />

/**
 * imports.pb.js - CSV imports: Card Uploader and eBay orders.
 *
 *   POST /api/vault/imports/card-uploader   (multipart: file, type)
 *   POST /api/vault/imports/ebay-orders     (multipart: file, type)
 *   GET  /api/vault/imports/:id
 *
 * Every import reads a mapping config (settings.import_mappings, seeded
 * by the Phase 4 migration with the skeleton docs/csv-formats.md already
 * carries) rather than hard-coded headers, because the real per-card
 * Card Uploader headers are only visible inside a logged-in account
 * (docs/csv-formats.md) - Richard confirms the seeded mapping against a
 * real export.
 *
 * Both routes run the whole import - the csv_imports bookkeeping row and
 * every item or sale it creates - inside one $app.runInTransaction, so a
 * file that goes wrong partway through leaves nothing behind. A single
 * bad row never aborts that transaction by itself, though: row-level
 * problems (no ids and no name, an unreadable price, an unknown custom
 * label, an already-sold item) are collected into the csv_imports row's
 * own `errors` list (lib/imports.js) so the rest of the file still goes
 * through - only a file whose header row this build cannot recognise at
 * all is refused up front, before any transaction opens.
 *
 * See docs/api-contract.md's "Phase 4" section for the exact refusals and
 * response shapes.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// sales.channel defaults to "counter" when a sale is created with it
// left empty. This lives here, not in sales.pb.js (another package's
// file this round - see the Phase 4 brief), because imports.pb.js is
// what actually needs the field: an eBay-orders-imported sale sets
// channel: "ebay" itself, but every ordinary counter sale sales.pb.js
// creates has never heard of this field at all, and "default counter"
// (docs/PLAN.md's Phase 4 plan) has to happen somewhere. onRecordCreate
// hooks from separate files both fire normally - see items.pb.js and
// customers.pb.js for two more that already coexist with other files'
// hooks on collections they do not otherwise own.
// ---------------------------------------------------------------------
onRecordCreate((e) => {
  if (!e.record.getString("channel")) {
    e.record.set("channel", "counter");
  }
  e.next();
}, "sales");

// ---------------------------------------------------------------------
// POST /api/vault/imports/card-uploader
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/imports/card-uploader",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const importsLib = require(`${__hooks}/lib/imports.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;

    const type = importsLib.declaredType(e);
    if (type && type !== "card_uploader") {
      throw e.badRequestError("This is the Card Uploader import. Check you picked the right file.", null);
    }

    const upload = importsLib.readCsvUpload(e);
    const rows = csvLib.parse(upload.text);
    const mapping = importsLib.cardUploaderMapping(e.app);
    const mapped = csvLib.mapRows(rows, mapping);

    if (rows.length === 0 || !csvLib.looksRecognised(mapped)) {
      throw e.badRequestError(
        "That file is not a CSV we recognise. Check the first line has the column headings.",
        null
      );
    }

    let result = null;
    e.app.runInTransaction((txApp) => {
      const record = new Record(txApp.findCollectionByNameOrId("csv_imports"), {
        type: "card_uploader",
        status: "processing",
        rows_total: mapped.records.length,
        rows_ok: 0,
        errors: [],
        staff: staff.id,
      });
      record.set("file", $filesystem.fileFromBytes(upload.bytes, `card-uploader-${Date.now()}.csv`));
      txApp.save(record);

      const outcome = importsLib.processCardUploaderRows(txApp, staff.id, mapped.records);

      record.set("rows_ok", outcome.matched + outcome.review);
      record.set("errors", outcome.errors);
      record.set("status", "done");
      txApp.save(record);

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "import_card_uploader",
        collection: "csv_imports",
        record: record.id,
        meta: { rows_total: mapped.records.length, matched: outcome.matched, review: outcome.review },
        ip: e.realIP(),
      });

      result = { import: record, matched: outcome.matched, review: outcome.review };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/imports/ebay-orders
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/imports/ebay-orders",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const importsLib = require(`${__hooks}/lib/imports.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;

    const type = importsLib.declaredType(e);
    if (type && type !== "ebay_orders") {
      throw e.badRequestError("This is the eBay orders import. Check you picked the right file.", null);
    }

    const upload = importsLib.readCsvUpload(e);
    const rows = csvLib.parse(upload.text);
    const mapping = importsLib.ebayOrdersMapping(e.app);
    const mapped = csvLib.mapRows(rows, mapping);

    if (rows.length === 0 || !csvLib.looksRecognised(mapped)) {
      throw e.badRequestError(
        "That file is not a CSV we recognise. Check the first line has the column headings.",
        null
      );
    }

    const settingsRow = util.settings(e.app);
    const vatRegistered = settingsRow ? settingsRow.getBool("vat_registered") : false;

    let result = null;
    e.app.runInTransaction((txApp) => {
      const record = new Record(txApp.findCollectionByNameOrId("csv_imports"), {
        type: "ebay_orders",
        status: "processing",
        rows_total: mapped.records.length,
        rows_ok: 0,
        errors: [],
        staff: staff.id,
      });
      record.set("file", $filesystem.fileFromBytes(upload.bytes, `ebay-orders-${Date.now()}.csv`));
      txApp.save(record);

      const outcome = importsLib.processEbayOrdersRows(txApp, staff.id, mapped.records, vatRegistered);

      record.set("rows_ok", outcome.sold);
      record.set("errors", outcome.errors);
      record.set("status", "done");
      txApp.save(record);

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "import_ebay_orders",
        collection: "csv_imports",
        record: record.id,
        meta: { rows_total: mapped.records.length, sold: outcome.sold, already_sold: outcome.alreadySold },
        ip: e.realIP(),
      });

      result = { import: record, sold: outcome.sold, already_sold: outcome.alreadySold };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/imports/:id
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/imports/{id}",
  (e) => {
    let record = null;
    try {
      record = e.app.findRecordById("csv_imports", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Import not found. Check the id and try again.", null);
    }
    return e.json(200, record);
  },
  $apis.requireAuth("staff")
);
