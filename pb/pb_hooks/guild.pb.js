/// <reference path="../pb_data/types.d.ts" />

/**
 * guild.pb.js - My Vault's Guild pages (docs/PLAN.md, "Customers, 'My
 * Vault' > Guild"; docs/api-contract.md's Phase 6 section).
 *
 *   GET /api/vault/me/guild    (customer)
 *   GET /api/vault/me/points   (customer)
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
    const util = require(`${__hooks}/lib/vaultutil.js`);
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
