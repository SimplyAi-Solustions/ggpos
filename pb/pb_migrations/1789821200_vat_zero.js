/// <reference path="../pb_data/types.d.ts" />

/**
 * Zero-rated VAT as a treatment of its own (docs/api-contract-launch.md,
 * section 3; approved for package RV as an as-built change to section 1).
 *
 * A PocketBase number column is `NUMERIC DEFAULT 0 NOT NULL`, so an empty
 * `vat_rate` reads 0, and section 1 says an empty rate on a standard item
 * means the shop's standard rate. A zero-rated item (standard at 0 percent)
 * would read exactly like a standard one. `zero` is therefore a scheme value
 * of its own on every select that carries a treatment, and the five
 * treatments are stored as:
 *
 *   margin    tax_scheme margin
 *   standard  tax_scheme standard, vat_rate 0 (the shop's standard rate)
 *   reduced   tax_scheme standard, vat_rate 5
 *   zero      tax_scheme zero
 *   exempt    tax_scheme exempt
 *
 * `packages/shared/src/vat.ts` is the one place a scheme and a rate become
 * the rate charged. Nothing stored before this changes meaning.
 *
 * `down()` maps `zero` back to `standard` with a rate of 0 first, then takes
 * the value off the selects.
 */

/** The collection and select field that carries a treatment. */
const SELECTS = [
  { collection: "items", field: "tax_scheme" },
  { collection: "till_products", field: "tax_scheme" },
  { collection: "sale_lines", field: "tax_scheme" },
  { collection: "categories", field: "default_tax_scheme" },
];

migrate(
  (app) => {
    SELECTS.forEach((entry) => {
      const collection = app.findCollectionByNameOrId(entry.collection);
      const field = collection.fields.getByName(entry.field);
      if (field.values.indexOf("zero") < 0) field.values = field.values.concat(["zero"]);
      app.save(collection);
    });
  },
  (app) => {
    app.db().newQuery("UPDATE items SET tax_scheme = 'standard', vat_rate = 0 WHERE tax_scheme = 'zero'").execute();
    app
      .db()
      .newQuery("UPDATE till_products SET tax_scheme = 'standard', vat_rate = 0 WHERE tax_scheme = 'zero'")
      .execute();
    app.db().newQuery("UPDATE sale_lines SET tax_scheme = 'standard', vat_rate = 0 WHERE tax_scheme = 'zero'").execute();
    app
      .db()
      .newQuery(
        "UPDATE categories SET default_tax_scheme = 'standard', default_vat_rate = 0 WHERE default_tax_scheme = 'zero'"
      )
      .execute();
    SELECTS.forEach((entry) => {
      const collection = app.findCollectionByNameOrId(entry.collection);
      const field = collection.fields.getByName(entry.field);
      field.values = field.values.filter((value) => value !== "zero");
      app.save(collection);
    });
  }
);
