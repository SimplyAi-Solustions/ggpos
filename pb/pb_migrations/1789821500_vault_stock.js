/// <reference path="../pb_data/types.d.ts" />

/**
 * The vault's Stock feature (apps/vault/src/features/stock): price history,
 * the price label print list, pricing rules and their approval queue.
 * Additive only: four new collections, nothing existing is touched.
 *
 *   item_price_changes  one row per sticker price change made through the
 *                       vault (POST /api/vault/stock/reprice and the approval
 *                       queue). `source` says how; a latest row of "manual"
 *                       is what "protect hand-stickered items" protects.
 *   stock_print_list    the Niimbot price label list: to_print, printed,
 *                       needs_reprint. A price change on a printed item flips
 *                       it to needs_reprint (vault_stock.pb.js).
 *   sell_price_rules    Pricing Studio-lite rules. The maths lives in
 *                       apps/vault/src/features/stock/pricing/rules.ts.
 *   price_proposals     a rule's proposed change waiting for Approve or
 *                       Reject, applied by POST /api/vault/stock/proposals/decide.
 *
 * Reads are staff-only. Price changes and decisions go through the routes so
 * the history row is always written; rules are written by admins and managers.
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const MANAGER =
      '@request.auth.collectionName = "staff" && (@request.auth.role = "admin" || @request.auth.role = "manager")';

    const items = app.findCollectionByNameOrId("items");
    const staff = app.findCollectionByNameOrId("staff");
    const games = app.findCollectionByNameOrId("games");
    const categories = app.findCollectionByNameOrId("categories");

    const autodates = [
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ];

    const rules = new Collection({
      type: "base",
      name: "sell_price_rules",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER,
      updateRule: MANAGER,
      deleteRule: MANAGER,
      fields: [
        { type: "text", name: "name", required: true, max: 80 },
        { type: "bool", name: "active" },
        { type: "select", name: "approval", maxSelect: 1, values: ["ask", "auto"] },
        { type: "select", name: "match", required: true, maxSelect: 1, values: ["all", "category", "game", "kind"] },
        { type: "relation", name: "match_category", collectionId: categories.id, maxSelect: 1, cascadeDelete: false },
        { type: "relation", name: "match_game", collectionId: games.id, maxSelect: 1, cascadeDelete: false },
        { type: "text", name: "match_kind", max: 20 },
        { type: "select", name: "start", required: true, maxSelect: 1, values: ["market_pct", "cost_markup", "fixed"] },
        // market_pct and cost_markup: a whole percent. fixed: pence.
        { type: "number", name: "start_value", onlyInt: true },
        // A whole percent added after the start point.
        { type: "number", name: "adjust_pct", onlyInt: true, min: -90, max: 500 },
        { type: "select", name: "rounding", maxSelect: 1, values: ["none", "charm_99", "charm_49_99", "round_to"] },
        // round_to only: 25, 50 or 100 pence.
        { type: "number", name: "round_step", onlyInt: true, min: 0 },
        { type: "bool", name: "never_below_cost" },
        // 0 is no limit.
        { type: "number", name: "max_change_pct", onlyInt: true, min: 0, max: 1000 },
        { type: "bool", name: "protect_hand" },
        { type: "relation", name: "created_by", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        ...autodates,
      ],
    });
    app.save(rules);

    const changes = new Collection({
      type: "base",
      name: "item_price_changes",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "relation", name: "item", required: true, collectionId: items.id, maxSelect: 1, cascadeDelete: true },
        { type: "number", name: "old_price", onlyInt: true },
        { type: "number", name: "new_price", onlyInt: true },
        { type: "select", name: "source", maxSelect: 1, values: ["manual", "rule", "import", "bulk"] },
        { type: "relation", name: "rule", collectionId: rules.id, maxSelect: 1, cascadeDelete: false },
        { type: "relation", name: "staff", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        ...autodates,
      ],
      indexes: ["CREATE INDEX idx_item_price_changes_item ON item_price_changes (item, created)"],
    });
    app.save(changes);

    const printList = new Collection({
      type: "base",
      name: "stock_print_list",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: STAFF_ONLY,
      updateRule: STAFF_ONLY,
      deleteRule: STAFF_ONLY,
      fields: [
        { type: "relation", name: "item", required: true, collectionId: items.id, maxSelect: 1, cascadeDelete: true },
        {
          type: "select",
          name: "status",
          required: true,
          maxSelect: 1,
          values: ["to_print", "printed", "needs_reprint"],
        },
        { type: "number", name: "copies", onlyInt: true, min: 0, max: 160 },
        { type: "date", name: "printed_at" },
        { type: "relation", name: "added_by", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX idx_stock_print_list_item ON stock_print_list (item)"],
    });
    app.save(printList);

    const proposals = new Collection({
      type: "base",
      name: "price_proposals",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: STAFF_ONLY,
      updateRule: null,
      deleteRule: MANAGER,
      fields: [
        { type: "relation", name: "rule", collectionId: rules.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "item", required: true, collectionId: items.id, maxSelect: 1, cascadeDelete: true },
        { type: "number", name: "old_price", onlyInt: true },
        { type: "number", name: "new_price", onlyInt: true, min: 0 },
        { type: "text", name: "reason", max: 200 },
        {
          type: "select",
          name: "status",
          required: true,
          maxSelect: 1,
          values: ["pending", "approved", "rejected"],
        },
        { type: "relation", name: "decided_by", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        { type: "date", name: "decided_at" },
        { type: "relation", name: "created_by", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        ...autodates,
      ],
      indexes: ["CREATE INDEX idx_price_proposals_status ON price_proposals (status, created)"],
    });
    app.save(proposals);
  },
  (app) => {
    for (const name of ["price_proposals", "stock_print_list", "item_price_changes", "sell_price_rules"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (err) {
        // Already gone.
      }
    }
  }
);
