/// <reference path="../pb_data/types.d.ts" />

/**
 * wants.pb.js - want lists with holds (docs/PLAN.md, "Want lists";
 * docs/api-contract.md's Phase 5 section).
 *
 *   GET  /api/vault/want-list              (customer, own rows)
 *   POST /api/vault/want-list              (customer)
 *   POST /api/vault/want-list/{id}/close   (customer own)
 *
 * Plus the items hooks that do the actual matching and fulfilment, and the
 * holds_release cron. The matching and release logic itself lives in
 * lib/wants.js; this file is just the routes and the hook registrations,
 * per CLAUDE.md's "keep hooks small".
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/want-list   (customer, own rows)
//
// Additive, the same reasoning GET /api/vault/quotes documents in
// quotes.pb.js: the collection read (`GET /api/collections/want_list/
// records?filter=customer=<id>`) keeps working under its own unchanged
// rule, but it can never carry `hold` or an expanded `card` - `items` is
// staff-only, so a customer's own token cannot expand `matched_item`
// itself, and this route exists so the portal never has to ask staff for
// that detail some other way.
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/want-list",
  (e) => {
    const wantsLib = require(`${__hooks}/lib/wants.js`);
    const customer = e.auth;

    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "want_list",
        "customer = {:customer}",
        "-created",
        50,
        0,
        { customer: customer.id }
      );
    } catch (err) {
      rows = [];
    }

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      out.push(wantsLib.wantRowShape(e.app, rows[i]));
    }

    return e.json(200, { rows: out });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/want-list   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/want-list",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const wantsLib = require(`${__hooks}/lib/wants.js`);

    const customer = e.auth;
    const body = util.body(e);
    const cardId = util.asStr(body.card);
    const freeText = util.asStr(body.free_text);
    const maxPrice = util.asInt(body.max_price, 0);

    if (!cardId && !freeText) {
      throw e.badRequestError("Pick a card, or describe what you are after.", null);
    }
    if (cardId) {
      try {
        e.app.findRecordById("cards", cardId);
      } catch (err) {
        throw e.notFoundError("Card not found. Check it or describe it instead.", null);
      }
    }
    if (maxPrice < 0) {
      throw e.badRequestError("A maximum price cannot be negative.", null);
    }

    let result = null;
    e.app.runInTransaction((txApp) => {
      const row = new Record(txApp.findCollectionByNameOrId("want_list"), {
        customer: customer.id,
        card: cardId,
        free_text: freeText,
        max_price: maxPrice,
        status: "open",
      });
      txApp.save(row);

      auditLib.writeAuditLog(txApp, {
        actor: customer.id,
        action: "want_list_create",
        collection: "want_list",
        record: row.id,
        meta: { card: cardId || "" },
        ip: e.realIP(),
      });

      result = { row: wantsLib.wantRowShape(txApp, row) };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/want-list/{id}/close   (customer own)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/want-list/{id}/close",
  (e) => {
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const wantsLib = require(`${__hooks}/lib/wants.js`);

    const customer = e.auth;
    const wantId = e.request.pathValue("id");

    let want = null;
    try {
      want = e.app.findRecordById("want_list", wantId);
    } catch (err) {
      throw e.notFoundError("Want-list entry not found.", null);
    }
    // Never lets a customer learn another customer's want-list row exists.
    if (want.getString("customer") !== customer.id) {
      throw e.notFoundError("Want-list entry not found.", null);
    }

    let result = null;
    let halt = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("want_list", wantId);
        if (live.getString("customer") !== customer.id) {
          halt = { status: 404, message: "Want-list entry not found." };
          throw new Error(halt.message);
        }
        live.set("status", "closed");
        txApp.save(live);

        auditLib.writeAuditLog(txApp, {
          actor: customer.id,
          action: "want_list_close",
          collection: "want_list",
          record: live.id,
          meta: {},
          ip: e.realIP(),
        });

        result = { row: wantsLib.wantRowShape(txApp, live) };
      });
    } catch (err) {
      if (halt) throw e.notFoundError(halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// items hooks: match on creation, match on returning to in_stock, and
// fulfil the matched row the moment a reserved item actually sells.
// Separate registrations from items.pb.js's own onRecordCreate/
// onRecordUpdate - PocketBase runs every registered handler for a
// collection, each in its own isolated context (pb/README.md), so this
// keeps want-list logic out of items.pb.js entirely.
// ---------------------------------------------------------------------
onRecordCreate((e) => {
  e.next();
  const wants = require(`${__hooks}/lib/wants.js`);
  wants.matchOnStock(e.app, e.record);
}, "items");

onRecordUpdate((e) => {
  const wasInStock = e.record.original().getString("status") === "in_stock";
  const wasReserved = e.record.original().getString("status") === "reserved";
  const isInStock = e.record.getString("status") === "in_stock";
  const isSold = e.record.getString("status") === "sold";

  e.next();

  const wants = require(`${__hooks}/lib/wants.js`);
  if (isInStock && !wasInStock) {
    wants.matchOnStock(e.app, e.record);
  }
  if (isSold && wasReserved) {
    wants.fulfilOnSale(e.app, e.record);
  }
}, "items");

// ---------------------------------------------------------------------
// Cron: holds_release, every 15 minutes.
// ---------------------------------------------------------------------
cronAdd("holds_release", "*/15 * * * *", () => {
  const wants = require(`${__hooks}/lib/wants.js`);
  const released = wants.releaseExpiredHolds($app);
  if (released > 0) {
    console.log(`[cron:holds_release] released ${released} expired hold(s)`);
  }
});
