// TCGCSV (https://tcgcsv.com/tcgplayer/{category}/...), the free daily
// TCGplayer dumps (docs/PLAN.md "Supporting sources"). Verified live on
// 2026-09-20 against category 71 (Lorcana): `/groups` returns
// `{totalItems, success, errors, results: [{groupId, name, categoryId,
// ...}]}`; `/{group}/products` the same shape with `{productId, groupId,
// ...}`; `/{group}/prices` `{success, errors, results: [{productId,
// lowPrice, midPrice, highPrice, marketPrice, directLowPrice,
// subTypeName}]}`. Every productId in a prices file appeared exactly once
// in the sample pulled while building this (no repeated productId under a
// different subTypeName), so unlike Cardmarket there is no separate
// finish-variant fan-out to do here.
import { fetchCachedJson } from "./http.mjs";
import { parseDecimalToMinor, convertMinorToGbpPence } from "./money.mjs";

/** Run `worker` over `items` with at most `limit` in flight at once. Plain
 * TCGCSV categories can carry hundreds of groups (Yu-Gi-Oh!'s 658, seen
 * live), so the products-file discovery phase below bounds its
 * concurrency rather than firing them all at once. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

export async function fetchGroups(baseUrl, categoryId, cacheDir, warn = () => {}) {
  const url = `${baseUrl}/${categoryId}/groups`;
  const { json } = await fetchCachedJson(url, cacheDir, `tcgcsv-${categoryId}-groups`, undefined, warn);
  return json?.results || [];
}

export async function fetchProducts(baseUrl, categoryId, groupId, cacheDir, warn = () => {}) {
  const url = `${baseUrl}/${categoryId}/${groupId}/products`;
  const { json } = await fetchCachedJson(url, cacheDir, `tcgcsv-${categoryId}-${groupId}-products`, undefined, warn);
  return json?.results || [];
}

export async function fetchPrices(baseUrl, categoryId, groupId, cacheDir, warn = () => {}) {
  const url = `${baseUrl}/${categoryId}/${groupId}/prices`;
  const { json } = await fetchCachedJson(url, cacheDir, `tcgcsv-${categoryId}-${groupId}-prices`, undefined, warn);
  return json?.results || [];
}

/**
 * Find which of a category's groups contain at least one wanted
 * tcgplayer_id, by fetching every group's /products file (there is no
 * single "all products in this category" endpoint - confirmed, both
 * `/tcgplayer/{category}/products` and an "ALL" group return 404). This
 * is the "build the map from the products file" option from the task
 * brief, chosen over storing a group id on `cards.external_ids`: nothing
 * in this codebase populates that field with one (no adapters exist yet
 * that would - see pb_hooks/, there is no adapters/ directory, and the
 * Phase 3 migration that has landed since, adapter_state, is an OAuth
 * token/sync-stamp store, not a card-to-group index). Products files
 * change far less often than prices, so after the first run this is
 * almost entirely served from the ETag cache.
 *
 * A single group's /products fetch failing (a timeout, a transient 5xx)
 * does not fail the whole game: it is retried once, and if it still
 * fails the group is simply skipped (its wanted ids, if any, are missed
 * for tonight and picked up once the next run's request succeeds) - one
 * summary warning names how many groups were skipped this way, rather
 * than one line per group, which would drown the real log in noise on a
 * bad network night. Discovery also stops as soon as every wanted id has
 * been found a group, rather than always checking every remaining group.
 */
export async function findRelevantGroups(baseUrl, categoryId, groups, wantedTcgplayerIds, cacheDir, concurrency = 8, warn = () => {}) {
  const relevant = new Set();
  const found = new Set();
  if (wantedTcgplayerIds.size === 0) return relevant;

  let stopped = false;
  let skippedGroups = 0;

  async function checkGroup(group) {
    if (stopped) return;
    let products;
    try {
      products = await fetchProducts(baseUrl, categoryId, group.groupId, cacheDir, warn);
    } catch {
      // One transient retry before giving up on this group for tonight.
      try {
        products = await fetchProducts(baseUrl, categoryId, group.groupId, cacheDir, warn);
      } catch {
        skippedGroups += 1;
        return;
      }
    }
    for (const product of products) {
      const id = String(product.productId);
      if (wantedTcgplayerIds.has(id) && !found.has(id)) {
        found.add(id);
        relevant.add(group.groupId);
      }
    }
    if (found.size >= wantedTcgplayerIds.size) stopped = true;
  }

  await mapWithConcurrency(groups, concurrency, async (group) => {
    if (stopped) return;
    await checkGroup(group);
  });

  if (skippedGroups > 0) {
    warn(`could not fetch /products for ${skippedGroups} group(s) after a retry; any of their wanted cards are missed this run`);
  }
  return relevant;
}

function minorOrZero(decimalString, fieldLabel, warn) {
  if (decimalString === null || decimalString === undefined) return 0;
  const minor = parseDecimalToMinor(decimalString);
  if (minor === null) {
    warn(`unparseable ${fieldLabel} value ${JSON.stringify(decimalString)}, treating as absent`);
    return 0;
  }
  return minor;
}

// TCGCSV's subTypeName is TCGplayer's own free-text printing/condition
// vocabulary ("Normal", "Holofoil", "Reverse Holofoil", "1st Edition",
// "1st Edition Holofoil", "Unlimited", ...) and does not match this app's
// own finish vocabulary (apps/web's stock intake and trade-in schemas:
// normal, holo, reverse, first_edition, foil, etched). Mapped through this
// table rather than written raw and lower-cased, so a card's finish reads
// the same way whether its price came from Cardmarket or TCGCSV. A
// subTypeName not listed here (a game-specific variant this table has not
// seen yet) falls back to a lower-cased, space-to-underscore version of
// the raw text rather than being dropped, so the row is still written.
const FINISH_ALIASES = {
  normal: "normal",
  foil: "foil",
  holofoil: "holo",
  "reverse holofoil": "reverse",
  "1st edition": "first_edition",
  "1st edition holofoil": "first_edition_holo",
  "1st edition normal": "first_edition",
  unlimited: "normal",
  etched: "etched",
  "etched foil": "etched",
};

function normalizeFinish(subTypeName) {
  if (typeof subTypeName !== "string" || !subTypeName.trim()) return "normal";
  const key = subTypeName.trim().toLowerCase();
  return FINISH_ALIASES[key] || key.replace(/\s+/g, "_");
}

/** Build the price_snapshots row for one TCGCSV prices entry, or null
 * when its productId is not a wanted tcgplayer_id. `fx` is
 * `{ gbpPerUsd, fxDatePb }`. A null marketPrice falls back to midPrice
 * (TCGplayer's median observed price) rather than being written as a
 * silent gbp_market of 0 - unparseable values (either field) are logged
 * through `warn` rather than left unexplained. */
export function buildTcgcsvRow(entry, cardsByTcgplayerId, fx, fetchedAtPb, warn = () => {}) {
  const card = cardsByTcgplayerId.get(String(entry.productId));
  if (!card) return null;

  const marketSource = entry.marketPrice ?? entry.midPrice ?? null;
  const nativeMarketMinor = minorOrZero(marketSource, "market", warn);
  return {
    card: card.id,
    finish: normalizeFinish(entry.subTypeName),
    source: "tcgplayer",
    native_currency: "USD",
    native_low: minorOrZero(entry.lowPrice, "low", warn),
    native_mid: minorOrZero(entry.midPrice, "mid", warn),
    native_market: nativeMarketMinor,
    fx_rate: fx.gbpPerUsd,
    fx_date: fx.fxDatePb,
    gbp_market: convertMinorToGbpPence(nativeMarketMinor, "USD", fx.gbpPerUsd),
    fetched_at: fetchedAtPb,
  };
}
