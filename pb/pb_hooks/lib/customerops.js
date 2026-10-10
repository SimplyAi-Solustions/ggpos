/**
 * The UK GDPR Article 17 erasure, factored out of customerops.pb.js's admin
 * route (POST /api/vault/customers/:id/erase) so the customer's own
 * self-service route (POST /api/vault/me/delete, portal.pb.js) runs the
 * exact same anonymisation rather than a second copy that could drift from
 * it. Trade-ins, sales and both ledgers stay untouched, seller snapshot
 * included - UK GDPR Article 17(3)(b) keeps the record the shop is required
 * by law to hold.
 *
 * Callers do their own pre-transaction credit-balance check (for the fast,
 * staff-facing refusal before a transaction ever opens - "validate first,
 * write second", pb/README.md) and their own role/step-up gate; this
 * function re-checks the balance itself, inside whatever transaction the
 * caller passes as `app`, and reports a refusal rather than throwing a
 * PocketBase-specific error, since the two callers word the same rule
 * differently for their own audience ("This customer still has..." for
 * staff, "You still have..." for the customer themself).
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/**
 * @param {any} app - a txApp from $app.runInTransaction (never $app/e.app
 *   directly - this always makes several writes and must be all-or-nothing).
 * @param {string} customerId
 * @param {{creditRefusal?: (pence:number)=>string}} [opts]
 * @returns {{ok:false,status:number,message:string} | {ok:true,removed:object,customer:any}}
 */
function erase(app, customerId, opts) {
  opts = opts || {};
  var balances = require(`${__hooks}/lib/balances.js`);
  var money = require(`${__hooks}/lib/shared/money.js`);

  var creditRefusal =
    opts.creditRefusal ||
    function (pence) {
      return `This customer still has ${money.formatGBP(pence)} store credit. Pay it out or write it off first.`;
    };

  var credit = balances.creditBalance(app, customerId);
  if (credit > 0) {
    return { ok: false, status: 422, message: creditRefusal(credit) };
  }

  // Rows that are wholly the person's own and go with them. Their
  // trade-ins, sales and ledgers stay: UK GDPR Article 17(3)(b) keeps the
  // record the shop is required to hold, with the seller snapshot on it.
  var DELETED = ["want_list", "notifications", "push_subscriptions", "quotes"];
  var removed = {};

  // --- the ID photos, file and all -------------------------------------
  var documents = [];
  try {
    documents = app.findRecordsByFilter("id_documents", "customer = {:customer}", "created", 0, 0, {
      customer: customerId,
    });
  } catch (err) {
    documents = [];
  }
  for (var i = 0; i < documents.length; i++) {
    if (documents[i]) app.delete(documents[i]);
  }
  removed.id_documents = documents.length;

  // --- vouchers they will never come back for ---------------------------
  var issued = [];
  try {
    issued = app.findRecordsByFilter(
      "reward_redemptions",
      'customer = {:customer} && status = "issued"',
      "created",
      0,
      0,
      { customer: customerId }
    );
  } catch (err) {
    issued = [];
  }
  for (var r = 0; r < issued.length; r++) {
    if (!issued[r]) continue;
    issued[r].set("status", "cancelled");
    app.save(issued[r]);
  }
  removed.reward_redemptions = issued.length;

  // --- their own rows, quote photos included -----------------------------
  for (var d = 0; d < DELETED.length; d++) {
    var rows = [];
    try {
      rows = app.findRecordsByFilter(DELETED[d], "customer = {:customer}", "created", 0, 0, {
        customer: customerId,
      });
    } catch (err) {
      rows = [];
    }
    for (var n = 0; n < rows.length; n++) {
      if (rows[n]) app.delete(rows[n]);
    }
    removed[DELETED[d]] = rows.length;
  }

  // --- customer_private ---------------------------------------------------
  var priv = null;
  try {
    priv = app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: customerId,
    });
  } catch (err) {
    priv = null;
  }
  if (priv) {
    priv.set("address", "");
    priv.set("dob", "");
    priv.set("notes", "");
    priv.set("flags", []);
    priv.set("id_status", "none");
    priv.set("id_type", "");
    priv.set("id_expiry", "");
    priv.set("id_ref_last4", "");
    priv.set("id_verified_by", "");
    priv.set("id_verified_at", "");
    app.save(priv);
  }

  // --- the customer record itself -----------------------------------------
  // The code stays: it is on printed receipts and on the six-year buy-in
  // register, and it identifies nobody on its own.
  var customer = app.findRecordById("customers", customerId);
  customer.set("name", "Erased customer");
  customer.set("email", "");
  customer.set("phone", "");
  customer.set("marketing_consent", false);
  customer.set("birthday_month", null);
  // Rotated, so a QR card already in a wallet stops resolving.
  customer.set("qr_token", $security.randomString(32));
  // A fresh random password rotates the auth record's tokenKey, which is
  // what a signed JWT's signature is derived from - every token issued to
  // this customer before the erasure, portal or step-up alike, stops
  // verifying at once, the same mechanism pb/README.md's step-up section
  // documents for a staff member's password change.
  customer.setRandomPassword();
  app.save(customer);

  return { ok: true, removed: removed, customer: app.findRecordById("customers", customerId) };
}

module.exports = { erase: erase };
