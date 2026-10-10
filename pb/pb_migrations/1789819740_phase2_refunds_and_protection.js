/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 2, second pass: what the reviewed refund arithmetic, the ID gate
 * and the protected-file work need.
 *
 * Added:
 *  - sale_lines.refunded_qty   how many of the units on this line have gone
 *                              back. `qty` and `discount` are the as-sold
 *                              figures and are never rewritten, so a
 *                              sequence of partial refunds can be priced
 *                              from immutable numbers and always sums to
 *                              exactly what was paid (pb_hooks/sales.pb.js).
 *  - sales.refunded_total      the pence refunded so far across every line,
 *                              which the cumulative points reversal is
 *                              worked out from.
 *  - trade_ins.id_document     the id_documents row that satisfied the ID
 *                              gate on a cash buy-in, so the six-year buy-in
 *                              register can say which photo was taken and
 *                              the retention cron can see the photo is still
 *                              in use.
 *
 * Changed:
 *  - trade_ins.signature and quotes.photos become `protected: true`. A
 *    protected file is only served with a short-lived file token, so a
 *    customer's signature and the photos they sent in for a valuation stop
 *    being readable by anyone who learns the record id. items.photos stays
 *    public: that is product imagery for the shop front.
 *  - cash_sessions gains a partial unique index over `closed_at` where it is
 *    empty, so the database itself allows only one open session. Two staff
 *    members hitting "open session" at the same moment now collide on the
 *    index instead of both winning (pb_hooks/cash.pb.js turns the violation
 *    into the same 409). PocketBase passes the WHERE clause through to
 *    SQLite (verified against this binary, and the same shape is already in
 *    use on trade_ins.number).
 *
 * Note: an install that somehow has two open cash sessions has to close one
 * before this migration can apply, which is the point.
 */
migrate((app) => {
  // -------------------------------------------------------------------
  // sale_lines.refunded_qty / sales.refunded_total
  // -------------------------------------------------------------------
  const saleLines = app.findCollectionByNameOrId("sale_lines");
  saleLines.fields.add(
    new Field({ name: "refunded_qty", type: "number", onlyInt: true, min: 0 })
  );
  app.save(saleLines);

  const sales = app.findCollectionByNameOrId("sales");
  sales.fields.add(
    new Field({ name: "refunded_total", type: "number", onlyInt: true, min: 0 })
  );
  app.save(sales);

  // -------------------------------------------------------------------
  // trade_ins.id_document, plus the protected signature
  // -------------------------------------------------------------------
  const idDocuments = app.findCollectionByNameOrId("id_documents");
  const tradeIns = app.findCollectionByNameOrId("trade_ins");
  tradeIns.fields.add(
    new Field({
      name: "id_document",
      type: "relation",
      collectionId: idDocuments.id,
      maxSelect: 1,
      // The retention cron deletes an expired photo; the buy-in register
      // must survive that, so the trade-in is never cascaded away with it.
      cascadeDelete: false,
    })
  );
  // Mutated through getByName and re-added by its existing id, so the
  // column keeps its identity (adding a fresh Field with the same name but
  // a new id reads as a drop-and-recreate to PocketBase's schema diff).
  const signature = tradeIns.fields.getByName("signature");
  signature.protected = true;
  tradeIns.fields.add(signature);
  app.save(tradeIns);

  // -------------------------------------------------------------------
  // quotes.photos: a customer's own valuation photos
  // -------------------------------------------------------------------
  const quotes = app.findCollectionByNameOrId("quotes");
  const photos = quotes.fields.getByName("photos");
  photos.protected = true;
  quotes.fields.add(photos);
  app.save(quotes);

  // -------------------------------------------------------------------
  // One open cash session at a time, enforced by the database
  // -------------------------------------------------------------------
  const cashSessions = app.findCollectionByNameOrId("cash_sessions");
  cashSessions.addIndex("idx_cash_sessions_one_open", true, "closed_at", "closed_at = ''");
  app.save(cashSessions);
}, (app) => {
  const cashSessions = app.findCollectionByNameOrId("cash_sessions");
  cashSessions.removeIndex("idx_cash_sessions_one_open");
  app.save(cashSessions);

  const quotes = app.findCollectionByNameOrId("quotes");
  const photos = quotes.fields.getByName("photos");
  photos.protected = false;
  quotes.fields.add(photos);
  app.save(quotes);

  const tradeIns = app.findCollectionByNameOrId("trade_ins");
  const signature = tradeIns.fields.getByName("signature");
  signature.protected = false;
  tradeIns.fields.add(signature);
  tradeIns.fields.removeByName("id_document");
  app.save(tradeIns);

  const sales = app.findCollectionByNameOrId("sales");
  sales.fields.removeByName("refunded_total");
  app.save(sales);

  const saleLines = app.findCollectionByNameOrId("sale_lines");
  saleLines.fields.removeByName("refunded_qty");
  app.save(saleLines);
});
