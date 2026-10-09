/// <reference path="../pb_data/types.d.ts" />

/**
 * EPOS schema (docs/EPOS-PLAN.md, Phase 8; docs/api-contract-epos.md).
 *
 * Every collection and field the till needs, laid in one migration before
 * the routes are written, so the staff, till, sales and printing packages
 * can be built side by side against the same schema.
 *
 * New: `till_events`, `till_reports`, `sale_tenders`, `parked_tickets`,
 * `till_categories`, `till_products`, `till_keys`, `printers`, `print_jobs`,
 * `till_overrides`.
 *
 * Changed:
 * - `staff`: `pin_length` (4 or 6, 0 for none).
 * - `cash_sessions`: `register`, the opening and closing counts by
 *   denomination, the card totals and the Z report link. The shop-wide "one
 *   open session" index becomes one open session per register. Existing
 *   rows move to the default register.
 * - `cash_movements`: types `paid_in` and `paid_out`, plus `reason` and
 *   `approver`.
 * - `sales`: `register`, `vat_total`, `trade_in`, `refund_count`, and the
 *   payment values `card_tide`, `card_other`, `part_exchange`, `gift_card`.
 *   Existing rows move to the default register.
 * - `sale_lines`: `item` is no longer required (a till product line has
 *   none); `product`, `title`, `vat_amount`, `note`; tax scheme `exempt`.
 * - `trade_ins`: `sale`, for a part-exchange.
 *
 * Collection rules here are for reading. The money collections keep their
 * existing write rules until the routes that replace those writes land
 * (the lockdown in docs/api-contract-epos.md, section 4, is its own
 * migration); every new money collection is route-only from the start.
 *
 * Seeds: four till categories ("Quick", "Sealed", "Accessories",
 * "Services"), five till products and the quick keys for them. The Guild
 * Membership product is seeded switched off: it needs a paid-plan tier to
 * grant, which Phase 10 sets up.
 */

const STAFF_ONLY = '@request.auth.collectionName = "staff"';
const MANAGER_UP =
  '@request.auth.collectionName = "staff" && (@request.auth.role = "admin" || @request.auth.role = "manager")';

const TENDER_METHODS = [
  "cash",
  "card_tide",
  "card_other",
  "store_credit",
  "points",
  "part_exchange",
  "gift_card",
  "sumup_card",
];

function autodates() {
  return [
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
}

function rel(name, collection, extra) {
  const field = {
    name: name,
    type: "relation",
    collectionId: collection.id,
    maxSelect: 1,
    cascadeDelete: false,
  };
  if (extra) {
    for (const key in extra) field[key] = extra[key];
  }
  return field;
}

function int(name, extra) {
  const field = { name: name, type: "number", onlyInt: true };
  if (extra) {
    for (const key in extra) field[key] = extra[key];
  }
  return field;
}

migrate(
  (app) => {
    const staff = app.findCollectionByNameOrId("staff");
    const customers = app.findCollectionByNameOrId("customers");
    const items = app.findCollectionByNameOrId("items");
    const registers = app.findCollectionByNameOrId("registers");
    const devices = app.findCollectionByNameOrId("register_devices");
    const tiers = app.findCollectionByNameOrId("loyalty_tiers");
    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    const cashSessions = app.findCollectionByNameOrId("cash_sessions");
    const cashMovements = app.findCollectionByNameOrId("cash_movements");
    const sales = app.findCollectionByNameOrId("sales");
    const saleLines = app.findCollectionByNameOrId("sale_lines");

    // How many digits the PIN has (4 or 6, 0 for none), so the lock
    // screen draws the right number of dots and unlocks on the last digit
    // without an Enter key. The hash says nothing about the PIN itself.
    staff.fields.add(new Field(int("pin_length", { min: 0, max: 6 })));
    app.save(staff);

    // The default register: the active one with the lowest sort.
    const defaults = app.findRecordsByFilter("registers", "active = true", "sort,created", 1, 0);
    const defaultRegister = defaults.length ? defaults[0].id : "";

    // -----------------------------------------------------------------
    // till_events: voids, no sales, overrides and reprints
    // -----------------------------------------------------------------
    const tillEvents = new Collection({
      type: "base",
      name: "till_events",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        rel("register", registers, { required: true }),
        rel("session", cashSessions),
        {
          name: "kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["void_line", "void_ticket", "no_sale", "override", "reprint"],
        },
        // Signed pence; not required because 0 is a real value.
        int("amount"),
        { name: "detail", type: "json", maxSize: 20000 },
        rel("staff", staff),
        rel("approver", staff),
      ].concat(autodates()),
      indexes: [
        "CREATE INDEX idx_till_events_session ON till_events (session)",
        "CREATE INDEX idx_till_events_register_created ON till_events (register, created)",
      ],
    });
    app.save(tillEvents);

    // -----------------------------------------------------------------
    // till_reports: numbered X and Z reports
    // -----------------------------------------------------------------
    const tillReports = new Collection({
      type: "base",
      name: "till_reports",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "type", type: "select", required: true, maxSelect: 1, values: ["x", "z"] },
        int("number", { min: 1 }),
        rel("register", registers, { required: true }),
        rel("session", cashSessions, { required: true }),
        { name: "period_start", type: "date" },
        { name: "period_end", type: "date" },
        // A TillReport (packages/shared/src/epos-types.ts).
        { name: "data", type: "json", maxSize: 500000 },
        rel("created_by", staff),
      ].concat(autodates()),
      indexes: [
        "CREATE UNIQUE INDEX idx_till_reports_type_number ON till_reports (type, number)",
        "CREATE INDEX idx_till_reports_session ON till_reports (session)",
        "CREATE INDEX idx_till_reports_register_created ON till_reports (register, created)",
      ],
    });
    app.save(tillReports);

    // -----------------------------------------------------------------
    // cash_sessions: per register, counted by denomination
    // -----------------------------------------------------------------
    cashSessions.fields.add(new Field(rel("register", registers)));
    cashSessions.fields.add(new Field({ name: "opening_counts", type: "json", maxSize: 2000 }));
    cashSessions.fields.add(new Field({ name: "closing_counts", type: "json", maxSize: 2000 }));
    cashSessions.fields.add(new Field(int("card_till_total")));
    cashSessions.fields.add(new Field(int("card_reported_total")));
    cashSessions.fields.add(new Field(int("card_variance")));
    cashSessions.fields.add(new Field(rel("z_report", tillReports)));
    app.save(cashSessions);

    if (defaultRegister) {
      app.findRecordsByFilter("cash_sessions", "register = ''", "", 0, 0).forEach((row) => {
        row.set("register", defaultRegister);
        app.saveNoValidate(row);
      });
    }

    // The one-open-session index was shop-wide (closed_at only). It is now
    // per register, so two tills can each have their own drawer open.
    cashSessions.indexes = [
      "CREATE UNIQUE INDEX idx_cash_sessions_one_open_per_register ON cash_sessions (register) WHERE closed_at = ''",
      "CREATE INDEX idx_cash_sessions_register_opened ON cash_sessions (register, opened_at)",
    ];
    app.save(cashSessions);

    // -----------------------------------------------------------------
    // cash_movements: paid in and out, with a reason and an approver
    // -----------------------------------------------------------------
    const movementType = cashMovements.fields.getByName("type");
    movementType.values = [
      "float_in",
      "payout",
      "cash_sale",
      "refund",
      "bank_drop",
      "adjustment",
      "paid_in",
      "paid_out",
    ];
    cashMovements.fields.add(new Field({ name: "reason", type: "text", max: 300 }));
    cashMovements.fields.add(new Field(rel("approver", staff)));
    cashMovements.indexes = ["CREATE INDEX idx_cash_movements_session ON cash_movements (session)"];
    app.save(cashMovements);

    // -----------------------------------------------------------------
    // till_categories, till_products, till_keys: what the till's tiles show
    // -----------------------------------------------------------------
    const tillCategories = new Collection({
      type: "base",
      name: "till_categories",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      deleteRule: MANAGER_UP,
      fields: [
        { name: "name", type: "text", required: true, max: 40 },
        int("sort"),
        { name: "active", type: "bool" },
        // Optional: { kinds?: [...], games?: [...] } makes it a dynamic
        // category listing the in-stock stock lines that match.
        { name: "filter", type: "json", maxSize: 2000 },
      ].concat(autodates()),
      indexes: ["CREATE UNIQUE INDEX idx_till_categories_name ON till_categories (name)"],
    });
    app.save(tillCategories);

    const tillProducts = new Collection({
      type: "base",
      name: "till_products",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      // Sale lines point at products; switch one off instead.
      deleteRule: null,
      fields: [
        { name: "name", type: "text", required: true, max: 100 },
        {
          name: "kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["service", "open_price", "membership", "deposit"],
        },
        // Pence. Ignored for open_price, where the till keys the price.
        int("price", { min: 0 }),
        rel("category", tillCategories),
        {
          name: "image",
          type: "file",
          maxSelect: 1,
          maxSize: 5242880,
          mimeTypes: ["image/png", "image/jpeg", "image/webp"],
          thumbs: ["160x0", "320x0"],
        },
        {
          name: "tax_scheme",
          type: "select",
          maxSelect: 1,
          values: ["standard", "margin", "exempt"],
        },
        // Percent, not pence.
        { name: "vat_rate", type: "number", min: 0, max: 100 },
        { name: "barcode", type: "text", max: 32 },
        rel("membership_tier", tiers),
        int("membership_months", { min: 0 }),
        { name: "active", type: "bool" },
        int("sort"),
      ].concat(autodates()),
      indexes: [
        "CREATE UNIQUE INDEX idx_till_products_barcode ON till_products (barcode) WHERE barcode != ''",
        "CREATE INDEX idx_till_products_category ON till_products (category)",
      ],
    });
    app.save(tillProducts);

    const tillKeys = new Collection({
      type: "base",
      name: "till_keys",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      deleteRule: MANAGER_UP,
      fields: [
        rel("category", tillCategories, { required: true, cascadeDelete: true }),
        int("position", { min: 0 }),
        // Exactly one of item (a stock line) or product.
        rel("item", items, { cascadeDelete: true }),
        rel("product", tillProducts, { cascadeDelete: true }),
        { name: "label", type: "text", max: 40 },
      ].concat(autodates()),
      indexes: ["CREATE INDEX idx_till_keys_category_position ON till_keys (category, position)"],
    });
    app.save(tillKeys);

    // -----------------------------------------------------------------
    // sales and sale_lines
    // -----------------------------------------------------------------
    sales.fields.getByName("payment").values = [
      "sumup_card",
      "cash",
      "store_credit",
      "points",
      "mixed",
      "card_tide",
      "card_other",
      "part_exchange",
      "gift_card",
    ];
    sales.fields.add(new Field(rel("register", registers)));
    sales.fields.add(new Field(int("vat_total", { min: 0 })));
    sales.fields.add(new Field(rel("trade_in", tradeIns)));
    // How many refunds this sale has had: the n in GG-S-000456-Rn.
    sales.fields.add(new Field(int("refund_count", { min: 0 })));
    sales.addIndex("idx_sales_cash_session", false, "cash_session", "");
    sales.addIndex("idx_sales_register_occurred", false, "register, occurred_at", "");
    app.save(sales);

    if (defaultRegister) {
      app
        .findRecordsByFilter("sales", "register = '' && channel != 'ebay'", "", 0, 0)
        .forEach((row) => {
          row.set("register", defaultRegister);
          app.saveNoValidate(row);
        });
    }

    saleLines.fields.getByName("item").required = false;
    saleLines.fields.getByName("tax_scheme").values = ["margin", "standard", "exempt"];
    saleLines.fields.add(new Field(rel("product", tillProducts)));
    // What the line was called when it was sold, so a renamed product or
    // an open-price "Single card: Charizard ex" reads the same for good.
    saleLines.fields.add(new Field({ name: "title", type: "text", max: 300 }));
    saleLines.fields.add(new Field(int("vat_amount", { min: 0 })));
    saleLines.fields.add(new Field({ name: "note", type: "text", max: 200 }));
    saleLines.addIndex("idx_sale_lines_sale", false, "sale", "");
    app.save(saleLines);

    tradeIns.fields.add(new Field(rel("sale", sales)));
    app.save(tradeIns);

    // -----------------------------------------------------------------
    // sale_tenders: one row per payment on a sale or a refund
    // -----------------------------------------------------------------
    const saleTenders = new Collection({
      type: "base",
      name: "sale_tenders",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        rel("sale", sales, { required: true }),
        // Empty for the sale itself; GG-S-000456-R1 for a refund.
        { name: "refund_ref", type: "text", max: 30 },
        { name: "method", type: "select", required: true, maxSelect: 1, values: TENDER_METHODS },
        // Signed pence: positive taken, negative given back.
        int("amount"),
        int("tendered", { min: 0 }),
        int("change", { min: 0 }),
        { name: "card_last4", type: "text", max: 4 },
        { name: "reference", type: "text", max: 60 },
        rel("register", registers),
        rel("session", cashSessions),
        rel("staff", staff),
      ].concat(autodates()),
      indexes: [
        "CREATE INDEX idx_sale_tenders_sale ON sale_tenders (sale)",
        "CREATE INDEX idx_sale_tenders_session ON sale_tenders (session)",
        "CREATE INDEX idx_sale_tenders_register_created ON sale_tenders (register, created)",
      ],
    });
    app.save(saleTenders);

    // -----------------------------------------------------------------
    // parked_tickets
    // -----------------------------------------------------------------
    const parked = new Collection({
      type: "base",
      name: "parked_tickets",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: STAFF_ONLY,
      updateRule: STAFF_ONLY,
      deleteRule: STAFF_ONLY,
      fields: [
        rel("register", registers, { required: true }),
        { name: "label", type: "text", required: true, max: 60 },
        rel("customer", customers),
        rel("staff", staff),
        // The ticket exactly as the counter holds it.
        { name: "payload", type: "json", maxSize: 200000 },
        int("total"),
        { name: "item_ids", type: "json", maxSize: 20000 },
      ].concat(autodates()),
      indexes: ["CREATE INDEX idx_parked_tickets_register ON parked_tickets (register)"],
    });
    app.save(parked);

    // -----------------------------------------------------------------
    // printers and print_jobs (Star CloudPRNT)
    // -----------------------------------------------------------------
    const printers = new Collection({
      type: "base",
      name: "printers",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "name", type: "text", required: true, max: 60 },
        { name: "model", type: "text", max: 60 },
        // Lowercase aa:bb:cc:dd:ee:ff.
        {
          name: "mac",
          type: "text",
          required: true,
          max: 17,
          pattern: "^[0-9a-f]{2}(:[0-9a-f]{2}){5}$",
        },
        { name: "token_hash", type: "text", required: true, max: 200, hidden: true },
        rel("register", registers),
        // 80 or 58 (millimetres of paper).
        int("paper_width", { min: 58, max: 80 }),
        { name: "active", type: "bool" },
        { name: "last_poll_at", type: "date" },
        { name: "last_status", type: "text", max: 200 },
        { name: "encodings", type: "json", maxSize: 2000 },
      ].concat(autodates()),
      indexes: [
        "CREATE UNIQUE INDEX idx_printers_mac ON printers (mac)",
        "CREATE UNIQUE INDEX idx_printers_token_hash ON printers (token_hash)",
      ],
    });
    app.save(printers);

    const printJobs = new Collection({
      type: "base",
      name: "print_jobs",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        rel("printer", printers, { required: true, cascadeDelete: true }),
        rel("register", registers),
        {
          name: "kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: [
            "receipt",
            "gift_receipt",
            "refund_receipt",
            "x_report",
            "z_report",
            "drawer",
            "test",
          ],
        },
        // The sale, report or event the job prints.
        { name: "ref", type: "text", max: 40 },
        {
          name: "format",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["image/png", "text/plain", "application/vnd.star.line"],
        },
        {
          name: "file",
          type: "file",
          maxSelect: 1,
          maxSize: 2097152,
          mimeTypes: ["image/png"],
          protected: true,
        },
        { name: "text", type: "text", max: 20000 },
        { name: "drawer", type: "bool" },
        { name: "cut", type: "bool" },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["queued", "printing", "done", "failed", "cancelled"],
        },
        int("attempts", { min: 0 }),
        { name: "error", type: "text", max: 300 },
        rel("created_by", staff),
        { name: "claimed_at", type: "date" },
        { name: "printed_at", type: "date" },
      ].concat(autodates()),
      indexes: [
        "CREATE INDEX idx_print_jobs_printer_status ON print_jobs (printer, status, created)",
        "CREATE INDEX idx_print_jobs_register_created ON print_jobs (register, created)",
      ],
    });
    app.save(printJobs);

    // -----------------------------------------------------------------
    // till_overrides: a manager's single-use approval (route-only)
    // -----------------------------------------------------------------
    const overrides = new Collection({
      type: "base",
      name: "till_overrides",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "token_hash", type: "text", required: true, max: 200, hidden: true },
        { name: "capability", type: "text", required: true, max: 40 },
        rel("requested_by", staff, { required: true }),
        rel("approver", staff, { required: true }),
        rel("register", registers),
        rel("device", devices),
        { name: "context", type: "json", maxSize: 5000 },
        { name: "expires_at", type: "date", required: true },
        { name: "used_at", type: "date" },
        // What used it: "<route>:<record id>".
        { name: "used_for", type: "text", max: 120 },
      ].concat(autodates()),
      indexes: ["CREATE UNIQUE INDEX idx_till_overrides_token_hash ON till_overrides (token_hash)"],
    });
    app.save(overrides);

    // -----------------------------------------------------------------
    // Seeds: categories, products and the quick keys
    // -----------------------------------------------------------------
    const categoryIds = {};
    [
      { name: "Quick", sort: 0, filter: null },
      { name: "Sealed", sort: 10, filter: { kinds: ["sealed"] } },
      { name: "Accessories", sort: 20, filter: { kinds: ["accessory"] } },
      { name: "Services", sort: 30, filter: null },
    ].forEach((c) => {
      const row = new Record(tillCategories);
      row.set("name", c.name);
      row.set("sort", c.sort);
      row.set("active", true);
      if (c.filter) row.set("filter", c.filter);
      app.save(row);
      categoryIds[c.name] = row.id;
    });

    const products = [
      {
        name: "Single card",
        kind: "open_price",
        price: 0,
        tax_scheme: "margin",
        vat_rate: 20,
        category: "Quick",
        active: true,
      },
      {
        name: "Table time, 1 hour",
        kind: "service",
        price: 500,
        tax_scheme: "standard",
        vat_rate: 20,
        category: "Services",
        active: true,
      },
      {
        name: "Event entry",
        kind: "open_price",
        price: 0,
        tax_scheme: "standard",
        vat_rate: 20,
        category: "Services",
        active: true,
      },
      {
        name: "Deposit",
        kind: "deposit",
        price: 0,
        tax_scheme: "exempt",
        vat_rate: 0,
        category: "Services",
        active: true,
      },
      {
        name: "Guild Membership, 12 months",
        kind: "membership",
        price: 2400,
        tax_scheme: "standard",
        vat_rate: 20,
        category: "Services",
        membership_months: 12,
        // Off until a paid-plan tier exists for it to grant (Phase 10).
        active: false,
      },
    ];
    products.forEach((p, index) => {
      const row = new Record(tillProducts);
      row.set("name", p.name);
      row.set("kind", p.kind);
      row.set("price", p.price);
      row.set("tax_scheme", p.tax_scheme);
      row.set("vat_rate", p.vat_rate);
      row.set("category", categoryIds[p.category]);
      row.set("membership_months", p.membership_months || 0);
      row.set("active", p.active);
      row.set("sort", (index + 1) * 10);
      app.save(row);

      const key = new Record(tillKeys);
      key.set("category", categoryIds.Quick);
      key.set("position", index + 1);
      key.set("product", row.id);
      app.save(key);
    });
  },
  (app) => {
    const staff = app.findCollectionByNameOrId("staff");
    staff.fields.removeByName("pin_length");
    app.save(staff);

    ["till_overrides", "print_jobs", "printers", "parked_tickets", "sale_tenders"].forEach((name) => {
      app.delete(app.findCollectionByNameOrId(name));
    });

    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    tradeIns.fields.removeByName("sale");
    app.save(tradeIns);

    // A line with no item cannot survive the old required rule, and its
    // product is about to go, so product lines go with it.
    app.findRecordsByFilter("sale_lines", "item = ''", "", 0, 0).forEach((row) => {
      app.delete(row);
    });
    const saleLines = app.findCollectionByNameOrId("sale_lines");
    saleLines.fields.removeByName("product");
    saleLines.fields.removeByName("title");
    saleLines.fields.removeByName("vat_amount");
    saleLines.fields.removeByName("note");
    saleLines.fields.getByName("item").required = true;
    app.findRecordsByFilter("sale_lines", "tax_scheme = 'exempt'", "", 0, 0).forEach((row) => {
      row.set("tax_scheme", "standard");
      app.saveNoValidate(row);
    });
    saleLines.fields.getByName("tax_scheme").values = ["margin", "standard"];
    saleLines.removeIndex("idx_sale_lines_sale");
    app.save(saleLines);

    const sales = app.findCollectionByNameOrId("sales");
    app
      .findRecordsByFilter(
        "sales",
        "payment = 'card_tide' || payment = 'card_other' || payment = 'part_exchange' || payment = 'gift_card'",
        "",
        0,
        0
      )
      .forEach((row) => {
        row.set("payment", "mixed");
        app.saveNoValidate(row);
      });
    sales.fields.getByName("payment").values = ["sumup_card", "cash", "store_credit", "points", "mixed"];
    sales.fields.removeByName("register");
    sales.fields.removeByName("vat_total");
    sales.fields.removeByName("trade_in");
    sales.fields.removeByName("refund_count");
    sales.removeIndex("idx_sales_cash_session");
    sales.removeIndex("idx_sales_register_occurred");
    app.save(sales);

    ["till_keys", "till_products", "till_categories"].forEach((name) => {
      app.delete(app.findCollectionByNameOrId(name));
    });

    const cashMovements = app.findCollectionByNameOrId("cash_movements");
    app
      .findRecordsByFilter("cash_movements", "type = 'paid_in' || type = 'paid_out'", "", 0, 0)
      .forEach((row) => {
        row.set("type", "adjustment");
        app.saveNoValidate(row);
      });
    cashMovements.fields.getByName("type").values = [
      "float_in",
      "payout",
      "cash_sale",
      "refund",
      "bank_drop",
      "adjustment",
    ];
    cashMovements.fields.removeByName("reason");
    cashMovements.fields.removeByName("approver");
    cashMovements.indexes = [];
    app.save(cashMovements);

    const cashSessions = app.findCollectionByNameOrId("cash_sessions");
    cashSessions.fields.removeByName("z_report");
    cashSessions.indexes = [];
    app.save(cashSessions);

    app.delete(app.findCollectionByNameOrId("till_reports"));
    app.delete(app.findCollectionByNameOrId("till_events"));

    cashSessions.fields.removeByName("register");
    cashSessions.fields.removeByName("opening_counts");
    cashSessions.fields.removeByName("closing_counts");
    cashSessions.fields.removeByName("card_till_total");
    cashSessions.fields.removeByName("card_reported_total");
    cashSessions.fields.removeByName("card_variance");
    // Only one session can be open shop-wide again; any extra open ones
    // would break the old index, so close all but the newest.
    const open = app.findRecordsByFilter("cash_sessions", "closed_at = ''", "-opened_at", 0, 0);
    open.slice(1).forEach((row) => {
      row.set("closed_at", new Date().toISOString());
      app.saveNoValidate(row);
    });
    cashSessions.indexes = [
      "CREATE UNIQUE INDEX `idx_cash_sessions_one_open` ON `cash_sessions` (closed_at) WHERE closed_at = ''",
    ];
    app.save(cashSessions);
  }
);
