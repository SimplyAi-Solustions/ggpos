/**
 * Cached balance recomputation.
 *
 * credit_ledger and points_ledger are the append-only truth (docs/PLAN.md,
 * "Data model"); customer_private.credit_balance and .points_balance are a
 * cache for the counter screens. Every write that touches either ledger
 * goes through here, and ledgers.pb.js calls it again after any create, so
 * a staff member adding a correction row straight through the collection
 * API gets the same recomputation the custom routes do.
 *
 * Always recomputes by summing the ledger rather than adding a delta to the
 * cached figure, so a cache that has drifted repairs itself on the next
 * write.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Sum one signed column of one ledger for one customer. */
function sumLedger(app, collection, field, customerId) {
  var rows = app.findRecordsByFilter(collection, "customer = {:customer}", "", 0, 0, {
    customer: customerId,
  });
  var total = 0;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) total += rows[i].getInt(field);
  }
  return total;
}

/** Store credit in pence, straight from credit_ledger. */
function creditBalance(app, customerId) {
  return sumLedger(app, "credit_ledger", "amount", customerId);
}

/** GG Points, straight from points_ledger. */
function pointsBalance(app, customerId) {
  return sumLedger(app, "points_ledger", "delta", customerId);
}

/**
 * Recompute both cached balances on customer_private and save the row.
 * Returns the fresh figures even when there is no customer_private row to
 * write them to (a customer created outside the usual hook path).
 *
 * @param {any} app - $app, e.app, or a txApp from $app.runInTransaction.
 * @param {string} customerId
 */
function recompute(app, customerId) {
  var credit = creditBalance(app, customerId);
  var points = pointsBalance(app, customerId);

  var priv = null;
  try {
    priv = app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: customerId,
    });
  } catch (err) {
    priv = null;
  }

  if (priv) {
    priv.set("credit_balance", credit);
    priv.set("points_balance", points);
    app.save(priv);
  }

  return { credit: credit, points: points };
}

module.exports = {
  recompute: recompute,
  creditBalance: creditBalance,
  pointsBalance: pointsBalance,
};
