// PriceCharting (retro prices): docs/PLAN.md "Card images and market
// prices" - the one paid feed in this build, $49/month "Legendary". Behind
// settings.api_keys.pricecharting being set at all (switched off otherwise
// - retro trade-in volume may not justify the subscription yet).
//   GET https://www.pricecharting.com/api/products?t=<key>&q=<query>
//   GET https://www.pricecharting.com/api/product?t=<key>&id=<id>
// Prices arrive as integer US cents ("1732" means $17.32) - never parsed as
// a float; packages/shared/src/money.ts's usdCentsToGbpPence takes the
// integer directly.
//
// PAL first, NTSC only when no PAL entry exists (PLAN.md): PriceCharting
// keys its "console" category separately per region ("pal-super-nintendo"
// vs "super-nintendo"), so the adapter searches the PAL category, and only
// falls back to the NTSC category when that search comes back empty.
//
// The category slugs below are PriceCharting's documented naming pattern
// (a "pal-" prefix on the NTSC console slug) applied to the platforms this
// shop stocks; nobody on this build has a PriceCharting key to confirm
// them against the live API, so pb/pb_hooks/adapters/fixtures/ carries a
// hand-written fixture instead of a recorded one (see
// pb/scripts/check-adapters.mjs) - flag any slug here that turns out wrong
// once a real key is available.
"use strict";

var BASE_URL = "https://www.pricecharting.com/api";

var CONSOLE_CATEGORIES = {
  gameboy_cart: { pal: "pal-gameboy", ntsc: "gameboy" },
  gameboy_box: { pal: "pal-gameboy", ntsc: "gameboy" },
  snes_pal_box: { pal: "pal-super-nintendo", ntsc: "super-nintendo" },
  n64_box: { pal: "pal-nintendo-64", ntsc: "nintendo-64" },
  megadrive_box: { pal: "pal-sega-genesis", ntsc: "sega-genesis" },
  ps1_case: { pal: "pal-playstation", ntsc: "playstation" },
  ps2_case: { pal: "pal-playstation-2", ntsc: "playstation-2" },
  gamecube_case: { pal: "pal-gamecube", ntsc: "gamecube" },
  switch_case: { pal: "nintendo-switch", ntsc: "nintendo-switch" },
};

function get(url, transport) {
  var http = require(__hooks + "/adapters/http.js");
  return http.request({ url: url, method: "GET" }, transport);
}

function categoriesFor(platformKey) {
  return CONSOLE_CATEGORIES[platformKey] || null;
}

/** The best product match in `category` for `title`, or null. */
function searchInCategory(apiKey, title, category, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var url = BASE_URL + "/products?" + http.qs({ t: apiKey, q: title + " " + category });
  var res = get(url, transport);
  if (res.statusCode !== 200 || !res.json || !Array.isArray(res.json.products) || !res.json.products.length) {
    return null;
  }
  var inCategory = res.json.products.filter(function (p) {
    return (p["console-name"] || "").toLowerCase() === category;
  });
  return inCategory[0] || res.json.products[0];
}

function fetchProduct(apiKey, id, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var url = BASE_URL + "/product?" + http.qs({ t: apiKey, id: id });
  var res = get(url, transport);
  if (res.statusCode !== 200 || !res.json || res.json.status !== "success") return null;
  return res.json;
}

/** `completeness` is our schema's loose | boxed | cib; PriceCharting has no separate "boxed" tier. */
function priceField(completeness) {
  if (completeness === "loose") return "loose-price";
  return "cib-price"; // "boxed" and "cib" both read the complete-in-box figure
}

/**
 * PAL first, NTSC only when PAL has no match (PLAN.md). Returns at most one
 * candidate: `source` says which category answered.
 */
function getPrices(apiKey, title, platformKey, completeness, transport) {
  if (!apiKey) return [];
  var categories = categoriesFor(platformKey);
  if (!categories) return [];

  var field = priceField(completeness);
  var fetchedAt = new Date().toISOString();

  var palProduct = searchInCategory(apiKey, title, categories.pal, transport);
  if (palProduct) {
    var palFull = fetchProduct(apiKey, palProduct.id, transport);
    if (palFull && palFull[field] != null) {
      return [
        {
          source: "pricecharting_pal",
          currency: "USD",
          // Integer US cents, exactly as PriceCharting returns them - never
          // strings here, unlike every decimal-string source elsewhere:
          // prices.pb.js routes this source through
          // packages/shared/src/money.ts's usdCentsToGbpPence(cents, rate),
          // which takes the integer directly (CLAUDE.md, "Pricing":
          // "PriceCharting's integer cents are divided by 100 before
          // conversion").
          low: palFull["loose-price"] != null ? palFull["loose-price"] : null,
          mid: null,
          market: palFull[field],
          trend: null,
          fetchedAt: fetchedAt,
          evidenceUrl: "https://www.pricecharting.com/game/" + encodeURIComponent(palProduct.id),
        },
      ];
    }
  }

  var ntscProduct = searchInCategory(apiKey, title, categories.ntsc, transport);
  if (ntscProduct) {
    var ntscFull = fetchProduct(apiKey, ntscProduct.id, transport);
    if (ntscFull && ntscFull[field] != null) {
      return [
        {
          source: "pricecharting_ntsc",
          currency: "USD",
          low: ntscFull["loose-price"] != null ? ntscFull["loose-price"] : null,
          mid: null,
          market: ntscFull[field],
          trend: null,
          fetchedAt: fetchedAt,
          evidenceUrl: "https://www.pricecharting.com/game/" + encodeURIComponent(ntscProduct.id),
        },
      ];
    }
  }

  return [];
}

module.exports = {
  getPrices: getPrices,
  categoriesFor: categoriesFor,
  priceField: priceField,
  CONSOLE_CATEGORIES: CONSOLE_CATEGORIES,
};
