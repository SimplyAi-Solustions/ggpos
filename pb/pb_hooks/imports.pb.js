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
 * bad row never aborts that transaction by itself: row-level problems (no
 * ids and no name, an unreadable price, an unknown custom label, an
 * already-sold item) are collected into the csv_imports row's own
 * `errors` list (lib/imports.js, which also wraps every row's own writes
 * in try/catch) so the rest of the file still goes through - only a file
 * whose header row this build cannot recognise at all is refused up
 * front, before any transaction opens, and the rare case of the
 * transaction itself failing (the bookkeeping row could not be saved) is
 * still a clean 400, not a bare 500.
 *
 * `$apis.bodyLimit` on both POST routes refuses an oversized request
 * before any of that even starts - see lib/imports.js's own MAX_CSV_BYTES
 * for the matching in-handler check once the body has been read.
 *
 * See docs/api-contract.md's "Phase 4" section for the exact refusals and
 * response shapes.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/imports/card-uploader
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/imports/card-uploader",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
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
    try {
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

        const settingsRow = util.settings(txApp);
        const defaultLocation = settingsRow ? settingsRow.getString("default_intake_location") : "";
        const outcome = importsLib.processCardUploaderRows(txApp, staff.id, mapped.records, defaultLocation);

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
    } catch (err) {
      throw e.badRequestError("This import could not be saved. Check the file and try again.", null);
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff"),
  $apis.bodyLimit(10 << 20)
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
    try {
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
    } catch (err) {
      throw e.badRequestError("This import could not be saved. Check the file and try again.", null);
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff"),
  $apis.bodyLimit(10 << 20)
);

// ---------------------------------------------------------------------
// GET /api/vault/imports/:id
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/imports/{id}",
  (e) => {
    const auditLib = require(`${__hooks}/lib/audit.js`);

    let record = null;
    try {
      record = e.app.findRecordById("csv_imports", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Import not found. Check the id and try again.", null);
    }

    auditLib.writeAuditLog(e.app, {
      actor: e.auth.id,
      action: "import_view",
      collection: "csv_imports",
      record: record.id,
      meta: {},
      ip: e.realIP(),
    });

    return e.json(200, record);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/imports/:id/link
// ---------------------------------------------------------------------
//
// The counter screen's own Card Uploader review queue used to link a
// "needs match" row by creating an items row itself through the
// collection API, bypassing the three-path matching rule below
// (lib/imports.js's applyCardMatch, the same one processCardUploaderRows
// runs automatically) and risking a duplicate, zero-cost item for a card
// already on the shelf. This route runs that exact rule for one row by
// hand instead, so a manual match can never drift from the automatic one.
//
// Body `{ "row": <1-based row number from the import's own errors
// entry>, "card": "<cards id>" }` links the row; `{ "row": <n>, "skip":
// true }` dismisses it without listing anything. See
// docs/api-contract.md's Phase 4 section for the full rule and every
// refusal below.
routerAdd(
  "POST",
  "/api/vault/imports/{id}/link",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const importsLib = require(`${__hooks}/lib/imports.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const body = util.body(e);
    const rowNumber = util.asInt(body.row, 0);
    const skip = util.asBool(body.skip);
    const cardId = util.asStr(body.card);
    const NOT_WAITING = "That row is not waiting for a match.";

    if (!(rowNumber > 0)) {
      throw e.badRequestError("Give the row number to link or skip.", null);
    }
    if (!skip && !cardId) {
      throw e.badRequestError("Give the card id to link this row to, or set skip.", null);
    }

    // Read-only lookup, before any transaction opens, so an import id
    // that does not exist gets this route's own 404 wording rather than
    // the generic transaction-failure 400 below.
    let importId = "";
    try {
      importId = e.app.findRecordById("csv_imports", e.request.pathValue("id")).id;
    } catch (err) {
      throw e.notFoundError(NOT_WAITING, null);
    }

    let outcome = null;
    let importRow = null;
    try {
      e.app.runInTransaction((txApp) => {
        const record = txApp.findRecordById("csv_imports", importId);
        const settingsRow = util.settings(txApp);
        const defaultLocation = settingsRow ? settingsRow.getString("default_intake_location") : "";

        outcome = importsLib.resolveReviewRow(txApp, staff.id, record, rowNumber, cardId, skip, defaultLocation);
        if (outcome.status !== "ok") return;

        txApp.save(record);
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "import_link",
          collection: "csv_imports",
          record: record.id,
          meta: {
            row: rowNumber,
            card: skip ? "" : cardId,
            item: outcome.item ? outcome.item.id : "",
            path: outcome.path,
          },
          ip: e.realIP(),
        });
        importRow = record;
      });
    } catch (err) {
      throw e.badRequestError("This row could not be linked. Check it and try again.", null);
    }

    if (!outcome || outcome.status === "not_found") {
      throw e.notFoundError(NOT_WAITING, null);
    }
    if (outcome.status === "already_resolved") {
      throw e.error(409, "This row has already been linked or skipped.", null);
    }
    if (outcome.status === "bad_card") {
      throw e.badRequestError("Card not found. Check the id.", null);
    }
    if (outcome.status === "bad_price") {
      throw e.badRequestError(
        "This row's price could not be read as an amount. Re-import the file with a valid price.",
        null
      );
    }
    if (outcome.status === "already_sold") {
      throw e.error(409, "That listing has already sold, been returned or been written off.", null);
    }

    return e.json(200, { import: importRow, item: outcome.item, path: outcome.path });
  },
  $apis.requireAuth("staff")
);
