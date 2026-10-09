/**
 * Tenders at the till (docs/api-contract-epos.md, section 4): the glue
 * between a sale or refund request and the shared rules in
 * lib/shared/tenders.js, and the writes those routes make with the result.
 *
 * - `saleTenders(body, rules)` / `refundTenders(body, rules)` read the
 *   request's `tenders`, or map the legacy `payment` / `payment_split` and
 *   `refund_method` onto tenders for older callers, then run the shared
 *   check. Each returns the checked tenders or `{ status, message }`.
 * - `ticketTenders(body, rules)` / `ticketRefundTenders(returns, rules)` are
 *   the same for a ticket carrying a trade-in or returns (section 7): the
 *   request's tenders come to what is left after the part-exchange and the
 *   exchange, which the server adds itself.
 * - `writeTenders(txApp, opts)` writes one `sale_tenders` row per tender,
 *   negative for a refund, with the register and session.
 * - `writeCashMovement(txApp, opts)` writes the drawer's movement for the
 *   cash tender's amount: what stays in the drawer (or leaves it), never what
 *   was handed over.
 * - `tendersFor(app, sale, refundRef)` reads a sale's (or one refund's)
 *   tenders back in the route shape, synthesising them from
 *   `payment_split` for a sale taken before tenders existed, so a historic
 *   SumUp sale still reads "Card (SumUp)".
 * - `eposSettings(app, row)` is `settings.epos` with its defaults.
 *
 * Transaction-agnostic: pass $app, e.app or a txApp. require() this from
 * inside each handler, not at file top level - see pb/README.md on pb_hooks
 * isolation.
 */

function shared() {
  return require(__hooks + "/lib/shared/tenders.js");
}

/** The legacy payment_split keys a sale could carry, oldest first. */
var LEGACY_SPLIT_KEYS = ["sumup_card", "cash", "store_credit", "points", "card_tide"];

/** `settings.epos` with the defaults the foundation migration seeds. */
function eposSettings(app, settingsRow) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var row = settingsRow || util.settings(app);
  var raw = row ? util.jsonField(row, "epos", {}) || {} : {};
  var receipt = raw.receipt && typeof raw.receipt === "object" ? raw.receipt : {};
  var pct = Number(raw.discount_limit_pct);
  return {
    discount_limit_pct: raw.discount_limit_pct !== undefined && isFinite(pct) && pct >= 0 ? pct : 10,
    // Anything but an explicit false keeps the card check on.
    require_card_last4: raw.require_card_last4 === false ? false : true,
    receipt: {
      header: util.asStr(receipt.header),
      footer: util.asStr(receipt.footer),
      returns_policy: util.asStr(receipt.returns_policy),
      show_portal_qr: receipt.show_portal_qr === false ? false : true,
    },
  };
}

/**
 * A request's tenders as a plain JS array of plain objects, whatever shape
 * the body parser handed over, so the shared rules see ordinary values.
 */
function plainList(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "object" || typeof raw.length !== "number") return raw;
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var entry = raw[i];
    if (!entry || typeof entry !== "object") {
      out.push({});
      continue;
    }
    var copy = {};
    var keys = ["method", "amount", "tendered", "card_last4", "reference"];
    for (var k = 0; k < keys.length; k++) {
      if (entry[keys[k]] !== undefined) copy[keys[k]] = entry[keys[k]];
    }
    out.push(copy);
  }
  return out;
}

/** A refusal for a route to throw: 422 for the customer ones, as before; 400 otherwise. */
function refusal(result) {
  return { status: result.code === "needs_customer" ? 422 : 400, message: result.message };
}

/**
 * The tenders a sale request names. `tenders` wins; otherwise the legacy
 * `payment` and `payment_split` are mapped onto tenders (cash as handed over
 * exactly, the card's digits from a top-level `card_last4`). A new SumUp
 * payment is refused: SumUp is gone (section 5).
 */
function legacySaleTenders(body, total) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var tenders = shared();
  var payment = util.asStr(body.payment);
  if (!payment) return { status: 400, message: "Pick a payment method for this sale." };
  if (payment === "sumup_card") return { status: 400, message: tenders.SUMUP_GONE };

  var cardLast4 = util.asStr(body.card_last4);
  var rawSplit =
    body.payment_split && typeof body.payment_split === "object" ? body.payment_split : null;

  if (rawSplit) {
    var list = [];
    for (var i = 0; i < LEGACY_SPLIT_KEYS.length; i++) {
      var key = LEGACY_SPLIT_KEYS[i];
      var amount = util.asInt(rawSplit[key], 0);
      if (amount < 0) {
        return { status: 400, message: "A payment amount cannot be negative. Check the split." };
      }
      if (amount === 0) continue;
      if (key === "sumup_card") return { status: 400, message: tenders.SUMUP_GONE };
      var entry = { method: key, amount: amount };
      if (key === "card_tide" && cardLast4) entry.card_last4 = cardLast4;
      list.push(entry);
    }
    return { list: list };
  }

  if (payment === "mixed") return { list: [] };
  if (["cash", "store_credit", "points", "card_tide"].indexOf(payment) < 0) {
    return { status: 400, message: "Pick a payment method for this sale." };
  }
  if (total === 0) return { list: [] };
  var single = { method: payment, amount: total };
  if (payment === "card_tide" && cardLast4) single.card_last4 = cardLast4;
  return { list: [single] };
}

/**
 * The checked tenders for a sale, or `{ status, message }`.
 * @param {object} body the request body
 * @param {{total:number, requireCardLast4:boolean, hasCustomer:boolean}} rules
 */
function saleTenders(body, rules) {
  var list = null;
  if (body.tenders !== undefined && body.tenders !== null) {
    list = plainList(body.tenders);
  } else {
    var legacy = legacySaleTenders(body, rules.total);
    if (legacy.status) return { ok: false, status: legacy.status, message: legacy.message };
    list = legacy.list;
  }
  var result = shared().checkSaleTenders(list, rules);
  if (!result.ok) {
    var r = refusal(result);
    return { ok: false, status: r.status, message: r.message };
  }
  return result;
}

/**
 * The checked tenders for a refund, or `{ status, message }`. `tenders`
 * wins; the legacy `refund_method` sends the whole amount back one way.
 * @param {object} body the request body
 * @param {{amount:number, hasCustomer:boolean}} rules
 */
function refundTenders(body, rules) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var list = null;
  if (body.tenders !== undefined && body.tenders !== null) {
    list = plainList(body.tenders);
  } else {
    var method = util.asStr(body.refund_method);
    if (method === "sumup_card") {
      return {
        ok: false,
        status: 400,
        message: "SumUp is no longer used. Refund card payments on the Tide reader.",
      };
    }
    if (!method || ["cash", "store_credit", "card_tide"].indexOf(method) < 0) {
      return {
        ok: false,
        status: 400,
        message: "Say how the refund is going back: cash, card or store credit.",
      };
    }
    list = rules.amount > 0 ? [{ method: method, amount: rules.amount }] : [];
  }
  var result = shared().checkRefundTenders(list, rules);
  if (!result.ok) {
    var r = refusal(result);
    return { ok: false, status: r.status, message: r.message };
  }
  return result;
}

/** A whole number of pence off an untyped value, or null. */
function wholePence(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value ? value : null;
}

/**
 * What a ticket leaves to pay once its trade-in and its returns are taken
 * off, in the words the payments refusal uses: "the trade-in", "the
 * exchange", or both.
 */
function leftAfter(rules) {
  var parts = [];
  if (rules.partExchange !== null && rules.partExchange !== undefined) parts.push("the trade-in");
  if (rules.exchange !== null && rules.exchange !== undefined) parts.push("the exchange");
  return parts.join(" and ");
}

/**
 * The checked tenders for a sale that may carry a part-exchange and an
 * exchange (docs/api-contract-epos.md, section 7), or `{ status, message }`.
 *
 * The server writes the `part_exchange` tender (what the trade-in pays
 * towards the sale) and the `exchange` tender (what the returned goods pay)
 * itself, so the request's own tenders only have to come to what is left,
 * `rules.total`. A till that sends those two tenders as well is taken at its
 * word only when it names the server's own figure; they are then left to
 * the server. Without a trade-in or returns on the ticket they go to the
 * shared rules like any other tender, which refuse them. The two the server
 * writes come after the request's own, part-exchange first.
 *
 * @param {object} body the request body
 * @param {{ total: number, requireCardLast4: boolean, hasCustomer: boolean,
 *   partExchange: number|null, exchange: number|null }} rules
 *   `total` is the sale after discounts less the part-exchange and the
 *   exchange; `partExchange` and `exchange` are null when the ticket has no
 *   trade-in or no returns.
 */
function ticketTenders(body, rules) {
  var money = require(__hooks + "/lib/shared/money.js");
  var px = rules.partExchange === undefined ? null : rules.partExchange;
  var ex = rules.exchange === undefined ? null : rules.exchange;
  if (px === null && ex === null) return saleTenders(body, rules);

  var request = {
    tenders: body.tenders,
    payment: body.payment,
    payment_split: body.payment_split,
    card_last4: body.card_last4,
  };
  // The other tenders "may be none" (section 7): a ticket the trade-in or
  // the returns cover needs no `tenders` at all, unless an older caller
  // names a `payment` instead.
  var util = require(__hooks + "/lib/vaultutil.js");
  if ((body.tenders === undefined || body.tenders === null) && !util.asStr(body.payment)) {
    request.tenders = [];
  }
  var sentPx = 0;
  var sentEx = 0;
  var sawPx = false;
  var sawEx = false;
  var rest = null;
  if (body.tenders !== undefined && body.tenders !== null) {
    var list = plainList(body.tenders);
    if (list && typeof list === "object" && typeof list.length === "number") {
      rest = [];
      for (var i = 0; i < list.length; i++) {
        var method = list[i] && list[i].method !== undefined ? String(list[i].method).trim() : "";
        var amount = wholePence(list[i] ? list[i].amount : null);
        if (method === "part_exchange" && px !== null) {
          sawPx = true;
          sentPx += amount === null ? 0 : amount;
        } else if (method === "exchange" && ex !== null) {
          sawEx = true;
          sentEx += amount === null ? 0 : amount;
        } else {
          rest.push(list[i]);
        }
      }
      request.tenders = rest;
    }
  }
  if (sawPx && sentPx !== px) {
    return {
      ok: false,
      status: 400,
      message:
        "The trade-in pays " +
        money.formatGBP(px) +
        " towards this sale, not " +
        money.formatGBP(sentPx) +
        ". Reload the ticket and try again.",
    };
  }
  if (sawEx && sentEx !== ex) {
    return {
      ok: false,
      status: 400,
      message:
        "The returns pay " +
        money.formatGBP(ex) +
        " towards this sale, not " +
        money.formatGBP(sentEx) +
        ". Reload the ticket and try again.",
    };
  }

  var result = saleTenders(request, rules);
  if (!result.ok) {
    // The shared sentence says "the total"; on this ticket what has to be
    // paid is what is left after the trade-in or the exchange, so say that.
    if (rest) {
      var paid = 0;
      for (var r = 0; r < rest.length; r++) {
        var p = wholePence(rest[r] ? rest[r].amount : null);
        paid += p === null ? 0 : p;
      }
      if (result.message === shared().sumProblem(paid, rules.total)) {
        result.message =
          "The payments come to " +
          money.formatGBP(paid) +
          " but " +
          money.formatGBP(rules.total) +
          " is left after " +
          leftAfter(rules) +
          ".";
      }
    }
    return result;
  }

  var tenders = result.tenders.slice();
  if (px !== null && px > 0) {
    tenders.push({ method: "part_exchange", amount: px, tendered: px, change: 0, card_last4: "", reference: "" });
  }
  if (ex !== null && ex > 0) {
    tenders.push({ method: "exchange", amount: ex, tendered: ex, change: 0, card_last4: "", reference: "" });
  }
  return { ok: true, tenders: tenders, paid: result.paid, change: result.change, cash: result.cash };
}

/**
 * The checked tenders for the refund half of an exchange: the part of the
 * returned goods' value the new sale does not take, back as cash, card or
 * store credit (`returns.tenders`), or `{ status, message }`. An absent list
 * is no tenders, which is right when nothing is left to give back.
 * @param {object} returns the request's `returns`
 * @param {{ amount: number, hasCustomer: boolean, exchange: number }} rules
 *   `amount` is what is left to give back after the exchange.
 */
function ticketRefundTenders(returns, rules) {
  var money = require(__hooks + "/lib/shared/money.js");
  var raw = returns && returns.tenders !== undefined && returns.tenders !== null ? returns.tenders : [];
  var result = refundTenders({ tenders: raw }, { amount: rules.amount, hasCustomer: rules.hasCustomer });
  if (!result.ok && rules.exchange > 0) {
    var list = plainList(raw);
    var paid = 0;
    if (list && typeof list === "object" && typeof list.length === "number") {
      for (var i = 0; i < list.length; i++) {
        var p = wholePence(list[i] ? list[i].amount : null);
        paid += p === null ? 0 : p;
      }
    }
    // checkRefundTenders' own sentence for tenders that do not come to the
    // amount (packages/shared/src/tenders.ts).
    var sumSentence =
      "The payments back come to " +
      money.formatGBP(paid) +
      " but the refund is " +
      money.formatGBP(rules.amount) +
      ".";
    if (result.message === sumSentence) {
      result.message =
        "The payments back come to " +
        money.formatGBP(paid) +
        " but " +
        money.formatGBP(rules.amount) +
        " is left to give back after the exchange.";
    }
  }
  return result;
}

/** The amount a set of checked tenders puts on one method. */
function amountFor(tenders, method) {
  var total = 0;
  for (var i = 0; i < tenders.length; i++) {
    if (tenders[i].method === method) total += tenders[i].amount;
  }
  return total;
}

/**
 * One `sale_tenders` row per tender. A refund's rows are negative and carry
 * its reference (GG-S-000456-R1); a sale's carry an empty one.
 * @returns {Array<object>} the tenders as the routes return them
 */
function writeTenders(txApp, opts) {
  var collection = txApp.findCollectionByNameOrId("sale_tenders");
  var sign = opts.refundRef ? -1 : 1;
  var out = [];
  for (var i = 0; i < opts.tenders.length; i++) {
    var t = opts.tenders[i];
    var row = new Record(collection);
    row.set("sale", opts.sale);
    row.set("refund_ref", opts.refundRef || "");
    row.set("method", t.method);
    row.set("amount", sign * t.amount);
    row.set("tendered", opts.refundRef ? 0 : t.tendered);
    row.set("change", opts.refundRef ? 0 : t.change);
    row.set("card_last4", t.card_last4 || "");
    row.set("reference", t.reference || "");
    if (opts.register) row.set("register", opts.register);
    if (opts.session) row.set("session", opts.session);
    if (opts.staff) row.set("staff", opts.staff);
    txApp.save(row);
    out.push(
      shared().toTender({
        method: t.method,
        amount: sign * t.amount,
        tendered: opts.refundRef ? 0 : t.tendered,
        change: opts.refundRef ? 0 : t.change,
        card_last4: t.card_last4,
        reference: t.reference,
      })
    );
  }
  return out;
}

/**
 * The drawer's movement for a cash tender: `cash_sale` in (positive) or
 * `refund` out (negative). Nothing is written for no cash.
 */
function writeCashMovement(txApp, opts) {
  if (!opts.amount) return null;
  var row = new Record(txApp.findCollectionByNameOrId("cash_movements"), {
    session: opts.session,
    type: opts.type,
    amount: opts.amount,
    ref: opts.ref,
    staff: opts.staff,
  });
  txApp.save(row);
  return row;
}

/**
 * A sale's tenders (refundRef "") or one refund's, oldest first, in the
 * route shape. A sale from before tenders existed has no rows; its
 * `payment_split` (or its single `payment`) stands in, so a historic SumUp
 * sale reads as "Card (SumUp)".
 */
function tendersFor(app, sale, refundRef) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var lib = shared();
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "sale_tenders",
      "sale = {:sale} && refund_ref = {:ref}",
      "created,id",
      0,
      0,
      { sale: sale.id, ref: refundRef || "" }
    );
  } catch (err) {
    rows = [];
  }
  // Rows written in one transaction share their `created` millisecond, so
  // the read order alone is not stable: put them in TENDER_METHODS order
  // (cash, then card, then the rest), keeping the read order within a
  // method, so a receipt and a lookup always list one sale's payments the
  // same way.
  var methods = require(__hooks + "/lib/shared/epos-types.js").TENDER_METHODS;
  rows = rows
    .filter(function (row) {
      return !!row;
    })
    .map(function (row, index) {
      var rank = methods.indexOf(row.getString("method"));
      return { row: row, rank: rank < 0 ? methods.length : rank, index: index };
    })
    .sort(function (a, b) {
      return a.rank - b.rank || a.index - b.index;
    })
    .map(function (entry) {
      return entry.row;
    });
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    out.push(
      lib.toTender({
        method: rows[i].getString("method"),
        amount: rows[i].getInt("amount"),
        tendered: rows[i].getInt("tendered"),
        change: rows[i].getInt("change"),
        card_last4: rows[i].getString("card_last4"),
        reference: rows[i].getString("reference"),
      })
    );
  }
  if (out.length || refundRef) return out;

  // A sale taken before sale_tenders: rebuild from what it stored.
  var split = util.jsonField(sale, "payment_split", null);
  if (split && typeof split === "object") {
    var keys = Object.keys(split);
    for (var k = 0; k < keys.length; k++) {
      var amount = util.asInt(split[keys[k]], 0);
      if (amount > 0) out.push(lib.toTender({ method: keys[k], amount: amount, tendered: amount }));
    }
  }
  var payment = sale.getString("payment");
  if (!out.length && payment && payment !== "mixed" && sale.getInt("total") > 0) {
    out.push(lib.toTender({ method: payment, amount: sale.getInt("total"), tendered: sale.getInt("total") }));
  }
  return out;
}

/** The change a set of tenders gave. */
function changeOf(tenders) {
  var total = 0;
  for (var i = 0; i < tenders.length; i++) total += tenders[i].change || 0;
  return total;
}

module.exports = {
  eposSettings: eposSettings,
  saleTenders: saleTenders,
  refundTenders: refundTenders,
  ticketTenders: ticketTenders,
  ticketRefundTenders: ticketRefundTenders,
  amountFor: amountFor,
  writeTenders: writeTenders,
  writeCashMovement: writeCashMovement,
  tendersFor: tendersFor,
  changeOf: changeOf,
};
