/// <reference path="../pb_data/types.d.ts" />

/**
 * Stock collections: items (the one true record of what we hold), where it
 * sits, stock counts and the want list.
 *
 * See docs/PLAN.md, "Data model (PocketBase collections) > Stock" and
 * "Core flows and rules" for the SKU and quantity model.
 *
 * items is never public (API rules in short: "items never public").
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  const games = app.findCollectionByNameOrId("games");
  const cards = app.findCollectionByNameOrId("cards");
  const retroTitles = app.findCollectionByNameOrId("retro_titles");
  const customers = app.findCollectionByNameOrId("customers");
  const staff = app.findCollectionByNameOrId("staff");

  // ---------------------------------------------------------------------
  // locations
  // ---------------------------------------------------------------------
  const locations = new Collection({
    name: "locations",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "name", type: "text", required: true, max: 100 },
      { name: "type", type: "text", max: 60 },
      { name: "sort", type: "number", onlyInt: true },
      ...autodates(),
    ],
  });
  app.save(locations);

  // ---------------------------------------------------------------------
  // items. trade_in_line points at trade_in_lines, which is created later
  // (1789819380_trading_collections.js); that field is patched on there
  // once the target collection exists.
  // ---------------------------------------------------------------------
  const items = new Collection({
    name: "items",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      // Assigned by items.pb.js on create if empty; required so any other
      // creation path (import, tests) must supply one directly.
      { name: "sku", type: "text", required: true, max: 20 },
      {
        name: "kind",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["single", "graded", "retro", "sealed", "accessory", "other"],
      },
      { name: "game", type: "relation", required: true, collectionId: games.id, maxSelect: 1 },
      { name: "card", type: "relation", collectionId: cards.id, maxSelect: 1 },
      { name: "retro_title", type: "relation", collectionId: retroTitles.id, maxSelect: 1 },
      // Derived from card/retro_title by items.pb.js if left empty.
      { name: "title", type: "text", max: 300 },
      { name: "set_code", type: "text", max: 40 },
      { name: "number", type: "text", max: 40 },
      { name: "finish", type: "text", max: 60 },
      { name: "language", type: "text", max: 20 },
      { name: "condition", type: "select", maxSelect: 1, values: ["NM", "LP", "MP", "HP", "DMG"] },
      { name: "completeness", type: "select", maxSelect: 1, values: ["loose", "boxed", "cib"] },
      { name: "cosmetic_grade", type: "select", maxSelect: 1, values: ["A", "B", "C"] },
      { name: "tested", type: "bool" },
      { name: "region", type: "select", maxSelect: 1, values: ["PAL", "NTSC", "JP"] },
      { name: "grade_company", type: "text", max: 60 },
      { name: "grade", type: "text", max: 20 },
      { name: "cert_no", type: "text", max: 60 },
      { name: "ean", type: "text", max: 32 },
      // 1 for singles/graded/retro; n for sealed/accessories (one SKU per
      // stock line, a sale decrements qty).
      // Not required: PocketBase's required check on a number field treats
      // an explicit 0 as blank, and a sale legitimately decrements a
      // sealed/accessory line's qty to exactly 0.
      { name: "qty", type: "number", onlyInt: true, min: 0 },
      { name: "cost", type: "number", onlyInt: true, min: 0 },
      { name: "market_at_intake", type: "number", onlyInt: true, min: 0 },
      { name: "price", type: "number", onlyInt: true, min: 0 },
      { name: "tax_scheme", type: "select", maxSelect: 1, values: ["margin", "standard"] },
      {
        name: "status",
        type: "select",
        maxSelect: 1,
        values: ["in_stock", "reserved", "listed_ebay", "sold", "returned", "written_off"],
      },
      { name: "location", type: "relation", collectionId: locations.id, maxSelect: 1 },
      { name: "photos", type: "file", maxSelect: 12, maxSize: 10485760, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
      { name: "source", type: "select", maxSelect: 1, values: ["trade_in", "supplier", "opening_stock"] },
      // trade_in_line (relation -> trade_in_lines) is added in
      // 1789819380_trading_collections.js once that collection exists.
      { name: "acquired_at", type: "date" },
      { name: "supplier_ref", type: "text", max: 100 },
      { name: "reserved_for", type: "relation", collectionId: customers.id, maxSelect: 1 },
      { name: "reserved_until", type: "date" },
      { name: "ebay_listing_id", type: "text", max: 100 },
      { name: "ebay_sku", type: "text", max: 60 },
      { name: "sumup_synced_at", type: "date" },
      { name: "label_printed_at", type: "date" },
      { name: "notes", type: "text", max: 2000 },
      { name: "created_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  items.addIndex("idx_items_sku_unique", true, "sku", "");
  items.addIndex("idx_items_status", false, "status", "");
  items.addIndex("idx_items_game", false, "game", "");
  items.addIndex("idx_items_title", false, "title", "");
  items.addIndex("idx_items_ebay_sku", false, "ebay_sku", "");
  items.addIndex("idx_items_ean", false, "ean", "");
  app.save(items);

  // ---------------------------------------------------------------------
  // want_list. Customer-createable (create with customer = @request.auth.id),
  // per the task brief's list of the only collections customers may create.
  // ---------------------------------------------------------------------
  const wantList = new Collection({
    name: "want_list",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: `${STAFF_ONLY} || (@request.auth.collectionName = "customers" && customer = @request.auth.id)`,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "card", type: "relation", collectionId: cards.id, maxSelect: 1 },
      { name: "free_text", type: "text", max: 300 },
      { name: "max_price", type: "number", onlyInt: true, min: 0 },
      {
        name: "status",
        type: "select",
        maxSelect: 1,
        values: ["open", "matched", "fulfilled", "closed"],
      },
      { name: "matched_item", type: "relation", collectionId: items.id, maxSelect: 1 },
      { name: "notified_at", type: "date" },
      ...autodates(),
    ],
  });
  app.save(wantList);

  // ---------------------------------------------------------------------
  // stock_counts / stock_count_lines
  // ---------------------------------------------------------------------
  const stockCounts = new Collection({
    name: "stock_counts",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "location", type: "relation", collectionId: locations.id, maxSelect: 1 },
      { name: "started_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "started_at", type: "autodate", onCreate: true },
      { name: "closed_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "closed_at", type: "date" },
      { name: "status", type: "select", maxSelect: 1, values: ["open", "closed"] },
      ...autodates(),
    ],
  });
  app.save(stockCounts);

  const stockCountLines = new Collection({
    name: "stock_count_lines",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "stock_count", type: "relation", required: true, collectionId: stockCounts.id, maxSelect: 1, cascadeDelete: true },
      { name: "item", type: "relation", required: true, collectionId: items.id, maxSelect: 1 },
      { name: "expected_qty", type: "number", onlyInt: true },
      { name: "scanned_qty", type: "number", onlyInt: true },
      { name: "variance", type: "number", onlyInt: true },
      ...autodates(),
    ],
  });
  app.save(stockCountLines);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("stock_count_lines"));
  app.delete(app.findCollectionByNameOrId("stock_counts"));
  app.delete(app.findCollectionByNameOrId("want_list"));
  app.delete(app.findCollectionByNameOrId("items"));
  app.delete(app.findCollectionByNameOrId("locations"));
});
