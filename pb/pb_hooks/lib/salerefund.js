/**
 * Refunding lines of a sale (docs/api-contract-epos.md, sections 4 and 7).
 *
 * Two routes refund a sale's lines: `POST /api/vault/sales/{id}/refund`,
 * and `POST /api/vault/sales/complete` when a ticket brings lines of an
 * earlier sale back (an exchange, or a ticket of returns alone). Both refund
 * exactly the same way, so the steps live here once:
 *
 * - `prepare(app, sale, input)`: the checks on the sale and the lines that
 *   run before the transaction, in the refund route's order (the sale is
 *   not already refunded in full, a reason, at least one line and at most
 *   `MAX_LINES`, each line on this sale, not already refunded and not asked
 *   for more units than are still sold), and the amount those lines come to
 *   from the shared `breakdown`. Returns `{ ok: true, plan }` or
 *   `{ ok: false, status, message }`.
 * - `write(txApp, plan, opts)`: the refund itself, inside the caller's
 *   transaction and in the refund route's order: the live re-checks, the
 *   override spent (when the caller asks), the `-Rn` reference, the items
 *   back in stock unless `restock: false`, each line's `refunded_qty`, the
 *   sale's status and `refunded_total`, store credit back, the drawer's
 *   movement, one negative `sale_tenders` row per tender, the points the
 *   sale earned on those units reversed, the reason as a staff note, the
 *   override till event (when the caller asks), the balances and the
 *   `sale_refund` audit row. Returns `{ ok: true, ... }` or a refusal for
 *   the caller to carry out of its transaction as its `halt`.
 * - `drawerShort(expected)`: the one wording for a drawer that cannot cover
 *   a cash refund.
 *
 * A refund never rewrites what was sold: `sale_lines.qty` and `.discount`
 * are the as-sold figures for good, and the amounts come from them through
 * lib/shared/saleline.js, so any sequence of partial refunds adds back up to
 * exactly what was taken.
 *
 * An exchange's refund carries one more tender: a negative `exchange` row of
 * the part the returned goods paid towards the new sale, written under the
 * refund's own reference, so it cancels the new sale's positive `exchange`
 * row on an X or a Z and nothing moves in the drawer for that part.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** The most lines one refund may take. */
var MAX_LINES = 100;

var FULLY_REFUNDED = "This sale has already been refunded in full.";
var LINE_RACED = "That line was refunded while this refund was open. Reload the sale and try again.";
var APPROVAL_USED = "That approval has already been used. Ask for it again.";

function refusal(status, message) {
  return { ok: false, status: status, message: message };
}

/** The one wording for a drawer that cannot cover a cash refund. */
function drawerShort(expected) {
  var money = require(__hooks + "/lib/shared/money.js");
  return (
    "The drawer should only hold " +
    money.formatGBP(Math.max(0, expected)) +
    ". Refund the rest to card or store credit."
  );
}

/** The sale's line records by id, beside the shared breakdown of them. */
function recordsById(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) map[rows[i].id] = rows[i];
  }
  return map;
}

/** A line goes back on the shelf unless the till says it is not fit to (`restock: false`). */
function restockOf(value) {
  if (value === false || value === 0) return false;
  var s = String(value === undefined || value === null ? "" : value).toLowerCase();
  return !(s === "false" || s === "0" || s === "no");
}

/**
 * The checks on the sale and its lines, before the transaction.
 * @param {any} app
 * @param {any} sale the `sales` record being refunded
 * @param {{ lines: any, reason: any }} input the request's `lines` and `reason`
 */
function prepare(app, sale, input) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var saleline = require(__hooks + "/lib/shared/saleline.js");

  if (sale.getString("status") === "refunded") {
    return refusal(409, FULLY_REFUNDED);
  }

  var reason = util.asStr(input.reason);
  if (!reason) {
    return refusal(400, "Say why this is being refunded.");
  }

  var rawLines = input.lines && input.lines.length ? input.lines : [];
  if (rawLines.length === 0) {
    return refusal(400, "Pick at least one line to refund.");
  }
  if (rawLines.length > MAX_LINES) {
    return refusal(400, "A refund can take up to " + MAX_LINES + " lines at once.");
  }

  // The as-sold breakdown: unit_price, qty and discount as they were at
  // completion, plus this line's share of the sale-level discount. The rows
  // come back in "created,id" order, which is the order the allocation's
  // rounding remainder is assigned in (lib/vaultutil.js).
  var soldRows = util.saleLineRows(app, sale.id);
  var soldRecords = recordsById(soldRows);
  var asSold = saleline.breakdown(util.asSoldLines(soldRows), sale.getInt("discount"));

  var requested = {};
  var restock = {};
  var order = [];
  for (var i = 0; i < rawLines.length; i++) {
    var raw = rawLines[i] && typeof rawLines[i] === "object" ? rawLines[i] : {};
    var lineId = util.asStr(raw.sale_line);
    var entry = asSold.byId[lineId];
    if (!entry) {
      return refusal(400, "One of those lines is not on this sale.");
    }
    if (soldRecords[lineId].getString("status") === "refunded") {
      return refusal(409, "One of those lines has already been refunded.");
    }
    var remaining = saleline.remainingQty(entry);
    var want = Math.max(1, util.asInt(raw.qty, remaining));
    if (requested[lineId] === undefined) {
      requested[lineId] = 0;
      restock[lineId] = true;
      order.push(lineId);
    }
    requested[lineId] += want;
    if (!restockOf(raw.restock)) restock[lineId] = false;
    if (requested[lineId] > remaining) {
      return refusal(400, "Only " + remaining + " of that line is still sold. Lower the quantity.");
    }
  }

  // What these lines and quantities come to, from the shared breakdown.
  var amount = 0;
  for (var k = 0; k < order.length; k++) {
    amount += saleline.refundAmount(asSold.byId[order[k]], requested[order[k]]);
  }

  return {
    ok: true,
    plan: {
      sale: sale,
      reason: reason,
      order: order,
      requested: requested,
      restock: restock,
      amount: amount,
      customerId: sale.getString("customer"),
    },
  };
}

/**
 * The refund, inside the caller's transaction.
 *
 * opts: {
 *   register, session: the records the refund is made on,
 *   staffId, ip,
 *   tenders: the checked tenders going back (positive amounts), and
 *   cashAmount, creditAmount: their cash and store credit parts,
 *   drawerReserve: pence the same ticket takes out of the drawer as well
 *     (a part-exchange's cash surplus), so the cash refund is checked
 *     against what is left (0 for the refund route),
 *   grant: the caller's lib/permissions.js result,
 *   consumeGrant: true when the refund is the whole action (the refund
 *     route, a ticket of returns alone); a sale with returns spends its
 *     approvals once for the whole ticket itself,
 *   exchange: { amount, sale, number } when part of the refund paid for a
 *     new sale in the same ticket, else null,
 *   refundMethod: the legacy `refund_method`, for the audit row,
 *   clientId: the ticket's client_id, when the refund is the whole ticket
 * }
 * Returns { ok: true, sale, refundRef, count, refunded, refundedAfter,
 * pointsReversed, tenderRows, credit, points } or a refusal.
 */
function write(txApp, plan, opts) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var balances = require(__hooks + "/lib/balances.js");
  var perms = require(__hooks + "/lib/permissions.js");
  var registers = require(__hooks + "/lib/registers.js");
  var tendersLib = require(__hooks + "/lib/tenders.js");
  var saleline = require(__hooks + "/lib/shared/saleline.js");

  var register = opts.register;
  var session = opts.session;
  var cashAmount = opts.cashAmount || 0;
  var creditAmount = opts.creditAmount || 0;
  var reserve = opts.drawerReserve || 0;
  var exchange = opts.exchange || null;
  var customerId = plan.customerId;

  var liveSale = txApp.findRecordById("sales", plan.sale.id);
  if (liveSale.getString("status") === "refunded") {
    return refusal(409, FULLY_REFUNDED);
  }

  var liveSession = registers.openSession(txApp, register.id);
  if (!liveSession || liveSession.id !== session.id) {
    return refusal(409, "Open the till first.");
  }
  if (cashAmount > 0) {
    var liveExpected = util.sessionExpected(txApp, liveSession) - reserve;
    if (cashAmount > liveExpected) {
      return refusal(409, drawerShort(liveExpected));
    }
  }

  // Re-read every line and price from the live refunded_qty, so two refunds
  // open at once cannot pay the same unit back twice.
  var liveRows = util.saleLineRows(txApp, liveSale.id);
  var liveRecords = recordsById(liveRows);
  var live = saleline.breakdown(util.asSoldLines(liveRows), liveSale.getInt("discount"));

  var plans = [];
  var refunded = 0;
  for (var i = 0; i < plan.order.length; i++) {
    var lineId = plan.order[i];
    var entry = live.byId[lineId];
    if (!entry) {
      return refusal(409, "That line is no longer on this sale. Reload it and try again.");
    }
    var record = liveRecords[lineId];
    var want = plan.requested[lineId];
    if (record.getString("status") === "refunded" || saleline.remainingQty(entry) < want) {
      return refusal(409, LINE_RACED);
    }
    var lineAmount = saleline.refundAmount(entry, want);
    refunded += lineAmount;
    plans.push({
      line: record,
      qty: entry.qty,
      already: entry.refundedQty,
      want: want,
      amount: lineAmount,
      restock: plan.restock[lineId],
    });
  }
  // The tenders were checked against the amount worked out before the
  // transaction; a refund of other units of the same line in the meantime
  // can move it by a penny of rounding.
  if (refunded !== plan.amount) {
    return refusal(409, LINE_RACED);
  }

  if (opts.consumeGrant) {
    try {
      perms.consume(txApp, opts.grant, "refund:" + liveSale.id);
    } catch (err) {
      return refusal(409, APPROVAL_USED);
    }
  }

  var count = liveSale.getInt("refund_count") + 1;
  var refundRef = liveSale.getString("number") + "-R" + count;

  var restocked = 0;
  for (var j = 0; j < plans.length; j++) {
    var p = plans[j];
    var itemId = p.line.getString("item");

    // A till product has no stock; a damaged return stays as it is.
    if (itemId && p.restock) {
      var item = null;
      try {
        item = txApp.findRecordById("items", itemId);
      } catch (err) {
        return refusal(409, "That item has been deleted, so it cannot go back into stock.");
      }
      item.set("qty", item.getInt("qty") + p.want);
      item.set("status", "in_stock");
      txApp.save(item);
      restocked += p.want;
    }

    // qty and discount stay as sold for ever; only refunded_qty moves.
    var afterQty = p.already + p.want;
    p.line.set("refunded_qty", afterQty);
    if (afterQty >= p.qty) p.line.set("status", "refunded");
    txApp.save(p.line);

    // A booking line takes what it paid back off the booking's `paid`
    // (docs/api-contract-launch.md, section 4).
    if (p.line.getString("booking")) {
      require(__hooks + "/lib/bookings.js").unpay(txApp, p.line, p.want, {
        ref: refundRef,
        staffId: opts.staffId,
        ip: opts.ip,
      });
    }
  }

  var allRefunded = true;
  var after = util.saleLineRows(txApp, liveSale.id);
  for (var k = 0; k < after.length; k++) {
    if (after[k] && after[k].getString("status") !== "refunded") allRefunded = false;
  }

  var refundedBefore = liveSale.getInt("refunded_total");
  var refundedAfter = refundedBefore + refunded;
  liveSale.set("refunded_total", refundedAfter);
  liveSale.set("refund_count", count);
  liveSale.set("status", allRefunded ? "refunded" : "part_refunded");
  txApp.save(liveSale);

  // Cumulative, from the sale's own earn figure: whatever order the lines go
  // back in, the points reversed total exactly what the sale earned once it
  // is fully refunded.
  var pointsEarned = liveSale.getInt("points_earned");
  var saleTotal = liveSale.getInt("total");
  var pointsToReverse =
    saleline.pointsCum(pointsEarned, saleTotal, refundedAfter) -
    saleline.pointsCum(pointsEarned, saleTotal, refundedBefore);

  if (creditAmount > 0) {
    txApp.save(
      new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
        customer: customerId,
        amount: creditAmount,
        reason: "sale",
        ref: refundRef,
        staff: opts.staffId,
      })
    );
  }

  // Signed: money out of the drawer is negative.
  tendersLib.writeCashMovement(txApp, {
    session: session.id,
    type: "refund",
    amount: -cashAmount,
    ref: refundRef,
    staff: opts.staffId,
  });

  // The part that paid for the new sale goes back as a negative exchange
  // tender under this refund's reference; the rest goes back as tendered.
  var tenders = opts.tenders.slice();
  if (exchange && exchange.amount > 0) {
    tenders.unshift({
      method: "exchange",
      amount: exchange.amount,
      tendered: 0,
      change: 0,
      card_last4: "",
      reference: "",
    });
  }
  var tenderRows = tendersLib.writeTenders(txApp, {
    sale: liveSale.id,
    refundRef: refundRef,
    tenders: tenders,
    register: register.id,
    session: session.id,
    staff: opts.staffId,
  });

  if (customerId && pointsToReverse !== 0) {
    // The points ledger is allowed to go negative here: a customer who has
    // already spent what a refunded sale earned owes those points back, and
    // the ledger is the record of that.
    txApp.save(
      new Record(txApp.findCollectionByNameOrId("points_ledger"), {
        customer: customerId,
        delta: -pointsToReverse,
        reason: "refund_reverse",
        ref: refundRef,
        staff: opts.staffId,
      })
    );
  }

  // The reason is a staff note against the sale, not audit meta: audit_log
  // is permanent and superuser-only, and a refund reason is free text a
  // staff member typed about a named customer.
  var note = new Record(txApp.findCollectionByNameOrId("notes"), {
    target_collection: "sales",
    target_record: liveSale.id,
    body: plan.reason,
    author: opts.staffId,
  });
  txApp.save(note);

  if (opts.consumeGrant) {
    perms.logOverrides(txApp, opts.grant, {
      register: register.id,
      session: session.id,
      amount: refunded,
      detail: { sale: liveSale.getString("number"), ref: refundRef },
      used_for: "refund:" + liveSale.id,
    });
  }

  var fresh = customerId ? balances.recompute(txApp, customerId) : { credit: 0, points: 0 };

  // The lines and quantities of this refund live here and nowhere else: the
  // refund receipt (lib/salereceipt.js) reads them back by `ref`.
  // Identifiers and the shop's own money only.
  var lineMeta = [];
  for (var m = 0; m < plans.length; m++) {
    lineMeta.push({
      sale_line: plans[m].line.id,
      qty: plans[m].want,
      amount: plans[m].amount,
      restock: plans[m].restock,
    });
  }
  var tenderMeta = [];
  for (var t = 0; t < tenders.length; t++) {
    tenderMeta.push({ method: tenders[t].method, amount: tenders[t].amount });
  }
  var meta = {
    number: liveSale.getString("number"),
    ref: refundRef,
    lines: lineMeta,
    refunded: refunded,
    refunded_total: refundedAfter,
    tenders: tenderMeta,
    refund_method: opts.refundMethod || "",
    restocked: restocked,
    points_reversed: pointsToReverse,
    note: note.id,
    register: register.id,
    session: session.id,
    approvals: perms.auditMeta(opts.grant),
  };
  if (exchange) {
    meta.exchange = { amount: exchange.amount, sale: exchange.sale, number: exchange.number };
  }
  if (opts.clientId) meta.client_id = opts.clientId;
  auditLib.writeAuditLog(txApp, {
    actor: opts.staffId,
    action: "sale_refund",
    collection: "sales",
    record: liveSale.id,
    meta: meta,
    ip: opts.ip,
  });

  return {
    ok: true,
    sale: liveSale,
    refundRef: refundRef,
    count: count,
    refunded: refunded,
    refundedAfter: refundedAfter,
    pointsReversed: pointsToReverse,
    tenderRows: tenderRows,
    credit: fresh.credit,
    points: fresh.points,
  };
}

/**
 * The refund route's own response body, for a refund made by either route.
 * `done` is write()'s result.
 */
function responseOf(done) {
  return {
    sale: {
      id: done.sale.id,
      number: done.sale.getString("number"),
      status: done.sale.getString("status"),
      refunded_total: done.refundedAfter,
      refund_count: done.count,
    },
    refund: { ref: done.refundRef, amount: done.refunded, tenders: done.tenderRows },
    refunded: done.refunded,
    refunded_total: done.refundedAfter,
    points_reversed: done.pointsReversed,
    credit_balance: done.credit,
    points_balance: done.points,
  };
}

/** n from a refund reference GG-S-000456-Rn, or 0. */
function countOf(ref) {
  var m = /-R(\d+)$/.exec(String(ref || ""));
  return m ? Number(m[1]) : 0;
}

/**
 * A ticket of returns alone (section 7): it makes no sale, so it answers as
 * the refund it is, with the refund route's own body, `refund.exchange` 0,
 * and the refund's tenders as they read back. The first answer and a replay
 * are both built here, from the refund's own rows.
 * `f`: { sale (the refunded sale's record), ref, refunded, refundedAfter,
 * pointsReversed, credit, points }.
 */
function returnsOnlyBody(app, f) {
  var tendersLib = require(__hooks + "/lib/tenders.js");
  return {
    sale: {
      id: f.sale.id,
      number: f.sale.getString("number"),
      status: f.sale.getString("status"),
      refunded_total: f.refundedAfter,
      refund_count: countOf(f.ref),
    },
    refund: {
      ref: f.ref,
      amount: f.refunded,
      exchange: 0,
      tenders: tendersLib.tendersFor(app, f.sale, f.ref),
    },
    refunded: f.refunded,
    refunded_total: f.refundedAfter,
    points_reversed: f.pointsReversed,
    credit_balance: f.credit,
    points_balance: f.points,
  };
}

/**
 * The replay of a ticket of returns alone: its client_id is on its refund's
 * `sale_refund` audit row, since there is no sale to carry it. Returns the
 * first answer again, with the customer's current balances, or null when no
 * refund carries that client_id.
 */
function replayByClientId(app, clientId) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var balances = require(__hooks + "/lib/balances.js");
  var row = null;
  try {
    row = app.findFirstRecordByFilter("audit_log", "action = 'sale_refund' && meta.client_id = {:c}", {
      c: clientId,
    });
  } catch (err) {
    row = null;
  }
  if (!row) return null;
  var sale = null;
  try {
    sale = app.findRecordById("sales", row.getString("record"));
  } catch (err) {
    return null;
  }
  var meta = util.jsonField(row, "meta", {}) || {};
  var customerId = sale.getString("customer");
  var fresh = customerId ? balances.recompute(app, customerId) : { credit: 0, points: 0 };
  return returnsOnlyBody(app, {
    sale: sale,
    ref: util.asStr(meta.ref),
    refunded: util.asInt(meta.refunded, 0),
    refundedAfter: util.asInt(meta.refunded_total, 0),
    pointsReversed: util.asInt(meta.points_reversed, 0),
    credit: fresh.credit,
    points: fresh.points,
  });
}

/**
 * An exchange's refund as the new sale's response and its replay give it
 * (`SaleTicketRefund`): the reference, the returned goods' value R and the
 * part E that paid for the new sale, plus the refunded sale and the refund's
 * own tenders, so the till can print the refund's receipt when the rest went
 * back as money. `returns` is what the new sale's `sale_complete` audit row
 * keeps: { sale, number, ref, amount, exchange }.
 */
function ticketBlock(app, returns) {
  var tendersLib = require(__hooks + "/lib/tenders.js");
  var util = require(__hooks + "/lib/vaultutil.js");
  var sale = null;
  try {
    sale = app.findRecordById("sales", util.asStr(returns.sale));
  } catch (err) {
    sale = null;
  }
  return {
    ref: util.asStr(returns.ref),
    amount: util.asInt(returns.amount, 0),
    exchange: util.asInt(returns.exchange, 0),
    sale: { id: util.asStr(returns.sale), number: util.asStr(returns.number) },
    tenders: sale ? tendersLib.tendersFor(app, sale, util.asStr(returns.ref)) : [],
  };
}

/** The `returns` a sale's own `sale_complete` audit row keeps, or null for a sale with none. */
function returnsOf(app, saleId) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var row = null;
  try {
    row = app.findFirstRecordByFilter("audit_log", "action = 'sale_complete' && record = {:id}", {
      id: saleId,
    });
  } catch (err) {
    row = null;
  }
  if (!row) return null;
  var meta = util.jsonField(row, "meta", {}) || {};
  return meta.returns && typeof meta.returns === "object" && meta.returns.ref ? meta.returns : null;
}

module.exports = {
  MAX_LINES: MAX_LINES,
  drawerShort: drawerShort,
  prepare: prepare,
  write: write,
  responseOf: responseOf,
  returnsOnlyBody: returnsOnlyBody,
  replayByClientId: replayByClientId,
  ticketBlock: ticketBlock,
  returnsOf: returnsOf,
};
