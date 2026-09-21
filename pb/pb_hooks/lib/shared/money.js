// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
/**
 * Money helpers. Every amount the app stores is an integer of GBP pence.
 * Foreign amounts are converted here, once, with an explicit rate, and the
 * result is rounded half-up to the penny. Decimal inputs are parsed as
 * strings so no float ever touches a price.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundHalfUp = roundHalfUp;
exports.parseDecimalToMinor = parseDecimalToMinor;
exports.formatGBP = formatGBP;
exports.convertMinorToGbpPence = convertMinorToGbpPence;
exports.usdCentsToGbpPence = usdCentsToGbpPence;
exports.eurDecimalToGbpPence = eurDecimalToGbpPence;
exports.applyPercent = applyPercent;
exports.roundToStep = roundToStep;
exports.roundToRetailEnding = roundToRetailEnding;
/** Round half-up to an integer, symmetric for negatives. */
function roundHalfUp(value) {
    const sign = value < 0 ? -1 : 1;
    return sign * Math.floor(Math.abs(value) + 0.5);
}
/**
 * Parse a decimal string such as "16.50", "£1,234.56", "$17", "0.45" into
 * integer minor units. Returns null for anything that is not a plain amount.
 */
function parseDecimalToMinor(input) {
    const cleaned = input.replace(/[£$€\s,]/g, "");
    if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned))
        return null;
    const negative = cleaned.startsWith("-");
    const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".");
    const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
    return negative ? -minor : minor;
}
/** Format pence as £1,234.56 (or -£1.00). Sub-pound values read £0.45. */
function formatGBP(pence) {
    const negative = pence < 0;
    const abs = Math.abs(pence);
    const pounds = Math.floor(abs / 100);
    const rem = abs % 100;
    const grouped = pounds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "-" : ""}£${grouped}.${rem.toString().padStart(2, "0")}`;
}
/**
 * Convert minor units of a foreign currency to GBP pence at a rate expressed
 * as GBP per one unit of the foreign currency (for example 0.8606 GBP per EUR).
 * Rounds half-up after conversion, never before.
 */
function convertMinorToGbpPence(minor, currency, gbpPerUnit) {
    if (currency === "GBP")
        return minor;
    if (!(gbpPerUnit > 0))
        throw new Error(`Invalid rate for ${currency}: ${gbpPerUnit}`);
    return roundHalfUp(minor * gbpPerUnit);
}
/** PriceCharting returns integer US cents ("1732" is $17.32). */
function usdCentsToGbpPence(cents, gbpPerUsd) {
    return convertMinorToGbpPence(cents, "USD", gbpPerUsd);
}
/** Cardmarket and Scryfall return EUR decimals as strings ("16.50"). */
function eurDecimalToGbpPence(eur, gbpPerEur) {
    const minor = parseDecimalToMinor(eur);
    if (minor === null)
        return null;
    return convertMinorToGbpPence(minor, "EUR", gbpPerEur);
}
/** Apply a percentage (for example 55 for 55 percent) to pence, half-up. */
function applyPercent(pence, percent) {
    return roundHalfUp((pence * percent) / 100);
}
/** Round pence to the nearest 25p, 50p or £1 step, half-up. */
function roundToStep(pence, step) {
    return roundHalfUp(pence / step) * step;
}
/** Sell-price rounding up to the next .49 or .99 ending (never below the input). */
function roundToRetailEnding(pence) {
    const pounds = Math.floor(pence / 100);
    const rem = pence % 100;
    if (rem <= 49)
        return pounds * 100 + 49;
    return pounds * 100 + 99;
}
