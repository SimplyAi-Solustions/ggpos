/**
 * Store credit from a Vault deal, queued for Epos Now
 * (1789821560_epos_credit_queue.js). The worker on the shop Mac
 * (deploy/mac/epos-credit-sync.mjs) sends it; this file only queues a row
 * and reports its status. require() inside the handler body (pb/README.md
 * on pb_hooks isolation).
 */

/**
 * Queue one pending row for a completed deal's credit. Call inside the
 * completion transaction with its txApp, so the row exists if and only if
 * the deal completed. The unique index on trade_in stops a second row.
 * Does nothing for zero credit.
 */
function queueCredit(txApp, tradeInId, customerId, amountPence) {
  if (!(amountPence > 0)) return null;
  var collection = txApp.findCollectionByNameOrId("epos_credit_queue");
  var row = new Record(collection);
  row.set("trade_in", tradeInId);
  row.set("customer", customerId);
  row.set("amount", amountPence);
  row.set("status", "pending");
  row.set("attempts", 0);
  txApp.save(row);
  return row;
}

/**
 * The deal's Epos Now credit status, for the result screen:
 *   status   none | pending | sending | done | failed | needs_check
 *   synced   true only when Epos Now confirmed the credit
 *   message  a line to show staff as-is
 */
function statusFor(app, tradeInId, maxAttempts) {
  var money = require(__hooks + "/lib/shared/money.js");
  var row = null;
  try {
    row = app.findFirstRecordByFilter("epos_credit_queue", "trade_in = {:id}", { id: tradeInId });
  } catch (err) {
    row = null;
  }
  if (!row) {
    return {
      status: "none",
      synced: false,
      amount: 0,
      message: "No store credit on this deal for Epos Now.",
    };
  }
  var status = row.getString("status");
  var amount = row.getInt("amount");
  var attempts = row.getInt("attempts");
  var gbp = money.formatGBP(amount);
  var message;
  if (status === "done") message = "Credit added to Epos Now: " + gbp;
  else if (status === "pending" || status === "sending") message = "Waiting to sync " + gbp + " to Epos Now.";
  else if (status === "failed" && attempts < maxAttempts) {
    message = "Could not add " + gbp + " to Epos Now yet. It will try again in a minute.";
  } else if (status === "failed") {
    message = "Could not add " + gbp + " to Epos Now. Add it in Epos Now Back Office and tell the owner.";
  } else {
    message = "Check Epos Now before adding " + gbp + " by hand: the sync may already have added it.";
  }
  var sentAt = row.getString("sent_at");
  return {
    status: status,
    synced: status === "done",
    amount: amount,
    epos_customer_id: row.getInt("epos_customer_id") || null,
    epos_balance_after: status === "done" && sentAt ? row.getInt("epos_balance_after") : null,
    attempts: attempts,
    sent_at: sentAt || null,
    last_error: row.getString("last_error") || null,
    message: message,
  };
}

module.exports = {
  MAX_ATTEMPTS: 5,
  queueCredit: queueCredit,
  statusFor: statusFor,
};
