// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REDUCED_VAT_RATE = exports.VAT_TREATMENTS = exports.STANDARD_VAT_RATE = void 0;
exports.vatInside = vatInside;
exports.rateFor = rateFor;
exports.lineVat = lineVat;
exports.vatSummary = vatSummary;
exports.vatTotal = vatTotal;
exports.isTaxScheme = isTaxScheme;
exports.isVatTreatment = isVatTreatment;
exports.treatmentOf = treatmentOf;
exports.treatmentFields = treatmentFields;
exports.standardRateOf = standardRateOf;
exports.treatmentLabel = treatmentLabel;
exports.resolveVat = resolveVat;
exports.registeredFromDay = registeredFromDay;
exports.vatApplies = vatApplies;
exports.marginVat = marginVat;
exports.keptLine = keptLine;
/**
 * VAT on a sale (docs/api-contract-epos.md, section 4, "VAT").
 *
 * Every price in the shop is VAT inclusive, so VAT is worked out inside a
 * line's gross amount (what the customer paid for it, after its discount and
 * its share of a ticket discount), rounded half-up per line. Only standard
 * rated lines carry VAT, and only while the shop is VAT registered; margin
 * scheme lines never show VAT (it sits on the margin and is worked out in the
 * stock book), and exempt lines have none.
 *
 * Pure and shared: the server stores what this says on each `sale_lines` row
 * and on `sales.vat_total`, and the receipt and the X and Z reports summarise
 * the same figures by rate, so a till preview and a printed receipt cannot
 * disagree by a penny.
 *
 * Since the launch (docs/api-contract-launch.md, section 3) this is also the
 * one place a stored scheme and rate become the rate a line is charged at
 * (`resolveVat`), the one place the registration date is applied
 * (`vatApplies`), and the one place a margin scheme line's VAT is worked out
 * (`marginVat`, `keptLine`), for the sale route, the dashboard, the margin
 * report and the VAT return alike.
 */
const bookings_1 = require("./bookings");
const saleline_1 = require("./saleline");
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
exports.VAT_TREATMENTS = ["margin", "standard", "reduced", "zero", "exempt"];
/** The UK reduced rate. */
exports.REDUCED_VAT_RATE = 5;
const SCHEMES = ["margin", "standard", "zero", "exempt"];
function isTaxScheme(value) {
    return typeof value === "string" && SCHEMES.includes(value);
}
function isVatTreatment(value) {
    return typeof value === "string" && exports.VAT_TREATMENTS.includes(value);
}
/** The treatment a stored scheme and rate stand for, or null when nothing is set. */
function treatmentOf(scheme, rate) {
    if (!isTaxScheme(scheme))
        return null;
    if (scheme !== "standard")
        return scheme;
    return rate === exports.REDUCED_VAT_RATE ? "reduced" : "standard";
}
/** What a treatment is stored as on an item, a till product, a sale line or a branch. */
function treatmentFields(treatment) {
    switch (treatment) {
        case "reduced":
            return { tax_scheme: "standard", vat_rate: exports.REDUCED_VAT_RATE };
        case "standard":
            return { tax_scheme: "standard", vat_rate: 0 };
        default:
            return { tax_scheme: treatment, vat_rate: 0 };
    }
}
/** The shop's standard rate from `settings.vat_standard_rate`, 20 when it is unset. */
function standardRateOf(value) {
    const rate = typeof value === "number" ? value : Number(value);
    return Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : exports.STANDARD_VAT_RATE;
}
/** "Standard 20%", "Reduced 5%", "Zero 0%", "Margin scheme", "Exempt". */
function treatmentLabel(treatment, standardRate = exports.STANDARD_VAT_RATE) {
    switch (treatment) {
        case "margin":
            return "Margin scheme";
        case "standard":
            return `Standard ${standardRateOf(standardRate)}%`;
        case "reduced":
            return `Reduced ${exports.REDUCED_VAT_RATE}%`;
        case "zero":
            return "Zero 0%";
        default:
            return "Exempt";
    }
}
/**
 * The scheme a line sells under and the rate it carries when VAT is
 * charged: the item's or till product's own treatment, else its branch's
 * default, else `fallback` (margin for stock, standard for a till product).
 * A standard row with no rate of its own is the shop's standard rate. Only a
 * standard line carries a rate; whether it is charged is `vatApplies` and
 * `rateFor`.
 */
function resolveVat(input) {
    var _a, _b, _c;
    const source = isTaxScheme((_a = input.own) === null || _a === void 0 ? void 0 : _a.scheme)
        ? input.own
        : isTaxScheme((_b = input.branch) === null || _b === void 0 ? void 0 : _b.scheme)
            ? input.branch
            : null;
    const scheme = source && isTaxScheme(source.scheme) ? source.scheme : input.fallback;
    if (scheme !== "standard")
        return { scheme, rate: 0 };
    const own = Number((_c = source === null || source === void 0 ? void 0 : source.rate) !== null && _c !== void 0 ? _c : 0);
    return { scheme, rate: Number.isFinite(own) && own > 0 ? own : standardRateOf(input.standardRate) };
}
/** The registration date as a shop-time calendar day, or "" when there is none. */
function registeredFromDay(from) {
    const day = (from !== null && from !== void 0 ? from : "").trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}
/**
 * Whether a sale made at `at` is inside the shop's VAT registration: VAT is
 * switched on and the sale's shop-time date is on or after
 * `vat_registered_from` (any date when none is set). Nothing is charged as
 * VAT outside it, and a sale before the date never is.
 */
function vatApplies(registration, at) {
    if (!registration.registered)
        return false;
    const from = registeredFromDay(registration.from);
    return from === "" || (0, bookings_1.shopDateOf)(at) >= from;
}
/**
 * The VAT due on a margin scheme line: the rate's fraction of its margin
 * (one sixth at 20 percent), rounded half-up, and nothing on a sale at a
 * loss. A loss on one line never reduces the VAT on another.
 */
function marginVat(margin, standardRate) {
    return margin > 0 ? vatInside(margin, standardRate) : 0;
}
/**
 * A line with `refunded` units back: the amount kept (the shared refund
 * arithmetic, so it agrees with the refund route to the penny), the cost of
 * the units kept, and the VAT due. A standard line's VAT is inside what was
 * kept at the rate it was charged; a margin line's is `marginVat` on what
 * was kept less its cost, and only inside the registration (`inScope`);
 * zero, exempt and anything uncharged carry none.
 */
function keptLine(line, refunded, options) {
    const qty = Math.max(1, line.qty);
    const back = Math.max(0, Math.min(qty, refunded));
    const gross = line.net - (0, saleline_1.cumNet)(line.net, qty, back);
    const cost = line.unitCost * (qty - back);
    let vat = 0;
    if (line.scheme === "standard")
        vat = vatInside(gross, line.rate);
    else if (line.scheme === "margin" && options.inScope)
        vat = marginVat(gross - cost, options.standardRate);
    return { gross, cost, vat, exVat: gross - vat };
}
