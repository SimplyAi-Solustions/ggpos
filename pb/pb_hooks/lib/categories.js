/**
 * The stock category tree on the server (docs/api-contract-inventory.md,
 * section 1), behind the hooks and routes in categories.pb.js, the item
 * filing in items.pb.js and the till's branch view (lib/tillcatalogue.js).
 *
 * Every branch has one parent, a sort, an `active` flag and three derived
 * fields the server keeps: `path` ("Trading cards / Pokémon / Singles"),
 * `lineage` ("|rootId|...|ownId|") and `depth`. The pure rules (building the
 * tree, deriving the fields, `moveProblem`, `fileItem`) are the shared
 * module's (lib/shared/categories.js); what is here is reading and writing
 * PocketBase records with them.
 *
 * A check returns `null` or `{ status, message }` rather than throwing, so
 * the calling hook or route raises it with its own event and the sentences
 * live in one place (as lib/loyaltyconfig.js does).
 *
 * Writes that touch more than one record take the app they should write
 * with, so a route passes its txApp and the collection API's own update is
 * wrapped the same way (`nextInTransaction`).
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var NAME_MAX = 60;
/** Ids one `assign` call may file between stock rows and till products. */
var ASSIGN_MAX = 500;

var SENTENCES = {
  name: "Give the branch a name.",
  nameLong: "Branch names are " + NAME_MAX + " characters at most. Shorten it.",
  parent: "That parent branch was not found.",
  branch: "That branch was not found.",
  notUnder: "That branch is not under the new parent.",
  unsorted: "Unsorted is where stock with no branch goes, so it stays.",
  order: "That order does not match the branches here. Reload and try again.",
  tooMany: "File up to " + ASSIGN_MAX + " at a time.",
  nothing: "Choose the stock rows or till products to file.",
  missing: "One of those was not found. Reload and try again.",
};

function shared() {
  return require(__hooks + "/lib/shared/categories.js");
}

function refusal(status, message) {
  return { status: status, message: message };
}

/** A trimmed string from an untyped request value. */
function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** A JS array from an untyped request value, [] when it is not a list. */
function listOf(value) {
  if (!value || typeof value !== "object" || typeof value.length !== "number") return [];
  var out = [];
  for (var i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

// ---------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------

/** A `categories` record as the row `buildCategoryTree` takes. */
function rowOf(record) {
  return {
    id: record.id,
    name: record.getString("name"),
    parent: record.getString("parent"),
    sort: record.getInt("sort"),
    active: record.getBool("active"),
    key: record.getString("key"),
    record: record,
  };
}

/**
 * Every branch, switched off or not, as the shared tree: `nodes` are the
 * top-level branches (each with its `children`), `flat` the whole tree
 * depth first, `byId` any node by id. A node's `path`, `lineage`, `depth`
 * and `visible` are worked out from the names and parents as stored, so
 * they hold even for a branch whose own derived fields have drifted.
 */
function loadTree(app) {
  var s = shared();
  var records = app.findRecordsByFilter("categories", "id != ''", "", 0, 0);
  var rows = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i]) rows.push(rowOf(records[i]));
  }
  var nodes = s.buildCategoryTree(rows);
  var flat = s.flattenCategoryTree(nodes);
  var byId = {};
  for (var j = 0; j < flat.length; j++) byId[flat[j].row.id] = flat[j];
  return { nodes: nodes, flat: flat, byId: byId };
}

/** The node of a branch by its seeded key ("unsorted"), or null. */
function nodeByKey(tree, key) {
  for (var i = 0; i < tree.flat.length; i++) {
    if (tree.flat[i].row.key === key) return tree.flat[i];
  }
  return null;
}

/** A branch's id by its seeded key, or "". */
function idByKey(app, key) {
  try {
    return app.findFirstRecordByFilter("categories", "key = {:key}", { key: key }).id;
  } catch (err) {
    return "";
  }
}

/** The Unsorted branch's id, or "". */
function unsortedId(app) {
  return idByKey(app, shared().UNSORTED_KEY);
}

/** A node and every node beneath it, depth first. */
function subtreeOf(node) {
  var out = [node];
  for (var i = 0; i < node.children.length; i++) {
    out = out.concat(subtreeOf(node.children[i]));
  }
  return out;
}

// ---------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------

/** `{ [branch id]: n }` from a query that selects `category` and `n`. */
function countsBy(app, sql) {
  var rows = arrayOf(new DynamicModel({ category: "", n: 0 }));
  app.db().newQuery(sql).all(rows);
  var out = {};
  for (var i = 0; i < rows.length; i++) out[rows[i].category] = Number(rows[i].n);
  return out;
}

/** Stock rows on the shelf (`in_stock`, `qty > 0`) by home branch. */
function shelfCounts(app) {
  return countsBy(
    app,
    "SELECT category AS category, COUNT(*) AS n FROM items " +
      "WHERE status = 'in_stock' AND qty > 0 AND category != '' GROUP BY category"
  );
}

/** Active till products by home branch. */
function productCounts(app) {
  return countsBy(
    app,
    "SELECT category AS category, COUNT(*) AS n FROM till_products " +
      "WHERE active = 1 AND category != '' GROUP BY category"
  );
}

/** `{ [branch id]: n }`: the shelf count of each branch and everything beneath it. */
function subtreeTotals(tree, counts) {
  var totals = {};
  var walk = function (node) {
    var sum = counts[node.row.id] || 0;
    for (var i = 0; i < node.children.length; i++) sum += walk(node.children[i]);
    totals[node.row.id] = sum;
    return sum;
  };
  for (var i = 0; i < tree.nodes.length; i++) walk(tree.nodes[i]);
  return totals;
}

/** `GET /api/vault/categories/tree`: a `CategoryTree`, every branch, depth first. */
function treeResponse(app) {
  var catalogue = require(__hooks + "/lib/tillcatalogue.js");
  var tree = loadTree(app);
  var counts = shelfCounts(app);
  var products = productCounts(app);
  var totals = subtreeTotals(tree, counts);

  var branches = [];
  var walk = function (nodes, parentId) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var record = node.row.record;
      branches.push({
        id: node.row.id,
        name: node.row.name,
        parent: parentId,
        path: node.path,
        lineage: node.lineage,
        depth: node.depth,
        sort: node.row.sort,
        active: node.row.active,
        visible: node.visible,
        key: node.row.key,
        image_url: catalogue.fileUrl(record, record.getString("image")),
        defaults: {
          kind: record.getString("default_kind"),
          game: record.getString("default_game"),
          platform: record.getString("default_platform"),
          tax_scheme: record.getString("default_tax_scheme"),
          // With the scheme, the branch's VAT treatment (launch contract, section 3).
          vat_rate: record.getFloat("default_vat_rate"),
        },
        counts: {
          children: node.children.length,
          products: products[node.row.id] || 0,
          items: counts[node.row.id] || 0,
          items_total: totals[node.row.id] || 0,
        },
      });
      walk(node.children, node.row.id);
    }
  };
  walk(tree.nodes, "");
  return { branches: branches };
}

// ---------------------------------------------------------------------
// Keeping the tree: checks on every create and update (section 1.2)
// ---------------------------------------------------------------------

/** "There is already a branch called Singles here." */
function duplicateName(name) {
  return "There is already a branch called " + name + " here.";
}

/** Whether a node's name is already taken among these siblings (case-insensitive). */
function nameTaken(siblings, name, exceptId) {
  var lower = name.toLowerCase();
  for (var i = 0; i < siblings.length; i++) {
    if (siblings[i].row.id !== exceptId && siblings[i].row.name.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Whether Unsorted is this branch or sits beneath it: switching either off
 * would take the stock-with-no-branch branch off the pickers.
 */
function holdsUnsorted(tree, id) {
  var unsorted = nodeByKey(tree, shared().UNSORTED_KEY);
  return !!unsorted && shared().isWithin(unsorted.lineage, id);
}

/**
 * The refusal for a branch about to be created or updated, or null. Trims
 * the name on the record. `record` is the branch as the request left it:
 * its name, parent and `active` are what is being asked for.
 */
function checkWrite(app, record, isNew) {
  var s = shared();
  var name = text(record.getString("name"));
  if (!name) return refusal(400, SENTENCES.name);
  if (name.length > NAME_MAX) return refusal(400, SENTENCES.nameLong);
  record.set("name", name);

  var tree = loadTree(app);
  var parentId = record.getString("parent");
  var parent = null;
  if (parentId) {
    parent = tree.byId[parentId];
    if (!parent) return refusal(400, SENTENCES.parent);
  }

  var self = isNew ? null : tree.byId[record.id];
  var problem = s.moveProblem(
    record.id,
    parent ? { lineage: parent.lineage, depth: parent.depth } : null,
    self ? s.subtreeHeight(self) : 0
  );
  if (problem) return refusal(400, problem);

  if (nameTaken(parent ? parent.children : tree.nodes, name, record.id)) {
    return refusal(400, duplicateName(name));
  }

  if (!isNew && !record.getBool("active") && record.original().getBool("active") && holdsUnsorted(tree, record.id)) {
    return refusal(409, SENTENCES.unsorted);
  }
  return null;
}

/**
 * A request creating a branch: `key` is the migration's, so it starts
 * empty whatever was sent; and a branch sent with no `active` or `sort`
 * is switched on and goes last among its siblings (a bool field left out
 * of a request would otherwise read as off).
 */
function shapeCreate(e) {
  var record = e.record;
  record.set("key", "");
  var body = {};
  try {
    body = (e.requestInfo() || {}).body || {};
  } catch (err) {
    body = {};
  }
  if (body.active === undefined || body.active === null || body.active === "") {
    record.set("active", true);
  }
  if (body.sort === undefined || body.sort === null || body.sort === "") {
    var last = 0;
    var siblings = e.app.findRecordsByFilter("categories", "parent = {:p}", "", 0, 0, {
      p: record.getString("parent"),
    });
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i]) last = Math.max(last, siblings[i].getInt("sort"));
    }
    record.set("sort", last + 10);
  }
}

/** A request updating a branch cannot change its seeded `key`. */
function keepKey(record) {
  record.set("key", record.original().getString("key"));
}

/** Whether a request moves or renames a branch that has branches beneath it. */
function rewritesSubtree(app, record) {
  var before = record.original();
  if (before.getString("name") === record.getString("name") && before.getString("parent") === record.getString("parent")) {
    return false;
  }
  return app.countRecords("categories", $dbx.hashExp({ parent: record.id })) > 0;
}

/**
 * Run the rest of a record request in a transaction, so the branch and every
 * branch beneath it are written together or not at all. The request's own app
 * becomes the transaction's while `e.next()` runs, so the model hooks below
 * (which write through `e.app`) join it.
 */
function nextInTransaction(e) {
  e.app.runInTransaction(function (txApp) {
    var outer = e.app;
    e.app = txApp;
    try {
      e.next();
    } finally {
      e.app = outer;
    }
  });
}

/**
 * Set `path`, `lineage` and `depth` on a branch from its parent, whatever a
 * request sent for them. Returns whether they differ from what is stored,
 * i.e. whether the branches beneath it have to follow.
 */
function deriveFields(app, record) {
  var s = shared();
  var parentId = record.getString("parent");
  var parentLineage = "";
  var parentPath = "";
  var depth = 0;
  if (parentId) {
    var parent = app.findRecordById("categories", parentId);
    parentLineage = parent.getString("lineage");
    parentPath = parent.getString("path");
    depth = parent.getInt("depth") + 1;
  }
  var lineage = s.lineageOf(parentLineage, record.id);
  var path = s.pathOf(parentPath, record.getString("name"));

  var changed = true;
  if (!record.isNew()) {
    var before = record.original();
    changed =
      before.getString("lineage") !== lineage || before.getString("path") !== path || before.getInt("depth") !== depth;
  }
  record.set("lineage", lineage);
  record.set("path", path);
  record.set("depth", depth);
  return changed;
}

/**
 * After a branch was saved with new derived fields: write them onto its
 * children, each of which does the same for its own (the update hook calls
 * this), so the whole subtree follows, parents before children.
 */
function rewriteChildren(app, parent) {
  var s = shared();
  var children = app.findRecordsByFilter("categories", "parent = {:p}", "sort,name", 0, 0, { p: parent.id });
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (!child) continue;
    var lineage = s.lineageOf(parent.getString("lineage"), child.id);
    var path = s.pathOf(parent.getString("path"), child.getString("name"));
    var depth = parent.getInt("depth") + 1;
    if (child.getString("lineage") === lineage && child.getString("path") === path && child.getInt("depth") === depth) {
      continue;
    }
    app.save(child);
  }
}

// ---------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------

/** "1 branch", "2 branches". */
function plural(n, one, many) {
  var digits = String(n);
  var grouped = "";
  while (digits.length > 3) {
    grouped = "," + digits.slice(-3) + grouped;
    digits = digits.slice(0, -3);
  }
  return digits + grouped + " " + (n === 1 ? one : many);
}

/** "a", "a and b", "a, b and c". */
function joinParts(parts) {
  if (parts.length <= 1) return parts.join("");
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

/**
 * The refusal for deleting a branch, or null: Unsorted stays, and a branch
 * that still holds branches, stock rows (whatever their status, since a
 * deleted branch would unfile sold history) or till products stays until they
 * are moved out. Names only the parts that are not zero.
 */
function deleteProblem(app, record) {
  if (record.getString("key") === shared().UNSORTED_KEY) return refusal(409, SENTENCES.unsorted);
  var children = app.countRecords("categories", $dbx.hashExp({ parent: record.id }));
  var items = app.countRecords("items", $dbx.hashExp({ category: record.id }));
  var products = app.countRecords("till_products", $dbx.hashExp({ category: record.id }));
  var parts = [];
  if (children > 0) parts.push(plural(children, "branch", "branches"));
  if (items > 0) parts.push(plural(items, "stock row", "stock rows"));
  if (products > 0) parts.push(plural(products, "till product", "till products"));
  if (!parts.length) return null;
  return refusal(
    409,
    record.getString("name") + " still holds " + joinParts(parts) + ". Move them out or switch the branch off."
  );
}

// ---------------------------------------------------------------------
// Filing stock and till products (section 1.2, "Filing new stock")
// ---------------------------------------------------------------------

/** The refusal for an item or till product naming a branch that does not exist, or null. */
function homeProblem(app, record, isNew) {
  var id = record.getString("category");
  if (!id) return null;
  if (!isNew && record.original().getString("category") === id) return null;
  try {
    app.findRecordById("categories", id);
  } catch (err) {
    return refusal(400, SENTENCES.branch);
  }
  return null;
}

/**
 * The id of the branch an item files into when nobody chose one: the shared
 * `fileItem` rule on its kind, its game's key and its retro title's platform
 * key, else Unsorted. "" when there is no tree to file into (never throws, so
 * a missing branch can never stop an item being created).
 */
function fileItem(app, record) {
  try {
    var game = "";
    var gameId = record.getString("game");
    if (gameId) {
      try {
        game = app.findRecordById("games", gameId).getString("key");
      } catch (err) {
        game = "";
      }
    }
    var platform = "";
    var retroId = record.getString("retro_title");
    if (retroId) {
      try {
        var platformId = app.findRecordById("retro_titles", retroId).getString("platform");
        if (platformId) platform = app.findRecordById("platforms", platformId).getString("key");
      } catch (err) {
        platform = "";
      }
    }
    var key = shared().fileItem({ kind: record.getString("kind"), game: game, platform: platform });
    return idByKey(app, key) || unsortedId(app);
  } catch (err) {
    return "";
  }
}

// ---------------------------------------------------------------------
// Moving, ordering and filing: the plans behind the write routes
//
// Each `plan*` validates a request against the tree as it stands and
// returns `{ ok: false, status, message }` or `{ ok: true, ... }`; each
// `run*` does the writes through the app it is given, which a route passes
// as its transaction's.
// ---------------------------------------------------------------------

function failed(status, message) {
  return { ok: false, status: status, message: message };
}

/** Sort 10, 20, 30 down a list of nodes. */
function numbered(nodes, moving, parentId) {
  var writes = [];
  for (var i = 0; i < nodes.length; i++) {
    writes.push({
      id: nodes[i].row.id,
      sort: (i + 1) * 10,
      moving: nodes[i].row.id === moving,
      parent: parentId,
    });
  }
  return writes;
}

/** `POST /api/vault/categories/{id}/move`: `{ parent, before? }`. */
function planMove(app, id, body) {
  var s = shared();
  var tree = loadTree(app);
  var node = tree.byId[id];
  if (!node) return failed(404, SENTENCES.branch);

  if (body.parent === undefined) return failed(400, SENTENCES.parent);
  var parentId = text(body.parent);
  var parent = null;
  if (parentId) {
    parent = tree.byId[parentId];
    if (!parent) return failed(400, SENTENCES.parent);
  }

  var problem = s.moveProblem(id, parent ? { lineage: parent.lineage, depth: parent.depth } : null, s.subtreeHeight(node));
  if (problem) return failed(400, problem);

  var siblings = [];
  var pool = parent ? parent.children : tree.nodes;
  for (var i = 0; i < pool.length; i++) {
    if (pool[i].row.id !== id) siblings.push(pool[i]);
  }
  if (nameTaken(siblings, node.row.name, id)) return failed(400, duplicateName(node.row.name));

  var position = siblings.length;
  var beforeId = text(body.before);
  if (beforeId) {
    position = -1;
    for (var j = 0; j < siblings.length; j++) {
      if (siblings[j].row.id === beforeId) position = j;
    }
    if (position < 0) return failed(400, SENTENCES.notUnder);
  }
  var ordered = siblings.slice();
  ordered.splice(position, 0, node);
  return { ok: true, id: id, parent: parentId, before: beforeId, writes: numbered(ordered, id, parentId) };
}

/** Write a move: the branch first (its update hook follows the subtree), then its new siblings' sorts. */
function runMove(txApp, plan) {
  var order = plan.writes.slice().sort(function (a, b) {
    return (b.moving ? 1 : 0) - (a.moving ? 1 : 0);
  });
  for (var i = 0; i < order.length; i++) {
    var write = order[i];
    var record = txApp.findRecordById("categories", write.id);
    var changed = false;
    if (record.getInt("sort") !== write.sort) {
      record.set("sort", write.sort);
      changed = true;
    }
    if (write.moving && record.getString("parent") !== write.parent) {
      record.set("parent", write.parent);
      changed = true;
    }
    if (changed) txApp.save(record);
  }
}

/** `POST /api/vault/categories/reorder`: `{ parent, order }`. */
function planReorder(app, body) {
  var tree = loadTree(app);
  var parentId = text(body.parent);
  var siblings = tree.nodes;
  if (parentId) {
    var parent = tree.byId[parentId];
    if (!parent) return failed(400, SENTENCES.parent);
    siblings = parent.children;
  }
  var wanted = listOf(body.order);
  if (wanted.length !== siblings.length) return failed(400, SENTENCES.order);
  var here = {};
  for (var i = 0; i < siblings.length; i++) here[siblings[i].row.id] = true;
  var seen = {};
  var ordered = [];
  for (var j = 0; j < wanted.length; j++) {
    var id = text(wanted[j]);
    if (!here[id] || seen[id]) return failed(400, SENTENCES.order);
    seen[id] = true;
    ordered.push(tree.byId[id]);
  }
  return { ok: true, parent: parentId, writes: numbered(ordered, "", parentId) };
}

/** Write a reorder: only the rows whose sort changes. */
function runReorder(txApp, plan) {
  for (var i = 0; i < plan.writes.length; i++) {
    var record = txApp.findRecordById("categories", plan.writes[i].id);
    if (record.getInt("sort") === plan.writes[i].sort) continue;
    record.set("sort", plan.writes[i].sort);
    txApp.save(record);
  }
}

/** Ids from an untyped list, blanks left out, in order. */
function idList(value) {
  var out = [];
  var raw = listOf(value);
  for (var i = 0; i < raw.length; i++) {
    var id = text(raw[i]);
    if (id) out.push(id);
  }
  return out;
}

/** The records for a list of ids, in one query, or null when any is missing. */
function recordsFor(app, collection, ids) {
  var unique = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (!seen[ids[i]]) {
      seen[ids[i]] = true;
      unique.push(ids[i]);
    }
  }
  if (!unique.length) return [];
  var found = app.findRecordsByIds(collection, unique);
  var records = [];
  for (var j = 0; j < found.length; j++) {
    if (found[j]) records.push(found[j]);
  }
  return records.length === unique.length ? records : null;
}

/** `POST /api/vault/categories/assign`: `{ category, items?, products? }`. */
function planAssign(app, body) {
  var categoryId = text(body.category);
  var target = null;
  if (categoryId) {
    try {
      target = app.findRecordById("categories", categoryId);
    } catch (err) {
      target = null;
    }
  }
  if (!target) return failed(400, SENTENCES.branch);

  var itemIds = idList(body.items);
  var productIds = idList(body.products);
  if (itemIds.length + productIds.length > ASSIGN_MAX) return failed(400, SENTENCES.tooMany);
  if (!itemIds.length && !productIds.length) return failed(400, SENTENCES.nothing);

  var items = recordsFor(app, "items", itemIds);
  var products = recordsFor(app, "till_products", productIds);
  if (items === null || products === null) return failed(404, SENTENCES.missing);
  return { ok: true, category: target.id, items: items, products: products };
}

/**
 * File the rows into the branch. A row already there is left alone (no write,
 * no new `updated`); every row asked for is counted as filed. Written without
 * validation: only `category` changes, it was checked above, and an old row
 * that would fail today's rules must still be fileable (the migration did the
 * same for the first filing).
 */
function runAssign(txApp, plan) {
  var lists = [plan.items, plan.products];
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      var record = txApp.findRecordById(lists[l][i].collection().name, lists[l][i].id);
      if (record.getString("category") === plan.category) continue;
      record.set("category", plan.category);
      txApp.saveNoValidate(record);
    }
  }
  return { items: plan.items.length, products: plan.products.length };
}

module.exports = {
  NAME_MAX: NAME_MAX,
  ASSIGN_MAX: ASSIGN_MAX,
  SENTENCES: SENTENCES,
  loadTree: loadTree,
  nodeByKey: nodeByKey,
  idByKey: idByKey,
  unsortedId: unsortedId,
  subtreeOf: subtreeOf,
  shelfCounts: shelfCounts,
  productCounts: productCounts,
  subtreeTotals: subtreeTotals,
  treeResponse: treeResponse,
  checkWrite: checkWrite,
  shapeCreate: shapeCreate,
  keepKey: keepKey,
  rewritesSubtree: rewritesSubtree,
  nextInTransaction: nextInTransaction,
  deriveFields: deriveFields,
  rewriteChildren: rewriteChildren,
  deleteProblem: deleteProblem,
  homeProblem: homeProblem,
  fileItem: fileItem,
  planMove: planMove,
  runMove: runMove,
  planReorder: planReorder,
  runReorder: runReorder,
  planAssign: planAssign,
  runAssign: runAssign,
};
