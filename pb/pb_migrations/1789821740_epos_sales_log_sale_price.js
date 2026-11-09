/// <reference path="../pb_data/types.d.ts" />

/**
 * epos_sales_log.sale_price: what the till line actually took, in pence:
 * UnitPrice (which Epos Now reports before discounts) times Quantity, less
 * the line's DiscountAmount and BasketDiscountPortion. This, not unit_price,
 * is what items.epos_sale_price records. Additive only.
 */
migrate(
  (app) => {
    const log = app.findCollectionByNameOrId("epos_sales_log");
    if (!log.fields.getByName("sale_price")) {
      log.fields.add(new Field({ name: "sale_price", type: "number", onlyInt: true }));
    }
    app.save(log);
  },
  (app) => {
    const log = app.findCollectionByNameOrId("epos_sales_log");
    log.fields.removeByName("sale_price");
    app.save(log);
  }
);
