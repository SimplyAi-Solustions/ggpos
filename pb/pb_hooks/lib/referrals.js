/**
 * Referrals: resolving the code a new customer names, and paying both
 * sides once that customer actually trades (docs/api-contract.md's Phase 6
 * section; docs/PLAN.md's "Loyalty engine": "the referee's first completed
 * sale or buy-in earns both sides").
 *
 * The customer-facing referral code is simply the referrer's own
 * `customers.code` - there is no second code to keep in step - so this
 * resolves a `GGC…` through the shared code parser, the same one
 * customers.pb.js generates it with.
 *
 * `onFirstCompletion()` writes through whatever `app` it is handed and
 * opens no transaction of its own: both callers (the sale and the
 * trade-in completion routes) are already inside one, and the two ledger
 * rows plus the referral's own status change must be atomic with the
 * completion that earned them. Emails come back as `pending` for the
 * caller to flush with lib/notify.js's `sendPending` once that
 * transaction has committed.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** A scanned or typed code in its stored form (uppercase, no hyphen), or "". */
function normalise(value) {
  var sku = require(`${__hooks}/lib/shared/sku.js`);
  if (!value) return "";
  return sku.normaliseCode(String(value));
}

/** The refusal for a code nobody holds, naming it in its printed form. */
function unknownCodeMessage(value) {
  var sku = require(`${__hooks}/lib/shared/sku.js`);
  var shown = sku.displayCode(normalise(value)) || String(value || "");
  return `No customer has the code ${shown}. Check it with them.`;
}

/**
 * The customer a `referred_by` value names: a `GGC…` code (what staff and
 * the portal actually pass) or, for an internal caller, a plain record id.
 * null when neither resolves.
 */
function resolve(app, value) {
  var raw = String(value || "").trim();
  if (!raw) return null;

  var code = normalise(raw);
  if (code) {
    try {
      return app.findFirstRecordByFilter("customers", "code = {:code}", { code: code });
    } catch (err) {
      // fall through to the id lookup
    }
  }
  try {
    return app.findRecordById("customers", raw);
  } catch (err) {
    return null;
  }
}

/** The customer's own pending referral (as the referee), or null. */
function pendingFor(app, customerId) {
  if (!customerId) return null;
  try {
    return app.findFirstRecordByFilter("referrals", 'referee = {:id} && status = "pending"', {
      id: customerId,
    });
  } catch (err) {
    return null;
  }
}

/** One `pending` referrals row, unless this referee already has one. */
function createPending(app, referrerId, refereeId) {
  if (!referrerId || !refereeId || referrerId === refereeId) return null;
  var existing = null;
  try {
    existing = app.findFirstRecordByFilter("referrals", "referee = {:id}", { id: refereeId });
  } catch (err) {
    existing = null;
  }
  if (existing) return existing;

  var record = new Record(app.findCollectionByNameOrId("referrals"), {
    referrer: referrerId,
    referee: refereeId,
    status: "pending",
  });
  app.save(record);
  return record;
}

/**
 * Called from the sale and trade-in completion routes, inside their own
 * transaction, with the customer who just completed one. A `pending`
 * referral where they are the referee becomes `earned` and both sides are
 * paid; anything else is a no-op, so a second or a fiftieth completion
 * never pays twice.
 *
 * @param {any} app - the caller's txApp.
 * @returns {{earned: boolean, referral: string, pending: Array}}
 */
function onFirstCompletion(app, customerId, staffId, ref) {
  var out = { earned: false, referral: "", pending: [] };
  if (!customerId) return out;

  var referral = pendingFor(app, customerId);
  if (!referral) return out;

  // A row with the same customer at both ends pays two bonuses to one
  // person. It should not exist - customers.pb.js refuses a self-referral
  // at creation and customerops.pb.js's merge deletes a row whose two ends
  // would fold together - but this is money, so it is refused here as well
  // rather than trusted to the two places that stop it being written.
  if (referral.getString("referrer") === customerId) return out;

  var util = require(`${__hooks}/lib/vaultutil.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  var tiers = require(`${__hooks}/lib/tiers.js`);

  var programme = util.programme(app);
  // A referral that lands while the programme is switched off stays
  // pending rather than being quietly written off: switching the
  // programme back on is meant to honour it.
  if (!programme.enabled) return out;

  var referrerId = referral.getString("referrer");
  referral.set("status", "earned");
  referral.set("earned_at", new Date().toISOString());
  app.save(referral);

  var ledger = app.findCollectionByNameOrId("points_ledger");
  if (referrerId && programme.referralBonusReferrer > 0) {
    var referrerRow = new Record(ledger, {
      customer: referrerId,
      delta: programme.referralBonusReferrer,
      reason: "referral",
      ref: referral.id,
    });
    if (staffId) referrerRow.set("staff", staffId);
    app.save(referrerRow);
  }
  if (programme.referralBonusReferee > 0) {
    var refereeRow = new Record(ledger, {
      customer: customerId,
      delta: programme.referralBonusReferee,
      reason: "referral",
      ref: referral.id,
    });
    if (staffId) refereeRow.set("staff", staffId);
    app.save(refereeRow);
  }

  // Neither body names the other person: the referrer already knows who
  // they referred, and a notification is not the place to hand one
  // customer another's name.
  if (referrerId) {
    var referrerNote = notifyLib.notify(app, {
      customer: referrerId,
      type: "referral_earned",
      title: "Your referral bonus is in",
      body: `Someone you referred has traded with us for the first time. ${tiers.formatPoints(programme.referralBonusReferrer)} points are on your account.`,
      link: "/account/guild",
      email: true,
    });
    out.pending = out.pending.concat(referrerNote.pending || []);
  }
  var refereeNote = notifyLib.notify(app, {
    customer: customerId,
    type: "referral_earned",
    title: "Your referral bonus is in",
    body: `Thanks for using a referral code. ${tiers.formatPoints(programme.referralBonusReferee)} points are on your account.`,
    link: "/account/guild",
    email: true,
  });
  out.pending = out.pending.concat(refereeNote.pending || []);

  out.earned = true;
  out.referral = referral.id;
  if (ref) {
    // Left deliberately unused on the ledger rows: `ref` there is the
    // referral's own id, so the audit trail always points back at the
    // referral rather than at whichever sale happened to trigger it.
    out.trigger = String(ref);
  }
  return out;
}

/** {earned, pending} counts for one customer's own referrals, for the portal. */
function countsFor(app, customerId) {
  function count(filter) {
    try {
      return app.findRecordsByFilter("referrals", filter, "", 0, 0, { id: customerId }).length;
    } catch (err) {
      return 0;
    }
  }
  return {
    earned: count('referrer = {:id} && status = "earned"'),
    pending: count('referrer = {:id} && status = "pending"'),
  };
}

module.exports = {
  normalise: normalise,
  unknownCodeMessage: unknownCodeMessage,
  resolve: resolve,
  pendingFor: pendingFor,
  createPending: createPending,
  onFirstCompletion: onFirstCompletion,
  countsFor: countsFor,
};
