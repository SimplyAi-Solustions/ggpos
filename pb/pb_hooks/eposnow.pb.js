/// <reference path="../pb_data/types.d.ts" />

/**
 * eposnow.pb.js - the Epos Now till, GG Vault's side
 * (docs/api-contract.md's Phase 8 section; logic in lib/eposnow.js).
 *
 *   POST /api/vault/epos/webhook               (public, Epos Now's Basic credentials)
 *   POST /api/vault/customers/{id}/epos-link   (staff)
 *   POST /api/vault/epos/poll                  (admin, "check Epos Now now")
 *   cron epos_poll                             (every 5 minutes, 08:00-22:00 Europe/London)
 *   cron epos_link_retry                       (every 5 minutes)
 *
 * The webhook and the poll feed the same idempotent handler. The webhook
 * never trusts the sale its body describes: each transaction id in it is
 * read back from Epos Now with the shop's own API token first, so somebody
 * holding the webhook credentials can do no more than make GG Vault look
 * at a real sale again.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/epos/webhook   (public; Epos Now's Basic credentials)
//
// Epos Now's webhook settings take an API key and secret ("Basic
// Authentication credentials", Epos Now developer docs, Webhooks) and send
// them as `Authorization: Basic base64(key:secret)`. They are compared in
// constant time against `settings.api_keys.eposnow_webhook_key` and
// `eposnow_webhook_secret`; nothing secret is in the URL, so nothing
// secret reaches PocketBase's request log.
// ---------------------------------------------------------------------
routerAdd("POST", "/api/vault/epos/webhook", (e) => {
  const epos = require(`${__hooks}/lib/eposnow.js`);

  const cfg = epos.config(e.app);
  let header = "";
  try {
    header = e.request.header.get("Authorization") || "";
  } catch (err) {
    header = "";
  }
  if (!epos.webhookAuthorised(cfg, header)) {
    throw e.unauthorizedError("Not authorised.", null);
  }

  let payload = null;
  try {
    const raw = readerToString(e.request.body);
    payload = raw ? JSON.parse(raw) : null;
  } catch (err) {
    payload = null;
  }

  let result = null;
  try {
    result = epos.handleWebhook(e.app, payload, new Date());
  } catch (err) {
    // Epos Now can resend a failed webhook; the poll will see the sale
    // anyway, so a failure here is logged, not bounced.
    console.log(`[epos:webhook] failed: ${err}`);
    result = { received: 0 };
  }
  return e.json(200, {
    received: result.received || 0,
    activated: result.activated || 0,
    renewed: result.renewed || 0,
    linked_manual: result.linked_manual || 0,
    flagged: result.flagged || 0,
    unmatched: result.unmatched || 0,
    deferred: result.deferred || 0,
    skipped: result.skipped || 0,
  });
});

// ---------------------------------------------------------------------
// POST /api/vault/customers/{id}/epos-link   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/customers/{id}/epos-link",
  (e) => {
    const epos = require(`${__hooks}/lib/eposnow.js`);

    const customerId = e.request.pathValue("id");
    try {
      e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("That customer was not found. Search again.", null);
    }

    // A staff press always gets a fresh run of tries, even after the
    // cron gave up: that is what the button is for.
    const priv = epos.privateFor(e.app, customerId);
    if (priv && !priv.getString("epos_customer_id") && priv.getString("epos_sync_status") === "failed") {
      priv.set("epos_sync_status", "queued");
      priv.set("epos_sync_attempts", 0);
      e.app.save(priv);
    }

    const result = epos.link(e.app, customerId, { actor: e.auth.id, ip: e.realIP() });
    return e.json(200, {
      link: epos.linkShape(epos.privateFor(e.app, customerId)),
      message: result.message || "",
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/epos/poll   (admin)
//
// The same pull the cron makes, on demand and at any hour: for an admin
// who has just rung a Guild membership through and does not want to wait
// five minutes, and for pb/scripts/check.sh.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/epos/poll",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const epos = require(`${__hooks}/lib/eposnow.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    util.requireAdmin(e);

    const cfg = epos.config(e.app);
    if (!cfg.token) {
      throw e.error(422, "Epos Now is not set up: save the API token in settings first.", null);
    }
    if (!Object.keys(cfg.productTiers).length) {
      throw e.error(422, "No Guild product is set: add its Epos Now product id in settings first.", null);
    }
    if (!cfg.activeFrom) {
      throw e.error(422, "No start time is set: add settings.eposnow.active_from before polling.", null);
    }
    const result = epos.poll(e.app, new Date());
    auditLib.writeAuditLog(e.app, {
      actor: e.auth.id,
      action: "epos_poll",
      collection: "epos_transactions",
      record: "",
      meta: {
        seen: result.seen,
        activated: result.activated,
        renewed: result.renewed,
        unmatched: result.unmatched,
      },
      ip: e.realIP(),
    });
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// Cron: epos_poll, every five minutes while the shop could be trading.
// PocketBase's cron runs on UTC, so it fires all day and checks the
// London clock itself (lib/reports/dates.js's toLondon, the one place
// this codebase converts a timezone).
// ---------------------------------------------------------------------
cronAdd("epos_poll", "*/5 * * * *", () => {
  const epos = require(`${__hooks}/lib/eposnow.js`);
  const dates = require(`${__hooks}/lib/reports/dates.js`);

  const now = new Date();
  const hour = dates.toLondon(now).getUTCHours();
  if (hour < 8 || hour >= 22) return;

  try {
    const result = epos.poll($app, now);
    if (result.error) console.log(`[cron:epos_poll] ${result.error}`);
    if (result.activated || result.renewed || result.unmatched) {
      console.log(
        `[cron:epos_poll] activated ${result.activated}, renewed ${result.renewed}, unmatched ${result.unmatched}`
      );
    }
  } catch (err) {
    console.log(`[cron:epos_poll] failed: ${err}`);
  }
});

// ---------------------------------------------------------------------
// Cron: epos_link_retry, every five minutes.
// ---------------------------------------------------------------------
cronAdd("epos_link_retry", "*/5 * * * *", () => {
  const epos = require(`${__hooks}/lib/eposnow.js`);
  try {
    const result = epos.retryQueued($app, 25);
    if (result.tried) console.log(`[cron:epos_link_retry] tried ${result.tried}, linked ${result.linked}`);
  } catch (err) {
    console.log(`[cron:epos_link_retry] failed: ${err}`);
  }
});
