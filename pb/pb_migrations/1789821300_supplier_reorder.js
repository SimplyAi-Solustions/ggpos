/// <reference path="../pb_data/types.d.ts" />

/**
 * The supplier reorder report's schema (docs/api-contract-reorder.md,
 * section 2), for the weekly call with a supplier's rep:
 *
 * - `games`: two rows for stock that is not a card or retro game,
 *   `warhammer` ("Warhammer") and `other` ("Other"), with no adapter, so no
 *   card search offers them. A row whose key already exists is left alone.
 *   The five card games get the `adapter` the seed left blank, so that "no
 *   adapter" can be read from the data (see CARD_ADAPTERS below).
 *   The live category tree's `default_game` is set by branch `key` to match
 *   the starter tree (packages/shared/src/categories.ts), only where it is
 *   empty, so nothing an admin chose is overwritten. The games and the keys
 *   are the shared module's, loaded from its generated copy in pb_hooks.
 * - `suppliers`: who the shop buys from and who the rep is. Any staff can
 *   read them; managers and admins write them. One row is seeded, Games
 *   Workshop. The name rules and the refusal to delete a supplier in use are
 *   pb_hooks/suppliers.pb.js's.
 * - `items.supplier`, `items.shelf_target` and `items.supplier_code`: which
 *   supplier a stock row is bought from, how many to keep on the shelf, and
 *   the supplier's own product code for the order. `shelf_target` is checked
 *   by the same hook file.
 * - `stock_requests`: what customers have asked for that the shop does not
 *   have, from Waiting to Collected. Any staff can read, add and change
 *   them; nobody can delete one (a request is cancelled). The checks on a
 *   new or changed request are pb_hooks/suppliers.pb.js's.
 *
 * `down()` removes the requests, the suppliers and the three item fields,
 * and clears any branch default that pointed at the two games. The two games
 * go too unless something still points at one, in which case that game stays
 * (stock already filed under it would otherwise be lost).
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

function rel(name, collection) {
  return { name: name, type: "relation", collectionId: collection.id, maxSelect: 1, cascadeDelete: false };
}

// The catalogue adapter behind each card game (pb_hooks/adapters/registry.js
// GAME_ADAPTERS, without the ".js"). The seed never filled `games.adapter` in,
// so "a game with no adapter" meant nothing in the data until now: with these
// set, a screen that offers a card search can leave out any game whose
// `adapter` is empty (Warhammer, Other and Retro, which is searched elsewhere).
const CARD_ADAPTERS = {
  pokemon: "tcgdex",
  mtg: "scryfall",
  yugioh: "ygoprodeck",
  onepiece: "optcg",
  lorcana: "lorcast",
};

migrate(
  (app) => {
    const categoriesShared = require(`${__hooks}/lib/shared/categories.js`);
    const reorderShared = require(`${__hooks}/lib/shared/reorder.js`);

    // -----------------------------------------------------------------
    // The two games, and the branches that default to them
    // -----------------------------------------------------------------
    const gamesCollection = app.findCollectionByNameOrId("games");
    const gameIds = {};
    categoriesShared.NON_CARD_GAMES.forEach((game) => {
      let row = null;
      try {
        row = app.findFirstRecordByFilter("games", "key = {:key}", { key: game.key });
      } catch (err) {
        row = null;
      }
      if (!row) {
        row = new Record(gamesCollection, { key: game.key, name: game.name, enabled: true });
        app.save(row);
      }
      gameIds[game.key] = row.id;
    });

    // The five card games say which adapter finds their cards, where they
    // did not say already.
    Object.keys(CARD_ADAPTERS).forEach((key) => {
      app
        .db()
        .newQuery("UPDATE games SET adapter = {:adapter} WHERE key = {:key} AND (adapter = '' OR adapter IS NULL)")
        .bind({ adapter: CARD_ADAPTERS[key], key: key })
        .execute();
    });

    // Written through SQL, as the category tree's own migration writes its
    // backfill, so no hook runs part way through a migration. Only the
    // branches whose starter default is one of the two new games, and only
    // where the live branch has no game yet.
    categoriesShared.starterBranches().forEach((entry) => {
      const game = entry.branch.defaults && entry.branch.defaults.game;
      if (!game || !gameIds[game]) return;
      app
        .db()
        .newQuery(
          "UPDATE categories SET default_game = {:game} WHERE key = {:key} AND (default_game = '' OR default_game IS NULL)"
        )
        .bind({ game: gameIds[game], key: entry.branch.key })
        .execute();
    });

    // -----------------------------------------------------------------
    // suppliers
    // -----------------------------------------------------------------
    const suppliers = new Collection({
      type: "base",
      name: "suppliers",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: MANAGER_UP,
      updateRule: MANAGER_UP,
      // A supplier any stock row or request points at is refused by the
      // hook; one nothing uses can go.
      deleteRule: MANAGER_UP,
      fields: [
        { name: "name", type: "text", required: true, min: 1, max: 80 },
        { name: "account_number", type: "text", max: 40 },
        { name: "rep_name", type: "text", max: 80 },
        { name: "rep_email", type: "text", max: 120 },
        { name: "rep_phone", type: "text", max: 40 },
        { name: "notes", type: "text", max: 500 },
        { name: "active", type: "bool" },
        { name: "sort", type: "number", onlyInt: true },
        ...autodates(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_suppliers_name ON suppliers (name COLLATE NOCASE)"],
    });
    app.save(suppliers);
    app.save(new Record(suppliers, { name: "Games Workshop", active: true, sort: 10 }));

    // -----------------------------------------------------------------
    // items.supplier, items.shelf_target, items.supplier_code
    // -----------------------------------------------------------------
    const items = app.findCollectionByNameOrId("items");
    items.fields.add(new Field(rel("supplier", suppliers)));
    items.fields.add(new Field({ name: "shelf_target", type: "number", onlyInt: true, min: 0 }));
    items.fields.add(new Field({ name: "supplier_code", type: "text", max: 40 }));
    items.indexes = items.indexes.concat(["CREATE INDEX idx_items_supplier ON items (supplier)"]);
    app.save(items);

    // -----------------------------------------------------------------
    // stock_requests
    // -----------------------------------------------------------------
    const customers = app.findCollectionByNameOrId("customers");
    const staff = app.findCollectionByNameOrId("staff");
    const requests = new Collection({
      type: "base",
      name: "stock_requests",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: STAFF_ONLY,
      updateRule: STAFF_ONLY,
      // A request is cancelled, not deleted.
      deleteRule: null,
      fields: [
        rel("supplier", suppliers),
        { name: "title", type: "text", required: true, min: 1, max: 200 },
        { name: "qty", type: "number", onlyInt: true, min: 1 },
        rel("customer", customers),
        { name: "contact_name", type: "text", max: 100 },
        { name: "contact_phone", type: "text", max: 40 },
        { name: "notes", type: "text", max: 500 },
        { name: "status", type: "select", required: true, maxSelect: 1, values: reorderShared.REQUEST_STATUSES },
        { name: "status_changed_at", type: "date" },
        rel("created_by", staff),
        rel("item", items),
        ...autodates(),
      ],
      indexes: ["CREATE INDEX idx_stock_requests_supplier_status ON stock_requests (supplier, status)"],
    });
    app.save(requests);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("stock_requests"));

    const items = app.findCollectionByNameOrId("items");
    items.indexes = items.indexes.filter((sql) => sql.indexOf("idx_items_supplier") < 0);
    items.fields.removeByName("supplier");
    items.fields.removeByName("shelf_target");
    items.fields.removeByName("supplier_code");
    app.save(items);

    app.delete(app.findCollectionByNameOrId("suppliers"));

    // The card games' adapters, as the seed had them (blank), where they are
    // still the ones set above.
    Object.keys(CARD_ADAPTERS).forEach((key) => {
      app
        .db()
        .newQuery("UPDATE games SET adapter = '' WHERE key = {:key} AND adapter = {:adapter}")
        .bind({ adapter: CARD_ADAPTERS[key], key: key })
        .execute();
    });

    // The two games: branches that defaulted to them go back to no game,
    // and a game nothing points at is removed. A game stock is filed under
    // stays, so no stock row loses its game.
    ["warhammer", "other"].forEach((key) => {
      let game = null;
      try {
        game = app.findFirstRecordByFilter("games", "key = {:key}", { key: key });
      } catch (err) {
        game = null;
      }
      if (!game) return;
      app.db().newQuery("UPDATE categories SET default_game = '' WHERE default_game = {:game}").bind({ game: game.id }).execute();
      if (app.countRecords("items", $dbx.hashExp({ game: game.id })) > 0) return;
      try {
        app.delete(game);
      } catch (err) {
        // Something else still points at it (a card, a pricing rule): keep it.
      }
    });
  }
);
