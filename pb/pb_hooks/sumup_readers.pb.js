/// <reference path="../pb_data/types.d.ts" />

/**
 * sumup_readers.pb.js - the SumUp Solo card reader at the counter.
 *
 *   GET    /api/vault/sumup/readers               (staff)
 *   POST   /api/vault/sumup/readers               (admin)
 *   DELETE /api/vault/sumup/readers/{id}          (admin)
 *   POST   /api/vault/sumup/checkouts             (staff)
 *   GET    /api/vault/sumup/checkouts/{id}        (staff)
 *   POST   /api/vault/sumup/checkouts/{id}/cancel (staff)
 *   POST   /api/vault/sumup/callback/{token}      (public, SumUp's own callback)
 *   cron   checkouts_expire  (every five minutes)
 *
 * docs/api-contract.md's Phase 7 section for the shapes; lib/readers.js
 * for the logic, adapters/sumup.js for the calls themselves. Phase 4's
 * own pull and reconcile routes stay in sumup.pb.js: this file is the
 * reader, that one is the merchant account's transaction history.
 *
 * The callback is the only public route in this package. It never says
 * whether a token exists (an unknown one is a bare 404), never logs the
 * token, and never believes what it was sent: every transition is decided
 * from the merchant's own transaction record (lib/readers.js).
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/sumup/readers   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/sumup/readers",
  (e) => {
    const readers = require(`${__hooks}/lib/readers.js`);
    const adapter = require(`${__hooks}/adapters/sumup.js`);

    const cfg = readers.config(e.app);
    if (!readers.isConfigured(cfg)) {
      // A shop that has not set SumUp up yet is not an error: the Settings
      // screen has to be able to load and say so.
      return e.json(200, { readers: [], default_reader_id: "", not_configured: true });
    }

    let result = null;
    try {
      result = adapter.listReaders(cfg.merchantCode, cfg.apiKey);
    } catch (err) {
      console.log(`[readers] list failed: ${err}`);
      throw e.error(502, adapter.READER_MESSAGES.unavailable, null);
    }
    if (!result.ok) {
      throw e.error(502, adapter.READER_MESSAGES.unavailable, null);
    }

    return e.json(200, { readers: result.data, default_reader_id: cfg.defaultReaderId });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/sumup/readers   (admin)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sumup/readers",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const readers = require(`${__hooks}/lib/readers.js`);
    const adapter = require(`${__hooks}/adapters/sumup.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);
    const body = util.body(e);
    const pairingCode = util.asStr(body.pairing_code);
    const name = util.asStr(body.name).slice(0, 60);

    if (!pairingCode) {
      throw e.badRequestError("Enter the pairing code from the reader's own Connections screen.", null);
    }

    const cfg = readers.config(e.app);
    if (!readers.isConfigured(cfg)) {
      throw e.error(422, readers.MESSAGES.not_configured, null);
    }

    let result = null;
    try {
      result = adapter.pairReader(cfg.merchantCode, cfg.apiKey, pairingCode, name);
    } catch (err) {
      console.log(`[readers] pair failed: ${err}`);
      throw e.error(502, adapter.READER_MESSAGES.unavailable, null);
    }
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    const reader = result.data || { id: "", name: name, status: "", model: "" };
    e.app.runInTransaction((txApp) => {
      if (!cfg.defaultReaderId && reader.id) {
        readers.saveSumupSettings(txApp, {
          default_reader_id: reader.id,
          default_reader_name: reader.name || name,
        });
      }
      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "sumup_reader_paired",
        collection: "settings",
        record: "",
        meta: { reader: reader.id, name: reader.name || name, made_default: !cfg.defaultReaderId },
        ip: e.realIP(),
      });
    });

    return e.json(200, { reader: reader });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// DELETE /api/vault/sumup/readers/{id}   (admin)
// ---------------------------------------------------------------------
routerAdd(
  "DELETE",
  "/api/vault/sumup/readers/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const readers = require(`${__hooks}/lib/readers.js`);
    const adapter = require(`${__hooks}/adapters/sumup.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);
    const readerId = e.request.pathValue("id");

    const cfg = readers.config(e.app);
    if (!readers.isConfigured(cfg)) {
      throw e.error(422, readers.MESSAGES.not_configured, null);
    }

    let result = null;
    try {
      result = adapter.unpairReader(cfg.merchantCode, cfg.apiKey, readerId);
    } catch (err) {
      console.log(`[readers] unpair failed: ${err}`);
      throw e.error(502, adapter.READER_MESSAGES.unavailable, null);
    }
    if (!result.ok) {
      throw e.error(502, adapter.READER_MESSAGES.unavailable, null);
    }

    e.app.runInTransaction((txApp) => {
      if (cfg.defaultReaderId === readerId) {
        readers.saveSumupSettings(txApp, { default_reader_id: "", default_reader_name: "" });
      }
      auditLib.writeAuditLog(txApp, {
        actor: staff.id,
        action: "sumup_reader_removed",
        collection: "settings",
        record: "",
        meta: { reader: readerId, was_default: cfg.defaultReaderId === readerId },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/sumup/checkouts   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sumup/checkouts",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const readers = require(`${__hooks}/lib/readers.js`);

    const staff = e.auth;
    const body = util.body(e);

    // Pence, as a whole number. A client sending "42.00" means pounds,
    // and this route only ever deals in pence, so anything that is not
    // already an integer or a string of digits is refused rather than
    // quietly read as 42p (lib/readers.js raises the sentence).
    const rawAmount = body.amount;
    let amount = 0;
    if (typeof rawAmount === "number") {
      amount = rawAmount;
    } else if (/^\d+$/.test(util.asStr(rawAmount))) {
      amount = Number(util.asStr(rawAmount));
    } else {
      amount = -1;
    }

    const result = readers.createCheckout(e.app, {
      staffId: staff.id,
      amount: amount,
      saleClientId: util.asStr(body.sale_client_id),
      description: util.asStr(body.description),
      readerId: util.asStr(body.reader_id),
    });
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    return e.json(200, { checkout: readers.shape(result.record), reused: !!result.reused });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/sumup/checkouts/{id}   (staff)
//
// The counter polls this every three seconds while it waits, on top of
// its realtime subscription, so a callback that never arrives cannot
// strand a sale. A row still pending more than five seconds after it was
// created is verified against SumUp before it is returned.
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/sumup/checkouts/{id}",
  (e) => {
    const readers = require(`${__hooks}/lib/readers.js`);

    let checkout = null;
    try {
      checkout = e.app.findRecordById("sumup_checkouts", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That card payment was not found. Take the payment on the reader again.", null);
    }

    if (checkout.getString("status") === "pending") {
      const created = new Date(checkout.getString("created").replace(" ", "T"));
      const age = isNaN(created.getTime()) ? readers.POLL_VERIFY_AFTER_MS : Date.now() - created.getTime();
      // The counter polls every three seconds for as long as the customer
      // is at the reader, so one payment would otherwise be hundreds of
      // outbound calls: a checkout is asked about at most once every
      // readers.VERIFY_THROTTLE_MS, whoever is polling (lib/readers.js).
      if (age >= readers.POLL_VERIFY_AFTER_MS && !readers.verifiedRecently(e.app, checkout.id)) {
        const outcome = readers.verify(e.app, checkout, {
          actor: e.auth ? e.auth.id : "system",
          ip: e.realIP(),
          source: "poll",
          readerStatusFallback: true,
        });
        if (outcome.record) checkout = outcome.record;
      }
    }

    return e.json(200, { checkout: readers.shape(checkout) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/sumup/checkouts/{id}/cancel   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sumup/checkouts/{id}/cancel",
  (e) => {
    const readers = require(`${__hooks}/lib/readers.js`);

    const staff = e.auth;
    let checkout = null;
    try {
      checkout = e.app.findRecordById("sumup_checkouts", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That card payment was not found. Take the payment on the reader again.", null);
    }

    // The till that started a payment, or an admin, may stop it. Anyone
    // else would be cancelling a payment happening at somebody else's
    // counter.
    const isOwner = checkout.getString("staff") === staff.id;
    const isAdmin = staff.getString("role") === "admin";
    if (!isOwner && !isAdmin) {
      throw e.forbiddenError("Only the staff member who started this payment, or an admin, can stop it.", null);
    }

    const result = readers.cancel(e.app, checkout, { actor: staff.id, ip: e.realIP() });
    if (!result.ok) {
      const body = { message: result.message, checkout: readers.shape(result.record) };
      return e.json(result.status, body);
    }

    return e.json(200, { checkout: readers.shape(result.record) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/sumup/callback/{token}   (public)
//
// SumUp POSTs here once a reader transaction reaches a final state. The
// token proves which checkout is meant and nothing else: an unknown one
// is a bare 404 with no body at all, and the body that was sent is only
// ever read for a failure reason to show staff. What actually happened is
// read from the merchant's own transaction record (lib/readers.js).
// ---------------------------------------------------------------------
routerAdd("POST", "/api/vault/sumup/callback/{token}", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const readers = require(`${__hooks}/lib/readers.js`);

  const checkout = readers.findByToken(e.app, e.request.pathValue("token"));
  if (!checkout) {
    // No hint, no body: a caller guessing tokens learns nothing.
    return e.noContent(404);
  }

  let failureReason = "";
  try {
    const body = util.body(e);
    const payload = body && typeof body.payload === "object" && body.payload ? body.payload : body || {};
    failureReason = util.asStr(payload.failure_reason);
  } catch (err) {
    failureReason = "";
  }

  try {
    readers.verify(e.app, checkout, { source: "callback", failureReason: failureReason, ip: e.realIP() });
  } catch (err) {
    // Never the token, and never the body: just which row could not be
    // settled, so the poll and the cron can pick it up instead.
    console.log(`[readers] callback could not settle checkout ${checkout.id}: ${err}`);
  }

  return e.json(200, {});
});

// ---------------------------------------------------------------------
// settings.sumup's two reader fields, when an admin writes them by hand
// through the collection API rather than through the pairing route.
// ---------------------------------------------------------------------
onRecordUpdateRequest((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const sumup = util.jsonField(e.record, "sumup", {}) || {};
  const fields = ["default_reader_id", "default_reader_name"];
  for (let i = 0; i < fields.length; i++) {
    const value = sumup[fields[i]];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length > 100) {
      throw e.badRequestError(
        "The default card reader is saved as its id and name, both text of 100 characters or fewer. Pair a reader under Settings instead of typing one in.",
        null
      );
    }
  }

  // A json field is replaced wholesale by a PATCH, so a screen saving the
  // merchant code without echoing the reader back would silently unpair
  // it. Anything the stored row had and this write does not mention is
  // put back; clearing a key is still possible by sending it empty.
  const previous = util.jsonField(e.record.original(), "sumup", {}) || {};
  let restored = false;
  for (const key in previous) {
    if (!Object.prototype.hasOwnProperty.call(previous, key)) continue;
    if (sumup[key] === undefined) {
      sumup[key] = previous[key];
      restored = true;
    }
  }
  if (restored) e.record.set("sumup", sumup);

  e.next();
}, "settings");

// ---------------------------------------------------------------------
// cron checkouts_expire, every five minutes
//
// A pending checkout older than fifteen minutes is asked about once more
// and then closed, so the Sell screen is never left waiting on a reader
// that was switched off an hour ago. One that turns out to have been paid
// is marked paid rather than expired.
// ---------------------------------------------------------------------
cronAdd("checkouts_expire", "*/5 * * * *", () => {
  const readers = require(`${__hooks}/lib/readers.js`);
  try {
    const result = readers.expirePending($app, new Date());
    if (result.checked > 0) {
      console.log(
        `[cron:checkouts_expire] checked ${result.checked}, expired ${result.expired}, paid ${result.paid}`
      );
    }
  } catch (err) {
    console.log(`[cron:checkouts_expire] failed: ${err}`);
  }
});
