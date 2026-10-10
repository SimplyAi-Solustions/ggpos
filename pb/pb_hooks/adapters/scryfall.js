// Scryfall (Magic: The Gathering): docs/PLAN.md "Card images and market
// prices". No key, but a real User-Agent is required (adapters/http.js
// always sends one) and Scryfall asks for at most 10 requests/second - a
// small pause runs between the handful of calls one request can make.
//   GET https://api.scryfall.com/cards/{set}/{collector_number}
//   GET https://api.scryfall.com/cards/search?q=...   (free text)
//   GET https://api.scryfall.com/sets                  (weekly sync)
"use strict";

var BASE_URL = "https://api.scryfall.com";

function get(url, transport) {
  var http = require(__hooks + "/adapters/http.js");
  return http.request({ url: url, method: "GET" }, transport);
}

function normalize(raw) {
  var images = raw.image_uris || (raw.card_faces && raw.card_faces[0] && raw.card_faces[0].image_uris) || {};
  return {
    number: raw.collector_number,
    name: raw.name,
    rarity: raw.rarity || "",
    type: raw.type_line || "",
    finishesAvailable: raw.finishes || [],
    setCode: raw.set,
    setName: raw.set_name,
    imageSmall: images.small || images.normal || "",
    imageLarge: images.normal || images.large || "",
    rehostImage: false,
    tcgplayerId: raw.tcgplayer_id != null ? String(raw.tcgplayer_id) : "",
    cardmarketId: raw.cardmarket_id != null ? String(raw.cardmarket_id) : "",
    externalIds: { scryfall: raw.id },
    prices: raw.prices || {},
  };
}

function search(query, transport) {
  var res = get(BASE_URL + "/cards/search?q=" + encodeURIComponent(query) + "&order=name", transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.data)) return [];
  return res.json.data.map(normalize);
}

function getBySetNumber(set, number, transport) {
  var res = get(
    BASE_URL + "/cards/" + encodeURIComponent(set.toLowerCase()) + "/" + encodeURIComponent(number),
    transport
  );
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

/** Every price a fresh card fetch carries, as decimal strings (never floats). */
function getPrices(card, finish, transport) {
  var full = getBySetNumber(card.setCode, card.number, transport);
  if (!full) return [];
  var prices = full.prices || {};
  // /foil/i alone would also match "nonfoil" (it contains "foil" as a
  // substring), which must read as non-foil.
  var foil = finish && /foil/i.test(finish) && !/non.?foil/i.test(finish);
  var eur = foil && prices.eur_foil != null ? prices.eur_foil : prices.eur;
  var usd = foil && prices.usd_foil != null ? prices.usd_foil : prices.usd;
  var fetchedAt = new Date().toISOString();
  var out = [];
  if (eur != null) {
    out.push({
      source: "cardmarket",
      currency: "EUR",
      low: null,
      mid: null,
      market: String(eur),
      trend: null,
      fetchedAt: fetchedAt,
      evidenceUrl: "",
    });
  }
  if (usd != null) {
    out.push({
      source: "tcgplayer",
      currency: "USD",
      low: null,
      mid: null,
      market: String(usd),
      trend: null,
      fetchedAt: fetchedAt,
      evidenceUrl: "",
    });
  }
  return out;
}

/** Every set Scryfall knows about, for the weekly card_sets sync cron. */
function listSets(transport) {
  var res = get(BASE_URL + "/sets", transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.data)) return [];
  return res.json.data.map(function (s) {
    return { code: s.code, name: s.name, total: s.card_count || null, externalIds: { scryfall: s.id } };
  });
}

module.exports = {
  search: search,
  getBySetNumber: getBySetNumber,
  getImage: getImage,
  getPrices: getPrices,
  listSets: listSets,
};
