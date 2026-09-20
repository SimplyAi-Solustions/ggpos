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
// Same shape as every other adapter in this directory (adapters/http.js's
// header comment): a plain CommonJS module, required fresh from inside
// each caller's handler body, `transport` always the last, optional
// argument so a test can substitute one without touching
// GG_ADAPTER_TRANSPORT_MODE.
"use strict";

var ORIGIN = "https://api.sumup.com";
var BASE_URL = ORIGIN + "/v2.1";
var HISTORY_LIMIT = 100;
var DEFAULT_MAX_PAGES = 20;

function authHeaders(apiKey) {
  return { Authorization: "Bearer " + apiKey };
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

module.exports = {
  BASE_URL: BASE_URL,
  ORIGIN: ORIGIN,
  resolveNextUrl: resolveNextUrl,
  fetchHistoryPage: fetchHistoryPage,
  fetchHistory: fetchHistory,
  fetchTransaction: fetchTransaction,
};
