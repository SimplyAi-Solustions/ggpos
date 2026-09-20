/// <reference path="../pb_data/types.d.ts" />

/**
 * ledgers.pb.js
 *
 * credit_ledger and points_ledger are append-only and are the truth for a
 * customer's store credit and GG Points; customer_private.credit_balance
 * and .points_balance are only a cache (docs/PLAN.md, "Data model").
 *
 * Two hooks per ledger keep the two in step no matter who writes the row -
 * the trade-in and sale routes, or a staff member adding a correction
 * straight through the collection API:
 *
 *  - onRecordCreate stamps `balance_after` before the row is written, so
 *    every row carries the running total it produced. It is computed as
 *    "the ledger as it stands, plus this row", never from the cached
 *    figure, so a cache that has drifted cannot poison the history.
 *  - onRecordAfterCreateSuccess recomputes both cached balances from the
 *    ledgers (lib/balances.js) once the row is safely in.
 *
 * Both run inside whatever transaction the caller is in, because e.app is
 * the txApp there.
 *
 * Each handler runs in its own isolated goja context, so each repeats its
 * own require() inside its body - see pb/README.md.
 */

onRecordCreate((e) => {
  const balances = require(`${__hooks}/lib/balances.js`);

  const customer = e.record.getString("customer");
  const isCredit = e.record.collection().name === "credit_ledger";
  const field = isCredit ? "amount" : "delta";

  if (customer) {
    const before = isCredit
      ? balances.creditBalance(e.app, customer)
      : balances.pointsBalance(e.app, customer);
    e.record.set("balance_after", before + e.record.getInt(field));
  }

  e.next();
}, "credit_ledger", "points_ledger");

onRecordAfterCreateSuccess((e) => {
  const balances = require(`${__hooks}/lib/balances.js`);

  const customer = e.record.getString("customer");
  if (customer) balances.recompute(e.app, customer);

  e.next();
}, "credit_ledger", "points_ledger");
