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
 * One want_list row as the portal reads it: the bare relation id is
 * expanded into `{ id, name, set, number, image }` (or null for a
 * free-text row) so the screen has a title and a picture without a
 * follow-up request - the same name/set/number shape the public estimate
 * route already returns a card as, plus `image` the same way that route's
 * own `image_large || image_small` fallback reads it.
 *
 * `hold` is taken from the matched `items` row at read time - never cached
 * on the want_list row itself, since `items` is staff-only and the row's
 * own `matched_item` is otherwise just a bare id the customer has no rule
 * letting them resolve on their own. It is only ever non-null while the
 * row is actually `matched`: a `closed` row (holds_release already cleared
 * the item's own `reserved_until`) or a `fulfilled` one (the item is sold)
 * has nothing currently held, so both read back `hold: null`, the same as
 * an `open` row that was never matched at all.
 */
function wantRowShape(app, row) {
  var cardId = row.getString("card");
  var card = null;
  if (cardId) {
    try {
      var cardRow = app.findRecordById("cards", cardId);
      var setName = "";
      try {
        setName = app.findRecordById("card_sets", cardRow.getString("set")).getString("name");
      } catch (err) {
        setName = "";
      }
      card = {
        id: cardRow.id,
        name: cardRow.getString("name"),
        set: setName,
        number: cardRow.getString("number"),
        image: cardRow.getString("image_large") || cardRow.getString("image_small") || "",
      };
    } catch (err) {
      card = null;
    }
  }

  var hold = null;
  var matchedItemId = row.getString("matched_item");
  if (matchedItemId && row.getString("status") === "matched") {
    try {
      var itemRow = app.findRecordById("items", matchedItemId);
      hold = {
        until: itemRow.getString("reserved_until"),
        price: itemRow.getInt("price"),
        title: itemRow.getString("title"),
      };
    } catch (err) {
      hold = null;
    }
  }

  return {
    id: row.id,
    card: card,
    free_text: row.getString("free_text"),
    max_price: row.getInt("max_price"),
    status: row.getString("status"),
    matched_item: row.getString("matched_item"),
    notified_at: row.getString("notified_at"),
    created: row.getString("created"),
    hold: hold,
  };
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
 *
 * The item's own reservation, the want row's own match, and the
 * notification are one `app.runInTransaction` (fix round, finding 13:
 * "want row plus item plus notification" must not be three independent
 * writes that a crash between them could leave half-done); the email
 * itself is sent only once that transaction has actually committed (fix
 * round, finding 7: sending mail while a write lock is held risks holding
 * it open for as long as the outbound send takes).
 *
 * Saves `item` and `want` themselves through `txApp`, rather than
 * re-fetching fresh copies by id inside the transaction: this is called
 * from an `items` `onRecordCreate`/`onRecordUpdate` hook, whose own
 * caller (PocketBase's own record-create/update response) serialises
 * whatever `item`'s own in-memory fields are once this call returns - a
 * re-fetched copy's own writes would reach the database correctly but
 * leave this same `item` reference looking unmatched in the very
 * response reporting it, which is exactly the regression an earlier
 * version of this fix round shipped and check.sh's own "was not reserved
 * on creation" assertion caught.
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
    var untilIso = until.toISOString();

    var pending = [];
    app.runInTransaction(function (txApp) {
      item.set("status", "reserved");
      item.set("reserved_for", want.getString("customer"));
      item.set("reserved_until", untilIso);
      txApp.save(item);

      want.set("status", "matched");
      want.set("matched_item", item.id);
      want.set("notified_at", now.toISOString());
      txApp.save(want);

      var title = item.getString("title") || "An item on your want list";
      var n = notifyLib.notify(txApp, {
        customer: want.getString("customer"),
        type: "want_match",
        title: "It is in and held for you",
        body: `${title} is in. Held for you until ${ukDateTime(untilIso)}.`,
        link: "/account/wants",
        email: true,
      });
      pending = pending.concat(n.pending || []);
    });
    notifyLib.sendPending(app, pending);
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
 *
 * Only releases an item that a `matched` want_list row actually points at
 * (fix round, finding 12): `reserved_for`/`reserved_until` are Phase 1/2
 * fields on `items` (`1789819320_stock_collections.js`), general enough for
 * a member of staff to reserve an item for a customer by hand outside any
 * want-list flow at all, and this cron must never undo that just because
 * its own `reserved_until` also happens to have passed - a want-list match
 * is the only kind of hold this cron is allowed to end.
 *
 * The query itself compares `reserved_until` (a PocketBase-stored date,
 * space-separated) against `{:now}` as text, so `{:now}` has to be written
 * the same way - an ISO "T" separator sorts as *greater* than every stored
 * value on the same calendar day (`"T"` > any digit > `" "` in ASCII),
 * which used to make every hold due today read as already expired the
 * moment the clock passed midnight UTC, regardless of what time later that
 * day it actually was due (pb_hooks/crons.pb.js's own `pbDate` comment
 * documents this exact trap; this file just was not yet following it).
 *
 * Each item's own release (item, want row, notification) is one
 * `app.runInTransaction`, the same reasoning matchOnStock's own comment
 * gives (fix round, finding 13); the email for each is sent only once that
 * item's own transaction has committed (finding 7).
 */
function releaseExpiredHolds(app) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  var nowPb = new Date().toISOString().replace("T", " ");

  var items = [];
  try {
    items = app.findRecordsByFilter(
      "items",
      'status = "reserved" && reserved_until != "" && reserved_until < {:now}',
      "",
      0,
      0,
      { now: nowPb }
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
      // No matching want-list row: this is a staff reservation, not a
      // want-list hold, and this cron has no business touching it.
      if (!want) continue;

      var itemId = item.id;
      var wantId = want.id;
      var customerId = want.getString("customer");
      var itemTitle = item.getString("title") || "The item you had on hold";

      var pending = [];
      app.runInTransaction(function (txApp) {
        var txWant = txApp.findRecordById("want_list", wantId);
        txWant.set("status", "closed");
        txApp.save(txWant);

        // Saving the item back to in_stock re-fires the same items hook
        // that matched it in the first place, which is what lets the next
        // open want-list row for this card take it immediately.
        var txItem = txApp.findRecordById("items", itemId);
        txItem.set("status", "in_stock");
        txItem.set("reserved_for", "");
        txItem.set("reserved_until", "");
        txApp.save(txItem);

        var n = notifyLib.notify(txApp, {
          customer: customerId,
          type: "hold_released",
          title: "Hold released",
          body: `The hold on ${itemTitle} has ended, so it is back on the shelf. Ask at the counter if you would still like it.`,
          link: "/account/wants",
          email: true,
        });
        pending = pending.concat(n.pending || []);
      });
      notifyLib.sendPending(app, pending);
      released += 1;
    } catch (err) {
      console.log(`[wants] releaseExpiredHolds failed for item ${item.id}: ${err}`);
    }
  }
  return released;
}

module.exports = {
  holdHours: holdHours,
  ukDateTime: ukDateTime,
  wantRowShape: wantRowShape,
  findOpenWant: findOpenWant,
  matchOnStock: matchOnStock,
  fulfilOnSale: fulfilOnSale,
  releaseExpiredHolds: releaseExpiredHolds,
};
