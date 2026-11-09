/// <reference path="../pb_data/types.d.ts" />

/**
 * Customer binders v2 (feat/binders-v2).
 *
 * binders gains:
 *   - kind "pokedex": a binder with one pocket per Pokemon, national or one
 *     generation, a sprite in each pocket until a card goes in.
 *   - grid: the pocket layout per page (2x2, 3x3, 3x4, 4x4), switchable.
 *   - min_slots: the pocket capacity the customer asked for with "Add page",
 *     so an empty page at the end survives a reload.
 *   - share_token: an unguessable token for the read-only share view. Set and
 *     cleared only by the share route, never from the browser.
 *   - dex_scope: "national" or "gen1" to "gen9" for a pokedex binder.
 *
 * binder_cards gains an explicit position (slot, -1 means taken out of the
 * binder but kept so an undo can put it back) and the pokedex fields.
 * Existing pockets get slots in their current order.
 *
 * binder_wanted is new: a customer asking the shop for a card they need.
 * One open request per customer per card. Customers read their own; staff
 * read all; every write goes through binders.pb.js.
 *
 * Nothing here holds a price. Customers never see values.
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const OWN_BINDER = '(@request.auth.collectionName = "customers" && customer = @request.auth.id)';
    const OWN_POCKET = '(@request.auth.collectionName = "customers" && binder.customer = @request.auth.id)';
    const notSet = (names) => names.map((n) => `@request.body.${n}:isset = false`).join(" && ");

    const customers = app.findCollectionByNameOrId("customers");
    const binders = app.findCollectionByNameOrId("binders");

    const kind = binders.fields.getByName("kind");
    kind.values = ["pokemon", "set", "illustrator", "custom", "pokedex"];
    if (!binders.fields.getByName("grid")) {
      binders.fields.add(
        new Field({ name: "grid", type: "select", maxSelect: 1, values: ["2x2", "3x3", "3x4", "4x4"] })
      );
    }
    if (!binders.fields.getByName("min_slots")) {
      binders.fields.add(new Field({ name: "min_slots", type: "number", onlyInt: true, min: 0, max: 20000 }));
    }
    if (!binders.fields.getByName("share_token")) {
      binders.fields.add(new Field({ name: "share_token", type: "text", max: 64 }));
    }
    if (!binders.fields.getByName("dex_scope")) {
      binders.fields.add(new Field({ name: "dex_scope", type: "text", max: 20 }));
    }
    binders.indexes = binders.indexes.concat([
      "CREATE UNIQUE INDEX idx_binders_share_token ON binders (share_token) WHERE share_token != ''",
    ]);
    // Name, who it is for, colour and grid only. What the binder is for, its
    // owner and its share link are fixed or set by the routes.
    binders.updateRule = `${OWN_BINDER} && ${notSet([
      "customer",
      "kind",
      "query",
      "share_token",
      "dex_scope",
      "min_slots",
    ])}`;
    app.save(binders);

    const cards = app.findCollectionByNameOrId("binder_cards");
    if (!cards.fields.getByName("slot")) {
      cards.fields.add(new Field({ name: "slot", type: "number", onlyInt: true, min: -1, max: 20000 }));
    }
    if (!cards.fields.getByName("dex")) {
      cards.fields.add(new Field({ name: "dex", type: "number", onlyInt: true, min: 0, max: 5000 }));
    }
    if (!cards.fields.getByName("sprite")) {
      cards.fields.add(new Field({ name: "sprite", type: "text", max: 500 }));
    }
    cards.indexes = cards.indexes.concat(["CREATE INDEX idx_binder_cards_slot_pos ON binder_cards (binder, slot)"]);
    // Only owned, owned_at and the position may change from the browser;
    // the card itself always comes from the catalogue through the routes.
    cards.updateRule = `${OWN_POCKET} && ${notSet([
      "binder",
      "card_id",
      "variant",
      "name",
      "number",
      "set_id",
      "set_name",
      "set_total",
      "rarity",
      "image",
      "group_name",
      "group_shape",
      "lang",
      "manual",
      "dex",
      "sprite",
    ])}`;
    app.save(cards);

    // Existing pockets keep their order: slot = position by sort within the binder.
    app
      .db()
      .newQuery(
        "UPDATE binder_cards SET slot = (SELECT COUNT(*) FROM binder_cards b2 WHERE b2.binder = binder_cards.binder AND (b2.sort < binder_cards.sort OR (b2.sort = binder_cards.sort AND b2.id < binder_cards.id)))"
      )
      .execute();

    const wanted = new Collection({
      type: "base",
      name: "binder_wanted",
      listRule: `${STAFF_ONLY} || (@request.auth.collectionName = "customers" && customer = @request.auth.id)`,
      viewRule: `${STAFF_ONLY} || (@request.auth.collectionName = "customers" && customer = @request.auth.id)`,
      // Opened, cancelled and closed through /api/vault/binders/wanted only.
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          type: "relation",
          name: "customer",
          required: true,
          collectionId: customers.id,
          cascadeDelete: true,
          maxSelect: 1,
        },
        { type: "text", name: "card_id", required: true, max: 80 },
        { type: "text", name: "card_name", max: 200 },
        { type: "text", name: "number", max: 30 },
        { type: "text", name: "set_id", max: 60 },
        { type: "text", name: "set_name", max: 120 },
        { type: "text", name: "image", max: 500 },
        { type: "number", name: "dex", onlyInt: true, min: 0, max: 5000 },
        {
          type: "relation",
          name: "binder",
          collectionId: binders.id,
          cascadeDelete: false,
          maxSelect: 1,
        },
        {
          type: "select",
          name: "status",
          required: true,
          maxSelect: 1,
          values: ["open", "cancelled", "fulfilled"],
        },
        { type: "date", name: "closed_at" },
        { type: "text", name: "staff_note", max: 500 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_binder_wanted_open ON binder_wanted (customer, card_id) WHERE status = 'open'",
        "CREATE INDEX idx_binder_wanted_status_card ON binder_wanted (status, card_id)",
      ],
    });
    app.save(wanted);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("binder_wanted"));
    } catch (err) {
      // Already gone.
    }
    const binders = app.findCollectionByNameOrId("binders");
    binders.indexes = binders.indexes.filter((sql) => sql.indexOf("idx_binders_share_token") < 0);
    for (const n of ["grid", "min_slots", "share_token", "dex_scope"]) binders.fields.removeByName(n);
    binders.fields.getByName("kind").values = ["pokemon", "set", "illustrator", "custom"];
    binders.updateRule =
      '(@request.auth.collectionName = "customers" && customer = @request.auth.id) && @request.body.customer:isset = false && @request.body.kind:isset = false && @request.body.query:isset = false';
    app.save(binders);
    const cards = app.findCollectionByNameOrId("binder_cards");
    cards.indexes = cards.indexes.filter((sql) => sql.indexOf("idx_binder_cards_slot_pos") < 0);
    for (const n of ["slot", "dex", "sprite"]) cards.fields.removeByName(n);
    cards.updateRule =
      '(@request.auth.collectionName = "customers" && binder.customer = @request.auth.id) && @request.body.binder:isset = false && @request.body.card_id:isset = false && @request.body.name:isset = false && @request.body.image:isset = false && @request.body.number:isset = false && @request.body.set_id:isset = false && @request.body.set_name:isset = false';
    app.save(cards);
  }
);
