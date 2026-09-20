// GG_ADAPTER_TRANSPORT_MODE=fixture (adapters/http.js): canned answers for
// every outbound call pb/scripts/check.sh's own route-level Phase 3 checks
// make, drawn from the exact same pb_hooks/adapters/fixtures/ files
// pb/scripts/check-adapters.mjs unit-tests each adapter against. This is
// what lets check.sh exercise a real route (lookup, refresh-prices, the
// image queue) end to end - the write-through, the GBP conversion, the
// audit row - with no real network call anywhere.
//
// Replaces GG_ADAPTER_TRANSPORT_MODE=offline_fail's blanket refusal, not
// its safety guarantee: any URL matched against none of the patterns below
// still throws, so a route this build never intended to call out from still
// fails loudly under test rather than silently reaching the real network
// (adapters/http.js falls through to this module's respond() only when
// GG_ADAPTER_TRANSPORT_MODE=fixture is set, and to the old blanket throw
// for every other mode).
//
// Goja-only - needs $os.readFile to load a fixture file's own JSON off
// disk, the same way adapters/images.js is goja-only for $filesystem. Never
// required under plain Node: pb/scripts/check-adapters.mjs tests every
// adapter directly, with its own per-test transport function, and never
// sets GG_ADAPTER_TRANSPORT_MODE at all (see that file's own banner).
"use strict";

var FIXTURES_DIR = __hooks + "/adapters/fixtures";

// The 1x1 transparent PNG pb/scripts/check.sh's own ID-check section
// already writes to disk for its multipart upload test - real, sniffable
// image bytes, decoded once here from the same literal rather than shipping
// a second binary fixture file for the same handful of bytes. Used for the
// image-queue-drain check's "this one actually caches" case.
var GOOD_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A synthetic host no real adapter ever calls, reserved for the
// image-queue-drain check: a real image, one well over
// adapters/images.js's own size cap, and one that answers 200 with bytes
// that are not an image at all - proving the cap and the mime sniff both
// hold on the real cacheImageFromUrl()/drainImageQueue() path, not only in
// adapters/images.js's own isolated logic.
var FIXTURE_IMAGE_HOST = "img.fixtures.test";

function bytesToString(bytes) {
  var chars = [];
  for (var i = 0; i < bytes.length; i++) chars.push(String.fromCharCode(bytes[i] & 0xff));
  return chars.join("");
}

function loadFixture(name) {
  var raw = $os.readFile(FIXTURES_DIR + "/" + name);
  var text = typeof raw === "string" ? raw : bytesToString(raw);
  return JSON.parse(text);
}

function ok(json) {
  return { statusCode: 200, json: json, headers: {}, body: null };
}

function okBytes(bytes) {
  return { statusCode: 200, json: null, headers: {}, body: bytes };
}

function goodImageBytes() {
  var base64 = require(__hooks + "/lib/base64.js");
  return base64.decode(GOOD_IMAGE_BASE64);
}

/** Comfortably over MAX_IMAGE_BYTES, whatever that constant is set to. */
function oversizedImageBytes() {
  var images = require(__hooks + "/adapters/images.js");
  var size = (images.MAX_IMAGE_BYTES || 2097152) + 1024;
  var bytes = [];
  for (var i = 0; i < size; i++) bytes.push(0);
  return bytes;
}

function notImageBytes() {
  var text = "this is not an image, just some plain bytes with a 200 and an image-shaped URL";
  var bytes = [];
  for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
  return bytes;
}

/**
 * Replaces the literal string "__NOW__" wherever it appears as a
 * `timestamp` field (top level, or inside a top-level `items` array) with
 * the real current instant. See the SumUp block below for why one fixture
 * needs this at all.
 */
function resolveNowPlaceholders(json) {
  if (!json) return json;
  if (json.timestamp === "__NOW__") json.timestamp = new Date().toISOString();
  if (Array.isArray(json.items)) {
    for (var i = 0; i < json.items.length; i++) {
      if (json.items[i] && json.items[i].timestamp === "__NOW__") {
        json.items[i].timestamp = new Date().toISOString();
      }
    }
  }
  return json;
}

function refuse(call, why) {
  var http = require(__hooks + "/adapters/http.js");
  throw new Error(
    "fixture transport has no mapping for " + call.method + " " + http.stripQuery(call.url) + (why ? " (" + why + ")" : "")
  );
}

/**
 * `call` is adapters/http.js's own shape: {url, method, headers, body,
 * timeoutSeconds}. Matched the same way every adapter's own unit test in
 * pb/scripts/check-adapters.mjs matches it - a plain substring check
 * against the URL, in the order a real request would actually try them (a
 * search before an exact fetch, PAL before NTSC).
 */
function respond(call) {
  var url = call.url || "";
  var headers = call.headers || {};

  // -- The fixture-only synthetic image host (see FIXTURE_IMAGE_HOST above) --
  if (url.indexOf(FIXTURE_IMAGE_HOST + "/good.png") >= 0) return okBytes(goodImageBytes());
  if (url.indexOf(FIXTURE_IMAGE_HOST + "/oversized.bin") >= 0) return okBytes(oversizedImageBytes());
  if (url.indexOf(FIXTURE_IMAGE_HOST + "/not-image.txt") >= 0) return okBytes(notImageBytes());

  // -- Frankfurter (FX) -----------------------------------------------------
  if (url.indexOf("api.frankfurter") >= 0) return ok(loadFixture("frankfurter_gbp_latest.json"));

  // -- TCGdex (Pokemon): exact card, then free-text search. ------------------
  if (url.indexOf("api.tcgdex.net/v2/en/sets/") >= 0) return ok(loadFixture("tcgdex_sv151_199.json"));
  if (url.indexOf("api.tcgdex.net/v2/en/cards?") >= 0) return ok(loadFixture("tcgdex_search_charizard.json"));

  // -- Scryfall (MTG): the exact-card fixture doubles as a one-row search
  //    result - scryfall.search() only ever reads res.json.data[]. ----------
  if (url.indexOf("api.scryfall.com/cards/search") >= 0) {
    return ok({ data: [loadFixture("scryfall_blb_223.json")] });
  }
  if (url.indexOf("api.scryfall.com/cards/") >= 0) return ok(loadFixture("scryfall_blb_223.json"));

  // -- YGOPRODeck (Yu-Gi-Oh!): search, the two exact-lookup calls, then the
  //    (hotlink-banned, always re-hosted) image itself. ----------------------
  if (url.indexOf("cardsetsinfo.php") >= 0) return ok(loadFixture("ygoprodeck_cardsetsinfo_CT13-EN003.json"));
  if (url.indexOf("cardinfo.php?id=46986421") >= 0) return ok(loadFixture("ygoprodeck_46986421.json"));
  if (url.indexOf("cardinfo.php?fname=") >= 0) return ok(loadFixture("ygoprodeck_46986414.json"));
  if (url.indexOf("images.ygoprodeck.com") >= 0) return okBytes(goodImageBytes());

  // -- OPTCG (One Piece): the exact card, then its re-hosted image. ----------
  if (url.indexOf("/api/sets/card/") >= 0) return ok(loadFixture("optcg_OP01-001.json"));
  if (url.indexOf("Card_Images") >= 0) return okBytes(goodImageBytes());

  // -- Lorcast (Disney Lorcana) -----------------------------------------------
  if (url.indexOf("api.lorcast.com/v0/cards/") >= 0) return ok(loadFixture("lorcast_1_1.json"));

  // -- IGDB (retro titles): the token call always answers, but the games
  //    search call refuses for one specific Client-ID -
  //    "fixture-unmapped-client" - so pb/scripts/check.sh can exercise
  //    "a source is configured, but this particular call has no fixture"
  //    (the 502 lookup.pb.js's retro/lookup route throws on any IGDB
  //    failure) through the very same adapter code path the success case
  //    uses, rather than a second, parallel test harness. -------------------
  if (url.indexOf("id.twitch.tv") >= 0) return ok(loadFixture("igdb_HANDWRITTEN_oauth_token.json"));
  if (url.indexOf("api.igdb.com") >= 0) {
    if (headers["Client-ID"] === "fixture-unmapped-client") {
      return refuse(call, 'Client-ID "fixture-unmapped-client" has no games-search fixture on purpose');
    }
    return ok(loadFixture("igdb_HANDWRITTEN_games_search.json"));
  }
  if (url.indexOf("images.igdb.com") >= 0) return okBytes(goodImageBytes());

  // -- eBay (UK asking price) --------------------------------------------------
  if (url.indexOf("ebay.com") >= 0 && url.indexOf("oauth2/token") >= 0) {
    return ok(loadFixture("ebay_HANDWRITTEN_oauth_token.json"));
  }
  if (url.indexOf("item_summary/search") >= 0) return ok(loadFixture("ebay_HANDWRITTEN_item_summary_search.json"));

  // -- PriceCharting (retro prices): the search fixture carries both an
  //    NTSC and a PAL row (like the real API - adapters/pricecharting.js
  //    matches on console-name, never the URL), so the identical /products?
  //    call correctly answers both a PAL search and, when the caller is
  //    really after NTSC (no PAL entry for this title), an NTSC search too. -
  if (url.indexOf("pricecharting.com/api/products") >= 0) {
    return ok(loadFixture("pricecharting_HANDWRITTEN_products_search_pal.json"));
  }
  if (url.indexOf("pricecharting.com/api/product?") >= 0) {
    return ok(
      url.indexOf("id=pal-") >= 0
        ? loadFixture("pricecharting_HANDWRITTEN_product_pal.json")
        : loadFixture("pricecharting_HANDWRITTEN_product_ntsc.json")
    );
  }

  // -- SumUp (the transactions pull, pb_hooks/lib/sumup.js) -----------------
  //    Two transactions in the one history page:
  //      - "txn-sku-0001" matches by a product name prefixed with a real
  //        SKU (GGP-AAAAAY, a hand-computed valid Crockford code - see
  //        pb/scripts/check.sh's own SumUp section for how it is built).
  //        Its amount and timestamp are deliberately unrelated to any real
  //        sale, so a match here can only have come from the SKU rule,
  //        never the amount+time one.
  //      - "txn-amount-0002" carries no SKU in its product name at all, so
  //        it can only match by amount and a timestamp within three
  //        minutes of a real sale's. A static timestamp baked into a
  //        fixture file could never land within that window when the
  //        script actually runs, so this one's `timestamp` is the literal
  //        string "__NOW__", resolved to the real current instant the
  //        moment this transport actually serves it - the file itself is
  //        still the full, real SumUp response shape; only the one field a
  //        static file structurally cannot supply is a placeholder.
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("/transactions/history") >= 0) {
    return ok(resolveNowPlaceholders(loadFixture("sumup_HANDWRITTEN_transactions_history.json")));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-sku-0001") >= 0) {
    return ok(loadFixture("sumup_HANDWRITTEN_transaction_sku.json"));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-amount-0002") >= 0) {
    return ok(resolveNowPlaceholders(loadFixture("sumup_HANDWRITTEN_transaction_amount.json")));
  }

  return refuse(call, "");
}

module.exports = { respond: respond, FIXTURE_IMAGE_HOST: FIXTURE_IMAGE_HOST };
