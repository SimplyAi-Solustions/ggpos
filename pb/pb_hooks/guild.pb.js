/// <reference path="../pb_data/types.d.ts" />

/**
 * guild.pb.js - My Vault's Guild pages (docs/PLAN.md, "Customers, 'My
 * Vault' > Guild"; docs/api-contract.md's Phase 6 section).
 *
 *   GET  /api/vault/me/guild    (customer)
 *   GET  /api/vault/me/points   (customer)
 *   POST /api/vault/guild/join  (customer, Phase 8)
 *
 * Both are read-only and both are about the caller alone: every query
 * filters on `e.auth.id`, so there is no id in either path to get wrong.
 * They exist because `loyalty_programme`, `loyalty_tiers` and
 * `loyalty_rewards` are admin-only through the collection API
 * (pb/README.md, "Known follow-ups"), and because a customer token cannot
 * read `perk_usage`, `memberships` or `referrals` at all.
 *
 * The tier and the window total are computed live from `points_ledger`
 * through lib/tiers.js, never read from `customer_private`'s cached
 * fields - the same rule GET /api/vault/me already follows for balances.
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

    // Phase 8: the paid plans a customer can ask to join online, and the
    // one waiting for payment at the counter, if they have asked.
    const membershipsLib = require(`${__hooks}/lib/memberships.js`);
    const plans = membershipsLib.paidPlans(e.app).map((row) => ({
      id: row.id,
      name: row.getString("name"),
      price: row.getInt("price"),
    }));
    const pendingRow = membershipsLib.latest(e.app, customer.id, "pending");
    const pending = pendingRow
      ? {
          id: pendingRow.id,
          tier: pendingRow.getString("tier"),
          tier_name: membershipsLib.tierName(e.app, pendingRow.getString("tier")),
          price: pendingRow.getInt("price"),
          created: pendingRow.getString("created"),
        }
      : null;

    return e.json(200, {
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
      pending: pending,
      plans: plans,
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
// POST /api/vault/guild/join   (customer, Phase 8)
//
// An expression of interest, paid for at the counter: a `pending`
// membership for a paid-plan tier, priced from the tier. One pending row
// at a time (asking again answers with the same row, switched to the tier
// asked for), and refused while a membership is already live. The Epos
// Now customer is created straight after (lib/eposnow.js), so the barcode
// My Vault shows attaches them at the till; if Epos Now is down the link
// is queued and retried, and the join itself has already succeeded.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/guild/join",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const membershipsLib = require(`${__hooks}/lib/memberships.js`);
    const epos = require(`${__hooks}/lib/eposnow.js`);

    const customer = e.auth;
    const body = util.body(e);
    const tierId = util.asStr(body.tier);

    let tier = null;
    try {
      tier = e.app.findRecordById("loyalty_tiers", tierId);
    } catch (err) {
      tier = null;
    }
    if (!tier || !tier.getBool("paid_plan")) {
      throw e.badRequestError("That plan is not one you can join. Pick one from the list.", {
        tier: new ValidationError("invalid", "Pick a plan from the list."),
      });
    }

    const active = membershipsLib.latest(e.app, customer.id, "active");
    if (active) {
      throw e.error(
        409,
        `You already have a ${membershipsLib.tierName(e.app, active.getString("tier")) || "Guild"} membership until ${membershipsLib.ukDate(active.getString("renews_at"))}. Renew it at the counter.`,
        null
      );
    }

    let membership = null;
    let created = false;
    e.app.runInTransaction((txApp) => {
      const existing = membershipsLib.latest(txApp, customer.id, "pending");
      if (existing) {
        membership = existing;
        if (existing.getString("tier") !== tier.id || existing.getInt("price") !== tier.getInt("price")) {
          existing.set("tier", tier.id);
          existing.set("price", tier.getInt("price"));
          txApp.save(existing);
        }
        return;
      }
      membership = new Record(txApp.findCollectionByNameOrId("memberships"), {
        customer: customer.id,
        tier: tier.id,
        status: "pending",
        price: tier.getInt("price"),
        payment_note: "Asked to join online. Pay at the counter.",
      });
      txApp.save(membership);
      created = true;

      auditLib.writeAuditLog(txApp, {
        actor: customer.id,
        action: "guild_join",
        collection: "memberships",
        record: membership.id,
        meta: { customer: customer.id, tier: tier.id, price: tier.getInt("price") },
        ip: e.realIP(),
      });
    });

    // Outside the transaction, and never able to fail the join.
    let link = null;
    try {
      epos.queue(e.app, customer.id);
      epos.link(e.app, customer.id, { actor: customer.id, ip: e.realIP() });
      link = epos.linkShape(epos.privateFor(e.app, customer.id));
    } catch (err) {
      console.log(`[guild:join] the Epos Now link for ${customer.id} did not run: ${err}`);
    }

    return e.json(created ? 201 : 200, {
      membership: membershipsLib.shape(e.app, e.app.findRecordById("memberships", membership.id)),
      till_ready: Boolean(link && link.status === "linked"),
    });
  },
  $apis.requireAuth("customers")
);
