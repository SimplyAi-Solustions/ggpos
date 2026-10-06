/**
 * Paid plans, the pieces shared by the staff routes (memberships.pb.js),
 * the customer's own Guild join (guild.pb.js) and the Epos Now sale that
 * pays for one (lib/eposnow.js), so a membership is started the same way
 * whichever of the three gets there.
 *
 * A `pending` membership is a customer's online request to join, waiting
 * for payment at the counter. It pins no tier: lib/tiers.js only ever reads
 * an `active` row. The tier is never written here either - the
 * `memberships` hooks in loyalty.pb.js re-evaluate it after every save.
 *
 * Transaction-agnostic: pass $app, e.app or a txApp. require() inside each
 * handler - see pb/README.md.
 */

/** A stored date (either "T" or PocketBase's own space form) as a Date, or null. */
function toDate(value) {
  if (!value) return null;
  var d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/** "6 Oct 2026" from either date form. */
function ukDate(value) {
  var quotes = require(`${__hooks}/lib/quotes.js`);
  var d = toDate(value);
  return d ? quotes.ukDateShort(d.toISOString()) : "";
}

/** Every paid-plan tier, lowest `sort` first. */
function paidPlans(app) {
  try {
    return app.findRecordsByFilter("loyalty_tiers", "paid_plan = true", "sort,created", 0, 0);
  } catch (err) {
    return [];
  }
}

/** The customer's newest membership in `status`, or null. */
function latest(app, customerId, status) {
  try {
    var rows = app.findRecordsByFilter(
      "memberships",
      "customer = {:customer} && status = {:status}",
      "-created",
      1,
      0,
      { customer: customerId, status: status }
    );
    return rows.length ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

function tierName(app, tierId) {
  try {
    return app.findRecordById("loyalty_tiers", tierId).getString("name");
  } catch (err) {
    return "";
  }
}

/** The one membership object every route here answers with. */
function shape(app, membership) {
  return {
    id: membership.id,
    customer: membership.getString("customer"),
    tier: membership.getString("tier"),
    tier_name: tierName(app, membership.getString("tier")),
    status: membership.getString("status"),
    started_at: membership.getString("started_at"),
    renews_at: membership.getString("renews_at"),
    price: membership.getInt("price"),
    created: membership.getString("created"),
  };
}

/**
 * Turn `membership` (pending, lapsed or brand new and unsaved) into a live
 * plan running `months` from `startedAt`, and save it. Returns the record.
 *
 * @param {any} app
 * @param {any} membership
 * @param {{ startedAt: Date, months: number, price: number, paymentNote?: string, tier?: string }} opts
 */
function activate(app, membership, opts) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var startedAt = opts.startedAt || new Date();
  membership.set("status", "active");
  if (opts.tier) membership.set("tier", opts.tier);
  membership.set("started_at", startedAt.toISOString());
  membership.set("renews_at", util.addMonths(startedAt, opts.months).toISOString());
  membership.set("price", opts.price);
  if (opts.paymentNote) membership.set("payment_note", opts.paymentNote);
  app.save(membership);
  return membership;
}

/**
 * Add `months` to a live plan, from the later of its current end and
 * `from`, so paying early adds to what is left and paying late does not
 * backdate the new term into months already gone.
 */
function extend(app, membership, opts) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var from = opts.from || new Date();
  var current = toDate(membership.getString("renews_at"));
  var base = current && current.getTime() > from.getTime() ? current : from;
  membership.set("status", "active");
  membership.set("renews_at", util.addMonths(base, opts.months).toISOString());
  membership.set("price", opts.price);
  if (opts.paymentNote) membership.set("payment_note", opts.paymentNote);
  app.save(membership);
  return membership;
}

module.exports = {
  toDate: toDate,
  ukDate: ukDate,
  paidPlans: paidPlans,
  latest: latest,
  tierName: tierName,
  shape: shape,
  activate: activate,
  extend: extend,
};
