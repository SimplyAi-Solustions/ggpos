/// <reference path="../pb_data/types.d.ts" />

/**
 * Part-exchange and exchanges in one ticket (docs/api-contract-epos.md,
 * section 7; docs/EPOS-PLAN.md, "Part-exchange in the same ticket").
 *
 * - `trade_ins.part_exchange_value`: what a trade-in paid towards the sale
 *   it was taken in (pence), and `payout_type` gains `part_exchange` for a
 *   trade-in that paid for the sale and left nothing over.
 * - `sale_tenders.method` and `sales.payment` gain `exchange`: the value of
 *   goods brought back in the same ticket, written once positive on the new
 *   sale and once negative on the old sale's refund, so the two cancel on
 *   an X or a Z and no money moves for that part.
 *
 * `down()` maps any row using the new values back to the nearest old one
 * (`credit`, `mixed`) and drops the field.
 */
migrate(
  (app) => {
    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    tradeIns.fields.getByName("payout_type").values = ["cash", "credit", "mixed", "part_exchange"];
    tradeIns.fields.add(new Field({ name: "part_exchange_value", type: "number", onlyInt: true, min: 0 }));
    app.save(tradeIns);

    const tenders = app.findCollectionByNameOrId("sale_tenders");
    const method = tenders.fields.getByName("method");
    method.values = method.values.concat(["exchange"]);
    app.save(tenders);

    const sales = app.findCollectionByNameOrId("sales");
    const payment = sales.fields.getByName("payment");
    payment.values = payment.values.concat(["exchange"]);
    app.save(sales);
  },
  (app) => {
    const sales = app.findCollectionByNameOrId("sales");
    app.findRecordsByFilter("sales", "payment = 'exchange'", "", 0, 0).forEach((row) => {
      row.set("payment", "mixed");
      app.saveNoValidate(row);
    });
    const payment = sales.fields.getByName("payment");
    payment.values = payment.values.filter((v) => v !== "exchange");
    app.save(sales);

    const tenders = app.findCollectionByNameOrId("sale_tenders");
    app.findRecordsByFilter("sale_tenders", "method = 'exchange'", "", 0, 0).forEach((row) => {
      app.delete(row);
    });
    const method = tenders.fields.getByName("method");
    method.values = method.values.filter((v) => v !== "exchange");
    app.save(tenders);

    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    app.findRecordsByFilter("trade_ins", "payout_type = 'part_exchange'", "", 0, 0).forEach((row) => {
      row.set("payout_type", "credit");
      app.saveNoValidate(row);
    });
    tradeIns.fields.getByName("payout_type").values = ["cash", "credit", "mixed"];
    tradeIns.fields.removeByName("part_exchange_value");
    app.save(tradeIns);
  }
);
