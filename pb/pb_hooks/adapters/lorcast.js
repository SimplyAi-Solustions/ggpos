// Lorcast (Disney Lorcana): docs/PLAN.md "Card images and market prices".
// No key, AVIF images, under 10 requests/second, prices cached 24 hours -
// adapters/http.js's pause() runs a small gap between the handful of calls
// one request can make.
//   GET https://api.lorcast.com/v0/cards/{set}/{number}
//   GET https://api.lorcast.com/v0/cards/search?q=...     (free text)
//   GET https://api.lorcast.com/v0/sets                    (weekly sync)
// Cardmarket's EUR figure for Lorcana comes from the nightly Cardmarket
// file 19 in services/pricesync, not from this adapter - Lorcast itself
// only carries TCGplayer's usd / usd_foil.
"use strict";

var BASE_URL = "https://api.lorcast.com/v0";

function get(url, transport) {
  var http = require(__hooks + "/adapters/http.js");
  return http.request({ url: url, method: "GET" }, transport);
}

function normalize(raw) {
  var images = (raw.image_uris && raw.image_uris.digital) || {};
  var set = raw.set || {};
  return {
    number: raw.collector_number,
    name: raw.version ? raw.name + " - " + raw.version : raw.name,
    rarity: raw.rarity || "",
    type: (raw.type && raw.type[0]) || "",
    finishesAvailable: raw.prices && raw.prices.usd_foil != null ? ["normal", "foil"] : ["normal"],
    setCode: set.code || "",
    setName: set.name || "",
    imageSmall: images.small || images.normal || "",
    imageLarge: images.large || images.normal || "",
    rehostImage: false,
    tcgplayerId: raw.tcgplayer_id != null ? String(raw.tcgplayer_id) : "",
    cardmarketId: "",
    externalIds: { lorcast: raw.id },
    prices: raw.prices || {},
  };
}

function search(query, transport) {
  var res = get(BASE_URL + "/cards/search?q=" + encodeURIComponent(query), transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.results)) return [];
  return res.json.results.map(normalize);
}

function getBySetNumber(set, number, transport) {
  var res = get(BASE_URL + "/cards/" + encodeURIComponent(set) + "/" + encodeURIComponent(number), transport);
  if (res.statusCode !== 200 || !res.json || !res.json.id) return null;
  return normalize(res.json);
}

function getImage(card, transport) {
  if (card && card.imageLarge) {
    return { small: card.imageSmall || card.imageLarge, large: card.imageLarge, rehost: false };
  }
  if (card && card.setCode && card.number) {
    var full = getBySetNumber(card.setCode, card.number, transport);
    if (full) return { small: full.imageSmall, large: full.imageLarge, rehost: false };
  }
  return { small: "", large: "", rehost: false };
}

function getPrices(card, finish, transport) {
  var full = getBySetNumber(card.setCode, card.number, transport);
  if (!full) return [];
  var prices = full.prices || {};
  // /foil/i alone would also match "nonfoil" (it contains "foil" as a
  // substring), which must read as non-foil.
  var foil = finish && /foil/i.test(finish) && !/non.?foil/i.test(finish);
  var usd = foil && prices.usd_foil != null ? prices.usd_foil : prices.usd;
  if (usd == null) return [];
  return [
    {
      source: "tcgplayer",
      currency: "USD",
      low: null,
      mid: null,
      market: String(usd),
      trend: null,
      fetchedAt: new Date().toISOString(),
      evidenceUrl: "",
    },
  ];
}

/** Every set Lorcast knows about, for the weekly card_sets sync cron. */
function listSets(transport) {
  var res = get(BASE_URL + "/sets", transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.results)) return [];
  return res.json.results.map(function (s) {
    return { code: s.code, name: s.name, total: null, externalIds: { lorcast: s.id } };
  });
}

module.exports = {
  search: search,
  getBySetNumber: getBySetNumber,
  getImage: getImage,
  getPrices: getPrices,
  listSets: listSets,
};
