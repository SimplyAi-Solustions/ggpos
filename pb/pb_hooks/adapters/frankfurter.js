// Frankfurter (FX): docs/PLAN.md "Currency: GBP everywhere" - the ECB
// reference rate, fetched daily, base GBP. No key.
//   GET https://api.frankfurter.dev/v1/latest?base=GBP&symbols=EUR,USD
//
// Frankfurter's own response is "units of the quote currency per one GBP"
// (base=GBP, so {"EUR":1.1644} means £1 = €1.1644). Every money helper in
// packages/shared/src/money.ts (convertMinorToGbpPence and friends) wants
// the opposite convention - GBP per one unit of the foreign currency, the
// same "0.8606" docs/PLAN.md's own worked example uses for EUR - so every
// rate is inverted once, here, and nowhere else in this codebase.
"use strict";

var BASE_URL = "https://api.frankfurter.dev/v1/latest";

/**
 * @returns {{base:"GBP", quotes: Record<string, number>, date: string, fetchedAt: string}}
 *   quotes[code] is GBP per one unit of `code` (EUR, USD, ...).
 */
function fetchRates(symbols, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var codes = symbols && symbols.length ? symbols : ["EUR", "USD"];
  var url = BASE_URL + "?" + http.qs({ base: "GBP", symbols: codes.join(",") });
  var res = http.request({ url: url, method: "GET" }, transport);
  if (res.statusCode !== 200 || !res.json || !res.json.rates) {
    throw new Error("Frankfurter returned " + res.statusCode + " for " + url);
  }
  var quotes = {};
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    var native = Number(res.json.rates[code]);
    if (native > 0) quotes[code] = 1 / native;
  }
  return {
    base: "GBP",
    quotes: quotes,
    date: res.json.date || null,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchRates: fetchRates, BASE_URL: BASE_URL };
