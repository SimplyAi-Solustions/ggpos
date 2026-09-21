/// <reference path="../pb_data/types.d.ts" />

/**
 * cash.pb.js - the till drawer.
 *
 *   POST /api/vault/cash-sessions/open
 *   GET  /api/vault/cash-sessions/current
 *   POST /api/vault/cash-sessions/{id}/close
 *
 * docs/api-contract.md ("Cash sessions"). One session is open at a time;
 * no cash payout and no cash sale happens without one (docs/PLAN.md,
 * "Core flows and rules > Cash").
 *
 * cash_movements.amount is signed, so the expected drawer total is the
 * opening float plus every movement - see lib/vaultutil.js.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/cash-sessions/open
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cash-sessions/open",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const body = util.body(e);
    const float = util.asInt(body.float, 0);
    if (float < 0) {
      throw e.badRequestError("The float cannot be negative. Count it again.", null);
    }

    const ALREADY_OPEN = "A cash session is already open. Close it before opening another.";

    /** A unique-index collision, whichever shape PocketBase reports it in. */
    function isUniqueViolation(err) {
      const text = String((err && err.message) || err || "");
      return /value must be unique/i.test(text) || /unique constraint/i.test(text);
    }

    const existing = util.openCashSession(e.app);
    if (existing) {
      throw e.error(409, ALREADY_OPEN, null);
    }

    // The read above is only the friendly refusal. The write goes in a
    // transaction, and cash_sessions carries a partial unique index over an
    // empty closed_at, so two staff members opening a session at the same
    // moment collide on the index instead of both winning.
    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        if (util.openCashSession(txApp)) {
          halt = { status: 409, message: ALREADY_OPEN };
          throw new Error(halt.message);
        }

        const session = new Record(txApp.findCollectionByNameOrId("cash_sessions"), {
          opened_by: staff.id,
          float: float,
        });
        txApp.save(session);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "cash_session_open",
          collection: "cash_sessions",
          record: session.id,
          meta: { float: float },
          ip: e.realIP(),
        });

        result = {
          session: {
            id: session.id,
            opened_by: session.getString("opened_by"),
            opened_at: session.getString("opened_at"),
            float: float,
          },
          expected: float,
          movements: [],
        };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      if (isUniqueViolation(err)) throw e.error(409, ALREADY_OPEN, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/cash-sessions/current
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/cash-sessions/current",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);

    const session = util.openCashSession(e.app);
    if (!session) {
      return e.json(200, { session: null, expected: 0, movements: [] });
    }

    const rows = util.sessionMovements(e.app, session.id);
    const movements = [];
    let total = session.getInt("float");
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      total += rows[i].getInt("amount");
      movements.push({
        id: rows[i].id,
        type: rows[i].getString("type"),
        amount: rows[i].getInt("amount"),
        ref: rows[i].getString("ref"),
        staff: rows[i].getString("staff"),
        created: rows[i].getString("created"),
      });
    }

    return e.json(200, {
      session: {
        id: session.id,
        opened_by: session.getString("opened_by"),
        opened_at: session.getString("opened_at"),
        float: session.getInt("float"),
      },
      expected: total,
      movements: movements,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/cash-sessions/{id}/close
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cash-sessions/{id}/close",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const body = util.body(e);

    let session = null;
    try {
      session = e.app.findRecordById("cash_sessions", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That cash session was not found.", null);
    }
    if (session.getString("closed_at")) {
      throw e.error(409, "That cash session is already closed.", null);
    }

    const counted = util.asInt(body.counted, 0);
    if (counted < 0) {
      throw e.badRequestError("A counted total cannot be negative. Count it again.", null);
    }

    const expected = util.sessionExpected(e.app, session);
    const variance = counted - expected;

    session.set("expected", expected);
    session.set("counted", counted);
    session.set("variance", variance);
    session.set("closed_by", staff.id);
    session.set("closed_at", util.nowIso());
    const notes = util.asStr(body.notes);
    if (notes) session.set("notes", notes);
    e.app.save(session);

    const settings = util.settings(e.app);
    const alertAt = settings ? settings.getInt("cash_variance_alert") : 0;
    const overAlert = alertAt > 0 && Math.abs(variance) > alertAt;

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: overAlert ? "cash_session_variance" : "cash_session_close",
      collection: "cash_sessions",
      record: session.id,
      meta: {
        expected: expected,
        counted: counted,
        variance: variance,
        alert_at: alertAt,
      },
      ip: e.realIP(),
    });

    return e.json(200, {
      session: {
        id: session.id,
        opened_by: session.getString("opened_by"),
        opened_at: session.getString("opened_at"),
        float: session.getInt("float"),
        closed_by: session.getString("closed_by"),
        closed_at: session.getString("closed_at"),
        expected: expected,
        counted: counted,
        variance: variance,
        notes: session.getString("notes"),
      },
      expected: expected,
      variance: variance,
      variance_alert: overAlert,
    });
  },
  $apis.requireAuth("staff")
);
