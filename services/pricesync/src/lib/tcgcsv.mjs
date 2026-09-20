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
// finish-variant fan-out to do here: `subTypeName` ("Normal", "Holofoil",
// "Reverse Holofoil", ...) is used directly, lower-cased, as the row's
// finish.
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

export async function fetchGroups(baseUrl, categoryId, cacheDir) {
  const url = `${baseUrl}/${categoryId}/groups`;
  const { json } = await fetchCachedJson(url, cacheDir, `tcgcsv-${categoryId}-groups`);
  return json?.results || [];
}

export async function fetchProducts(baseUrl, categoryId, groupId, cacheDir) {
  const url = `${baseUrl}/${categoryId}/${groupId}/products`;
  const { json } = await fetchCachedJson(url, cacheDir, `tcgcsv-${categoryId}-${groupId}-products`);
  return json?.results || [];
}

export async function fetchPrices(baseUrl, categoryId, groupId, cacheDir) {
  const url = `${baseUrl}/${categoryId}/${groupId}/prices`;
  const { json } = await fetchCachedJson(url, cacheDir, `tcgcsv-${categoryId}-${groupId}-prices`);
  return json?.results || [];
}

/**
 * Find which of a category's groups contain at least one wanted
 * tcgplayer_id, by fetching every group's /products file (there is no
 * single "all products in this category" endpoint - confirmed, both
 * `/tcgplayer/{category}/products` and an "ALL" group return 404). This
 * is the "build the map from the products file" option from the task
 * brief, chosen over storing a group id on `cards.external_ids`: nothing
 * in this codebase populates that field yet (no adapters exist before
 * this phase - see pb_hooks/, there is no adapters/ directory), so there
 * is no group id to read from it. Products files change far less often
 * than prices, so after the first run this is almost entirely served from
 * the ETag cache; the first run's cost is the one real downside, and it
 * is bounded by mapWithConcurrency rather than fetched all at once.
 */
export async function findRelevantGroups(baseUrl, categoryId, groups, wantedTcgplayerIds, cacheDir, concurrency = 8) {
  const relevant = new Set();
  if (wantedTcgplayerIds.size === 0) return relevant;
  await mapWithConcurrency(groups, concurrency, async (group) => {
    const products = await fetchProducts(baseUrl, categoryId, group.groupId, cacheDir);
    for (const product of products) {
      if (wantedTcgplayerIds.has(String(product.productId))) {
        relevant.add(group.groupId);
        return;
      }
    }
  });
  return relevant;
}

function minorOrZero(decimalString) {
  if (decimalString === null || decimalString === undefined) return 0;
  const minor = parseDecimalToMinor(decimalString);
  return minor === null ? 0 : minor;
}

/** Build the price_snapshots row for one TCGCSV prices entry, or null
 * when its productId is not a wanted tcgplayer_id. `fx` is
 * `{ gbpPerUsd, fxDatePb }`. */
export function buildTcgcsvRow(entry, cardsByTcgplayerId, fx, fetchedAtPb) {
  const card = cardsByTcgplayerId.get(String(entry.productId));
  if (!card) return null;

  const nativeMarketMinor = minorOrZero(entry.marketPrice);
  return {
    card: card.id,
    finish: typeof entry.subTypeName === "string" && entry.subTypeName ? entry.subTypeName.toLowerCase() : "normal",
    source: "tcgplayer",
    native_currency: "USD",
    native_low: minorOrZero(entry.lowPrice),
    native_mid: minorOrZero(entry.midPrice),
    native_market: nativeMarketMinor,
    fx_rate: fx.gbpPerUsd,
    fx_date: fx.fxDatePb,
    gbp_market: convertMinorToGbpPence(nativeMarketMinor, "USD", fx.gbpPerUsd),
    fetched_at: fetchedAtPb,
  };
}
