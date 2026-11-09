// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEAL_PCT_MAX = exports.DEAL_PCT_MIN = exports.DEFAULT_DEAL_RATES = void 0;
exports.clampDealPct = clampDealPct;
exports.dealLine = dealLine;
exports.overrideTarget = overrideTarget;
exports.computeDeal = computeDeal;
exports.effectivePct = effectivePct;
exports.splitDeal = splitDeal;
exports.dealPayout = dealPayout;
exports.payoutLines = payoutLines;
/**
 * The buy-in deal calculator's maths.
 *
 * A deal values every card twice, as store credit ("trade") and as cash, at
 * two sweep rates of the card's market value: 80% trade and 70% cash unless
 * the shop or the staff member says otherwise. One card can carry its own
 * rate for either figure. Staff can then key a final total for either side,
 * as an amount or as a new percentage, and every card's figure is rescaled
 * pro rata so the lines still add up to the total exactly. A customer who
 * wants some cash takes it out of the cash total, and what is left converts
 * to credit at the trade rate.
 *
 * Every amount is integer GBP pence. Rounding goes through `applyPercent`
 * and `roundHalfUp`, and pennies are spread with `allocatePence`, so nothing
 * here rounds in a way of its own.
 */
const money_1 = require("./money");
/** The owner's defaults, used when settings do not say otherwise. */
exports.DEFAULT_DEAL_RATES = { tradePct: 80, cashPct: 70 };
/** The steps the rate controls move in, and the range they allow. */
exports.DEAL_PCT_MIN = 0;
exports.DEAL_PCT_MAX = 200;
/** A percentage clamped to the range the calculator allows. */
function clampDealPct(pct) {
    if (!Number.isFinite(pct))
        return 0;
    return Math.min(exports.DEAL_PCT_MAX, Math.max(exports.DEAL_PCT_MIN, pct));
}
/** One line at the sweep, or at its own rates. */
function dealLine(line, rates) {
    var _a, _b, _c, _d;
    const qty = Math.max(1, Math.floor(line.qty));
    const market = Math.max(0, line.marketPence) * qty;
    const tradeCustom = line.tradePct !== undefined;
    const cashCustom = line.cashPct !== undefined;
    const tradePct = clampDealPct((_a = line.tradePct) !== null && _a !== void 0 ? _a : rates.tradePct);
    const cashPct = clampDealPct((_b = line.cashPct) !== null && _b !== void 0 ? _b : rates.cashPct);
    const fixed = line.fixedTrade !== undefined || line.fixedCash !== undefined;
    // Per unit first, so the stored per-unit offer times the quantity is the
    // line's figure exactly.
    const tradeUnit = (_c = line.fixedTrade) !== null && _c !== void 0 ? _c : (0, money_1.applyPercent)(Math.max(0, line.marketPence), tradePct);
    const cashUnit = (_d = line.fixedCash) !== null && _d !== void 0 ? _d : (0, money_1.applyPercent)(Math.max(0, line.marketPence), cashPct);
    return {
        market,
        calculatedTrade: tradeUnit * qty,
        calculatedCash: cashUnit * qty,
        trade: tradeUnit * qty,
        cash: cashUnit * qty,
        tradePct,
        cashPct,
        tradeCustom,
        cashCustom,
        fixed,
    };
}
/** The total a final override asks for, from the market and the calculated figure. */
function overrideTarget(override, market, calculated) {
    if (!override)
        return null;
    if (override.kind === "amount")
        return Math.max(0, Math.floor(override.pence));
    if (!Number.isFinite(override.pct))
        return calculated;
    return (0, money_1.applyPercent)(market, clampDealPct(override.pct));
}
/**
 * Rescale the lines' figures pro rata to a new total, per unit, so a line of
 * several units keeps one price per unit. Lines with nothing calculated
 * share by market value instead, and failing that equally.
 */
function rescale(target, calculated, markets, qtys) {
    const anyCalculated = calculated.some((value) => value > 0);
    const weights = anyCalculated ? calculated : markets;
    return (0, money_1.allocatePence)(target, weights, qtys);
}
/** The whole deal: every line, both totals, and the final override applied. */
function computeDeal(inputs, rates, overrides = {}) {
    const lines = inputs.map((line) => dealLine(line, rates));
    const qtys = inputs.map((line) => Math.max(1, Math.floor(line.qty)));
    const market = lines.reduce((sum, line) => sum + line.market, 0);
    const calculatedTrade = lines.reduce((sum, line) => sum + line.calculatedTrade, 0);
    const calculatedCash = lines.reduce((sum, line) => sum + line.calculatedCash, 0);
    const tradeTarget = lines.length ? overrideTarget(overrides.trade, market, calculatedTrade) : null;
    const cashTarget = lines.length ? overrideTarget(overrides.cash, market, calculatedCash) : null;
    if (tradeTarget !== null) {
        const parts = rescale(tradeTarget, lines.map((line) => line.calculatedTrade), lines.map((line) => line.market), qtys);
        lines.forEach((line, i) => {
            line.trade = parts[i];
        });
    }
    if (cashTarget !== null) {
        const parts = rescale(cashTarget, lines.map((line) => line.calculatedCash), lines.map((line) => line.market), qtys);
        lines.forEach((line, i) => {
            line.cash = parts[i];
        });
    }
    return {
        lines,
        market,
        calculatedTrade,
        calculatedCash,
        // Read back off the lines, so the total is always what they add up to.
        trade: lines.reduce((sum, line) => sum + line.trade, 0),
        cash: lines.reduce((sum, line) => sum + line.cash, 0),
        tradeOverridden: tradeTarget !== null,
        cashOverridden: cashTarget !== null,
    };
}
/** A figure as a percentage of market value, to one decimal place. */
function effectivePct(figure, market) {
    if (!(market > 0))
        return 0;
    return (0, money_1.roundHalfUp)((figure * 1000) / market) / 10;
}
/**
 * Part cash, part credit. The cash taken comes out of the cash total, and
 * the share of the deal it does not cover converts to credit at the trade
 * total: credit = trade x (1 - cash taken / cash total), half-up to the
 * penny. £100.00 trade and £87.50 cash with £35.00 taken gives £60.00 credit.
 */
function splitDeal(trade, cashTotal, cashTaken) {
    if (!(cashTotal > 0))
        return { cash: 0, credit: Math.max(0, trade) };
    const cash = Math.min(Math.max(0, Math.floor(cashTaken)), cashTotal);
    const credit = (0, money_1.roundHalfUp)((Math.max(0, trade) * (cashTotal - cash)) / cashTotal);
    return { cash, credit };
}
/**
 * What the customer is paid. All credit is the trade total, all cash is the
 * cash total, and a mixed payout is `splitDeal`. A mixed payout with no cash
 * in it is a credit payout, and one that takes the whole cash total is a
 * cash payout, so the type always says what really happens.
 */
function dealPayout(type, deal, cashTaken) {
    if (type === "cash")
        return { type: "cash", cash: deal.cash, credit: 0 };
    if (type === "credit")
        return { type: "credit", cash: 0, credit: deal.trade };
    const split = splitDeal(deal.trade, deal.cash, cashTaken);
    if (split.cash <= 0)
        return { type: "credit", cash: 0, credit: deal.trade };
    if (split.credit <= 0)
        return { type: "cash", cash: split.cash, credit: 0 };
    return { type: "mixed", cash: split.cash, credit: split.credit };
}
/**
 * What each line is recorded at for the payout being made, so the lines add
 * up to cash plus credit exactly (the completion route refuses anything
 * else). Credit uses the trade figures and cash the cash figures as they
 * stand; a mixed payout spreads cash plus credit over the lines in
 * proportion to their trade figures. In the rare case where every line has
 * several units and a penny cannot be placed, the credit gives up that
 * penny so the record and the payout still agree.
 */
function payoutLines(deal, qtys, payout) {
    const units = deal.lines.map((_, i) => { var _a; return Math.max(1, Math.floor((_a = qtys[i]) !== null && _a !== void 0 ? _a : 1)); });
    const figures = payout.type === "cash"
        ? deal.lines.map((line) => line.cash)
        : payout.type === "credit"
            ? deal.lines.map((line) => line.trade)
            : (0, money_1.allocatePence)(payout.cash + payout.credit, deal.lines.map((line) => (line.trade > 0 ? line.trade : line.market)), units);
    const perUnit = figures.map((figure, i) => Math.floor(figure / units[i]));
    const recorded = perUnit.reduce((sum, unit, i) => sum + unit * units[i], 0);
    const owed = payout.cash + payout.credit;
    if (recorded === owed)
        return { perUnit, payout };
    // Only the credit side ever moves, and only down to what was recorded.
    const credit = Math.max(0, recorded - payout.cash);
    return { perUnit, payout: Object.assign(Object.assign({}, payout), { credit }) };
}
