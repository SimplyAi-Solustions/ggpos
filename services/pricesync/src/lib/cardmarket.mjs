// Cardmarket's public price guide files
// (https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_{gameId}.json,
// docs/PLAN.md "Card images and market prices"). Verified live against the
// real Magic (1), Yu-Gi-Oh! (3), Pokemon (6), One Piece (18) and Lorcana
// (19) files on 2026-09-20: each is `{version, createdAt, priceGuides: [
// {idProduct, idCategory, avg, low, trend, avg1, avg7, avg30, ...} ]}`,
// with the base fields plus one suffixed variant per game - Pokemon uses
// "-holo" (avg-holo, low-holo, trend-holo, avg7-holo, ...), the other four
// games use "-foil". This reads for either suffix on every entry rather
// than assuming which one a given game uses, since nothing else about the
// shape differs between them.
import { streamPickedArray } from "./json-stream.mjs";
import { convertMinorToGbpPence, parseDecimalToMinor } from "./money.mjs";

/** Pull one variant (the base card, or its -holo/-foil printing) out of a
 * raw price guide entry. Returns null when the source has no data for
 * this variant at all (no such holo/foil printing exists for this
 * product), so callers never write a row for a finish the card cannot
 * actually be bought in.
 *
 * Existence is judged on low/avg/avg7 only, deliberately ignoring a bare
 * trend of exactly 0: sampled across full or large partial pulls of all
 * five real files (2026-09-20), a suffixed "trend-holo"/"trend-foil" of
 * precisely 0 with low/avg/avg7 all null is Cardmarket's own "no such
 * printing" default - it accounted for 87-97% of every game's entries
 * (12835/13229 for One Piece alone) - while a *non-zero* trend with the
 * other three null is a real signal seen 500-1100 times per game (a
 * product with too little sales volume for an average, but some recent
 * trend). Treating every present trend as "exists", as the task brief's
 * field mapping reads most literally, would have written a spurious
 * all-zero snapshot for the ~90% of products with no holo/foil printing
 * at all; treating only low/avg/avg7 as the signal would have dropped the
 * 500-1100 genuine trend-only ones. This is the one place this module
 * departs from reading "present" as "not null", and only for the
 * existence check - the native_market/native_trend field mapping below
 * still follows the brief exactly, trend included.
 *
 * Field mapping, from the task brief: native_low = low, native_mid = avg,
 * native_market = trend when present else avg7 else avg, native_trend =
 * avg7. Every value is the exact decimal string stream-json produced
 * (numberAsString) - never a float. */
export function buildCardmarketVariant(entry, suffix) {
  const field = (base) => (suffix ? `${base}-${suffix}` : base);
  const low = entry[field("low")] ?? null;
  const avg = entry[field("avg")] ?? null;
  const trend = entry[field("trend")] ?? null;
  const avg7 = entry[field("avg7")] ?? null;

  const trendMinor = trend === null ? null : parseDecimalToMinor(trend);
  const trendIsRealSignal = trendMinor !== null && trendMinor !== 0;
  if (low === null && avg === null && avg7 === null && !trendIsRealSignal) return null;

  const market = trend ?? avg7 ?? avg;
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
 * matched entry can yield up to three: normal, holo, foil).
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
