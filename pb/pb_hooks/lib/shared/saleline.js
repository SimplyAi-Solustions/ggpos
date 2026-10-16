// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.grossOf = grossOf;
exports.spread = spread;
exports.breakdown = breakdown;
exports.cumNet = cumNet;
exports.refundAmount = refundAmount;
exports.remainingQty = remainingQty;
exports.pointsCum = pointsCum;
/**
 * What each sale line was actually paid, from immutable as-sold figures.
 *
 * A mirror of `pb/pb_hooks/lib/saleline.js`: the refund route, the stock book
 * export and the counter's refund sheet all have to agree to the penny, so the
 * arithmetic lives in one place and both sides read it.
 *
 * `sale_lines.qty` and `.discount` are written once at sale completion and
 * never rewritten; a refund only ever moves `sale_lines.refunded_qty` and
 * `sales.refunded_total`. Everything here therefore reads the same numbers
 * whatever has been refunded so far, which is what makes a sequence of partial
 * refunds add up to exactly what was taken for the sale.
 *
 *   lineGross = unit_price * qty - discount
 *   allocation = the line's pro rata share of sales.discount, rounded
 *                half-up, with the LAST line taking whatever is left so the
 *                allocations sum to sales.discount exactly
 *   lineNet   = lineGross - allocation          (sum of lineNet = sales.total)
 *   cumNet(n) = roundHalfUp(lineNet * n / qty)  (cumNet(qty) = lineNet)
 *
 * The amount due for refunding `r` more units of a line that already has
 * `refunded_qty` back is cumNet(refunded_qty + r) - cumNet(refunded_qty), so
 * every unit of every line is paid back once and only once.
 *
 * The server orders the lines "created,id" before it allocates, because lines
 * written in one transaction share a `created` timestamp to the millisecond
 * and the remainder has to land on the same line every time. Callers here
 * pass the lines in that same order.
 */
const money_1 = require("./money");
/** unit_price * qty - discount, all as sold. */
function grossOf(line) {
    return line.unitPrice * Math.max(1, line.qty) - line.discount;
}
/**
 * Spread a sale-level discount across per-line gross amounts, pro rata, with
 * the last entry absorbing the remainder so the allocations sum to `discount`
 * exactly and no penny is lost or invented.
 */
function spread(grosses, discount) {
    const total = grosses.reduce((sum, value) => sum + value, 0);
    const out = [];
    let allocated = 0;
    for (let n = 0; n < grosses.length; n++) {
        let allocation = 0;
        if (discount > 0 && total > 0) {
            if (n === grosses.length - 1) {
                allocation = discount - allocated;
            }
            else {
                allocation = (0, money_1.roundHalfUp)((discount * grosses[n]) / total);
                allocated += allocation;
            }
        }
        out.push(grosses[n] - allocation);
    }
    return out;
}
/** The as-sold breakdown of one sale, lines in "created,id" order. */
function breakdown(lines, saleDiscount) {
    const grosses = lines.map(grossOf);
    const nets = spread(grosses, saleDiscount);
    const rows = lines.map((line, index) => ({
        id: line.id,
        qty: Math.max(1, line.qty),
        gross: grosses[index],
        allocation: grosses[index] - nets[index],
        net: nets[index],
        refundedQty: line.refundedQty,
    }));
    const byId = {};
    for (const row of rows)
        byId[row.id] = row;
    return {
        lines: rows,
        byId,
        gross: grosses.reduce((sum, value) => sum + value, 0),
        net: nets.reduce((sum, value) => sum + value, 0),
    };
}
/**
 * What the first `n` units of a line came to. `cumNet(qty)` is the line's
 * whole net, so the per-unit amounts always add back up to it.
 */
function cumNet(lineNet, qty, n) {
    if (qty <= 0)
        return 0;
    if (n <= 0)
        return 0;
    if (n >= qty)
        return lineNet;
    return (0, money_1.roundHalfUp)((lineNet * n) / qty);
}
/**
 * What refunding `more` further units of a line comes to, given what has
 * already gone back. Cumulative, so any sequence of partial refunds adds up to
 * the line's net and never past it.
 */
function refundAmount(line, more) {
    const already = Math.max(0, Math.min(line.qty, line.refundedQty));
    const after = Math.max(already, Math.min(line.qty, already + more));
    return cumNet(line.net, line.qty, after) - cumNet(line.net, line.qty, already);
}
/** How many units of a line are still refundable. */
function remainingQty(line) {
    return Math.max(0, line.qty - line.refundedQty);
}
/**
 * Points to reverse when a sale's refunded total reaches `refundedTotal`
 * pence. Cumulative, so any sequence of partial refunds reverses exactly the
 * points the sale earned and no more.
 */
function pointsCum(pointsEarned, saleTotal, refundedTotal) {
    if (saleTotal <= 0 || pointsEarned === 0)
        return 0;
    if (refundedTotal <= 0)
        return 0;
    if (refundedTotal >= saleTotal)
        return pointsEarned;
    return (0, money_1.roundHalfUp)((pointsEarned * refundedTotal) / saleTotal);
}
