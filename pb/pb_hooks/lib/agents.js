/**
 * Agents (docs/api-contract-launch.md, section 5; docs/EPOS-PLAN.md,
 * decision 10).
 *
 * An agent is a `staff` row of `kind: "agent"` with the admin role (the
 * shop chose full admin access for Gandalf), no PIN and a password nobody
 * knows. It reaches GG Vault with a long-lived token: a PocketBase static
 * auth token signed with the record's own token key, good for a year and
 * answered once. Rotating that key (re-keying, or switching the agent off)
 * kills every token it had at the same moment, which is the whole of
 * "switching the agent off stops it at once".
 *
 * What an agent may not do, whatever its role:
 *  - appear on the lock screen's roster (till_auth.pb.js filters it out),
 *  - set, hold or use a PIN, so it cannot unlock a till,
 *  - sign in with a password,
 *  - approve a manager override,
 *  - pass a step-up, so it never opens an ID photo or does anything else
 *    that needs a person's password in the last ten minutes.
 * `refusalFor` says which request is which; agents.pb.js raises it.
 *
 * Nothing here returns or logs a token, a token key, a password or a hash.
 * Audit rows carry ids, field names and dates.
 *
 * require() this from inside each handler - see pb/README.md on hook
 * isolation.
 */

var TOKEN_DAYS = 365;
var DAY_MS = 24 * 60 * 60 * 1000;

var SENTENCES = {
  notFound: "That agent was not found.",
  name: "Give the agent a name of 60 characters or fewer.",
  note: "Keep the note to 500 characters or fewer.",
  nothing: "There is nothing to change. Send a name, a note or active.",
  active: "Say whether the agent is on with true or false.",
  off: "Switch the agent on before giving it a new token.",
  password: "Agents sign in with their token, not a password.",
  pin: "Agents do not have a PIN. They use their token.",
  unlock: "Agents cannot unlock a till. They use their own token.",
  approve: "An agent cannot approve that. Ask somebody with a PIN to approve it.",
  stepUp: "An agent cannot confirm a password. A member of staff has to do this one.",
  idPhoto: "Agents cannot open ID photos. A member of staff can, after confirming their password.",
  staffRoute: "Manage agents in Settings, Agents.",
  ownPassword: "Agents do not have a password. They use their token.",
  kind: "An account cannot change between a person and an agent.",
  newAgent: "Add an agent in Settings, Agents.",
  webhookUrl: "Give the webhook an http or https address of 500 characters or fewer.",
  webhookSecret: "Make the webhook secret 16 to 200 characters, or leave it blank to keep the one set.",
};

function isAgent(record) {
  if (!record) return false;
  try {
    return record.collection().name === "staff" && record.getString("kind") === "agent";
  } catch (err) {
    return false;
  }
}

/** The staff row behind an id, or null. */
function staffById(app, id) {
  if (!id) return null;
  try {
    return app.findRecordById("staff", String(id));
  } catch (err) {
    return null;
  }
}

/** The agent behind an id, or null for a person or nobody. */
function findAgent(app, id) {
  var record = staffById(app, id);
  return isAgent(record) ? record : null;
}

/** The newest audit row matching a filter, or null. */
function newestAudit(app, filter, params) {
  try {
    var rows = app.findRecordsByFilter("audit_log", filter, "-created,-id", 1, 0, params);
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

function isoOf(value) {
  var text = String(value || "");
  if (!text) return "";
  var parsed = new Date(text.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

/**
 * AgentSummary (packages/shared/src/agents.ts). When its token was issued
 * is read back from the audit row that issued it: the schema keeps no date
 * of its own for it, and the row is the record of the issue anyway.
 */
function shape(app, record) {
  var issued = newestAudit(app, "action = 'agent_token_issued' && record = {:id}", { id: record.id });
  var issuedAt = "";
  var expiresAt = "";
  if (issued) {
    issuedAt = isoOf(issued.getString("created"));
    var meta = {};
    try {
      meta = JSON.parse(toString(issued.get("meta"))) || {};
    } catch (err) {
      meta = {};
    }
    expiresAt = meta.expires_at ? String(meta.expires_at) : "";
  }
  // Switching an agent off rotates its key, so a token issued before then
  // works no more: say so rather than show a date it will never reach.
  var revoked = newestAudit(
    app,
    "record = {:id} && (action = 'agent_switched_off') && created > {:at}",
    { id: record.id, at: issued ? issued.getString("created") : "" }
  );
  if (revoked) {
    issuedAt = "";
    expiresAt = "";
  }
  var last = newestAudit(app, "actor = {:id}", { id: record.id });
  return {
    id: record.id,
    name: record.getString("name"),
    note: record.getString("agent_note"),
    active: record.getBool("active"),
    role: record.getString("role"),
    created: isoOf(record.getString("created")),
    token_issued_at: issuedAt,
    token_expires_at: expiresAt,
    last_action_at: last ? isoOf(last.getString("created")) : "",
  };
}

/** A name of 1 to 60 characters, or null. */
function cleanName(raw) {
  var name = raw === null || raw === undefined ? "" : String(raw).replace(/\s+/g, " ").trim();
  if (!name || name.length > 60) return null;
  return name;
}

/** A note of up to 500 characters, or null when too long. */
function cleanNote(raw) {
  var note = raw === null || raw === undefined ? "" : String(raw).trim();
  if (note.length > 500) return null;
  return note;
}

/**
 * A new agent row, unsaved: admin, active, kind agent, an address nobody
 * can receive mail at (the auth collection needs one), a random password
 * nobody is told, and no PIN.
 */
function newAgentRecord(app, name, note) {
  var record = new Record(app.findCollectionByNameOrId("staff"));
  var local = $security.randomStringWithAlphabet(16, "abcdefghijklmnopqrstuvwxyz0123456789");
  record.set("name", name);
  record.set("agent_note", note);
  record.setEmail("agent-" + local + "@agents.ggvault.invalid");
  record.setPassword($security.randomString(48));
  record.set("role", "admin");
  record.set("kind", "agent");
  record.set("active", true);
  record.set("must_change_password", false);
  record.set("verified", true);
  return record;
}

/**
 * A year-long token for a saved agent row, signed with its current key.
 * Returned once to the caller and never stored or logged.
 */
function issueToken(record) {
  var ms = TOKEN_DAYS * DAY_MS;
  // time.Duration is nanoseconds.
  var token = record.newStaticAuthToken(ms * 1000000);
  return { token: token, expires_at: new Date(Date.now() + ms).toISOString() };
}

/**
 * The last 50 things an agent did, newest first, from the audit log.
 * `detail` is built from the row's own identifiers, never a value.
 */
function actions(app, id, limit) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("audit_log", "actor = {:id}", "-created,-id", limit || 50, 0, { id: id });
  } catch (err) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var meta = {};
    try {
      meta = JSON.parse(toString(row.get("meta"))) || {};
    } catch (err) {
      meta = {};
    }
    out.push({
      id: row.id,
      action: row.getString("action"),
      collection: row.getString("collection"),
      record: row.getString("record"),
      created: isoOf(row.getString("created")),
      detail: actionDetail(row.getString("action"), meta),
    });
  }
  return out;
}

/** A few words from an audit row's meta: the tool, the status, a number. */
function actionDetail(action, meta) {
  var parts = [];
  if (meta.tool) parts.push(String(meta.tool));
  if (meta.method && meta.path) parts.push(String(meta.method) + " " + String(meta.path));
  if (meta.ok === false) parts.push("refused" + (meta.status ? " (" + meta.status + ")" : ""));
  if (meta.number) parts.push(String(meta.number));
  if (typeof meta.price === "number") {
    var money = require(__hooks + "/lib/shared/money.js");
    parts.push(money.formatGBP(meta.price));
  }
  if (meta.comps !== undefined) parts.push(String(meta.comps) + " comps");
  if (meta.fields && meta.fields.length) parts.push(meta.fields.join(", "));
  return parts.join(" · ").slice(0, 200);
}

// ---------------------------------------------------------------------------
// The research webhook (settings.agent_webhook: { url, secret })
// ---------------------------------------------------------------------------

function webhookConfig(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var row = util.settings(app);
  var stored = row ? util.jsonField(row, "agent_webhook", null) : null;
  return {
    row: row,
    url: stored && typeof stored.url === "string" ? stored.url : "",
    secret: stored && typeof stored.secret === "string" ? stored.secret : "",
  };
}

/** A URL the webhook may call: http or https, nothing else. */
function cleanWebhookUrl(raw) {
  var url = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!url) return "";
  if (url.length > 500 || !/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url)) return null;
  return url;
}

/**
 * POST one event to the agent webhook, signed, and say how it went.
 *
 * The body is JSON with `event_type` at the top (the field Hermes's
 * webhook adapter filters routes on) and the event's `data`. With a secret
 * set it carries the HMAC-SHA256 of the body, hex, as `X-GG-Signature`
 * (docs/api-contract-launch.md, section 5) and, so a Hermes webhook route
 * checks it with no adapter in between, the same value as
 * `X-Webhook-Signature` and the timestamped `X-Webhook-Signature-V2`
 * (HMAC-SHA256 of "<unix seconds>.<body>") with `X-Webhook-Timestamp`.
 *
 * A short timeout, and it never throws: a sleeping agent must never fail
 * the request that asked it for help. goja has no background thread, so
 * callers send it after their own transaction has committed. Neither the
 * URL nor the secret is ever logged.
 */
function sendWebhook(app, event, data) {
  var config = webhookConfig(app);
  if (!config.url) return { sent: false, status: 0, reason: "off" };
  var body = JSON.stringify({ event_type: event, sent_at: new Date().toISOString(), data: data });
  var headers = {
    "Content-Type": "application/json",
    "User-Agent": "GGVault/1.0 (+https://ggpos.ggentertainment.co.uk)",
    "X-GG-Event": event,
  };
  if (config.secret) {
    var timestamp = String(Math.floor(Date.now() / 1000));
    var signature = $security.hs256(body, config.secret);
    headers["X-GG-Signature"] = signature;
    headers["X-Webhook-Signature"] = signature;
    headers["X-Webhook-Timestamp"] = timestamp;
    headers["X-Webhook-Signature-V2"] = $security.hs256(timestamp + "." + body, config.secret);
  }
  try {
    var res = $http.send({ url: config.url, method: "POST", body: body, headers: headers, timeout: 3 });
    var status = res && res.statusCode ? res.statusCode : 0;
    return { sent: status >= 200 && status < 300, status: status, reason: status ? "" : "no answer" };
  } catch (err) {
    console.log("[agents] the agent webhook did not answer for " + event);
    return { sent: false, status: 0, reason: "unreachable" };
  }
}

// ---------------------------------------------------------------------------
// What an agent may not do
// ---------------------------------------------------------------------------

/** The request's path, without a trailing slash. */
function pathOf(e) {
  var path = "";
  try {
    path = String(e.request.url.path || "");
  } catch (err) {
    path = "";
  }
  if (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.substring(0, path.length - 1);
  return path;
}

function methodOf(e) {
  try {
    return String(e.request.method || "").toUpperCase();
  } catch (err) {
    return "";
  }
}

/** A JSON body field, read once (PocketBase caches the parsed body). */
function bodyField(e, name) {
  try {
    var info = e.requestInfo();
    var body = (info && info.body) || {};
    var value = body[name];
    return value === null || value === undefined ? "" : String(value);
  } catch (err) {
    return "";
  }
}

/**
 * The refusal for this request when it would have an agent do something
 * only a person may, or null. Two kinds: the caller is an agent (a step-up,
 * an ID photo, its own PIN or password), or the request names an agent as
 * somebody it is not allowed to be (unlocking a till as one, approving as
 * one, giving one a PIN or a password through the staff routes).
 */
function refusalFor(e) {
  var method = methodOf(e);
  var path = pathOf(e);
  if (path.indexOf("/api/vault/") !== 0) return null;

  var callerIsAgent = isAgent(e.auth);
  if (callerIsAgent) {
    if (method === "POST" && path === "/api/vault/step-up") return { status: 403, message: SENTENCES.stepUp };
    if (method === "GET" && /^\/api\/vault\/id-photo\/[^/]+$/.test(path)) {
      return { status: 403, message: SENTENCES.idPhoto };
    }
    if ((method === "POST" || method === "DELETE") && path === "/api/vault/staff/me/pin") {
      return { status: 403, message: SENTENCES.pin };
    }
    if (method === "POST" && path === "/api/vault/staff/me/password") {
      return { status: 403, message: SENTENCES.ownPassword };
    }
  }

  if (method === "POST" && path === "/api/vault/till/unlock") {
    if (findAgent(e.app, bodyField(e, "staff"))) return { status: 403, message: SENTENCES.unlock };
    return null;
  }
  if (method === "POST" && path === "/api/vault/till/override") {
    if (findAgent(e.app, bodyField(e, "approver"))) return { status: 403, message: SENTENCES.approve };
    return null;
  }

  var target = /^\/api\/vault\/staff\/([^/]+)(\/(pin|password))?$/.exec(path);
  if (target && target[1] !== "me" && findAgent(e.app, target[1])) {
    if (target[3] === "pin" && (method === "POST" || method === "DELETE")) {
      return { status: 403, message: SENTENCES.pin };
    }
    if (target[3] === "password" && method === "POST") return { status: 403, message: SENTENCES.ownPassword };
    if (!target[3] && method === "PATCH") return { status: 403, message: SENTENCES.staffRoute };
  }
  return null;
}

module.exports = {
  TOKEN_DAYS: TOKEN_DAYS,
  SENTENCES: SENTENCES,
  isAgent: isAgent,
  findAgent: findAgent,
  shape: shape,
  cleanName: cleanName,
  cleanNote: cleanNote,
  newAgentRecord: newAgentRecord,
  issueToken: issueToken,
  actions: actions,
  webhookConfig: webhookConfig,
  cleanWebhookUrl: cleanWebhookUrl,
  sendWebhook: sendWebhook,
  refusalFor: refusalFor,
};
