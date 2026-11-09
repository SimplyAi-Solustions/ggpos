/// <reference path="../pb_data/types.d.ts" />

/**
 * binders_stock.pb.js - the stock-arrival side of "In stock at GG".
 *
 * Watches the staff side's `items` collection: when a row becomes available
 * (created as in_stock with qty > 0 and a catalogue card, or updated into
 * that state), lib/binders_stock.js checks whether that exact print just
 * came back onto the shelf and writes one binder_alerts row per customer
 * whose binders still need it. Reading availability happens in
 * binders.pb.js; this file only reacts to stock changes.
 *
 * The alert work sits after e.next() in a try/catch so it can never break
 * a stock write - the shop till and intake always win over a notification.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

onRecordCreate(
  (e) => {
    e.next();
    try {
      const S = require(`${__hooks}/lib/binders_stock.js`);
      if (S.itemIsAvailable(e.record.getString("status"), e.record.getInt("qty"), e.record.getString("card"))) {
        S.onItemAvailable(e.app, e.record);
      }
    } catch (err) {
      console.log(`[binder_alerts] could not check new item ${e.record.id}: ${err}`);
    }
  },
  "items"
);

onRecordUpdate(
  (e) => {
    const before = e.record.original();
    const wasStatus = before.getString("status");
    const wasQty = before.getInt("qty");
    const wasCard = before.getString("card");
    e.next();
    try {
      const S = require(`${__hooks}/lib/binders_stock.js`);
      const was = S.itemIsAvailable(wasStatus, wasQty, wasCard);
      const now = S.itemIsAvailable(e.record.getString("status"), e.record.getInt("qty"), e.record.getString("card"));
      if (!was && now) S.onItemAvailable(e.app, e.record);
    } catch (err) {
      console.log(`[binder_alerts] could not check updated item ${e.record.id}: ${err}`);
    }
  },
  "items"
);
