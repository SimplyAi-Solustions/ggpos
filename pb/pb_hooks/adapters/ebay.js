// eBay Browse API: docs/PLAN.md "Card images and market prices" - "the
// first automated GBP source". No Marketplace Insights (sold data) access,
// so this reads live ebay.co.uk fixed-price listings and estimates a sold
// price from them:
//   POST https://api.ebay.com/identity/v1/oauth2/token   (client credentials)
//   GET  https://api.ebay.com/buy/browse/v1/item_summary/search
//       ?q=<query>&filter=itemLocationCountry:GB
//       header X-EBAY-C-MARKETPLACE-ID: EBAY_GB
//
// UK-located, GBP, fixed-price listings only; the adapter takes the median
// of the five lowest asking prices and applies a configurable
// asking-to-sold haircut because asking prices sit above what sells.
// Switched off entirely when settings.api_keys.ebay is not set (PLAN.md:
// "If eBay declines production access ... this source is switched off in
// settings").
//
// The haircut percent has exactly one home: settings.offer.ebayHaircutPct
// (the settings editor's own field, alongside bulkThreshold and friends in
// that same JSON blob), read here by haircutPctFromSettings(app) and
// falling back to DEFAULT_HAIRCUT_PCT when the key is absent. getPrices()
// itself still takes haircutPct as a plain argument rather than an app -
// every adapter here stays testable under plain Node with no PocketBase at
// all (pb/scripts/check-adapters.mjs) - so the one PocketBase-specific read
// lives in this one small function, and every caller uses it rather than
// reading settings.offer itself.
//
// `store` (adapters/statestore.js) caches the application token and, per
// PLAN.md ("Cached 24 hours per card"), the computed candidate itself,
// keyed by the caller's own cache key (typically `${cardId}:${finish}:${condition}`),
// so repeated "refresh prices" clicks inside a day do not burn eBay's
// 5,000-call daily limit on a query that will not have changed.
"use strict";

var TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
var SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
var DEFAULT_HAIRCUT_PCT = 15;
var CACHE_HOURS = 24;

function basicAuthHeader(clientId, clientSecret) {
  var base64 = require(__hooks + "/lib/base64.js");
  var plain = clientId + ":" + clientSecret;
  var bytes = [];
  for (var i = 0; i < plain.length; i++) bytes.push(plain.charCodeAt(i) & 0xff);
  return "Basic " + base64.encode(bytes);
}

function fetchToken(clientId, clientSecret, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var res = http.request(
    {
      url: TOKEN_URL,
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    },
    transport
  );
  if (res.statusCode !== 200 || !res.json || !res.json.access_token) {
    throw new Error("eBay OAuth token request failed: " + res.statusCode);
  }
  return res.json;
}

function getToken(store, clientId, clientSecret, transport) {
  var cached = store.get("ebay_oauth_token");
  if (cached && cached.access_token) return cached.access_token;
  var fresh = fetchToken(clientId, clientSecret, transport);
  var expiresAt = new Date(Date.now() + Math.max(0, (fresh.expires_in || 0) - 60) * 1000).toISOString();
  store.set("ebay_oauth_token", { access_token: fresh.access_token }, expiresAt);
  return fresh.access_token;
}

/**
 * settings.offer.ebayHaircutPct (an integer percent), the one home for this
 * figure - falls back to DEFAULT_HAIRCUT_PCT when the settings row does not
 * exist yet or the key is absent from it. PocketBase-only (needs `app`);
 * every caller in pb_hooks reads the haircut through this rather than
 * settings.offer itself, so there is exactly one place that knows the key.
 */
function haircutPctFromSettings(app) {
  try {
    var util = require(__hooks + "/lib/vaultutil.js");
    var settingsRow = util.settings(app);
    if (!settingsRow) return DEFAULT_HAIRCUT_PCT;
    var offer = util.jsonField(settingsRow, "offer", null);
    var value = offer && offer.ebayHaircutPct;
    return value === undefined || value === null ? DEFAULT_HAIRCUT_PCT : value;
  } catch (err) {
    return DEFAULT_HAIRCUT_PCT;
  }
}

/**
 * The median of the (up to) five lowest GBP, GB-located asking prices,
 * before and after the haircut. `listings` is [{ pricePence, currency,
 * country, url }]; everything else is filtered out first. Pure and
 * exported on its own so pb/scripts/check-adapters.mjs can assert the
 * maths without any network or OAuth involved.
 */
function medianAskingCandidate(listings, haircutPct) {
  var money = require(__hooks + "/lib/shared/money.js");
  var lowest = (listings || [])
    .filter(function (l) {
      return l && l.currency === "GBP" && l.country === "GB" && l.pricePence > 0;
    })
    .sort(function (a, b) {
      return a.pricePence - b.pricePence;
    })
    .slice(0, 5);
  if (!lowest.length) return null;

  var mid = Math.floor(lowest.length / 2);
  var medianPence, evidenceUrl;
  if (lowest.length % 2 === 1) {
    medianPence = lowest[mid].pricePence;
    evidenceUrl = lowest[mid].url || "";
  } else {
    // An even count's median is the average of the two middle listings, so
    // it is not literally any one of them - roundHalfUp is the house
    // rounding rule (CLAUDE.md, "Money"), not a bare Math.round. The lower
    // of the two middle listings is cited as evidence: it is the one that
    // most conservatively supports the computed figure.
    medianPence = money.roundHalfUp((lowest[mid - 1].pricePence + lowest[mid].pricePence) / 2);
    evidenceUrl = lowest[mid - 1].url || "";
  }

  var pct = haircutPct === undefined || haircutPct === null ? DEFAULT_HAIRCUT_PCT : haircutPct;
  var afterHaircutPence = money.applyPercent(medianPence, 100 - pct);

  return {
    medianPence: medianPence,
    afterHaircutPence: afterHaircutPence,
    sampleSize: lowest.length,
    evidenceUrl: evidenceUrl,
  };
}

/** One item_summary/search response's items, parsed into medianAskingCandidate()'s input shape. */
function parseListings(json) {
  var money = require(__hooks + "/lib/shared/money.js");
  var items = (json && json.itemSummaries) || [];
  return items.map(function (item) {
    var price = item.price || {};
    var minor = money.parseDecimalToMinor(String(price.value || "0"));
    return {
      pricePence: price.currency === "GBP" ? minor : null,
      currency: price.currency,
      country: item.itemLocation ? item.itemLocation.country : null,
      url: item.itemWebUrl || "",
    };
  }).map(function (l) {
    // parseDecimalToMinor can return null for an unparsable value; treat
    // that the same as "not GBP" so it is filtered out rather than sorted
    // as if it were free.
    if (l.pricePence === null) l.currency = null;
    return l;
  });
}

/**
 * `cacheKey` should be unique per card+finish+condition (or per retro title
 * + completeness). `query` is the search text the caller has already built
 * (name, set, number, finish and condition words - PLAN.md). `bypassCache`
 * is `POST .../refresh-prices`'s own "bypasses the price cache" contract
 * promise (docs/api-contract.md): a GET never sets it, so an ordinary price
 * check still respects the 24-hour window, but a deliberate refresh always
 * asks eBay again rather than replaying yesterday's cached read.
 */
function getPrices(store, apiKey, query, cacheKey, haircutPct, bypassCache, transport) {
  if (!apiKey || !apiKey.client_id || !apiKey.client_secret) return [];

  var cached = cacheKey && !bypassCache ? store.get("ebay_prices:" + cacheKey) : null;
  if (cached) return cached;

  var http = require(__hooks + "/adapters/http.js");
  var token = getToken(store, apiKey.client_id, apiKey.client_secret, transport);
  var url =
    SEARCH_URL +
    "?" +
    http.qs({
      q: query,
      filter: "itemLocationCountry:GB,buyingOptions:{FIXED_PRICE}",
      limit: "50",
    });
  var res = http.request(
    { url: url, method: "GET", headers: { Authorization: "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB" } },
    transport
  );
  if (res.statusCode !== 200 || !res.json) return [];

  var candidate = medianAskingCandidate(parseListings(res.json), haircutPct);
  var result = [];
  if (candidate) {
    // marketMinor/midMinor carry the GBP figure as an integer already in
    // pence - pricing_policy.js's fromAdapterCandidate takes it as-is,
    // rather than formatting it to a decimal string here only to re-parse
    // that same string a moment later, which risks nothing but a pointless
    // float round-trip on a value that was already exact.
    result = [
      {
        source: "ebay_uk_asking",
        currency: "GBP",
        low: null,
        mid: null,
        market: null,
        lowMinor: candidate.afterHaircutPence,
        midMinor: candidate.medianPence,
        marketMinor: candidate.afterHaircutPence,
        trend: null,
        fetchedAt: new Date().toISOString(),
        evidenceUrl: candidate.evidenceUrl,
      },
    ];
  }
  // Never cache an empty result: a query that happened to match nothing
  // this time (an unlucky search, or eBay having a slow moment) should not
  // be remembered as "no listings" for a full day.
  if (cacheKey && result.length) {
    store.set("ebay_prices:" + cacheKey, result, new Date(Date.now() + CACHE_HOURS * 3600000).toISOString());
  }
  return result;
}

module.exports = {
  getPrices: getPrices,
  medianAskingCandidate: medianAskingCandidate,
  parseListings: parseListings,
  getToken: getToken,
  haircutPctFromSettings: haircutPctFromSettings,
  DEFAULT_HAIRCUT_PCT: DEFAULT_HAIRCUT_PCT,
  CACHE_HOURS: CACHE_HOURS,
};
