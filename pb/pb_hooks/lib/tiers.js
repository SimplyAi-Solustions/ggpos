/**
 * Tier re-evaluation: the one place a customer's `customer_private.tier` is
 * decided and written (docs/api-contract.md's Phase 6 section,
 * docs/PLAN.md's "Loyalty engine": "tier re-evaluated on every ledger
 * change from the rolling window; paid memberships pin a tier").
 *
 * Every decision is made from the `points_ledger` rows themselves through
 * the shared `tierWindowPoints`/`resolveTier` (packages/shared/src/
 * loyalty.ts), never from `customer_private.points_balance`, which is only
 * a cache (CLAUDE.md's "Money"; lib/balances.js says the same for both
 * balances). `redeem` and `expire` rows are excluded by the shared helper
 * itself, so spending points never costs a tier.
 *
 * `recompute()` writes through whatever `app` it is handed - a txApp from
 * the caller's own transaction (the membership routes, the points_ledger
 * hook firing inside a sale or buy-in), or `$app` wrapped by the caller
 * (the `tiers_recompute` cron opens one transaction per customer). It
 * never opens its own, and never sends mail: a promotion's email comes
 * back as `pending` for the caller to flush through lib/notify.js's
 * `sendPending` once its transaction has committed.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Every points_ledger row for one customer, newest first, as the shared evaluator reads them. */
function pointsRows(app, customerId) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("points_ledger", "customer = {:customer}", "-created", 0, 0, {
      customer: customerId,
    });
  } catch (err) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    out.push({
      id: rows[i].id,
      delta: rows[i].getInt("delta"),
      reason: rows[i].getString("reason"),
      created: rows[i].getString("created"),
      balance_after: rows[i].getInt("balance_after"),
      ref: rows[i].getString("ref"),
      record: rows[i],
    });
  }
  return out;
}

/** Every loyalty_tiers row as a shared LoyaltyTier, by `sort`. */
function allTiers(app) {
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var rows = [];
  try {
    rows = app.findRecordsByFilter("loyalty_tiers", "id != ''", "sort", 0, 0);
  } catch (err) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var rawPerks = util.jsonField(row, "perks", []) || [];
    var perks = [];
    for (var p = 0; p < rawPerks.length; p++) {
      var perk = loyalty.parseTierPerk(rawPerks[p]);
      if (perk) perks.push(perk);
    }
    out.push({
      id: row.id,
      name: row.getString("name"),
      thresholdPoints: row.getInt("threshold_points"),
      sort: row.getInt("sort"),
      perks: perks,
      paidPlan: row.getBool("paid_plan"),
    });
  }
  return out;
}

/** The customer's live `active` membership record, or null. */
function activeMembership(app, customerId) {
  if (!customerId) return null;
  try {
    return app.findFirstRecordByFilter(
      "memberships",
      'customer = {:customer} && status = "active"',
      { customer: customerId }
    );
  } catch (err) {
    return null;
  }
}

/**
 * What the customer's tier should be right now, read-only: the window
 * total, the membership pinning it (if any), and the tier that falls out
 * of the two. Nothing is written.
 */
function evaluate(app, customerId, now) {
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
  var util = require(`${__hooks}/lib/vaultutil.js`);

  var programme = util.programme(app);
  var tiers = allTiers(app);
  var rows = pointsRows(app, customerId);
  var windowPoints = loyalty.tierWindowPoints(rows, now || new Date(), programme.tierWindowMonths);
  var membership = activeMembership(app, customerId);
  var tier = loyalty.resolveTier(tiers, windowPoints, membership ? membership.getString("tier") : null);
  return {
    programme: programme,
    tiers: tiers,
    rows: rows,
    windowPoints: windowPoints,
    membership: membership,
    tier: tier,
  };
}

/** Where a tier sits in the ladder; no tier at all is below every tier. */
function rankOf(tier) {
  if (!tier) return { sort: -1, threshold: -1 };
  return { sort: tier.sort, threshold: tier.thresholdPoints };
}

/** True when `next` sits above `previous` in the ladder. */
function isPromotion(previous, next) {
  var a = rankOf(previous);
  var b = rankOf(next);
  if (b.sort !== a.sort) return b.sort > a.sort;
  return b.threshold > a.threshold;
}

/**
 * Re-evaluate and write `customer_private.tier`. A promotion notifies the
 * customer (type `tier_up`, emailed when they have email on); a demotion is
 * silent, per the contract.
 *
 * @param {any} app - a txApp, or $app inside the caller's own transaction.
 * @returns {{tier: object|null, windowPoints: number, changed: boolean, promoted: boolean, pending: Array}}
 */
function recompute(app, customerId, now) {
  var notifyLib = require(`${__hooks}/lib/notify.js`);

  var result = { tier: null, windowPoints: 0, changed: false, promoted: false, pending: [] };
  if (!customerId) return result;

  var priv = null;
  try {
    priv = app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: customerId,
    });
  } catch (err) {
    priv = null;
  }

  var state = evaluate(app, customerId, now);
  result.tier = state.tier;
  result.windowPoints = state.windowPoints;
  // Nothing to write the tier onto (a customer created outside the usual
  // hook path). The figures above are still correct to report.
  if (!priv) return result;

  var previousId = priv.getString("tier");
  var nextId = state.tier ? state.tier.id : "";
  if (previousId === nextId) return result;

  var previous = null;
  for (var i = 0; i < state.tiers.length; i++) {
    if (state.tiers[i].id === previousId) previous = state.tiers[i];
  }

  priv.set("tier", nextId);
  app.save(priv);
  result.changed = true;

  if (state.tier && isPromotion(previous, state.tier)) {
    result.promoted = true;
    var n = notifyLib.notify(app, {
      customer: customerId,
      type: "tier_up",
      title: `You are now a ${state.tier.name}`,
      body: `You are now a ${state.tier.name}. Your perks are in My Vault, under Guild.`,
      link: "/account/guild",
      email: true,
    });
    result.pending = n.pending || [];
  }

  return result;
}

/** A points figure as people read it: 1240 -> "1,240". */
function formatPoints(points) {
  var n = Math.round(points || 0);
  var negative = n < 0;
  var digits = String(Math.abs(n));
  var out = "";
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return (negative ? "-" : "") + out;
}

/** "20 Sep" - day and short month, no year. UTC, like lib/quotes.js's ukDateShort. */
function ukDayMonth(iso) {
  if (!iso) return "";
  var d = new Date(String(iso).replace(" ", "T"));
  if (isNaN(d.getTime())) return String(iso);
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

module.exports = {
  pointsRows: pointsRows,
  allTiers: allTiers,
  activeMembership: activeMembership,
  evaluate: evaluate,
  recompute: recompute,
  isPromotion: isPromotion,
  formatPoints: formatPoints,
  ukDayMonth: ukDayMonth,
};
