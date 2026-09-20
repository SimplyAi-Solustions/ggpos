#!/usr/bin/env node
// Unit tests for pb/pb_hooks/adapters/*.js against recorded (or, where a
// key is needed, hand-written) fixtures. No PocketBase, no network:
//
//   node --test pb/scripts/check-adapters.mjs
//
// Every adapter is CommonJS (pb_hooks cannot load TypeScript - see
// CLAUDE.md's "Hooks"), and every outbound call goes through
// adapters/http.js's request(req, transport), so each test below passes
// its own `transport` function reading a fixture instead of calling the
// network. `global.__hooks` is set once, below, to this repo's real
// pb_hooks directory: every adapter requires its neighbours with
// `require(`${__hooks}/...`)`, exactly the convention the rest of pb_hooks
// uses (see pb/README.md), and Node's own require() accepts that absolute
// path directly - no relative-path resolution to get right across two
// different module loaders (goja's and Node's).
//
// Fixtures (pb_hooks/adapters/fixtures/), recorded live through the
// configured proxy on 2026-09-20 unless the name says HANDWRITTEN:
//   tcgdex_sv151_199.json                     GET /v2/en/sets/sv03.5/199
//   tcgdex_search_charizard.json              GET /v2/en/cards?name=charizard (trimmed to 5)
//   scryfall_blb_223.json                     GET /cards/blb/223 (trimmed to used fields)
//   ygoprodeck_46986414.json                  GET /cardinfo.php?id=46986414 (card_sets trimmed to 5)
//   ygoprodeck_46986421.json                  GET /cardinfo.php?id=46986421 (the CT13-EN003 printing; trimmed)
//   ygoprodeck_cardsetsinfo_CT13-EN003.json   GET /cardsetsinfo.php?setcode=CT13-EN003
//   optcg_OP01-001.json                       GET /api/sets/card/OP01-001/
//   lorcast_1_1.json                          GET /v0/cards/1/1
//   frankfurter_gbp_latest.json               GET /v1/latest?base=GBP&symbols=EUR,USD
// Hand-written (no key available on this build - see each fixture's own
// "_fixture_note" and pb/README.md):
//   igdb_HANDWRITTEN_oauth_token.json, igdb_HANDWRITTEN_games_search.json
//   pricecharting_HANDWRITTEN_products_search_{pal,ntsc,empty}.json,
//     pricecharting_HANDWRITTEN_product_{pal,ntsc}.json
//   ebay_HANDWRITTEN_oauth_token.json, ebay_HANDWRITTEN_item_summary_search.json
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hooksDir = path.resolve(__dirname, "..", "pb_hooks");
const fixturesDir = path.join(hooksDir, "adapters", "fixtures");

// The one piece of environment every adapter needs outside PocketBase -
// see the file banner above and adapters/http.js.
global.__hooks = hooksDir;

const nodeRequire = createRequire(import.meta.url);

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

/** A fresh instance of an adapter module, cache cleared like a goja require() would be. */
function adapter(name) {
  const p = path.join(hooksDir, "adapters", name);
  delete nodeRequire.cache[nodeRequire.resolve(p)];
  return nodeRequire(p);
}

function sharedLib(name) {
  return nodeRequire(path.join(hooksDir, "lib", "shared", name));
}

// =======================================================================
// TCGdex (Pokemon) - recorded fixtures
// =======================================================================

test("tcgdex.getBySetNumber: parsed shape, ids, image URLs", () => {
  const tcgdex = adapter("tcgdex.js");
  const transport = (req) => {
    assert.equal(req.url, "https://api.tcgdex.net/v2/en/sets/sv03.5/199");
    assert.equal(req.headers["User-Agent"], "GGVault/1.0 (+https://vault.ggentertainment.co.uk)");
    return { statusCode: 200, json: fixture("tcgdex_sv151_199.json") };
  };
  const card = tcgdex.getBySetNumber("sv03.5", "199", transport);
  assert.equal(card.number, "199");
  assert.equal(card.name, "Charizard ex");
  assert.equal(card.setCode, "sv03.5");
  assert.equal(card.setName, "151");
  assert.equal(card.rehostImage, false, "TCGdex images may be hotlinked");
  assert.equal(card.tcgplayerId, "517045");
  assert.equal(card.cardmarketId, "733794");
  assert.match(card.imageLarge, /\/high\.webp$/);
  assert.match(card.imageSmall, /\/low\.webp$/);
});

test("tcgdex.getPrices: cardmarket EUR + tcgplayer USD, decimal strings converted half-up at a fixed rate", () => {
  const tcgdex = adapter("tcgdex.js");
  const money = sharedLib("money.js");
  const transport = () => ({ statusCode: 200, json: fixture("tcgdex_sv151_199.json") });

  const prices = tcgdex.getPrices({ setCode: "sv03.5", number: "199" }, "holo", transport);
  const cardmarket = prices.find((p) => p.source === "cardmarket");
  const tcgplayer = prices.find((p) => p.source === "tcgplayer");

  assert.equal(cardmarket.currency, "EUR");
  assert.equal(typeof cardmarket.market, "string", "EUR prices are decimal strings, never floats");
  assert.equal(cardmarket.market, "368.3");
  assert.equal(tcgplayer.currency, "USD");
  assert.equal(typeof tcgplayer.market, "string");
  assert.equal(tcgplayer.market, "359.87");

  assert.equal(money.eurDecimalToGbpPence(cardmarket.market, 0.86), 31674);
  assert.equal(
    money.convertMinorToGbpPence(money.parseDecimalToMinor(tcgplayer.market), "USD", 0.75),
    26990
  );
});

test("tcgdex.search: compact rows, set/number split off the id's last hyphen", () => {
  const tcgdex = adapter("tcgdex.js");
  const rows = tcgdex.search("charizard", () => ({
    statusCode: 200,
    json: fixture("tcgdex_search_charizard.json"),
  }));
  assert.equal(rows.length, 5);
  const withHyphenatedSet = rows.find((r) => r.externalIds.tcgdex === "30th-c-001");
  assert.equal(withHyphenatedSet.setCode, "30th-c");
  assert.equal(withHyphenatedSet.number, "001");
});

test("tcgdex.getImage: reuses an already-known image without a second call", () => {
  const tcgdex = adapter("tcgdex.js");
  const transport = () => {
    throw new Error("should not be called - getImage had the URLs already");
  };
  const image = tcgdex.getImage(
    { imageSmall: "https://x/low.webp", imageLarge: "https://x/high.webp" },
    transport
  );
  assert.equal(image.rehost, false);
  assert.equal(image.large, "https://x/high.webp");
});

// =======================================================================
// Scryfall (MTG) - recorded fixture
// =======================================================================

test("scryfall.getBySetNumber: parsed shape, ids, currency", () => {
  const scryfall = adapter("scryfall.js");
  const transport = (req) => {
    assert.equal(req.url, "https://api.scryfall.com/cards/blb/223");
    return { statusCode: 200, json: fixture("scryfall_blb_223.json") };
  };
  const card = scryfall.getBySetNumber("blb", "223", transport);
  assert.equal(card.number, "223");
  assert.equal(card.name, "Lunar Convocation");
  assert.equal(card.setCode, "blb");
  assert.equal(card.setName, "Bloomburrow");
  assert.equal(card.rarity, "rare");
  assert.equal(card.rehostImage, false);
  assert.equal(card.tcgplayerId, "559480");
  assert.equal(card.cardmarketId, "778438");
});

test("scryfall.getPrices: eur + usd decimal strings, converted half-up at a fixed rate", () => {
  const scryfall = adapter("scryfall.js");
  const money = sharedLib("money.js");
  const transport = () => ({ statusCode: 200, json: fixture("scryfall_blb_223.json") });

  const prices = scryfall.getPrices({ setCode: "blb", number: "223" }, "nonfoil", transport);
  const cardmarket = prices.find((p) => p.source === "cardmarket");
  const tcgplayer = prices.find((p) => p.source === "tcgplayer");
  assert.equal(cardmarket.currency, "EUR");
  assert.equal(cardmarket.market, "0.80");
  assert.equal(tcgplayer.currency, "USD");
  assert.equal(tcgplayer.market, "0.81");

  assert.equal(money.eurDecimalToGbpPence(cardmarket.market, 0.86), 69);
  assert.equal(
    money.convertMinorToGbpPence(money.parseDecimalToMinor(tcgplayer.market), "USD", 0.75),
    61
  );
});

// =======================================================================
// YGOPRODeck (Yu-Gi-Oh!) - recorded fixtures. Images must be re-hosted.
// =======================================================================

test("ygoprodeck.getBySetNumber: resolves a set code via cardsetsinfo, then re-hosts the image", () => {
  const ygoprodeck = adapter("ygoprodeck.js");
  const calls = [];
  const transport = (req) => {
    calls.push(req.url);
    if (req.url.indexOf("cardsetsinfo.php") >= 0) {
      return { statusCode: 200, json: fixture("ygoprodeck_cardsetsinfo_CT13-EN003.json") };
    }
    if (req.url.indexOf("cardinfo.php?id=46986421") >= 0) {
      return { statusCode: 200, json: fixture("ygoprodeck_46986421.json") };
    }
    if (req.url.indexOf("images.ygoprodeck.com") >= 0) {
      return { statusCode: 200, body: [1, 2, 3] }; // stand-in JPEG bytes
    }
    throw new Error("unexpected YGOPRODeck URL: " + req.url);
  };

  const card = ygoprodeck.getBySetNumber("CT13", "EN003", transport);
  assert.equal(card.name, "Dark Magician");
  assert.equal(card.setCode, "CT13");
  assert.equal(card.number, "EN003");
  assert.equal(card.setName, "2016 Mega-Tins");
  assert.equal(card.rarity, "Ultra Rare");
  assert.equal(
    card.rehostImage,
    true,
    "YGOPRODeck images must never be hotlinked - hotlinking gets IPs banned"
  );
  assert.equal(card.imageSmall, "", "the bare provider URL must never reach image_small");
  assert.equal(card.imageLarge, "", "the bare provider URL must never reach image_large");
  assert.deepEqual(card.imageBytes, [1, 2, 3]);
  assert.ok(card.imageFilename);
  assert.ok(calls.some((u) => u.indexOf("cardsetsinfo.php") >= 0));
  assert.ok(calls.some((u) => u.indexOf("images.ygoprodeck.com") >= 0));
});

test("ygoprodeck.getPrices: cardmarket EUR (overall) + tcgplayer USD (this printing's set_price)", () => {
  const ygoprodeck = adapter("ygoprodeck.js");
  const money = sharedLib("money.js");
  const transport = (req) => {
    if (req.url.indexOf("cardsetsinfo.php") >= 0) {
      return { statusCode: 200, json: fixture("ygoprodeck_cardsetsinfo_CT13-EN003.json") };
    }
    if (req.url.indexOf("cardinfo.php") >= 0) {
      return { statusCode: 200, json: fixture("ygoprodeck_46986421.json") };
    }
    return { statusCode: 200, body: [1] };
  };
  const card = ygoprodeck.getBySetNumber("CT13", "EN003", transport);
  const prices = ygoprodeck.getPrices(card, null, transport);
  const cardmarket = prices.find((p) => p.source === "cardmarket");
  const tcgplayer = prices.find((p) => p.source === "tcgplayer");

  assert.equal(cardmarket.currency, "EUR");
  assert.equal(cardmarket.market, "0.02");
  assert.equal(tcgplayer.currency, "USD");
  assert.equal(tcgplayer.market, "6.97", "the CT13-EN003 printing's own set_price, not the overall tcgplayer_price");

  assert.equal(money.eurDecimalToGbpPence(cardmarket.market, 0.86), 2);
  assert.equal(
    money.convertMinorToGbpPence(money.parseDecimalToMinor(tcgplayer.market), "USD", 0.75),
    523
  );
});

test("ygoprodeck.search: one row per printing (card_sets[]), never a hotlinked image", () => {
  const ygoprodeck = adapter("ygoprodeck.js");
  const rows = ygoprodeck.search("dark magician", () => ({
    statusCode: 200,
    json: fixture("ygoprodeck_46986414.json"),
  }));
  // The fixture's one card has 5 printings (card_sets[]) - a card has no
  // set code of its own in YGOPRODeck's shape, only its printings do, so
  // search() emits one row per printing, not one row per card (writing a
  // blank-setCode row through fails card_sets' required validation).
  assert.equal(rows.length, 5);
  const ct13 = rows.find((r) => r.number === "CT13-EN003");
  assert.ok(ct13, "expected the CT13-EN003 printing among the rows");
  assert.equal(ct13.name, "Dark Magician");
  assert.equal(ct13.setCode, "CT13");
  assert.equal(ct13.setName, "2016 Mega-Tins");
  assert.equal(ct13.rehostImage, true);
  assert.equal(ct13.imageSmall, "");
  assert.equal(ct13.imageLarge, "");
  assert.ok(
    rows.every((r) => r.setCode && r.number.indexOf(r.setCode) === 0),
    "every row's number carries its own setCode as a prefix"
  );
});

// =======================================================================
// OPTCG (One Piece) - recorded fixture. Image cached locally.
// =======================================================================

test("optcg.getBySetNumber: picks the base printing over its parallel, re-hosts the image", () => {
  const optcg = adapter("optcg.js");
  const transport = (req) => {
    if (req.url.indexOf("/sets/card/") >= 0) return { statusCode: 200, json: fixture("optcg_OP01-001.json") };
    if (req.url.indexOf("Card_Images") >= 0) return { statusCode: 200, body: [9, 9, 9] };
    throw new Error("unexpected OPTCG URL: " + req.url);
  };
  const card = optcg.getBySetNumber("OP01", "001", transport);
  assert.equal(card.number, "OP01-001");
  assert.equal(
    card.setCode,
    "OP01",
    "the card's own code prefix (card_set_id), not set_id's differently-punctuated OP-01 - " +
      "getBySetNumber reconstructs OP01-001 from set+number, so a card_sets row keyed on OP-01 could never be found by a later lookup"
  );
  assert.equal(card.setName, "Romance Dawn");
  assert.equal(card.rehostImage, true, "OPTCG images are cached locally, never hotlinked");
  assert.deepEqual(card.imageBytes, [9, 9, 9]);
  assert.equal(card.marketPriceUsd, 2.09);
});

test("optcg.getPrices: market_price as a decimal string, safe from float drift", () => {
  const optcg = adapter("optcg.js");
  const money = sharedLib("money.js");
  const transport = () => ({ statusCode: 200, json: fixture("optcg_OP01-001.json") });
  const card = optcg.getBySetNumber("OP01", "001", transport);
  const prices = optcg.getPrices(card, null, transport);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].currency, "USD");
  assert.equal(typeof prices[0].market, "string");
  assert.equal(prices[0].market, "2.09");
  assert.equal(money.convertMinorToGbpPence(money.parseDecimalToMinor(prices[0].market), "USD", 0.75), 157);
});

// =======================================================================
// Lorcast (Disney Lorcana) - recorded fixture
// =======================================================================

test("lorcast.getBySetNumber + getPrices: parsed shape and usd decimal string", () => {
  const lorcast = adapter("lorcast.js");
  const money = sharedLib("money.js");
  const transport = (req) => {
    assert.equal(req.url, "https://api.lorcast.com/v0/cards/1/1");
    return { statusCode: 200, json: fixture("lorcast_1_1.json") };
  };
  const card = lorcast.getBySetNumber("1", "1", transport);
  assert.equal(card.number, "1");
  assert.equal(card.name, "Ariel - On Human Legs");
  assert.equal(card.setCode, "1");
  assert.equal(card.setName, "The First Chapter");
  assert.equal(card.tcgplayerId, "494102");
  assert.equal(card.rehostImage, false);

  const prices = lorcast.getPrices(card, "normal", transport);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].source, "tcgplayer");
  assert.equal(prices[0].currency, "USD");
  assert.equal(prices[0].market, "0.12");
  assert.equal(money.convertMinorToGbpPence(money.parseDecimalToMinor(prices[0].market), "USD", 0.75), 9);
});

// =======================================================================
// Frankfurter (FX)
// =======================================================================

test("frankfurter.fetchRates: inverts to GBP-per-unit (packages/shared's own convention)", () => {
  const frankfurter = adapter("frankfurter.js");
  const transport = (req) => {
    assert.match(req.url, /base=GBP/);
    assert.match(req.url, /symbols=EUR%2CUSD/);
    return { statusCode: 200, json: fixture("frankfurter_gbp_latest.json") };
  };
  const rates = frankfurter.fetchRates(["EUR", "USD"], transport);
  assert.equal(rates.base, "GBP");
  assert.ok(Math.abs(rates.quotes.EUR - 0.8588114050154585) < 1e-9);
  assert.ok(Math.abs(rates.quotes.USD - 0.749400479616307) < 1e-9);
  assert.equal(rates.date, "2026-09-18");
});

test("frankfurter.fetchRates: a non-positive rate is dropped, not inverted into Infinity or a negative figure", () => {
  const frankfurter = adapter("frankfurter.js");
  // A hand-crafted response shaped like Frankfurter's own: EUR is a normal
  // rate, USD has come back 0 (the one shape a real weekend/bank-holiday
  // response can take - see crons.pb.js's "fx" cron, which skips writing a
  // row at all when every quote ends up dropped this way).
  const transport = () => ({
    statusCode: 200,
    json: { amount: 1.0, base: "GBP", date: "2026-09-19", rates: { EUR: 1.1644, USD: 0 } },
  });
  const rates = frankfurter.fetchRates(["EUR", "USD"], transport);
  assert.ok(rates.quotes.EUR > 0, "a normal rate is kept");
  assert.equal(Object.prototype.hasOwnProperty.call(rates.quotes, "USD"), false, "a zero rate is dropped, not inverted to Infinity");
});

test("frankfurter.fetchRates: every quote non-positive leaves an empty quotes object", () => {
  const frankfurter = adapter("frankfurter.js");
  const transport = () => ({
    statusCode: 200,
    json: { amount: 1.0, base: "GBP", date: "2026-09-20", rates: { EUR: 0, USD: 0 } },
  });
  const rates = frankfurter.fetchRates(["EUR", "USD"], transport);
  assert.deepEqual(rates.quotes, {}, "crons.pb.js's fx cron reads this as 'nothing usable' and skips the write entirely");
});

// =======================================================================
// eBay - median of the five lowest GBP/GB asking prices, then the haircut.
// Hand-written fixtures (no Browse API production access on this build).
// =======================================================================

test("ebay.parseListings + medianAskingCandidate: filters to GBP/GB, medians the five lowest, applies the haircut", () => {
  const ebay = adapter("ebay.js");
  const listings = ebay.parseListings(fixture("ebay_HANDWRITTEN_item_summary_search.json"));

  // 9 rows in the fixture; only the 7 GBP/GB ones may count.
  const eligible = listings.filter((l) => l.currency === "GBP" && l.country === "GB");
  assert.equal(eligible.length, 7);

  const candidate = ebay.medianAskingCandidate(listings, 15);
  assert.equal(candidate.sampleSize, 5, "the five lowest, not all seven");
  assert.equal(candidate.medianPence, 1500, "median of 1000,1200,1500,1800,2000 is 1500");
  assert.equal(candidate.afterHaircutPence, 1275, "15% off 1500 is 1275, half-up");
});

test("ebay.getPrices: end to end through a stub OAuth token and search, source order and shape", () => {
  const ebay = adapter("ebay.js");
  const statestore = adapter("statestore.js");
  const transport = (req) => {
    if (req.url.indexOf("oauth2/token") >= 0) {
      assert.equal(req.method, "POST");
      return { statusCode: 200, json: fixture("ebay_HANDWRITTEN_oauth_token.json") };
    }
    if (req.url.indexOf("item_summary/search") >= 0) {
      assert.equal(req.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_GB");
      return { statusCode: 200, json: fixture("ebay_HANDWRITTEN_item_summary_search.json") };
    }
    throw new Error("unexpected eBay URL: " + req.url);
  };

  const prices = ebay.getPrices(
    statestore.memory(),
    { client_id: "id", client_secret: "secret" },
    "Test Card NM",
    "test-cache-key",
    15,
    false, // bypassCache
    transport
  );
  assert.equal(prices.length, 1);
  assert.equal(prices[0].source, "ebay_uk_asking");
  assert.equal(prices[0].currency, "GBP");
  // Already an integer in pence (marketMinor), never a decimal string -
  // pricing_policy.js's fromAdapterCandidate takes it as-is, so a GBP
  // figure that started out exact never round-trips through a string.
  assert.equal(prices[0].market, null);
  assert.equal(prices[0].marketMinor, 1275);
  assert.equal(prices[0].lowMinor, 1275);
  assert.equal(prices[0].midMinor, 1500);
});

test("ebay.getPrices: switched off entirely with no key (PLAN.md)", () => {
  const ebay = adapter("ebay.js");
  const statestore = adapter("statestore.js");
  const transport = () => {
    throw new Error("must not call out with no api key configured");
  };
  const prices = ebay.getPrices(statestore.memory(), null, "anything", "key", 15, transport);
  assert.deepEqual(prices, []);
});

test("ebay.getPrices: the 24-hour cache skips a second call entirely (globalThis.__adapterTransport override)", () => {
  const ebay = adapter("ebay.js");
  const statestore = adapter("statestore.js");
  const store = statestore.memory();
  let calls = 0;
  // Demonstrates the *other* override path (adapters/http.js falls back to
  // globalThis.__adapterTransport when no transport argument is given),
  // not just passing one explicitly like every other test here.
  global.__adapterTransport = (req) => {
    calls += 1;
    if (req.url.indexOf("oauth2/token") >= 0) return { statusCode: 200, json: fixture("ebay_HANDWRITTEN_oauth_token.json") };
    return { statusCode: 200, json: fixture("ebay_HANDWRITTEN_item_summary_search.json") };
  };
  try {
    const first = ebay.getPrices(store, { client_id: "id", client_secret: "s" }, "q", "cache-key-2", 15);
    const callsAfterFirst = calls;
    const second = ebay.getPrices(store, { client_id: "id", client_secret: "s" }, "q", "cache-key-2", 15);
    assert.deepEqual(second, first);
    assert.equal(calls, callsAfterFirst, "the second call must be served from the 24-hour cache");
  } finally {
    delete global.__adapterTransport;
  }
});

// =======================================================================
// PriceCharting - PAL first, NTSC only when PAL has no entry. Hand-written
// fixtures (no PriceCharting key on this build).
// =======================================================================

test("pricecharting.getPrices: PAL first when a PAL entry exists, matched by console-name (never the URL), integer US cents throughout", () => {
  const pricecharting = adapter("pricecharting.js");
  const calls = [];
  const transport = (req) => {
    calls.push(req.url);
    if (req.url.indexOf("/products?") >= 0) {
      // The query is just the title now - PriceCharting keys PAL/NTSC by
      // console-name in the response, never by a URL-shaped category slug
      // (adapters/pricecharting.js's own searchInCategory) - so the PAL and
      // NTSC search calls are indistinguishable at the URL, and this
      // fixture carries both an NTSC and a PAL row deliberately, so the PAL
      // match has to pick the right one out of several.
      assert.ok(req.url.indexOf("Super%20Mario%20Kart") >= 0, "the title itself is the query: " + req.url);
      assert.ok(req.url.indexOf("pal-super-nintendo") < 0, "the category must never leak into the query string");
      return { statusCode: 200, json: fixture("pricecharting_HANDWRITTEN_products_search_pal.json") };
    }
    if (req.url.indexOf("/product?") >= 0) {
      assert.match(req.url, /id=pal-/, "must fetch the PAL product, not the NTSC one also in the search results");
      return { statusCode: 200, json: fixture("pricecharting_HANDWRITTEN_product_pal.json") };
    }
    throw new Error("unexpected PriceCharting URL: " + req.url);
  };
  const prices = pricecharting.getPrices("key", "Super Mario Kart", "snes_pal_box", "cib", transport);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].source, "pricecharting_pal");
  assert.equal(prices[0].currency, "USD");
  assert.equal(typeof prices[0].market, "number", "PriceCharting is integer cents, never a string");
  assert.equal(prices[0].market, 2500, "cib-price, in cents");
  assert.equal(calls.filter((u) => u.indexOf("/products?") >= 0).length, 1, "must never fall through to an NTSC search once PAL matched");

  const money = sharedLib("money.js");
  assert.equal(money.usdCentsToGbpPence(prices[0].market, 0.75), 1875);
});

test("pricecharting.getPrices: falls back to NTSC only when PAL has no entry", () => {
  const pricecharting = adapter("pricecharting.js");
  const calls = [];
  const transport = (req) => {
    calls.push(req.url);
    if (req.url.indexOf("/products?") >= 0) {
      // This fixture carries only an NTSC row: the first (PAL) search call
      // finds nothing that reads as PAL and getPrices() must try again for
      // NTSC, hitting this identical URL a second time.
      return { statusCode: 200, json: fixture("pricecharting_HANDWRITTEN_products_search_ntsc.json") };
    }
    if (req.url.indexOf("/product?") >= 0) {
      assert.match(req.url, /id=ntsc-/);
      return { statusCode: 200, json: fixture("pricecharting_HANDWRITTEN_product_ntsc.json") };
    }
    throw new Error("unexpected PriceCharting URL: " + req.url);
  };
  const prices = pricecharting.getPrices("key", "Super Mario Kart", "snes_pal_box", "cib", transport);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].source, "pricecharting_ntsc");
  assert.equal(prices[0].market, 1800);
  assert.equal(calls.filter((u) => u.indexOf("/products?") >= 0).length, 2, "PAL search, then NTSC search, both against the same URL");

  const money = sharedLib("money.js");
  assert.equal(money.usdCentsToGbpPence(prices[0].market, 0.75), 1350);
});

test("pricecharting.getPrices: no candidate at all when neither region has an entry", () => {
  const pricecharting = adapter("pricecharting.js");
  const transport = () => ({ statusCode: 200, json: fixture("pricecharting_HANDWRITTEN_products_search_empty.json") });
  const prices = pricecharting.getPrices("key", "Some Obscure Game", "snes_pal_box", "cib", transport);
  assert.deepEqual(prices, []);
});

test("pricecharting.getPrices: switched off entirely with no key configured", () => {
  const pricecharting = adapter("pricecharting.js");
  const prices = pricecharting.getPrices(null, "Anything", "snes_pal_box", "cib", () => {
    throw new Error("must not call out with no api key configured");
  });
  assert.deepEqual(prices, []);
});

test("pricecharting.priceField: our loose/boxed/cib completeness maps onto PriceCharting's two price tiers", () => {
  const pricecharting = adapter("pricecharting.js");
  assert.equal(pricecharting.priceField("loose"), "loose-price");
  assert.equal(pricecharting.priceField("boxed"), "cib-price");
  assert.equal(pricecharting.priceField("cib"), "cib-price");
});

// =======================================================================
// IGDB - hand-written fixtures (no key on this build)
// =======================================================================

test("igdb.search: token fetched once and cached, Apicalypse body, parsed shape", () => {
  const igdb = adapter("igdb.js");
  const statestore = adapter("statestore.js");
  const store = statestore.memory();
  let tokenCalls = 0;
  const transport = (req) => {
    if (req.url.indexOf("id.twitch.tv") >= 0) {
      tokenCalls += 1;
      return { statusCode: 200, json: fixture("igdb_HANDWRITTEN_oauth_token.json") };
    }
    if (req.url.indexOf("api.igdb.com") >= 0) {
      assert.equal(req.headers["Client-ID"], "client123");
      assert.match(req.body, /search "super mario"/);
      return { statusCode: 200, json: fixture("igdb_HANDWRITTEN_games_search.json") };
    }
    throw new Error("unexpected IGDB URL: " + req.url);
  };

  const first = igdb.search(store, "client123", "secret", "super mario", igdb.platformIgdbId("snes_pal_box"), transport);
  const second = igdb.search(store, "client123", "secret", "super mario", null, transport);
  assert.equal(tokenCalls, 1, "the Twitch token is cached between calls");
  assert.equal(first.length, 2);
  assert.equal(first[0].name, "Super Mario Kart");
  assert.deepEqual(first[0].platformNames, ["Super Nintendo Entertainment System"]);
  assert.match(first[0].cover, /^https:\/\/images\.igdb\.com\//);
  assert.equal(second.length, 2);
});

// =======================================================================
// registry.js - the "set number" query classifier. A minimal fake `app`
// stands in for PocketBase: only the two methods resolveSetNumberQuery's
// own call chain actually reaches (findRecordsByFilter for
// ensureSetsSynced/resolveSetCode's card_sets scan) are implemented, scoped
// to one seeded game.
// =======================================================================

test("registry.resolveSetNumberQuery: a two-word name is not misread as an exact set+number lookup", () => {
  const registry = adapter("registry.js");
  const GAME_ID = "game1";
  const fakeApp = {
    findRecordsByFilter(collection, filter, sort, limit, offset, params) {
      if (collection !== "card_sets" || !params || params.game !== GAME_ID) return [];
      // One seeded set, standing in for a normal, already-synced install -
      // ensureSetsSynced's own hasSets check finds this and returns
      // immediately, so this test needs no adapter and no statestore at all.
      return [{ getString: (f) => (f === "code" ? "sv03.5" : "") }];
    },
    findFirstRecordByFilter() {
      return null;
    },
  };

  // "ex" does not look like a collector number, so this reads as a name
  // search, never an exact lookup for set "charizard" (the bug this
  // classifier exists to fix).
  assert.equal(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "pokemon", null, "charizard ex"), null);
  // Same shape, a different game - "bolt" is not a collector number either.
  assert.equal(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "mtg", null, "lightning bolt"), null);

  // The alias table resolves before any card_sets lookup at all.
  assert.deepEqual(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "pokemon", null, "sv151 199"), {
    set: "sv03.5",
    number: "199",
  });
  // A real (non-aliased) set code still resolves, case-insensitively,
  // against the seeded card_sets row.
  assert.deepEqual(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "pokemon", null, "SV03.5 199"), {
    set: "sv03.5",
    number: "199",
  });
  // A set code with no card_sets row at all (and no alias) does not resolve.
  assert.equal(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "pokemon", null, "unknownset 199"), null);

  // One Piece and Yu-Gi-Oh still use the single hyphenated-token form and
  // never touch `app` at all.
  assert.deepEqual(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "onepiece", null, "OP01-001"), {
    set: "OP01",
    number: "001",
  });
  assert.equal(registry.resolveSetNumberQuery(fakeApp, GAME_ID, "onepiece", null, "one piece booster"), null);
});

// =======================================================================
// The shared source order is UK first, in both directions
// =======================================================================

test("packages/shared's default source priority puts a UK sold comp first, for cards and for retro", () => {
  const pricing = sharedLib("pricing.js");
  assert.equal(pricing.DEFAULT_TCG_PRIORITY[0], "uk_sold_manual");
  assert.equal(pricing.DEFAULT_RETRO_PRIORITY[0], "uk_sold_manual");
  assert.deepEqual(pricing.DEFAULT_TCG_PRIORITY, [
    "uk_sold_manual",
    "ebay_uk_asking",
    "cardmarket",
    "tcgplayer",
  ]);
  assert.deepEqual(pricing.DEFAULT_RETRO_PRIORITY, [
    "uk_sold_manual",
    "pricecharting_pal",
    "ebay_uk_asking",
    "pricecharting_ntsc",
  ]);
});

// =======================================================================
// SumUp - the transactions pull's own history/detail calls. Hand-written
// fixtures (no SumUp merchant account on this build); see
// pb_hooks/adapters/fixtures/sumup_HANDWRITTEN_*.json.
// =======================================================================

test("sumup.fetchHistory: sends changes_since as real ISO 8601, never PocketBase's space-separated date shape", () => {
  const sumup = adapter("sumup.js");
  let seenUrl = "";
  const transport = (req) => {
    seenUrl = req.url;
    assert.equal(req.headers.Authorization, "Bearer test-key");
    return { statusCode: 200, json: { items: [{ id: "t1" }], links: [] } };
  };
  // The exact bug this guards: lib/sumup.js used to read this value off
  // PocketBase's own stored `fetched_at` text ("...12:00:00.000Z" with a
  // space, not a "T"), which SumUp's API cannot parse - every pull after
  // the first silently sent it a `changes_since` it would reject.
  const since = "2026-09-20T12:00:00.000Z";
  const items = sumup.fetchHistory("MFIX1", "test-key", since, 5, transport);
  assert.equal(items.length, 1);
  const match = /changes_since=([^&]+)/.exec(seenUrl);
  assert.ok(match, "changes_since missing from the request URL: " + seenUrl);
  const sent = decodeURIComponent(match[1]);
  assert.match(sent, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "changes_since is not ISO 8601 (has a space, not a T?): " + sent);
  assert.doesNotMatch(sent, / /, "changes_since contains a literal space - PocketBase's stored date shape, not ISO 8601");
});

test("sumup.fetchHistory: pages via links[].next up to maxPages", () => {
  const sumup = adapter("sumup.js");
  let calls = 0;
  const transport = () => {
    calls += 1;
    if (calls === 1) {
      return {
        statusCode: 200,
        json: { items: [{ id: "a" }], links: [{ rel: "next", href: sumup.BASE_URL + "/merchants/M/transactions/history?cursor=2" }] },
      };
    }
    return { statusCode: 200, json: { items: [{ id: "b" }], links: [] } };
  };
  const items = sumup.fetchHistory("M", "k", "2026-09-20T00:00:00.000Z", 5, transport);
  assert.equal(calls, 2);
  assert.deepEqual(items.map((i) => i.id), ["a", "b"]);
});

test("sumup.resolveNextUrl: follows the real origin and a path-absolute link, refuses anything else", () => {
  const sumup = adapter("sumup.js");
  assert.equal(sumup.resolveNextUrl(sumup.BASE_URL + "/merchants/M/transactions/history?cursor=2"), sumup.BASE_URL + "/merchants/M/transactions/history?cursor=2");
  assert.equal(sumup.resolveNextUrl("/v2.1/merchants/M/transactions/history?cursor=2"), sumup.ORIGIN + "/v2.1/merchants/M/transactions/history?cursor=2");
  assert.equal(sumup.resolveNextUrl("https://evil.example.com/steal"), null, "a different host must never be followed");
  assert.equal(sumup.resolveNextUrl(""), null);
  assert.equal(sumup.resolveNextUrl(null), null);
});

test("sumup.fetchHistory: a links[].href on a different host stops paging rather than following it", () => {
  const sumup = adapter("sumup.js");
  let calls = 0;
  const transport = () => {
    calls += 1;
    return {
      statusCode: 200,
      json: { items: [{ id: "only" }], links: [{ rel: "next", href: "https://evil.example.com/steal" }] },
    };
  };
  const items = sumup.fetchHistory("M", "k", "2026-09-20T00:00:00.000Z", 5, transport);
  assert.equal(calls, 1, "paging must stop, not follow an off-origin link");
  assert.deepEqual(items.map((i) => i.id), ["only"]);
});

test("sumup.fetchTransaction: returns the detail body, products[] included", () => {
  const sumup = adapter("sumup.js");
  const transport = (req) => {
    assert.match(req.url, /transactions\?id=txn-1/);
    return { statusCode: 200, json: { id: "txn-1", products: [{ name: "GGP-AAAAAY Item", quantity: 1 }] } };
  };
  const detail = sumup.fetchTransaction("M", "k", "txn-1", transport);
  assert.equal(detail.id, "txn-1");
  assert.equal(detail.products[0].name, "GGP-AAAAAY Item");
});

// =======================================================================
// SumUp Readers API (Phase 7: the Solo card reader at the counter).
// Every one of these answers { ok, status, message, data } rather than
// throwing - see the adapter's own Phase 7 block.
// =======================================================================

test("sumup: the Readers API lives on /v0.1 and leaves the /v2.1 transactions calls alone", () => {
  const sumup = adapter("sumup.js");
  assert.equal(sumup.BASE_URL, "https://api.sumup.com/v2.1");
  assert.equal(sumup.READERS_BASE_URL, "https://api.sumup.com/v0.1");
  // The paging guard the history calls depend on is untouched by Phase 7.
  assert.equal(sumup.resolveNextUrl("/v2.1/merchants/M/transactions/history?cursor=2"), sumup.ORIGIN + "/v2.1/merchants/M/transactions/history?cursor=2");
  assert.equal(sumup.resolveNextUrl("https://evil.example.com/steal"), null);
});

test("sumup.listReaders: GETs the merchant's readers and reduces each to id, name, status and model", () => {
  const sumup = adapter("sumup.js");
  const transport = (req) => {
    assert.equal(req.url, "https://api.sumup.com/v0.1/merchants/M1/readers");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.Authorization, "Bearer test-key");
    return {
      statusCode: 200,
      json: {
        items: [
          { id: "r1", name: "Counter Solo", status: "paired", device: { identifier: "S1", model: "solo" } },
          { id: "", name: "half a row" },
        ],
      },
    };
  };
  const result = sumup.listReaders("M1", "test-key", transport);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ id: "r1", name: "Counter Solo", status: "paired", model: "solo" }]);
});

test("sumup.listReaders: a SumUp failure comes back as not ok with the 'did not answer' sentence", () => {
  const sumup = adapter("sumup.js");
  const result = sumup.listReaders("M1", "k", () => ({ statusCode: 500, json: null }));
  assert.equal(result.ok, false);
  assert.equal(result.message, sumup.READER_MESSAGES.unavailable);
  assert.deepEqual(result.data, []);
});

test("sumup.pairReader: POSTs the pairing code as JSON and maps a refused code to its own sentence", () => {
  const sumup = adapter("sumup.js");
  let seen = null;
  const good = (req) => {
    seen = req;
    return {
      statusCode: 201,
      json: { id: "r9", name: "Counter Solo", status: "paired", device: { identifier: "S9", model: "solo" } },
    };
  };
  const paired = sumup.pairReader("M1", "k", "ABCD1234", "Counter Solo", good);
  assert.equal(seen.url, "https://api.sumup.com/v0.1/merchants/M1/readers");
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen.body), { pairing_code: "ABCD1234", name: "Counter Solo" });
  assert.equal(paired.ok, true);
  assert.equal(paired.data.id, "r9");

  const refused = sumup.pairReader("M1", "k", "NOPE1234", "", () => ({ statusCode: 422, json: {} }));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);
  assert.equal(refused.message, sumup.READER_MESSAGES.pairing);
});

test("sumup.unpairReader: DELETEs the reader, and treats a 404 as already unpaired", () => {
  const sumup = adapter("sumup.js");
  let seen = null;
  const result = sumup.unpairReader("M1", "k", "r9", (req) => {
    seen = req;
    return { statusCode: 204, json: null };
  });
  assert.equal(seen.url, "https://api.sumup.com/v0.1/merchants/M1/readers/r9");
  assert.equal(seen.method, "DELETE");
  assert.equal(result.ok, true);

  const gone = sumup.unpairReader("M1", "k", "r9", () => ({ statusCode: 404, json: {} }));
  assert.equal(gone.ok, true, "a reader SumUp has already forgotten is as unpaired as this call could make it");
});

test("sumup.createReaderCheckout: sends pence as SumUp's own minor-unit shape and reads data.checkout_id back", () => {
  const sumup = adapter("sumup.js");
  let seen = null;
  const result = sumup.createReaderCheckout(
    "M1",
    "k",
    "r9",
    {
      amountPence: 4200,
      description: "GG-S-000456",
      returnUrl: "https://vault.example.test/api/vault/sumup/callback/tok",
    },
    (req) => {
      seen = req;
      return { statusCode: 201, json: { data: { checkout_id: "chk-1", client_transaction_id: "ctid-1" } } };
    }
  );
  assert.equal(seen.url, "https://api.sumup.com/v0.1/merchants/M1/readers/r9/checkout");
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers.Authorization, "Bearer k");
  const body = JSON.parse(seen.body);
  // Integer pence, never a decimal built in JS.
  assert.deepEqual(body.total_amount, { currency: "GBP", minor_unit: 2, value: 4200 });
  assert.equal(body.description, "GG-S-000456");
  assert.equal(body.return_url, "https://vault.example.test/api/vault/sumup/callback/tok");
  assert.equal(result.ok, true);
  assert.equal(result.data.checkout_id, "chk-1");
  assert.equal(result.data.client_transaction_id, "ctid-1");
});

test("sumup.createReaderCheckout: 422 is the reader being offline, 404 is it no longer being paired", () => {
  const sumup = adapter("sumup.js");
  const offline = sumup.createReaderCheckout("M1", "k", "r9", { amountPence: 100 }, () => ({
    statusCode: 422,
    json: {},
  }));
  assert.equal(offline.ok, false);
  assert.equal(offline.status, 422);
  assert.equal(offline.message, "The reader is offline. Check it is on and connected, then try again.");

  const unpaired = sumup.createReaderCheckout("M1", "k", "r9", { amountPence: 100 }, () => ({
    statusCode: 404,
    json: {},
  }));
  assert.equal(unpaired.status, 422);
  assert.equal(unpaired.message, "That reader is no longer paired. Pair it again under Settings.");
});

test("sumup.getReaderCheckout and terminateReaderCheckout: the status and the stop call", () => {
  const sumup = adapter("sumup.js");
  let seen = null;
  const status = sumup.getReaderCheckout("M1", "k", "r9", "chk-1", (req) => {
    seen = req;
    return { statusCode: 200, json: { data: { status: "SUCCESSFUL" } } };
  });
  assert.equal(seen.url, "https://api.sumup.com/v0.1/merchants/M1/readers/r9/checkout/chk-1");
  assert.equal(seen.method, "GET");
  assert.equal(status.data.status, "SUCCESSFUL");

  const stopped = sumup.terminateReaderCheckout("M1", "k", "r9", (req) => {
    seen = req;
    return { statusCode: 200, json: {} };
  });
  assert.equal(seen.url, "https://api.sumup.com/v0.1/merchants/M1/readers/r9/terminate");
  assert.equal(seen.method, "POST");
  assert.equal(stopped.ok, true);
});

test("sumup.findTransactionByClientId: looks the payment up by client_transaction_id, on /v2.1", () => {
  const sumup = adapter("sumup.js");
  let seen = null;
  const found = sumup.findTransactionByClientId("M1", "k", "ctid-1", (req) => {
    seen = req;
    return {
      statusCode: 200,
      json: { id: "txn-1", transaction_code: "TCODE1", amount: "42.00", status: "SUCCESSFUL", card: { last_4_digits: "4242" } },
    };
  });
  assert.equal(seen.url, "https://api.sumup.com/v2.1/merchants/M1/transactions?client_transaction_id=ctid-1");
  assert.equal(seen.headers.Authorization, "Bearer k");
  assert.equal(found.ok, true);
  assert.equal(found.data.transaction_code, "TCODE1");
  // The amount stays the string SumUp sent: lib/readers.js parses it
  // through the shared money helpers, never through a float.
  assert.equal(found.data.amount, "42.00");

  const listShape = sumup.findTransactionByClientId("M1", "k", "ctid-2", () => ({
    statusCode: 200,
    json: { items: [{ id: "txn-2" }] },
  }));
  assert.equal(listShape.data.id, "txn-2");

  const unknown = sumup.findTransactionByClientId("M1", "k", "ctid-3", () => ({ statusCode: 404, json: {} }));
  assert.equal(unknown.ok, true, "SumUp not knowing of a transaction yet is an answer, not a failure");
  assert.equal(unknown.data, null);
});

// =======================================================================
// Live smoke (GG_ADAPTER_SMOKE=1): calls the keyless sources for real, for
// the exact cards named in the brief, and prints what came back. Skips
// cleanly - no tests registered at all - without the flag.
// =======================================================================

if (process.env.GG_ADAPTER_SMOKE === "1") {
  // adapters/http.js falls through to a real `$http.send` when no
  // transport is given and no override global is set - that binding only
  // exists inside PocketBase, so the smoke run provides its own, backed by
  // `curl` (already how this session's outbound HTTPS goes through the
  // configured proxy, and every adapter's own functions are synchronous to
  // match goja's synchronous $http.send, which rules out Node's own
  // (Promise-based) fetch here).
  global.$os = { getenv: () => "" };
  global.$http = {
    send(cfg) {
      const args = ["-sS", "-i", "-L", "--max-time", String(Math.ceil(cfg.timeout || 20)), "-X", cfg.method || "GET"];
      const headers = cfg.headers || {};
      for (const key of Object.keys(headers)) args.push("-H", `${key}: ${headers[key]}`);
      if (cfg.body) args.push("--data-raw", cfg.body);
      args.push(cfg.url);
      // Buffer, not a string: an image adapter (YGOPRODeck, OPTCG) fetches
      // raw JPEG bytes through this same path, and decoding those as UTF-8
      // to split on a blank line first would corrupt them. `-L` follows the
      // one redirect Frankfurter's old .app host now issues.
      const out = execFileSync("curl", args, { maxBuffer: 20 * 1024 * 1024 });
      // With -L, a redirect prints one header block per hop; only the last
      // "header block, blank line, body" split (found from the end) is the
      // final response.
      const marker = Buffer.from("\r\n\r\n");
      let splitAt = out.lastIndexOf(marker);
      if (splitAt < 0) splitAt = out.lastIndexOf(Buffer.from("\n\n"));
      const headerText = (splitAt >= 0 ? out.subarray(0, splitAt) : out).toString("latin1");
      const bodyBuffer = splitAt >= 0 ? out.subarray(splitAt + marker.length) : Buffer.alloc(0);
      // -L (and the proxy's own CONNECT tunnel banner) can print more than
      // one "HTTP/... status" line before the final response's own; the
      // last one is the one that actually answers this request.
      const headerLines = headerText.split(/\r?\n/);
      const statusLine = [...headerLines].reverse().find((l) => /^HTTP\/\d/.test(l)) || "";
      const statusMatch = statusLine.match(/\s(\d{3})\b/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      let json = null;
      try {
        json = JSON.parse(bodyBuffer.toString("utf8"));
      } catch (err) {
        json = null;
      }
      return { statusCode, json, headers: {}, body: Array.from(bodyBuffer) };
    },
  };

  test("[smoke] tcgdex sv151(=sv03.5)/199", async () => {
    const tcgdex = adapter("tcgdex.js");
    const card = tcgdex.getBySetNumber("sv03.5", "199");
    console.log("[smoke] tcgdex image:", card && card.imageLarge);
    console.log("[smoke] tcgdex prices:", card && JSON.stringify(tcgdex.getPrices(card, "holo")));
    assert.ok(card, "tcgdex returned no card for sv03.5/199");
  });

  test("[smoke] scryfall blb/223", async () => {
    const scryfall = adapter("scryfall.js");
    const card = scryfall.getBySetNumber("blb", "223");
    console.log("[smoke] scryfall image:", card && card.imageLarge);
    console.log("[smoke] scryfall prices:", card && JSON.stringify(scryfall.getPrices(card, "nonfoil")));
    assert.ok(card, "scryfall returned no card for blb/223");
  });

  test("[smoke] ygoprodeck passcode 46986414", async () => {
    const ygoprodeck = adapter("ygoprodeck.js");
    // cardinfo.php's `fname` is a fuzzy *name* search, not a betcode/passcode
    // lookup, so the smoke check for the named passcode goes straight to
    // the id lookup search() is built on internally.
    const http = adapter("http.js");
    const res = http.request({ url: "https://db.ygoprodeck.com/api/v7/cardinfo.php?id=46986414", method: "GET" });
    const card = res.json && res.json.data && res.json.data[0];
    console.log("[smoke] ygoprodeck card:", card && card.name, "image:", card && card.card_images && card.card_images[0] && card.card_images[0].image_url);

    const rows = ygoprodeck.search("Dark Magician");
    console.log("[smoke] ygoprodeck search('Dark Magician') rows:", rows.length);
    assert.ok(card, "ygoprodeck returned no card for passcode 46986414");
  });

  test("[smoke] optcg OP01-001", async () => {
    const optcg = adapter("optcg.js");
    const card = optcg.getBySetNumber("OP01", "001");
    console.log("[smoke] optcg image bytes:", card && card.imageBytes && card.imageBytes.length);
    console.log("[smoke] optcg prices:", card && JSON.stringify(optcg.getPrices(card)));
    assert.ok(card, "optcg returned no card for OP01-001");
  });

  test("[smoke] lorcast 1/1", async () => {
    const lorcast = adapter("lorcast.js");
    const card = lorcast.getBySetNumber("1", "1");
    console.log("[smoke] lorcast image:", card && card.imageLarge);
    console.log("[smoke] lorcast prices:", card && JSON.stringify(lorcast.getPrices(card, "normal")));
    assert.ok(card, "lorcast returned no card for 1/1");
  });

  test("[smoke] frankfurter latest GBP rates", async () => {
    const frankfurter = adapter("frankfurter.js");
    const rates = frankfurter.fetchRates(["EUR", "USD"]);
    console.log("[smoke] frankfurter rates:", JSON.stringify(rates));
    assert.ok(rates.quotes.EUR > 0 && rates.quotes.USD > 0);
  });
}
