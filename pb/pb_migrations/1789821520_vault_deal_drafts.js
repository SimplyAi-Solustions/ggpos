/// <reference path="../pb_data/types.d.ts" />

/**
 * Vault deal drafts (apps/vault/src/features/deals). Additive only.
 *
 *  - trade_ins.customer is no longer required, so a deal can be drafted
 *    before the seller is known. POST /api/vault/deals/{id}/complete
 *    already refuses a deal without a customer (422 "Add a customer to this
 *    deal before completing it."), and so does the counter's own route,
 *    which loads the customer before anything else.
 *  - trade_ins.deal_name: the draft's name as staff typed it ("Sam, vintage
 *    lot"). Empty for every counter buy-in.
 *  - trade_ins.deal_note: the optional note from the deal's review.
 */
migrate(
  (app) => {
    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    // Mutated in place and re-added by its own id, so the column keeps its
    // identity (see 1789819680_phase2_fields.js on trade_ins.number).
    const customer = tradeIns.fields.getByName("customer");
    customer.required = false;
    tradeIns.fields.add(customer);
    tradeIns.fields.add(new Field({ name: "deal_name", type: "text", max: 120 }));
    tradeIns.fields.add(new Field({ name: "deal_note", type: "text", max: 1000 }));
    app.save(tradeIns);
  },
  (app) => {
    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    tradeIns.fields.removeByName("deal_note");
    tradeIns.fields.removeByName("deal_name");
    // Drafts with no customer would block the column going back to
    // required, so they go first.
    app.findRecordsByFilter("trade_ins", "customer = ''", "", 0, 0).forEach((row) => app.delete(row));
    const customer = tradeIns.fields.getByName("customer");
    customer.required = true;
    tradeIns.fields.add(customer);
    app.save(tradeIns);
  }
);
