/// <reference path="../pb_data/types.d.ts" />

/**
 * till_catalogue.pb.js - what the till's tiles show
 * (docs/api-contract-epos.md, section 4, "The till catalogue").
 *
 *   GET /api/vault/till/catalogue                     (staff)
 *   GET /api/vault/till/category/{id}/items?q=&page=  (staff)
 *   GET /api/vault/till/branch/{id}?q=&page=          (staff)
 *
 * One call loads the till: every active category in `sort` order, each with
 * its quick keys in `position` order and the product or stock line behind
 * each key expanded, so the counter can draw the rail and the tiles with no
 * further request (and the service worker can keep it for offline reading).
 * A category with a `filter` ({ kinds?, games? }) is dynamic: its tiles are
 * the in-stock stock lines that match, a page at a time, from the second
 * route.
 *
 * Since Phase 9 the catalogue also carries `branches`, the category tree's
 * visible top-level branches, and the third route browses one branch of the
 * tree (docs/api-contract-inventory.md, section 1.3).
 *
 * A key whose product is switched off is left out: the sale route would
 * refuse it. A stock line that has sold out keeps its key, with its quantity
 * and status, so the till can show it greyed rather than move the tiles
 * around.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/till/catalogue   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/catalogue",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const catalogue = require(`${__hooks}/lib/tillcatalogue.js`);

    let categories = [];
    try {
      categories = e.app.findRecordsByFilter("till_categories", "active = true", "sort,name", 0, 0);
    } catch (err) {
      categories = [];
    }
    const categoryIds = [];
    for (let i = 0; i < categories.length; i++) {
      if (categories[i]) categoryIds.push(categories[i].id);
    }

    let keys = [];
    if (categoryIds.length) {
      try {
        keys = e.app.findRecordsByFilter("till_keys", "category.active = true", "position,created", 0, 0);
      } catch (err) {
        keys = [];
      }
    }

    const productIds = [];
    const itemIds = [];
    for (let i = 0; i < keys.length; i++) {
      if (!keys[i]) continue;
      if (keys[i].getString("product")) productIds.push(keys[i].getString("product"));
      if (keys[i].getString("item")) itemIds.push(keys[i].getString("item"));
    }
    const products = catalogue.byIds(e.app, "till_products", productIds);
    const items = catalogue.byIds(e.app, "items", itemIds);
    const cardImages = catalogue.cardImages(e.app, items);

    const byCategory = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!key) continue;
      const out = { id: key.id, position: key.getInt("position"), label: key.getString("label") };
      const product = products[key.getString("product")];
      const item = items[key.getString("item")];
      if (product) {
        if (!product.getBool("active")) continue;
        out.product = catalogue.productShape(e.app, product);
      } else if (item) {
        out.item = catalogue.itemShape(e.app, item, cardImages);
      } else {
        // A key whose product or stock line is gone has nothing to sell.
        continue;
      }
      const categoryId = key.getString("category");
      if (!byCategory[categoryId]) byCategory[categoryId] = [];
      byCategory[categoryId].push(out);
    }

    const out = [];
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      if (!category) continue;
      out.push({
        id: category.id,
        name: category.getString("name"),
        sort: category.getInt("sort"),
        dynamic: catalogue.isDynamic(util.jsonField(category, "filter", null)),
        keys: byCategory[category.id] || [],
      });
    }

    // The category tree's visible top-level branches follow the quick-key
    // pages on the rail (docs/api-contract-inventory.md, section 1.3). The
    // rail still draws from the pages if the tree cannot be read.
    let branches = [];
    try {
      branches = catalogue.topBranches(e.app);
    } catch (err) {
      console.log(`[till_catalogue] could not read the category tree: ${err}`);
      branches = [];
    }

    return e.json(200, { categories: out, branches: branches });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/category/{id}/items?q=&page=   (staff)
//
// A dynamic category's stock: stock lines with something on the shelf
// (`qty > 0`, `in_stock`) of the filter's kinds and games, `q` matching the
// title, 40 a page, by title.
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/category/{id}/items",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const catalogue = require(`${__hooks}/lib/tillcatalogue.js`);

    const PER_PAGE = 40;

    let category = null;
    try {
      category = e.app.findRecordById("till_categories", e.request.pathValue("id"));
    } catch (err) {
      category = null;
    }
    if (!category || !category.getBool("active")) {
      throw e.notFoundError("That category is not on the till any more. Reload the till.", null);
    }
    const filter = util.jsonField(category, "filter", null);
    if (!catalogue.isDynamic(filter)) {
      throw e.badRequestError(
        `${category.getString("name")} has its own keys, not a stock list. Use the till catalogue.`,
        null
      );
    }

    const q = csvLib.queryParam(e, "q").slice(0, 100);
    const page = Math.max(1, util.asInt(csvLib.queryParam(e, "page"), 1));
    const query = catalogue.stockQuery(filter, q);

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "items",
        query.filter,
        "title,sku",
        PER_PAGE,
        (page - 1) * PER_PAGE,
        query.params
      );
    } catch (err) {
      rows = [];
    }
    let total = 0;
    try {
      total = e.app.countRecords("items", query.expression);
    } catch (err) {
      total = rows.length;
    }

    const items = [];
    const list = [];
    for (let i = 0; i < rows.length; i++) if (rows[i]) list.push(rows[i]);
    const byId = {};
    for (let i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    const cardImages = catalogue.cardImages(e.app, byId);
    for (let i = 0; i < list.length; i++) items.push(catalogue.itemShape(e.app, list[i], cardImages));

    return e.json(200, { items: items, page: page, per_page: PER_PAGE, total: total });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/branch/{id}?q=&page=   (staff)
//
// One branch of the category tree as the till browses it
// (docs/api-contract-inventory.md, section 1.3): its trail for the
// breadcrumb, its visible child branches as folder tiles, the active till
// products homed here and the stock on the shelf homed here, 40 a page. With
// `q`, products and stock anywhere beneath it that match by name, title or
// SKU, and no child branches. A branch that is missing or switched off (or
// beneath one that is) is 404.
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/branch/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const catalogue = require(`${__hooks}/lib/tillcatalogue.js`);

    const q = csvLib.queryParam(e, "q").slice(0, 100);
    const page = Math.max(1, util.asInt(csvLib.queryParam(e, "page"), 1));

    const view = catalogue.branchView(e.app, e.request.pathValue("id"), q, page);
    if (!view) throw e.notFoundError("That branch was not found.", null);
    return e.json(200, view);
  },
  $apis.requireAuth("staff")
);
