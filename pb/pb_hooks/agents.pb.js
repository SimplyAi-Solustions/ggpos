/// <reference path="../pb_data/types.d.ts" />

/**
 * agents.pb.js - AI agents with full admin access
 * (docs/api-contract-launch.md, section 5; docs/EPOS-PLAN.md, decision 10).
 *
 *   GET   /api/vault/agents                  (staff_manage)
 *   POST  /api/vault/agents                  (staff_manage + step-up)  { name, note }
 *   PATCH /api/vault/agents/{id}             (staff_manage)            { name?, note?, active? }
 *   POST  /api/vault/agents/{id}/token       (staff_manage + step-up)
 *   GET   /api/vault/agents/{id}/actions     (staff_manage)
 *   GET   /api/vault/agents/webhook          (staff_manage)
 *   POST  /api/vault/agents/webhook          (staff_manage)            { url, secret? }
 *
 * Creating an agent and re-keying one each answer a year-long token once;
 * neither is ever stored, logged or answered again. Both need the admin's
 * own step-up, because each hands out a credential with full admin access,
 * and that also means an agent can never mint itself another. Switching an
 * agent off rotates its token key in the same save, so its token stops at
 * once; switching it back on does not revive the old one.
 *
 * The hooks below keep an agent an agent whichever way a staff row is
 * written: `kind` is set here and nowhere else, an agent never holds a PIN,
 * switching one off through any path rotates its key, and a password
 * sign-in as one is refused. The routerUse middleware refuses the rest of
 * what only a person may do (lib/agents.js `refusalFor`).
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/agents
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/agents",
  (e) => {
    const perms = require(`${__hooks}/lib/permissions.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    const rows = e.app.findRecordsByFilter("staff", "kind = 'agent'", "name,id", 200, 0);
    const list = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) list.push(agents.shape(e.app, rows[i]));
    }
    return e.json(200, { agents: list });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/agents - a new agent and its first token
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/agents",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);
    stepup.requireStepUp(e);
    const by = grant.by;

    const body = util.body(e);
    const name = agents.cleanName(body.name);
    if (!name) throw e.badRequestError(agents.SENTENCES.name, null);
    const note = agents.cleanNote(body.note);
    if (note === null) throw e.badRequestError(agents.SENTENCES.note, null);

    function nameTaken(app) {
      try {
        app.findFirstRecordByFilter("staff", "kind = 'agent' && name:lower = {:name}", {
          name: name.toLowerCase(),
        });
        return true;
      } catch (err) {
        return false;
      }
    }
    const TAKEN = `There is already an agent called ${name}. Give this one another name.`;
    if (nameTaken(e.app)) throw e.error(409, TAKEN, null);

    let halt = null;
    let created = null;
    let issued = null;
    try {
      e.app.runInTransaction((txApp) => {
        if (nameTaken(txApp)) {
          halt = { status: 409, message: TAKEN };
          throw new Error(halt.message);
        }
        const record = agents.newAgentRecord(txApp, name, note);
        txApp.save(record);
        issued = agents.issueToken(record);
        created = record;

        audit.writeAuditLog(txApp, {
          actor: by.id,
          action: "agent_created",
          collection: "staff",
          record: record.id,
          meta: { record: record.id, by: by.id },
          ip: e.realIP(),
        });
        audit.writeAuditLog(txApp, {
          actor: by.id,
          action: "agent_token_issued",
          collection: "staff",
          record: record.id,
          meta: { record: record.id, by: by.id, expires_at: issued.expires_at },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(201, {
      agent: agents.shape(e.app, created),
      token: issued.token,
      expires_at: issued.expires_at,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// PATCH /api/vault/agents/{id} - name, note, on or off
// ---------------------------------------------------------------------
routerAdd(
  "PATCH",
  "/api/vault/agents/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);
    const by = grant.by;

    const id = e.request.pathValue("id");
    if (!agents.findAgent(e.app, id)) throw e.notFoundError(agents.SENTENCES.notFound, null);

    const body = util.body(e);
    const changes = {};
    if (body.name !== undefined) {
      const name = agents.cleanName(body.name);
      if (!name) throw e.badRequestError(agents.SENTENCES.name, null);
      changes.name = name;
    }
    if (body.note !== undefined) {
      const note = agents.cleanNote(body.note);
      if (note === null) throw e.badRequestError(agents.SENTENCES.note, null);
      changes.note = note;
    }
    if (body.active !== undefined) {
      if (body.active !== true && body.active !== false) {
        throw e.badRequestError(agents.SENTENCES.active, null);
      }
      changes.active = body.active;
    }
    if (changes.name === undefined && changes.note === undefined && changes.active === undefined) {
      throw e.badRequestError(agents.SENTENCES.nothing, null);
    }

    let saved = null;
    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", id);
      const fields = [];
      if (changes.name !== undefined && changes.name !== fresh.getString("name")) {
        fresh.set("name", changes.name);
        fields.push("name");
      }
      if (changes.note !== undefined && changes.note !== fresh.getString("agent_note")) {
        fresh.set("agent_note", changes.note);
        fields.push("note");
      }
      let switched = "";
      if (changes.active !== undefined && changes.active !== fresh.getBool("active")) {
        fresh.set("active", changes.active);
        // The staff update hook below rotates the key on any save that
        // switches an agent off; doing it here as well says so where the
        // route reads, and a second rotation in one save is the same one.
        if (!changes.active) fresh.refreshTokenKey();
        switched = changes.active ? "agent_switched_on" : "agent_switched_off";
      }
      saved = fresh;
      if (!fields.length && !switched) return;
      txApp.save(fresh);

      if (fields.length) {
        audit.writeAuditLog(txApp, {
          actor: by.id,
          action: "agent_updated",
          collection: "staff",
          record: fresh.id,
          meta: { fields: fields, record: fresh.id, by: by.id },
          ip: e.realIP(),
        });
      }
      if (switched) {
        audit.writeAuditLog(txApp, {
          actor: by.id,
          action: switched,
          collection: "staff",
          record: fresh.id,
          meta: { record: fresh.id, by: by.id },
          ip: e.realIP(),
        });
      }
    });

    return e.json(200, { agent: agents.shape(e.app, saved) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/agents/{id}/token - a new token; the old one stops
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/agents/{id}/token",
  (e) => {
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);
    stepup.requireStepUp(e);
    const by = grant.by;

    const id = e.request.pathValue("id");
    const agent = agents.findAgent(e.app, id);
    if (!agent) throw e.notFoundError(agents.SENTENCES.notFound, null);
    if (!agent.getBool("active")) throw e.error(409, agents.SENTENCES.off, null);

    let saved = null;
    let issued = null;
    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", id);
      // A new key first: every token signed with the old one, the one being
      // replaced included, stops working when this commits.
      fresh.refreshTokenKey();
      txApp.save(fresh);
      issued = agents.issueToken(fresh);
      saved = fresh;
      audit.writeAuditLog(txApp, {
        actor: by.id,
        action: "agent_token_issued",
        collection: "staff",
        record: fresh.id,
        meta: { record: fresh.id, by: by.id, expires_at: issued.expires_at, rekey: true },
        ip: e.realIP(),
      });
    });

    return e.json(200, {
      agent: agents.shape(e.app, saved),
      token: issued.token,
      expires_at: issued.expires_at,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/agents/{id}/actions - its last 50 actions
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/agents/{id}/actions",
  (e) => {
    const perms = require(`${__hooks}/lib/permissions.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    const id = e.request.pathValue("id");
    if (!agents.findAgent(e.app, id)) throw e.notFoundError(agents.SENTENCES.notFound, null);
    return e.json(200, { actions: agents.actions(e.app, id, 50) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/agents/webhook - where a new research request is sent
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/agents/webhook",
  (e) => {
    const perms = require(`${__hooks}/lib/permissions.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    const config = agents.webhookConfig(e.app);
    // The secret itself never leaves the server, only whether there is one.
    return e.json(200, { url: config.url, secret_set: config.secret !== "" });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/agents/webhook   { url, secret? }
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/agents/webhook",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const agents = require(`${__hooks}/lib/agents.js`);

    const grant = perms.check(e, "staff_manage");
    if (!grant.ok) return perms.refuse(e, grant);
    const by = grant.by;

    const body = util.body(e);
    const url = agents.cleanWebhookUrl(body.url);
    if (url === null) throw e.badRequestError(agents.SENTENCES.webhookUrl, null);
    // A blank or missing secret keeps the one set; `clear_secret` removes it.
    let secret = null;
    if (typeof body.secret === "string" && body.secret.trim() !== "") {
      secret = body.secret.trim();
      if (secret.length < 16 || secret.length > 200) {
        throw e.badRequestError(agents.SENTENCES.webhookSecret, null);
      }
    }
    const clear = body.clear_secret === true;

    let answer = null;
    e.app.runInTransaction((txApp) => {
      const config = agents.webhookConfig(txApp);
      if (!config.row) throw new Error("The settings record is missing.");
      const next = {
        url: url,
        secret: clear ? "" : secret !== null ? secret : config.secret,
      };
      const fields = [];
      if (next.url !== config.url) fields.push("url");
      if (next.secret !== config.secret) fields.push("secret");
      config.row.set("agent_webhook", next);
      txApp.save(config.row);
      if (fields.length) {
        // Field names only: neither the address nor the secret goes in the
        // permanent log.
        audit.writeAuditLog(txApp, {
          actor: by.id,
          action: "agent_webhook_set",
          collection: "settings",
          record: config.row.id,
          meta: { fields: fields, by: by.id },
          ip: e.realIP(),
        });
      }
      answer = { url: next.url, secret_set: next.secret !== "" };
    });

    return e.json(200, answer);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// What an agent may not do: one middleware, read in lib/agents.js
// ---------------------------------------------------------------------
routerUse((e) => {
  const agents = require(`${__hooks}/lib/agents.js`);
  const refusal = agents.refusalFor(e);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
});

// ---------------------------------------------------------------------
// Staff rows: kind, PINs and switching off, whichever way they are saved
// ---------------------------------------------------------------------

/** A password sign-in as an agent is refused; it has its token. */
onRecordAuthWithPasswordRequest((e) => {
  const agents = require(`${__hooks}/lib/agents.js`);
  if (agents.isAgent(e.record)) throw e.forbiddenError(agents.SENTENCES.password, null);
  e.next();
}, "staff");

/**
 * Through the collection API `kind` is not anybody's to set: a new row is
 * a person, and only a superuser in `/_/` may make or unmake an agent by
 * hand. The agent routes write it themselves, which these hooks never see.
 */
onRecordCreateRequest((e) => {
  const agents = require(`${__hooks}/lib/agents.js`);
  const kind = e.record.getString("kind");
  if (kind === "agent" && !e.hasSuperuserAuth()) throw e.badRequestError(agents.SENTENCES.newAgent, null);
  if (!kind) e.record.set("kind", "person");
  e.next();
}, "staff");

onRecordUpdateRequest((e) => {
  const agents = require(`${__hooks}/lib/agents.js`);
  let before = "";
  try {
    before = e.record.original().getString("kind");
  } catch (err) {
    before = "";
  }
  const after = e.record.getString("kind");
  if ((before || "person") !== (after || "person") && !e.hasSuperuserAuth()) {
    throw e.badRequestError(agents.SENTENCES.kind, null);
  }
  e.next();
}, "staff");

/** Every new staff row is a person unless it says otherwise. */
onRecordCreate((e) => {
  if (!e.record.getString("kind")) e.record.set("kind", "person");
  e.next();
}, "staff");

/**
 * Every save of an agent row, through any route or the collection API:
 * it never holds a PIN, and switching it off rotates its token key so the
 * token it had stops in the same save.
 */
onRecordUpdate((e) => {
  const agents = require(`${__hooks}/lib/agents.js`);
  if (agents.isAgent(e.record)) {
    if (e.record.getString("pin_hash")) throw new Error(agents.SENTENCES.pin);
    let wasActive = false;
    try {
      wasActive = e.record.original().getBool("active");
    } catch (err) {
      wasActive = false;
    }
    if (wasActive && !e.record.getBool("active")) e.record.refreshTokenKey();
  }
  e.next();
}, "staff");
