/// <reference path="../pb_data/types.d.ts" />

/**
 * guild.pb.js - My Vault's Guild pages (docs/PLAN.md, "Customers, 'My
 * Vault' > Guild"; docs/api-contract.md's Phase 6 section), and since the
 * launch joining the Guild (docs/api-contract-launch.md, section 2).
 *
 *   GET  /api/vault/me/guild        (customer)
 *   GET  /api/vault/me/points       (customer)
 *   POST /api/vault/guild/join      (staff)
 *   POST /api/vault/me/guild/join   (customer, on accepting the terms)
 *   customers, on update: `guild_joined_at` set once and never moved
 *
 * The two GETs are read-only and both are about the caller alone: every
 * query filters on `e.auth.id`, so there is no id in either path to get
 * wrong. They exist because `loyalty_programme`, `loyalty_tiers` and
 * `loyalty_rewards` are admin-only through the collection API
 * (pb/README.md, "Known follow-ups"), and because a customer token cannot
 * read `perk_usage`, `memberships` or `referrals` at all.
 *
 * The tier and the window total are computed live from `points_ledger`
 * through lib/tiers.js, never read from `customer_private`'s cached
 * fields - the same rule GET /api/vault/me already follows for balances.
 *
 * Joining is lib/guild.js: the date, the welcome bonus once whatever path
 * the customer joins by, and the Guild card notification, in one
 * transaction, with its email sent after it commits.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/me/guild   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/me/guild",
  (e) => {
    const tiersLib = require(`${__hooks}/lib/tiers.js`);
    const perksLib = require(`${__hooks}/lib/perks.js`);
    const referralsLib = require(`${__hooks}/lib/referrals.js`);
    const loyalty = require(`${__hooks}/lib/shared/loyalty.js`);

    const customer = e.auth;
    const now = new Date();
    const state = tiersLib.evaluate(e.app, customer.id, now);

    let pointsName = "points";
    try {
      const programmeRow = e.app.findFirstRecordByFilter("loyalty_programme", "id != ''");
      pointsName = programmeRow.getString("points_name") || pointsName;
    } catch (err) {
      pointsName = "points";
    }

    const next = loyalty.pointsToNextTier(state.tiers, state.windowPoints);

    let membership = null;
    if (state.membership) {
      let tierName = "";
      try {
        tierName = e.app
          .findRecordById("loyalty_tiers", state.membership.getString("tier"))
          .getString("name");
      } catch (err) {
        tierName = "";
      }
      membership = { tier_name: tierName, renews_at: state.membership.getString("renews_at") };
    }

    let vouchersOpen = 0;
    try {
      vouchersOpen = e.app.findRecordsByFilter(
        "reward_redemptions",
        'customer = {:customer} && status = "issued"',
        "",
        0,
        0,
        { customer: customer.id }
      ).length;
    } catch (err) {
      vouchersOpen = 0;
    }

    const counts = referralsLib.countsFor(e.app, customer.id);

    // The launch: whether they are in the Guild yet, and the terms and
    // bonus My Vault shows a customer who is not (docs/api-contract-launch.md,
    // section 2).
    const guildLib = require(`${__hooks}/lib/guild.js`);
    let terms = "";
    try {
      terms = e.app.findFirstRecordByFilter("loyalty_programme", "id != ''").getString("terms");
    } catch (err) {
      terms = "";
    }

    return e.json(200, {
      member: guildLib.isMember(customer),
      joined_at: customer.getString("guild_joined_at") || null,
      terms: terms,
      welcome_bonus: state.programme.enabled ? state.programme.welcomeBonus : 0,
      points_name: pointsName,
      tier: state.tier ? { id: state.tier.id, name: state.tier.name } : null,
      window_points: state.windowPoints,
      next: next ? { name: next.tier.name, points_needed: next.points } : null,
      membership: membership,
      perks: perksLib.walletFor(e.app, customer.id, state.tier, now),
      referral: {
        code: customer.getString("code"),
        bonus_referrer: state.programme.referralBonusReferrer,
        bonus_referee: state.programme.referralBonusReferee,
        earned: counts.earned,
        pending: counts.pending,
      },
      vouchers_open: vouchersOpen,
    });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/me/points   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/me/points",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const customer = e.auth;
    const programme = util.programme(e.app);

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("points_ledger", "customer = {:customer}", "-created", 100, 0, {
        customer: customer.id,
      });
    } catch (err) {
      rows = [];
    }

    // One lookup per distinct reference, not one per row: a customer with
    // a hundred rows from a handful of sales reads those sales once.
    const saleTotals = {};
    function saleTotalFor(number) {
      if (!number) return null;
      if (saleTotals[number] !== undefined) return saleTotals[number];
      let total = null;
      try {
        total = e.app
          .findFirstRecordByFilter("sales", "number = {:number}", { number: number })
          .getInt("total");
      } catch (err) {
        total = null;
      }
      saleTotals[number] = total;
      return total;
    }

    const rewardNames = {};
    function rewardNameFor(redemptionId) {
      if (!redemptionId) return "";
      if (rewardNames[redemptionId] !== undefined) return rewardNames[redemptionId];
      let name = "";
      try {
        const redemption = e.app.findRecordById("reward_redemptions", redemptionId);
        name = e.app.findRecordById("loyalty_rewards", redemption.getString("reward")).getString("name");
      } catch (err) {
        name = "";
      }
      rewardNames[redemptionId] = name;
      return name;
    }

    /** A short sentence per reason, the one place this wording lives. */
    function noteFor(row) {
      const reason = row.getString("reason");
      const ref = row.getString("ref");
      switch (reason) {
        case "earn_sale": {
          const total = saleTotalFor(ref);
          return total === null ? "Earned on a sale" : `Earned on a ${money.formatGBP(total)} sale`;
        }
        case "earn_trade_in":
          return ref ? `Earned on buy-in ${ref}` : "Earned on a buy-in";
        case "rule_bonus":
          return "Bonus points";
        case "welcome":
          return "Welcome bonus";
        case "referral":
          return "Referral bonus";
        case "redeem": {
          const name = rewardNameFor(ref);
          return name ? `Redeemed for ${name}` : "Redeemed for a reward";
        }
        case "adjust":
          return "Adjusted by the shop";
        case "expire":
          return programme.expiryMonthsInactive > 0
            ? `Expired after ${programme.expiryMonthsInactive} months without a purchase`
            : "Expired";
        case "refund_reverse":
          return "Reversed with a refund";
        default:
          return "";
      }
    }

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      out.push({
        id: row.id,
        delta: row.getInt("delta"),
        reason: row.getString("reason"),
        balance_after: row.getInt("balance_after"),
        created: row.getString("created"),
        note: noteFor(row),
      });
    }

    return e.json(200, { rows: out });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/guild/join   (staff)
//
// docs/api-contract-launch.md, section 2: `{ customer?, name?, email?,
// phone?, marketing_consent, birthday_month? }`. With `customer`, that
// customer joins; without, a new customer is made and joins in the same
// transaction (a name and an email or a phone). Answers
// `{ customer: { id, name, code }, points_balance, welcome_points }`.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/guild/join",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const guildLib = require(`${__hooks}/lib/guild.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const staff = e.auth;
    const body = util.body(e);
    const customerId = util.asStr(body.customer);
    const name = util.asStr(body.name);
    const email = util.asStr(body.email).toLowerCase();
    const phone = util.asStr(body.phone);
    const consentSent = body.marketing_consent !== undefined && body.marketing_consent !== null;
    const consent = util.asBool(body.marketing_consent);

    let birthdayMonth = 0;
    if (body.birthday_month !== undefined && body.birthday_month !== null && body.birthday_month !== "") {
      birthdayMonth = util.asInt(body.birthday_month, 0);
      if (birthdayMonth < 1 || birthdayMonth > 12 || Number(body.birthday_month) !== birthdayMonth) {
        throw e.badRequestError("A birthday month is a number from 1 to 12.", null);
      }
    }

    /** The 409 for an email or phone already on somebody else, naming them. */
    function clashResponse(clash) {
      return e.json(409, {
        status: 409,
        message: guildLib.clashMessage(clash),
        data: {},
        customer: guildLib.customerShape(clash.customer),
      });
    }

    let existing = null;
    if (customerId) {
      try {
        existing = e.app.findRecordById("customers", customerId);
      } catch (err) {
        throw e.notFoundError("That customer no longer exists. Search again.", null);
      }
      if (guildLib.isMember(existing)) {
        throw e.error(409, `${existing.getString("name")} is already in the Guild.`, null);
      }
    } else {
      if (!name || (!email && !phone)) {
        throw e.badRequestError("Add a name and an email or a phone number.", null);
      }
      if (name.length > 200) {
        throw e.badRequestError("That name is too long. Keep it to 200 characters.", null);
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw e.badRequestError("That email address does not look right. Check it and try again.", null);
      }
      if (phone.length > 32) {
        throw e.badRequestError("That phone number is too long. Check it and try again.", null);
      }
      const clash = guildLib.findClash(e.app, email, phone, "");
      if (clash) return clashResponse(clash);
    }

    let halt = null;
    let clashed = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        let customer = null;
        if (existing) {
          // Re-read: the other till may have joined them a moment ago.
          customer = txApp.findRecordById("customers", existing.id);
          if (guildLib.isMember(customer)) {
            halt = { status: 409, message: `${customer.getString("name")} is already in the Guild.` };
            throw new Error(halt.message);
          }
        } else {
          const clash = guildLib.findClash(txApp, email, phone, "");
          if (clash) {
            clashed = clash;
            throw new Error("clash");
          }
          customer = new Record(txApp.findCollectionByNameOrId("customers"));
          customer.set("name", name);
          if (email) customer.set("email", email);
          if (phone) customer.set("phone", phone);
          customer.set("source", "counter");
          customer.set("marketing_consent", consent);
          // OTP only: the password exists because every auth record has one
          // (customers.pb.js does the same for the collection API).
          customer.setRandomPassword();
        }

        const done = guildLib.join(txApp, customer, {
          staffId: staff.id,
          marketingConsent: consentSent ? consent : null,
          birthdayMonth: birthdayMonth || null,
        });

        // Identifiers and the shop's own figures only (pb/README.md,
        // "Audit meta stays to identifiers").
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "guild_join",
          collection: "customers",
          record: customer.id,
          meta: { welcome_points: done.points, created: !existing, by: "staff" },
          ip: e.realIP(),
        });

        result = { customer: customer, points: done.points, pending: done.pending };
      });
    } catch (err) {
      if (clashed) return clashResponse(clashed);
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    notifyLib.sendPending(e.app, result.pending);

    return e.json(200, {
      customer: guildLib.customerShape(result.customer),
      points_balance: balances.pointsBalance(e.app, result.customer.id),
      welcome_points: result.points,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/me/guild/join   (customer)
//
// My Vault's side of joining (docs/api-contract-launch.md, section 2: "asks
// for the Guild's terms and joins on acceptance"). `{ terms_accepted: true,
// marketing_consent? }`. Answers `{ joined_at, points_balance,
// welcome_points }`.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/me/guild/join",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const guildLib = require(`${__hooks}/lib/guild.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const body = util.body(e);
    if (!util.asBool(body.terms_accepted)) {
      throw e.badRequestError("Read the Guild terms and agree to them to join.", null);
    }
    const consentSent = body.marketing_consent !== undefined && body.marketing_consent !== null;
    const consent = util.asBool(body.marketing_consent);

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const customer = txApp.findRecordById("customers", e.auth.id);
        if (guildLib.isMember(customer)) {
          halt = { status: 409, message: "You are already in the Guild." };
          throw new Error(halt.message);
        }
        const done = guildLib.join(txApp, customer, {
          marketingConsent: consentSent ? consent : null,
        });
        auditLib.writeAuditLog(txApp, {
          actor: customer.id,
          action: "guild_join",
          collection: "customers",
          record: customer.id,
          meta: { welcome_points: done.points, created: false, by: "customer" },
          ip: e.realIP(),
        });
        result = { joinedAt: done.joinedAt, points: done.points, pending: done.pending };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    notifyLib.sendPending(e.app, result.pending);

    return e.json(200, {
      joined_at: result.joinedAt,
      points_balance: balances.pointsBalance(e.app, e.auth.id),
      welcome_points: result.points,
    });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// customers, on update through the collection API: `guild_joined_at` is
// set once and then never moved or cleared, whoever sends it. Setting it
// on somebody who is not a member is joining, so it is stamped with now and
// gets the welcome bonus and the Guild card exactly as the routes above
// give them ("the welcome bonus once per customer whatever path they join
// by"). The bonus goes in after the customer's own save, in a transaction
// of its own, the same shape loyalty.pb.js's create hook uses.
// ---------------------------------------------------------------------
onRecordUpdateRequest((e) => {
  const before = e.record.original().getString("guild_joined_at");
  const sent = e.record.getString("guild_joined_at");
  let joining = false;
  if (before) {
    if (sent !== before) e.record.set("guild_joined_at", before);
  } else if (sent) {
    e.record.set("guild_joined_at", new Date().toISOString());
    joining = true;
  }

  e.next();

  if (!joining) return;
  const guildLib = require(`${__hooks}/lib/guild.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);
  const actor = e.auth ? e.auth.id : "system";
  const byStaff = !!(e.auth && e.auth.collection().name === "staff");
  let pending = [];
  try {
    e.app.runInTransaction((txApp) => {
      const live = txApp.findRecordById("customers", e.record.id);
      const done = guildLib.welcome(txApp, live, { staffId: byStaff ? actor : "" });
      pending = done.pending;
      auditLib.writeAuditLog(txApp, {
        actor: actor,
        action: "guild_join",
        collection: "customers",
        record: live.id,
        meta: { welcome_points: done.points, created: false, by: byStaff ? "staff" : "customer" },
        ip: e.realIP(),
      });
    });
  } catch (err) {
    console.log(`[guild] welcome on joining failed for ${e.record.id}: ${err}`);
  }
  notifyLib.sendPending(e.app, pending);
}, "customers");
