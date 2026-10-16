/// <reference path="../pb_data/types.d.ts" />

/**
 * research.pb.js - research requests (docs/api-contract-launch.md,
 * section 5).
 *
 *   POST /api/vault/research                 (staff)  { query?, card?, retro_title?, item?, trade_in_line?, condition?, finish? }
 *   GET  /api/vault/research?status=         (staff)  also trade_in_line=, item=, card=, retro_title=, page=
 *   GET  /api/vault/research/{id}            (staff)
 *   POST /api/vault/research/{id}/claim      (staff)
 *   POST /api/vault/research/{id}/complete   (staff)  { result, comps: [{ price, currency, sold_at, url, title, condition }] }
 *   POST /api/vault/research/{id}/cancel     (staff)
 *
 * A request is asked for from a trade-in line, the item page or price
 * check by a member of staff, or by an agent itself; an agent (or a person)
 * claims it and completes it with the sold listings it found. Completing
 * writes each comp as a UK sold comp (lib/research.js), so it becomes the
 * line's first price source as a staff-entered comp does.
 *
 * A new request calls the agent webhook (settings.agent_webhook), signed,
 * after its own transaction commits and with a three second timeout, so a
 * sleeping agent is woken rather than polled and never fails the request
 * that asked. Asking again while a request about the same thing is still
 * open answers that one (200, `existing: true`) and wakes nobody twice.
 *
 * Every write is one transaction through txApp, re-reading the request's
 * status inside it, and audited under whoever made it, an agent included.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/research - ask for UK sold comps
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/research",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const research = require(`${__hooks}/lib/research.js`);
    const agents = require(`${__hooks}/lib/agents.js`);
    const shared = require(`${__hooks}/lib/shared/agents.js`);

    const caller = perms.caller(e);
    const resolved = research.resolve(e.app, util.body(e));
    if (!resolved.ok) throw e.error(resolved.status, resolved.message, null);
    const fields = resolved.fields;

    const twin = research.liveTwin(e.app, fields);
    if (twin) return e.json(200, { request: research.shape(e.app, twin), existing: true });

    let created = null;
    e.app.runInTransaction((txApp) => {
      const record = new Record(txApp.findCollectionByNameOrId("research_requests"));
      record.set("query", fields.query);
      record.set("card", fields.card);
      record.set("retro_title", fields.retro_title);
      record.set("item", fields.item);
      record.set("trade_in_line", fields.trade_in_line);
      record.set("condition", fields.condition);
      record.set("finish", fields.finish);
      record.set("status", "open");
      record.set("requested_by", caller.id);
      record.set("comps", []);
      txApp.save(record);
      created = record;

      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "research_requested",
        collection: "research_requests",
        record: record.id,
        meta: { record: record.id, card: fields.card, retro_title: fields.retro_title, item: fields.item, trade_in_line: fields.trade_in_line },
        ip: e.realIP(),
      });
    });

    const shaped = research.shape(e.app, created);
    // After the commit: the agent that answers can read the row at once.
    const sent = agents.sendWebhook(e.app, shared.RESEARCH_EVENT, shaped);
    if (sent.reason !== "off") {
      audit.writeAuditLog(e.app, {
        actor: caller.id,
        action: "research_webhook",
        collection: "research_requests",
        record: created.id,
        meta: { record: created.id, ok: sent.sent, status: sent.status },
        ip: e.realIP(),
      });
    }

    return e.json(201, { request: shaped });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/research?status=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/research",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const research = require(`${__hooks}/lib/research.js`);

    const PER_PAGE = 50;
    perms.caller(e);

    function queryParam(name) {
      let value = "";
      try {
        const info = e.requestInfo();
        value = util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        value = "";
      }
      return value;
    }

    // The same filter twice: as a PocketBase filter for the page, and as
    // query expressions for the count.
    const clauses = [];
    const params = {};
    const exprs = [];
    const status = queryParam("status");
    if (status) {
      const wanted = status.split(",").map((part) => part.trim()).filter(Boolean);
      const parts = [];
      for (let i = 0; i < wanted.length; i++) {
        if (research.STATUSES.indexOf(wanted[i]) < 0) throw e.badRequestError(research.SENTENCES.status, null);
        params[`s${i}`] = wanted[i];
        parts.push(`status = {:s${i}}`);
      }
      if (parts.length) {
        clauses.push(`(${parts.join(" || ")})`);
        exprs.push($dbx.in("status", ...wanted));
      }
    }
    const links = ["trade_in_line", "item", "card", "retro_title"];
    for (let i = 0; i < links.length; i++) {
      const value = queryParam(links[i]);
      if (value) {
        params[links[i]] = value;
        clauses.push(`${links[i]} = {:${links[i]}}`);
        const pair = {};
        pair[links[i]] = value;
        exprs.push($dbx.hashExp(pair));
      }
    }
    const page = Math.max(1, util.asInt(queryParam("page"), 1));
    const filter = clauses.length ? clauses.join(" && ") : "id != ''";

    const rows = e.app.findRecordsByFilter(
      "research_requests",
      filter,
      "-created,-id",
      PER_PAGE,
      (page - 1) * PER_PAGE,
      params
    );
    const total = e.app.countRecords("research_requests", ...exprs);
    const requests = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) requests.push(research.shape(e.app, rows[i]));
    }
    return e.json(200, { requests: requests, page: page, per_page: PER_PAGE, total: total });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/research/{id}
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/research/{id}",
  (e) => {
    const perms = require(`${__hooks}/lib/permissions.js`);
    const research = require(`${__hooks}/lib/research.js`);

    perms.caller(e);
    let record = null;
    try {
      record = e.app.findRecordById("research_requests", e.request.pathValue("id"));
    } catch (err) {
      record = null;
    }
    if (!record) throw e.notFoundError(research.SENTENCES.notFound, null);
    return e.json(200, { request: research.shape(e.app, record) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/research/{id}/claim
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/research/{id}/claim",
  (e) => {
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const research = require(`${__hooks}/lib/research.js`);

    const caller = perms.caller(e);
    const id = e.request.pathValue("id");
    let record = null;
    try {
      record = e.app.findRecordById("research_requests", id);
    } catch (err) {
      record = null;
    }
    if (!record) throw e.notFoundError(research.SENTENCES.notFound, null);
    // Claiming your own claim again is a no-op, so a retry is safe.
    if (record.getString("status") === "claimed" && record.getString("claimed_by") === caller.id) {
      return e.json(200, { request: research.shape(e.app, record) });
    }
    const early = research.stateRefusal(e.app, record, "claim");
    if (early) throw e.error(409, early, null);

    let halt = null;
    let saved = null;
    try {
      e.app.runInTransaction((txApp) => {
        const fresh = txApp.findRecordById("research_requests", id);
        if (fresh.getString("status") !== "open") {
          halt = { status: 409, message: research.stateRefusal(txApp, fresh, "claim") || research.SENTENCES.notFound };
          throw new Error(halt.message);
        }
        fresh.set("status", "claimed");
        fresh.set("claimed_by", caller.id);
        fresh.set("claimed_at", new Date().toISOString());
        txApp.save(fresh);
        saved = fresh;
        audit.writeAuditLog(txApp, {
          actor: caller.id,
          action: "research_claimed",
          collection: "research_requests",
          record: fresh.id,
          meta: { record: fresh.id },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, { request: research.shape(e.app, saved) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/research/{id}/complete   { result, comps }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/research/{id}/complete",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const research = require(`${__hooks}/lib/research.js`);

    const caller = perms.caller(e);
    const id = e.request.pathValue("id");
    let record = null;
    try {
      record = e.app.findRecordById("research_requests", id);
    } catch (err) {
      record = null;
    }
    if (!record) throw e.notFoundError(research.SENTENCES.notFound, null);

    function blocked(row) {
      const status = row.getString("status");
      if (status === "open") return "";
      if (status === "claimed" && row.getString("claimed_by") === caller.id) return "";
      return research.stateRefusal(e.app, row, "complete");
    }
    const early = blocked(record);
    if (early) throw e.error(409, early, null);

    const body = util.body(e);
    const result = typeof body.result === "string" ? body.result.trim() : "";
    if (result.length > 2000) throw e.badRequestError(research.SENTENCES.result, null);
    const cleaned = research.cleanComps(body.comps);
    if (!cleaned.ok) throw e.badRequestError(cleaned.message, null);

    let halt = null;
    let saved = null;
    let written = 0;
    try {
      e.app.runInTransaction((txApp) => {
        const fresh = txApp.findRecordById("research_requests", id);
        const refusal = blocked(fresh);
        if (refusal) {
          halt = { status: 409, message: refusal };
          throw new Error(halt.message);
        }
        written = research.writeComps(txApp, fresh, cleaned.comps, caller.id, e.realIP());
        const now = new Date().toISOString();
        if (!fresh.getString("claimed_by")) {
          fresh.set("claimed_by", caller.id);
          fresh.set("claimed_at", now);
        }
        fresh.set("status", "done");
        fresh.set("result", result);
        fresh.set("comps", research.storedComps(cleaned.comps));
        fresh.set("done_at", now);
        txApp.save(fresh);
        saved = fresh;
        audit.writeAuditLog(txApp, {
          actor: caller.id,
          action: "research_completed",
          collection: "research_requests",
          record: fresh.id,
          meta: { record: fresh.id, comps: cleaned.comps.length, written: written },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, { request: research.shape(e.app, saved), written: written });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/research/{id}/cancel
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/research/{id}/cancel",
  (e) => {
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const research = require(`${__hooks}/lib/research.js`);

    const caller = perms.caller(e);
    const id = e.request.pathValue("id");
    let record = null;
    try {
      record = e.app.findRecordById("research_requests", id);
    } catch (err) {
      record = null;
    }
    if (!record) throw e.notFoundError(research.SENTENCES.notFound, null);
    const early = research.stateRefusal(e.app, record, "cancel");
    if (early) throw e.error(409, early, null);

    let halt = null;
    let saved = null;
    try {
      e.app.runInTransaction((txApp) => {
        const fresh = txApp.findRecordById("research_requests", id);
        const refusal = research.stateRefusal(txApp, fresh, "cancel");
        if (refusal) {
          halt = { status: 409, message: refusal };
          throw new Error(halt.message);
        }
        fresh.set("status", "cancelled");
        txApp.save(fresh);
        saved = fresh;
        audit.writeAuditLog(txApp, {
          actor: caller.id,
          action: "research_cancelled",
          collection: "research_requests",
          record: fresh.id,
          meta: { record: fresh.id },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, { request: research.shape(e.app, saved) });
  },
  $apis.requireAuth("staff")
);
