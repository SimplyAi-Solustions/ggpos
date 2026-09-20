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
 * The handler runs in its own isolated goja context, so every require()
 * and helper lives inside the handler body - see pb/README.md.
 */
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
