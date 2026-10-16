/// <reference path="../pb_data/types.d.ts" />

/**
 * sale_receipts.pb.js - a sale's receipt, and emailing it
 * (docs/api-contract-epos.md, section 4, "Receipts data").
 *
 *   GET  /api/vault/sales/{id}/receipt?refund=<ref>&gift=1&reprint=1   (staff)
 *   POST /api/vault/sales/{id}/receipt/email                          (staff)
 *
 * The receipt is `ReceiptData` (packages/shared/src/epos-types.ts), built in
 * lib/salereceipt.js so the printed receipt, the browser print page and the
 * email cannot drift. `refund` gives that refund's receipt; `gift` gives the
 * same data (the renderer hides the prices); `reprint=1` is the counter
 * printing it again, which needs capability `reprint` and is recorded as a
 * `reprint` till event for the X and Z.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/sales/{id}/receipt   (staff; reprint=1 needs reprint)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/sales/{id}/receipt",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const receiptLib = require(`${__hooks}/lib/salereceipt.js`);

    let sale = null;
    try {
      sale = e.app.findRecordById("sales", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Sale not found. Check the number and try again.", null);
    }

    const refundRef = csvLib.queryParam(e, "refund");
    const reprint = util.asBool(csvLib.queryParam(e, "reprint"));

    const built = receiptLib.build(e.app, sale, { refundRef: refundRef });
    if (built.status) throw e.error(built.status, built.message, null);

    if (reprint) {
      const grant = perms.check(e, "reprint");
      if (!grant.ok) return perms.refuse(e, grant);

      // The event belongs to the register the sale was made on (the
      // default one for a sale from before registers), and to its open
      // session when there is one, so the X and Z count it.
      const registerId = sale.getString("register") || (registers.defaultRegister(e.app) || { id: "" }).id;
      let halt = null;
      try {
        e.app.runInTransaction((txApp) => {
          try {
            perms.consume(txApp, grant, "reprint:" + sale.id);
          } catch (err) {
            halt = { status: 409, message: "That approval has already been used. Ask for it again." };
            throw err;
          }
          if (!registerId) return;
          const session = registers.openSession(txApp, registerId);
          const event = new Record(txApp.findCollectionByNameOrId("till_events"), {
            register: registerId,
            kind: "reprint",
            amount: built.receipt.total,
            detail: { sale: sale.getString("number"), number: built.receipt.number },
            staff: e.auth.id,
          });
          if (session) event.set("session", session.id);
          if (grant.approver) event.set("approver", grant.approver.id);
          txApp.save(event);
          perms.logOverrides(txApp, grant, {
            register: registerId,
            session: session ? session.id : "",
            amount: 0,
            detail: { sale: sale.getString("number"), number: built.receipt.number },
            used_for: "reprint:" + sale.id,
          });
        });
      } catch (err) {
        if (halt) throw e.error(halt.status, halt.message, null);
        throw err;
      }
    }

    return e.json(200, { receipt: built.receipt });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/sales/{id}/receipt/email   (staff)
//
// { "email"?: "...", "refund"?: "<ref>" } -> 202 { "sent_to": "s***@example.com" }.
// Defaults to the customer's own address. Goes through the same mail
// settings and test mode as every other email here (lib/notify.js's
// sendEmail, lib/receipts.js's buy-in receipt): while
// settings.email.test_mode is on it logs instead of sending, and says so.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sales/{id}/receipt/email",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const receiptLib = require(`${__hooks}/lib/salereceipt.js`);

    const body = util.body(e);

    let sale = null;
    try {
      sale = e.app.findRecordById("sales", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Sale not found. Check the number and try again.", null);
    }

    let to = util.asStr(body.email);
    if (!to && sale.getString("customer")) {
      try {
        to = e.app.findRecordById("customers", sale.getString("customer")).getString("email");
      } catch (err) {
        to = "";
      }
    }
    if (!to) {
      throw e.badRequestError("There is no email address for this sale. Type one in.", null);
    }
    if (to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw e.badRequestError("That email address does not look right. Check it and type it again.", null);
    }

    const settings = util.settings(e.app);
    const built = receiptLib.build(e.app, sale, { refundRef: util.asStr(body.refund), settings: settings });
    if (built.status) throw e.error(built.status, built.message, null);
    const bodies = receiptLib.render(built.receipt);
    const emailSettings = util.emailSettings(e.app, settings);
    const sentTo = receiptLib.maskEmail(to);

    /** The audit row: the receipt number and whether it went, never the address. */
    function audit(sent) {
      auditLib.writeAuditLog(e.app, {
        actor: e.auth.id,
        action: "sale_receipt_email",
        collection: "sales",
        record: sale.id,
        meta: {
          number: built.receipt.number,
          sent: sent,
          test_mode: emailSettings.test_mode,
          own_address: !util.asStr(body.email),
        },
        ip: e.realIP(),
      });
    }

    // Test mode is on until a real sender and SMTP host are set, so a fresh
    // install cannot email a customer by accident.
    if (emailSettings.test_mode) {
      console.log(`[receipt:test_mode] would email ${built.receipt.number} to an address at the counter (not sent)`);
      audit(false);
      return e.json(202, { sent_to: sentTo, sent: false, test_mode: true });
    }

    const appSettings = e.app.settings();
    const fromAddress =
      emailSettings.from_address || (appSettings.meta ? appSettings.meta.senderAddress : "");
    const fromName =
      emailSettings.from_name || (appSettings.meta ? appSettings.meta.senderName : "") || built.receipt.shop.name;
    if (!fromAddress) {
      throw e.error(
        422,
        "No sender address is set. Add one in Settings > Email before sending receipts.",
        null
      );
    }

    const message = new MailerMessage({
      from: { address: fromAddress, name: fromName },
      to: [{ address: to }],
      subject: bodies.subject,
      text: bodies.text,
      html: bodies.html,
    });
    if (emailSettings.reply_to) {
      message.headers = { "Reply-To": emailSettings.reply_to };
    }

    try {
      e.app.newMailClient().send(message);
    } catch (err) {
      console.log(`[receipt:send] ${sale.id}: ${err}`);
      throw e.internalServerError(
        "The receipt could not be sent. Check the mail settings in the PocketBase dashboard, then try again.",
        null
      );
    }

    audit(true);
    return e.json(202, { sent_to: sentTo, sent: true, test_mode: false });
  },
  $apis.requireAuth("staff")
);
