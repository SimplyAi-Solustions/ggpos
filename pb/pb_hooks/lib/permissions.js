/**
 * Capabilities and manager overrides at the till
 * (docs/api-contract-epos.md, section 2, "Overrides").
 *
 * Each capability names the lowest role allowed to use it
 * (packages/shared/src/permissions.ts, through the generated copy in
 * lib/shared/permissions.js), overlaid with `settings.epos.permissions`.
 * A member of staff whose role lacks a capability can still do the thing if
 * the request carries a manager's override for it: a single-use token from
 * `POST /api/vault/till/override`, sent as
 * `X-GG-Override: <token>[,<token>...]`, issued to this caller for this
 * capability, unused and unexpired, by somebody who is still active and
 * still holds the capability.
 *
 * Usage in a route:
 *
 *   const perms = require(`${__hooks}/lib/permissions.js`);
 *   const grant = perms.check(e, "refund");
 *   if (!grant.ok) return perms.refuse(e, grant);
 *   ...
 *   $app.runInTransaction((txApp) => {
 *     perms.consume(txApp, grant, "refund:" + sale.id);  // throws if raced
 *     perms.logOverrides(txApp, grant, { register, session, amount, detail });
 *     ...
 *   });
 *
 * `checkAll(e, [caps])` is the same for an action that needs several at
 * once (a sale with a price override and a big discount); it refuses with
 * the first capability that is neither held nor approved, so the counter
 * asks for one approval at a time and retries with every token it holds.
 *
 * The refusal is a plain 403 body, not a thrown error, because it carries
 * `needs_override` and `capability` at the top level and PocketBase's own
 * errors only carry validation data:
 *   { "message": "A manager needs to approve this.", "needs_override": true, "capability": "refund" }
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var OVERRIDE_HEADER = "X-GG-Override";
var NEEDS_OVERRIDE = "A manager needs to approve this.";
var MAX_TOKENS = 5;

function shared() {
  return require(__hooks + "/lib/shared/permissions.js");
}

/** The permission table in force: defaults overlaid with settings.epos.permissions. */
function table(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var stored = {};
  var row = util.settings(app);
  if (row) {
    var epos = util.jsonField(row, "epos", null);
    if (epos && epos.permissions) stored = epos.permissions;
  }
  return shared().resolvePermissions(stored);
}

/** The signed-in staff member, active, or a thrown 401/403. */
function caller(e) {
  var auth = e.auth;
  if (!auth || auth.collection().name !== "staff") {
    throw e.unauthorizedError("Sign in as staff to do this.", null);
  }
  if (!auth.getBool("active")) {
    throw e.forbiddenError("This account is inactive. Ask an admin to reactivate it.", null);
  }
  return auth;
}

/** Whether a staff record holds a capability under a table. */
function holds(record, capability, perms) {
  if (!record || !record.getBool("active")) return false;
  return shared().can(record.getString("role"), capability, perms);
}

/** The override tokens on the request, at most five, trimmed. */
function tokens(e) {
  var raw = "";
  try {
    raw = e.request.header.get(OVERRIDE_HEADER) || "";
  } catch (err) {
    raw = "";
  }
  var out = [];
  var parts = String(raw).split(",");
  for (var i = 0; i < parts.length && out.length < MAX_TOKENS; i++) {
    var t = parts[i].trim();
    if (t && t.length <= 200) out.push(t);
  }
  return out;
}

/** sha256 hex of a token: what till_overrides stores. */
function hashToken(token) {
  return $security.sha256(token);
}

/**
 * A live override on this request for this caller and capability, or null.
 * Reads with the app it is given, so a transaction sees its own writes.
 */
function findOverride(app, e, by, capability, perms) {
  var list = tokens(e);
  var now = new Date();
  for (var i = 0; i < list.length; i++) {
    var row = null;
    try {
      row = app.findFirstRecordByFilter("till_overrides", "token_hash = {:h}", {
        h: hashToken(list[i]),
      });
    } catch (err) {
      row = null;
    }
    if (!row) continue;
    if (row.getString("capability") !== capability) continue;
    if (row.getString("requested_by") !== by.id) continue;
    if (row.getString("used_at")) continue;
    var expires = new Date(row.getString("expires_at").replace(" ", "T"));
    if (!(expires.getTime() > now.getTime())) continue;
    var approver = null;
    try {
      approver = app.findRecordById("staff", row.getString("approver"));
    } catch (err) {
      approver = null;
    }
    if (!holds(approver, capability, perms)) continue;
    return { override: row, approver: approver };
  }
  return null;
}

/**
 * Whether the caller may use a capability on this request.
 * @returns {{ok: true, by: any, capability: string, approver: any|null, override: any|null}
 *   | {ok: false, status: number, body: {message: string, needs_override: boolean, capability: string}}}
 * Throws a 401 or 403 when there is no active staff caller at all.
 */
function check(e, capability) {
  var by = caller(e);
  var perms = table(e.app);
  if (holds(by, capability, perms)) {
    return { ok: true, by: by, capability: capability, approver: null, override: null };
  }
  var found = findOverride(e.app, e, by, capability, perms);
  if (found) {
    return {
      ok: true,
      by: by,
      capability: capability,
      approver: found.approver,
      override: found.override,
    };
  }
  return {
    ok: false,
    status: 403,
    body: { message: NEEDS_OVERRIDE, needs_override: true, capability: capability },
  };
}

/**
 * Several capabilities at once. On success, `grants` holds one grant per
 * capability and `approvers` the distinct approvers' records.
 */
function checkAll(e, capabilities) {
  var grants = [];
  var approvers = [];
  var seen = {};
  for (var i = 0; i < capabilities.length; i++) {
    var g = check(e, capabilities[i]);
    if (!g.ok) return g;
    grants.push(g);
    if (g.approver && !seen[g.approver.id]) {
      seen[g.approver.id] = true;
      approvers.push(g.approver);
    }
  }
  return { ok: true, by: grants.length ? grants[0].by : caller(e), grants: grants, approvers: approvers };
}

/** The 403 for a refused check, as the route's response. */
function refuse(e, result) {
  return e.json(result.status || 403, result.body);
}

/** The grants inside a check() or checkAll() result. */
function grantsOf(result) {
  if (!result || !result.ok) return [];
  return result.grants ? result.grants : [result];
}

/**
 * Mark every override a result used, inside the caller's transaction. Throws
 * when one was used by a concurrent request in the meantime, which rolls the
 * whole action back. Returns the grants that used an override.
 */
function consume(txApp, result, usedFor) {
  var used = [];
  var list = grantsOf(result);
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    if (!g.override) continue;
    var fresh = txApp.findRecordById("till_overrides", g.override.id);
    if (fresh.getString("used_at")) {
      throw new Error("That approval has already been used. Ask for it again.");
    }
    fresh.set("used_at", new Date().toISOString());
    fresh.set("used_for", String(usedFor || "").slice(0, 120));
    txApp.save(fresh);
    used.push(g);
  }
  return used;
}

/**
 * One `override` till event per approval used, for the X and Z reports.
 * `ctx.register` is required (till_events.register); without one nothing is
 * written, so routes outside the till can call it unconditionally.
 */
function logOverrides(txApp, result, ctx) {
  ctx = ctx || {};
  if (!ctx.register) return;
  var list = grantsOf(result);
  var collection = null;
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    if (!g.override) continue;
    if (!collection) collection = txApp.findCollectionByNameOrId("till_events");
    var row = new Record(collection);
    row.set("register", ctx.register);
    if (ctx.session) row.set("session", ctx.session);
    row.set("kind", "override");
    row.set("amount", ctx.amount || 0);
    row.set("detail", {
      capability: g.capability,
      used_for: ctx.used_for || "",
      detail: ctx.detail || null,
    });
    row.set("staff", g.by.id);
    row.set("approver", g.approver ? g.approver.id : "");
    txApp.save(row);
  }
}

/** Names for an audit row: who did it and who approved it. */
function auditMeta(result) {
  var list = grantsOf(result);
  var approvals = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].approver) {
      approvals.push({
        capability: list[i].capability,
        approver: list[i].approver.id,
        approver_name: list[i].approver.getString("name"),
      });
    }
  }
  return approvals;
}

module.exports = {
  OVERRIDE_HEADER: OVERRIDE_HEADER,
  NEEDS_OVERRIDE: NEEDS_OVERRIDE,
  table: table,
  caller: caller,
  holds: holds,
  hashToken: hashToken,
  check: check,
  checkAll: checkAll,
  refuse: refuse,
  consume: consume,
  logOverrides: logOverrides,
  auditMeta: auditMeta,
};
