/// <reference path="../pb_data/types.d.ts" />

/**
 * till.pb.js - till sessions, cashing up and the drawer.
 *
 *   POST /api/vault/till/open          (till_open)
 *   GET  /api/vault/till/current       (staff; ?running=0 skips the running report)
 *   POST /api/vault/till/x             (x_report)
 *   POST /api/vault/till/z             (z_report)
 *   GET  /api/vault/till/reports       (x_report)
 *   GET  /api/vault/till/reports/{id}  (x_report)
 *   POST /api/vault/till/movement      (paid_in_out; z_report for an adjustment)
 *   POST /api/vault/till/no-sale       (no_sale)
 *   POST /api/vault/till/void          (void_line)
 *
 * docs/api-contract-epos.md, section 3. Every route takes an optional
 * `register` and falls back to the default register (lib/registers.js);
 * every route but `open` and the reads needs an open session on it.
 *
 * Each route checks in the same order: the register, the session, the
 * request itself, the state that could refuse it (a parked ticket, an empty
 * drawer), and only then the capability, so a manager is never called over
 * to approve something that was going to be refused anyway. The writes go
 * in one `runInTransaction` with every write through `txApp`, re-checking
 * what has to be atomic (the session is still open, the drawer still holds
 * enough) and carrying a refusal out in a `halt` object, as sales.pb.js
 * does. An override is spent (`perms.consume`) and logged as an `override`
 * till event inside that same transaction, and the audit row names the
 * approver (`perms.auditMeta`).
 *
 * Every figure on an X or a Z comes from the shared `buildTillReport`
 * (packages/shared/src/till.ts) through lib/till.js. A Z report is never
 * changed or deleted, by anybody: the hooks at the foot of this file refuse
 * it at the record level, beneath the collection rules (which are already
 * null for every write).
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/till/open
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/open",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);
    const till = require(`${__hooks}/lib/shared/till.js`);

    const ALREADY_OPEN = "The till is already open. Close it with a Z report first.";

    const staff = perms.caller(e);
    const body = util.body(e);
    const register = tillLib.registerFor(e, util.asStr(body.register));

    // With counts the float is their total and `float` is ignored; with
    // neither the float is 0. An empty `{}` is no count at all.
    const rawCounts = tillLib.plain(body.counts);
    const countsSent =
      till.hasCounts(rawCounts) ||
      (rawCounts !== undefined && rawCounts !== null && (typeof rawCounts !== "object" || Array.isArray(rawCounts)));
    let counts = null;
    let float = 0;
    if (countsSent) {
      const parsed = till.parseDenominationCounts(rawCounts);
      if (!parsed.ok) throw e.badRequestError(parsed.message, null);
      counts = parsed.counts;
      float = till.denominationTotal(counts);
    } else {
      const given = tillLib.pence(body.float);
      if (!given.ok || given.value < 0) {
        throw e.badRequestError("Enter the float as a whole number of pence, 0 or more.", null);
      }
      float = given.value;
    }

    if (tillLib.openSession(e.app, register.id)) {
      throw e.error(409, ALREADY_OPEN, null);
    }

    const grant = perms.check(e, "till_open");
    if (!grant.ok) return perms.refuse(e, grant);

    // The read above is only the friendly refusal. cash_sessions carries a
    // partial unique index over (register) WHERE closed_at = '', so two
    // devices opening the same till at once collide on the index rather
    // than both winning (as cash.pb.js).
    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        if (tillLib.openSession(txApp, register.id)) {
          halt = { status: 409, message: ALREADY_OPEN };
          throw new Error(halt.message);
        }
        halt = tillLib.consume(txApp, grant, "till_open:" + register.id);
        if (halt) throw new Error(halt.message);

        const session = new Record(txApp.findCollectionByNameOrId("cash_sessions"));
        session.set("register", register.id);
        session.set("opened_by", staff.id);
        session.set("float", float);
        if (counts) session.set("opening_counts", counts);
        txApp.save(session);

        perms.logOverrides(txApp, grant, {
          register: register.id,
          session: session.id,
          amount: float,
          used_for: "till_open",
        });

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "till_open",
          collection: "cash_sessions",
          record: session.id,
          meta: {
            register: register.id,
            float: float,
            counted: !!counts,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });

        result = { session: tillLib.sessionShape(txApp, session, register, {}) };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      if (tillLib.isUniqueViolation(err)) throw e.error(409, ALREADY_OPEN, null);
      throw err;
    }

    return e.json(201, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/current?register=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/current",
  (e) => {
    const perms = require(`${__hooks}/lib/permissions.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);

    const staff = perms.caller(e);
    const register = tillLib.registerFor(e, tillLib.query(e, "register"));
    const session = tillLib.openSession(e.app, register.id);
    const cache = {};

    // `running` is what an X would say right now, unnumbered and unsaved,
    // so cashing up can show it before anything is committed. The till
    // screen polls this only to know whether the till is open, and asks
    // with `?running=0` to skip building it.
    const wantRunning = tillLib.query(e, "running") !== "0";
    return e.json(200, {
      register: tillLib.registerRef(register),
      session: session ? tillLib.sessionShape(e.app, session, register, cache) : null,
      running: session && wantRunning
        ? tillLib.buildReport(e.app, session, register, {
            type: "x",
            number: 0,
            id: "",
            created: tillLib.now(),
            createdBy: tillLib.staffRef(e.app, staff.id, cache),
            cache: cache,
          })
        : null,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/till/x
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/x",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const counters = require(`${__hooks}/lib/counters.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);

    const staff = perms.caller(e);
    const body = util.body(e);
    const register = tillLib.registerFor(e, util.asStr(body.register));
    const session = tillLib.openSession(e.app, register.id);
    if (!session) throw e.error(409, tillLib.NOT_OPEN, null);

    const grant = perms.check(e, "x_report");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("cash_sessions", session.id);
        if (live.getString("closed_at")) {
          halt = { status: 409, message: tillLib.NOT_OPEN };
          throw new Error(halt.message);
        }
        halt = tillLib.consume(txApp, grant, "x_report:" + live.id);
        if (halt) throw new Error(halt.message);
        perms.logOverrides(txApp, grant, { register: register.id, session: live.id, used_for: "x_report" });

        const cache = {};
        const report = tillLib.buildReport(txApp, live, register, {
          type: "x",
          number: counters.nextValue(txApp, "x_report"),
          id: tillLib.newId(),
          created: tillLib.now(),
          createdBy: tillLib.staffRef(txApp, staff.id, cache),
          cache: cache,
        });
        tillLib.saveReport(txApp, register, live, report);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "till_x_report",
          collection: "till_reports",
          record: report.id,
          meta: {
            number: report.number,
            register: register.id,
            session: live.id,
            net: report.sales.net,
            expected: report.cash.expected,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });

        result = { report: report };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(201, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/till/z
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/z",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const counters = require(`${__hooks}/lib/counters.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);
    const till = require(`${__hooks}/lib/shared/till.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const CARD_TOTAL = "Enter the Tide card total for today from the Tide app.";
    const BANK_DROP_REASON = "Bank drop at cashing up";

    const staff = perms.caller(e);
    const body = util.body(e);
    const register = tillLib.registerFor(e, util.asStr(body.register));
    const registerName = register.getString("name");
    const session = tillLib.openSession(e.app, register.id);
    if (!session) throw e.error(409, tillLib.NOT_OPEN, null);

    // The blind count is of the whole drawer. Staff then take the bank drop,
    // when there is one, out of what they counted: it is written as a
    // movement first, so expected is after the drop, and the report's
    // counted figure is the count less the drop (lib/shared/till.js
    // countedAfterDrop). The variance is the same either side of the drop.
    const rawCounts = tillLib.plain(body.counts);
    if (!till.hasCounts(rawCounts)) {
      throw e.badRequestError("Count the drawer before closing the till.", null);
    }
    const parsed = till.parseDenominationCounts(rawCounts);
    if (!parsed.ok) throw e.badRequestError(parsed.message, null);
    const counts = parsed.counts;

    const reportedIn = tillLib.pence(body.card_reported_total);
    if (!reportedIn.ok) {
      throw e.badRequestError("Enter the Tide card total as a whole number of pence.", null);
    }
    const reported = reportedIn.given ? reportedIn.value : null;

    const dropIn = tillLib.pence(body.bank_drop);
    if (!dropIn.ok || dropIn.value < 0) {
      throw e.badRequestError("Enter the bank drop as a whole number of pence, 0 or more.", null);
    }
    const bankDrop = dropIn.value;
    const countedTotal = till.denominationTotal(counts);
    if (bankDrop > countedTotal) {
      throw e.badRequestError(`You cannot bank more than the ${money.formatGBP(countedTotal)} you counted.`, null);
    }

    const notes = util.asStr(body.notes);
    if (notes.length > 2000) {
      throw e.badRequestError("Keep the notes to 2,000 characters.", null);
    }

    if (reported === null && tillLib.zRequiresCardTotal(e.app) && tillLib.tookCard(e.app, session.id)) {
      throw e.badRequestError(CARD_TOTAL, null);
    }

    const parked = tillLib.parkedCount(e.app, register.id);
    if (parked > 0) {
      throw e.error(409, till.parkedTicketsMessage(parked, registerName), null);
    }

    const grant = perms.check(e, "z_report");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("cash_sessions", session.id);
        if (live.getString("closed_at")) {
          halt = { status: 409, message: tillLib.NOT_OPEN };
          throw new Error(halt.message);
        }
        // A ticket parked, or a card sale taken, since the checks above.
        const liveParked = tillLib.parkedCount(txApp, register.id);
        if (liveParked > 0) {
          halt = { status: 409, message: till.parkedTicketsMessage(liveParked, registerName) };
          throw new Error(halt.message);
        }
        if (reported === null && tillLib.zRequiresCardTotal(txApp) && tillLib.tookCard(txApp, live.id)) {
          halt = { status: 400, message: CARD_TOTAL };
          throw new Error(halt.message);
        }
        halt = tillLib.consume(txApp, grant, "z_report:" + live.id);
        if (halt) throw new Error(halt.message);
        perms.logOverrides(txApp, grant, { register: register.id, session: live.id, used_for: "z_report" });

        // 1. The bank drop, taken from the counted cash, as a movement, so
        //    the report and the expected figure both see it.
        if (bankDrop > 0) {
          const drop = new Record(txApp.findCollectionByNameOrId("cash_movements"));
          drop.set("session", live.id);
          drop.set("type", "bank_drop");
          drop.set("amount", -bankDrop);
          drop.set("reason", BANK_DROP_REASON);
          drop.set("staff", staff.id);
          if (grant.approver) drop.set("approver", grant.approver.id);
          txApp.save(drop);
        }

        // 2. The report, from the session's records, numbered and saved.
        const cache = {};
        const report = tillLib.buildReport(txApp, live, register, {
          type: "z",
          number: counters.nextValue(txApp, "z_report"),
          id: tillLib.newId(),
          created: tillLib.now(),
          createdBy: tillLib.staffRef(txApp, staff.id, cache),
          cache: cache,
          close: { counts: counts, bank_drop: bankDrop, card_reported_total: reported, notes: notes },
        });
        tillLib.saveReport(txApp, register, live, report);

        // 3. The session closes on the report's own figures. A session from
        //    before the EPOS schema with no register belongs to the default
        //    register (lib/registers.js) and is stamped with it, so the
        //    closed record and its Z name the same till.
        if (!live.getString("register")) live.set("register", register.id);
        live.set("closed_by", staff.id);
        live.set("closed_at", report.created);
        live.set("expected", report.cash.expected);
        live.set("counted", report.cash.counted);
        live.set("variance", report.cash.variance);
        live.set("closing_counts", counts);
        live.set("card_till_total", report.card.till_total);
        live.set("card_reported_total", reported === null ? 0 : reported);
        live.set("card_variance", report.card.variance === null ? 0 : report.card.variance);
        live.set("z_report", report.id);
        if (notes) live.set("notes", notes);
        txApp.save(live);

        const settings = util.settings(txApp);
        const alertAt = settings ? settings.getInt("cash_variance_alert") : 0;

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "till_z_report",
          collection: "till_reports",
          record: report.id,
          meta: {
            number: report.number,
            register: register.id,
            session: live.id,
            net: report.sales.net,
            expected: report.cash.expected,
            counted: report.cash.counted,
            variance: report.cash.variance,
            variance_alert: alertAt > 0 && Math.abs(report.cash.variance) > alertAt,
            card_till_total: report.card.till_total,
            card_reported_total: reported,
            card_variance: report.card.variance,
            bank_drop: bankDrop,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });

        result = { report: report, session: tillLib.sessionShape(txApp, live, register, cache) };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(201, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/reports?register=&type=&page=&per_page=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/reports",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);

    perms.caller(e);

    // A filter, not a target: with no register the history is every
    // register's, and a switched-off register's reports stay readable.
    const registerId = tillLib.query(e, "register");
    let register = null;
    if (registerId) {
      try {
        register = e.app.findRecordById("registers", registerId);
      } catch (err) {
        throw e.notFoundError("That register was not found.", null);
      }
    }
    const type = tillLib.query(e, "type");
    if (type && type !== "x" && type !== "z") {
      throw e.badRequestError("Choose x or z for the report type.", null);
    }
    const page = Math.max(1, util.asInt(tillLib.query(e, "page"), 1));
    const perPage = Math.min(100, Math.max(1, util.asInt(tillLib.query(e, "per_page"), 20)));

    const grant = perms.check(e, "x_report");
    if (!grant.ok) return perms.refuse(e, grant);
    const logOn = register || registers.defaultRegister(e.app);
    const openOn = logOn ? tillLib.openSession(e.app, logOn.id) : null;
    const spent = tillLib.consumeForRead(e.app, grant, {
      register: logOn ? logOn.id : "",
      session: openOn ? openOn.id : "",
      used_for: "till_reports",
    });
    if (spent) throw e.error(spent.status, spent.message, null);

    const parts = [];
    const params = {};
    const pairs = {};
    if (register) {
      parts.push("register = {:register}");
      params.register = register.id;
      pairs.register = register.id;
    }
    if (type) {
      parts.push("type = {:type}");
      params.type = type;
      pairs.type = type;
    }
    const filter = parts.length ? parts.join(" && ") : "id != ''";

    const records = e.app.findRecordsByFilter(
      "till_reports",
      filter,
      "-created,-number",
      perPage,
      (page - 1) * perPage,
      params
    );
    const total = parts.length
      ? e.app.countRecords("till_reports", $dbx.hashExp(pairs))
      : e.app.countRecords("till_reports");

    const cache = {};
    const items = [];
    for (let i = 0; i < records.length; i++) {
      if (records[i]) items.push(tillLib.summaryOf(e.app, records[i], cache));
    }

    return e.json(200, { items: items, page: page, per_page: perPage, total: total });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/reports/{id}
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/reports/{id}",
  (e) => {
    const perms = require(`${__hooks}/lib/permissions.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);

    perms.caller(e);

    let record = null;
    try {
      record = e.app.findRecordById("till_reports", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That report was not found. Check the list and try again.", null);
    }

    const grant = perms.check(e, "x_report");
    if (!grant.ok) return perms.refuse(e, grant);
    const spent = tillLib.consumeForRead(e.app, grant, {
      register: record.getString("register"),
      session: record.getString("session"),
      used_for: "till_report:" + record.id,
    });
    if (spent) throw e.error(spent.status, spent.message, null);

    return e.json(200, { report: tillLib.reportOf(record) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/till/movement
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/movement",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);
    const till = require(`${__hooks}/lib/shared/till.js`);

    const AUDIT_ACTIONS = {
      paid_in: "cash_paid_in",
      paid_out: "cash_paid_out",
      bank_drop: "cash_bank_drop",
      adjustment: "cash_adjustment",
    };

    const staff = perms.caller(e);
    const body = util.body(e);
    const register = tillLib.registerFor(e, util.asStr(body.register));
    const session = tillLib.openSession(e.app, register.id);
    if (!session) throw e.error(409, tillLib.NOT_OPEN, null);

    const type = util.asStr(body.type);
    if (!till.isTillMovementType(type)) {
      throw e.badRequestError("Choose paid in, paid out, bank drop or adjustment.", null);
    }
    // Paid in, paid out and a bank drop take an amount above zero and get
    // their sign from the type; an adjustment carries its own sign.
    const amountIn = tillLib.pence(body.amount);
    if (!amountIn.given || !amountIn.ok || (type === "adjustment" ? amountIn.value === 0 : amountIn.value <= 0)) {
      throw e.badRequestError(
        type === "adjustment"
          ? "Enter the adjustment in pence, above or below £0.00."
          : "Enter an amount above £0.00, in pence.",
        null
      );
    }
    const reason = util.asStr(body.reason);
    if (!reason) throw e.badRequestError("Say what the money was for.", null);
    if (reason.length > 300) throw e.badRequestError("Keep the reason to 300 characters.", null);

    const amount = till.signedMovementAmount(type, amountIn.value);
    const expected = util.sessionExpected(e.app, session);
    if (till.takesDrawerBelowZero(expected, amount)) {
      throw e.error(409, tillLib.drawerMessage(expected), null);
    }

    const grant = perms.check(e, type === "adjustment" ? "z_report" : "paid_in_out");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let movement = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("cash_sessions", session.id);
        if (live.getString("closed_at")) {
          halt = { status: 409, message: tillLib.NOT_OPEN };
          throw new Error(halt.message);
        }
        // Two paid outs at once must not both take the last of the drawer.
        const liveExpected = util.sessionExpected(txApp, live);
        if (till.takesDrawerBelowZero(liveExpected, amount)) {
          halt = { status: 409, message: tillLib.drawerMessage(liveExpected) };
          throw new Error(halt.message);
        }
        halt = tillLib.consume(txApp, grant, type + ":" + live.id);
        if (halt) throw new Error(halt.message);

        movement = new Record(txApp.findCollectionByNameOrId("cash_movements"));
        movement.set("session", live.id);
        movement.set("type", type);
        movement.set("amount", amount);
        movement.set("reason", reason);
        movement.set("staff", staff.id);
        if (grant.approver) movement.set("approver", grant.approver.id);
        txApp.save(movement);

        perms.logOverrides(txApp, grant, {
          register: register.id,
          session: live.id,
          amount: amount,
          used_for: type + ":" + movement.id,
        });

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: AUDIT_ACTIONS[type],
          collection: "cash_movements",
          record: movement.id,
          meta: {
            register: register.id,
            session: live.id,
            type: type,
            amount: amount,
            expected_after: liveExpected + amount,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    // After the commit: money in or out of the drawer opens it. An
    // adjustment corrects the figure and moves no money.
    const printJob = type === "adjustment" ? null : tillLib.kickDrawer(e.app, register.id, staff.id, movement.id);

    return e.json(201, {
      movement: tillLib.movementShape(e.app, movement, register.id, {}),
      print_job: printJob,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/till/no-sale
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/no-sale",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);

    const staff = perms.caller(e);
    const body = util.body(e);
    const register = tillLib.registerFor(e, util.asStr(body.register));
    const session = tillLib.openSession(e.app, register.id);
    if (!session) throw e.error(409, tillLib.NOT_OPEN, null);

    const reason = util.asStr(body.reason);
    if (!reason) throw e.badRequestError("Say why the drawer needs opening.", null);
    if (reason.length > 300) throw e.badRequestError("Keep the reason to 300 characters.", null);

    const grant = perms.check(e, "no_sale");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let event = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("cash_sessions", session.id);
        if (live.getString("closed_at")) {
          halt = { status: 409, message: tillLib.NOT_OPEN };
          throw new Error(halt.message);
        }
        halt = tillLib.consume(txApp, grant, "no_sale:" + live.id);
        if (halt) throw new Error(halt.message);

        event = new Record(txApp.findCollectionByNameOrId("till_events"));
        event.set("register", register.id);
        event.set("session", live.id);
        event.set("kind", "no_sale");
        event.set("amount", 0);
        event.set("detail", { reason: reason });
        event.set("staff", staff.id);
        if (grant.approver) event.set("approver", grant.approver.id);
        txApp.save(event);

        perms.logOverrides(txApp, grant, {
          register: register.id,
          session: live.id,
          amount: 0,
          used_for: "no_sale:" + event.id,
        });

        // The reason is free text and stays on the event, not in audit_log.
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "till_no_sale",
          collection: "till_events",
          record: event.id,
          meta: {
            register: register.id,
            session: live.id,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    const printJob = tillLib.kickDrawer(e.app, register.id, staff.id, event.id);

    return e.json(201, { event: tillLib.eventShape(e.app, event, {}), print_job: printJob });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/till/void
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/void",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);

    const MAX_LINES = 100;
    const LINE_PROBLEM = "Each removed line needs a title, a quantity of 1 or more and an amount of £0.00 or more.";

    const staff = perms.caller(e);
    const body = util.body(e);
    const register = tillLib.registerFor(e, util.asStr(body.register));
    const session = tillLib.openSession(e.app, register.id);
    if (!session) throw e.error(409, tillLib.NOT_OPEN, null);

    // Lines taken off a ticket before it was paid: the value of each is what
    // the line came to (its quantity at its price), in pence.
    const ticket = util.asBool(body.ticket);
    const rawLines = tillLib.plain(body.lines);
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      throw e.badRequestError("List the lines that were taken off the ticket.", null);
    }
    if (rawLines.length > MAX_LINES) {
      throw e.badRequestError("Void at most 100 lines at a time.", null);
    }
    const lines = [];
    let total = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw e.badRequestError(LINE_PROBLEM, null);
      const title = util.asStr(raw.title).slice(0, 300);
      const qty = tillLib.pence(raw.qty);
      const amount = tillLib.pence(raw.amount);
      const qtyOk = qty.given && qty.ok && qty.value >= 1 && qty.value <= 100000;
      const amountOk = amount.given && amount.ok && amount.value >= 0;
      if (!title || !qtyOk || !amountOk) throw e.badRequestError(LINE_PROBLEM, null);
      lines.push({ title: title, qty: qty.value, amount: amount.value });
      total += amount.value;
    }

    const grant = perms.check(e, "void_line");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    const events = [];
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("cash_sessions", session.id);
        if (live.getString("closed_at")) {
          halt = { status: 409, message: tillLib.NOT_OPEN };
          throw new Error(halt.message);
        }
        halt = tillLib.consume(txApp, grant, "void:" + live.id);
        if (halt) throw new Error(halt.message);

        const collection = txApp.findCollectionByNameOrId("till_events");
        function write(kind, amount, detail) {
          const row = new Record(collection);
          row.set("register", register.id);
          row.set("session", live.id);
          row.set("kind", kind);
          row.set("amount", amount);
          row.set("detail", detail);
          row.set("staff", staff.id);
          if (grant.approver) row.set("approver", grant.approver.id);
          txApp.save(row);
          events.push(row);
        }

        // A whole ticket voided is one event carrying its lines; single
        // lines are one event each, as the sale route writes `voided`.
        if (ticket) {
          write("void_ticket", total, { lines: lines });
        } else {
          for (let i = 0; i < lines.length; i++) {
            write("void_line", lines[i].amount, { title: lines[i].title, qty: lines[i].qty });
          }
        }

        perms.logOverrides(txApp, grant, {
          register: register.id,
          session: live.id,
          amount: total,
          used_for: "void:" + events[0].id,
        });

        const ids = [];
        for (let i = 0; i < events.length; i++) ids.push(events[i].id);
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "till_void",
          collection: "till_events",
          record: events[0].id,
          meta: {
            register: register.id,
            session: live.id,
            ticket: ticket,
            lines: lines.length,
            total: total,
            events: ids,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    const cache = {};
    const shaped = [];
    for (let i = 0; i < events.length; i++) shaped.push(tillLib.eventShape(e.app, events[i], cache));
    return e.json(201, { events: shaped });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// A Z report is never changed or deleted (section 3). The collection rules
// already refuse every staff write; these refuse it beneath them, for a
// superuser and for any hook, so the numbered record of a day's takings
// stays as it was printed.
// ---------------------------------------------------------------------
onRecordUpdate((e) => {
  const original = e.record.original();
  if ((original && original.getString("type") === "z") || e.record.getString("type") === "z") {
    throw new ForbiddenError("A Z report cannot be changed or deleted.");
  }
  e.next();
}, "till_reports");

onRecordDelete((e) => {
  if (e.record.getString("type") === "z") {
    throw new ForbiddenError("A Z report cannot be changed or deleted.");
  }
  e.next();
}, "till_reports");
