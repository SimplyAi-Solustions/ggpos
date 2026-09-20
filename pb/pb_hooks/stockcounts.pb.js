/// <reference path="../pb_data/types.d.ts" />

/**
 * stockcounts.pb.js - closing a stock count.
 *
 *   POST /api/vault/stock-counts/{id}/close   (admin)
 *
 * docs/api-contract.md's "Stock counts" section for the shape. Counts and
 * their lines are otherwise ordinary collection-API rows (staff create and
 * update); this is the one custom route, because closing has to reconcile
 * every line's variance, optionally move stock, and audit, all in a single
 * transaction, and because `stock_counts.status` cannot be set through the
 * collection API at all (see the migration this ships with) - so this
 * route is the only way a count actually closes.
 *
 * "Scanned but not expected" (docs/api-contract.md) is `expected_qty = 0`
 * and `scanned_qty > 0`: PocketBase's plain number fields have no null
 * state (their zero value is 0 - see packages/shared/src/pricing.ts's own
 * note on the same PocketBase behaviour), so a line nobody expected to see
 * reads the same as a line genuinely counted at zero, which is exactly
 * "found something that was not on the list".
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

/**
 * Only one count may be open per location at a time (a partial unique index
 * on `stock_counts (location) WHERE status = 'open'` -
 * 1789820220_stock_counts_one_open.js): the counter app already offers to
 * resume an open count rather than start a second one, and this is what
 * makes that rule real rather than merely a UI convention. A friendly
 * pre-check first (the ordinary case: nobody is racing), then the same
 * unique-violation safety net cash.pb.js's cash-sessions/open route uses,
 * for the moment two staff members start a count on the same location at
 * once and only the index itself catches it.
 */
onRecordCreateRequest((e) => {
  if (e.record.getString("status") !== "open") {
    e.next();
    return;
  }

  const ALREADY_OPEN =
    "A count of this location is already open. Carry on with it or close it first.";

  /** A unique-index collision, whichever shape PocketBase reports it in - same check as cash.pb.js's. */
  function isUniqueViolation(err) {
    const text = String((err && err.message) || err || "");
    return /value must be unique/i.test(text) || /unique constraint/i.test(text);
  }

  // The index is a plain `(location) WHERE status = 'open'`, with no
  // separate carve-out for a blank location - two counts opened with no
  // location picked at all collide on it exactly the same as two opened
  // against the same real location, so this check does not special-case
  // an empty locationId either.
  const locationId = e.record.getString("location");
  let existing = null;
  try {
    existing = e.app.findFirstRecordByFilter("stock_counts", "location = {:location} && status = 'open'", {
      location: locationId,
    });
  } catch (err) {
    existing = null;
  }
  if (existing) {
    throw e.error(409, ALREADY_OPEN, null);
  }

  try {
    e.next();
  } catch (err) {
    if (isUniqueViolation(err)) throw e.error(409, ALREADY_OPEN, null);
    throw err;
  }
}, "stock_counts");

routerAdd(
  "POST",
  "/api/vault/stock-counts/{id}/close",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);
    const countId = e.request.pathValue("id");

    let count = null;
    try {
      count = e.app.findRecordById("stock_counts", countId);
    } catch (err) {
      throw e.notFoundError("Stock count not found. Check the id.", null);
    }
    if (count.getString("status") === "closed") {
      throw e.error(409, "That stock count is already closed.", null);
    }

    const body = util.body(e);
    const moveUnexpected = util.asBool(body.move_unexpected);
    const locationId = count.getString("location");

    let lines = [];
    try {
      lines = e.app.findRecordsByFilter("stock_count_lines", "stock_count = {:id}", "", 0, 0, {
        id: countId,
      });
    } catch (err) {
      lines = [];
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const liveCount = txApp.findRecordById("stock_counts", countId);
        if (liveCount.getString("status") === "closed") {
          halt = { status: 409, message: "That stock count is already closed." };
          throw new Error(halt.message);
        }

        const movedItemIds = [];
        for (let i = 0; i < lines.length; i++) {
          const line = txApp.findRecordById("stock_count_lines", lines[i].id);
          const expectedQty = line.getInt("expected_qty");
          const scannedQty = line.getInt("scanned_qty");
          line.set("variance", scannedQty - expectedQty);
          txApp.save(line);

          const scannedButNotExpected = expectedQty === 0 && scannedQty > 0;
          if (moveUnexpected && scannedButNotExpected && locationId) {
            const itemId = line.getString("item");
            if (itemId) {
              try {
                const item = txApp.findRecordById("items", itemId);
                item.set("location", locationId);
                txApp.save(item);
                movedItemIds.push(itemId);
              } catch (err) {
                // The item behind this line has since been deleted or sold
                // off - nothing to move, and not a reason to fail the close.
              }
            }
          }
        }

        const closedAt = util.nowIso();
        liveCount.set("status", "closed");
        liveCount.set("closed_by", staff.id);
        liveCount.set("closed_at", closedAt);
        txApp.save(liveCount);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "stock_count_close",
          collection: "stock_counts",
          record: countId,
          meta: { lines: lines.length, moved_items: movedItemIds },
          ip: e.realIP(),
        });

        result = {
          stock_count: {
            id: countId,
            status: "closed",
            closed_by: staff.id,
            closed_at: closedAt,
          },
          lines: lines.length,
          moved_items: movedItemIds,
        };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);
