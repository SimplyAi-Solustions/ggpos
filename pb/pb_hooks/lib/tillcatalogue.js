/**
 * The till catalogue's shapes (docs/api-contract-epos.md, section 4, "The
 * till catalogue"), shared by the two routes in till_catalogue.pb.js: a
 * product or a stock line as a tile, the image behind it, and the stock
 * query behind a dynamic category.
 *
 * An image URL is a `/api/files/...` path for a product's own image or an
 * item's first photo, otherwise the card's image URL (re-hosted locally by
 * adapters/images.js once it has been cached), otherwise "".
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Records by id for a list of ids, in one query, as `{ [id]: record }`. */
function byIds(app, collection, ids) {
  var out = {};
  var unique = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] && !seen[ids[i]]) {
      seen[ids[i]] = true;
      unique.push(ids[i]);
    }
  }
  if (!unique.length) return out;
  var rows = [];
  try {
    rows = app.findRecordsByIds(collection, unique);
  } catch (err) {
    rows = [];
  }
  for (var j = 0; j < rows.length; j++) {
    if (rows[j]) out[rows[j].id] = rows[j];
  }
  return out;
}

/** The `/api/files/...` path of a record's file, or "". */
function fileUrl(record, filename) {
  if (!filename) return "";
  return "/api/files/" + record.baseFilesPath() + "/" + filename;
}

/** The first name in a multi-file field, whatever shape PocketBase hands it back in. */
function firstFile(record, field) {
  try {
    var names = record.getStringSlice(field);
    if (names && names.length) return String(names[0]);
  } catch (err) {
    // fall through
  }
  return "";
}

/** `{ [cardId]: url }` for the cards behind a batch of items, in one query. */
function cardImages(app, itemsById) {
  var ids = [];
  var keys = Object.keys(itemsById || {});
  for (var i = 0; i < keys.length; i++) {
    var item = itemsById[keys[i]];
    if (item && item.getString("card") && !firstFile(item, "photos")) ids.push(item.getString("card"));
  }
  var cards = byIds(app, "cards", ids);
  var out = {};
  var cardIds = Object.keys(cards);
  for (var j = 0; j < cardIds.length; j++) {
    var card = cards[cardIds[j]];
    out[card.id] =
      card.getString("image_small") ||
      card.getString("image_large") ||
      fileUrl(card, card.getString("image_file"));
  }
  return out;
}

/** Whether a category's filter makes it a dynamic stock list. */
function isDynamic(filter) {
  if (!filter || typeof filter !== "object") return false;
  var kinds = filter.kinds && filter.kinds.length ? filter.kinds : [];
  var games = filter.games && filter.games.length ? filter.games : [];
  return kinds.length > 0 || games.length > 0;
}

/** A till product as a tile. */
function productShape(app, product) {
  var kind = product.getString("kind");
  var openPrice = kind === "open_price" || kind === "deposit";
  return {
    id: product.id,
    name: product.getString("name"),
    kind: kind,
    price: openPrice ? 0 : product.getInt("price"),
    open_price: openPrice,
    image_url: fileUrl(product, product.getString("image")),
    tax_scheme: product.getString("tax_scheme") || "standard",
  };
}

/** A stock line (or a single) as a tile. */
function itemShape(app, item, images) {
  var photo = firstFile(item, "photos");
  return {
    id: item.id,
    sku: item.getString("sku"),
    title: item.getString("title") || item.getString("sku"),
    price: item.getInt("price"),
    qty: item.getInt("qty"),
    image_url: photo ? fileUrl(item, photo) : (images && images[item.getString("card")]) || "",
    kind: item.getString("kind"),
    status: item.getString("status"),
  };
}

/**
 * The in-stock stock lines a dynamic filter lists: the same conditions as a
 * PocketBase filter (for the page) and as a dbx expression (for the count),
 * built from the one list of kinds and games so the two cannot disagree.
 */
function stockQuery(filter, q) {
  var kinds = [];
  var games = [];
  var i;
  if (filter && filter.kinds) for (i = 0; i < filter.kinds.length; i++) kinds.push(String(filter.kinds[i]));
  if (filter && filter.games) for (i = 0; i < filter.games.length; i++) games.push(String(filter.games[i]));

  var parts = ["qty > 0", "status = 'in_stock'"];
  var params = {};
  var exps = [$dbx.exp("[[qty]] > 0"), $dbx.hashExp({ status: "in_stock" })];

  if (kinds.length) {
    var kindParts = [];
    for (i = 0; i < kinds.length; i++) {
      params["k" + i] = kinds[i];
      kindParts.push("kind = {:k" + i + "}");
    }
    parts.push("(" + kindParts.join(" || ") + ")");
    exps.push($dbx.in.apply(null, ["kind"].concat(kinds)));
  }
  if (games.length) {
    var gameParts = [];
    for (i = 0; i < games.length; i++) {
      params["g" + i] = games[i];
      gameParts.push("game = {:g" + i + "}");
    }
    parts.push("(" + gameParts.join(" || ") + ")");
    exps.push($dbx.in.apply(null, ["game"].concat(games)));
  }
  if (q) {
    params.q = q;
    parts.push("title ~ {:q}");
    exps.push($dbx.like("title", q));
  }

  return {
    filter: parts.join(" && "),
    params: params,
    expression: $dbx.and.apply(null, exps),
  };
}

module.exports = {
  byIds: byIds,
  fileUrl: fileUrl,
  firstFile: firstFile,
  cardImages: cardImages,
  isDynamic: isDynamic,
  productShape: productShape,
  itemShape: itemShape,
  stockQuery: stockQuery,
};
