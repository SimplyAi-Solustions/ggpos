// Pure mapping logic for TCGCSV rows. The network-facing pieces
// (fetchGroups/findRelevantGroups/fetchPrices, all thin wrappers around
// fetchCachedJson) are exercised end to end in test/pipeline.test.mjs
// against a fake HTTP server instead of mocked here, so what a real
// response looks like is only asserted in one place.
//
// The shapes asserted below are real, not invented: fetched live on
// 2026-09-20 from https://tcgcsv.com/tcgplayer/71/groups (Lorcana,
// category 71 per docs/PLAN.md) and its /{group}/products and
// /{group}/prices for group 17690 ("D23 Promos"). Every productId in that
// prices response appeared exactly once (no repeated id under a different
// subTypeName), which is why buildTcgcsvRow does not fan a single TCGCSV
// entry out into several finishes the way buildCardmarketRows does.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { buildTcgcsvRow, mapWithConcurrency } from "../src/lib/tcgcsv.mjs";
import { parseJsonStream } from "../src/lib/json-stream.mjs";

// A trimmed but verbatim slice of the real /tcgplayer/71/17690/prices
// response (see the module doc above) - numbers kept exactly as TCGCSV
// sent them, parsed below through the same numberAsString path
// production uses.
const REAL_PRICES_RESPONSE = `{
  "success": true,
  "errors": [],
  "results": [
    { "productId": 454233, "lowPrice": 2499.99, "midPrice": 2499.99, "highPrice": 2499.99, "marketPrice": 1142.8, "directLowPrice": null, "subTypeName": "Normal" },
    { "productId": 559532, "lowPrice": 225, "midPrice": 250, "highPrice": 801.49, "marketPrice": 209.05, "directLowPrice": null, "subTypeName": "Holofoil" },
    { "productId": 999999, "lowPrice": null, "midPrice": null, "highPrice": null, "marketPrice": null, "directLowPrice": null, "subTypeName": "Normal" }
  ]
}`;

const FX = { gbpPerUsd: 0.7421, fxDatePb: "2026-09-20 07:00:00.000Z" };
const FETCHED_AT = "2026-09-20 04:00:00.000Z";

describe("buildTcgcsvRow", () => {
  test("maps a wanted productId's lowPrice/midPrice/marketPrice, converting to GBP pence at a fixed rate, half-up", async () => {
    const { results } = await parseJsonStream(Readable.from(REAL_PRICES_RESPONSE));
    const entry = results.find((r) => r.productId === "454233");
    const cardsByTcgplayerId = new Map([["454233", { id: "card_normal" }]]);

    const row = buildTcgcsvRow(entry, cardsByTcgplayerId, FX, FETCHED_AT);
    assert.deepEqual(row, {
      card: "card_normal",
      finish: "normal",
      source: "tcgplayer",
      native_currency: "USD",
      native_low: 249999, // "2499.99"
      native_mid: 249999,
      native_market: 114280, // "1142.8" -> $1142.80
      fx_rate: 0.7421,
      fx_date: FX.fxDatePb,
      gbp_market: 84807, // 114280 * 0.7421 = 84807.188 -> half-up -> 84807
      fetched_at: FETCHED_AT,
    });
  });

  test("uses the entry's own subTypeName as the finish, lower-cased", async () => {
    const { results } = await parseJsonStream(Readable.from(REAL_PRICES_RESPONSE));
    const entry = results.find((r) => r.productId === "559532");
    const cardsByTcgplayerId = new Map([["559532", { id: "card_holo" }]]);

    const row = buildTcgcsvRow(entry, cardsByTcgplayerId, FX, FETCHED_AT);
    assert.equal(row.finish, "holofoil");
    assert.equal(row.native_low, 22500);
    assert.equal(row.native_market, 20905);
  });

  test("a productId with no price data at all still yields a row of zeros, not a crash", async () => {
    const { results } = await parseJsonStream(Readable.from(REAL_PRICES_RESPONSE));
    const entry = results.find((r) => r.productId === "999999");
    const cardsByTcgplayerId = new Map([["999999", { id: "card_no_data" }]]);

    const row = buildTcgcsvRow(entry, cardsByTcgplayerId, FX, FETCHED_AT);
    assert.equal(row.native_low, 0);
    assert.equal(row.native_mid, 0);
    assert.equal(row.native_market, 0);
    assert.equal(row.gbp_market, 0);
  });

  test("a productId that is not wanted yields no row", async () => {
    const { results } = await parseJsonStream(Readable.from(REAL_PRICES_RESPONSE));
    const entry = results.find((r) => r.productId === "454233");
    const row = buildTcgcsvRow(entry, new Map(), FX, FETCHED_AT);
    assert.equal(row, null);
  });
});

describe("mapWithConcurrency", () => {
  test("runs every item, respecting the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 3, async (i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return i * 2;
    });
    assert.deepEqual(results, items.map((i) => i * 2));
    assert.ok(maxInFlight <= 3, `expected at most 3 concurrent, saw ${maxInFlight}`);
  });
});
