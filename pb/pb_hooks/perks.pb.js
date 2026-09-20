/// <reference path="../pb_data/types.d.ts" />

/**
 * perks.pb.js - the perks wallet at the counter (docs/api-contract.md's
 * Phase 6 section).
 *
 *   GET  /api/vault/customers/{id}/perks       (staff)
 *   POST /api/vault/customers/{id}/perks/use   (staff)
 *
 * `perk_usage` is staff-only and the portal reads its own copy of this
 * wallet through `GET /api/vault/me/guild` (guild.pb.js), so these two are
 * the counter's side: what this customer's tier gives them this month, and
 * marking one used when they take it.
 *
 * The allowance itself comes from the tier's own perks through the shared
 * `perkAllowance`, and the monthly counter from `perk_usage`, which
 * carries a unique index on (customer, perk_type, period) - so a use is an
 * upsert of that one row inside a transaction, never a blind insert.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/customers/{id}/perks   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/customers/{id}/perks",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perksLib = require(`${__hooks}/lib/perks.js`);

    const customerId = e.request.pathValue("id");
    try {
      e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("That customer was not found. Search again.", null);
    }

    let priv = null;
    try {
      priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
        customer: customerId,
      });
    } catch (err) {
      priv = null;
    }
    const tier = util.tier(e.app, priv ? priv.getString("tier") : "");

    return e.json(200, {
      tier: tier ? { id: tier.id, name: tier.name } : null,
      perks: perksLib.walletFor(e.app, customerId, tier, new Date()),
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/customers/{id}/perks/use   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/customers/{id}/perks/use",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perksLib = require(`${__hooks}/lib/perks.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const customerId = e.request.pathValue("id");
    const body = util.body(e);
    const type = util.asStr(body.type);
    const count = body.count === undefined ? 1 : util.asInt(body.count, 1);

    try {
      e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("That customer was not found. Search again.", null);
    }

    let priv = null;
    try {
      priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
        customer: customerId,
      });
    } catch (err) {
      priv = null;
    }
    const tier = util.tier(e.app, priv ? priv.getString("tier") : "");

    // Validate first, write second: this refusal never opens a
    // transaction, and the re-check inside the one below is only there for
    // the case that has to be atomic - two counters taking the last free
    // entry at the same moment.
    const refusal = perksLib.check(e.app, customerId, tier, type, count, new Date());
    if (refusal) {
      throw e.error(refusal.status, refusal.message, null);
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const outcome = perksLib.use(txApp, customerId, tier, type, count, new Date());
        if (!outcome.ok) {
          halt = { status: outcome.status, message: outcome.message };
          throw new Error(halt.message);
        }

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "perk_use",
          collection: "perk_usage",
          record: "",
          meta: {
            customer: customerId,
            perk_type: type,
            count: count,
            used: outcome.entry.used,
            allowed: outcome.entry.allowed,
            period: outcome.entry.period,
          },
          ip: e.realIP(),
        });

        result = { perk: outcome.entry };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);
