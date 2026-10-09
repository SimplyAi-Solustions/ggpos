/// <reference path="../pb_data/types.d.ts" />

/**
 * public_stock.pb.js - the stock feed the shop's website reads in the
 * browser (docs/api-contract-launch.md, section 6).
 *
 *   GET /api/public/stock?category=&q=&page=   (anyone)
 *   GET /api/public/stock/{sku}                (anyone)
 *   GET /api/public/categories                 (anyone)
 *
 * No auth and no writes. Like everything under `/api/public/`, rate limited
 * per client (1789821240_public_rate_limits.js), readable cross-origin by
 * https://ggentertainment.co.uk and https://www.ggentertainment.co.uk only,
 * and cached for a minute: public_api.pb.js does all three for the prefix.
 * Logic in lib/publicstock.js.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/public/stock?category=&q=&page=
// ---------------------------------------------------------------------
routerAdd("GET", "/api/public/stock", (e) => {
  const publicStock = require(`${__hooks}/lib/publicstock.js`);
  const url = e.request.url.query();
  const page = publicStock.listStock(e.app, e, {
    category: url.get("category"),
    q: url.get("q"),
    page: url.get("page"),
  });
  return e.json(200, page);
});

// ---------------------------------------------------------------------
// GET /api/public/stock/{sku}
// ---------------------------------------------------------------------
routerAdd("GET", "/api/public/stock/{sku}", (e) => {
  const publicStock = require(`${__hooks}/lib/publicstock.js`);
  const item = publicStock.oneItem(e.app, e, e.request.pathValue("sku"));
  if (!item) return e.json(404, { message: publicStock.SENTENCES.notFound });
  return e.json(200, item);
});

// ---------------------------------------------------------------------
// GET /api/public/categories
// ---------------------------------------------------------------------
routerAdd("GET", "/api/public/categories", (e) => {
  const publicStock = require(`${__hooks}/lib/publicstock.js`);
  const body = publicStock.categoriesResponse(e.app);
  return e.json(200, body);
});
