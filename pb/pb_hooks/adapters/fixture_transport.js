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

// -- The Solo reader fixtures (see the Readers API block in respond()) ---

/**
 * The outcome a checkout's own description asks for: the words a caller
 * puts in it. Longest first, so one tag that contains another is still
 * read as itself.
 *
 *   paid          SUCCESSFUL for the amount asked for
 *   mismatch      SUCCESSFUL for GBP 5.00 more
 *   eurcurrency   SUCCESSFUL for the right figure in euros
 *   badamount     SUCCESSFUL with an amount that cannot be read at all
 *   refunded      REFUNDED
 *   failed        FAILED
 *   pending       PENDING
 *   unknown       the transactions lookup 404s, the reader says PENDING
 *   readerstatus  the transactions lookup 404s, the reader says FAILED
 *   wrongid       a SUCCESSFUL transaction for somebody else's payment
 *   noref         the checkout comes back with no client_transaction_id
 */
function readerOutcomeFrom(text) {
  var lower = String(text || "").toLowerCase();
  var tags = [
    "readerstatus",
    "eurcurrency",
    "badamount",
    "mismatch",
    "refunded",
    "wrongid",
    "pending",
    "unknown",
    "failed",
    "noref",
  ];
  for (var i = 0; i < tags.length; i++) {
    if (lower.indexOf(tags[i]) >= 0) return tags[i];
  }
  return "paid";
}

/** Integer pence as the decimal string SumUp's own transactions API answers with. */
function penceToDecimal(pence) {
  var whole = Math.floor(Math.abs(pence) / 100);
  var rest = Math.abs(pence) % 100;
  return (pence < 0 ? "-" : "") + whole + "." + (rest < 10 ? "0" + rest : String(rest));
}

/** `{ outcome, pence, nonce }` read back out of a `ctid-<outcome>-<pence>-<nonce>` id. */
function readerIdParts(id) {
  var parts = String(id || "").split("-");
  return {
    outcome: parts[1] || "paid",
    pence: Number(parts[2] || 0),
    nonce: parts[3] || "0",
  };
}

function readerObject(id, name) {
  return {
    id: id,
    name: name || "Counter Solo",
    status: "paired",
    device: { identifier: "SOLO-" + id, model: "solo" },
    created_at: "2026-09-20T09:00:00Z",
    updated_at: "2026-09-20T09:00:00Z",
  };
}

/** Every /readers call: list, get one, pair, unpair, checkout, terminate. */
function readersRespond(call, url) {
  var method = call.method || "GET";
  var body = {};
  try {
    body = call.body ? JSON.parse(call.body) : {};
  } catch (err) {
    body = {};
  }

  if (method === "POST" && url.indexOf("/terminate") >= 0) {
    return { statusCode: 200, json: {}, headers: {}, body: null };
  }

  if (method === "POST" && url.indexOf("/checkout") >= 0) {
    // The reader id itself carries the two failure cases, so a route's
    // own refusals can be exercised without a second fixture mode.
    if (url.indexOf("reader-unknown") >= 0) return { statusCode: 404, json: {}, headers: {}, body: null };
    if (url.indexOf("reader-offline") >= 0) return { statusCode: 422, json: {}, headers: {}, body: null };
    if (url.indexOf("reader-busy") >= 0) return { statusCode: 409, json: {}, headers: {}, body: null };
    var amount = body.total_amount || {};
    var pence = Number(amount.value || 0);
    var outcome = readerOutcomeFrom(body.description);
    var nonce = Math.floor(Math.random() * 1000000000).toString(36);
    var suffix = outcome + "-" + pence + "-" + nonce;
    // The contract says to treat every field of this response as
    // optional, so one outcome answers without the reference at all.
    if (outcome === "noref") return ok({ data: { checkout_id: "chk-" + suffix } });
    return ok({ data: { checkout_id: "chk-" + suffix, client_transaction_id: "ctid-" + suffix } });
  }

  if (method === "GET" && url.indexOf("/checkout/") >= 0) {
    var checkoutId = url.slice(url.indexOf("/checkout/") + "/checkout/".length);
    var parts = readerIdParts(checkoutId);
    var status = "PENDING";
    if (parts.outcome === "paid" || parts.outcome === "mismatch") status = "SUCCESSFUL";
    // "readerstatus" is the one the transactions lookup knows nothing
    // about while the reader itself reports a definite failure, which is
    // the only thing that fallback is ever allowed to act on.
    if (parts.outcome === "failed" || parts.outcome === "readerstatus") status = "FAILED";
    return ok({ data: { status: status, client_transaction_id: "ctid-" + checkoutId.slice(4) } });
  }

  if (method === "DELETE") return { statusCode: 204, json: null, headers: {}, body: null };

  if (method === "POST") {
    var code = String(body.pairing_code || "");
    if (code.length < 8 || code.toUpperCase().indexOf("BAD") >= 0) {
      return { statusCode: 422, json: { message: "invalid pairing code" }, headers: {}, body: null };
    }
    return {
      statusCode: 201,
      json: readerObject("reader-" + code.toLowerCase(), body.name || "Counter Solo"),
      headers: {},
      body: null,
    };
  }

  if (url.indexOf("/readers/") >= 0) {
    var readerId = url.slice(url.indexOf("/readers/") + "/readers/".length);
    return ok(readerObject(readerId, "Counter Solo"));
  }
  return ok({ items: [readerObject("reader-solo-1", "Counter Solo"), readerObject("reader-solo-2", "Back room Solo")] });
}

/** The transactions lookup by client_transaction_id, answered from the id itself. */
function readerTransactionRespond(call, url) {
  var match = /client_transaction_id=([^&]+)/.exec(url);
  var id = match ? decodeURIComponent(match[1]) : "";
  var parts = readerIdParts(id);
  if (parts.outcome === "unknown" || parts.outcome === "readerstatus") {
    // SumUp has never heard of this one: the reader has not reported yet.
    return { statusCode: 404, json: {}, headers: {}, body: null };
  }
  var status = "PENDING";
  if (parts.outcome === "paid" || parts.outcome === "mismatch") status = "SUCCESSFUL";
  if (parts.outcome === "eurcurrency" || parts.outcome === "badamount" || parts.outcome === "wrongid") {
    status = "SUCCESSFUL";
  }
  if (parts.outcome === "failed") status = "FAILED";
  if (parts.outcome === "refunded") status = "REFUNDED";
  // A mismatch answers with £5.00 more than the reader was asked for, so
  // a route that compares the two figures has something to catch.
  var pence = parts.outcome === "mismatch" ? parts.pence + 500 : parts.pence;
  var transaction = {
    id: "txn-" + parts.outcome + "-" + parts.pence + "-" + parts.nonce,
    transaction_code: "TFIX" + String(parts.pence) + parts.nonce.toUpperCase(),
    amount: penceToDecimal(pence),
    currency: parts.outcome === "eurcurrency" ? "EUR" : "GBP",
    status: status,
    payment_type: "POS",
    timestamp: new Date().toISOString(),
    client_transaction_id: id,
  };
  // An amount no parser can read, and a transaction that belongs to
  // somebody else's payment: both have to be refused rather than acted
  // on (lib/readers.js, adapters/sumup.js's own matchesClientId).
  if (parts.outcome === "badamount") transaction.amount = "not an amount";
  if (parts.outcome === "wrongid") transaction.client_transaction_id = "ctid-someone-else-0-zz";
  if (status === "SUCCESSFUL") transaction.card = { last_4_digits: "4242", type: "VISA" };
  return ok(transaction);
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
  //    `changes_since` is checked here for real ISO 8601 (a "T", never a
  //    space) on every call, not just once in a unit test: this is what
  //    makes the fixture-driven pull in pb/scripts/check.sh itself prove
  //    lib/sumup.js never regresses to sending PocketBase's own
  //    space-separated date shape, on the second pull as much as the first.
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("/transactions/history") >= 0) {
    var sinceMatch = /changes_since=([^&]+)/.exec(url);
    if (sinceMatch) {
      var sinceValue = decodeURIComponent(sinceMatch[1]);
      if (sinceValue.indexOf(" ") >= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(sinceValue)) {
        return refuse(call, "changes_since is not ISO 8601: " + sinceValue);
      }
    }
    return ok(resolveNowPlaceholders(loadFixture("sumup_HANDWRITTEN_transactions_history.json")));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-sku-0001") >= 0) {
    return ok(loadFixture("sumup_HANDWRITTEN_transaction_sku.json"));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-amount-0002") >= 0) {
    return ok(resolveNowPlaceholders(loadFixture("sumup_HANDWRITTEN_transaction_amount.json")));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-failed-0003") >= 0) {
    return ok(loadFixture("sumup_HANDWRITTEN_transaction_failed.json"));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-outside-window-0004") >= 0) {
    return ok(loadFixture("sumup_HANDWRITTEN_transaction_outside_window.json"));
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("transactions?id=txn-mixed-0005") >= 0) {
    return ok(resolveNowPlaceholders(loadFixture("sumup_HANDWRITTEN_transaction_mixed.json")));
  }

  // -- SumUp Readers API (the Solo checkouts, pb_hooks/lib/readers.js) ----
  //    Answered from this module rather than a fixture file, because what
  //    a reader checkout has to say back is a function of the request:
  //    the amount that was asked for, and which of the four outcomes the
  //    caller wants to see. Both travel in the checkout's own
  //    `description`, which is the only field pb/scripts/check.sh can put
  //    a marker in, and both come back inside the `client_transaction_id`
  //    the checkout answers with (`ctid-<outcome>-<pence>`), which is the
  //    id the transactions lookup below is then asked about. Nothing is
  //    remembered between calls: every answer is derived from the id in
  //    front of it, so the same lookup gives the same answer however many
  //    times a poll, a callback and the expiry cron each ask it.
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("/readers") >= 0) {
    return readersRespond(call, url);
  }
  if (url.indexOf("api.sumup.com") >= 0 && url.indexOf("client_transaction_id=") >= 0) {
    return readerTransactionRespond(call, url);
  }

  return refuse(call, "");
}

module.exports = { respond: respond, FIXTURE_IMAGE_HOST: FIXTURE_IMAGE_HOST };
