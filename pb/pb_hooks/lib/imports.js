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
  const uploads = e.findUploadedFiles("file");
  if (!uploads || uploads.length === 0 || !uploads[0]) {
    throw e.badRequestError("Choose a CSV file to import.", null);
  }
  const upload = uploads[0];
  if (upload.size > MAX_CSV_BYTES) {
    throw e.badRequestError("That file is over 10 MB. Export a smaller range and try again.", null);
  }

  let bytes = null;
  let reader = null;
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

/**
 * Process every mapped Card Uploader row inside `txApp`. A row carrying a
 * `tcgplayerId` or `cardmarketId` matches `cards` directly (both are
 * indexed - PLAN.md's "Card Uploader and the eBay round trip"); a
 * name-only row goes to the review list instead of guessing. A matched
 * row creates or updates an `items` row: `status: "listed_ebay"`,
 * `ebay_sku` from the CS-XXXXXX custom label, price from the file in
 * pence, `source: "supplier"` unless an item with that `ebay_sku` already
 * exists, in which case it is updated in place rather than duplicated.
 *
 * Returns `{ matched, review, errors }` - `errors` entries are
 * `{ row, kind: "review" | "error", message, ... }`, the shape
 * `GET /api/vault/imports/:id` hands back for the review screen.
 */
function processCardUploaderRows(txApp, staffId, records) {
  var errors = [];
  var matched = 0;
  var review = 0;
  var nowIso = new Date().toISOString();

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var tcgId = String(r.tcgplayerId || "").trim();
    var cmId = String(r.cardmarketId || "").trim();
    var name = String(r.name || "").trim();

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
      });
      review += 1;
      continue;
    }

    var pricePence = toPence(r.price);
    if (pricePence === null || pricePence < 0) {
      errors.push({ row: r._row, kind: "error", message: "Price could not be read as an amount." });
      continue;
    }

    var qty = parseInt(String(r.quantity || "").trim(), 10);
    if (!(qty > 0)) qty = 1;

    var csSku = String(r.csSku || "").trim();
    var existing = null;
    if (csSku) {
      try {
        existing = txApp.findFirstRecordByFilter("items", "ebay_sku = {:sku}", { sku: csSku });
      } catch (err) {
        existing = null;
      }
    }

    var record = existing || new Record(txApp.findCollectionByNameOrId("items"), {});
    record.set("kind", "single");
    record.set("game", card.getString("game"));
    record.set("card", card.id);
    record.set("status", "listed_ebay");
    record.set("price", pricePence);
    record.set("qty", qty);
    var condition = normaliseCondition(r.condition);
    if (condition) record.set("condition", condition);
    if (csSku) record.set("ebay_sku", csSku);
    if (!existing) {
      record.set("source", "supplier");
      record.set("acquired_at", nowIso);
      record.set("tax_scheme", "margin");
    }
    txApp.save(record);
    matched += 1;
  }

  return { matched: matched, review: review, errors: errors };
}

/**
 * Process every mapped eBay orders row inside `txApp`: match the item by
 * custom label (`ebay_sku`), create a `sales` row with `channel: "ebay"`
 * and one `sale_lines` row at the sold price, mark the item sold, and
 * record the order reference as `sales.external_ref`. An item already
 * `sold` is reported rather than sold again, so a re-run of the same
 * export file (or an order that appears in two overlapping exports)
 * cannot double-sell it.
 *
 * `payment` is left blank on the created sale: none of `sales.payment`'s
 * values (sumup_card, cash, store_credit, points, mixed) describe money
 * that went through this shop at all - eBay collected the buyer's payment
 * on its own side - so `channel: "ebay"` is what actually says how this
 * sale happened, and a fabricated payment method would be worse than none.
 *
 * Returns `{ sold, alreadySold, errors }`.
 */
function processEbayOrdersRows(txApp, staffId, records, vatRegistered) {
  var errors = [];
  var sold = 0;
  var alreadySold = 0;

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var customLabel = String(r.customLabel || "").trim();
    if (!customLabel) {
      errors.push({ row: r._row, kind: "error", message: "No custom label (SKU) on this row." });
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
        row: r._row,
        kind: "error",
        message: "No item is listed with custom label " + customLabel + ".",
        custom_label: customLabel,
      });
      continue;
    }
    if (item.getString("status") === "sold") {
      errors.push({ row: r._row, kind: "already_sold", message: "already sold", custom_label: customLabel });
      alreadySold += 1;
      continue;
    }

    var pricePence = toPence(r.salePrice);
    if (pricePence === null || pricePence < 0) {
      errors.push({ row: r._row, kind: "error", message: "Sale price could not be read as an amount." });
      continue;
    }

    var qty = parseInt(String(r.quantity || "").trim(), 10);
    if (!(qty > 0)) qty = 1;

    var counters = require(__hooks + "/lib/counters.js");
    var number = counters.nextNumber(txApp, "sale");
    var taxScheme = item.getString("tax_scheme") || "margin";

    var sale = new Record(txApp.findCollectionByNameOrId("sales"), {
      number: number,
      subtotal: pricePence,
      discount: 0,
      total: pricePence,
      refunded_total: 0,
      status: "complete",
      channel: "ebay",
      external_ref: String(r.orderNumber || "").trim(),
    });
    txApp.save(sale);

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

    item.set("qty", Math.max(0, item.getInt("qty") - qty));
    item.set("status", "sold");
    txApp.save(item);

    sold += 1;
  }

  return { sold: sold, alreadySold: alreadySold, errors: errors };
}

module.exports = {
  DEFAULT_CARD_UPLOADER_MAPPING: DEFAULT_CARD_UPLOADER_MAPPING,
  DEFAULT_EBAY_ORDERS_MAPPING: DEFAULT_EBAY_ORDERS_MAPPING,
  readCsvUpload: readCsvUpload,
  declaredType: declaredType,
  cardUploaderMapping: cardUploaderMapping,
  ebayOrdersMapping: ebayOrdersMapping,
  processCardUploaderRows: processCardUploaderRows,
  processEbayOrdersRows: processEbayOrdersRows,
};
