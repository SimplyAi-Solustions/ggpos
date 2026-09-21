/// <reference path="../pb_data/types.d.ts" />

/**
 * What a buy-in line needs to record a staff override and a retro item's
 * cosmetic grade.
 *
 * Added to `trade_in_lines`:
 *  - override_reason   why the staff member moved off the computed offer.
 *                      **This field is the override flag**: a line is
 *                      overridden when it is non-empty, and the completion
 *                      route lists those line ids in its audit meta. The
 *                      reason itself stays here on the line and never goes
 *                      into `audit_log`, which is permanent and
 *                      superuser-only.
 *  - override_cash     the overridden cash figure, in pence.
 *  - override_credit   the overridden store credit figure, in pence.
 *                      Both are what the staff member typed for each payout
 *                      type, kept for the record. `offer_price` stays the
 *                      figure actually paid for the payout type chosen, so
 *                      the completion route's payout arithmetic is
 *                      unchanged and still reads `offer_price` alone.
 *  - cosmetic_grade    A, B or C, the same scale as `items.cosmetic_grade`.
 *                      The completion route copies it onto the item it
 *                      creates for a retro line.
 *
 * Nothing here is required: an ordinary line at the computed offer leaves
 * all four empty.
 */
migrate((app) => {
  const tradeInLines = app.findCollectionByNameOrId("trade_in_lines");

  tradeInLines.fields.add(new Field({ name: "override_reason", type: "text", max: 500 }));
  tradeInLines.fields.add(
    new Field({ name: "override_cash", type: "number", onlyInt: true, min: 0 })
  );
  tradeInLines.fields.add(
    new Field({ name: "override_credit", type: "number", onlyInt: true, min: 0 })
  );
  tradeInLines.fields.add(
    new Field({
      name: "cosmetic_grade",
      type: "select",
      maxSelect: 1,
      values: ["A", "B", "C"],
    })
  );

  app.save(tradeInLines);
}, (app) => {
  const tradeInLines = app.findCollectionByNameOrId("trade_in_lines");
  tradeInLines.fields.removeByName("cosmetic_grade");
  tradeInLines.fields.removeByName("override_credit");
  tradeInLines.fields.removeByName("override_cash");
  tradeInLines.fields.removeByName("override_reason");
  app.save(tradeInLines);
});
