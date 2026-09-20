/// <reference path="../pb_data/types.d.ts" />

/**
 * display.pb.js - the customer-facing display on the counter
 * (docs/PLAN.md, "Customer-facing display"; docs/api-contract.md's Phase 6
 * section).
 *
 *   POST /api/vault/display          (staff)
 *   POST /api/vault/display/accept   (staff, the kiosk's own session)
 *   POST /api/vault/display/clear    (staff)
 *
 * There is one `display_state` row and these three routes are the only
 * things that write it in anger; the tablet at `/display` and the buy-in
 * wizard both subscribe to that row over realtime rather than polling a
 * route. A customer token can neither read nor write it - the screen shows
 * whoever is at the counter right now, which is nobody's own record.
 *
 * What may go on the screen is decided in lib/display.js, not here: the
 * payload is rebuilt field by field from the shapes the contract names, a
 * payload carrying an identifier, an email or a phone number is refused
 * outright, and every publish expires fifteen minutes out so a basket left
 * on screen clears itself.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/display   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/display",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const displayLib = require(`${__hooks}/lib/display.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const body = util.body(e);
    const mode = util.asStr(body.mode) || "idle";
    const now = new Date();

    if (mode !== "idle" && mode !== "sale" && mode !== "buy_in") {
      throw e.badRequestError("Pick a display mode: idle, sale or buy_in.", null);
    }

    const sanitised = displayLib.sanitise(mode, body.payload);
    if (!sanitised.ok) {
      throw e.badRequestError(sanitised.message, null);
    }

    const token = $security.randomString(32);
    const expiresAt = new Date(now.getTime() + displayLib.TTL_MINUTES * 60000).toISOString();
    let result = null;

    e.app.runInTransaction((txApp) => {
      const row = displayLib.stateRow(txApp);
      row.set("mode", mode);
      row.set("payload", sanitised.payload);
      row.set("token", mode === "idle" ? "" : token);
      row.set("customer_accepted_at", "");
      row.set("updated_by", staff.id);
      row.set("expires_at", mode === "idle" ? "" : expiresAt);
      txApp.save(row);

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "display_publish",
        collection: "display_state",
        record: row.id,
        // Identifiers and counts only: nothing off the payload itself,
        // which is about a customer standing at the counter.
        meta: { mode: mode, lines: (sanitised.payload.lines || []).length },
        ip: e.realIP(),
      });

      result = { token: mode === "idle" ? "" : token, mode: mode, expires_at: mode === "idle" ? "" : expiresAt };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/display/accept   (staff - the tablet's own session)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/display/accept",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const displayLib = require(`${__hooks}/lib/display.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const body = util.body(e);
    const token = util.asStr(body.token);
    const now = new Date();

    if (!token) {
      throw e.badRequestError("The accept needs the token the display was published with.", null);
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const row = displayLib.stateRow(txApp);
        // A publish nobody dealt with inside fifteen minutes is cleared
        // before anything else is decided, so a stale token can never be
        // accepted after the fact.
        displayLib.clearIfStale(txApp, row, now);

        if (row.getString("mode") !== "buy_in") {
          halt = {
            status: 409,
            message: "There is no offer on the display to accept. Show the customer the offer again.",
          };
          throw new Error(halt.message);
        }
        if (row.getString("token") !== token) {
          halt = {
            status: 409,
            message: "The display has moved on since that offer. Show the customer the offer again.",
          };
          throw new Error(halt.message);
        }

        row.set("customer_accepted_at", now.toISOString());
        txApp.save(row);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "display_accept",
          collection: "display_state",
          record: row.id,
          meta: { mode: row.getString("mode") },
          ip: e.realIP(),
        });

        result = { accepted_at: row.getString("customer_accepted_at"), mode: row.getString("mode") };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/display/clear   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/display/clear",
  (e) => {
    const displayLib = require(`${__hooks}/lib/display.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    let result = null;

    e.app.runInTransaction((txApp) => {
      const row = displayLib.stateRow(txApp);
      displayLib.reset(txApp, row);
      row.set("updated_by", staff.id);
      txApp.save(row);

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "display_clear",
        collection: "display_state",
        record: row.id,
        meta: {},
        ip: e.realIP(),
      });

      result = { mode: "idle" };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);
