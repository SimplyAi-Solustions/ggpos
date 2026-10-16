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

import http from "node:http";

import { buildTcgcsvRow, mapWithConcurrency, findRelevantGroups } from "../src/lib/tcgcsv.mjs";
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

  test("maps the entry's own subTypeName through the finish alias table, not raw and lower-cased", async () => {
    const { results } = await parseJsonStream(Readable.from(REAL_PRICES_RESPONSE));
    const entry = results.find((r) => r.productId === "559532");
    const cardsByTcgplayerId = new Map([["559532", { id: "card_holo" }]]);

    const row = buildTcgcsvRow(entry, cardsByTcgplayerId, FX, FETCHED_AT);
    // subTypeName is "Holofoil" (see REAL_PRICES_RESPONSE) - the app's own
    // finish vocabulary (apps/web's stock/tradein schemas) calls this
    // "holo", not the raw TCGplayer term, so cards priced from Cardmarket
    // and from TCGCSV read the same way on screen.
    assert.equal(row.finish, "holo");
    assert.equal(row.native_low, 22500);
    assert.equal(row.native_market, 20905);
  });

  test("maps every finish alias table entry as expected, and falls back sensibly for an unlisted one", async () => {
    const base = { productId: 1, lowPrice: "1", midPrice: "1", marketPrice: "1" };
    const cardsByTcgplayerId = new Map([["1", { id: "card_x" }]]);
    const cases = [
      ["Normal", "normal"],
      ["Foil", "foil"],
      ["Holofoil", "holo"],
      ["Reverse Holofoil", "reverse"],
      ["1st Edition", "first_edition"],
      ["1st Edition Holofoil", "first_edition_holo"],
      ["Unlimited", "normal"],
      ["", "normal"],
      [null, "normal"],
      ["Some Future Variant", "some_future_variant"],
    ];
    for (const [subTypeName, expectedFinish] of cases) {
      const row = buildTcgcsvRow({ ...base, subTypeName }, cardsByTcgplayerId, FX, FETCHED_AT);
      assert.equal(row.finish, expectedFinish, `subTypeName ${JSON.stringify(subTypeName)} should map to ${expectedFinish}`);
    }
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

  test("a null marketPrice falls back to midPrice rather than a silent zero", () => {
    const cardsByTcgplayerId = new Map([["1", { id: "card_x" }]]);
    const row = buildTcgcsvRow(
      { productId: "1", lowPrice: "10", midPrice: "15", marketPrice: null, subTypeName: "Normal" },
      cardsByTcgplayerId,
      FX,
      FETCHED_AT
    );
    assert.equal(row.native_market, 1500);
  });

  test("an unparseable price value is warned about and treated as absent, not silently zero with no trace", () => {
    const cardsByTcgplayerId = new Map([["1", { id: "card_x" }]]);
    const warnings = [];
    const row = buildTcgcsvRow(
      { productId: "1", lowPrice: "not-a-number", midPrice: "15", marketPrice: "22.5", subTypeName: "Normal" },
      cardsByTcgplayerId,
      FX,
      FETCHED_AT,
      (msg) => warnings.push(msg)
    );
    assert.equal(row.native_low, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unparseable low value/);
  });
});

describe("findRelevantGroups", () => {
  function listenOnFreePort(server) {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  }

  test("stops checking further groups once every wanted id has been found", async () => {
    const requestedGroups = [];
    const groups = [{ groupId: 1 }, { groupId: 2 }, { groupId: 3 }, { groupId: 4 }, { groupId: 5 }];
    const server = http.createServer((req, res) => {
      const m = req.url.match(/^\/tcgplayer\/3\/(\d+)\/products$/);
      const groupId = Number(m[1]);
      requestedGroups.push(groupId);
      // The wanted id lives in group 2; every group is served one at a
      // time under a concurrency of 1 below so "stops early" is
      // deterministic rather than a race between concurrent requests.
      const results = groupId === 2 ? [{ productId: 42, groupId }] : [{ productId: 999, groupId }];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, errors: [], results }));
    });
    const port = await listenOnFreePort(server);
    try {
      const cacheDir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/pricesync-tcgcsv-"));
      const relevant = await findRelevantGroups(`http://127.0.0.1:${port}/tcgplayer`, 3, groups, new Set(["42"]), cacheDir, 1);
      assert.deepEqual([...relevant], [2]);
      assert.deepEqual(requestedGroups, [1, 2], "should not have checked groups 3, 4 or 5 once the only wanted id was found in group 2");
    } finally {
      server.close();
    }
  });

  test("a group whose /products fetch fails twice is skipped with one summary warning, not a thrown error", async () => {
    let attempts = 0;
    const groups = [{ groupId: 1 }, { groupId: 2 }];
    const server = http.createServer((req, res) => {
      const m = req.url.match(/^\/tcgplayer\/3\/(\d+)\/products$/);
      const groupId = Number(m[1]);
      if (groupId === 1) {
        attempts += 1;
        res.writeHead(500);
        return res.end("server error");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, errors: [], results: [{ productId: 7, groupId }] }));
    });
    const port = await listenOnFreePort(server);
    try {
      const cacheDir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/pricesync-tcgcsv-"));
      const warnings = [];
      const relevant = await findRelevantGroups(`http://127.0.0.1:${port}/tcgplayer`, 3, groups, new Set(["7"]), cacheDir, 2, (m) =>
        warnings.push(m)
      );
      assert.deepEqual([...relevant], [2]);
      assert.equal(attempts, 2, "group 1's failing fetch should have been retried exactly once");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /could not fetch \/products for 1 group/);
    } finally {
      server.close();
    }
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
