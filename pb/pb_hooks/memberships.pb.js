/// <reference path="../pb_data/types.d.ts" />

/**
 * memberships.pb.js - paid plans (a Guild Pass and anything like it), which
 * pin a tier for as long as they run (docs/PLAN.md's Loyalty data model;
 * docs/api-contract.md's Phase 6 section).
 *
 *   POST /api/vault/memberships              (staff)
 *   POST /api/vault/memberships/{id}/renew   (staff)
 *   POST /api/vault/memberships/{id}/cancel  (staff)
 *   cron memberships_lapse                   (nightly)
 *
 * The tier itself is never written here: `memberships` create and update
 * hooks (loyalty.pb.js) re-evaluate it through lib/tiers.js, so a
 * membership taken out, renewed, cancelled or lapsed all reach the tier by
 * exactly the same path, whichever route or cron got it there.
 *
 * Stripe is a later phase (docs/PLAN.md, Phase 7); `price` and
 * `payment_note` are what a member of staff records having taken at the
 * counter.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/memberships   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/memberships",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotes = require(`${__hooks}/lib/quotes.js`);

    const staff = e.auth;
    const body = util.body(e);
    const customerId = util.asStr(body.customer);
    const tierId = util.asStr(body.tier);
    const months = util.asInt(body.months, 0);
    const price = util.asInt(body.price, 0);
    const paymentNote = util.asStr(body.payment_note);
    const now = new Date();

    let customer = null;
    try {
      customer = e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("That customer was not found. Search again.", null);
    }
    let tier = null;
    try {
      tier = e.app.findRecordById("loyalty_tiers", tierId);
    } catch (err) {
      throw e.notFoundError("That tier was not found. Pick one from the tiers list.", null);
    }
    if (!tier.getBool("paid_plan")) {
      throw e.error(
        422,
        `${tier.getString("name")} is earned with points, not bought. Pick a paid plan tier.`,
        null
      );
    }
    if (months < 1 || months > 24) {
      throw e.badRequestError("Pick a length of 1 to 24 months.", null);
    }
    if (price < 0) {
      throw e.badRequestError("A membership price cannot be negative.", null);
    }

    let existing = null;
    try {
      existing = e.app.findFirstRecordByFilter(
        "memberships",
        'customer = {:customer} && status = "active"',
        { customer: customerId }
      );
    } catch (err) {
      existing = null;
    }
    if (existing) {
      throw e.error(
        409,
        `This customer already has a membership until ${quotes.ukDateShort(existing.getString("renews_at"))}. Renew that one instead.`,
        null
      );
    }

    const renewsAt = util.addMonths(now, months).toISOString();
    let result = null;
    let pending = [];

    e.app.runInTransaction((txApp) => {
      const membership = new Record(txApp.findCollectionByNameOrId("memberships"), {
        customer: customerId,
        tier: tier.id,
        status: "active",
        started_at: now.toISOString(),
        renews_at: renewsAt,
        price: price,
        payment_note: paymentNote,
      });
      txApp.save(membership);

      const n = notifyLib.notify(txApp, {
        customer: customerId,
        type: "membership_started",
        title: `Your ${tier.getString("name")} is live`,
        body: `Your ${tier.getString("name")} runs until ${quotes.ukDateShort(renewsAt)}. The perks are in My Vault, under Guild.`,
        link: "/account/guild",
        email: true,
      });
      pending = n.pending || [];

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "membership_start",
        collection: "memberships",
        record: membership.id,
        meta: { customer: customerId, tier: tier.id, months: months, price: price },
        ip: e.realIP(),
      });

      result = {
        membership: {
          id: membership.id,
          customer: customerId,
          tier: tier.id,
          tier_name: tier.getString("name"),
          status: "active",
          started_at: membership.getString("started_at"),
          renews_at: membership.getString("renews_at"),
          price: price,
        },
      };
    });

    notifyLib.sendPending(e.app, pending);
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/memberships/{id}/renew   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/memberships/{id}/renew",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const quotes = require(`${__hooks}/lib/quotes.js`);

    const staff = e.auth;
    const body = util.body(e);
    const months = util.asInt(body.months, 0);
    const price = util.asInt(body.price, 0);
    const paymentNote = util.asStr(body.payment_note);
    const now = new Date();

    let membership = null;
    try {
      membership = e.app.findRecordById("memberships", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That membership was not found.", null);
    }
    if (months < 1 || months > 24) {
      throw e.badRequestError("Pick a length of 1 to 24 months.", null);
    }
    if (price < 0) {
      throw e.badRequestError("A membership price cannot be negative.", null);
    }
    if (membership.getString("status") === "cancelled") {
      throw e.error(409, "That membership was cancelled. Start a new one instead.", null);
    }

    // Renewing a lapsed membership makes it active again, so the same
    // "one active membership per customer" rule the create route enforces
    // has to hold here: otherwise a lapsed one renewed alongside a live
    // one leaves two, and which of them pins the tier is a coin toss.
    let otherActive = null;
    try {
      otherActive = e.app.findFirstRecordByFilter(
        "memberships",
        'customer = {:customer} && status = "active" && id != {:id}',
        { customer: membership.getString("customer"), id: membership.id }
      );
    } catch (err) {
      otherActive = null;
    }
    if (otherActive) {
      throw e.error(
        409,
        `This customer already has a membership until ${quotes.ukDateShort(otherActive.getString("renews_at"))}. Renew that one instead.`,
        null
      );
    }

    // From the later of now and the current expiry, so renewing early adds
    // to what is left rather than throwing it away, and renewing late does
    // not backdate the new term into months already gone.
    const currentRenewal = membership.getString("renews_at");
    const currentEnd = currentRenewal ? new Date(String(currentRenewal).replace(" ", "T")) : now;
    const from = !isNaN(currentEnd.getTime()) && currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const renewsAt = util.addMonths(from, months).toISOString();

    let result = null;

    e.app.runInTransaction((txApp) => {
      const live = txApp.findRecordById("memberships", membership.id);
      live.set("renews_at", renewsAt);
      live.set("status", "active");
      live.set("price", price);
      if (paymentNote) live.set("payment_note", paymentNote);
      txApp.save(live);

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "membership_renew",
        collection: "memberships",
        record: live.id,
        meta: {
          customer: live.getString("customer"),
          tier: live.getString("tier"),
          months: months,
          price: price,
          renews_at: renewsAt,
        },
        ip: e.realIP(),
      });

      result = {
        membership: {
          id: live.id,
          customer: live.getString("customer"),
          tier: live.getString("tier"),
          status: live.getString("status"),
          started_at: live.getString("started_at"),
          renews_at: live.getString("renews_at"),
          price: live.getInt("price"),
        },
      };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/memberships/{id}/cancel   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/memberships/{id}/cancel",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const tiers = require(`${__hooks}/lib/tiers.js`);

    const staff = e.auth;
    let membership = null;
    try {
      membership = e.app.findRecordById("memberships", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That membership was not found.", null);
    }
    if (membership.getString("status") === "cancelled") {
      throw e.error(409, "That membership is already cancelled.", null);
    }

    let tierName = "membership";
    try {
      tierName = e.app.findRecordById("loyalty_tiers", membership.getString("tier")).getString("name");
    } catch (err) {
      tierName = "membership";
    }

    let result = null;
    let pending = [];

    e.app.runInTransaction((txApp) => {
      const live = txApp.findRecordById("memberships", membership.id);
      live.set("status", "cancelled");
      txApp.save(live);

      // The `memberships` update hook (loyalty.pb.js) re-evaluates the
      // tier off the back of that save, so nothing here writes it.
      const n = notifyLib.notify(txApp, {
        customer: live.getString("customer"),
        type: "membership_lapsed",
        title: `Your ${tierName} has ended`,
        body: `Your ${tierName} was cancelled on ${tiers.ukDayMonth(new Date().toISOString())}. Ask at the counter to start it again.`,
        link: "/account/guild",
        email: true,
      });
      pending = n.pending || [];

      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "membership_cancel",
        collection: "memberships",
        record: live.id,
        meta: { customer: live.getString("customer"), tier: live.getString("tier") },
        ip: e.realIP(),
      });

      result = {
        membership: {
          id: live.id,
          customer: live.getString("customer"),
          tier: live.getString("tier"),
          status: "cancelled",
          started_at: live.getString("started_at"),
          renews_at: live.getString("renews_at"),
          price: live.getInt("price"),
        },
      };
    });

    notifyLib.sendPending(e.app, pending);
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// Cron: memberships_lapse, nightly at 04:00.
// ---------------------------------------------------------------------
cronAdd("memberships_lapse", "0 4 * * *", () => {
  const notifyLib = require(`${__hooks}/lib/notify.js`);
  const tiers = require(`${__hooks}/lib/tiers.js`);

  const now = new Date();
  // PocketBase's own stored date form (a space, not "T") - see
  // pb_hooks/crons.pb.js's own pbDate() for why a cutoff is written this way.
  const cutoff = now.toISOString().replace("T", " ");

  let due = [];
  try {
    due = $app.findRecordsByFilter(
      "memberships",
      'status = "active" && renews_at != "" && renews_at <= {:cutoff}',
      "renews_at",
      0,
      0,
      { cutoff: cutoff }
    );
  } catch (err) {
    due = [];
  }

  let lapsed = 0;
  for (let i = 0; i < due.length; i++) {
    const membership = due[i];
    if (!membership) continue;

    let tierName = "membership";
    try {
      tierName = $app.findRecordById("loyalty_tiers", membership.getString("tier")).getString("name");
    } catch (err) {
      tierName = "membership";
    }
    const endedOn = tiers.ukDayMonth(membership.getString("renews_at"));

    let pending = [];
    try {
      $app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("memberships", membership.id);
        live.set("status", "lapsed");
        txApp.save(live);

        const n = notifyLib.notify(txApp, {
          customer: live.getString("customer"),
          type: "membership_lapsed",
          title: `Your ${tierName} has ended`,
          body: `Your ${tierName} ended on ${endedOn}. Renew at the counter to keep its perks.`,
          link: "/account/guild",
          email: true,
        });
        pending = n.pending || [];
      });
    } catch (err) {
      console.log(`[cron:memberships_lapse] ${membership.id} failed: ${err}`);
      continue;
    }
    notifyLib.sendPending($app, pending);
    lapsed += 1;
  }

  if (lapsed > 0) {
    console.log(`[cron:memberships_lapse] lapsed ${lapsed} membership(s)`);
  }
});
