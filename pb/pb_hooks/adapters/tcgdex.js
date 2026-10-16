// TCGdex (Pokemon): docs/PLAN.md "Card images and market prices".
//   GET https://api.tcgdex.net/v2/en/sets/{setId}/{localId}  - one card, with
//     pricing.cardmarket (EUR) and pricing.tcgplayer (USD) embedded.
//   GET https://api.tcgdex.net/v2/en/cards?name={query}      - free-text
//     search, a compact {id, localId, name, image?} per row (no key, MIT).
//   GET https://api.tcgdex.net/v2/en/sets                    - every set,
//     for the weekly card_sets sync (crons.pb.js).
// No key, no documented rate limit beyond "be reasonable" - a small pause
// still runs between the handful of calls one request can make.
"use strict";

var BASE_URL = "https://api.tcgdex.net/v2/en";

function get(url, transport) {
  var http = require(__hooks + "/adapters/http.js");
  return http.request({ url: url, method: "GET" }, transport);
}

/** TCGdex ids are "{setId}-{localId}"; split on the LAST hyphen. */
function splitId(id) {
  var at = id.lastIndexOf("-");
  if (at < 0) return { setId: "", localId: id };
  return { setId: id.slice(0, at), localId: id.slice(at + 1) };
}

function finishesFromVariants(variants) {
  if (!variants) return [];
  var out = [];
  var keys = ["normal", "reverse", "holo", "firstEdition", "wPromo"];
  for (var i = 0; i < keys.length; i++) {
    if (variants[keys[i]]) out.push(keys[i]);
  }
  return out;
}

/** The TCGplayer sub-object keyed for the requested finish, or the first one available. */
function pickTcgplayerFinish(tcgplayer, finish) {
  if (!tcgplayer) return null;
  var alias = {
    holo: "holofoil",
    holofoil: "holofoil",
    reverse: "reverseHolofoil",
    normal: "normal",
    firstEdition: "1stEditionHolofoil",
  };
  var key = alias[finish] || finish;
  if (key && tcgplayer[key]) return tcgplayer[key];
  var fallbackKeys = Object.keys(tcgplayer).filter(function (k) {
    return k !== "unit" && k !== "updated" && tcgplayer[k] && typeof tcgplayer[k] === "object";
  });
  return fallbackKeys.length ? tcgplayer[fallbackKeys[0]] : null;
}

/** One full card detail fetch, used by both getBySetNumber() and getPrices(). */
function fetchDetail(setId, number, transport) {
  var res = get(BASE_URL + "/sets/" + encodeURIComponent(setId) + "/" + encodeURIComponent(number), transport);
  if (res.statusCode !== 200 || !res.json || !res.json.id) return null;
  return res.json;
}

function normalize(raw) {
  var set = raw.set || {};
  return {
    number: raw.localId,
    name: raw.name,
    rarity: raw.rarity || "",
    type: (raw.types && raw.types[0]) || "",
    finishesAvailable: finishesFromVariants(raw.variants),
    setCode: set.id || "",
    setName: set.name || "",
    imageSmall: raw.image ? raw.image + "/low.webp" : "",
    imageLarge: raw.image ? raw.image + "/high.webp" : "",
    rehostImage: false,
    tcgplayerId:
      raw.pricing && raw.pricing.tcgplayer && raw.pricing.tcgplayer.holofoil
        ? String(raw.pricing.tcgplayer.holofoil.productId || "")
        : "",
    cardmarketId:
      raw.pricing && raw.pricing.cardmarket ? String(raw.pricing.cardmarket.idProduct || "") : "",
    externalIds: { tcgdex: raw.id },
  };
}

function search(query, transport) {
  var res = get(BASE_URL + "/cards?name=" + encodeURIComponent(query), transport);
  if (res.statusCode !== 200 || !Array.isArray(res.json)) return [];
  var rows = [];
  for (var i = 0; i < res.json.length; i++) {
    var row = res.json[i];
    var ids = splitId(row.id);
    if (!ids.setId) {
      console.log("[tcgdex] search: skipping an id with no hyphen to split a set from: " + row.id);
      continue;
    }
    rows.push({
      number: row.localId || ids.localId,
      name: row.name,
      rarity: "",
      type: "",
      finishesAvailable: [],
      setCode: ids.setId,
      setName: "",
      imageSmall: row.image ? row.image + "/low.webp" : "",
      imageLarge: row.image ? row.image + "/high.webp" : "",
      rehostImage: false,
      tcgplayerId: "",
      cardmarketId: "",
      externalIds: { tcgdex: row.id },
    });
  }
  return rows;
}

function getBySetNumber(setId, number, transport) {
  var raw = fetchDetail(setId, number, transport);
  return raw ? normalize(raw) : null;
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
  var raw = fetchDetail(card.setCode, card.number, transport);
  if (!raw || !raw.pricing) return [];
  var out = [];

  // Every price below is handed back as a decimal *string*, never a float:
  // the caller (prices.pb.js) runs it through packages/shared/src/money.ts's
  // eurDecimalToGbpPence/parseDecimalToMinor, which parse strings so no
  // float ever represents a price (CLAUDE.md, "Pricing"; docs/PLAN.md,
  // "Currency: GBP everywhere").
  var cm = raw.pricing.cardmarket;
  // TCGdex carries a second set of Cardmarket fields for the holo variant
  // ("avg-holo", "low-holo", ...) alongside the plain ones; a holo or
  // reverse-holo card reads from those when Cardmarket actually has them
  // (a holo-only print's plain fields are usually null), rather than
  // silently pricing it as if it were the non-holo print.
  var wantsHolo = finish === "holo" || finish === "reverse";
  var holoAvg = cm ? cm["avg-holo"] : null;
  var cmAvg = wantsHolo && holoAvg != null ? holoAvg : cm ? cm.avg : null;
  var cmLow = wantsHolo && cm && cm["low-holo"] != null ? cm["low-holo"] : cm ? cm.low : null;
  var cmAvg7 = wantsHolo && cm && cm["avg7-holo"] != null ? cm["avg7-holo"] : cm ? cm.avg7 : null;
  var cmTrend = wantsHolo && cm && cm["trend-holo"] != null ? cm["trend-holo"] : cm ? cm.trend : null;
  if (cm && (cmAvg || cmLow)) {
    out.push({
      source: "cardmarket",
      currency: "EUR",
      low: cmLow != null ? String(cmLow) : null,
      mid: cmAvg7 != null ? String(cmAvg7) : cmAvg != null ? String(cmAvg) : null,
      market: cmAvg != null ? String(cmAvg) : null,
      trend: cmTrend != null ? String(cmTrend) : null,
      fetchedAt: cm.updated || new Date().toISOString(),
      evidenceUrl: "",
    });
  }

  var tp = pickTcgplayerFinish(raw.pricing.tcgplayer, finish);
  if (tp) {
    out.push({
      source: "tcgplayer",
      currency: "USD",
      low: tp.lowPrice != null ? String(tp.lowPrice) : null,
      mid: tp.midPrice != null ? String(tp.midPrice) : null,
      market: tp.marketPrice != null ? String(tp.marketPrice) : null,
      trend: null,
      fetchedAt: raw.pricing.tcgplayer.updated || new Date().toISOString(),
      evidenceUrl: "",
    });
  }

  return out;
}

/** Every set TCGdex knows about, for the weekly card_sets sync cron. */
function listSets(transport) {
  var res = get(BASE_URL + "/sets", transport);
  if (res.statusCode !== 200 || !Array.isArray(res.json)) return [];
  return res.json.map(function (s) {
    return {
      code: s.id,
      name: s.name,
      total: (s.cardCount && (s.cardCount.official || s.cardCount.total)) || null,
      externalIds: {},
    };
  });
}

module.exports = {
  search: search,
  getBySetNumber: getBySetNumber,
  getImage: getImage,
  getPrices: getPrices,
  listSets: listSets,
};
