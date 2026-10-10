/// <reference path="../pb_data/types.d.ts" />

/**
 * EPOS foundation (docs/EPOS-PLAN.md, Phase 8): the pieces every till
 * package builds on, laid first so they can be built side by side.
 *
 * - `staff.role` gains `manager`, between staff and admin
 *   (packages/shared/src/permissions.ts ranks them). Collection rules that
 *   say `role = "admin"` keep meaning admin only.
 * - `staff.pin_hash` becomes hidden, so no auth response or record read ever
 *   carries it, and staff gains `pin_failures`, `pin_locked` and
 *   `pin_set_at` for the PIN routes (pb_hooks/till_auth.pb.js).
 * - `registers`: a till and its drawer. One is seeded, "Counter"; the Mac and
 *   the tablet are both devices on it. Staff can read them; an admin manages
 *   them; nobody deletes one (deactivate it instead), because sales and Z
 *   reports point at it.
 * - `register_devices`: a browser registered to a register. Its secret is
 *   stored only as a hash and is hidden. Writes go through the device routes
 *   only.
 * - `settings.epos`: the till's settings, with defaults; `settings.vat_number`
 *   for the receipt.
 *
 * `down()` removes all of it.
 */

const STAFF_ONLY = '@request.auth.collectionName = "staff"';
const MANAGER_UP =
  '@request.auth.collectionName = "staff" && (@request.auth.role = "admin" || @request.auth.role = "manager")';
const ADMIN_ONLY = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';

const EPOS_DEFAULTS = {
  // Capability -> lowest role, overlaid on the defaults in
  // packages/shared/src/permissions.ts. Empty means "the defaults".
  permissions: {},
  // A ticket or line discount above this percent needs discount_over_limit.
  discount_limit_pct: 10,
  // The card step asks for the last four digits off the Tide reader.
  require_card_last4: true,
  // Minutes without a touch before the till locks to the PIN screen.
  auto_lock_minutes: 5,
  // The quick cash buttons, in pence.
  quick_cash: [500, 1000, 2000, 5000],
  // Suggested opening float, in pence.
  default_float: 10000,
  // The Z report asks for the Tide total for the day when there were card sales.
  z_requires_card_total: true,
  // Which card step the till uses. Only "manual_tide" exists today.
  card_provider: "manual_tide",
  receipt: {
    header: "",
    footer: "Thank you for shopping with GG Entertainment.",
    returns_policy: "",
    show_portal_qr: true,
  },
};

migrate(
  (app) => {
    // -----------------------------------------------------------------
    // staff
    // -----------------------------------------------------------------
    const staff = app.findCollectionByNameOrId("staff");
    const role = staff.fields.getByName("role");
    role.values = ["admin", "manager", "staff"];
    const pinHash = staff.fields.getByName("pin_hash");
    pinHash.hidden = true;
    staff.fields.add(new Field({ name: "pin_failures", type: "number", onlyInt: true, min: 0 }));
    staff.fields.add(new Field({ name: "pin_locked", type: "bool" }));
    staff.fields.add(new Field({ name: "pin_set_at", type: "date" }));
    app.save(staff);

    // -----------------------------------------------------------------
    // registers
    // -----------------------------------------------------------------
    const locations = app.findCollectionByNameOrId("locations");
    const registers = new Collection({
      type: "base",
      name: "registers",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: ADMIN_ONLY,
      updateRule: ADMIN_ONLY,
      deleteRule: null,
      fields: [
        { name: "name", type: "text", required: true, max: 60 },
        {
          name: "location",
          type: "relation",
          collectionId: locations.id,
          maxSelect: 1,
        },
        { name: "active", type: "bool" },
        { name: "sort", type: "number", onlyInt: true },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_registers_name ON registers (name)"],
    });
    app.save(registers);

    const counter = new Record(registers);
    counter.set("name", "Counter");
    counter.set("active", true);
    counter.set("sort", 1);
    app.save(counter);

    // -----------------------------------------------------------------
    // register_devices
    // -----------------------------------------------------------------
    const devices = new Collection({
      type: "base",
      name: "register_devices",
      listRule: MANAGER_UP,
      viewRule: MANAGER_UP,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          name: "register",
          type: "relation",
          required: true,
          collectionId: registers.id,
          maxSelect: 1,
          cascadeDelete: false,
        },
        { name: "label", type: "text", required: true, max: 60 },
        { name: "secret_hash", type: "text", required: true, max: 200, hidden: true },
        {
          name: "created_by",
          type: "relation",
          collectionId: staff.id,
          maxSelect: 1,
        },
        { name: "last_seen", type: "date" },
        { name: "revoked_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_register_devices_register ON register_devices (register)"],
    });
    app.save(devices);

    // -----------------------------------------------------------------
    // settings
    // -----------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "epos", type: "json", maxSize: 20000 }));
    settings.fields.add(new Field({ name: "vat_number", type: "text", max: 20 }));
    app.save(settings);

    const rows = app.findRecordsByFilter("settings", "id != ''", "", 1, 0);
    if (rows.length) {
      const row = rows[0];
      // A new json field reads back as raw JSON text ("null" until set), not
      // as an object, so the emptiness test is on the text.
      const current = String(row.getString("epos") || "").trim();
      if (current === "" || current === "null" || current === "{}") {
        row.set("epos", EPOS_DEFAULTS);
        app.save(row);
      }
    }
  },
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("epos");
    settings.fields.removeByName("vat_number");
    app.save(settings);

    app.delete(app.findCollectionByNameOrId("register_devices"));
    app.delete(app.findCollectionByNameOrId("registers"));

    const staff = app.findCollectionByNameOrId("staff");
    // A manager has to become something the old schema knows before the
    // value can go.
    app
      .findRecordsByFilter("staff", 'role = "manager"', "", 0, 0)
      .forEach((r) => {
        r.set("role", "staff");
        app.save(r);
      });
    const role = staff.fields.getByName("role");
    role.values = ["admin", "staff"];
    staff.fields.getByName("pin_hash").hidden = false;
    staff.fields.removeByName("pin_failures");
    staff.fields.removeByName("pin_locked");
    staff.fields.removeByName("pin_set_at");
    app.save(staff);
  }
);
