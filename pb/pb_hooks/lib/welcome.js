/**
 * The GG Guild welcome bonus: one `points_ledger` row with reason
 * `welcome`, and one notification for joining, written once per customer.
 *
 * Two callers, one rule each about *when*:
 *  - a customer created at the counter (`source` "counter" or empty) gets
 *    it the moment the record is made (loyalty.pb.js's customers create
 *    hook, unchanged in behaviour);
 *  - a customer who signed up online (`source` "portal") gets it on their
 *    first successful emailed-code sign-in (signup.pb.js's auth hook), so
 *    a typed-in address nobody owns never collects points.
 *
 * Never twice: an existing `welcome` row for the customer is checked first,
 * which is also what makes the sign-in path safe to run on every sign-in.
 *
 * Writes outside any transaction of the caller's own on purpose (see
 * loyalty.pb.js's banner): a loyalty programme having a bad day never stops
 * a customer being created or signing in. Returns the emails to flush with
 * lib/notify.js's `sendPending` once the caller is done; never throws.
 *
 * require() this from inside each handler - see pb/README.md.
 */

/** True when a `welcome` row already exists for this customer. */
function alreadyWelcomed(app, customerId) {
  try {
    return (
      app.findRecordsByFilter(
        "points_ledger",
        'customer = {:customer} && reason = "welcome"',
        "",
        1,
        0,
        { customer: customerId }
      ).length > 0
    );
  } catch (err) {
    return false;
  }
}

/**
 * @param {any} app
 * @param {any} customer the `customers` record
 * @param {{ signedIn?: boolean }} [opts] `signedIn` words the notification
 *   for somebody who is already in My Vault rather than somebody who has
 *   yet to claim a card made at the counter.
 * @returns {{ awarded: boolean, pending: Array<any> }}
 */
function award(app, customer, opts) {
  opts = opts || {};
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  var tiers = require(`${__hooks}/lib/tiers.js`);

  var out = { awarded: false, pending: [] };
  if (!customer || !customer.id) return out;

  try {
    var programme = util.programme(app);
    if (!programme.enabled || !(programme.welcomeBonus > 0)) return out;
    if (alreadyWelcomed(app, customer.id)) return out;

    app.save(
      new Record(app.findCollectionByNameOrId("points_ledger"), {
        customer: customer.id,
        delta: programme.welcomeBonus,
        reason: "welcome",
        ref: customer.id,
      })
    );
    out.awarded = true;

    // Only when there is an address to send it to: a customer created at
    // the counter without one has nowhere to read it.
    if (customer.getString("email")) {
      var points = tiers.formatPoints(programme.welcomeBonus);
      var n = notifyLib.notify(app, {
        customer: customer.id,
        type: "welcome",
        title: "Welcome to GG Guild",
        body: opts.signedIn
          ? `${points} points are on your card. Show your card at the counter to earn more.`
          : `${points} points are on your card. Sign in to My Vault with this email address to see them.`,
        link: opts.signedIn ? "/account/guild" : "/account",
        email: true,
      });
      out.pending = n.pending || [];
    }
  } catch (err) {
    // Two sign-ins racing each other both saw no welcome row; the unique
    // index on points_ledger (customer, ref) WHERE reason = 'welcome' let
    // exactly one through, and this is the other one. Nothing to undo.
    if (/unique/i.test(String(err))) {
      out.awarded = false;
      out.pending = [];
      return out;
    }
    console.log(`[welcome] the welcome bonus failed for ${customer.id}: ${err}`);
  }
  return out;
}

module.exports = { award: award, alreadyWelcomed: alreadyWelcomed };
