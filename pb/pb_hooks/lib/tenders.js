/**
 * Tenders at the till (docs/api-contract-epos.md, section 4): the glue
 * between a sale or refund request and the shared rules in
 * lib/shared/tenders.js, and the writes those routes make with the result.
 *
 * - `saleTenders(body, rules)` / `refundTenders(body, rules)` read the
 *   request's `tenders`, or map the legacy `payment` / `payment_split` and
 *   `refund_method` onto tenders for older callers, then run the shared
 *   check. Each returns the checked tenders or `{ status, message }`.
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
  amountFor: amountFor,
  writeTenders: writeTenders,
  writeCashMovement: writeCashMovement,
  tendersFor: tendersFor,
  changeOf: changeOf,
};
