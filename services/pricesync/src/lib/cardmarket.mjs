// Cardmarket's public price guide files
// (https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_{gameId}.json,
// docs/PLAN.md "Card images and market prices"). Verified live on
// 2026-09-20: each is `{version, createdAt, priceGuides: [{idProduct,
// idCategory, avg, low, trend, avg1, avg7, avg30, ...}]}`, with the base
// fields plus one suffixed variant per game - Pokemon uses "-holo"
// (avg-holo, low-holo, trend-holo, avg7-holo, ...), the other four games
// use "-foil". This reads for either suffix on every entry rather than
// assuming which one a given game uses, since nothing else about the
// shape differs between them.
import { streamPickedArray } from "./json-stream.mjs";
import { convertMinorToGbpPence, parseDecimalToMinor } from "./money.mjs";

/** Pull one variant (the base card, or its -holo/-foil printing) out of a
 * raw price guide entry. Returns null when the source has no data for
 * this variant at all (no such holo/foil printing exists for this
 * product), so callers never write a row for a finish the card cannot
 * actually be bought in.
 *
 * Existence and the market value both treat a bare trend of exactly 0
 * specially, rather than reading "present" as simply "not null" (which is
 * how the task brief's field mapping reads most literally). Measured
 * against the committed fixture (test/fixtures/cardmarket-price-guide-19-
 * lorcana.json, the real Lorcana price guide, 3636 entries): 352 of them
 * have every "-foil" field null except trend-foil, which is exactly 0 -
 * Cardmarket's own "no such printing" default, not a real trend of zero.
 * Treating a present-but-zero trend as "this variant exists" would write
 * a spurious all-zero foil row on every one of those 352 cards. The same
 * zero can also show up on a variant that does have real data elsewhere
 * (low/avg/avg7 non-null) - low/avg/avg7 carry no such sentinel, so this
 * is judged on those three, and a real-but-zero trend is treated as "no
 * market signal from trend" rather than a genuine number worth reporting.
 * This fixture has no entry where trend is the *only* non-null field
 * (avg/low/avg7 all null) with a genuine non-zero value; that pattern was
 * observed spot-checking the other four games live while building this
 * (not persisted as a fixture, so no number from it is claimed here), and
 * `trendIsRealSignal` covers it exactly the same way should it occur.
 *
 * Field mapping, from the task brief: native_low = low, native_mid = avg,
 * native_market = trend when present else avg7 else avg, native_trend =
 * avg7 - with "present" read as "a real signal", not "not null", for
 * trend specifically, per the above. Every value is the exact decimal
 * string stream-json produced (numberAsString) - never a float. */
export function buildCardmarketVariant(entry, suffix) {
  const field = (base) => (suffix ? `${base}-${suffix}` : base);
  const low = entry[field("low")] ?? null;
  const avg = entry[field("avg")] ?? null;
  const trend = entry[field("trend")] ?? null;
  const avg7 = entry[field("avg7")] ?? null;

  const trendMinor = trend === null ? null : parseDecimalToMinor(trend);
  const trendIsRealSignal = trendMinor !== null && trendMinor !== 0;

  if (low === null && avg === null && avg7 === null && !trendIsRealSignal) return null;

  const market = (trendIsRealSignal ? trend : null) ?? avg7 ?? avg;
  return { low, mid: avg, market, trend: avg7 };
}

const VARIANTS = [
  { finish: "normal", suffix: null },
  { finish: "holo", suffix: "holo" },
  { finish: "foil", suffix: "foil" },
];

/** Convert one decimal-string field to an integer minor-unit amount, 0
 * when the source had no value. Logs (via `warn`) and treats as absent
 * rather than throwing when a value cannot be parsed (more than 2 decimal
 * places, scientific notation, etc) - seen on none of the five real files
 * sampled while building this, but the source is a third party's daily
 * export this service does not control. */
function minorOrZero(decimalString, fieldLabel, warn) {
  if (decimalString === null) return 0;
  const minor = parseDecimalToMinor(decimalString);
  if (minor === null) {
    warn(`unparseable ${fieldLabel} value ${JSON.stringify(decimalString)}, treating as absent`);
    return 0;
  }
  return minor;
}

/**
 * Build the price_snapshots row(s) for one raw price guide entry, or []
 * when its idProduct is not one of `cards`' wanted cardmarket_id values.
 * `fx` is `{ gbpPerEur, fxDatePb }`; `fetchedAtPb` is this run's fetched_at
 * (frozen once at the top of index.mjs so every row from one run shares
 * the same timestamp - see the module doc there).
 */
export function buildCardmarketRows(entry, cardsByCardmarketId, fx, fetchedAtPb, warn = () => {}) {
  const card = cardsByCardmarketId.get(String(entry.idProduct));
  if (!card) return [];

  const rows = [];
  for (const { finish, suffix } of VARIANTS) {
    const variant = buildCardmarketVariant(entry, suffix);
    if (!variant) continue;
    const nativeMarketMinor = minorOrZero(variant.market, `${finish} market`, warn);
    rows.push({
      card: card.id,
      finish,
      source: "cardmarket",
      native_currency: "EUR",
      native_low: minorOrZero(variant.low, `${finish} low`, warn),
      native_mid: minorOrZero(variant.mid, `${finish} mid`, warn),
      native_market: nativeMarketMinor,
      native_trend: minorOrZero(variant.trend, `${finish} trend`, warn),
      fx_rate: fx.gbpPerEur,
      fx_date: fx.fxDatePb,
      // Converted directly from the integer EUR-cent amount already
      // computed above - never round-tripped back through a decimal
      // string, so no float division of money ever happens here.
      gbp_market: convertMinorToGbpPence(nativeMarketMinor, "EUR", fx.gbpPerEur),
      fetched_at: fetchedAtPb,
    });
  }
  return rows;
}

/**
 * Stream one Cardmarket price guide file and collect the price_snapshots
 * rows built from it. Never buffers the file itself (it runs 15 to 26 MB -
 * docs/PLAN.md) or the entries that do not match: only the rows for
 * entries whose idProduct is wanted are kept, which is bounded by the
 * shop's own catalogue rather than Cardmarket's, so gathering just those
 * into an array is the same "do not buffer the file" optimisation the
 * task brief asks for, not a violation of it.
 *
 * Returns `{ seen, matched, rows }` - `seen` is every entry the file
 * carried for this game, `matched` is how many had an idProduct present in
 * `cardsByCardmarketId`, `rows` is every price_snapshots row built (a
 * matched entry can yield up to three: normal, holo, foil). Rejects
 * (rather than crashing the process) on malformed or non-JSON bytes - see
 * json-stream.mjs.
 */
export async function ingestCardmarketStream(nodeReadable, { cardsByCardmarketId, fx, fetchedAtPb, warn = () => {} }) {
  let seen = 0;
  let matched = 0;
  const rows = [];
  await streamPickedArray(nodeReadable, "priceGuides", (entry) => {
    seen += 1;
    const entryRows = buildCardmarketRows(entry, cardsByCardmarketId, fx, fetchedAtPb, warn);
    if (entryRows.length > 0) {
      matched += 1;
      rows.push(...entryRows);
    }
  });
  return { seen, matched, rows };
}
