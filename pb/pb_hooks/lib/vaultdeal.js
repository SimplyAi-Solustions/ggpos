/**
 * The Vault deal: a trade-in priced by the canonical deal maths
 * (packages/shared/src/deal.ts, generated into lib/shared/deal.js) from the
 * fields 1789821460_vault_deal.js adds. Used by vaultdeal.pb.js.
 * Transaction-agnostic reads; require() inside the handler body
 * (pb/README.md on pb_hooks isolation).
 *
 * Stored field -> canonical input:
 *   trade_ins.trade_pct / cash_pct (0 or empty = default)  -> DealRates
 *   trade_ins.{trade,cash}_override_kind amount|pct + _pence / _pct
 *                                                          -> DealOverrides { trade?, cash? }
 *   trade_in_lines.market_price, qty                       -> marketPence, qty
 *   trade_in_lines.trade_pct / cash_pct (JSON, null = sweep) -> tradePct / cashPct
 *   trade_in_lines.override_reason set -> override_credit / override_cash
 *                                                          -> fixedTrade / fixedCash
 */

var OVERRIDE_FIELDS = [
  "trade_override_kind",
  "trade_override_pence",
  "trade_override_pct",
  "cash_override_kind",
  "cash_override_pence",
  "cash_override_pct",
];

/** A per-line rate: a number 0 to 200, or undefined for "follow the sweep". */
function lineRate(record, name) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var value = util.jsonField(record, name, null);
  return typeof value === "number" && isFinite(value) && value >= 0 && value <= 200 ? value : undefined;
}

/** DealRates for a trade-in: its own sweep, or the shop default. */
function ratesFor(tradeIn) {
  var deal = require(__hooks + "/lib/shared/deal.js");
  var t = tradeIn.getFloat("trade_pct");
  var c = tradeIn.getFloat("cash_pct");
  return {
    tradePct: t > 0 ? t : deal.DEFAULT_DEAL_RATES.tradePct,
    cashPct: c > 0 ? c : deal.DEFAULT_DEAL_RATES.cashPct,
  };
}

/** One side of DealOverrides, or null. */
function sideOverride(tradeIn, side) {
  var kind = tradeIn.getString(side + "_override_kind");
  if (kind === "amount") return { kind: "amount", pence: tradeIn.getInt(side + "_override_pence") };
  if (kind === "pct") return { kind: "pct", pct: tradeIn.getFloat(side + "_override_pct") };
  return null;
}

function overridesFor(tradeIn) {
  return { trade: sideOverride(tradeIn, "trade"), cash: sideOverride(tradeIn, "cash") };
}

/** DealLineInput for each line. */
function inputsFor(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var input = {
      marketPence: line.getInt("market_price"),
      qty: Math.max(1, line.getInt("qty")),
    };
    var tradePct = lineRate(line, "trade_pct");
    var cashPct = lineRate(line, "cash_pct");
    if (tradePct !== undefined) input.tradePct = tradePct;
    if (cashPct !== undefined) input.cashPct = cashPct;
    // A line priced by hand with a reason: the counter's own override
    // fields become the canonical fixed figures.
    if (line.getString("override_reason")) {
      input.fixedTrade = line.getInt("override_credit");
      input.fixedCash = line.getInt("override_cash");
    }
    out.push(input);
  }
  return out;
}

/** The canonical Deal for a trade-in and its accepted lines, with the qtys. */
function computeFor(tradeIn, lines) {
  var deal = require(__hooks + "/lib/shared/deal.js");
  var inputs = inputsFor(lines);
  var rates = ratesFor(tradeIn);
  return {
    deal: deal.computeDeal(inputs, rates, overridesFor(tradeIn)),
    rates: rates,
    qtys: inputs.map(function (x) {
      return x.qty;
    }),
  };
}

function overrideShape(o) {
  if (!o) return null;
  return o.kind === "amount" ? { kind: "amount", pence: o.pence } : { kind: "pct", pct: o.pct };
}

/** The deal as GET /api/vault/deals/{id} returns it. */
function shape(tradeIn, lines, computed) {
  var dealLib = require(__hooks + "/lib/shared/deal.js");
  var d = computed.deal;
  var outLines = [];
  for (var i = 0; i < lines.length; i++) {
    var v = d.lines[i];
    outLines.push({
      id: lines[i].id,
      market_price: lines[i].getInt("market_price"),
      market_source: lines[i].getString("market_source"),
      qty: computed.qtys[i],
      market: v.market,
      trade_pct: v.tradePct,
      cash_pct: v.cashPct,
      trade_custom: v.tradeCustom,
      cash_custom: v.cashCustom,
      fixed: v.fixed,
      calculated_trade: v.calculatedTrade,
      calculated_cash: v.calculatedCash,
      trade: v.trade,
      cash: v.cash,
    });
  }
  var o = overridesFor(tradeIn);
  return {
    id: tradeIn.id,
    status: tradeIn.getString("status"),
    trade_pct: computed.rates.tradePct,
    cash_pct: computed.rates.cashPct,
    market_total: d.market,
    calculated_trade: d.calculatedTrade,
    calculated_cash: d.calculatedCash,
    trade_total: d.trade,
    cash_total: d.cash,
    trade_effective_pct: dealLib.effectivePct(d.trade, d.market),
    cash_effective_pct: dealLib.effectivePct(d.cash, d.market),
    overrides: {
      trade: overrideShape(o.trade),
      cash: overrideShape(o.cash),
      reason: tradeIn.getString("override_reason"),
      by: tradeIn.getString("override_by"),
      at: tradeIn.getString("override_at"),
    },
    payout_cash: tradeIn.getInt("payout_cash"),
    payout_credit: tradeIn.getInt("payout_credit"),
    lines: outLines,
  };
}

/**
 * Before a trade_ins create or update through the collection API: who set
 * the final overrides and when are stamped from the caller's token, never
 * taken from the body; clearing a side's kind clears its figures.
 */
function stampOverride(e, isCreate) {
  var r = e.record;
  var orig = isCreate ? null : r.original();
  var changed = false;
  for (var i = 0; i < OVERRIDE_FIELDS.length; i++) {
    var f = OVERRIDE_FIELDS[i];
    var now = r.getString(f);
    var before = orig ? orig.getString(f) : "";
    if (isCreate ? now !== "" && now !== "0" : now !== before) changed = true;
  }
  r.set("override_by", orig ? orig.getString("override_by") : "");
  r.set("override_at", orig ? orig.getString("override_at") : "");
  var sides = ["trade", "cash"];
  for (var s = 0; s < sides.length; s++) {
    if (!r.getString(sides[s] + "_override_kind")) {
      r.set(sides[s] + "_override_pence", 0);
      r.set(sides[s] + "_override_pct", 0);
    }
  }
  if (!r.getString("trade_override_kind") && !r.getString("cash_override_kind")) {
    r.set("override_by", "");
    r.set("override_at", "");
    return;
  }
  if (changed) {
    var auth = e.auth;
    if (auth && auth.collection().name === "staff") r.set("override_by", auth.id);
    r.set("override_at", new Date().toISOString());
  }
}

/** trade_in_lines.trade_pct / cash_pct: null, or a percent from 0 to 200. */
function checkLineRates(e) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var names = ["trade_pct", "cash_pct"];
  for (var i = 0; i < names.length; i++) {
    var value = util.jsonField(e.record, names[i], null);
    if (value === null) continue;
    if (typeof value !== "number" || !isFinite(value) || value < 0 || value > 200) {
      throw e.badRequestError(
        "The line's " +
          (names[i] === "trade_pct" ? "trade" : "cash") +
          " rate has to be a percent from 0 to 200, or empty to use the deal's rate.",
        null
      );
    }
  }
}

module.exports = {
  lineRate: lineRate,
  ratesFor: ratesFor,
  overridesFor: overridesFor,
  inputsFor: inputsFor,
  computeFor: computeFor,
  shape: shape,
  stampOverride: stampOverride,
  checkLineRates: checkLineRates,
};
