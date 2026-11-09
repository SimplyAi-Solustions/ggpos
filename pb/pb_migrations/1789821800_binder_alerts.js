/// <reference path="../pb_data/types.d.ts" />

/**
 * binder_alerts: the "in stock at GG" alerts. When an item on the staff
 * side becomes available and it is the exact print a customer's binder
 * still needs, binders_stock.pb.js writes one row here; My Vault shows the
 * unread ones on the binder shelf. `dedupe_key` is unique so a customer is
 * told at most once per card, print and stock arrival, whatever races.
 *
 * No price, quantity, SKU or location ever goes into a row: the alert is
 * the card's name and the binder it belongs to, nothing about the item.
 *
 * Also adds `binders.alerts_off`, the per-binder switch. It is off by
 * default (bool false), so alerts are on unless the customer turns them
 * off, and it is absent from the binders updateRule's blocked list so the
 * customer can flip it from the binder settings sheet.
 */
migrate(
  (app) => {
    const customers = app.findCollectionByNameOrId("customers");
    const binders = app.findCollectionByNameOrId("binders");

    const OWN = '@request.auth.collectionName = "customers" && customer = @request.auth.id';
    const alerts = new Collection({
      name: "binder_alerts",
      type: "base",
      listRule: `@request.auth.collectionName = "staff" || (${OWN})`,
      viewRule: `@request.auth.collectionName = "staff" || (${OWN})`,
      // Written by the items hook only, never through the collection API.
      createRule: null,
      // A customer may only stamp read_at on their own alert - the alert's
      // content and its dedupe memory stay system-owned.
      updateRule:
        `(${OWN})` +
        " && @request.body.customer:isset = false" +
        " && @request.body.binder:isset = false" +
        " && @request.body.card_id:isset = false" +
        " && @request.body.lang:isset = false" +
        " && @request.body.card_name:isset = false" +
        " && @request.body.binder_name:isset = false" +
        " && @request.body.message:isset = false" +
        " && @request.body.dedupe_key:isset = false",
      deleteRule: null,
      fields: [
        {
          type: "relation",
          name: "customer",
          required: true,
          collectionId: customers.id,
          maxSelect: 1,
          cascadeDelete: true,
        },
        { type: "relation", name: "binder", collectionId: binders.id, maxSelect: 1, cascadeDelete: true },
        { type: "text", name: "card_id", required: true, max: 80 },
        { type: "text", name: "lang", max: 10 },
        { type: "text", name: "card_name", max: 200 },
        { type: "text", name: "binder_name", max: 120 },
        { type: "text", name: "message", max: 500 },
        { type: "text", name: "dedupe_key", required: true, max: 220 },
        { type: "date", name: "read_at" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
    });
    alerts.addIndex("idx_binder_alerts_dedupe_unique", true, "dedupe_key", "");
    alerts.addIndex("idx_binder_alerts_customer_read", false, "customer, read_at", "");
    alerts.addIndex("idx_binder_alerts_card", false, "card_id", "");
    app.save(alerts);

    if (!binders.fields.getByName("alerts_off")) {
      binders.fields.add(new Field({ type: "bool", name: "alerts_off" }));
      app.save(binders);
    }
  },
  (app) => {
    const alerts = app.findCollectionByNameOrId("binder_alerts");
    app.delete(alerts);
    const binders = app.findCollectionByNameOrId("binders");
    if (binders.fields.getByName("alerts_off")) {
      binders.fields.removeByName("alerts_off");
      app.save(binders);
    }
  }
);
