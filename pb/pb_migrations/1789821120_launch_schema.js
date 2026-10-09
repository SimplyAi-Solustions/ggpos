/// <reference path="../pb_data/types.d.ts" />

/**
 * The schema for the week before opening (docs/api-contract-launch.md,
 * section 1), laid before its packages start:
 *
 * - The Guild: `customers.guild_joined_at`. Every existing customer is a
 *   member from the day they were created; from now on only members earn
 *   points, and a customer created without joining (a seller at a cash
 *   buy-in) is not one until they join.
 * - VAT: `items.vat_rate` (empty means the shop's standard rate),
 *   `items.tax_scheme` gains `exempt`, `categories.default_vat_rate`, and
 *   in settings the date registered from, the quarter's first month and the
 *   standard rate.
 * - Stock online: `items.show_online`, `categories.show_online`,
 *   `settings.online`.
 * - Agents: `staff.kind` (`person` or `agent`) and `staff.agent_note`;
 *   `settings.agent_webhook` (`{ url, secret }`).
 * - Research requests: `research_requests`, written through routes only.
 * - Bookings: `resources`, `booking_events`, `bookings`,
 *   `sale_lines.booking`, `till_products.kind` gains `booking`, and
 *   `settings.opening_hours`.
 *
 * `down()` removes all of it; a `booking` till product or an `exempt` item
 * is moved back to the nearest old value first.
 */

const STAFF_ONLY = '@request.auth.collectionName = "staff"';
const MANAGER_UP =
  '@request.auth.collectionName = "staff" && (@request.auth.role = "admin" || @request.auth.role = "manager")';

function autodates() {
  return [
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
}

function rel(name, collection, extra) {
  const field = { name: name, type: "relation", collectionId: collection.id, maxSelect: 1, cascadeDelete: false };
  if (extra) for (const key in extra) field[key] = extra[key];
  return field;
}

function int(name, extra) {
  const field = { name: name, type: "number", onlyInt: true };
  if (extra) for (const key in extra) field[key] = extra[key];
  return field;
}

const IMAGE = {
  type: "file",
  maxSelect: 1,
  maxSize: 5242880,
  mimeTypes: ["image/png", "image/jpeg", "image/webp"],
  thumbs: ["160x0", "320x0", "640x0"],
};

migrate(
  (app) => {
    const staff = app.findCollectionByNameOrId("staff");
    const customers = app.findCollectionByNameOrId("customers");
    const items = app.findCollectionByNameOrId("items");
    const cards = app.findCollectionByNameOrId("cards");
    const retroTitles = app.findCollectionByNameOrId("retro_titles");
    const tradeInLines = app.findCollectionByNameOrId("trade_in_lines");
    const games = app.findCollectionByNameOrId("games");

    // --- The Guild ---------------------------------------------------------
    customers.fields.add(new Field({ name: "guild_joined_at", type: "date" }));
    app.save(customers);
    app.db().newQuery("UPDATE customers SET guild_joined_at = created WHERE guild_joined_at = '' OR guild_joined_at IS NULL").execute();

    // --- VAT and stock online on items and branches -------------------------
    items.fields.getByName("tax_scheme").values = ["margin", "standard", "exempt"];
    items.fields.add(new Field({ name: "vat_rate", type: "number", min: 0, max: 100 }));
    items.fields.add(new Field({ name: "show_online", type: "bool" }));
    items.indexes = items.indexes.concat(["CREATE INDEX idx_items_show_online ON items (show_online, status)"]);
    app.save(items);

    const categories = app.findCollectionByNameOrId("categories");
    categories.fields.add(new Field({ name: "default_vat_rate", type: "number", min: 0, max: 100 }));
    categories.fields.add(new Field({ name: "show_online", type: "bool" }));
    app.save(categories);

    // --- Agents --------------------------------------------------------------
    staff.fields.add(new Field({ name: "kind", type: "select", maxSelect: 1, values: ["person", "agent"] }));
    staff.fields.add(new Field({ name: "agent_note", type: "text", max: 500 }));
    app.save(staff);
    app.db().newQuery("UPDATE staff SET kind = 'person' WHERE kind = '' OR kind IS NULL").execute();

    // --- Settings ------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "vat_registered_from", type: "date" }));
    settings.fields.add(new Field({ name: "vat_period_start_month", type: "number", onlyInt: true, min: 1, max: 12 }));
    settings.fields.add(new Field({ name: "vat_standard_rate", type: "number", min: 0, max: 100 }));
    settings.fields.add(new Field({ name: "online", type: "json", maxSize: 5000 }));
    settings.fields.add(new Field({ name: "opening_hours", type: "json", maxSize: 5000 }));
    settings.fields.add(new Field({ name: "agent_webhook", type: "json", maxSize: 5000 }));
    app.save(settings);
    app.findRecordsByFilter("settings", "id != ''", "", 1, 0).forEach((row) => {
      if (!row.getInt("vat_period_start_month")) row.set("vat_period_start_month", 1);
      if (!row.getFloat("vat_standard_rate")) row.set("vat_standard_rate", 20);
      row.set("online", { enabled: true, min_price: 0, hide_qty: false });
      // Placeholder hours the shop edits in Settings, Bookings.
      row.set("opening_hours", {
        mon: [["10:00", "20:00"]],
        tue: [["10:00", "20:00"]],
        wed: [["10:00", "20:00"]],
        thu: [["10:00", "20:00"]],
        fri: [["10:00", "22:00"]],
        sat: [["10:00", "22:00"]],
        sun: [["11:00", "17:00"]],
      });
      row.set("agent_webhook", { url: "", secret: "" });
      app.saveNoValidate(row);
    });

    // --- Research requests ---------------------------------------------------
    const research = new Collection({
      type: "base",
      name: "research_requests",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "query", type: "text", required: true, max: 300 },
        rel("card", cards),
        rel("retro_title", retroTitles),
        rel("item", items),
        rel("trade_in_line", tradeInLines),
        { name: "condition", type: "text", max: 20 },
        { name: "finish", type: "text", max: 60 },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["open", "claimed", "done", "cancelled"],
        },
        rel("requested_by", staff),
        rel("claimed_by", staff),
        { name: "claimed_at", type: "date" },
        { name: "result", type: "text", max: 2000 },
        { name: "comps", type: "json", maxSize: 20000 },
        { name: "done_at", type: "date" },
      ].concat(autodates()),
      indexes: [
        "CREATE INDEX idx_research_requests_status ON research_requests (status, created)",
        "CREATE INDEX idx_research_requests_trade_in_line ON research_requests (trade_in_line)",
      ],
    });
    app.save(research);

    // --- Bookings ------------------------------------------------------------
    const resources = new Collection({
      type: "base",
      name: "resources",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      // Bookings point at resources; switch one off instead.
      deleteRule: null,
      fields: [
        { name: "name", type: "text", required: true, max: 60 },
        { name: "kind", type: "select", required: true, maxSelect: 1, values: ["table", "pc", "console", "room"] },
        int("capacity", { min: 1 }),
        int("slot_minutes", { min: 5 }),
        int("price", { min: 0 }),
        int("member_price", { min: 0 }),
        int("deposit", { min: 0 }),
        { name: "online", type: "bool" },
        { name: "hours", type: "json", maxSize: 5000 },
        { name: "active", type: "bool" },
        int("sort"),
        Object.assign({ name: "image" }, IMAGE),
        { name: "note", type: "text", max: 500 },
      ].concat(autodates()),
      indexes: ["CREATE UNIQUE INDEX idx_resources_name ON resources (name COLLATE NOCASE)"],
    });
    app.save(resources);

    const events = new Collection({
      type: "base",
      name: "booking_events",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      deleteRule: null,
      fields: [
        { name: "name", type: "text", required: true, max: 120 },
        rel("game", games),
        { name: "format", type: "text", max: 120 },
        { name: "starts_at", type: "date", required: true },
        { name: "ends_at", type: "date", required: true },
        int("capacity", { min: 0 }),
        int("entry_fee", { min: 0 }),
        int("member_fee", { min: 0 }),
        { name: "online", type: "bool" },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["draft", "published", "cancelled", "finished"],
        },
        { name: "repeat_weekly", type: "bool" },
        rel("resources", resources, { maxSelect: 50 }),
        { name: "description", type: "text", max: 4000 },
        Object.assign({ name: "image" }, IMAGE),
      ].concat(autodates()),
      indexes: ["CREATE INDEX idx_booking_events_starts ON booking_events (starts_at)"],
    });
    app.save(events);
    // A weekly event's next occurrences point back at the one they repeat.
    events.fields.add(new Field({ name: "repeat_of", type: "relation", collectionId: events.id, maxSelect: 1, cascadeDelete: false }));
    app.save(events);

    const bookings = new Collection({
      type: "base",
      name: "bookings",
      listRule: STAFF_ONLY + ' || (@request.auth.collectionName = "customers" && customer = @request.auth.id)',
      viewRule: STAFF_ONLY + ' || (@request.auth.collectionName = "customers" && customer = @request.auth.id)',
      // Every write goes through the booking routes, which check overlap,
      // capacity and hours and audit the change.
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "kind", type: "select", required: true, maxSelect: 1, values: ["resource", "event"] },
        rel("resource", resources),
        rel("event", events),
        rel("customer", customers),
        { name: "name", type: "text", max: 200 },
        { name: "phone", type: "text", max: 32 },
        { name: "email", type: "email" },
        { name: "starts_at", type: "date", required: true },
        { name: "ends_at", type: "date", required: true },
        int("party_size", { min: 1 }),
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["held", "confirmed", "checked_in", "completed", "cancelled", "no_show"],
        },
        int("price", { min: 0 }),
        int("deposit", { min: 0 }),
        int("paid", { min: 0 }),
        { name: "source", type: "select", maxSelect: 1, values: ["till", "online", "phone"] },
        { name: "checked_in_at", type: "date" },
        { name: "checked_out_at", type: "date" },
        { name: "notes", type: "text", max: 2000 },
        rel("created_by", staff),
      ].concat(autodates()),
      indexes: [
        "CREATE INDEX idx_bookings_resource_starts ON bookings (resource, starts_at)",
        "CREATE INDEX idx_bookings_event ON bookings (event)",
        "CREATE INDEX idx_bookings_customer ON bookings (customer)",
        "CREATE INDEX idx_bookings_status_starts ON bookings (status, starts_at)",
      ],
    });
    app.save(bookings);

    const saleLines = app.findCollectionByNameOrId("sale_lines");
    saleLines.fields.add(new Field({ name: "booking", type: "relation", collectionId: bookings.id, maxSelect: 1, cascadeDelete: false }));
    app.save(saleLines);

    const tillProducts = app.findCollectionByNameOrId("till_products");
    const kind = tillProducts.fields.getByName("kind");
    kind.values = kind.values.concat(["booking"]);
    app.save(tillProducts);
  },
  (app) => {
    const tillProducts = app.findCollectionByNameOrId("till_products");
    app.db().newQuery("UPDATE till_products SET kind = 'service' WHERE kind = 'booking'").execute();
    const kind = tillProducts.fields.getByName("kind");
    kind.values = kind.values.filter((v) => v !== "booking");
    app.save(tillProducts);

    const saleLines = app.findCollectionByNameOrId("sale_lines");
    saleLines.fields.removeByName("booking");
    app.save(saleLines);

    app.delete(app.findCollectionByNameOrId("bookings"));
    app.delete(app.findCollectionByNameOrId("booking_events"));
    app.delete(app.findCollectionByNameOrId("resources"));
    app.delete(app.findCollectionByNameOrId("research_requests"));

    const settings = app.findCollectionByNameOrId("settings");
    ["vat_registered_from", "vat_period_start_month", "vat_standard_rate", "online", "opening_hours", "agent_webhook"].forEach(
      (name) => settings.fields.removeByName(name)
    );
    app.save(settings);

    const staff = app.findCollectionByNameOrId("staff");
    staff.fields.removeByName("kind");
    staff.fields.removeByName("agent_note");
    app.save(staff);

    const categories = app.findCollectionByNameOrId("categories");
    categories.fields.removeByName("default_vat_rate");
    categories.fields.removeByName("show_online");
    app.save(categories);

    const items = app.findCollectionByNameOrId("items");
    app.db().newQuery("UPDATE items SET tax_scheme = 'standard' WHERE tax_scheme = 'exempt'").execute();
    items.indexes = items.indexes.filter((sql) => sql.indexOf("idx_items_show_online") < 0);
    items.fields.removeByName("vat_rate");
    items.fields.removeByName("show_online");
    items.fields.getByName("tax_scheme").values = ["margin", "standard"];
    app.save(items);

    const customers = app.findCollectionByNameOrId("customers");
    customers.fields.removeByName("guild_joined_at");
    app.save(customers);
  }
);
