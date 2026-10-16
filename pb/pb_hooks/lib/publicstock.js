/**
 * The public stock feed (docs/api-contract-launch.md, section 6;
 * docs/EPOS-PLAN.md, decision 13), behind the three routes in
 * public_stock.pb.js that the shop's website reads in the browser:
 *
 *   GET /api/public/stock?category=&q=&page=   24 a page, newest first
 *   GET /api/public/stock/{sku}                one item, with its photos
 *   GET /api/public/categories                 visible branches with counts
 *
 * Which items show is the shared rule (lib/shared/online.js): marked
 * `show_online`, `in_stock` with some on the shelf, at or over
 * `settings.online.min_price`, and the whole feed switched on. Sold and
 * reserved stock leaves at once because every answer is read live.
 *
 * Every answer is built field by field from the shapes in
 * packages/shared/src/online.ts and nothing else, so a cost, a supplier,
 * a customer, a location or a note can never reach the website, whatever is
 * added to `items` later.
 *
 * The headers (CORS, caching) are the whole prefix's, in public_api.pb.js.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var SENTENCES = {
  notFound: "That item is not on sale online. It may have just sold.",
};

/** The page the feed stops at: 24 x 500 is more stock than the shop holds. */
var PAGE_MAX = 500;

/** Words in a search; the rest are ignored. */
var WORDS_MAX = 6;

/** The `?thumb=` size the feed's `small` asks for (items.photos' thumbs). */
var PHOTO_THUMB = "640x0";

/** The platform a stock row is framed in when nothing more specific says (apps/web item-shape.ts). */
var KIND_PLATFORM = {
  single: "tcg_card",
  graded: "graded_slab",
  sealed: "etb",
};

function shared() {
  return require(__hooks + "/lib/shared/online.js");
}

function util() {
  return require(__hooks + "/lib/vaultutil.js");
}

/** `settings.online`, made whole. */
function onlineSettings(app) {
  var u = util();
  var row = u.settings(app);
  return shared().readOnlineSettings(row ? u.jsonField(row, "online", null) : null);
}

// ---------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------

/**
 * This instance's own address, for the absolute image URLs another site
 * needs: the application URL deploy/bootstrap.sh sets, else the address the
 * request came in on.
 */
function baseUrl(app, e) {
  var configured = "";
  try {
    configured = String(app.settings().meta.appURL || "");
  } catch (err) {
    configured = "";
  }
  if (configured) return configured.replace(/\/+$/, "");
  var proto = "";
  var host = "";
  try {
    proto = String(e.request.header.get("X-Forwarded-Proto") || "");
    host = String(e.request.host || "");
  } catch (err) {
    host = "";
  }
  return host ? (proto || "http") + "://" + host : "";
}

/** A stored URL made absolute: a path on this server gets the base, an http(s) URL stays. */
function absolute(base, url) {
  var value = String(url || "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.charAt(0) === "/") return base + value;
  return "";
}

/** The file names in a multi-file field, in their stored order. */
function filesOf(record, field) {
  try {
    var names = record.getStringSlice(field);
    var out = [];
    for (var i = 0; i < names.length; i++) if (names[i]) out.push(String(names[i]));
    return out;
  } catch (err) {
    return [];
  }
}

function fileUrl(base, record, name) {
  return base + "/api/files/" + record.baseFilesPath() + "/" + name;
}

// ---------------------------------------------------------------------
// The lookups one page shares
// ---------------------------------------------------------------------

/** `{ [id]: record }` for a list of ids in one query; missing ids are skipped. */
function byIds(app, collection, ids) {
  var unique = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] && !seen[ids[i]]) {
      seen[ids[i]] = true;
      unique.push(ids[i]);
    }
  }
  var out = {};
  if (!unique.length) return out;
  var records = app.findRecordsByIds(collection, unique);
  for (var j = 0; j < records.length; j++) if (records[j]) out[records[j].id] = records[j];
  return out;
}

/** Everything the item shapes on one page need, fetched once. */
function lookups(app, items) {
  var games = [];
  var categories = [];
  var cards = [];
  var retro = [];
  for (var i = 0; i < items.length; i++) {
    games.push(items[i].getString("game"));
    categories.push(items[i].getString("category"));
    cards.push(items[i].getString("card"));
    retro.push(items[i].getString("retro_title"));
  }
  var platformsById = {};
  var platformsByKey = {};
  var platforms = app.findRecordsByFilter("platforms", "id != ''", "", 0, 0);
  for (var p = 0; p < platforms.length; p++) {
    if (!platforms[p]) continue;
    platformsById[platforms[p].id] = platforms[p];
    platformsByKey[platforms[p].getString("key")] = platforms[p];
  }
  return {
    games: byIds(app, "games", games),
    categories: byIds(app, "categories", categories),
    cards: byIds(app, "cards", cards),
    retro: byIds(app, "retro_titles", retro),
    platformsById: platformsById,
    platformsByKey: platformsByKey,
  };
}

/** The frame an item's picture sits in, width over height. */
function ratioFor(item, ctx) {
  var platform = null;
  var retro = ctx.retro[item.getString("retro_title")];
  if (retro) platform = ctx.platformsById[retro.getString("platform")] || null;
  if (!platform) platform = ctx.platformsByKey[KIND_PLATFORM[item.getString("kind")] || "other"] || null;
  if (!platform) return 0.75;
  return shared().ratioOf(platform.getInt("aspect_w"), platform.getInt("aspect_h"));
}

/** Every photo as `{ small, large }`, first first. */
function photosOf(base, item) {
  var names = filesOf(item, "photos");
  var out = [];
  for (var i = 0; i < names.length; i++) {
    var large = fileUrl(base, item, names[i]);
    out.push({ small: large + "?thumb=" + PHOTO_THUMB, large: large });
  }
  return out;
}

/** The first photo, else the catalogue's image: the card's, or the retro title's cover. */
function imageOf(base, item, ctx) {
  var ratio = ratioFor(item, ctx);
  var photos = photosOf(base, item);
  if (photos.length) return { small: photos[0].small, large: photos[0].large, ratio: ratio };

  var card = ctx.cards[item.getString("card")];
  if (card) {
    var small = absolute(base, card.getString("image_small"));
    var large = absolute(base, card.getString("image_large"));
    var file = card.getString("image_file");
    if (!small && !large && file) small = large = fileUrl(base, card, file);
    if (small || large) return { small: small || large, large: large || small, ratio: ratio };
  }

  var retro = ctx.retro[item.getString("retro_title")];
  if (retro && retro.getString("cover")) {
    var cover = fileUrl(base, retro, retro.getString("cover"));
    return { small: cover, large: cover, ratio: ratio };
  }
  return { small: "", large: "", ratio: ratio };
}

/** PocketBase's "2026-10-09 20:28:24.123Z" as ISO 8601, which every browser parses. */
function isoDate(value) {
  var text = String(value || "");
  return text ? text.replace(" ", "T") : "";
}

/**
 * One item as the website sees it (PublicStockItem). Built key by key: this
 * is the whole of what leaves the shop.
 */
function itemShape(base, item, ctx, settings) {
  var s = shared();
  var card = ctx.cards[item.getString("card")];
  var game = ctx.games[item.getString("game")];
  var branch = ctx.categories[item.getString("category")];
  var out = {
    sku: item.getString("sku"),
    title: item.getString("title") || (card ? card.getString("name") : "") || item.getString("sku"),
    price: item.getInt("price"),
    condition: s.conditionLabel({
      kind: item.getString("kind"),
      condition: item.getString("condition"),
      completeness: item.getString("completeness"),
      grade_company: item.getString("grade_company"),
      grade: item.getString("grade"),
    }),
    finish: item.getString("finish"),
    game: game ? game.getString("name") : "",
    category: branch ? { id: branch.id, path: branch.getString("path") || branch.getString("name") } : null,
    image: imageOf(base, item, ctx),
  };
  if (!settings.hide_qty) out.qty = item.getInt("qty");
  out.updated = isoDate(item.getString("updated"));
  return out;
}

// ---------------------------------------------------------------------
// GET /api/public/stock
// ---------------------------------------------------------------------

/** `%`, `_` and `\` matched as themselves in a LIKE with ESCAPE '\'. */
function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, function (ch) {
    return "\\" + ch;
  });
}

/** The query's words, at most WORDS_MAX, each cut to the feed's limit. */
function wordsOf(q) {
  var text = String(q || "").trim().slice(0, shared().PUBLIC_SEARCH_MAX);
  if (!text) return [];
  var parts = text.split(/\s+/);
  var out = [];
  for (var i = 0; i < parts.length && out.length < WORDS_MAX; i++) if (parts[i]) out.push(parts[i]);
  return out;
}

/**
 * The WHERE clause and its bound values for the online items, narrowed to a
 * branch's subtree and to every search word (each word in the title, the
 * code, the set or the number).
 */
function onlineWhere(settings, category, words) {
  var clauses = [
    "i.show_online = 1",
    "i.status = 'in_stock'",
    "i.qty > 0",
    "i.price >= {:min}",
  ];
  var params = { min: settings.min_price };
  if (category) {
    clauses.push("c.lineage LIKE {:lineage} ESCAPE '\\'");
    params.lineage = "%|" + likeEscape(category) + "|%";
  }
  for (var i = 0; i < words.length; i++) {
    var key = "w" + i;
    clauses.push(
      "(i.title LIKE {:" + key + "} ESCAPE '\\' OR i.sku LIKE {:" + key + "} ESCAPE '\\'" +
        " OR i.set_code LIKE {:" + key + "} ESCAPE '\\' OR i.number LIKE {:" + key + "} ESCAPE '\\')"
    );
    params[key] = "%" + likeEscape(words[i]) + "%";
  }
  return { sql: clauses.join(" AND "), params: params };
}

var FROM = " FROM items i LEFT JOIN categories c ON c.id = i.category WHERE ";

/** `{ items, page, per_page, total }` for one page of the feed. */
function listStock(app, e, query) {
  var s = shared();
  var u = util();
  var settings = onlineSettings(app);
  var perPage = s.PUBLIC_STOCK_PER_PAGE;
  var page = Math.min(PAGE_MAX, Math.max(1, u.asInt(query.page, 1)));
  if (!settings.enabled) return { items: [], page: page, per_page: perPage, total: 0 };

  var where = onlineWhere(settings, u.asStr(query.category), wordsOf(query.q));

  var counted = new DynamicModel({ n: 0 });
  app.db().newQuery("SELECT COUNT(*) AS n" + FROM + where.sql).bind(where.params).one(counted);
  var total = Number(counted.n) || 0;

  var rows = arrayOf(new DynamicModel({ id: "" }));
  var params = where.params;
  params.limit = perPage;
  params.offset = (page - 1) * perPage;
  app
    .db()
    .newQuery(
      "SELECT i.id AS id" + FROM + where.sql + " ORDER BY i.created DESC, i.id DESC LIMIT {:limit} OFFSET {:offset}"
    )
    .bind(params)
    .all(rows);

  var ids = [];
  for (var i = 0; i < rows.length; i++) ids.push(rows[i].id);
  var found = byIds(app, "items", ids);
  var records = [];
  for (var j = 0; j < ids.length; j++) if (found[ids[j]]) records.push(found[ids[j]]);

  var ctx = lookups(app, records);
  var base = baseUrl(app, e);
  var items = [];
  for (var k = 0; k < records.length; k++) items.push(itemShape(base, records[k], ctx, settings));
  return { items: items, page: page, per_page: perPage, total: total };
}

// ---------------------------------------------------------------------
// GET /api/public/stock/{sku}
// ---------------------------------------------------------------------

/** One item with every photo (PublicStockDetail), or null when it is not online. */
function oneItem(app, e, sku) {
  var code = String(sku || "").trim().toUpperCase().replace(/-/g, "");
  if (!code) return null;
  var item;
  try {
    item = app.findFirstRecordByFilter("items", "sku = {:sku}", { sku: code });
  } catch (err) {
    return null;
  }
  var settings = onlineSettings(app);
  var online = shared().isOnline(
    {
      show_online: item.getBool("show_online"),
      status: item.getString("status"),
      qty: item.getInt("qty"),
      price: item.getInt("price"),
    },
    settings
  );
  if (!online) return null;
  var base = baseUrl(app, e);
  var out = itemShape(base, item, lookups(app, [item]), settings);
  out.photos = photosOf(base, item);
  return out;
}

// ---------------------------------------------------------------------
// GET /api/public/categories
// ---------------------------------------------------------------------

/**
 * The visible branches (on, under branches that are on) with how many items
 * are online in each subtree, depth first. A branch with nothing online
 * anywhere beneath it is left out, so the website's navigation never leads
 * to an empty shelf.
 */
function categoriesResponse(app) {
  var settings = onlineSettings(app);
  if (!settings.enabled) return { categories: [] };
  var categories = require(__hooks + "/lib/categories.js");
  var tree = categories.loadTree(app);

  var where = onlineWhere(settings, "", []);
  var rows = arrayOf(new DynamicModel({ category: "", n: 0 }));
  app
    .db()
    .newQuery("SELECT i.category AS category, COUNT(*) AS n" + FROM + where.sql + " AND i.category != '' GROUP BY i.category")
    .bind(where.params)
    .all(rows);
  var counts = {};
  for (var i = 0; i < rows.length; i++) counts[rows[i].category] = Number(rows[i].n);
  var totals = categories.subtreeTotals(tree, counts);

  var out = [];
  for (var j = 0; j < tree.flat.length; j++) {
    var node = tree.flat[j];
    var count = totals[node.row.id] || 0;
    if (!node.visible || count < 1) continue;
    out.push({
      id: node.row.id,
      name: node.row.name,
      parent: node.row.parent || "",
      path: node.path,
      depth: node.depth,
      count: count,
    });
  }
  return { categories: out };
}

// ---------------------------------------------------------------------
// New stock in a branch marked show_online (items.pb.js, on create)
// ---------------------------------------------------------------------

/**
 * Whether new stock filed in this branch starts shown online: the branch
 * itself, or any branch above it, is marked `show_online`, so marking
 * "Trading cards / Pokémon" covers its Singles too. Never throws.
 */
function branchStartsOnline(app, categoryId) {
  if (!categoryId) return false;
  try {
    var branch = app.findRecordById("categories", categoryId);
    var ids = String(branch.getString("lineage") || "")
      .split("|")
      .filter(function (id) {
        return id;
      });
    if (ids.indexOf(branch.id) < 0) ids.push(branch.id);
    var rows = app.findRecordsByIds("categories", ids);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].getBool("show_online")) return true;
    }
  } catch (err) {
    return false;
  }
  return false;
}

module.exports = {
  SENTENCES: SENTENCES,
  branchStartsOnline: branchStartsOnline,
  listStock: listStock,
  oneItem: oneItem,
  categoriesResponse: categoriesResponse,
};
