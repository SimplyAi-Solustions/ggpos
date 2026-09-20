/**
 * Want-list matching, fulfilment and the hold window - the logic behind
 * wants.pb.js's item hooks, its two customer routes and the holds_release
 * cron. Kept out of wants.pb.js itself per CLAUDE.md's "keep hooks small".
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** settings.holds.hours, or the documented default of 48. */
function holdHours(app, settingsRow) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var row = settingsRow || util.settings(app);
  var holds = row ? util.jsonField(row, "holds", {}) : {};
  var hours = holds && holds.hours;
  return hours > 0 ? hours : 48;
}

/** "22 Sep, 14:00" - day, short month, 24-hour time. UTC, matching
 * lib/receipts.js's own ukDate on why this codebase treats a stored UTC
 * instant as the display time rather than converting to Europe/London
 * (the sales heatmap in lib/reports/dates.js is the one deliberate
 * exception, and only for that one figure). */
function ukDateTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  var hh = String(d.getUTCHours()).padStart(2, "0");
  var mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${hh}:${mm}`;
}

/**
 * The oldest open want_list row for `item`'s card whose max_price is empty
 * (0, PocketBase's plain-number zero value - see PricingRule.bandMax in
 * packages/shared/src/pricing.ts for the same "0 means no real bound"
 * convention) or at least the item's price. Only cards match: a free-text
 * row has nothing this codebase can compare an item against automatically.
 */
function findOpenWant(app, item) {
  var cardId = item.getString("card");
  if (!cardId) return null;
  var price = item.getInt("price");
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "want_list",
      'status = "open" && card = {:card} && (max_price = 0 || max_price >= {:price})',
      "created",
      1,
      0,
      { card: cardId, price: price }
    );
  } catch (err) {
    rows = [];
  }
  return rows && rows.length ? rows[0] : null;
}

/**
 * Called after an item is created in_stock, or returns to in_stock
 * (docs/PLAN.md, "Want lists"). Reserves the item for the oldest matching
 * open want-list row, marks that row matched, and notifies the customer.
 * A no-op when nothing matches. Never throws - a matching failure must
 * never block the item write that triggered it.
 */
function matchOnStock(app, item) {
  try {
    if (item.getString("status") !== "in_stock") return;
    var want = findOpenWant(app, item);
    if (!want) return;

    var util = require(`${__hooks}/lib/vaultutil.js`);
    var notifyLib = require(`${__hooks}/lib/notify.js`);
    var settingsRow = util.settings(app);
    var now = new Date();
    var until = new Date(now.getTime() + holdHours(app, settingsRow) * 3600 * 1000);

    item.set("status", "reserved");
    item.set("reserved_for", want.getString("customer"));
    item.set("reserved_until", until.toISOString());
    app.save(item);

    want.set("status", "matched");
    want.set("matched_item", item.id);
    want.set("notified_at", now.toISOString());
    app.save(want);

    var title = item.getString("title") || "An item on your want list";
    notifyLib.notify(app, {
      customer: want.getString("customer"),
      type: "want_match",
      title: "It is in and held for you",
      body: `${title} is in. Held for you until ${ukDateTime(until.toISOString())}.`,
      link: "",
      email: true,
    });
  } catch (err) {
    console.log(`[wants] matchOnStock failed for item ${item.id}: ${err}`);
  }
}

/**
 * Called after a reserved item is sold (docs/PLAN.md: "Selling a reserved
 * item to its customer ... marks the row fulfilled"). The Phase 2 sale
 * route (sales.pb.js) already refuses to sell a reserved item to anyone but
 * `reserved_for`, so by the time this runs the sale was to the right
 * customer. Never throws, for the same reason as matchOnStock.
 */
function fulfilOnSale(app, item) {
  try {
    var rows = [];
    try {
      rows = app.findRecordsByFilter(
        "want_list",
        'status = "matched" && matched_item = {:item}',
        "",
        1,
        0,
        { item: item.id }
      );
    } catch (err) {
      rows = [];
    }
    var row = rows && rows.length ? rows[0] : null;
    if (!row) return;
    row.set("status", "fulfilled");
    app.save(row);
  } catch (err) {
    console.log(`[wants] fulfilOnSale failed for item ${item.id}: ${err}`);
  }
}

/**
 * The holds_release cron (every 15 minutes): every reserved item whose hold
 * has passed goes back to in_stock (which, through the same items hook,
 * immediately tries to match the next oldest open want-list row for that
 * card), its want-list row closes, and its customer is told the hold has
 * gone. Returns how many holds were released.
 */
function releaseExpiredHolds(app) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  var nowIso = new Date().toISOString();

  var items = [];
  try {
    items = app.findRecordsByFilter(
      "items",
      'status = "reserved" && reserved_until != "" && reserved_until < {:now}',
      "",
      0,
      0,
      { now: nowIso }
    );
  } catch (err) {
    items = [];
  }

  var released = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;
    try {
      var wantRows = [];
      try {
        wantRows = app.findRecordsByFilter(
          "want_list",
          'status = "matched" && matched_item = {:item}',
          "",
          1,
          0,
          { item: item.id }
        );
      } catch (err) {
        wantRows = [];
      }
      var want = wantRows && wantRows.length ? wantRows[0] : null;
      var customerId = want ? want.getString("customer") : item.getString("reserved_for");

      if (want) {
        want.set("status", "closed");
        app.save(want);
      }

      // Saving the item back to in_stock re-fires the same items hook that
      // matched it in the first place, which is what lets the next open
      // want-list row for this card take it immediately.
      item.set("status", "in_stock");
      item.set("reserved_for", "");
      item.set("reserved_until", "");
      app.save(item);
      released += 1;

      if (customerId) {
        var title = item.getString("title") || "The item you had on hold";
        notifyLib.notify(app, {
          customer: customerId,
          type: "hold_released",
          title: "Hold released",
          body: `The hold on ${title} has ended, so it is back on the shelf. Ask at the counter if you would still like it.`,
          link: "",
          email: true,
        });
      }
    } catch (err) {
      console.log(`[wants] releaseExpiredHolds failed for item ${item.id}: ${err}`);
    }
  }
  return released;
}

module.exports = {
  holdHours: holdHours,
  ukDateTime: ukDateTime,
  findOpenWant: findOpenWant,
  matchOnStock: matchOnStock,
  fulfilOnSale: fulfilOnSale,
  releaseExpiredHolds: releaseExpiredHolds,
};
