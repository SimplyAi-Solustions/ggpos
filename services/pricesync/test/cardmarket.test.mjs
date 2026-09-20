// Runs the streaming filter against a real Cardmarket price guide file.
//
// Fixture provenance: test/fixtures/cardmarket-price-guide-19-lorcana.json
// is the REAL, complete, unmodified response from
// https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_19.json
// (Lorcana, game id 19 per docs/PLAN.md), fetched live on 2026-09-20
// through this environment's configured proxy. It is used whole rather
// than trimmed to a slice: at 764,520 bytes it is already the smallest of
// the five real files this service reads (Magic runs 26 MB, Yu-Gi-Oh! 17
// MB, Pokemon 15 MB, One Piece 2.7 MB - all confirmed via a live HEAD
// request the same day) and comes in under the 1 MB fixture size the task
// brief asks for without needing to cut it down.
//
// idProduct 726997 and 726998 (this file's first two entries) are used
// directly below rather than invented, so every assertion here traces back
// to bytes Cardmarket actually served.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCardmarketVariant, buildCardmarketRows, ingestCardmarketStream } from "../src/lib/cardmarket.mjs";
import { parseJsonStream } from "../src/lib/json-stream.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "cardmarket-price-guide-19-lorcana.json");
const fixtureRaw = readFileSync(FIXTURE_PATH);

// Parsed the same way index.mjs parses it in production - through
// stream-json with numberAsString, never a plain JSON.parse - so every
// number below is the exact decimal string the real pipeline would see,
// not a float. A plain JSON.parse of this fixture would hand
// buildCardmarketVariant/buildCardmarketRows JS numbers instead, which
// money.mjs's parseDecimalToMinor deliberately refuses (it requires a
// string), silently zeroing every field - that mismatch would have made
// every assertion below pass against the wrong values.
const fixture = await parseJsonStream(Readable.from(fixtureRaw));

// 726997: real base pricing, but every "-foil" field is null except
// trend-foil, which is exactly 0 - Cardmarket's own "no foil printing"
// default (see the long comment on buildCardmarketVariant).
const NO_FOIL_ENTRY = fixture.priceGuides[0];
assert.equal(NO_FOIL_ENTRY.idProduct, "726997", "fixture's first entry changed - update the hard-coded expectations below");

// 726998: real base pricing AND a real foil printing.
const WITH_FOIL_ENTRY = fixture.priceGuides[1];
assert.equal(WITH_FOIL_ENTRY.idProduct, "726998", "fixture's second entry changed - update the hard-coded expectations below");

const FX = { gbpPerEur: 0.8606, fxDatePb: "2026-09-20 07:00:00.000Z" };
const FETCHED_AT = "2026-09-20 04:00:00.000Z";

describe("buildCardmarketVariant", () => {
  test("returns null for a variant with no data at all", () => {
    assert.equal(buildCardmarketVariant(NO_FOIL_ENTRY, "foil"), null);
  });
  test("reads a real variant's four fields", () => {
    const base = buildCardmarketVariant(WITH_FOIL_ENTRY, null);
    assert.deepEqual(base, { low: "2790", mid: "2700", market: "2451.36", trend: "974.5" });
    const foil = buildCardmarketVariant(WITH_FOIL_ENTRY, "foil");
    assert.deepEqual(foil, { low: "5000", mid: "2766.33", market: "2809.03", trend: "2421.14" });
  });
});

describe("buildCardmarketRows", () => {
  test("a variant with a bare trend of 0 but real low/avg/avg7 still gets a row, with market falling back rather than reading 0", () => {
    // A hand-built entry rather than one hunted for in the fixture: the
    // repo fixture happens to have zero cases of "trend exactly 0 AND
    // avg/low/avg7 all real" for -foil specifically (see cardmarket.mjs's
    // doc comment), so this pins the behaviour directly rather than
    // relying on one turning up.
    // Values as strings, exactly as they arrive after numberAsString
    // parsing in production (see json-stream.mjs) - buildCardmarketVariant
    // calls money.mjs's parseDecimalToMinor, which requires a string and
    // treats anything else as absent, so a plain JS number here would
    // silently test the wrong thing (every field reading as "missing").
    const entry = {
      idProduct: "555555",
      avg: "10",
      low: "8",
      trend: "9",
      avg7: "9.5",
      "avg-foil": "20",
      "low-foil": "18",
      "trend-foil": "0",
      "avg7-foil": "19",
    };
    const cardsByCardmarketId = new Map([["555555", { id: "card_zero_trend" }]]);
    const rows = buildCardmarketRows(entry, cardsByCardmarketId, FX, FETCHED_AT);
    const foil = rows.find((r) => r.finish === "foil");
    assert.ok(foil, "the foil variant has real avg/low/avg7 and must still get a row despite trend-foil being 0");
    assert.equal(foil.native_market, 1900, "market should fall back to avg7 (19.00) rather than reading the bare zero trend");
    assert.notEqual(foil.native_market, 0);
  });

  test("a card with no foil printing gets only a normal row, never a spurious all-zero foil row", () => {
    const cardsByCardmarketId = new Map([["726997", { id: "card_no_foil" }]]);
    const rows = buildCardmarketRows(NO_FOIL_ENTRY, cardsByCardmarketId, FX, FETCHED_AT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].finish, "normal");
  });

  test("maps low/mid/market/trend correctly and converts to GBP pence at a fixed rate, half-up", () => {
    const cardsByCardmarketId = new Map([["726998", { id: "card_with_foil" }]]);
    const rows = buildCardmarketRows(WITH_FOIL_ENTRY, cardsByCardmarketId, FX, FETCHED_AT);
    assert.equal(rows.length, 2);

    const normal = rows.find((r) => r.finish === "normal");
    assert.deepEqual(normal, {
      card: "card_with_foil",
      finish: "normal",
      source: "cardmarket",
      native_currency: "EUR",
      native_low: 279000, // "2790" -> EUR2790.00
      native_mid: 270000, // "2700" -> EUR2700.00
      native_market: 245136, // trend "2451.36" is present, so market = trend
      native_trend: 97450, // avg7 "974.5" -> EUR974.50
      fx_rate: 0.8606,
      fx_date: FX.fxDatePb,
      gbp_market: 210964, // 245136 * 0.8606 = 210964.0896 -> half-up -> 210964
      fetched_at: FETCHED_AT,
    });

    const foil = rows.find((r) => r.finish === "foil");
    assert.deepEqual(foil, {
      card: "card_with_foil",
      finish: "foil",
      source: "cardmarket",
      native_currency: "EUR",
      native_low: 500000,
      native_mid: 276633,
      native_market: 280903,
      native_trend: 242114,
      fx_rate: 0.8606,
      fx_date: FX.fxDatePb,
      gbp_market: 241745, // 280903 * 0.8606 = 241745.2418 -> 241745
      fetched_at: FETCHED_AT,
    });
  });

  test("an idProduct not in the wanted set yields no rows", () => {
    const rows = buildCardmarketRows(WITH_FOIL_ENTRY, new Map(), FX, FETCHED_AT);
    assert.deepEqual(rows, []);
  });
});

describe("ingestCardmarketStream", () => {
  test("streams the whole real fixture, matching only wanted ids, without buffering it as one object", async () => {
    const cardsByCardmarketId = new Map([
      ["726997", { id: "card_no_foil" }],
      ["726998", { id: "card_with_foil" }],
    ]);
    const stream = Readable.from(readFileSync(FIXTURE_PATH));
    const { seen, matched, rows } = await ingestCardmarketStream(stream, {
      cardsByCardmarketId,
      fx: FX,
      fetchedAtPb: FETCHED_AT,
    });
    assert.equal(seen, fixture.priceGuides.length);
    assert.equal(matched, 2);
    // 1 row for 726997 (normal only) + 2 rows for 726998 (normal, foil).
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.card === "card_with_foil").length, 2);
  });

  test("an empty wanted set streams the whole file and matches nothing", async () => {
    const stream = Readable.from(readFileSync(FIXTURE_PATH));
    const { seen, matched, rows } = await ingestCardmarketStream(stream, {
      cardsByCardmarketId: new Map(),
      fx: FX,
      fetchedAtPb: FETCHED_AT,
    });
    assert.equal(seen, fixture.priceGuides.length);
    assert.equal(matched, 0);
    assert.deepEqual(rows, []);
  });
});
