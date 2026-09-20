/// <reference path="../pb_data/types.d.ts" />

/**
 * loyalty.pb.js - the loyalty engine's own hooks, the one admin route that
 * moves points by hand, and the two nightly passes over the ledger.
 *
 *   POST /api/vault/loyalty/adjust        (admin, step-up)
 *   cron tiers_recompute                  (03:30)
 *   cron points_expire                    (03:40)
 *
 * Hooks registered here:
 *  - `customers` on create: resolve a `referred_by` **code** into the
 *    customer it names, refusing one nobody holds or the customer's own.
 *  - `customers` after create: the welcome bonus, and the `pending`
 *    referrals row.
 *  - `points_ledger` after create: re-evaluate the tier from the rolling
 *    window, and clear the points-expiry warning whenever points come in.
 *  - `memberships` after create and after update: re-evaluate the tier,
 *    because a paid plan pins it.
 *  - `loyalty_programme`, `loyalty_rules`, `loyalty_tiers` and
 *    `loyalty_rewards` on write: the shape checks that keep a rule or a
 *    perk the evaluators cannot read out of the database in the first
 *    place, plus the "a tier in use cannot be deleted" guard.
 *
 * Everything that decides anything reads the ledger itself, never
 * `customer_private.points_balance` (CLAUDE.md's "Money"; lib/balances.js
 * and lib/tiers.js both say the same). Every multi-row write runs inside a
 * transaction, and every email a write produces is flushed with
 * lib/notify.js's `sendPending` once that transaction has returned.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// customers on create: referred_by is a customer CODE
//
// A separate registration from customers.pb.js's own create hook, which
// runs first (hook handlers fire in registration order, and pb_hooks files
// load in name order) and has already assigned this record's own `code` by
// the time this one sees it - which is what makes the "a customer cannot
// refer themselves" check below possible at all.
// ---------------------------------------------------------------------
onRecordCreate((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const referrals = require(`${__hooks}/lib/referrals.js`);

  // The relation field itself only ever holds a record id, so a GGC… code
  // has to be resolved before the record is validated and saved.
  const body = util.body(e);
  const raw = util.asStr(body.referred_by) || util.asStr(e.record.get("referred_by"));
  if (!raw) {
    e.next();
    return;
  }

  const ownCode = referrals.normalise(e.record.getString("code"));
  const given = referrals.normalise(raw);
  if (ownCode && given && ownCode === given) {
    throw e.badRequestError("A customer cannot refer themselves. Use the other person's code.", null);
  }

  const referrer = referrals.resolve(e.app, raw);
  if (!referrer) {
    throw e.badRequestError(referrals.unknownCodeMessage(raw), null);
  }
  if (referrer.id === e.record.id) {
    throw e.badRequestError("A customer cannot refer themselves. Use the other person's code.", null);
  }

  e.record.set("referred_by", referrer.id);
  e.next();
}, "customers");

// ---------------------------------------------------------------------
// customers after create: the welcome bonus and the pending referral
//
// Runs after customers.pb.js's own after-create hook, which is what
// creates the paired customer_private row the ledger's cached balance is
// written to; both writes here go through one transaction so a customer is
// never left with a bonus and no referral, or the other way round.
// ---------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const referrals = require(`${__hooks}/lib/referrals.js`);

  const customerId = e.record.id;
  const referrerId = e.record.getString("referred_by");
  const programme = util.programme(e.app);

  // Never twice for the same customer: a merge keeps the record it is
  // folding into, welcome row and all, and never asks for a second one.
  let alreadyWelcomed = false;
  try {
    alreadyWelcomed =
      e.app.findRecordsByFilter(
        "points_ledger",
        'customer = {:customer} && reason = "welcome"',
        "",
        1,
        0,
        { customer: customerId }
      ).length > 0;
  } catch (err) {
    alreadyWelcomed = false;
  }

  const wantsBonus = programme.enabled && programme.welcomeBonus > 0 && !alreadyWelcomed;
  if (wantsBonus || referrerId) {
    try {
      e.app.runInTransaction((txApp) => {
        if (wantsBonus) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customerId,
              delta: programme.welcomeBonus,
              reason: "welcome",
              ref: customerId,
            })
          );
        }
        if (referrerId) referrals.createPending(txApp, referrerId, customerId);
      });
    } catch (err) {
      console.log(`[loyalty] welcome bonus or referral failed for ${customerId}: ${err}`);
    }
  }

  e.next();
}, "customers");

// ---------------------------------------------------------------------
// points_ledger after create: the tier, and the expiry clock
//
// A separate registration from ledgers.pb.js's own after-create hook
// (which recomputes both cached balances): this one re-evaluates the tier
// from the rolling window and, whenever points actually come in, clears
// the "your points expire soon" stamp, because a positive row is exactly
// what resets the clock the warning was about.
// ---------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  const tiers = require(`${__hooks}/lib/tiers.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);

  const customerId = e.record.getString("customer");
  if (!customerId) {
    e.next();
    return;
  }

  let pending = [];
  try {
    e.app.runInTransaction((txApp) => {
      if (e.record.getInt("delta") > 0) {
        let priv = null;
        try {
          priv = txApp.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
            customer: customerId,
          });
        } catch (err) {
          priv = null;
        }
        if (priv && priv.getString("points_expiry_warned_at")) {
          priv.set("points_expiry_warned_at", "");
          txApp.save(priv);
        }
      }
      const result = tiers.recompute(txApp, customerId);
      pending = result.pending || [];
    });
  } catch (err) {
    console.log(`[loyalty] tier re-evaluation failed for ${customerId}: ${err}`);
  }
  notifyLib.sendPending(e.app, pending);

  e.next();
}, "points_ledger");

// ---------------------------------------------------------------------
// memberships: a paid plan pins a tier, so any change re-evaluates it
// ---------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  const tiers = require(`${__hooks}/lib/tiers.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);

  const customerId = e.record.getString("customer");
  let pending = [];
  if (customerId) {
    try {
      e.app.runInTransaction((txApp) => {
        pending = tiers.recompute(txApp, customerId).pending || [];
      });
    } catch (err) {
      console.log(`[loyalty] tier re-evaluation failed after a membership create: ${err}`);
    }
    notifyLib.sendPending(e.app, pending);
  }

  e.next();
}, "memberships");

onRecordAfterUpdateSuccess((e) => {
  const tiers = require(`${__hooks}/lib/tiers.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);

  const customerId = e.record.getString("customer");
  let pending = [];
  if (customerId) {
    try {
      e.app.runInTransaction((txApp) => {
        pending = tiers.recompute(txApp, customerId).pending || [];
      });
    } catch (err) {
      console.log(`[loyalty] tier re-evaluation failed after a membership update: ${err}`);
    }
    notifyLib.sendPending(e.app, pending);
  }

  e.next();
}, "memberships");

// ---------------------------------------------------------------------
// loyalty_rules: the conditions shape and the value the evaluator reads
//
// The evaluator in packages/shared reads `conditions` as plain JSON, so an
// unknown key there is silently ignored rather than applied - a rule saved
// with "kind" instead of "kinds", or "min_spend" instead of "minSpend",
// would look right in the editor and quietly earn the wrong points. It is
// refused here instead, naming the key.
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkRule(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_rules");

onRecordUpdateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkRule(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_rules");

// ---------------------------------------------------------------------
// loyalty_tiers: every perk has to parse, thresholds stay distinct, and a
// tier somebody is actually on cannot be deleted out from under them.
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkTier(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_tiers");

onRecordUpdateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkTier(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_tiers");

onRecordDeleteRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkTierDelete(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_tiers");

// ---------------------------------------------------------------------
// loyalty_rewards and loyalty_programme
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkReward(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_rewards");

onRecordUpdateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkReward(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_rewards");

onRecordUpdateRequest((e) => {
  const validate = require(`${__hooks}/lib/loyaltyconfig.js`);
  const refusal = validate.checkProgramme(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "loyalty_programme");

// ---------------------------------------------------------------------
// POST /api/vault/loyalty/adjust   (admin, step-up)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/loyalty/adjust",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const tiers = require(`${__hooks}/lib/tiers.js`);

    const staff = util.requireAdmin(e);
    stepup.requireStepUp(e);

    const body = util.body(e);
    const customerId = util.asStr(body.customer);
    const delta = util.asInt(body.delta, 0);
    const reason = util.asStr(body.reason);

    if (!customerId) {
      throw e.badRequestError("Pick the customer to adjust.", null);
    }
    let customer = null;
    try {
      customer = e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("That customer was not found. Search again.", null);
    }
    if (delta === 0) {
      throw e.badRequestError("An adjustment of 0 points changes nothing. Enter the points to add or remove.", null);
    }
    if (reason.length < 5 || reason.length > 500) {
      throw e.badRequestError("Say why, in 5 to 500 characters. It goes on the customer's record.", null);
    }

    const balanceBefore = balances.pointsBalance(e.app, customerId);
    if (balanceBefore + delta < 0) {
      throw e.error(
        422,
        `That would take them to ${tiers.formatPoints(balanceBefore + delta)} points. The most you can remove is ${tiers.formatPoints(balanceBefore)}.`,
        null
      );
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        // Re-read inside the transaction: two admins adjusting the same
        // customer at once must not both pass the check above.
        const live = balances.pointsBalance(txApp, customerId);
        if (live + delta < 0) {
          halt = {
            status: 422,
            message: `That would take them to ${tiers.formatPoints(live + delta)} points. The most you can remove is ${tiers.formatPoints(live)}.`,
          };
          throw new Error(halt.message);
        }

        const row = new Record(txApp.findCollectionByNameOrId("points_ledger"), {
          customer: customerId,
          delta: delta,
          reason: "adjust",
          ref: "",
          staff: staff.id,
        });
        txApp.save(row);

        txApp.save(
          new Record(txApp.findCollectionByNameOrId("notes"), {
            target_collection: "customers",
            target_record: customerId,
            body: reason,
            author: staff.id,
          })
        );

        // The reason itself stays on the note: audit_log is permanent and
        // superuser-only, so it carries identifiers and figures only.
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "points_adjust",
          collection: "points_ledger",
          record: row.id,
          meta: { customer: customerId, delta: delta, balance: live + delta },
          ip: e.realIP(),
        });

        result = { balance: balances.pointsBalance(txApp, customerId) };
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
// Cron: tiers_recompute, nightly at 03:30.
//
// The ledger hook above re-evaluates a tier the moment points move, which
// covers every promotion. A demotion needs this: points roll out of the
// rolling window with the passage of time alone, and nothing writes a row
// to notice it.
// ---------------------------------------------------------------------
cronAdd("tiers_recompute", "30 3 * * *", () => {
  const query = require(`${__hooks}/lib/reports/query.js`);
  const tiers = require(`${__hooks}/lib/tiers.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);

  const customers = query.findAllByFilter($app, "customers", "id != ''", "created", {});
  let changed = 0;
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    if (!customer) continue;
    let pending = [];
    try {
      $app.runInTransaction((txApp) => {
        const result = tiers.recompute(txApp, customer.id);
        if (result.changed) changed += 1;
        pending = result.pending || [];
      });
    } catch (err) {
      console.log(`[cron:tiers_recompute] ${customer.id} failed: ${err}`);
      continue;
    }
    notifyLib.sendPending($app, pending);
  }
  if (changed > 0) {
    console.log(`[cron:tiers_recompute] re-evaluated ${customers.length} customer(s), ${changed} tier change(s)`);
  }
});

// ---------------------------------------------------------------------
// Cron: points_expire, nightly at 03:40.
//
// Points expire after `loyalty_programme.expiry_months_inactive` months
// with no points coming in (0 turns expiry off entirely), with one warning
// thirty days before. Both the balance and the date it is measured from
// come from `points_ledger` itself.
// ---------------------------------------------------------------------
cronAdd("points_expire", "40 3 * * *", () => {
  const query = require(`${__hooks}/lib/reports/query.js`);
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const tiers = require(`${__hooks}/lib/tiers.js`);
  const quotes = require(`${__hooks}/lib/quotes.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);

  const programme = util.programme($app);
  if (!programme.enabled || programme.expiryMonthsInactive <= 0) return;

  const WARN_DAYS = 30;
  const now = new Date();
  const customers = query.findAllByFilter($app, "customers", "id != ''", "created", {});

  let expired = 0;
  let warned = 0;

  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    if (!customer) continue;

    const rows = tiers.pointsRows($app, customer.id); // newest first
    let balance = 0;
    let lastPositive = "";
    for (let r = 0; r < rows.length; r++) {
      balance += rows[r].delta;
      if (!lastPositive && rows[r].delta > 0) lastPositive = rows[r].created;
    }
    if (balance <= 0 || !lastPositive) continue;

    const from = new Date(String(lastPositive).replace(" ", "T"));
    if (isNaN(from.getTime())) continue;
    const expiresAt = util.addMonths(from, programme.expiryMonthsInactive);
    const warnFrom = new Date(expiresAt.getTime() - WARN_DAYS * 86400000);

    if (expiresAt.getTime() <= now.getTime()) {
      let pending = [];
      try {
        $app.runInTransaction((txApp) => {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customer.id,
              delta: -balance,
              reason: "expire",
              ref: "",
            })
          );
          let priv = null;
          try {
            priv = txApp.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
              customer: customer.id,
            });
          } catch (err) {
            priv = null;
          }
          if (priv && priv.getString("points_expiry_warned_at")) {
            priv.set("points_expiry_warned_at", "");
            txApp.save(priv);
          }
          const n = notifyLib.notify(txApp, {
            customer: customer.id,
            type: "points_expired",
            title: "Your points have expired",
            body: `${tiers.formatPoints(balance)} points expired after ${programme.expiryMonthsInactive} months without a purchase. Buying or trading anything starts them again.`,
            link: "/account/guild",
            email: true,
          });
          pending = n.pending || [];
        });
      } catch (err) {
        console.log(`[cron:points_expire] ${customer.id} failed: ${err}`);
        continue;
      }
      notifyLib.sendPending($app, pending);
      expired += 1;
      continue;
    }

    if (warnFrom.getTime() > now.getTime()) continue;

    let priv = null;
    try {
      priv = $app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
        customer: customer.id,
      });
    } catch (err) {
      priv = null;
    }
    // Once per run-up, not once a night for thirty nights. The stamp is
    // cleared the moment points come in again (the ledger hook above), so
    // the next run-up warns again.
    if (!priv || priv.getString("points_expiry_warned_at")) continue;

    let warnPending = [];
    try {
      $app.runInTransaction((txApp) => {
        const livePriv = txApp.findRecordById("customer_private", priv.id);
        livePriv.set("points_expiry_warned_at", now.toISOString());
        txApp.save(livePriv);
        const n = notifyLib.notify(txApp, {
          customer: customer.id,
          type: "points_expiring",
          title: `Your ${tiers.formatPoints(balance)} points expire soon`,
          body: `Your ${tiers.formatPoints(balance)} points expire on ${quotes.ukDateShort(expiresAt.toISOString())}. Any purchase keeps them.`,
          link: "/account/guild",
          email: true,
        });
        warnPending = n.pending || [];
      });
    } catch (err) {
      console.log(`[cron:points_expire] warning for ${customer.id} failed: ${err}`);
      continue;
    }
    notifyLib.sendPending($app, warnPending);
    warned += 1;
  }

  if (expired > 0 || warned > 0) {
    console.log(`[cron:points_expire] expired=${expired} warned=${warned}`);
  }
});
