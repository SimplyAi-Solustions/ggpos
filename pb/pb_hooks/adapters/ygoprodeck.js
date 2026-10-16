// YGOPRODeck (Yu-Gi-Oh!): docs/PLAN.md "Card images and market prices".
// No key, 20 req/s. Images **must be re-hosted**: hotlinking YGOPRODeck's
// CDN gets IPs banned, so every normalized card here comes back with
// `rehostImage: true` and imageSmall/imageLarge left blank - the caller
// (adapters/storage.js, via lookup.pb.js) must store the bytes into
// `cards.image_file` before anything is shown, never the bare URL.
//   GET https://db.ygoprodeck.com/api/v7/cardinfo.php?id=<passcode>
//   GET https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=<query>   (search)
//   GET https://db.ygoprodeck.com/api/v7/cardsetsinfo.php?setcode=<SET-NUM>
//     resolves one specific printing (its passcode, set name, rarity, and
//     that printing's own USD set_price) from a "set number" query such as
//     "CT13-EN003" - cardinfo.php has no way to look up by set code alone.
"use strict";

var BASE_URL = "https://db.ygoprodeck.com/api/v7";

function get(url, transport) {
  var http = require(__hooks + "/adapters/http.js");
  return http.request({ url: url, method: "GET" }, transport);
}

function fetchById(id, transport) {
  var res = get(BASE_URL + "/cardinfo.php?id=" + encodeURIComponent(id), transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.data) || !res.json.data[0]) {
    return null;
  }
  return res.json.data[0];
}

/** The first card_sets[] entry matching `setCode` exactly, or null. */
function findPrinting(raw, setCode) {
  var sets = raw.card_sets || [];
  for (var i = 0; i < sets.length; i++) {
    if (sets[i].set_code === setCode) return sets[i];
  }
  return null;
}

function normalize(raw, printing) {
  var images = raw.card_images && raw.card_images[0] ? raw.card_images[0] : {};
  var prices = raw.card_prices && raw.card_prices[0] ? raw.card_prices[0] : {};
  var setCode = printing ? printing.set_code : "";
  var dash = setCode.lastIndexOf("-");
  return {
    number: dash >= 0 ? setCode.slice(dash + 1) : String(raw.id),
    name: raw.name,
    rarity: printing ? printing.set_rarity || "" : "",
    type: raw.type || "",
    finishesAvailable: [],
    setCode: dash >= 0 ? setCode.slice(0, dash) : "",
    setName: printing ? printing.set_name || "" : "",
    imageSmall: "",
    imageLarge: "",
    rehostImage: true,
    imageUrlForRehost: images.image_url || "",
    tcgplayerId: "",
    cardmarketId: "",
    externalIds: { ygoprodeck: String(raw.id) },
    // Kept for getPrices(): card_prices (overall) and this printing's own
    // set_price (a specific printing's USD asking price, PLAN.md).
    cardPrices: prices,
    printingPriceUsd: printing ? printing.set_price : null,
  };
}

/**
 * One row per *printing* (a passcode can have dozens, each in its own
 * set), not one row per card: a card has no set code of its own in
 * YGOPRODeck's shape, only its printings do (`card_sets[]`), and writing a
 * row through with a blank `setCode` fails `card_sets`'s required
 * validation with a generic 400. `number` is deliberately the full
 * printing code ("CT13-EN003"), not just the suffix, so each row a search
 * returns stays distinct and directly recognisable; `setCode` is that same
 * code's own prefix, up to its last hyphen. A printing whose own code has
 * no hyphen to split on is skipped (nothing to key a set on), same as
 * tcgdex.js's search() below.
 */
function search(query, transport) {
  var res = get(BASE_URL + "/cardinfo.php?fname=" + encodeURIComponent(query), transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.data)) return [];
  var rows = [];
  for (var i = 0; i < res.json.data.length; i++) {
    var raw = res.json.data[i];
    var images = raw.card_images && raw.card_images[0] ? raw.card_images[0] : {};
    var sets = raw.card_sets || [];
    for (var j = 0; j < sets.length; j++) {
      var printingCode = sets[j].set_code || "";
      var dash = printingCode.lastIndexOf("-");
      if (dash < 0) {
        console.log("[ygoprodeck] search: skipping a printing with no hyphen in its set code: " + printingCode);
        continue;
      }
      rows.push({
        number: printingCode,
        name: raw.name,
        rarity: sets[j].set_rarity || "",
        type: raw.type || "",
        finishesAvailable: [],
        setCode: printingCode.slice(0, dash),
        setName: sets[j].set_name || "",
        // Search is a lightweight discovery listing: a hotlink-banned image
        // is never written to `cards`, so it is left out here rather than
        // risking it reaching a screen before an exact lookup re-hosts it
        // properly.
        imageSmall: "",
        imageLarge: "",
        rehostImage: true,
        imageUrlForRehost: images.image_url || "",
        tcgplayerId: "",
        cardmarketId: "",
        externalIds: { ygoprodeck: String(raw.id) },
      });
    }
  }
  return rows;
}

/** `set` + `number` are the two halves of a set code, e.g. "CT13" + "EN003". */
function getBySetNumber(set, number, transport) {
  var setCode = set + "-" + number;
  var http = require(__hooks + "/adapters/http.js");
  var lookup = get(BASE_URL + "/cardsetsinfo.php?setcode=" + encodeURIComponent(setCode), transport);
  if (lookup.statusCode !== 200 || !lookup.json || !lookup.json.id) return null;
  http.pause(50);
  var raw = fetchById(lookup.json.id, transport);
  if (!raw) return null;
  var printing = findPrinting(raw, setCode) || {
    set_code: setCode,
    set_name: lookup.json.set_name,
    set_rarity: lookup.json.set_rarity,
    set_price: lookup.json.set_price,
  };
  var normalized = normalize(raw, printing);

  // Re-host right away: this is the exact-match path lookup.pb.js writes
  // straight through to `cards`, so the bare YGOPRODeck URL must never be
  // the value that lands in image_small/image_large.
  if (normalized.imageUrlForRehost) {
    var imgRes = get(normalized.imageUrlForRehost, transport);
    if (imgRes.statusCode === 200 && imgRes.body) {
      normalized.imageBytes = imgRes.body;
      normalized.imageFilename = "ygo-" + raw.id + ".jpg";
    }
  }
  return normalized;
}

function getImage(card, transport) {
  var url = card && (card.imageUrlForRehost || card.imageLarge);
  if (!url) return { small: "", large: "", rehost: true };
  var res = get(url, transport);
  if (res.statusCode !== 200 || !res.body) return { small: "", large: "", rehost: true };
  return {
    small: "",
    large: "",
    rehost: true,
    bytes: res.body,
    filename: "ygo-" + (card.externalIds && card.externalIds.ygoprodeck ? card.externalIds.ygoprodeck : "card") + ".jpg",
  };
}

/** cardmarket_price (EUR) and tcgplayer_price (USD) off card_prices, plus this printing's own USD set_price when known. */
function getPrices(card, finish, transport) {
  var raw = card.cardPrices
    ? card
    : (function () {
        var setCode = card.setCode ? card.setCode + "-" + card.number : "";
        return setCode ? getBySetNumber(card.setCode, card.number, transport) : null;
      })();
  if (!raw) return [];
  var fetchedAt = new Date().toISOString();
  var out = [];
  var prices = raw.cardPrices || {};
  if (prices.cardmarket_price != null) {
    out.push({
      source: "cardmarket",
      currency: "EUR",
      low: null,
      mid: null,
      market: String(prices.cardmarket_price),
      trend: null,
      fetchedAt: fetchedAt,
      evidenceUrl: "",
    });
  }
  var tcgplayerAmount = raw.printingPriceUsd != null ? raw.printingPriceUsd : prices.tcgplayer_price;
  if (tcgplayerAmount != null) {
    out.push({
      source: "tcgplayer",
      currency: "USD",
      low: null,
      mid: null,
      market: String(tcgplayerAmount),
      trend: null,
      fetchedAt: fetchedAt,
      evidenceUrl: "",
    });
  }
  return out;
}

module.exports = {
  search: search,
  getBySetNumber: getBySetNumber,
  getImage: getImage,
  getPrices: getPrices,
};
