// SumUp Transactions API: docs/PLAN.md "SumUp integration (verified
// against developer.sumup.com)". Sales rung through the SumUp app (card
// or cash) reach us through no webhook at all, so this pulls them:
//   GET https://api.sumup.com/v2.1/merchants/{code}/transactions/history
//       ?changes_since=<iso>&limit=100
//   GET https://api.sumup.com/v2.1/merchants/{code}/transactions?id=<id>
// The history list carries no line-item detail, hence the second call per
// transaction for its own `products[]` (matched back to our stock by a
// product name prefixed with our SKU - see lib/sumup.js).
//
// Authenticated with a plain merchant API key (`Authorization: Bearer
// <key>`), not OAuth: a SumUp merchant API key is a long-lived personal
// access token issued from the merchant's own dashboard, so unlike
// adapters/ebay.js and adapters/igdb.js there is no client-credentials
// token to fetch or cache here.
//
// Phase 7 adds the Readers API (/v0.1/merchants/{code}/readers...), which
// is how a paired Solo terminal is listed, paired, handed an amount and
// stopped again, plus a transactions lookup by `client_transaction_id`
// that says whether the money a reader reported actually moved. See the
// Phase 7 block at the foot of this file.
//
// Same shape as every other adapter in this directory (adapters/http.js's
// header comment): a plain CommonJS module, required fresh from inside
// each caller's handler body, `transport` always the last, optional
// argument so a test can substitute one without touching
// GG_ADAPTER_TRANSPORT_MODE.
"use strict";

var ORIGIN = "https://api.sumup.com";
var BASE_URL = ORIGIN + "/v2.1";
// The Readers API (a paired Solo terminal) is the one part of SumUp this
// app talks to outside /v2.1 - see the Phase 7 block at the foot of this
// file.
var READERS_BASE_URL = ORIGIN + "/v0.1";
var HISTORY_LIMIT = 100;
var DEFAULT_MAX_PAGES = 20;

function authHeaders(apiKey) {
  return { Authorization: "Bearer " + apiKey };
}

function jsonHeaders(apiKey) {
  return { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" };
}

/**
 * `links[].href` resolved to a URL worth following, or null when it is
 * not one - a relative, path-absolute link ("/v2.1/...") is resolved
 * against SumUp's own origin; anything that does not end up on that
 * origin (a different host entirely, or a malformed value) is refused,
 * so a response this adapter did not expect can never walk paging off to
 * some other server. Paging simply stops when this returns null.
 */
function resolveNextUrl(href) {
  if (!href || typeof href !== "string") return null;
  if (href.indexOf(ORIGIN) === 0) return href;
  if (href.charAt(0) === "/") return ORIGIN + href;
  return null;
}

/**
 * One page of transaction history.
 * @returns {{items: object[], nextUrl: string|null}}
 */
function fetchHistoryPage(url, apiKey, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var res = http.request({ url: url, method: "GET", headers: authHeaders(apiKey) }, transport);
  if (res.statusCode !== 200 || !res.json) {
    throw new Error("SumUp transactions history returned " + res.statusCode);
  }
  var items = res.json.items || [];
  var links = res.json.links || [];
  var next = null;
  for (var i = 0; i < links.length; i++) {
    if (links[i] && links[i].rel === "next" && links[i].href) {
      next = resolveNextUrl(links[i].href);
      break;
    }
  }
  return { items: items, nextUrl: next };
}

/**
 * Every transaction changed since `changesSince` (an ISO 8601 string),
 * following `links` for paging up to `maxPages` - a hard stop so a
 * misread or looping "next" link can never hold a pull open forever.
 * @returns {object[]}
 */
function fetchHistory(merchantCode, apiKey, changesSince, maxPages, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var url =
    BASE_URL +
    "/merchants/" +
    encodeURIComponent(merchantCode) +
    "/transactions/history?" +
    http.qs({ changes_since: changesSince, limit: HISTORY_LIMIT });

  var all = [];
  var cap = maxPages || DEFAULT_MAX_PAGES;
  var pages = 0;
  while (url && pages < cap) {
    var page = fetchHistoryPage(url, apiKey, transport);
    all = all.concat(page.items);
    url = page.nextUrl;
    pages += 1;
  }
  return all;
}

/**
 * One transaction's own detail, including `products[]` (absent from the
 * history list).
 * @returns {object}
 */
function fetchTransaction(merchantCode, apiKey, transactionId, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var url =
    BASE_URL + "/merchants/" + encodeURIComponent(merchantCode) + "/transactions?" + http.qs({ id: transactionId });
  var res = http.request({ url: url, method: "GET", headers: authHeaders(apiKey) }, transport);
  if (res.statusCode !== 200 || !res.json) {
    throw new Error("SumUp transaction detail returned " + res.statusCode + " for " + transactionId);
  }
  return res.json;
}

// =====================================================================
// Phase 7: the Solo card reader (SumUp's Readers API, /v0.1)
//
// A paired Solo takes the payment at the counter and reports the result
// back to `return_url`, so these calls are what turn "£42.00, card" on
// the Sell screen into an amount already on the reader's screen. See
// docs/api-contract.md's Phase 7 section for the routes over them and
// pb_hooks/lib/readers.js for the logic.
//
// Every function below answers `{ ok, status, message, data }` rather
// than throwing: a reader that is off, unplugged or no longer paired is
// an ordinary thing to happen at a counter, and the sentence staff need
// to read differs per status. `message` is that sentence, empty on
// success. A transport-level failure (no network at all) still throws,
// the same as every other call in this file.
// =====================================================================

/** The reader collection's own URL, with an optional suffix ("/{id}", "/{id}/checkout"). */
function readersUrl(merchantCode, suffix) {
  return (
    READERS_BASE_URL + "/merchants/" + encodeURIComponent(merchantCode) + "/readers" + (suffix || "")
  );
}

/** One `{ ok, status, message, data }` answer, so every caller reads the same shape. */
function readerResult(statusCode, message, data) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    message: message || "",
    data: data === undefined ? null : data,
  };
}

/**
 * The one wording for each way a reader call can be refused, kept here
 * beside the calls themselves so the two routes and the cron that make
 * them cannot word the same refusal three different ways.
 */
var READER_MESSAGES = {
  offline: "The reader is offline. Check it is on and connected, then try again.",
  unpaired: "That reader is no longer paired. Pair it again under Settings.",
  pairing: "That pairing code was not accepted. Read the code off the reader again; it changes each time.",
  unavailable: "SumUp did not answer. Try again in a moment.",
};

/** A reader object reduced to the fields this app shows. */
function normaliseReader(raw) {
  if (!raw || typeof raw !== "object") return null;
  var device = raw.device || {};
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    status: String(raw.status || ""),
    model: String(device.model || ""),
  };
}

/**
 * Every reader paired to this merchant.
 * @returns {{ok:boolean, status:number, message:string, data:object[]}}
 */
function listReaders(merchantCode, apiKey, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var res = http.request(
    { url: readersUrl(merchantCode, ""), method: "GET", headers: authHeaders(apiKey) },
    transport
  );
  if (res.statusCode !== 200 || !res.json) {
    return readerResult(res.statusCode || 502, READER_MESSAGES.unavailable, []);
  }
  var items = res.json.items || [];
  var readers = [];
  for (var i = 0; i < items.length; i++) {
    var reader = normaliseReader(items[i]);
    if (reader && reader.id) readers.push(reader);
  }
  return readerResult(200, "", readers);
}

/**
 * Pair a Solo with the 8 or 9 character code from its own Connections >
 * API > Connect screen (it lasts five minutes and changes each time).
 */
function pairReader(merchantCode, apiKey, pairingCode, name, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var payload = { pairing_code: String(pairingCode || "") };
  if (name) payload.name = String(name);
  var res = http.request(
    {
      url: readersUrl(merchantCode, ""),
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify(payload),
    },
    transport
  );
  if (res.statusCode === 200 || res.statusCode === 201) {
    return readerResult(res.statusCode, "", normaliseReader(res.json));
  }
  if (res.statusCode === 404 || res.statusCode === 409 || res.statusCode === 422 || res.statusCode === 400) {
    return readerResult(422, READER_MESSAGES.pairing, null);
  }
  return readerResult(502, READER_MESSAGES.unavailable, null);
}

/** Unpair a reader. SumUp answers 204; anything else is reported as it is. */
function unpairReader(merchantCode, apiKey, readerId, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var res = http.request(
    {
      url: readersUrl(merchantCode, "/" + encodeURIComponent(readerId)),
      method: "DELETE",
      headers: authHeaders(apiKey),
    },
    transport
  );
  if (res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 404) {
    // A reader SumUp has already forgotten is as unpaired as this call
    // could make it, so 404 counts as done rather than as a failure.
    return readerResult(204, "", null);
  }
  return readerResult(502, READER_MESSAGES.unavailable, null);
}

/**
 * Put an amount on a paired reader. `amountPence` is an integer of GBP
 * pence, sent as SumUp's own `{ currency, minor_unit, value }` shape so
 * no decimal is ever built here.
 * @returns {{ok:boolean, status:number, message:string, data:{checkout_id:string, client_transaction_id:string}|null}}
 */
function createReaderCheckout(merchantCode, apiKey, readerId, opts, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var payload = {
    total_amount: { currency: "GBP", minor_unit: 2, value: opts.amountPence },
    description: String(opts.description || ""),
  };
  if (opts.returnUrl) payload.return_url = String(opts.returnUrl);
  var res = http.request(
    {
      url: readersUrl(merchantCode, "/" + encodeURIComponent(readerId) + "/checkout"),
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify(payload),
    },
    transport
  );
  if (res.statusCode === 200 || res.statusCode === 201) {
    var data = (res.json && res.json.data) || {};
    return readerResult(res.statusCode, "", {
      checkout_id: String(data.checkout_id || ""),
      client_transaction_id: String(data.client_transaction_id || ""),
    });
  }
  if (res.statusCode === 404) return readerResult(422, READER_MESSAGES.unpaired, null);
  if (res.statusCode === 422 || res.statusCode === 409) return readerResult(422, READER_MESSAGES.offline, null);
  return readerResult(502, READER_MESSAGES.unavailable, null);
}

/** One reader checkout's own status, for a callback that never arrived. */
function getReaderCheckout(merchantCode, apiKey, readerId, checkoutId, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var res = http.request(
    {
      url: readersUrl(
        merchantCode,
        "/" + encodeURIComponent(readerId) + "/checkout/" + encodeURIComponent(checkoutId)
      ),
      method: "GET",
      headers: authHeaders(apiKey),
    },
    transport
  );
  if (res.statusCode !== 200 || !res.json) {
    return readerResult(res.statusCode || 502, READER_MESSAGES.unavailable, null);
  }
  return readerResult(200, "", res.json.data || res.json);
}

/** Stop whatever is on the reader's screen. A terminated checkout with a return_url is reported to it as failed. */
function terminateReaderCheckout(merchantCode, apiKey, readerId, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var res = http.request(
    {
      url: readersUrl(merchantCode, "/" + encodeURIComponent(readerId) + "/terminate"),
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: "{}",
    },
    transport
  );
  if (res.statusCode >= 200 && res.statusCode < 300) return readerResult(res.statusCode, "", null);
  if (res.statusCode === 404 || res.statusCode === 409) {
    // Nothing on the reader to stop: the thing this call wanted is
    // already true, so the caller carries on to the verification below.
    return readerResult(204, "", null);
  }
  return readerResult(502, READER_MESSAGES.unavailable, null);
}

/**
 * The transaction behind a reader checkout, looked up by the
 * `client_transaction_id` the checkout call returned. This is the one
 * source of truth about whether money actually moved: a callback body is
 * never trusted on its own (lib/readers.js).
 * @returns {{ok:boolean, status:number, message:string, data:object|null}} `data` is null when SumUp knows of no such transaction yet.
 */
function findTransactionByClientId(merchantCode, apiKey, clientTransactionId, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var url =
    BASE_URL +
    "/merchants/" +
    encodeURIComponent(merchantCode) +
    "/transactions?" +
    http.qs({ client_transaction_id: clientTransactionId });
  var res = http.request({ url: url, method: "GET", headers: authHeaders(apiKey) }, transport);
  if (res.statusCode === 404) return readerResult(200, "", null);
  if (res.statusCode !== 200 || !res.json) {
    return readerResult(res.statusCode || 502, READER_MESSAGES.unavailable, null);
  }
  // Documented as one transaction object; a list shape is accepted too,
  // since the same path with an `id=` parameter answers with one and
  // this app never wants to care which SumUp sends.
  var body = res.json;
  if (Array.isArray(body.items)) body = body.items.length ? body.items[0] : null;
  return readerResult(200, "", body || null);
}

module.exports = {
  BASE_URL: BASE_URL,
  ORIGIN: ORIGIN,
  READERS_BASE_URL: READERS_BASE_URL,
  READER_MESSAGES: READER_MESSAGES,
  resolveNextUrl: resolveNextUrl,
  fetchHistoryPage: fetchHistoryPage,
  fetchHistory: fetchHistory,
  fetchTransaction: fetchTransaction,
  listReaders: listReaders,
  pairReader: pairReader,
  unpairReader: unpairReader,
  createReaderCheckout: createReaderCheckout,
  getReaderCheckout: getReaderCheckout,
  terminateReaderCheckout: terminateReaderCheckout,
  findTransactionByClientId: findTransactionByClientId,
};
