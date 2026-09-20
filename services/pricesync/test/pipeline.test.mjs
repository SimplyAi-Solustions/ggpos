// Runs the whole pipeline (src/index.mjs's run()) against a fake
// PocketBase, a fake Cardmarket price guide host and a fake TCGCSV host,
// all served by one small node:http server, exactly as the task brief
// asks for. Fixtures here are hand-crafted (not the real download used in
// cardmarket.test.mjs) so each scenario - the market/mid/trend fallback
// chain, a same-day update, a stale FX refusal, an ETag short-circuit -
// is deliberate and easy to read, rather than hunting for a real entry
// that happens to exercise it.
//
// Only the "pokemon" game is seeded as enabled; the other four in
// GAME_CONFIG (mtg, yugioh, onepiece, lorcana) are simply absent from the
// fake `games` collection, so index.mjs logs "game not found... skipping"
// for them and this server never needs to answer for five Cardmarket
// files and five TCGCSV categories to exercise one game's worth of both
// sources.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run, HardFailure } from "../src/index.mjs";

// --- a tiny fake PocketBase + Cardmarket + TCGCSV server -------------------

function evalClause(record, clause) {
  const m = clause.trim().match(/^(\w+)\s*(!=|>=|<=|=)\s*"((?:[^"\\]|\\.)*)"$/);
  if (!m) throw new Error(`fake PocketBase: cannot evaluate filter clause: ${clause}`);
  const [, field, op, rawValue] = m;
  const value = rawValue.replace(/\\"/g, '"');
  const actual = record[field] ?? "";
  if (op === "=") return actual === value;
  if (op === "!=") return actual !== value;
  if (op === ">=") return actual >= value;
  return actual <= value; // "<="
}

function evalFilter(record, filterStr) {
  if (!filterStr) return true;
  if (filterStr.includes(" || ")) return filterStr.split(" || ").some((c) => evalClause(record, c));
  if (filterStr.includes(" && ")) return filterStr.split(" && ").every((c) => evalClause(record, c));
  return evalClause(record, filterStr);
}

function queryCollection(rows, { filter, sort, page = 1, perPage = 30, fields }) {
  let result = rows.filter((r) => evalFilter(r, filter));
  if (sort) {
    const desc = sort.startsWith("-");
    const field = desc ? sort.slice(1) : sort;
    result = result.slice().sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (desc ? -1 : 1));
  }
  const totalItems = result.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const pageItems = result.slice((page - 1) * perPage, page * perPage);
  const fieldList = fields ? fields.split(",") : null;
  const items = pageItems.map((r) => (fieldList ? Object.fromEntries(fieldList.map((f) => [f, r[f] ?? ""])) : { ...r }));
  return { items, page, perPage, totalItems, totalPages };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

/** `db` is a plain `{ collectionName: [records] }` object the test seeds
 * before calling run(). `cachedFiles` maps a served path to
 * `{ body, etag }`; a matching If-None-Match gets a 304, and every
 * request (full or 304) is counted in `requestCounts`. */
function createFakeServer({ db, cachedFiles }) {
  let nextId = 1;
  const genId = () => `rec${String(nextId++).padStart(6, "0")}`;
  const capturedBatches = [];
  const requestCounts = new Map(); // path -> { full, notModified }

  function countRequest(pathname, kind) {
    const entry = requestCounts.get(pathname) || { full: 0, notModified: 0 };
    entry[kind] += 1;
    requestCounts.set(pathname, entry);
  }

  function handleOneBatchRequest(r) {
    const m = r.url.match(/^\/api\/collections\/([\w]+)\/records(?:\/([\w-]+))?$/);
    if (!m) return { status: 404, body: { message: "not found" } };
    const [, collection, id] = m;
    db[collection] = db[collection] || [];
    if (r.method === "POST") {
      const record = { id: genId(), created: "2026-09-20 04:00:00.000Z", updated: "2026-09-20 04:00:00.000Z", ...r.body };
      db[collection].push(record);
      return { status: 200, body: record };
    }
    if (r.method === "PATCH") {
      const record = db[collection].find((x) => x.id === id);
      if (!record) return { status: 404, body: { message: "not found" } };
      Object.assign(record, r.body, { updated: "2026-09-20 04:00:00.000Z" });
      return { status: 200, body: record };
    }
    return { status: 400, body: { message: `unsupported method ${r.method}` } };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    // --- cached file hosts (Cardmarket, TCGCSV) ---------------------------
    if (cachedFiles[url.pathname]) {
      const { body, etag } = cachedFiles[url.pathname];
      if (req.headers["if-none-match"] === etag) {
        countRequest(url.pathname, "notModified");
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      countRequest(url.pathname, "full");
      res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
      return res.end(body);
    }

    // --- PocketBase auth ---------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/collections/_superusers/auth-with-password") {
      await readBody(req);
      return sendJson(res, 200, { token: "test-superuser-token", record: { id: "su1" } });
    }

    // --- PocketBase settings (batch API) ------------------------------------
    if (req.method === "GET" && url.pathname === "/api/settings") {
      return sendJson(res, 200, { batch: { enabled: true, maxRequests: 200, timeout: 3, maxBodySize: 0 } });
    }

    // --- PocketBase batch ----------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/batch") {
      const body = await readBody(req);
      capturedBatches.push(body.requests);
      const results = body.requests.map(handleOneBatchRequest);
      return sendJson(res, 200, results);
    }

    // --- PocketBase generic collection listing --------------------------------
    const listMatch = url.pathname.match(/^\/api\/collections\/([\w]+)\/records$/);
    if (req.method === "GET" && listMatch) {
      const [, collection] = listMatch;
      const rows = db[collection] || [];
      const result = queryCollection(rows, {
        filter: url.searchParams.get("filter"),
        sort: url.searchParams.get("sort"),
        page: Number(url.searchParams.get("page")) || 1,
        perPage: Number(url.searchParams.get("perPage")) || 30,
        fields: url.searchParams.get("fields"),
      });
      return sendJson(res, 200, result);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: `fake server: no route for ${req.method} ${url.pathname}` }));
  });

  return { server, capturedBatches, requestCounts, db };
}

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

// --- fixtures ----------------------------------------------------------------

// Cardmarket, hand-crafted to exercise every tier of the "market = trend
// when present else avg7 else avg" fallback in one small file: 1001 has a
// trend, 1002's base has none (falls back to avg7) and a holo variant with
// its own trend, 1003 has neither trend nor avg7 (falls back to avg),
// 9999 is not in any card's cardmarket_id (tests seen-but-unmatched).
const CARDMARKET_FIXTURE = `{
  "version": 1,
  "createdAt": "2026-09-20T02:40:00+0000",
  "priceGuides": [
    { "idProduct": 1001, "idCategory": 1, "avg": 10.00, "low": 8.00, "trend": 9.50, "avg1": null, "avg7": 9.00, "avg30": 9.20, "avg-holo": null, "low-holo": null, "trend-holo": 0, "avg1-holo": null, "avg7-holo": null, "avg30-holo": null },
    { "idProduct": 1002, "idCategory": 1, "avg": 5.00, "low": 4.00, "trend": null, "avg1": null, "avg7": 4.50, "avg30": 4.60, "avg-holo": 20.00, "low-holo": 18.00, "trend-holo": 19.00, "avg1-holo": null, "avg7-holo": 18.50, "avg30-holo": 18.75 },
    { "idProduct": 1003, "idCategory": 1, "avg": 3.33, "low": 2.00, "trend": null, "avg1": null, "avg7": null, "avg30": 3.00, "avg-holo": null, "low-holo": null, "trend-holo": 0, "avg1-holo": null, "avg7-holo": null, "avg30-holo": null },
    { "idProduct": 9999, "idCategory": 1, "avg": 100.00, "low": 90.00, "trend": 95.00, "avg1": null, "avg7": 92.00, "avg30": 93.00, "avg-holo": null, "low-holo": null, "trend-holo": 0, "avg1-holo": null, "avg7-holo": null, "avg30-holo": null }
  ]
}`;

const TCGCSV_GROUPS_FIXTURE = JSON.stringify({
  totalItems: 1,
  success: true,
  errors: [],
  results: [{ groupId: 555, name: "Test Set", abbreviation: "TS", isSupplemental: false, publishedOn: "2026-01-01", modifiedOn: "2026-01-01", categoryId: 3 }],
});

const TCGCSV_PRODUCTS_FIXTURE = JSON.stringify({
  totalItems: 3,
  success: true,
  errors: [],
  results: [
    { productId: 5001, name: "Card D", groupId: 555, categoryId: 3 },
    { productId: 5002, name: "Card B", groupId: 555, categoryId: 3 },
    { productId: 5999, name: "Unwanted", groupId: 555, categoryId: 3 },
  ],
});

const TCGCSV_PRICES_FIXTURE = `{
  "success": true,
  "errors": [],
  "results": [
    { "productId": 5001, "lowPrice": 12.00, "midPrice": 12.50, "highPrice": 15.00, "marketPrice": 13.25, "directLowPrice": null, "subTypeName": "Normal" },
    { "productId": 5002, "lowPrice": 20.00, "midPrice": 21.00, "highPrice": 25.00, "marketPrice": 22.50, "directLowPrice": null, "subTypeName": "Holofoil" },
    { "productId": 5999, "lowPrice": 1, "midPrice": 1, "highPrice": 1, "marketPrice": 1, "directLowPrice": null, "subTypeName": "Normal" }
  ]
}`;

function buildDb() {
  return {
    games: [{ id: "game_pokemon", key: "pokemon", enabled: true }],
    cards: [
      { id: "cardA", game: "game_pokemon", cardmarket_id: "1001", tcgplayer_id: "", prices: null },
      { id: "cardB", game: "game_pokemon", cardmarket_id: "1002", tcgplayer_id: "5002", prices: null },
      { id: "cardC", game: "game_pokemon", cardmarket_id: "1003", tcgplayer_id: "", prices: null },
      { id: "cardD", game: "game_pokemon", cardmarket_id: "", tcgplayer_id: "5001", prices: { cardmarket: { finish: "normal", note: "stale, from a previous source that should be kept" } } },
    ],
    fx_rates: [{ id: "fx1", base: "GBP", quotes: { EUR: 0.8606, USD: 0.7421 }, fetched_at: "2026-09-20 07:00:00.000Z" }],
    price_snapshots: [
      // Already written earlier today for cardA/normal/cardmarket - the
      // run must PATCH this row, not create a second one.
      {
        id: "existing-snap-a",
        card: "cardA",
        finish: "normal",
        source: "cardmarket",
        native_currency: "EUR",
        native_low: 1,
        native_mid: 1,
        native_market: 1,
        native_trend: 1,
        fetched_at: "2026-09-20 01:00:00.000Z",
      },
      // Written yesterday for cardC - must NOT be treated as "today", so
      // cardC gets a fresh POST instead of patching this one.
      {
        id: "yesterday-snap-c",
        card: "cardC",
        finish: "normal",
        source: "cardmarket",
        native_currency: "EUR",
        native_low: 1,
        native_mid: 1,
        native_market: 1,
        native_trend: 1,
        fetched_at: "2026-09-19 04:00:00.000Z",
      },
    ],
  };
}

/** The most recently fetched price_snapshots row for a (card, finish,
 * source) key. Several tests deliberately seed a row from a different day
 * under the same key (to prove it is left alone rather than reused), so
 * picking "the" match by array order would find whichever happens to be
 * seeded first instead of whatever this run actually wrote. */
function latestByKey(rows, card, finish, source) {
  return rows
    .filter((r) => r.card === card && r.finish === finish && r.source === source)
    .sort((a, b) => (a.fetched_at < b.fetched_at ? -1 : a.fetched_at > b.fetched_at ? 1 : 0))
    .at(-1);
}

function envFor(port, cacheDir) {
  return {
    PB_URL: `http://127.0.0.1:${port}`,
    PB_SUPERUSER_EMAIL: "sync@example.test",
    PB_SUPERUSER_PASSWORD: "hunter2hunter2",
    CACHE_DIR: cacheDir,
    CARDMARKET_BASE_URL: `http://127.0.0.1:${port}/priceguide`,
    TCGCSV_BASE_URL: `http://127.0.0.1:${port}/tcgplayer`,
  };
}

describe("pricesync pipeline", () => {
  let cacheDir;

  before(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "pricesync-cache-"));
  });
  after(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("writes correct source/currency/pence for both Cardmarket and TCGCSV, maps mid/market/trend, updates same-day rows instead of duplicating, and merges cards.prices", async () => {
    const db = buildDb();
    const { server, capturedBatches } = createFakeServer({
      db,
      cachedFiles: {
        "/priceguide/price_guide_6.json": { body: CARDMARKET_FIXTURE, etag: `"cm-6-v1"` },
        "/tcgplayer/3/groups": { body: TCGCSV_GROUPS_FIXTURE, etag: `"tc-groups-v1"` },
        "/tcgplayer/3/555/products": { body: TCGCSV_PRODUCTS_FIXTURE, etag: `"tc-products-v1"` },
        "/tcgplayer/3/555/prices": { body: TCGCSV_PRICES_FIXTURE, etag: `"tc-prices-v1"` },
      },
    });
    const port = await listenOnFreePort(server);
    try {
      const result = await run(envFor(port, path.join(cacheDir, "run1")), { now: () => new Date("2026-09-20T04:00:00.000Z") });
      assert.equal(result.exitCode, 0, `expected a clean exit, got summary: ${JSON.stringify(result.summary)}`);

      // --- Cardmarket: source, currency, mapping, conversion -----------------
      // The seed data includes rows from other days sharing a (card, finish,
      // source) key on purpose (to prove they are left alone) - pick the
      // most recently fetched match, which is the one this run wrote or
      // updated, rather than whichever happens to be first in the array.
      const byKey = (card, finish, source) => latestByKey(db.price_snapshots, card, finish, source);

      const cardA = byKey("cardA", "normal", "cardmarket");
      assert.ok(cardA, "cardA/normal/cardmarket row missing");
      assert.equal(cardA.id, "existing-snap-a", "the existing same-day row should have been updated in place, not duplicated");
      assert.equal(cardA.native_currency, "EUR");
      assert.equal(cardA.native_low, 800);
      assert.equal(cardA.native_mid, 1000);
      assert.equal(cardA.native_market, 950, "market should be trend (9.50) when trend is present");
      assert.equal(cardA.native_trend, 900);
      assert.equal(cardA.gbp_market, 818); // 950 * 0.8606 = 817.57 -> half-up -> 818
      assert.equal(cardA.fx_rate, 0.8606);

      const cardBNormal = byKey("cardB", "normal", "cardmarket");
      assert.equal(cardBNormal.native_market, 450, "market should fall back to avg7 (4.50) when trend is null");
      assert.equal(cardBNormal.gbp_market, 387); // 450 * 0.8606 = 387.27 -> 387

      const cardBHolo = byKey("cardB", "holo", "cardmarket");
      assert.ok(cardBHolo, "cardB should also get a holo row");
      assert.equal(cardBHolo.native_low, 1800);
      assert.equal(cardBHolo.native_mid, 2000);
      assert.equal(cardBHolo.native_market, 1900);
      assert.equal(cardBHolo.gbp_market, 1635); // 1900 * 0.8606 = 1635.14 -> 1635

      const cardC = byKey("cardC", "normal", "cardmarket");
      assert.notEqual(cardC.id, "yesterday-snap-c", "a row from a previous day must not be reused - this should be a fresh row");
      assert.equal(cardC.native_market, 333, "market should fall back to avg (3.33) when both trend and avg7 are null");
      assert.equal(cardC.native_trend, 0, "native_trend should be 0 (not written as null) when avg7 is absent");
      assert.equal(cardC.gbp_market, 287); // 333 * 0.8606 = 286.58 -> 287

      // Two rows overall is correct here - yesterday's seeded one, left
      // alone, plus today's - the invariant is one row per *day*, not one
      // ever: exactly one of them is dated today.
      assert.equal(
        db.price_snapshots.filter(
          (r) => r.card === "cardC" && r.finish === "normal" && r.source === "cardmarket" && r.fetched_at.startsWith("2026-09-20")
        ).length,
        1,
        "cardC must have exactly one normal/cardmarket row for today, not two"
      );
      assert.equal(
        db.price_snapshots.filter((r) => r.card === "cardC" && r.finish === "normal" && r.source === "cardmarket").length,
        2,
        "yesterday's row should still be there too, untouched"
      );

      assert.equal(byKey("cardA", "holo", "cardmarket"), undefined, "cardA has no holo data and must not get a holo row");
      assert.ok(
        !db.price_snapshots.some((r) => r.source === "cardmarket" && r.native_market === 9500 && r.card !== "cardA"),
        "idProduct 9999 (not any card's cardmarket_id) must not have been written anywhere"
      );

      // --- TCGCSV: source, currency, mapping, conversion ----------------------
      const cardD = byKey("cardD", "normal", "tcgplayer");
      assert.ok(cardD, "cardD/normal/tcgplayer row missing");
      assert.equal(cardD.native_currency, "USD");
      assert.equal(cardD.native_low, 1200);
      assert.equal(cardD.native_mid, 1250);
      assert.equal(cardD.native_market, 1325);
      assert.equal(cardD.gbp_market, 983); // 1325 * 0.7421 = 983.28 -> 983
      assert.equal(cardD.fx_rate, 0.7421);

      const cardBTcg = byKey("cardB", "holo", "tcgplayer");
      assert.ok(cardBTcg, "cardB/holo/tcgplayer row missing (subTypeName 'Holofoil' should map through the finish alias table to 'holo')");
      assert.equal(cardBTcg.native_market, 2250);
      assert.equal(cardBTcg.gbp_market, 1670); // 2250 * 0.7421 = 1669.725 -> half-up -> 1670

      assert.ok(
        !db.price_snapshots.some((r) => r.source === "tcgplayer" && [5999, "5999"].includes(r.tcgplayer_id)),
        "productId 5999 (not any card's tcgplayer_id) must not have been written"
      );

      // --- cards.prices: latest per source, merged rather than overwritten ---
      const cardDRecord = db.cards.find((c) => c.id === "cardD");
      assert.equal(cardDRecord.prices.cardmarket?.note, "stale, from a previous source that should be kept", "an untouched source must survive the merge");
      assert.equal(cardDRecord.prices.tcgplayer.gbp_market, 983);
      assert.equal(cardDRecord.prices.tcgplayer.native_currency, "USD");

      const cardBRecord = db.cards.find((c) => c.id === "cardB");
      assert.equal(cardBRecord.prices.cardmarket.finish, "normal", "the 'normal' finish should be the representative row per source");
      assert.equal(cardBRecord.prices.cardmarket.gbp_market, 387);
      assert.equal(cardBRecord.prices.tcgplayer.gbp_market, 1670);

      // --- the actual batch bodies sent over the wire -------------------------
      const allRequests = capturedBatches.flat();
      const cardAPatch = allRequests.find((r) => r.method === "PATCH" && r.url === "/api/collections/price_snapshots/records/existing-snap-a");
      assert.ok(cardAPatch, "expected a PATCH to the existing same-day row, not a POST");
      assert.equal(cardAPatch.body.source, "cardmarket");
      assert.equal(cardAPatch.body.native_currency, "EUR");

      const cardCPost = allRequests.find(
        (r) => r.method === "POST" && r.url === "/api/collections/price_snapshots/records" && r.body.card === "cardC"
      );
      assert.ok(cardCPost, "expected a POST for cardC (no row for today existed yet)");
    } finally {
      server.close();
    }
  });

  test("refuses to run when the latest fx_rates row is more than 3 days old", async () => {
    const db = buildDb();
    db.fx_rates = [{ id: "fx_stale", base: "GBP", quotes: { EUR: 0.86, USD: 0.74 }, fetched_at: "2026-09-15 07:00:00.000Z" }];
    const { server } = createFakeServer({ db, cachedFiles: {} });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(
        () => run(envFor(port, path.join(cacheDir, "stale-fx")), { now: () => new Date("2026-09-20T04:00:00.000Z") }),
        (err) => {
          assert.ok(err instanceof HardFailure, "expected a HardFailure");
          assert.equal(err.exitCode, 2);
          assert.match(err.message, /more than 3/);
          return true;
        }
      );
    } finally {
      server.close();
    }
  });

  test("refuses to run when there is no fx_rates row at all", async () => {
    const db = buildDb();
    db.fx_rates = [];
    const { server } = createFakeServer({ db, cachedFiles: {} });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(
        () => run(envFor(port, path.join(cacheDir, "no-fx")), { now: () => new Date("2026-09-20T04:00:00.000Z") }),
        (err) => {
          assert.ok(err instanceof HardFailure);
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      server.close();
    }
  });

  test("an unchanged Cardmarket file is not re-downloaded on the next run (ETag short-circuit)", async () => {
    const db1 = buildDb();
    const cachedFiles = {
      "/priceguide/price_guide_6.json": { body: CARDMARKET_FIXTURE, etag: `"cm-6-etag-test"` },
      "/tcgplayer/3/groups": { body: TCGCSV_GROUPS_FIXTURE, etag: `"tc-groups-v1"` },
      "/tcgplayer/3/555/products": { body: TCGCSV_PRODUCTS_FIXTURE, etag: `"tc-products-v1"` },
      "/tcgplayer/3/555/prices": { body: TCGCSV_PRICES_FIXTURE, etag: `"tc-prices-v1"` },
    };
    const { server, requestCounts } = createFakeServer({ db: db1, cachedFiles });
    const port = await listenOnFreePort(server);
    const sharedCacheDir = path.join(cacheDir, "etag-shared");
    try {
      const result1 = await run(envFor(port, sharedCacheDir), { now: () => new Date("2026-09-20T04:00:00.000Z") });
      assert.equal(result1.exitCode, 0);
      const cardmarketCounts1 = requestCounts.get("/priceguide/price_guide_6.json");
      assert.equal(cardmarketCounts1.full, 1, "first run should fetch the file in full");
      assert.equal(cardmarketCounts1.notModified, 0);

      // Second run, same cache dir, same server (same ETag) - reset every
      // collection to a fresh copy of the same seed data, simulating a new
      // day's run against the same on-disk cache. The server closed over
      // `db1` itself (not a copy), so reassigning its properties here is
      // enough for the next request it handles to see the reset data.
      const db2 = buildDb();
      Object.assign(db1, db2);

      const result2 = await run(envFor(port, sharedCacheDir), { now: () => new Date("2026-09-21T04:00:00.000Z") });
      assert.equal(result2.exitCode, 0);
      const cardmarketCounts2 = requestCounts.get("/priceguide/price_guide_6.json");
      assert.equal(cardmarketCounts2.full, 1, "second run must not fetch the file again");
      assert.equal(cardmarketCounts2.notModified, 1, "second run should get a 304 for the unchanged file");

      // And the cached copy was actually used to reprocess the data, not
      // silently skipped: the same rows land again, from the disk cache.
      // (Run 2 is dated the next day, so this is a fresh row for that new
      // day, not the same one run 1 wrote - the point of this assertion is
      // that the cached bytes were still correctly parsed and written.)
      const cardmarketRun2 = latestByKey(db1.price_snapshots, "cardA", "normal", "cardmarket");
      assert.equal(cardmarketRun2.native_market, 950);
    } finally {
      server.close();
    }
  });
});
