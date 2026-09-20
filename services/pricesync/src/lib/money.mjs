// Money helpers, reimplemented locally because pricesync (plain Node, no
// build step) cannot import packages/shared/src/money.ts. This file
// mirrors that module's rules exactly (see CLAUDE.md, "Money" and
// docs/PLAN.md, "Currency: GBP everywhere"):
//
//   - every GBP amount is an integer of pence, never a float;
//   - foreign decimals (Cardmarket EUR, TCGCSV USD) are parsed from their
//     original string form into integer minor units, never through a
//     float that a JSON parser produced;
//   - conversion multiplies minor units by a GBP-per-unit rate and rounds
//     half-up to the penny AFTER conversion, never before.
//
// test/money.test.mjs pins the same numeric results as
// packages/shared/test/money.test.ts for every function this file shares
// with it, so the two implementations cannot silently drift apart.

/** Round half-up to an integer, symmetric for negatives. Matches
 * packages/shared/src/money.ts's roundHalfUp exactly. */
export function roundHalfUp(value) {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) + 0.5);
}

/**
 * Parse a decimal string such as "16.50", "1862.5", "130" or "0" into
 * integer minor units. Returns null for anything that is not a plain
 * amount (more than 2 decimal places, scientific notation, empty, etc).
 *
 * This is deliberately the same shape as
 * packages/shared/src/money.ts's parseDecimalToMinor: string in, integer
 * out, no float ever touches the value.
 */
export function parseDecimalToMinor(input) {
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[£$€\s,]/g, "");
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".");
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -minor : minor;
}

/**
 * Convert minor units of a foreign currency to GBP pence at a rate
 * expressed as GBP per one unit of the foreign currency (for example
 * 0.8606 GBP per EUR). Rounds half-up after conversion, never before.
 */
export function convertMinorToGbpPence(minor, currency, gbpPerUnit) {
  if (currency === "GBP") return minor;
  if (!(gbpPerUnit > 0)) throw new Error(`Invalid rate for ${currency}: ${gbpPerUnit}`);
  return roundHalfUp(minor * gbpPerUnit);
}

/** Cardmarket's price guide files carry EUR amounts; stream-json parses
 * them with numberAsString so they arrive here as decimal strings
 * ("16.50"), never as a float. Returns null when the source value was
 * null/missing or not a plain decimal. */
export function eurDecimalToGbpPence(eur, gbpPerEur) {
  const minor = parseDecimalToMinor(eur);
  if (minor === null) return null;
  return convertMinorToGbpPence(minor, "EUR", gbpPerEur);
}

/** TCGCSV's prices files carry USD decimal amounts (marketPrice, lowPrice,
 * midPrice), also parsed with numberAsString into strings. Symmetric with
 * eurDecimalToGbpPence above. */
export function usdDecimalToGbpPence(usd, gbpPerUsd) {
  const minor = parseDecimalToMinor(usd);
  if (minor === null) return null;
  return convertMinorToGbpPence(minor, "USD", gbpPerUsd);
}
