/**
 * Suppliers, the Keep on shelf target and customer requests on the server
 * (docs/api-contract-reorder.md, section 2), behind the record hooks in
 * suppliers.pb.js and the collection rules set by
 * pb_migrations/1789821300_supplier_reorder.js.
 *
 * A check returns `null` or `{ status, message }` rather than throwing, so
 * the calling hook raises it with its own event and the sentences live in
 * one place (as lib/categories.js does). The checks that tidy a record
 * (trimming, the defaults, who made a request) change it in place; they run
 * before PocketBase's own validation, so a request that gets this far is
 * saved as shaped here.
 *
 * What the hooks read is the record as PocketBase has already loaded the
 * request into it: a number field has been cast to a number (text that is
 * not a number, `null` and "" all arrive as 0, which PocketBase treats as
 * blank for every number field), so a whole-number check is a check of that
 * number.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var SENTENCES = {
  supplierName: "Give the supplier a name.",
  shelfTarget: "Keep on shelf is a whole number, 0 or more.",
  requestTitle: "Say what the customer is after.",
  requestQty: "The quantity is a whole number, 1 or more.",
  requestWho: "Add the customer, or a name to contact, so they can be told when it comes in.",
};

/** The largest Keep on shelf or quantity taken: far past any real rack, short of losing precision. */
var MAX_WHOLE = 1000000000;

function refusal(status, message) {
  return { status: status, message: message };
}

/** A trimmed string from an untyped value. */
function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** Whether a number is a whole number from `min` to MAX_WHOLE. */
function isWhole(n, min) {
  return isFinite(n) && Math.floor(n) === n && n >= min && n <= MAX_WHOLE;
}

// ---------------------------------------------------------------------
// suppliers
// ---------------------------------------------------------------------

/**
 * The refusal for a supplier being saved, or null. The name is trimmed in
 * place first. A name is required and may not match another supplier's,
 * whatever the case.
 */
function supplierProblem(app, record, isNew) {
  var name = text(record.getString("name"));
  record.set("name", name);
  if (!name) return refusal(400, SENTENCES.supplierName);

  var lower = name.toLowerCase();
  var others = app.findRecordsByFilter("suppliers", "id != ''", "", 0, 0);
  for (var i = 0; i < others.length; i++) {
    var other = others[i];
    if (!other || (!isNew && other.id === record.id)) continue;
    if (text(other.getString("name")).toLowerCase() === lower) {
      return refusal(400, "There is already a supplier called " + name + ".");
    }
  }
  return null;
}

/** The refusal for deleting a supplier any stock row or request points at, or null. */
function supplierDeleteProblem(app, record) {
  var stock = app.countRecords("items", $dbx.hashExp({ supplier: record.id }));
  var requests = app.countRecords("stock_requests", $dbx.hashExp({ supplier: record.id }));
  if (stock === 0 && requests === 0) return null;
  return refusal(400, record.getString("name") + " still has stock or requests. Switch it off instead.");
}

// ---------------------------------------------------------------------
// items: Keep on shelf and the supplier's code
// ---------------------------------------------------------------------

/**
 * The refusal for an item whose Keep on shelf is negative or fractional, or
 * null. Empty is 0, which is no target. The supplier's code is trimmed in
 * place.
 */
function itemProblem(record) {
  record.set("supplier_code", text(record.getString("supplier_code")));
  return isWhole(record.getFloat("shelf_target"), 0) ? null : refusal(400, SENTENCES.shelfTarget);
}

// ---------------------------------------------------------------------
// stock_requests
// ---------------------------------------------------------------------

/** The staff member a request is logged against: nobody for an agent or a superuser. */
function creatorOf(auth) {
  if (!auth) return "";
  try {
    if (auth.collection().name !== "staff") return "";
    if (require(__hooks + "/lib/agents.js").isAgent(auth)) return "";
  } catch (err) {
    return "";
  }
  return auth.id;
}

/**
 * The refusal for a customer request being saved, or null; the record is
 * shaped in place first.
 *
 * - `title` is trimmed and required; the contact fields are trimmed.
 * - `qty` is 1 when left empty (0 is what an empty number arrives as), else
 *   a whole number of 1 or more. A request that does not send `qty` keeps
 *   the one it has.
 * - Either a Guild customer or a name to contact is needed, so the customer
 *   can be told when it comes in.
 * - A new request starts Waiting, with the caller as `created_by` whatever
 *   was sent (nobody for an agent) and `status_changed_at` now. An update
 *   cannot change `created_by`, and a change of `status` stamps
 *   `status_changed_at`.
 */
function requestProblem(e, isNew) {
  var record = e.record;

  var title = text(record.getString("title"));
  record.set("title", title);
  if (!title) return refusal(400, SENTENCES.requestTitle);

  var qty = record.getFloat("qty");
  if (qty === 0) {
    record.set("qty", 1);
  } else if (!isWhole(qty, 1)) {
    return refusal(400, SENTENCES.requestQty);
  }

  record.set("contact_name", text(record.getString("contact_name")));
  record.set("contact_phone", text(record.getString("contact_phone")));
  record.set("notes", text(record.getString("notes")));
  if (!record.getString("customer") && !record.getString("contact_name")) {
    return refusal(400, SENTENCES.requestWho);
  }

  var now = new Date().toISOString();
  if (isNew) {
    if (!record.getString("status")) record.set("status", "waiting");
    record.set("created_by", creatorOf(e.auth));
    record.set("status_changed_at", now);
  } else {
    var before = record.original();
    record.set("created_by", before.getString("created_by"));
    if (record.getString("status") !== before.getString("status")) {
      record.set("status_changed_at", now);
    }
  }
  return null;
}

module.exports = {
  SENTENCES: SENTENCES,
  supplierProblem: supplierProblem,
  supplierDeleteProblem: supplierDeleteProblem,
  itemProblem: itemProblem,
  requestProblem: requestProblem,
};
