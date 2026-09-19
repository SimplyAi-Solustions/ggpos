/// <reference path="../pb_data/types.d.ts" />

/**
 * Trading collections: trade-ins (cash/credit buy-ins), remote quotes,
 * staff notes and the store credit ledger.
 *
 * See docs/PLAN.md, "Data model (PocketBase collections) > Trading" and
 * "Core flows and rules > Trade-in completion".
 *
 * Trade-in completion itself is a custom route inside $app.runInTransaction
 * (later phase), not a direct write - these rules only gate the draft
 * lifecycle and staff/customer reads.
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  const customers = app.findCollectionByNameOrId("customers");
  const staff = app.findCollectionByNameOrId("staff");
  const cards = app.findCollectionByNameOrId("cards");
  const retroTitles = app.findCollectionByNameOrId("retro_titles");
  const items = app.findCollectionByNameOrId("items");

  // ---------------------------------------------------------------------
  // quotes: customer submits photos for a remote valuation. Customers can
  // create their own (task brief) and can update it themselves too so the
  // portal's accept/decline step works ("status timeline; accept or
  // decline" in PLAN.md's portal screens) - that is an update, not a
  // create or delete, so it does not conflict with "customers must never
  // create or delete except quotes, want_list, push_subscriptions".
  // ---------------------------------------------------------------------
  const quotes = new Collection({
    name: "quotes",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: `${STAFF_ONLY} || (@request.auth.collectionName = "customers" && customer = @request.auth.id)`,
    updateRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      {
        name: "status",
        type: "select",
        maxSelect: 1,
        values: [
          "submitted",
          "reviewing",
          "offered",
          "accepted",
          "declined",
          "expired",
          "received",
          "completed",
        ],
      },
      { name: "photos", type: "file", maxSelect: 20, maxSize: 10485760, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
      { name: "message", type: "text", max: 4000 },
      { name: "lines", type: "json", maxSize: 50000 },
      { name: "offer_total", type: "number", onlyInt: true, min: 0 },
      { name: "offer_expires_at", type: "date" },
      { name: "customer_reply", type: "text", max: 2000 },
      { name: "drop_off", type: "select", maxSelect: 1, values: ["in_store", "post"] },
      ...autodates(),
    ],
  });
  app.save(quotes);

  // ---------------------------------------------------------------------
  // trade_ins. Customer-readable (own) per "API rules in short"; writes
  // are staff only, completion is a custom route.
  // ---------------------------------------------------------------------
  const tradeIns = new Collection({
    name: "trade_ins",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "number", type: "text", required: true, max: 20 }, // GG-BI-000123, see lib/counters.js
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "channel", type: "select", maxSelect: 1, values: ["counter", "remote"] },
      {
        name: "status",
        type: "select",
        maxSelect: 1,
        values: ["draft", "offered", "accepted", "completed", "declined", "cancelled"],
      },
      { name: "payout_type", type: "select", maxSelect: 1, values: ["cash", "credit", "mixed"] },
      { name: "total_market", type: "number", onlyInt: true, min: 0 },
      { name: "total_offer", type: "number", onlyInt: true, min: 0 },
      { name: "payout_cash", type: "number", onlyInt: true, min: 0 },
      { name: "payout_credit", type: "number", onlyInt: true, min: 0 },
      { name: "id_checked", type: "bool" },
      { name: "id_checked_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "signature", type: "file", maxSelect: 1, maxSize: 2097152 },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "completed_at", type: "date" },
      { name: "quote", type: "relation", collectionId: quotes.id, maxSelect: 1 },
      // cash_session -> cash_sessions is added in
      // 1789819440_selling_cash_collections.js once that collection exists.
      // Seller snapshot, taken at completion, so the 6-year register
      // survives a later customer erasure (UK GDPR Article 17(3)(b)).
      { name: "seller_name", type: "text", max: 200 },
      { name: "seller_address", type: "text", max: 1000 },
      { name: "seller_id_type", type: "text", max: 100 },
      { name: "seller_id_last4", type: "text", max: 4 },
      { name: "seller_id_expiry", type: "date" },
      ...autodates(),
    ],
  });
  tradeIns.addIndex("idx_trade_ins_number_unique", true, "number", "");
  app.save(tradeIns);

  // ---------------------------------------------------------------------
  // trade_in_lines. Viewable by the owning customer through the parent
  // trade_in (dot-notation relation filter), not customer-writeable.
  // ---------------------------------------------------------------------
  const tradeInLines = new Collection({
    name: "trade_in_lines",
    type: "base",
    listRule: `${STAFF_ONLY} || trade_in.customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || trade_in.customer = @request.auth.id`,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "trade_in", type: "relation", required: true, collectionId: tradeIns.id, maxSelect: 1, cascadeDelete: true },
      { name: "card", type: "relation", collectionId: cards.id, maxSelect: 1 },
      { name: "retro_title", type: "relation", collectionId: retroTitles.id, maxSelect: 1 },
      { name: "free_text_title", type: "text", max: 300 },
      { name: "finish", type: "text", max: 60 },
      { name: "condition", type: "select", maxSelect: 1, values: ["NM", "LP", "MP", "HP", "DMG"] },
      { name: "qty", type: "number", onlyInt: true, min: 1 },
      { name: "market_price", type: "number", onlyInt: true, min: 0 },
      { name: "market_currency", type: "select", maxSelect: 1, values: ["GBP", "EUR", "USD"] },
      { name: "fx_rate", type: "number", min: 0 },
      { name: "market_source", type: "text", max: 60 },
      { name: "offer_pct", type: "number", min: 0 }, // percent, not pence
      { name: "offer_price", type: "number", onlyInt: true, min: 0 },
      { name: "accepted", type: "bool" },
      { name: "item", type: "relation", collectionId: items.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  app.save(tradeInLines);

  // Now that trade_in_lines exists, complete the items <-> trade_in_lines
  // circular relation started in 1789819320_stock_collections.js.
  items.fields.add(
    new Field({
      name: "trade_in_line",
      type: "relation",
      collectionId: tradeInLines.id,
      maxSelect: 1,
    })
  );
  app.save(items);

  // ---------------------------------------------------------------------
  // notes: staff-only annotations against any target collection/record
  // (quote notes, override reasons, customer notes). Never customer
  // readable.
  // ---------------------------------------------------------------------
  const notes = new Collection({
    name: "notes",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "target_collection", type: "text", required: true, max: 100 },
      { name: "target_record", type: "text", required: true, max: 40 },
      { name: "body", type: "editor" },
      { name: "author", type: "relation", collectionId: staff.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  app.save(notes);

  // ---------------------------------------------------------------------
  // credit_ledger: append-only (per PLAN.md). update/delete are null so
  // even staff can only add corrective entries, never edit history.
  // ---------------------------------------------------------------------
  const creditLedger = new Collection({
    name: "credit_ledger",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: STAFF_ONLY,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      // Not required: PocketBase's required check treats an explicit 0 as
      // blank, and signed pence can legitimately be 0 (e.g. a no-op
      // corrective entry kept for the audit trail).
      { name: "amount", type: "number", onlyInt: true }, // signed pence
      {
        name: "reason",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["trade_in", "sale", "adjustment", "expiry", "reward"],
      },
      { name: "ref", type: "text", max: 100 },
      { name: "balance_after", type: "number", onlyInt: true },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  app.save(creditLedger);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("credit_ledger"));
  app.delete(app.findCollectionByNameOrId("notes"));

  const items = app.findCollectionByNameOrId("items");
  items.fields.removeByName("trade_in_line");
  app.save(items);

  app.delete(app.findCollectionByNameOrId("trade_in_lines"));
  app.delete(app.findCollectionByNameOrId("trade_ins"));
  app.delete(app.findCollectionByNameOrId("quotes"));
});
