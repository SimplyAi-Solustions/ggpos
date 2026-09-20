/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 4 (exports, imports and SumUp): what the CSV importers, the eBay
 * order channel and the SumUp transactions pull need that earlier phases
 * did not already carry. `sumup_transactions` and `csv_imports`
 * themselves already exist (1789819560_ops_collections.js) with every
 * field this phase writes to - nothing new is added there.
 *
 * Added:
 *  - `sales.channel` (select `counter` | `ebay`) and `sales.external_ref`
 *    (text): an eBay-orders import creates its own sale with
 *    `channel: "ebay"` and the order reference in `external_ref`, so a
 *    counter sale and an eBay sale can be told apart later (reports,
 *    the sales export). An ordinary counter sale never sets `channel`
 *    itself - `sales.pb.js` is another phase's file, not touched this
 *    round - so `imports.pb.js` carries a small `onRecordCreate` hook of
 *    its own that defaults an empty `channel` to `"counter"`; see that
 *    file's own comment for why it lives there.
 *  - `settings.import_mappings`: the header-name mapping config each CSV
 *    importer reads instead of hard-coded headers (the real Card Uploader
 *    per-card headers are only visible inside a logged-in account -
 *    docs/csv-formats.md), seeded with the exact skeleton that file
 *    already carries for both `card_uploader` and `ebay_orders`. Richard
 *    confirms the real header names once a real export is in hand and
 *    corrects this settings field directly - see docs/api-contract.md's
 *    Phase 4 section.
 *  - `settings.sumup`: `{ merchant_code }`, the merchant identifier the
 *    SumUp Transactions API calls are scoped to. The API key itself goes
 *    at `settings.api_keys.sumup` (merged into the existing `api_keys`
 *    blob, not overwriting it, matching this same file's own precedent
 *    in 1789819920_phase3_adapter_state.js for `offer.ebayHaircutPct`).
 *    Both are already kept out of `GET /api/vault/config`: that route
 *    drops the whole `api_keys` field by name, and `sumup.merchant_code`
 *    is not a key or a secret, so it is fine for an ordinary staff member
 *    to see it there.
 */
migrate(
  (app) => {
    // ---------------------------------------------------------------
    // sales.channel / sales.external_ref
    // ---------------------------------------------------------------
    const sales = app.findCollectionByNameOrId("sales");
    sales.fields.add(
      new Field({ name: "channel", type: "select", maxSelect: 1, values: ["counter", "ebay"] })
    );
    sales.fields.add(new Field({ name: "external_ref", type: "text", max: 100 }));
    app.save(sales);

    // ---------------------------------------------------------------
    // settings.import_mappings / settings.sumup
    // ---------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "import_mappings", type: "json", maxSize: 20000 }));
    settings.fields.add(new Field({ name: "sumup", type: "json", maxSize: 2000 }));
    app.save(settings);

    // The settings singleton may not exist yet on a fresh, pre-seed
    // database (this migration could in principle run before
    // 1789819620_seed.js on some future reordering) - skip the data
    // fill-in rather than fail the whole migration when there is no row
    // to fill in yet.
    let row = null;
    try {
      row = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      row = null;
    }
    if (row) {
      row.set("import_mappings", {
        card_uploader: {
          source: "card_uploader",
          headerRow: 1,
          columns: {
            name: ["Card Name", "Name", "Title"],
            set: ["Set", "Set Name"],
            number: ["Number", "Card Number", "#"],
            condition: ["Condition"],
            price: ["Price", "Sale Price"],
            quantity: ["Quantity", "Qty"],
            tcgplayerId: ["TCGplayer ID", "TCGplayer Product ID"],
            cardmarketId: ["Cardmarket ID", "Cardmarket Product ID"],
            csSku: ["CS SKU", "Custom Label"],
          },
        },
        ebay_orders: {
          source: "ebay_orders",
          headerRow: 1,
          columns: {
            customLabel: ["Custom Label", "Custom Label (SKU)"],
            itemNumber: ["Item Number"],
            orderNumber: ["Order Number", "Sales Record Number"],
            saleDate: ["Sale Date"],
            salePrice: ["Sold For", "Sale Price"],
            quantity: ["Quantity"],
            currency: ["Sale Currency", "Currency"],
          },
        },
      });

      row.set("sumup", { merchant_code: "" });

      let apiKeys = {};
      try {
        const raw = row.get("api_keys");
        apiKeys = raw ? JSON.parse(toString(raw)) || {} : {};
      } catch (err) {
        apiKeys = {};
      }
      if (apiKeys.sumup === undefined) {
        apiKeys.sumup = "";
        row.set("api_keys", apiKeys);
      }

      app.save(row);
    }
  },
  (app) => {
    let row = null;
    try {
      row = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      row = null;
    }
    if (row) {
      let apiKeys = {};
      try {
        const raw = row.get("api_keys");
        apiKeys = raw ? JSON.parse(toString(raw)) || {} : {};
      } catch (err) {
        apiKeys = {};
      }
      delete apiKeys.sumup;
      row.set("api_keys", apiKeys);
      row.set("sumup", null);
      row.set("import_mappings", null);
      app.save(row);
    }

    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("sumup");
    settings.fields.removeByName("import_mappings");
    app.save(settings);

    const sales = app.findCollectionByNameOrId("sales");
    sales.fields.removeByName("external_ref");
    sales.fields.removeByName("channel");
    app.save(sales);
  }
);
