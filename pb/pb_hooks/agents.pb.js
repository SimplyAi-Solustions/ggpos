/// <reference path="../pb_data/types.d.ts" />

/**
 * agents.pb.js - read-only access for a watcher (docs/api-contract.md's
 * Phase 8 section).
 *
 *   GET /api/vault/agent/quotes?since=ISO          (agent)
 *   GET /api/vault/agent/guild-pending?since=ISO   (agent)
 *   agents auth hook                               (an inactive agent cannot sign in)
 *
 * `agents` is its own auth collection (password sign-in, created by an
 * admin only). No collection rule anywhere admits an agent token - every
 * staff rule names `staff`, every customer rule compares a customer id -
 * so these two routes are the whole of what one can read, and each carries
 * no personal data beyond a first name. Neither writes anything, and
 * neither is audited: a watcher polling every minute would otherwise bury
 * the audit log under its own reads.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

onRecordAuthRequest((e) => {
  if (!e.record.getBool("active")) {
    throw e.forbiddenError("This agent is switched off. Ask an admin to turn it back on.", null);
  }
  e.next();
}, "agents");

// ---------------------------------------------------------------------
// GET /api/vault/agent/quotes?since=ISO   (agent)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/agent/quotes",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);

    if (!e.auth.getBool("active")) {
      throw e.forbiddenError("This agent is switched off. Ask an admin to turn it back on.", null);
    }

    let since = "";
    try {
      since = util.asStr(e.request.url.query().get("since"));
    } catch (err) {
      since = "";
    }
    let cutoff = "";
    if (since) {
      const d = new Date(since);
      if (isNaN(d.getTime())) {
        throw e.badRequestError("The since value is not a date. Send an ISO 8601 time, for example 2026-10-06T09:00:00Z.", null);
      }
      cutoff = d.toISOString().replace("T", " ");
    }

    function firstName(customerId) {
      try {
        const name = e.app.findRecordById("customers", customerId).getString("name").trim();
        return name.split(/\s+/)[0] || "";
      } catch (err) {
        return "";
      }
    }

    let base = "";
    try {
      base = (e.app.settings().meta.appURL || "").replace(/\/+$/, "");
    } catch (err) {
      base = "";
    }

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "quotes",
        cutoff
          ? '(status = "submitted" || status = "reviewing") && created > {:cutoff}'
          : 'status = "submitted" || status = "reviewing"',
        "created",
        100,
        0,
        { cutoff: cutoff }
      );
    } catch (err) {
      rows = [];
    }

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const lines = util.jsonField(row, "lines", []);
      const photos = row.get("photos");
      out.push({
        id: row.id,
        created: row.getString("created"),
        status: row.getString("status"),
        drop_off: row.getString("drop_off") || "in_store",
        line_count: Array.isArray(lines) ? lines.length : 0,
        photo_count: photos && photos.length ? photos.length : 0,
        customer_first_name: firstName(row.getString("customer")),
        link: `${base}/counter/quotes/${row.id}`,
      });
    }
    return e.json(200, { quotes: out });
  },
  $apis.requireAuth("agents")
);

// ---------------------------------------------------------------------
// GET /api/vault/agent/guild-pending?since=ISO   (agent)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/agent/guild-pending",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);

    if (!e.auth.getBool("active")) {
      throw e.forbiddenError("This agent is switched off. Ask an admin to turn it back on.", null);
    }

    let since = "";
    try {
      since = util.asStr(e.request.url.query().get("since"));
    } catch (err) {
      since = "";
    }
    let cutoff = "";
    if (since) {
      const d = new Date(since);
      if (isNaN(d.getTime())) {
        throw e.badRequestError("The since value is not a date. Send an ISO 8601 time, for example 2026-10-06T09:00:00Z.", null);
      }
      cutoff = d.toISOString().replace("T", " ");
    }

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "memberships",
        cutoff ? 'status = "pending" && created > {:cutoff}' : 'status = "pending"',
        "created",
        100,
        0,
        { cutoff: cutoff }
      );
    } catch (err) {
      rows = [];
    }

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      let tierName = "";
      try {
        tierName = e.app.findRecordById("loyalty_tiers", row.getString("tier")).getString("name");
      } catch (err) {
        tierName = "";
      }
      let first = "";
      try {
        first = e.app.findRecordById("customers", row.getString("customer")).getString("name").trim().split(/\s+/)[0] || "";
      } catch (err) {
        first = "";
      }
      out.push({ id: row.id, created: row.getString("created"), tier: tierName, customer_first_name: first });
    }
    return e.json(200, { pending: out });
  },
  $apis.requireAuth("agents")
);
