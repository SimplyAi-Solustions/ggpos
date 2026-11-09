/// <reference path="../pb_data/types.d.ts" />

/**
 * Customer binders (docs/PLAN.md rebuild, "Customer app features" 2 and 3).
 *
 * A binder is a collection a customer is building: one Pokemon, one set,
 * one illustrator, or their own picks. binder_cards holds one pocket per
 * card. Ported from the GG HQ binder builder with every price field left
 * out: customers never see values, so the columns do not exist here at
 * all rather than being hidden.
 *
 * A customer reads and writes only their own binders. Staff can read them.
 * Pockets are created by the binder routes (binders.pb.js) so the card data
 * comes from the catalogue, never from the browser; a customer may only
 * flip `owned` on their own pockets or remove one.
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const OWN_BINDER = '(@request.auth.collectionName = "customers" && customer = @request.auth.id)';
    const OWN_POCKET = '(@request.auth.collectionName = "customers" && binder.customer = @request.auth.id)';

    const customers = app.findCollectionByNameOrId("customers");

    const binders = new Collection({
      type: "base",
      name: "binders",
      listRule: `${STAFF_ONLY} || ${OWN_BINDER}`,
      viewRule: `${STAFF_ONLY} || ${OWN_BINDER}`,
      // Created through POST /api/vault/binders only.
      createRule: null,
      // Name and cover colour only; what the binder is for is fixed at birth.
      updateRule: `${OWN_BINDER} && @request.body.customer:isset = false && @request.body.kind:isset = false && @request.body.query:isset = false`,
      deleteRule: OWN_BINDER,
      fields: [
        {
          type: "relation",
          name: "customer",
          required: true,
          collectionId: customers.id,
          cascadeDelete: true,
          maxSelect: 1,
        },
        { type: "text", name: "name", required: true, max: 120 },
        { type: "text", name: "owner", max: 80 },
        {
          type: "select",
          name: "kind",
          required: true,
          maxSelect: 1,
          values: ["pokemon", "set", "illustrator", "custom"],
        },
        { type: "text", name: "query", max: 200 },
        { type: "text", name: "query_label", max: 200 },
        { type: "text", name: "color", max: 20 },
        { type: "bool", name: "master" },
        { type: "text", name: "cover", max: 500 },
        { type: "text", name: "logo", max: 500 },
        { type: "number", name: "sort" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_binders_customer ON binders (customer)"],
    });
    app.save(binders);

    app.save(
      new Collection({
        type: "base",
        name: "binder_cards",
        listRule: `${STAFF_ONLY} || ${OWN_POCKET}`,
        viewRule: `${STAFF_ONLY} || ${OWN_POCKET}`,
        createRule: null,
        // Only the owned flag and its date may change from the browser.
        updateRule: `${OWN_POCKET} && @request.body.binder:isset = false && @request.body.card_id:isset = false && @request.body.name:isset = false && @request.body.image:isset = false && @request.body.number:isset = false && @request.body.set_id:isset = false && @request.body.set_name:isset = false`,
        deleteRule: OWN_POCKET,
        fields: [
          {
            type: "relation",
            name: "binder",
            required: true,
            collectionId: binders.id,
            cascadeDelete: true,
            maxSelect: 1,
          },
          { type: "text", name: "card_id", required: true, max: 80 },
          { type: "text", name: "variant", max: 40 },
          { type: "text", name: "name", max: 200 },
          { type: "text", name: "number", max: 30 },
          { type: "text", name: "set_id", max: 60 },
          { type: "text", name: "set_name", max: 120 },
          { type: "text", name: "set_total", max: 20 },
          { type: "text", name: "rarity", max: 80 },
          { type: "text", name: "image", max: 500 },
          { type: "number", name: "sort" },
          { type: "bool", name: "owned" },
          { type: "date", name: "owned_at" },
          { type: "text", name: "group_name", max: 120 },
          { type: "text", name: "group_shape", max: 10 },
          { type: "text", name: "lang", max: 5 },
          { type: "bool", name: "manual" },
          { type: "autodate", name: "created", onCreate: true },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_binder_cards_slot ON binder_cards (binder, card_id, variant)",
          "CREATE INDEX idx_binder_cards_binder ON binder_cards (binder)",
        ],
      })
    );
  },
  (app) => {
    for (const name of ["binder_cards", "binders"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (err) {
        // Already gone.
      }
    }
  }
);
