/// <reference path="../pb_data/types.d.ts" />

/**
 * Ops and reporting collections: pricing rules, labels, imports/exports,
 * daily stats, saved reports, notifications, push subscriptions, the
 * audit log and the single settings record.
 *
 * See docs/PLAN.md, "Data model (PocketBase collections) > Ops and
 * reporting" and "Security, GDPR and record keeping".
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const ADMIN_ONLY = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';
  const PUBLIC = "";
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  const staff = app.findCollectionByNameOrId("staff");
  const customers = app.findCollectionByNameOrId("customers");
  const games = app.findCollectionByNameOrId("games");
  const items = app.findCollectionByNameOrId("items");
  const sales = app.findCollectionByNameOrId("sales");

  // ---------------------------------------------------------------------
  // pricing_rules: admin-only (named explicitly in "API rules in short").
  // ---------------------------------------------------------------------
  const pricingRules = new Collection({
    name: "pricing_rules",
    type: "base",
    listRule: ADMIN_ONLY,
    viewRule: ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "game", type: "relation", collectionId: games.id, maxSelect: 1 }, // empty = any game
      {
        name: "kind",
        type: "select",
        maxSelect: 1,
        values: ["single", "graded", "retro", "sealed", "accessory", "other"],
      },
      // Free text, not the items.condition select: a pricing rule also
      // needs to key on retro completeness (loose/boxed/cib), which is a
      // different enum, and "" acts as a wildcard (see the seed's retro
      // and sealed rows, which apply regardless of completeness).
      { name: "condition", type: "text", max: 40 },
      { name: "finish", type: "text", max: 60 },
      { name: "rarity", type: "text", max: 100 },
      { name: "band_min", type: "number", onlyInt: true, min: 0 },
      { name: "band_max", type: "number", onlyInt: true, min: 0 }, // empty = open-ended band
      { name: "cash_pct", type: "number", min: 0 },
      { name: "credit_pct", type: "number", min: 0 },
      { name: "rounding", type: "number", onlyInt: true, min: 0 }, // pence step
      { name: "priority", type: "number", onlyInt: true },
      { name: "active", type: "bool" },
      ...autodates(),
    ],
  });
  app.save(pricingRules);

  // ---------------------------------------------------------------------
  // label_templates / label_jobs
  // ---------------------------------------------------------------------
  const labelTemplates = new Collection({
    name: "label_templates",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "key", type: "text", required: true, max: 60 },
      { name: "name", type: "text", required: true, max: 100 },
      { name: "width_mm", type: "number", required: true, min: 1 },
      { name: "height_mm", type: "number", required: true, min: 1 },
      { name: "dpi", type: "number", onlyInt: true, min: 0 },
      { name: "active", type: "bool" },
      ...autodates(),
    ],
  });
  labelTemplates.addIndex("idx_label_templates_key_unique", true, "key", "");
  app.save(labelTemplates);

  const labelJobs = new Collection({
    name: "label_jobs",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "item", type: "relation", required: true, collectionId: items.id, maxSelect: 1 },
      { name: "template", type: "relation", required: true, collectionId: labelTemplates.id, maxSelect: 1 },
      { name: "copies", type: "number", onlyInt: true, min: 1 },
      { name: "status", type: "select", maxSelect: 1, values: ["queued", "printed", "cancelled"] },
      { name: "requested_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "printed_at", type: "date" },
      ...autodates(),
    ],
  });
  app.save(labelJobs);

  // ---------------------------------------------------------------------
  // sumup_transactions / csv_imports
  // ---------------------------------------------------------------------
  const sumupTransactions = new Collection({
    name: "sumup_transactions",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "sumup_id", type: "text", required: true, max: 100 },
      { name: "transaction_code", type: "text", max: 100 },
      { name: "timestamp", type: "date" },
      { name: "amount", type: "number", onlyInt: true },
      { name: "payment_type", type: "text", max: 60 },
      { name: "status", type: "text", max: 60 },
      { name: "products", type: "json", maxSize: 20000 },
      { name: "matched_sale", type: "relation", collectionId: sales.id, maxSelect: 1 },
      { name: "fetched_at", type: "date" },
      ...autodates(),
    ],
  });
  sumupTransactions.addIndex("idx_sumup_transactions_sumup_id_unique", true, "sumup_id", "");
  app.save(sumupTransactions);

  const csvImports = new Collection({
    name: "csv_imports",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      {
        name: "type",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["card_uploader", "ebay_orders", "sumup_sales"],
      },
      { name: "file", type: "file", maxSelect: 1, maxSize: 26214400, mimeTypes: ["text/csv", "text/plain", "application/vnd.ms-excel"] },
      {
        name: "status",
        type: "select",
        maxSelect: 1,
        values: ["pending", "processing", "done", "failed"],
      },
      { name: "rows_total", type: "number", onlyInt: true, min: 0 },
      { name: "rows_ok", type: "number", onlyInt: true, min: 0 },
      { name: "errors", type: "json", maxSize: 50000 },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  app.save(csvImports);

  // ---------------------------------------------------------------------
  // daily_stats: built nightly and on demand; staff-only reporting data.
  // ---------------------------------------------------------------------
  const dailyStats = new Collection({
    name: "daily_stats",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "date", type: "date", required: true },
      { name: "sales_count", type: "number", onlyInt: true, min: 0 },
      { name: "sales_total_by_payment", type: "json", maxSize: 5000 },
      { name: "buy_in_count", type: "number", onlyInt: true, min: 0 },
      { name: "buy_in_total_by_payout", type: "json", maxSize: 5000 },
      { name: "items_in", type: "number", onlyInt: true },
      { name: "items_out", type: "number", onlyInt: true },
      { name: "stock_value_cost", type: "number", onlyInt: true, min: 0 },
      { name: "stock_value_market", type: "number", onlyInt: true, min: 0 },
      { name: "credit_issued", type: "number", onlyInt: true, min: 0 },
      { name: "credit_redeemed", type: "number", onlyInt: true, min: 0 },
      { name: "points_earned", type: "number", onlyInt: true, min: 0 },
      { name: "points_redeemed", type: "number", onlyInt: true, min: 0 },
      { name: "cash_variance", type: "number", onlyInt: true },
      { name: "new_customers", type: "number", onlyInt: true, min: 0 },
      { name: "returning_customers", type: "number", onlyInt: true, min: 0 },
      ...autodates(),
    ],
  });
  dailyStats.addIndex("idx_daily_stats_date_unique", true, "date", "");
  app.save(dailyStats);

  // ---------------------------------------------------------------------
  // saved_reports
  // ---------------------------------------------------------------------
  const savedReports = new Collection({
    name: "saved_reports",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "owner", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "report_key", type: "text", required: true, max: 100 },
      { name: "filters", type: "json", maxSize: 20000 },
      { name: "name", type: "text", max: 200 },
      { name: "schedule", type: "select", maxSelect: 1, values: ["none", "weekly", "monthly"] },
      { name: "recipients", type: "json", maxSize: 5000 },
      ...autodates(),
    ],
  });
  app.save(savedReports);

  // ---------------------------------------------------------------------
  // notifications / push_subscriptions
  // ---------------------------------------------------------------------
  const notifications = new Collection({
    name: "notifications",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: STAFF_ONLY,
    updateRule: `${STAFF_ONLY} || customer = @request.auth.id`, // lets a customer mark their own read_at
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "customer", type: "relation", collectionId: customers.id, maxSelect: 1 },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "type", type: "text", max: 60 },
      { name: "title", type: "text", max: 200 },
      { name: "body", type: "text", max: 2000 },
      { name: "link", type: "text", max: 500 },
      { name: "read_at", type: "date" },
      { name: "pushed_at", type: "date" },
      ...autodates(),
    ],
  });
  app.save(notifications);

  const pushSubscriptions = new Collection({
    name: "push_subscriptions",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule:
      '(@request.auth.collectionName = "customers" && customer = @request.auth.id) || ' +
      '(@request.auth.collectionName = "staff" && staff = @request.auth.id)',
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "customer", type: "relation", collectionId: customers.id, maxSelect: 1 },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "endpoint", type: "text", required: true, max: 1000 },
      { name: "keys", type: "json", maxSize: 5000 },
      ...autodates(),
    ],
  });
  app.save(pushSubscriptions);

  // ---------------------------------------------------------------------
  // audit_log: superuser-only end to end. Written by pb_hooks/audit.pb.js
  // and pb_hooks/lib/audit.js, and by future custom routes, all through
  // $app - never through a client-facing rule.
  // ---------------------------------------------------------------------
  const auditLog = new Collection({
    name: "audit_log",
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // Staff record id, or "system" for cron/hook-only actions - a plain
      // text field rather than a relation so a system-triggered row never
      // fails validation for lack of an authenticated staff id.
      { name: "actor", type: "text", max: 60 },
      { name: "action", type: "text", max: 100 },
      { name: "collection", type: "text", max: 100 },
      { name: "record", type: "text", max: 40 },
      { name: "meta", type: "json", maxSize: 20000 },
      { name: "ip", type: "text", max: 64 },
      ...autodates(),
    ],
  });
  app.save(auditLog);

  // ---------------------------------------------------------------------
  // settings: single record, admin-only (contains server-side API keys).
  // Singleton enforced by pb_hooks/singletons.pb.js.
  // ---------------------------------------------------------------------
  const settings = new Collection({
    name: "settings",
    type: "base",
    listRule: ADMIN_ONLY,
    viewRule: ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "cash_cap", type: "number", onlyInt: true, min: 0 },
      { name: "min_single_offer", type: "number", onlyInt: true, min: 0 },
      { name: "bulk_rate_pct", type: "number", min: 0 },
      { name: "source_priority", type: "json", maxSize: 5000 },
      { name: "retro_source_priority", type: "json", maxSize: 5000 },
      { name: "condition_multipliers", type: "json", maxSize: 5000 },
      { name: "markup_bands", type: "json", maxSize: 5000 },
      { name: "sell_rounding", type: "select", maxSelect: 1, values: ["49_99"] },
      { name: "label_default_template", type: "relation", collectionId: labelTemplates.id, maxSelect: 1 },
      { name: "quote_expiry_days", type: "number", onlyInt: true, min: 0 },
      { name: "id_photo_retention_months", type: "number", onlyInt: true, min: 0 },
      { name: "vat_registered", type: "bool" },
      { name: "shop_name", type: "text", max: 200 },
      { name: "shop_address", type: "text", max: 500 },
      { name: "shop_town", type: "text", max: 100 },
      { name: "shop_postcode", type: "text", max: 20 },
      { name: "shop_phone", type: "text", max: 40 },
      { name: "shop_email", type: "email" },
      { name: "email_provider", type: "select", maxSelect: 1, values: ["resend", "postmark", "brevo", "none"] },
      { name: "email_api_key", type: "text", max: 500 },
      { name: "push_vapid_public_key", type: "text", max: 500 },
      { name: "push_vapid_private_key", type: "text", max: 500 },
      // Everything else (PriceCharting, eBay, IGDB, ...) - a flexible
      // bucket rather than one named field per provider, since the exact
      // set of adapters is still growing (see docs/PLAN.md "Card images
      // and market prices").
      { name: "api_keys", type: "json", maxSize: 20000 },
      ...autodates(),
    ],
  });
  app.save(settings);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("settings"));
  app.delete(app.findCollectionByNameOrId("audit_log"));
  app.delete(app.findCollectionByNameOrId("push_subscriptions"));
  app.delete(app.findCollectionByNameOrId("notifications"));
  app.delete(app.findCollectionByNameOrId("saved_reports"));
  app.delete(app.findCollectionByNameOrId("daily_stats"));
  app.delete(app.findCollectionByNameOrId("csv_imports"));
  app.delete(app.findCollectionByNameOrId("sumup_transactions"));
  app.delete(app.findCollectionByNameOrId("label_jobs"));
  app.delete(app.findCollectionByNameOrId("label_templates"));
  app.delete(app.findCollectionByNameOrId("pricing_rules"));
});
