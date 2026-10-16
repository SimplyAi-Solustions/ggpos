/// <reference path="../pb_data/types.d.ts" />

/**
 * The till's quick-key pages after the category tree
 * (docs/api-contract-inventory.md, section 1.5).
 *
 * `till_categories` rows are the till's quick-key pages. The EPOS seed made
 * four: Quick (the keys), Sealed and Accessories (dynamic lists of stock by
 * kind) and Services (an empty page). The tree now browses all of that, so a
 * page with no keys behind it only duplicates a branch: this switches off
 * every active page that has none, which as seeded is Sealed, Accessories and
 * Services. A page with keys, Quick among them, stays, and so does any page
 * staff switched off already. Nothing is deleted.
 *
 * `down()` switches the seeded ones back on, by name.
 */

/** The seeded pages the tree replaces. */
const REPLACED = ["Sealed", "Accessories", "Services"];

migrate(
  (app) => {
    const pages = app.findRecordsByFilter("till_categories", "active = true", "", 0, 0);
    pages.forEach((page) => {
      if (!page) return;
      if (app.countRecords("till_keys", $dbx.hashExp({ category: page.id })) > 0) return;
      page.set("active", false);
      app.save(page);
    });
  },
  (app) => {
    REPLACED.forEach((name) => {
      let page = null;
      try {
        page = app.findFirstRecordByFilter("till_categories", "name = {:name}", { name: name });
      } catch (err) {
        page = null;
      }
      if (!page || page.getBool("active")) return;
      page.set("active", true);
      app.save(page);
    });
  }
);
