/// <reference path="../pb_data/types.d.ts" />

/**
 * vault_snapshots.pb.js - card price intelligence for the vault.
 *
 *   cron vault_snapshots_daily                        05:15 every day
 *   POST /api/vault/cardintel/snapshots/run           (admin)  { force? }
 *   POST /api/vault/cardintel/cards/{id}/snapshot     (staff)
 *   GET  /api/vault/cardintel/grading                 (staff)
 *   PUT  /api/vault/cardintel/grading                 (admin or manager)
 *
 * The daily job snapshots every card that is in stock, in an open deal, or
 * was scanned in the last 30 days (lib/vault_snapshots.js selectCards), so
 * price history builds from the day this ships: the game's own adapter for
 * the spot Cardmarket and TCGplayer figures (converted to GBP, UK-first
 * policy untouched), the Cardmarket rolling averages seeded once as dated
 * trend points, and the PSA 10, PSA 9 and ACE 10 slabs from UK eBay
 * listings when settings.api_keys.ebay is set. Every card is stamped in
 * adapter_state for 20 hours, so the on-demand route below and the cron
 * never read the same card twice in a day, and one run stops at 150 cards.
 * 05:15 sits after services/pricesync's 04:00 night run and before the
 * 07:00 FX fetch (yesterday's rate converts; the fx cron only ever shifts
 * it by a day's movement).
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

cronAdd("vault_snapshots_daily", "15 5 * * *", () => {
  const db = require(`${__hooks}/lib/vault_snapshots_db.js`);
  try {
    const summary = db.runDaily($app, new Date(), false);
    console.log(
      `[cron:vault_snapshots_daily] ${summary.selected} of ${summary.candidates} card(s): wrote ${summary.written} spot, ${summary.seeded} seed and ${summary.graded} graded snapshot(s), ${summary.skipped} skipped, ${summary.failed} failed${summary.capped ? " (capped, the next run carries on)" : ""}`
    );
  } catch (err) {
    console.log(`[cron:vault_snapshots_daily] failed: ${err}`);
  }
});

// ---------------------------------------------------------------------
// POST /api/vault/cardintel/snapshots/run   { force? }   (admin)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cardintel/snapshots/run",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const db = require(`${__hooks}/lib/vault_snapshots_db.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);
    const body = util.body(e);
    const summary = db.runDaily(e.app, new Date(), util.asBool(body.force));
    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "cardintel_snapshots_run",
      collection: "price_snapshots",
      record: "",
      meta: summary,
      ip: e.realIP(),
    });
    return e.json(200, summary);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/cardintel/cards/{id}/snapshot   (staff)
// The card page asks for this when its history is thin or a day old. Rate
// limited by the same 20-hour stamp as the cron, so a busy counter cannot
// burn the adapters: a second call inside the window answers
// { skipped: true } and reads nothing.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/cardintel/cards/{id}/snapshot",
  (e) => {
    const db = require(`${__hooks}/lib/vault_snapshots_db.js`);

    let card = null;
    try {
      card = e.app.findRecordById("cards", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Card not found. Search for it again.", null);
    }
    const result = db.snapshotCard(e.app, card, { now: new Date() });
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/cardintel/grading   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/cardintel/grading",
  (e) => {
    const db = require(`${__hooks}/lib/vault_snapshots_db.js`);
    return e.json(200, { grading: db.gradingConfig(e.app) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// PUT /api/vault/cardintel/grading   (admin or manager)
// { ace_standard_pence, psa_value_pence, postage_pence, min_profit_pence, fees_checked_on }
// ---------------------------------------------------------------------
routerAdd(
  "PUT",
  "/api/vault/cardintel/grading",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const db = require(`${__hooks}/lib/vault_snapshots_db.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const role = staff ? staff.getString("role") : "";
    if (role !== "admin" && role !== "manager") {
      throw e.forbiddenError("Only a manager or admin can change the grading fees.", null);
    }
    const settingsRow = util.settings(e.app);
    if (!settingsRow) throw e.error(500, "Settings are not set up on this server.", null);

    const body = util.body(e);
    const current = db.gradingConfig(e.app, settingsRow);
    const next = {};
    const keys = ["ace_standard_pence", "psa_value_pence", "postage_pence", "min_profit_pence"];
    for (let i = 0; i < keys.length; i++) {
      const value = body[keys[i]] === undefined ? current[keys[i]] : util.asInt(body[keys[i]], -1);
      if (value < 0 || value > 10000000) {
        throw e.badRequestError("Enter each fee in pence, from 0 up. For example 1500 for £15.00.", null);
      }
      next[keys[i]] = value;
    }
    const checked = body.fees_checked_on === undefined ? current.fees_checked_on : util.asStr(body.fees_checked_on).slice(0, 10);
    if (checked && !/^\d{4}-\d{2}-\d{2}$/.test(checked)) {
      throw e.badRequestError("Enter the date the fees were checked, as YYYY-MM-DD.", null);
    }
    next.fees_checked_on = checked;

    settingsRow.set("grading", next);
    e.app.save(settingsRow);
    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "grading_fees_updated",
      collection: "settings",
      record: settingsRow.id,
      meta: next,
      ip: e.realIP(),
    });
    return e.json(200, { grading: next });
  },
  $apis.requireAuth("staff")
);
