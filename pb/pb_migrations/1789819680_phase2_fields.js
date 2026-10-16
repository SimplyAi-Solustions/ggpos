/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 2 fields: everything the custom /api/vault routes need that the
 * Phase 1 migrations did not already carry.
 *
 * Phase 1 is already applied on real installs, so nothing there is edited;
 * this file only appends fields and fills their defaults on the existing
 * settings row.
 *
 * Note: the seller snapshot fields the trade-in completion route writes
 * (seller_name, seller_address, seller_id_type, seller_id_last4,
 * seller_id_expiry) already exist on `trade_ins` from
 * 1789819380_trading_collections.js, so they are not repeated here.
 *
 * Added:
 *  - id_documents.mime         the original photo's MIME type, kept beside
 *                              the encrypted .enc file so the view route can
 *                              serve the decrypted bytes with the right
 *                              Content-Type.
 *  - settings.cash_variance_alert  pence; a cash session closing over this
 *                              variance writes an audit row.
 *  - settings.offer            OfferSettings from packages/shared/src/pricing.ts
 *                              ({ bulkThreshold, bulkCash, bulkCredit,
 *                              minimumOffer }, all pence).
 *  - settings.default_intake_location  where trade-in items land when a line
 *                              does not name a location.
 *  - settings.email            { from_name, from_address, reply_to, test_mode }.
 *                              The transport itself is PocketBase's own SMTP
 *                              settings (Dashboard > Settings > Mail); this
 *                              row only holds the addressing and the test
 *                              switch. settings.email_provider /
 *                              settings.email_api_key stay for a future
 *                              HTTP-API provider.
 *  - settings.receipt_terms    the terms paragraph printed and emailed on a
 *                              buy-in receipt.
 *  - trade_in_lines.kind / .game / .completeness  what the completion route
 *                              needs to turn a line into an `items` row.
 *                              items.kind and items.game are both required,
 *                              and a line that is neither a catalogue card
 *                              nor a retro title (sealed product, an
 *                              accessory) has nothing to derive them from.
 *                              The route still falls back to the card or
 *                              retro title when a line leaves them empty.
 */
migrate((app) => {
  // -------------------------------------------------------------------
  // id_documents.mime
  // -------------------------------------------------------------------
  const idDocuments = app.findCollectionByNameOrId("id_documents");
  idDocuments.fields.add(new Field({ name: "mime", type: "text", max: 120 }));
  app.save(idDocuments);

  // -------------------------------------------------------------------
  // trade_ins.number: only a completed trade-in has one.
  //
  // Drafts and their lines are created through the collection API
  // (docs/api-contract.md, "Trade-ins") and the number is assigned from
  // counters.trade_in at completion, so a required `number` would make a
  // draft impossible to create and would burn a number on every abandoned
  // one. The unique index becomes partial so the numbers that do exist
  // stay unique while any number of drafts sit at "".
  // -------------------------------------------------------------------
  const tradeIns = app.findCollectionByNameOrId("trade_ins");
  // Mutated through getByName and re-added by its existing id, so the
  // column keeps its identity (adding a fresh Field with the same name but
  // a new id reads as a drop-and-recreate to PocketBase's schema diff).
  const numberField = tradeIns.fields.getByName("number");
  numberField.required = false;
  tradeIns.fields.add(numberField);
  tradeIns.removeIndex("idx_trade_ins_number_unique");
  tradeIns.addIndex("idx_trade_ins_number_unique", true, "number", "number != ''");
  app.save(tradeIns);

  // -------------------------------------------------------------------
  // trade_in_lines: what an items row needs that a line could not say
  // -------------------------------------------------------------------
  const games = app.findCollectionByNameOrId("games");
  const tradeInLines = app.findCollectionByNameOrId("trade_in_lines");
  tradeInLines.fields.add(
    new Field({
      name: "kind",
      type: "select",
      maxSelect: 1,
      values: ["single", "graded", "retro", "sealed", "accessory", "other"],
    })
  );
  tradeInLines.fields.add(
    new Field({ name: "game", type: "relation", collectionId: games.id, maxSelect: 1 })
  );
  tradeInLines.fields.add(
    new Field({
      name: "completeness",
      type: "select",
      maxSelect: 1,
      values: ["loose", "boxed", "cib"],
    })
  );
  app.save(tradeInLines);

  // -------------------------------------------------------------------
  // settings: new fields
  // -------------------------------------------------------------------
  const locations = app.findCollectionByNameOrId("locations");
  const settings = app.findCollectionByNameOrId("settings");
  settings.fields.add(
    new Field({ name: "cash_variance_alert", type: "number", onlyInt: true, min: 0 })
  );
  settings.fields.add(new Field({ name: "offer", type: "json", maxSize: 5000 }));
  settings.fields.add(
    new Field({
      name: "default_intake_location",
      type: "relation",
      collectionId: locations.id,
      maxSelect: 1,
    })
  );
  settings.fields.add(new Field({ name: "email", type: "json", maxSize: 5000 }));
  settings.fields.add(new Field({ name: "receipt_terms", type: "text", max: 4000 }));
  app.save(settings);

  // -------------------------------------------------------------------
  // Defaults on the seeded settings row (1789819620_seed.js). Only the
  // new fields are touched, so a shop that has already tuned the others
  // keeps its values.
  // -------------------------------------------------------------------
  let row = null;
  try {
    row = app.findFirstRecordByFilter("settings", "id != ''");
  } catch (err) {
    row = null; // no settings row yet (fresh, pre-seed database)
  }
  if (row) {
    let intakeLocation = "";
    try {
      intakeLocation = app.findFirstRecordByFilter("locations", "name = {:name}", {
        name: "Storeroom",
      }).id;
    } catch (err) {
      intakeLocation = "";
    }

    row.set("cash_variance_alert", 1000); // £10.00
    // Matches OfferSettings / DEFAULT_OFFER_SETTINGS in packages/shared/src/pricing.ts.
    row.set("offer", {
      bulkThreshold: 100,
      bulkCash: 5,
      bulkCredit: 10,
      minimumOffer: 25,
    });
    if (intakeLocation) row.set("default_intake_location", intakeLocation);
    row.set("email", {
      from_name: "GG Entertainment",
      from_address: "",
      reply_to: "",
      // On until a real SMTP host and from address are configured: receipts
      // are logged, never sent, so a fresh install cannot email a customer
      // by accident.
      test_mode: true,
    });
    row.set(
      "receipt_terms",
      "Items bought outright. We check every item before it goes on sale. " +
        "By signing you confirm the items are yours to sell and that the details above are correct. " +
        "We keep this record, and the seller details on it, for six years."
    );
    app.save(row);
  }
}, (app) => {
  const settings = app.findCollectionByNameOrId("settings");
  settings.fields.removeByName("receipt_terms");
  settings.fields.removeByName("email");
  settings.fields.removeByName("default_intake_location");
  settings.fields.removeByName("offer");
  settings.fields.removeByName("cash_variance_alert");
  app.save(settings);

  const tradeInLines = app.findCollectionByNameOrId("trade_in_lines");
  tradeInLines.fields.removeByName("completeness");
  tradeInLines.fields.removeByName("game");
  tradeInLines.fields.removeByName("kind");
  app.save(tradeInLines);

  const tradeIns = app.findCollectionByNameOrId("trade_ins");
  const numberField = tradeIns.fields.getByName("number");
  numberField.required = true;
  tradeIns.fields.add(numberField);
  tradeIns.removeIndex("idx_trade_ins_number_unique");
  tradeIns.addIndex("idx_trade_ins_number_unique", true, "number", "");
  app.save(tradeIns);

  const idDocuments = app.findCollectionByNameOrId("id_documents");
  idDocuments.fields.removeByName("mime");
  app.save(idDocuments);
});
