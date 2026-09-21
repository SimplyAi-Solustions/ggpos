/**
 * lib/reservations.js - the staff reservation's own expiry, behind
 * reservations.pb.js's `reservations_expire` cron.
 *
 * This is the mirror image of lib/wants.js's `releaseExpiredHolds`. Both
 * walk the same query - an `items` row that is `reserved` with a
 * `reserved_until` in the past - and each takes exactly the half of it
 * the other leaves alone:
 *
 *  - a row a `matched` want_list row points at is a want-list hold, which
 *    `releaseExpiredHolds` releases and tells the customer about;
 *  - a row with no such want_list row behind it is a promise a member of
 *    staff made across the counter, which this releases quietly.
 *
 * Quietly is deliberate. Nobody was told by the system that the hold
 * existed, so nobody is told it has ended: the item goes back on the
 * shelf, a `notes` row on the item says who it was held for and until
 * when, and an `audit_log` row records the release. A reservation with an
 * empty `reserved_until` is an open-ended hold and is never touched.
 *
 * Each item is released in its own transaction, so one bad row cannot
 * hold up the rest, and a second run the same minute finds nothing left
 * to do.
 *
 * require() this from inside the cron body, not at file top level - see
 * pb/README.md.
 */

var HELD_STATUS = "reserved";

/** PocketBase's own stored date shape ("2026-09-20 12:00:00.000Z"). */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

/** A stored date read back as a Date, whichever separator it carries. */
function parseStored(value) {
  if (!value) return null;
  var d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/** True when a `matched` want_list row is holding this item (lib/wants.js's job, not this one). */
function heldByWantList(app, itemId) {
  try {
    var rows = app.findRecordsByFilter("want_list", 'status = "matched" && matched_item = {:item}', "", 1, 0, {
      item: itemId,
    });
    return !!(rows && rows.length);
  } catch (err) {
    // A query that could not be run is treated as "somebody may be
    // holding this": leaving an item reserved for another quarter of an
    // hour is the safer of the two mistakes.
    return true;
  }
}

/** The customer's own name for the note, or a neutral phrase when the row has gone. */
function customerName(app, customerId) {
  if (!customerId) return "a customer";
  try {
    var customer = app.findRecordById("customers", customerId);
    return customer.getString("name") || "a customer";
  } catch (err) {
    return "a customer";
  }
}

/**
 * Release every staff reservation whose `reserved_until` has passed.
 *
 * @param {any} app - $app, or a txApp when a caller already has one open.
 * @param {Date} [now]
 * @returns {{released: number, skipped: number}} `skipped` is want-list holds left for lib/wants.js.
 */
function releaseExpired(app, now) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var quotes = require(__hooks + "/lib/quotes.js");
  var at = now || new Date();
  var cutoff = pbDate(at);

  var items = [];
  try {
    items = app.findRecordsByFilter(
      "items",
      'status = {:status} && reserved_until != "" && reserved_until < {:now}',
      "reserved_until",
      0,
      0,
      { status: HELD_STATUS, now: cutoff }
    );
  } catch (err) {
    items = [];
  }

  var released = 0;
  var skipped = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;
    if (heldByWantList(app, item.id)) {
      skipped += 1;
      continue;
    }

    var customerId = item.getString("reserved_for");
    var until = item.getString("reserved_until");
    var name = customerName(app, customerId);
    var untilText = quotes.ukDateShort(String(until).replace(" ", "T")) || String(until);

    try {
      var freed = false;
      app.runInTransaction(function (txApp) {
        var live = txApp.findRecordById("items", item.id);
        // Re-checked inside the transaction: a sale or a fresh
        // reservation that landed in the meantime keeps the item.
        if (live.getString("status") !== HELD_STATUS) return;
        var liveUntil = parseStored(live.getString("reserved_until"));
        if (!liveUntil || liveUntil.getTime() >= at.getTime()) return;

        live.set("status", "in_stock");
        live.set("reserved_for", "");
        live.set("reserved_until", "");
        txApp.save(live);

        txApp.save(
          new Record(txApp.findCollectionByNameOrId("notes"), {
            target_collection: "items",
            target_record: live.id,
            body: "Hold for " + name + " ended " + untilText + "; back on the shelf.",
          })
        );

        auditLib.writeAuditLog(txApp, {
          actor: "system",
          action: "reservation_expired",
          collection: "items",
          record: live.id,
          meta: { sku: live.getString("sku"), customer: customerId, reserved_until: until },
          ip: "",
        });

        freed = true;
      });
      // Counted after the transaction returns, never inside it: a commit
      // that then fails must not read as an item back on the shelf.
      if (freed) released += 1;
    } catch (err) {
      console.log("[reservations] could not release item " + item.id + ": " + err);
    }
  }

  return { released: released, skipped: skipped };
}

module.exports = {
  pbDate: pbDate,
  releaseExpired: releaseExpired,
};
