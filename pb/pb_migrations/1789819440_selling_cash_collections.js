/// <reference path="../pb_data/types.d.ts" />

/**
 * Selling and cash collections: sales, cash sessions/movements and the
 * shared sequence counters.
 *
 * See docs/PLAN.md, "Data model (PocketBase collections) > Selling and
 * cash" and "Core flows and rules > Sale completion / Cash".
 *
 * Sales are staff-only end to end - unlike trade_ins, "sales" does not
 * appear in PLAN.md's "readable by their owning customer" list, and no
 * customer portal screen shows purchase history, so this stays staff-only.
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  const staff = app.findCollectionByNameOrId("staff");
  const customers = app.findCollectionByNameOrId("customers");
  const items = app.findCollectionByNameOrId("items");

  // ---------------------------------------------------------------------
  // cash_sessions / cash_movements
  // ---------------------------------------------------------------------
  const cashSessions = new Collection({
    name: "cash_sessions",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "opened_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "opened_at", type: "autodate", onCreate: true },
      { name: "float", type: "number", onlyInt: true, min: 0 },
      { name: "closed_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "closed_at", type: "date" },
      { name: "expected", type: "number", onlyInt: true },
      { name: "counted", type: "number", onlyInt: true },
      { name: "variance", type: "number", onlyInt: true },
      { name: "notes", type: "text", max: 2000 },
      ...autodates(),
    ],
  });
  app.save(cashSessions);

  // Complete the trade_ins <-> cash_sessions circular relation started in
  // 1789819380_trading_collections.js.
  const tradeIns = app.findCollectionByNameOrId("trade_ins");
  tradeIns.fields.add(
    new Field({ name: "cash_session", type: "relation", collectionId: cashSessions.id, maxSelect: 1 })
  );
  app.save(tradeIns);

  const cashMovements = new Collection({
    name: "cash_movements",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "session", type: "relation", required: true, collectionId: cashSessions.id, maxSelect: 1, cascadeDelete: true },
      {
        name: "type",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["float_in", "payout", "cash_sale", "refund", "bank_drop", "adjustment"],
      },
      { name: "amount", type: "number", required: true, onlyInt: true }, // signed pence
      { name: "ref", type: "text", max: 100 },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  app.save(cashMovements);

  // ---------------------------------------------------------------------
  // sales / sale_lines
  // ---------------------------------------------------------------------
  const sales = new Collection({
    name: "sales",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "number", type: "text", required: true, max: 20 }, // GG-S-000456
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "customer", type: "relation", collectionId: customers.id, maxSelect: 1 },
      { name: "subtotal", type: "number", onlyInt: true, min: 0 },
      { name: "discount", type: "number", onlyInt: true, min: 0 },
      { name: "discount_source", type: "select", maxSelect: 1, values: ["manual", "tier_perk", "reward"] },
      { name: "total", type: "number", onlyInt: true, min: 0 },
      {
        name: "payment",
        type: "select",
        maxSelect: 1,
        values: ["sumup_card", "cash", "store_credit", "points", "mixed"],
      },
      { name: "payment_split", type: "json", maxSize: 5000 },
      { name: "sumup_ref", type: "text", max: 100 },
      { name: "cash_session", type: "relation", collectionId: cashSessions.id, maxSelect: 1 },
      { name: "points_earned", type: "number", onlyInt: true },
      { name: "status", type: "select", maxSelect: 1, values: ["complete", "refunded", "part_refunded"] },
      ...autodates(),
    ],
  });
  sales.addIndex("idx_sales_number_unique", true, "number", "");
  app.save(sales);

  const saleLines = new Collection({
    name: "sale_lines",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "sale", type: "relation", required: true, collectionId: sales.id, maxSelect: 1, cascadeDelete: true },
      { name: "item", type: "relation", required: true, collectionId: items.id, maxSelect: 1 },
      { name: "qty", type: "number", onlyInt: true, min: 1 },
      { name: "unit_price", type: "number", onlyInt: true, min: 0 },
      { name: "discount", type: "number", onlyInt: true, min: 0 },
      { name: "vat_rate", type: "number", min: 0 }, // percent, not pence
      { name: "tax_scheme", type: "select", maxSelect: 1, values: ["margin", "standard"] },
      { name: "status", type: "select", maxSelect: 1, values: ["sold", "refunded"] },
      ...autodates(),
    ],
  });
  app.save(saleLines);

  // ---------------------------------------------------------------------
  // counters: bumped inside the same transaction as the record it numbers
  // (see pb_hooks/lib/counters.js). No direct client writes.
  // ---------------------------------------------------------------------
  const counters = new Collection({
    name: "counters",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "key", type: "text", required: true, max: 40 },
      { name: "value", type: "number", required: true, onlyInt: true, min: 0 },
      ...autodates(),
    ],
  });
  counters.addIndex("idx_counters_key_unique", true, "key", "");
  app.save(counters);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("counters"));
  app.delete(app.findCollectionByNameOrId("sale_lines"));
  app.delete(app.findCollectionByNameOrId("sales"));
  app.delete(app.findCollectionByNameOrId("cash_movements"));

  const tradeIns = app.findCollectionByNameOrId("trade_ins");
  tradeIns.fields.removeByName("cash_session");
  app.save(tradeIns);

  app.delete(app.findCollectionByNameOrId("cash_sessions"));
});
