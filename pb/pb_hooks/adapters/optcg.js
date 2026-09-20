// OPTCG API (One Piece): docs/PLAN.md "Card images and market prices". No
// key. Images are cached locally rather than hotlinked (the plan calls
// this out the same way as YGOPRODeck's IP-ban risk), so every normalized
// card here comes back with `rehostImage: true` and imageSmall/imageLarge
// left blank until the caller re-hosts the bytes into `cards.image_file`.
//   GET https://optcgapi.com/api/sets/card/{OP01-001}/   - one card code,
//     as an array: the base printing plus any "(Parallel)" alt-art version.
//   GET https://optcgapi.com/api/allSets/                - every set, for
//     the weekly card_sets sync cron.
// `market_price` / `inventory_price` arrive as bare JSON numbers (USD, not
// strings): String(n) recovers the exact original decimal literal (the
// ECMAScript Number-to-string algorithm always produces the shortest
// string that round-trips), which is safer than multiplying the float
// directly - see packages/shared/src/money.ts's parseDecimalToMinor, which
// every value here is eventually run through.
"use strict";

var BASE_URL = "https://optcgapi.com/api";

function get(url, transport) {
  var http = require(__hooks + "/adapters/http.js");
  return http.request({ url: url, method: "GET" }, transport);
}

function isParallel(row) {
  return /\(parallel\)/i.test(row.card_name || "");
}

/** The base printing, or the parallel one when `finish` asks for it. */
function pickVariant(rows, finish) {
  if (!rows.length) return null;
  var wantsParallel = finish && /parallel|alt/i.test(finish);
  for (var i = 0; i < rows.length; i++) {
    if (isParallel(rows[i]) === !!wantsParallel) return rows[i];
  }
  return rows[0];
}

function normalize(row) {
  // The card's own code prefix ("OP01-001" gives "OP01"), not `set_id`
  // ("OP-01" - a differently punctuated value from the /allSets/ endpoint):
  // getBySetNumber() reconstructs "OP01-001" from set + number, so a
  // card_sets row keyed on "OP-01" could never be found by a later lookup
  // that resolves the set from the card's own code.
  var code = row.card_set_id || "";
  var dash = code.lastIndexOf("-");
  var setCodeFromCard = dash >= 0 ? code.slice(0, dash) : row.set_id || "";
  return {
    number: code,
    name: (row.card_name || "").replace(/\s*\(Parallel\)\s*$/i, ""),
    rarity: row.rarity || "",
    type: row.card_type || "",
    finishesAvailable: isParallel(row) ? ["parallel"] : ["normal"],
    setCode: setCodeFromCard,
    setName: row.set_name || "",
    imageSmall: "",
    imageLarge: "",
    rehostImage: true,
    imageUrlForRehost: row.card_image || "",
    tcgplayerId: "",
    cardmarketId: "",
    externalIds: { optcg: row.card_image_id || row.card_set_id },
    marketPriceUsd: row.market_price,
    inventoryPriceUsd: row.inventory_price,
  };
}

function fetchByCode(code, transport) {
  var res = get(BASE_URL + "/sets/card/" + encodeURIComponent(code) + "/", transport);
  if (res.statusCode !== 200 || !Array.isArray(res.json) || !res.json.length) return [];
  return res.json;
}

/** lookup.pb.js recognises this exact message and turns it into a 422 rather than a generic empty 200. */
var NEEDS_CODE_MESSAGE = "One Piece search needs a card code, for example OP01-001.";

function search(query, transport) {
  // OPTCG API has no free-text search endpoint; a query already shaped
  // like a card code ("OP01-001") is looked up directly, exactly like
  // getBySetNumber. A name-shaped query has no code-search to run at all,
  // so it is a 422, not a silent empty result staff would read as "no such
  // card" - registry.js already routes a plain name query away from a game
  // whose adapter cannot search it, so this is a defence for a query that
  // reaches here anyway.
  var code = (query || "").trim().toUpperCase();
  var dash = code.lastIndexOf("-");
  if (dash < 0) throw new Error(NEEDS_CODE_MESSAGE);
  var rows = fetchByCode(code, transport);
  return rows.map(normalize);
}

function getBySetNumber(set, number, transport) {
  var code = set.toUpperCase() + "-" + number.toUpperCase();
  var rows = fetchByCode(code, transport);
  var row = pickVariant(rows, null);
  if (!row) return null;
  var normalized = normalize(row);
  if (normalized.imageUrlForRehost) {
    var imgRes = get(normalized.imageUrlForRehost, transport);
    if (imgRes.statusCode === 200 && imgRes.body) {
      normalized.imageBytes = imgRes.body;
      normalized.imageFilename = "optcg-" + code + ".jpg";
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
    filename: "optcg-" + (card.number || "card") + ".jpg",
  };
}

/** market_price as fallback when Cardmarket has no match for this code (PLAN.md). */
function getPrices(card, finish, transport) {
  var row = card;
  if (row.marketPriceUsd === undefined) {
    var code = (card.setCode || "") + "-" + (card.number || "");
    var rows = fetchByCode(code, transport);
    row = pickVariant(rows, finish);
    if (row) row = normalize(row);
  }
  if (!row || row.marketPriceUsd == null) return [];
  return [
    {
      source: "tcgplayer",
      currency: "USD",
      low: row.inventoryPriceUsd != null ? String(row.inventoryPriceUsd) : null,
      mid: null,
      market: String(row.marketPriceUsd),
      trend: null,
      fetchedAt: new Date().toISOString(),
      evidenceUrl: "",
    },
  ];
}

/** Every set OPTCG knows about, for the weekly card_sets sync cron. */
function listSets(transport) {
  var res = get(BASE_URL + "/allSets/", transport);
  if (res.statusCode !== 200 || !Array.isArray(res.json)) return [];
  return res.json.map(function (s) {
    return { code: s.set_id, name: s.set_name, total: null, externalIds: {} };
  });
}

module.exports = {
  search: search,
  getBySetNumber: getBySetNumber,
  getImage: getImage,
  getPrices: getPrices,
  listSets: listSets,
  NEEDS_CODE_MESSAGE: NEEDS_CODE_MESSAGE,
};
