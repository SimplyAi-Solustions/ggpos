/// <reference path="../pb_data/types.d.ts" />

/**
 * The Booking till product (docs/api-contract-launch.md, section 4): the key
 * a booking's price, deposit or balance and an event entry are sold on, so
 * they report under Services on the X, the Z and the sales report rather than
 * under Other. Standard rated, filed under Services, switched on. Added only
 * when the shop has no `booking` product yet.
 *
 * `down()` deletes it when no sale line points at it, and switches it off
 * otherwise.
 */
migrate(
  (app) => {
    let existing = null;
    try {
      existing = app.findFirstRecordByFilter("till_products", "kind = 'booking'");
    } catch (err) {
      existing = null;
    }
    if (existing) return;

    let services = "";
    try {
      services = app.findFirstRecordByFilter("categories", "key = 'services'").id;
    } catch (err) {
      services = "";
    }

    const row = new Record(app.findCollectionByNameOrId("till_products"));
    row.set("name", "Booking");
    row.set("kind", "booking");
    row.set("price", 0);
    row.set("tax_scheme", "standard");
    row.set("vat_rate", 20);
    row.set("active", true);
    row.set("sort", 900);
    if (services) row.set("category", services);
    app.save(row);
  },
  (app) => {
    let row = null;
    try {
      row = app.findFirstRecordByFilter("till_products", "kind = 'booking' && name = 'Booking'");
    } catch (err) {
      row = null;
    }
    if (!row) return;
    let used = false;
    try {
      used = app.findRecordsByFilter("sale_lines", "product = {:id}", "", 1, 0, { id: row.id }).length > 0;
    } catch (err) {
      used = false;
    }
    if (used) {
      row.set("active", false);
      app.save(row);
    } else {
      app.delete(row);
    }
  }
);
