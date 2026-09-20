/**
 * lib/imports.js - row-level matching and writes for the two CSV
 * importers in imports.pb.js. Multipart handling, the transaction and the
 * csv_imports bookkeeping stay in imports.pb.js; this module is the part
 * that reads a mapped row and decides what happens to it, so it can be
 * called the same way from the route (and, if ever needed, a test).
 *
 * See docs/csv-formats.md for the column layouts and
 * docs/api-contract.md's "Phase 4" section for the matching rules this
 * implements.
 *
 * require() this from inside each handler body, not at file top level -
 * see pb/README.md.
 */

// The skeleton docs/csv-formats.md already carries, seeded into
// settings.import_mappings by the Phase 4 migration. Kept here too as the
// fallback for an install whose settings row predates that migration, or
// whose import_mappings entry has been cleared - an importer should never
// simply refuse to run for want of a mapping when the documented default
// is right there.
var DEFAULT_CARD_UPLOADER_MAPPING = {
  source: "card_uploader",
  headerRow: 1,
  columns: {
    name: ["Card Name", "Name", "Title"],
    set: ["Set", "Set Name"],
    number: ["Number", "Card Number", "#"],
    condition: ["Condition"],
    price: ["Price", "Sale Price"],
    quantity: ["Quantity", "Qty"],
    tcgplayerId: ["TCGplayer ID", "TCGplayer Product ID"],
    cardmarketId: ["Cardmarket ID", "Cardmarket Product ID"],
    csSku: ["CS SKU", "Custom Label"],
  },
};

var DEFAULT_EBAY_ORDERS_MAPPING = {
  source: "ebay_orders",
  headerRow: 1,
  columns: {
    customLabel: ["Custom Label", "Custom Label (SKU)"],
    itemNumber: ["Item Number"],
    orderNumber: ["Order Number", "Sales Record Number"],
    saleDate: ["Sale Date"],
    salePrice: ["Sold For", "Sale Price"],
    quantity: ["Quantity"],
    currency: ["Sale Currency", "Currency"],
  },
};

var MAX_CSV_BYTES = 10 * 1024 * 1024;
var MAX_STORED_ERRORS = 200;
var STOCK_TERMINAL_STATUSES = ["sold", "returned", "written_off"];

/**
 * Read the multipart `file` upload off a request as `{ bytes, text }` -
 * raw bytes (kept for storing the original file on the csv_imports row)
 * and its UTF-8 text (for parsing). Refuses cleanly when there is no
 * file, or it is over the size cap.
 *
 * Lives here, not as a file-top-level helper in imports.pb.js, because a
 * routerAdd handler cannot see a plain function declared at the top of
 * its own .pb.js file - only one it require()s fresh - see pb/README.md.
 * Both import routes call this the same way, so it is required rather
 * than duplicated twice.
 */
function readCsvUpload(e) {
  var uploads = e.findUploadedFiles("file");
  if (!uploads || uploads.length === 0 || !uploads[0]) {
    throw e.badRequestError("Choose a CSV file to import.", null);
  }
  var upload = uploads[0];
  if (upload.size > MAX_CSV_BYTES) {
    throw e.badRequestError("That file is over 10 MB. Export a smaller range and try again.", null);
  }

  var bytes = null;
  var reader = null;
  try {
    reader = upload.reader.open();
    bytes = toBytes(reader, MAX_CSV_BYTES + 1);
  } catch (err) {
    throw e.badRequestError("That file could not be read. Export it again and try again.", null);
  } finally {
    if (reader) {
      try {
        reader.close();
      } catch (err) {
        // Nothing useful to do if the reader will not close.
      }
    }
  }
  if (bytes.length > MAX_CSV_BYTES) {
    throw e.badRequestError("That file is over 10 MB. Export a smaller range and try again.", null);
  }

  return { bytes: bytes, text: toString(bytes) };
}

/** The multipart `type` field, trimmed, or "" when absent - the route's own guard against the wrong upload button. */
function declaredType(e) {
  try {
    return String(e.request.formValue("type") || "").trim();
  } catch (err) {
    return "";
  }
}

function configuredMapping(app, key, fallback) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var settingsRow = util.settings(app);
  var configured = settingsRow ? util.jsonField(settingsRow, "import_mappings", null) : null;
  if (configured && configured[key] && configured[key].columns) return configured[key];
  return fallback;
}

function cardUploaderMapping(app) {
  return configuredMapping(app, "card_uploader", DEFAULT_CARD_UPLOADER_MAPPING);
}

function ebayOrdersMapping(app) {
  return configuredMapping(app, "ebay_orders", DEFAULT_EBAY_ORDERS_MAPPING);
}

/** A decimal-string price into integer pence, or null when it does not read as one. */
function toPence(text) {
  var money = require(__hooks + "/lib/shared/money.js");
  var trimmed = String(text === null || text === undefined ? "" : text).trim();
  if (!trimmed) return null;
  return money.parseDecimalToMinor(trimmed);
}

function normaliseCondition(text) {
  var t = String(text || "").trim().toUpperCase();
  if (["NM", "LP", "MP", "HP", "DMG"].indexOf(t) >= 0) return t;
  return "";
}

/** A file's own date cell as an ISO instant, or null when it does not parse. */
function parseFileDate(text) {
  var s = String(text === null || text === undefined ? "" : text).trim();
  if (!s) return null;
  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Cap a rows-level errors list at the first `MAX_STORED_ERRORS` entries,
 * with a final `{ kind: "truncated", count }` naming how many more were
 * left out - so a file with thousands of bad rows never grows
 * `csv_imports.errors` (maxSize 50000) past what it can hold, and the
 * review screen still knows there is more it is not seeing.
 */
function capErrors(errors) {
  if (errors.length <= MAX_STORED_ERRORS) return errors;
  var omitted = errors.length - MAX_STORED_ERRORS;
  return errors.slice(0, MAX_STORED_ERRORS).concat([{ kind: "truncated", count: omitted }]);
}

/**
 * The three-path matching rule shared by the automatic Card Uploader
 * import below and `POST /api/vault/imports/:id/link` (a staff member
 * resolving one "needs match" row by hand). Given a `card` the caller has
 * already matched (by id in the automatic path, by a human's own pick in
 * the manual one) and that row's own `price` (pence), `quantity`,
 * `condition` and `ebaySku`, in order (docs/api-contract.md's Phase 4
 * section, "Card Uploader import matching"):
 *  (a) an existing `items` row already carrying this `ebaySku` is updated
 *      in place (status, price, qty) - unless it has since sold, been
 *      returned or been written off, in which case `{ path: "already_sold" }`
 *      is returned rather than resurrecting a disposed item;
 *  (b) failing that, the oldest still-`in_stock` item already linked to
 *      this exact card (narrowed by `condition` when the caller gives
 *      one, and by `finish`/`language` when the caller gives those too -
 *      the manual link route never has them, only the file-driven import
 *      does) is the same physical card already on the shelf, so it is
 *      connected to this listing (`status`, `ebaySku`, `price` set;
 *      `cost`, `source`, `acquired_at`, `trade_in_line` and `location`
 *      are never touched);
 *  (c) only when neither exists is a brand new `source: "supplier"` item
 *      created (its `cost` is left unset - a listing with nothing already
 *      in stock behind it).
 *
 * Returns `{ path: "ebay_sku" | "in_stock" | "created" | "already_sold", item }` -
 * `item` is the matched or created record, except for `already_sold`,
 * where it is the disposed-of item the caller is reporting on, untouched.
 * Never saves anything for `already_sold`; the caller decides what to do
 * (an `errors` entry for the file import, a 400 for the manual link).
 *
 * `defaultLocation` (a `locations` id, or "") is `settings.default_intake_location` -
 * only the (c) path uses it, on a genuinely new item; (a) and (b) update
 * an item that already has its own location, which is never touched.
 */
function applyCardMatch(txApp, staffId, card, fields, defaultLocation) {
  var pricePence = fields.price;
  var qty = fields.quantity > 0 ? fields.quantity : 1;
  var condition = fields.condition || "";
  var csSku = fields.ebaySku || "";

  // (a) an existing item already carrying this ebaySku.
  var byEbaySku = null;
  if (csSku) {
    try {
      byEbaySku = txApp.findFirstRecordByFilter("items", "ebay_sku = {:sku}", { sku: csSku });
    } catch (err) {
      byEbaySku = null;
    }
  }
  if (byEbaySku) {
    if (STOCK_TERMINAL_STATUSES.indexOf(byEbaySku.getString("status")) >= 0) {
      return { path: "already_sold", item: byEbaySku };
    }
    byEbaySku.set("status", "listed_ebay");
    byEbaySku.set("price", pricePence);
    byEbaySku.set("qty", qty);
    if (condition) byEbaySku.set("condition", condition);
    txApp.save(byEbaySku);
    return { path: "ebay_sku", item: byEbaySku };
  }

  // (b) the oldest matching item already physically in stock, narrowed by
  // condition, and by finish/language only when the caller gives them
  // (the file-driven import passes those on when its mapping carries
  // those columns; the manual link route has neither, so never narrows
  // by them - docs/api-contract.md's Phase 4 section).
  var stockFilter = 'card = {:card} && status = "in_stock"';
  var stockParams = { card: card.id };
  if (condition) {
    stockFilter += " && condition = {:condition}";
    stockParams.condition = condition;
  }
  if (fields.finish) {
    stockFilter += " && finish = {:finish}";
    stockParams.finish = fields.finish;
  }
  if (fields.language) {
    stockFilter += " && language = {:language}";
    stockParams.language = fields.language;
  }
  var inStockMatches = [];
  try {
    inStockMatches = txApp.findRecordsByFilter("items", stockFilter, "created", 1, 0, stockParams);
  } catch (err) {
    inStockMatches = [];
  }
  var inStock = inStockMatches && inStockMatches.length ? inStockMatches[0] : null;
  if (inStock) {
    inStock.set("status", "listed_ebay");
    if (csSku) inStock.set("ebay_sku", csSku);
    inStock.set("price", pricePence);
    txApp.save(inStock);
    return { path: "in_stock", item: inStock };
  }

  // (c) nothing on hand for this card anywhere - a fresh supplier item.
  var record = new Record(txApp.findCollectionByNameOrId("items"), {});
  record.set("kind", "single");
  record.set("game", card.getString("game"));
  record.set("card", card.id);
  record.set("status", "listed_ebay");
  record.set("price", pricePence);
  record.set("qty", qty);
  if (condition) record.set("condition", condition);
  if (csSku) record.set("ebay_sku", csSku);
  record.set("source", "supplier");
  record.set("acquired_at", new Date().toISOString());
  record.set("tax_scheme", "margin");
  if (staffId) record.set("created_by", staffId);
  if (defaultLocation) record.set("location", defaultLocation);
  txApp.save(record);
  return { path: "created", item: record };
}

/**
 * Process every mapped Card Uploader row inside `txApp`. A row carrying a
 * `tcgplayerId` or `cardmarketId` matches `cards` directly (both are
 * indexed - PLAN.md's "Card Uploader and the eBay round trip"); a
 * name-only row goes to the review list instead of guessing, and so does
 * one whose id does not match any `cards` row. Either way the review
 * entry carries this row's own `price`, `quantity`, `condition` and
 * `ebay_sku` (whatever it parsed to, even if blank or unreadable)
 * alongside the name/id fields a human matches by, so a later
 * `POST /api/vault/imports/:id/link` has everything `applyCardMatch`
 * above needs without re-reading the original file.
 *
 * Once a card is matched, `applyCardMatch` above runs the three-path
 * rule. Every row's writes are wrapped in try/catch: a row this build
 * cannot write for some unexpected reason becomes an `errors` entry,
 * never an exception that would abort the whole file's transaction.
 *
 * Returns `{ matched, review, errors }` - `errors` entries are
 * `{ row, kind: "review" | "error" | "already_sold", message, ... }`, the
 * shape `GET /api/vault/imports/:id` hands back for the review screen.
 * `review` counts only rows that could not be matched to any card at all;
 * the (c) case above still counts as `matched` (an item really was
 * created) even though it also adds a review-kind note to `errors`, so
 * `rows_ok` (matched + review) never double-counts a single row.
 */
function processCardUploaderRows(txApp, staffId, records, defaultLocation) {
  var errors = [];
  var matched = 0;
  var review = 0;

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    try {
      var tcgId = String(r.tcgplayerId || "").trim();
      var cmId = String(r.cardmarketId || "").trim();
      var name = String(r.name || "").trim();
      var pricePenceRaw = toPence(r.price);
      var qty = parseInt(String(r.quantity || "").trim(), 10);
      if (!(qty > 0)) qty = 1;
      var condition = normaliseCondition(r.condition);
      var csSku = String(r.csSku || "").trim();

      if (!tcgId && !cmId) {
        if (!name) {
          errors.push({ row: r._row, kind: "error", message: "No name, TCGplayer ID or Cardmarket ID on this row." });
          continue;
        }
        errors.push({
          row: r._row,
          kind: "review",
          message: "needs match",
          name: name,
          set: String(r.set || "").trim(),
          number: String(r.number || "").trim(),
          price: pricePenceRaw,
          quantity: qty,
          condition: condition,
          ebay_sku: csSku,
        });
        review += 1;
        continue;
      }

      var card = null;
      if (tcgId) {
        try {
          card = txApp.findFirstRecordByFilter("cards", "tcgplayer_id = {:id}", { id: tcgId });
        } catch (err) {
          card = null;
        }
      }
      if (!card && cmId) {
        try {
          card = txApp.findFirstRecordByFilter("cards", "cardmarket_id = {:id}", { id: cmId });
        } catch (err) {
          card = null;
        }
      }
      if (!card) {
        errors.push({
          row: r._row,
          kind: "review",
          message: "needs match",
          name: name,
          tcgplayer_id: tcgId,
          cardmarket_id: cmId,
          price: pricePenceRaw,
          quantity: qty,
          condition: condition,
          ebay_sku: csSku,
        });
        review += 1;
        continue;
      }

      if (pricePenceRaw === null || pricePenceRaw < 0) {
        errors.push({ row: r._row, kind: "error", message: "Price could not be read as an amount." });
        continue;
      }

      var outcome = applyCardMatch(
        txApp,
        staffId,
        card,
        {
          price: pricePenceRaw,
          quantity: qty,
          condition: condition,
          ebaySku: csSku,
          finish: Object.prototype.hasOwnProperty.call(r, "finish") ? String(r.finish || "").trim() : "",
          language: Object.prototype.hasOwnProperty.call(r, "language") ? String(r.language || "").trim() : "",
        },
        defaultLocation
      );

      if (outcome.path === "already_sold") {
        errors.push({ row: r._row, kind: "already_sold", message: "already sold", ebay_sku: csSku });
        continue;
      }

      matched += 1;
      if (outcome.path === "created") {
        errors.push({
          row: r._row,
          kind: "review",
          message: "Listed card was not in stock. Created with no cost - check it.",
          card: card.id,
          sku: outcome.item.getString("sku"),
        });
      }
    } catch (err) {
      errors.push({ row: r._row, kind: "error", message: "This row could not be processed." });
    }
  }

  return { matched: matched, review: review, errors: capErrors(errors) };
}

/**
 * Resolve one "needs match" review row on an import that has already run
 * (`POST /api/vault/imports/:id/link`): either link it to a `cards` row a
 * human picked, running the exact same `applyCardMatch` rule the
 * automatic import above uses, or drop it as `skip`. When linking lands
 * on `applyCardMatch`'s "created" path, the old "needs match" entry is
 * replaced with the same zero-cost review note `processCardUploaderRows`
 * itself would have left - the row stops needing a match, but a supplier
 * item created with no cost behind it is still worth Richard checking,
 * whichever path put it there. Mutates `importRecord`'s `errors`,
 * `resolved_rows` and (for a skip) `rows_skipped` fields in place; the
 * caller saves it, and only it, inside its own transaction, and decides
 * what to audit.
 *
 * Returns one of:
 *  - `{ status: "ok", path, item }` - `path` is `applyCardMatch`'s own,
 *    or `"skipped"`; `item` is `null` for a skip.
 *  - `{ status: "not_found" }` - no "needs match" entry for this row
 *    number exists in `errors` right now.
 *  - `{ status: "already_resolved" }` - this row number has already been
 *    linked or skipped (its `errors` entry is gone, but `resolved_rows`
 *    remembers it) - the caller's own row-was-here check to tell apart
 *    from `not_found` above.
 *  - `{ status: "bad_card" }` - `cardId` (link only) does not resolve to
 *    a `cards` row.
 *  - `{ status: "bad_price" }` - this row's own captured price did not
 *    parse to a usable amount at import time, so there is nothing to
 *    list it at (link only; a skip never needs a price).
 *  - `{ status: "already_sold" }` - the row's own `ebay_sku` (link only)
 *    already tags an item that has since sold, been returned or been
 *    written off.
 */
function resolveReviewRow(txApp, staffId, importRecord, rowNumber, cardId, skip, defaultLocation) {
  var util = require(__hooks + "/lib/vaultutil.js");

  var resolvedRows = util.jsonField(importRecord, "resolved_rows", []);
  if (!Array.isArray(resolvedRows)) resolvedRows = [];
  for (var k = 0; k < resolvedRows.length; k++) {
    if (resolvedRows[k] === rowNumber) return { status: "already_resolved" };
  }

  var errorsList = util.jsonField(importRecord, "errors", []);
  if (!Array.isArray(errorsList)) errorsList = [];
  var entryIndex = -1;
  for (var i = 0; i < errorsList.length; i++) {
    var candidate = errorsList[i];
    if (candidate && candidate.row === rowNumber && candidate.kind === "review" && candidate.message === "needs match") {
      entryIndex = i;
      break;
    }
  }
  if (entryIndex < 0) return { status: "not_found" };

  var entry = errorsList[entryIndex];
  var remainingErrors = errorsList.slice(0, entryIndex).concat(errorsList.slice(entryIndex + 1));

  if (skip) {
    resolvedRows.push(rowNumber);
    importRecord.set("errors", remainingErrors);
    importRecord.set("resolved_rows", resolvedRows);
    importRecord.set("rows_skipped", (importRecord.getInt("rows_skipped") || 0) + 1);
    return { status: "ok", path: "skipped", item: null };
  }

  var card = null;
  try {
    card = txApp.findRecordById("cards", cardId);
  } catch (err) {
    card = null;
  }
  if (!card) return { status: "bad_card" };

  var pricePence = entry.price;
  if (typeof pricePence !== "number" || isNaN(pricePence) || pricePence < 0) {
    return { status: "bad_price" };
  }

  var outcome = applyCardMatch(
    txApp,
    staffId,
    card,
    {
      price: pricePence,
      quantity: entry.quantity,
      condition: entry.condition || "",
      ebaySku: entry.ebay_sku || "",
    },
    defaultLocation
  );

  if (outcome.path === "already_sold") {
    return { status: "already_sold" };
  }

  if (outcome.path === "created") {
    remainingErrors = remainingErrors.concat([
      {
        row: rowNumber,
        kind: "review",
        message: "Listed card was not in stock. Created with no cost - check it.",
        card: card.id,
        sku: outcome.item.getString("sku"),
      },
    ]);
  }

  resolvedRows.push(rowNumber);
  importRecord.set("errors", remainingErrors);
  importRecord.set("resolved_rows", resolvedRows);
  return { status: "ok", path: outcome.path, item: outcome.item };
}

/**
 * Process every mapped eBay orders row inside `txApp`, one sale per order
 * (docs/api-contract.md's Phase 4 section): rows sharing the same
 * `orderNumber` become one `sales` row (`channel: "ebay"`,
 * `external_ref: orderNumber`, truncated to the field's own 100
 * characters) with one `sale_lines` row per row of the file, its
 * `occurred_at` taken from the first row's own `saleDate` column
 * (falling back to now when it does not parse). A row with no order
 * number gets a one-line "order" of its own, matching the old
 * one-row-one-sale behaviour for a file that never carries one.
 *
 * Matching an item is by its `ebay_sku` custom label. An item already
 * `sold`, `returned` or `written_off` is reported as `already_sold`
 * rather than sold again. Idempotency itself, though, is a `sale_lines`
 * row already existing for `(sale, item)` - not the item's own status,
 * which a partial sale of a multi-unit stock line can legitimately leave
 * short of `sold` - so re-running the same file, or one that overlaps an
 * earlier export, never double-sells the same line of the same order. A
 * multi-unit line's `qty` is decremented and only set `status: "sold"`
 * once nothing is left, mirroring `sales.pb.js`'s own counter-sale logic.
 *
 * `payment` is left blank on every created sale: none of `sales.payment`'s
 * values (sumup_card, cash, store_credit, points, mixed) describe money
 * that went through this shop at all - eBay collected the buyer's payment
 * on its own side - so `channel: "ebay"` is what actually says how this
 * sale happened, and a fabricated payment method would be worse than none.
 *
 * Every row's writes are wrapped in try/catch, the same reasoning as
 * `processCardUploaderRows` above.
 *
 * Returns `{ sold, alreadySold, errors }`.
 */
function processEbayOrdersRows(txApp, staffId, records, vatRegistered) {
  var errors = [];
  var sold = 0;
  var alreadySold = 0;

  // Group by orderNumber (preserving each row's own place, for its own
  // error/row-number reporting), so one order becomes one sale.
  var orderGroups = {};
  var groupKeys = [];
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var orderNumber = String(r.orderNumber || "").trim();
    // A blank order number still gets its own single-row "order": there
    // is nothing to group it with, and grouping every blank-order row
    // together under one fake shared sale would be worse.
    var key = orderNumber ? "n:" + orderNumber : "r:" + r._row;
    if (!orderGroups[key]) {
      orderGroups[key] = { orderNumber: orderNumber, rows: [] };
      groupKeys.push(key);
    }
    orderGroups[key].rows.push(r);
  }

  for (var g = 0; g < groupKeys.length; g++) {
    var group = orderGroups[groupKeys[g]];
    var orderNumber = group.orderNumber;
    var externalRef = orderNumber.slice(0, 100);

    var sale = null;
    if (orderNumber) {
      try {
        sale = txApp.findFirstRecordByFilter(
          "sales",
          'channel = "ebay" && external_ref = {:ref}',
          { ref: externalRef }
        );
      } catch (err) {
        sale = null;
      }
    }

    if (!sale) {
      var occurredAt = parseFileDate(group.rows[0] && group.rows[0].saleDate) || new Date().toISOString();
      var counters = require(__hooks + "/lib/counters.js");
      var number = counters.nextNumber(txApp, "sale");
      sale = new Record(txApp.findCollectionByNameOrId("sales"), {
        number: number,
        subtotal: 0,
        discount: 0,
        total: 0,
        refunded_total: 0,
        status: "complete",
        channel: "ebay",
        external_ref: externalRef,
        occurred_at: occurredAt,
      });
      if (staffId) sale.set("staff", staffId);
      try {
        txApp.save(sale);
      } catch (err) {
        for (var gi = 0; gi < group.rows.length; gi++) {
          errors.push({ row: group.rows[gi]._row, kind: "error", message: "Could not create the sale for this order." });
        }
        continue;
      }
    }

    var saleTotalDelta = 0;
    for (var ri = 0; ri < group.rows.length; ri++) {
      var row = group.rows[ri];
      try {
        var customLabel = String(row.customLabel || "").trim();
        if (!customLabel) {
          errors.push({ row: row._row, kind: "error", message: "No custom label (SKU) on this row." });
          continue;
        }

        var item = null;
        try {
          item = txApp.findFirstRecordByFilter("items", "ebay_sku = {:sku}", { sku: customLabel });
        } catch (err) {
          item = null;
        }
        if (!item) {
          errors.push({
            row: row._row,
            kind: "error",
            message: "No item is listed with custom label " + customLabel + ".",
            custom_label: customLabel,
          });
          continue;
        }

        var itemStatus = item.getString("status");
        if (STOCK_TERMINAL_STATUSES.indexOf(itemStatus) >= 0) {
          errors.push({ row: row._row, kind: "already_sold", message: "already sold", custom_label: customLabel });
          alreadySold += 1;
          continue;
        }

        // Idempotency: a sale_lines row already tying this item to this
        // sale means an earlier run already processed this exact row.
        var already = null;
        try {
          already = txApp.findFirstRecordByFilter(
            "sale_lines",
            "sale = {:sale} && item = {:item}",
            { sale: sale.id, item: item.id }
          );
        } catch (err) {
          already = null;
        }
        if (already) {
          errors.push({ row: row._row, kind: "already_sold", message: "already sold", custom_label: customLabel });
          alreadySold += 1;
          continue;
        }

        var pricePence = toPence(row.salePrice);
        if (pricePence === null || pricePence < 0) {
          errors.push({ row: row._row, kind: "error", message: "Sale price could not be read as an amount." });
          continue;
        }

        var qty = parseInt(String(row.quantity || "").trim(), 10);
        if (!(qty > 0)) qty = 1;

        var taxScheme = item.getString("tax_scheme") || "margin";

        txApp.save(
          new Record(txApp.findCollectionByNameOrId("sale_lines"), {
            sale: sale.id,
            item: item.id,
            qty: qty,
            unit_price: pricePence,
            discount: 0,
            refunded_qty: 0,
            vat_rate: vatRegistered && taxScheme === "standard" ? 20 : 0,
            tax_scheme: taxScheme,
            status: "sold",
          })
        );

        // Mirrors sales.pb.js: "sold" only once the remaining qty reaches
        // zero, so a partial sale of a multi-unit stock line stays
        // listed_ebay with its qty reduced, not falsely sold out.
        var remaining = Math.max(0, item.getInt("qty") - qty);
        item.set("qty", remaining);
        if (remaining <= 0) item.set("status", "sold");
        txApp.save(item);

        saleTotalDelta += pricePence;
        sold += 1;
      } catch (err) {
        errors.push({ row: row._row, kind: "error", message: "Could not record this sale line." });
      }
    }

    if (saleTotalDelta > 0) {
      try {
        var newTotal = sale.getInt("total") + saleTotalDelta;
        sale.set("subtotal", newTotal);
        sale.set("total", newTotal);
        txApp.save(sale);
      } catch (err) {
        // The lines themselves are already saved and correct; the sale's
        // own total cache failing to update is logged, not fatal to the row.
        console.log("[imports] could not update the sale total for order " + orderNumber + ": " + err);
      }
    }
  }

  return { sold: sold, alreadySold: alreadySold, errors: capErrors(errors) };
}

module.exports = {
  DEFAULT_CARD_UPLOADER_MAPPING: DEFAULT_CARD_UPLOADER_MAPPING,
  DEFAULT_EBAY_ORDERS_MAPPING: DEFAULT_EBAY_ORDERS_MAPPING,
  readCsvUpload: readCsvUpload,
  declaredType: declaredType,
  cardUploaderMapping: cardUploaderMapping,
  ebayOrdersMapping: ebayOrdersMapping,
  parseFileDate: parseFileDate,
  applyCardMatch: applyCardMatch,
  processCardUploaderRows: processCardUploaderRows,
  processEbayOrdersRows: processEbayOrdersRows,
  resolveReviewRow: resolveReviewRow,
};
