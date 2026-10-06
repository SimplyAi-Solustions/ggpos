/**
 * Online sign-ups nobody ever signed in to (Phase 8): see signup.pb.js's
 * `purge_unverified_signups` cron. require() inside each handler.
 */

var PURGE_DAYS = 30;

/** Collections whose rows mean a record has been used for something. */
var ATTACHED = [
  "trade_ins",
  "sales",
  "quotes",
  "credit_ledger",
  "points_ledger",
  "reward_redemptions",
  "want_list",
  "memberships",
];

function hasRows(app, collection, customerId) {
  try {
    return app.findRecordsByFilter(collection, "customer = {:c}", "", 1, 0, { c: customerId }).length > 0;
  } catch (err) {
    // A lookup that fails is treated as "something is there": never
    // delete a record on a guess.
    return true;
  }
}

/**
 * Delete every `source: "portal"` customer still unverified `PURGE_DAYS`
 * after creation with nothing attached. Answers `{ deleted, kept }`.
 */
function purgeUnverified(app, now) {
  var auditLib = require(`${__hooks}/lib/audit.js`);
  var cutoff = new Date(now.getTime() - PURGE_DAYS * 86400000).toISOString().replace("T", " ");
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "customers",
      'source = "portal" && verified = false && created < {:cutoff}',
      "created",
      500,
      0,
      { cutoff: cutoff }
    );
  } catch (err) {
    rows = [];
  }
  var out = { deleted: 0, kept: 0 };
  for (var i = 0; i < rows.length; i++) {
    var customer = rows[i];
    if (!customer) continue;
    var keep = false;
    for (var c = 0; c < ATTACHED.length && !keep; c++) {
      if (hasRows(app, ATTACHED[c], customer.id)) keep = true;
    }
    if (!keep) {
      try {
        app.findFirstRecordByFilter("referrals", "referrer = {:c} || referee = {:c}", { c: customer.id });
        keep = true;
      } catch (err) {
        keep = keep || false;
      }
    }
    var priv = null;
    try {
      priv = app.findFirstRecordByFilter("customer_private", "customer = {:c}", { c: customer.id });
    } catch (err) {
      priv = null;
    }
    if (priv && (priv.getString("epos_customer_id") || priv.getString("epos_sync_status"))) keep = true;
    if (keep) {
      out.kept += 1;
      continue;
    }
    var id = customer.id;
    app.runInTransaction(function (txApp) {
      // customer_private goes with it (cascadeDelete); notifications and
      // push subscriptions are the only other rows such a record can have.
      var notes = txApp.findRecordsByFilter("notifications", "customer = {:c}", "", 0, 0, { c: id });
      for (var n = 0; n < notes.length; n++) if (notes[n]) txApp.delete(notes[n]);
      txApp.delete(txApp.findRecordById("customers", id));
      auditLib.writeAuditLog(txApp, {
        actor: "system",
        action: "customer_unverified_purge",
        collection: "customers",
        record: id,
        meta: { days: PURGE_DAYS },
        ip: "",
      });
    });
    out.deleted += 1;
  }
  return out;
}

module.exports = { PURGE_DAYS: PURGE_DAYS, purgeUnverified: purgeUnverified };
