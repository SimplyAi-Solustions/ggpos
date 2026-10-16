/// <reference path="../pb_data/types.d.ts" />

/**
 * rewards.pb.js - the rewards catalogue, redeeming one, and the vouchers
 * that come out of it (docs/api-contract.md's Phase 6 section).
 *
 *   GET  /api/vault/rewards                  (customer)
 *   POST /api/vault/rewards/{id}/redeem      (customer)
 *   GET  /api/vault/me/vouchers              (customer)
 *   GET  /api/vault/vouchers/{code}          (staff)
 *   POST /api/vault/vouchers/{code}/use      (staff)
 *   POST /api/vault/vouchers/{code}/cancel   (admin)
 *   cron vouchers_expire                     (nightly)
 *
 * `loyalty_rewards` is admin-only through the collection API, so these two
 * customer routes are the portal's only window onto it - the read-only
 * server-side route pb/README.md's "Known follow-ups" proposed rather than
 * loosening the rule.
 *
 * A redemption is money: the whole of it (the voucher, the points row,
 * and for a store-credit reward the credit row too) is one
 * `runInTransaction`, every figure is re-checked against live rows inside
 * it, and the points balance is summed from the ledger, never read from
 * `customer_private.points_balance`.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/rewards   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/rewards",
  (e) => {
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);
    return e.json(200, { rewards: rewardsLib.listFor(e.app, e.auth.id, e.auth, new Date()) });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/rewards/{id}/redeem   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/rewards/{id}/redeem",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotes = require(`${__hooks}/lib/quotes.js`);

    const customer = e.auth;
    const rewardId = e.request.pathValue("id");
    const now = new Date();

    let reward = null;
    try {
      reward = e.app.findRecordById("loyalty_rewards", rewardId);
    } catch (err) {
      throw e.notFoundError("That reward is not in the list. Pick another one.", null);
    }
    if (!reward.getBool("active")) {
      throw e.error(422, "That reward is not available now. Pick another one from the list.", null);
    }
    const endsAt = reward.getString("ends_at");
    if (endsAt && util.isPast(String(endsAt).replace(" ", "T"), now)) {
      throw e.error(
        422,
        `That reward finished on ${quotes.ukDateShort(endsAt)}. Pick another one from the list.`,
        null
      );
    }

    const programme = util.programme(e.app);
    if (!programme.enabled) {
      throw e.error(422, "The rewards programme is switched off at the moment. Ask at the counter.", null);
    }

    const cost = reward.getInt("cost_points");
    const balance = balances.pointsBalance(e.app, customer.id);
    const stockLimit = reward.getInt("stock_limit");
    const perCustomerLimit = reward.getInt("per_customer_limit");
    const remaining = stockLimit > 0 ? stockLimit - rewardsLib.takenCount(e.app, reward.id, "") : null;
    const perCustomerRemaining =
      perCustomerLimit > 0 ? perCustomerLimit - rewardsLib.takenCount(e.app, reward.id, customer.id) : null;
    const reason = rewardsLib.reasonFor(reward, now, balance, remaining, perCustomerRemaining);
    if (reason !== "ok") {
      throw e.error(422, rewardsLib.reasonMessage(reason, reward, balance), null);
    }

    const days = rewardsLib.voucherDays(e.app, null);
    const expiresAt = new Date(now.getTime() + days * 86400000).toISOString();

    let halt = null;
    let result = null;
    let pending = [];

    try {
      e.app.runInTransaction((txApp) => {
        // Live re-checks: two tabs, or two devices, must not both spend
        // the same points or take the last one of a limited reward.
        const liveReward = txApp.findRecordById("loyalty_rewards", reward.id);
        const liveBalance = balances.pointsBalance(txApp, customer.id);
        const liveRemaining =
          stockLimit > 0 ? liveReward.getInt("stock_limit") - rewardsLib.takenCount(txApp, liveReward.id, "") : null;
        const livePerCustomer =
          perCustomerLimit > 0
            ? liveReward.getInt("per_customer_limit") - rewardsLib.takenCount(txApp, liveReward.id, customer.id)
            : null;
        const liveReason = rewardsLib.reasonFor(liveReward, now, liveBalance, liveRemaining, livePerCustomer);
        if (liveReason !== "ok") {
          halt = { status: 422, message: rewardsLib.reasonMessage(liveReason, liveReward, liveBalance) };
          throw new Error(halt.message);
        }

        // The redemption first: its own create hook assigns the GG-V-…
        // number and the GGV… code, and the points row refs it.
        const redemption = new Record(txApp.findCollectionByNameOrId("reward_redemptions"), {
          customer: customer.id,
          reward: liveReward.id,
          points_spent: cost,
          status: "issued",
          expires_at: expiresAt,
        });
        txApp.save(redemption);

        if (cost > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customer.id,
              delta: -cost,
              reason: "redeem",
              ref: redemption.id,
            })
          );
        }

        // A store-credit reward is the credit: there is nothing to bring
        // to the counter, so the voucher is spent the moment it is made.
        if (liveReward.getString("type") === "store_credit") {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
              customer: customer.id,
              amount: liveReward.getInt("value"),
              reason: "reward",
              ref: redemption.getString("number"),
            })
          );
          redemption.set("status", "used");
          txApp.save(redemption);
        }

        const n = notifyLib.notify(txApp, {
          customer: customer.id,
          type: "reward_issued",
          title: `Your reward is ready: ${liveReward.getString("name")}`,
          body:
            liveReward.getString("type") === "store_credit"
              ? `${liveReward.getString("name")} is on your account as store credit. Spend it next time you are in.`
              : `${liveReward.getString("name")} is ready. Show the code in My Vault at the counter.`,
          link: "/account/rewards",
          email: true,
        });
        pending = n.pending || [];

        auditLib.writeAuditLog(txApp, {
          actor: customer.id,
          action: "reward_redeem",
          collection: "reward_redemptions",
          record: redemption.id,
          meta: { customer: customer.id, reward: liveReward.id, points_spent: cost },
          ip: e.realIP(),
        });

        result = { voucher: rewardsLib.voucherShape(txApp, redemption) };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    notifyLib.sendPending(e.app, pending);
    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/me/vouchers   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/me/vouchers",
  (e) => {
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("reward_redemptions", "customer = {:customer}", "-created", 100, 0, {
        customer: e.auth.id,
      });
    } catch (err) {
      rows = [];
    }
    const vouchers = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) vouchers.push(rewardsLib.voucherShape(e.app, rows[i]));
    }
    return e.json(200, { vouchers: vouchers });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/vouchers/{code}   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/vouchers/{code}",
  (e) => {
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);

    const redemption = rewardsLib.findByCode(e.app, e.request.pathValue("code"));
    if (!redemption) {
      throw e.notFoundError("No voucher with that code. Check it or scan it again.", null);
    }

    const voucher = rewardsLib.voucherShape(e.app, redemption);
    let customer = null;
    try {
      customer = e.app.findRecordById("customers", redemption.getString("customer"));
    } catch (err) {
      customer = null;
    }
    voucher.customer = customer
      ? { id: customer.id, code: customer.getString("code"), name: customer.getString("name") }
      : null;

    return e.json(200, { voucher: voucher });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/vouchers/{code}/use   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/vouchers/{code}/use",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotes = require(`${__hooks}/lib/quotes.js`);

    const staff = e.auth;
    const now = new Date();
    const redemption = rewardsLib.findByCode(e.app, e.request.pathValue("code"));
    if (!redemption) {
      throw e.notFoundError("No voucher with that code. Check it or scan it again.", null);
    }

    let reward = null;
    try {
      reward = e.app.findRecordById("loyalty_rewards", redemption.getString("reward"));
    } catch (err) {
      reward = null;
    }
    const type = reward ? reward.getString("type") : "";

    // Money off is applied to a basket, not ticked off at the counter:
    // the Sell screen takes the code and checks the discount matches.
    if (type === "money_off") {
      throw e.error(409, "Use this one on the sale: scan it at Sell.", null);
    }
    if (!rewardsLib.isCounterType(type)) {
      throw e.error(409, "This voucher is not one the counter marks used. Check the rewards list.", null);
    }

    const status = redemption.getString("status");
    if (status !== "issued") {
      const wording = {
        used: "That voucher has already been used.",
        expired: "That voucher has expired.",
        cancelled: "That voucher was cancelled.",
      };
      throw e.error(409, `${wording[status] || "That voucher cannot be used."} Ask an admin if it should be reissued.`, null);
    }
    const expiresAt = redemption.getString("expires_at");
    if (expiresAt && util.isPast(String(expiresAt).replace(" ", "T"), now)) {
      throw e.error(
        409,
        `That voucher expired on ${quotes.ukDateShort(expiresAt)}. Ask an admin if it should be reissued.`,
        null
      );
    }

    let halt = null;
    let result = null;
    let pending = [];

    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("reward_redemptions", redemption.id);
        if (live.getString("status") !== "issued") {
          halt = { status: 409, message: "That voucher has already been used." };
          throw new Error(halt.message);
        }
        live.set("status", "used");
        live.set("used_by", staff.id);
        txApp.save(live);

        const n = notifyLib.notify(txApp, {
          customer: live.getString("customer"),
          type: "reward_used",
          title: "Your reward has been used",
          body: `${reward ? reward.getString("name") : "Your reward"} was used at the counter.`,
          link: "/account/rewards",
          email: false,
        });
        pending = n.pending || [];

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "voucher_use",
          collection: "reward_redemptions",
          record: live.id,
          meta: {
            number: live.getString("number"),
            customer: live.getString("customer"),
            reward: live.getString("reward"),
          },
          ip: e.realIP(),
        });

        result = { voucher: rewardsLib.voucherShape(txApp, live) };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    notifyLib.sendPending(e.app, pending);
    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/vouchers/{code}/cancel   (admin)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/vouchers/{code}/cancel",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const sku = require(`${__hooks}/lib/shared/sku.js`);

    const staff = util.requireAdmin(e);
    const redemption = rewardsLib.findByCode(e.app, e.request.pathValue("code"));
    if (!redemption) {
      throw e.notFoundError("No voucher with that code. Check it or scan it again.", null);
    }
    if (redemption.getString("status") !== "issued") {
      throw e.error(
        409,
        `That voucher is ${redemption.getString("status")}, so there is nothing to cancel.`,
        null
      );
    }

    let reward = null;
    try {
      reward = e.app.findRecordById("loyalty_rewards", redemption.getString("reward"));
    } catch (err) {
      reward = null;
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("reward_redemptions", redemption.id);
        if (live.getString("status") !== "issued") {
          halt = { status: 409, message: "That voucher has already been used or cancelled." };
          throw new Error(halt.message);
        }
        live.set("status", "cancelled");
        txApp.save(live);

        const points = live.getInt("points_spent");
        if (points > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: live.getString("customer"),
              delta: points,
              reason: "adjust",
              ref: live.id,
              staff: staff.id,
            })
          );
        }

        txApp.save(
          new Record(txApp.findCollectionByNameOrId("notes"), {
            target_collection: "customers",
            target_record: live.getString("customer"),
            body: `Voucher ${sku.displayCode(live.getString("code"))} (${reward ? reward.getString("name") : "reward"}) cancelled, ${points} points returned.`,
            author: staff.id,
          })
        );

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "voucher_cancel",
          collection: "reward_redemptions",
          record: live.id,
          meta: {
            number: live.getString("number"),
            customer: live.getString("customer"),
            points_returned: points,
          },
          ip: e.realIP(),
        });

        result = { voucher: rewardsLib.voucherShape(txApp, live) };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// Cron: vouchers_expire, nightly at 03:50.
// ---------------------------------------------------------------------
cronAdd("vouchers_expire", "50 3 * * *", () => {
  const rewardsLib = require(`${__hooks}/lib/rewards.js`);
  const expired = rewardsLib.expireVouchers($app, new Date());
  if (expired > 0) {
    console.log(`[cron:vouchers_expire] expired ${expired} voucher(s)`);
  }
});
