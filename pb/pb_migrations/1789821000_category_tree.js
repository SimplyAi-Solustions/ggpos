/// <reference path="../pb_data/types.d.ts" />

/**
 * The stock category tree (docs/EPOS-PLAN.md, decision 7;
 * docs/api-contract-inventory.md, section 1).
 *
 * - `categories`: a tree of any depth (eight levels at most), brand before
 *   type. `parent` is empty at the top. `path`, `lineage` ("|root|...|own|")
 *   and `depth` are derived from the parent; this migration writes them for
 *   the seeded branches and `pb_hooks/categories.pb.js` keeps them from
 *   then on. `key` is the stable name of a seeded branch ("tcg.pokemon.
 *   singles"), which the filing rules use whatever staff rename it to. The
 *   `default_*` fields are what a new item in the branch starts with.
 * - `items.category`: every stock row's one home branch. Existing stock is
 *   filed by the shared rules (`fileItem` in packages/shared/src/
 *   categories.ts): by kind and game for cards and sealed product, by the
 *   boxed platform for retro, Unsorted for anything the facts do not settle.
 * - `till_products.category` points at the tree instead of the till's
 *   quick-key pages (`till_categories`, which stay as pages): each existing
 *   product is placed by its kind and name.
 *
 * The starter tree and the filing rules are the shared module's, loaded from
 * its generated copy in pb_hooks, so the seed, the item-create hook and
 * demo mode cannot disagree. The backfill writes through SQL so an old row
 * that would fail today's validation is still filed.
 *
 * `down()` puts `till_products.category` back on the pages (by the old
 * page names where they still exist, else empty), drops `items.category`
 * and the collection.
 */

const STAFF_ONLY = '@request.auth.collectionName = "staff"';
const MANAGER_UP =
  '@request.auth.collectionName = "staff" && (@request.auth.role = "admin" || @request.auth.role = "manager")';

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

migrate(
  (app) => {
    const shared = require(`${__hooks}/lib/shared/categories.js`);

    // -----------------------------------------------------------------
    // The collection
    // -----------------------------------------------------------------
    const games = app.findCollectionByNameOrId("games");
    const platforms = app.findCollectionByNameOrId("platforms");
    const categories = new Collection({
      type: "base",
      name: "categories",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      // A branch with branches, stock or products in it is refused by the
      // hook; an empty one can go.
      deleteRule: MANAGER_UP,
      fields: [
        { name: "name", type: "text", required: true, max: 60 },
        { name: "sort", type: "number", onlyInt: true },
        { name: "active", type: "bool" },
        {
          name: "image",
          type: "file",
          maxSelect: 1,
          maxSize: 5242880,
          mimeTypes: ["image/png", "image/jpeg", "image/webp"],
          thumbs: ["160x0", "320x0"],
        },
        { name: "key", type: "text", max: 80 },
        {
          name: "default_kind",
          type: "select",
          maxSelect: 1,
          values: ["single", "graded", "retro", "sealed", "accessory", "other"],
        },
        { name: "default_game", type: "relation", collectionId: games.id, maxSelect: 1, cascadeDelete: false },
        {
          name: "default_platform",
          type: "relation",
          collectionId: platforms.id,
          maxSelect: 1,
          cascadeDelete: false,
        },
        { name: "default_tax_scheme", type: "select", maxSelect: 1, values: ["margin", "standard", "exempt"] },
        // Derived from the parent and kept by pb_hooks/categories.pb.js.
        { name: "path", type: "text", max: 600 },
        { name: "lineage", type: "text", max: 400 },
        { name: "depth", type: "number", onlyInt: true, min: 0 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    });
    app.save(categories);
    categories.fields.add(
      new Field({ name: "parent", type: "relation", collectionId: categories.id, maxSelect: 1, cascadeDelete: false })
    );
    categories.indexes = [
      "CREATE UNIQUE INDEX idx_categories_sibling_name ON categories (parent, name COLLATE NOCASE)",
      "CREATE UNIQUE INDEX idx_categories_key ON categories (key) WHERE key != ''",
      "CREATE INDEX idx_categories_lineage ON categories (lineage)",
      "CREATE INDEX idx_categories_parent_sort ON categories (parent, sort)",
    ];
    app.save(categories);

    // -----------------------------------------------------------------
    // The starter tree, depth first, siblings ten apart
    // -----------------------------------------------------------------
    const gameIds = {};
    app.findRecordsByFilter("games", "id != ''", "", 0, 0).forEach((row) => {
      gameIds[row.getString("key")] = row.id;
    });
    const platformIds = {};
    app.findRecordsByFilter("platforms", "id != ''", "", 0, 0).forEach((row) => {
      platformIds[row.getString("key")] = row.id;
    });

    const byKey = {};
    const siblings = {};
    shared.starterBranches().forEach((entry) => {
      const branch = entry.branch;
      const parent = entry.parent ? byKey[entry.parent] : null;
      const position = (siblings[entry.parent] = (siblings[entry.parent] || 0) + 1);
      const id = $security.randomStringWithAlphabet(15, ID_ALPHABET);
      const row = new Record(categories);
      row.set("id", id);
      row.set("name", branch.name);
      row.set("sort", position * 10);
      row.set("active", true);
      row.set("key", branch.key);
      if (parent) row.set("parent", parent.id);
      const defaults = branch.defaults || {};
      if (defaults.kind) row.set("default_kind", defaults.kind);
      if (defaults.game && gameIds[defaults.game]) row.set("default_game", gameIds[defaults.game]);
      if (defaults.platform && platformIds[defaults.platform]) {
        row.set("default_platform", platformIds[defaults.platform]);
      }
      if (defaults.tax_scheme) row.set("default_tax_scheme", defaults.tax_scheme);
      const lineage = shared.lineageOf(parent ? parent.lineage : "", id);
      const path = shared.pathOf(parent ? parent.path : "", branch.name);
      row.set("lineage", lineage);
      row.set("path", path);
      row.set("depth", entry.depth);
      app.save(row);
      byKey[branch.key] = { id: id, lineage: lineage, path: path };
    });

    // -----------------------------------------------------------------
    // items.category, and the existing stock filed
    // -----------------------------------------------------------------
    const items = app.findCollectionByNameOrId("items");
    items.fields.add(
      new Field({ name: "category", type: "relation", collectionId: categories.id, maxSelect: 1, cascadeDelete: false })
    );
    items.indexes = items.indexes.concat(["CREATE INDEX idx_items_category ON items (category)"]);
    app.save(items);

    const unsorted = byKey[shared.UNSORTED_KEY].id;
    const facts = arrayOf(
      new DynamicModel({ id: "", kind: "", game: "", platform: "" })
    );
    app
      .db()
      .newQuery(
        "SELECT i.id AS id, COALESCE(i.kind, '') AS kind, COALESCE(g.key, '') AS game, COALESCE(p.key, '') AS platform " +
          "FROM items i LEFT JOIN games g ON g.id = i.game " +
          "LEFT JOIN retro_titles r ON r.id = i.retro_title LEFT JOIN platforms p ON p.id = r.platform"
      )
      .all(facts);
    facts.forEach((row) => {
      const key = shared.fileItem({ kind: row.kind, game: row.game, platform: row.platform });
      const target = byKey[key] ? byKey[key].id : unsorted;
      app.db().newQuery("UPDATE items SET category = {:category} WHERE id = {:id}").bind({ category: target, id: row.id }).execute();
    });

    // -----------------------------------------------------------------
    // till_products.category: from the quick-key pages to the tree
    // -----------------------------------------------------------------
    const products = arrayOf(new DynamicModel({ id: "", kind: "", name: "", page: "" }));
    app
      .db()
      .newQuery(
        "SELECT p.id AS id, COALESCE(p.kind, '') AS kind, COALESCE(p.name, '') AS name, COALESCE(c.name, '') AS page " +
          "FROM till_products p LEFT JOIN till_categories c ON c.id = p.category"
      )
      .all(products);

    const tillProducts = app.findCollectionByNameOrId("till_products");
    tillProducts.indexes = tillProducts.indexes.filter((sql) => sql.indexOf("idx_till_products_category") < 0);
    tillProducts.fields.removeByName("category");
    app.save(tillProducts);
    tillProducts.fields.add(
      new Field({ name: "category", type: "relation", collectionId: categories.id, maxSelect: 1, cascadeDelete: false })
    );
    tillProducts.indexes = tillProducts.indexes.concat([
      "CREATE INDEX idx_till_products_category ON till_products (category)",
    ]);
    app.save(tillProducts);

    // The top-level branches by name, for a product on a page of the same
    // name ("Services").
    const topByName = {};
    shared.STARTER_TREE.forEach((branch) => {
      topByName[branch.name.toLowerCase()] = branch.key;
    });
    products.forEach((row) => {
      const name = row.name.toLowerCase();
      let key = "";
      if (row.kind === "membership") key = "services.memberships";
      else if (row.kind === "service" && name.indexOf("table") >= 0) key = "services.tabletime";
      else if (name.indexOf("event") >= 0) key = "services.events";
      else if (row.kind === "service" || row.kind === "deposit") key = "services";
      else if (name.indexOf("single card") >= 0) key = "tcg";
      else if (topByName[row.page.toLowerCase()]) key = topByName[row.page.toLowerCase()];
      else key = shared.UNSORTED_KEY;
      const target = byKey[key] ? byKey[key].id : unsorted;
      app
        .db()
        .newQuery("UPDATE till_products SET category = {:category} WHERE id = {:id}")
        .bind({ category: target, id: row.id })
        .execute();
    });
  },
  (app) => {
    // Products back on the pages, by the page whose name matches the
    // product's top-level branch, else none.
    const pages = {};
    app.findRecordsByFilter("till_categories", "id != ''", "", 0, 0).forEach((row) => {
      pages[row.getString("name").toLowerCase()] = row.id;
    });
    const placed = arrayOf(new DynamicModel({ id: "", top: "" }));
    app
      .db()
      .newQuery(
        "SELECT p.id AS id, COALESCE(t.name, '') AS top FROM till_products p " +
          "LEFT JOIN categories c ON c.id = p.category " +
          "LEFT JOIN categories t ON c.lineage LIKE '|' || t.id || '|%'"
      )
      .all(placed);

    const tillProducts = app.findCollectionByNameOrId("till_products");
    tillProducts.indexes = tillProducts.indexes.filter((sql) => sql.indexOf("idx_till_products_category") < 0);
    tillProducts.fields.removeByName("category");
    app.save(tillProducts);
    const tillCategories = app.findCollectionByNameOrId("till_categories");
    tillProducts.fields.add(
      new Field({ name: "category", type: "relation", collectionId: tillCategories.id, maxSelect: 1, cascadeDelete: false })
    );
    tillProducts.indexes = tillProducts.indexes.concat([
      "CREATE INDEX idx_till_products_category ON till_products (category)",
    ]);
    app.save(tillProducts);
    placed.forEach((row) => {
      const page = pages[row.top.toLowerCase()] || "";
      app.db().newQuery("UPDATE till_products SET category = {:page} WHERE id = {:id}").bind({ page: page, id: row.id }).execute();
    });

    const items = app.findCollectionByNameOrId("items");
    items.indexes = items.indexes.filter((sql) => sql.indexOf("idx_items_category") < 0);
    items.fields.removeByName("category");
    app.save(items);

    app.delete(app.findCollectionByNameOrId("categories"));
  }
);
