// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STANDARD_VAT_RATE = void 0;
exports.vatInside = vatInside;
exports.rateFor = rateFor;
exports.lineVat = lineVat;
exports.vatSummary = vatSummary;
exports.vatTotal = vatTotal;
/** The standard UK rate, for stock items, which carry no rate of their own. */
exports.STANDARD_VAT_RATE = 20;
/**
 * The VAT inside a VAT-inclusive amount at a percentage rate, rounded half-up
 * (symmetric for a negative amount, so a refund mirrors its sale). Worked in
 * whole numbers: the rate is scaled to thousandths of a percent, so 20, 5 and
 * 12.5 are all exact and no float rounding reaches the penny.
 */
function vatInside(gross, ratePercent) {
    if (!(ratePercent > 0) || gross === 0)
        return 0;
    const scaled = Math.round(ratePercent * 1000);
    const sign = gross < 0 ? -1 : 1;
    const numerator = Math.abs(gross) * scaled;
    const denominator = 100000 + scaled;
    // floor(n / d + 1/2) without a fractional intermediate.
    return sign * Math.floor((2 * numerator + denominator) / (2 * denominator));
}
/** The rate a line is charged at: its own rate when it carries VAT, otherwise 0. */
function rateFor(input) {
    if (!input.vatRegistered || input.taxScheme !== "standard")
        return 0;
    return input.rate > 0 ? input.rate : 0;
}
/** The VAT on one line: standard rated and VAT registered only, otherwise 0. */
function lineVat(input) {
    return vatInside(input.gross, rateFor(input));
}
/**
 * The per-rate summary for a receipt or a report: one row per rate, highest
 * rate first, from the lines that carried VAT. `net` is the amount before
 * VAT, so `net + vat = gross` on every row. Lines at a zero rate (margin,
 * exempt, or sold while not registered) are left out.
 */
function vatSummary(lines) {
    var _a;
    const byRate = new Map();
    for (const line of lines) {
        if (!(line.rate > 0))
            continue;
        const row = (_a = byRate.get(line.rate)) !== null && _a !== void 0 ? _a : { rate: line.rate, net: 0, vat: 0, gross: 0 };
        row.gross += line.gross;
        row.vat += line.vat;
        row.net = row.gross - row.vat;
        byRate.set(line.rate, row);
    }
    return [...byRate.values()].sort((a, b) => b.rate - a.rate);
}
/** The VAT a sale carries in total: the sum of its lines' own rounded VAT. */
function vatTotal(lines) {
    return lines.reduce((sum, line) => sum + line.vat, 0);
}
