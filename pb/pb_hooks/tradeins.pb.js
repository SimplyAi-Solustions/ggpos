/// <reference path="../pb_data/types.d.ts" />

/**
 * tradeins.pb.js - buy-in completion and receipts.
 *
 *   POST /api/vault/trade-ins/{id}/complete
 *   GET  /api/vault/trade-ins/{id}/receipt
 *   POST /api/vault/trade-ins/{id}/receipt/email
 *
 * See docs/api-contract.md ("Trade-ins", "Receipts") for the shapes and
 * docs/PLAN.md ("Core flows and rules > Trade-in completion") for the rules.
 *
 * Completion validates first and writes second: every staff-facing refusal
 * is raised before $app.runInTransaction opens, so the transaction only
 * ever contains writes plus the two re-checks that must be atomic (the
 * trade-in is still open, the cash session is still open). A refusal found
 * inside the transaction records itself in `halt`, throws to roll back, and
 * is turned into the right status code after the catch, because an ApiError
 * thrown through the Go transaction boundary does not arrive back in JS as
 * itself.
 *
 * The checks and the writes themselves are lib/tradeincomplete.js, shared
 * with a sale that takes a trade-in as part-exchange
 * (docs/api-contract-epos.md, section 7). Since then every completed
 * trade-in is linked to the open cash session, credit-only ones included,
 * so the X and Z count them; only a cash payout still needs `cash_session`.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and every helper lives inside the handler body - see
 * pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/trade-ins/{id}/complete
//
// The checks and the writes live in lib/tradeincomplete.js, which a sale
// taking a part-exchange shares (docs/api-contract-epos.md, section 7);
// this route keeps its own loading, its payout arithmetic and every
// refusal it has always given, in the same order.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/trade-ins/{id}/complete",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const tradeComplete = require(`${__hooks}/lib/tradeincomplete.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const staff = e.auth;
    const tradeInId = e.request.pathValue("id");
    const body = util.body(e);
    const now = new Date();

    // -----------------------------------------------------------------
    // Load
    // -----------------------------------------------------------------
    let tradeIn = null;
    try {
      tradeIn = e.app.findRecordById("trade_ins", tradeInId);
    } catch (err) {
      throw e.notFoundError("Trade-in not found. Check the link and try again.", null);
    }

    const status = tradeIn.getString("status");
    if (status === "completed") {
      throw e.error(409, tradeComplete.ALREADY_COMPLETED, null);
    }
    if (status !== "draft" && status !== "offered" && status !== "accepted") {
      throw e.error(409, `This trade-in is ${status} and cannot be completed.`, null);
    }

    const customerId = tradeIn.getString("customer");
    if (!customerId) {
      throw e.error(422, "Add a customer to this trade-in before completing it.", null);
    }
    let customer = null;
    try {
      customer = e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.error(422, "The customer on this trade-in no longer exists.", null);
    }
    let priv = null;
    try {
      priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
        customer: customerId,
      });
    } catch (err) {
      priv = null;
    }

    const lines = tradeComplete.acceptedLines(e.app, tradeInId);
    if (!lines || lines.length === 0) {
      throw e.error(422, "Accept at least one line before completing this trade-in.", null);
    }

    // -----------------------------------------------------------------
    // Payout arithmetic
    // -----------------------------------------------------------------
    const payoutCash = util.asInt(body.payout_cash, 0);
    const payoutCredit = util.asInt(body.payout_credit, 0);
    if (payoutCash < 0 || payoutCredit < 0) {
      throw e.badRequestError("A payout cannot be negative. Check the split.", null);
    }

    const offerTotal = tradeComplete.totals(lines).offer;
    if (payoutCash + payoutCredit !== offerTotal) {
      throw e.badRequestError(
        `The payout adds up to ${money.formatGBP(payoutCash + payoutCredit)} but the accepted lines come to ${money.formatGBP(offerTotal)}. Adjust the split and try again.`,
        null
      );
    }

    let payoutType = util.asStr(body.payout_type);
    if (payoutType !== "cash" && payoutType !== "credit" && payoutType !== "mixed") {
      payoutType = payoutCash > 0 && payoutCredit > 0 ? "mixed" : payoutCash > 0 ? "cash" : "credit";
    }

    // -----------------------------------------------------------------
    // The terms, the ID gate and cash cap, the item plans and the
    // signature (lib/tradeincomplete.js)
    // -----------------------------------------------------------------
    const ready = tradeComplete.prepare(e.app, {
      tradeIn: tradeIn,
      customer: customer,
      priv: priv,
      lines: lines,
      payoutCash: payoutCash,
      payoutCredit: payoutCredit,
      termsAccepted: util.asBool(body.terms_accepted),
      idCheck: body.id_check,
      signature: body.signature,
      sessionId: body.cash_session,
      now: now,
    });
    if (!ready.ok) throw e.error(ready.status, ready.message, null);

    // -----------------------------------------------------------------
    // Write
    // -----------------------------------------------------------------
    let halt = null;
    let done = null;

    try {
      e.app.runInTransaction((txApp) => {
        done = tradeComplete.complete(txApp, ready.prepared, {
          staffId: staff.id,
          ip: e.realIP(),
          payoutType: payoutType,
        });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    // After the transaction has committed, never inside it (lib/notify.js).
    notifyLib.sendPending(e.app, done.pending);

    return e.json(200, done.result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/trade-ins/{id}/receipt
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/trade-ins/{id}/receipt",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const receipts = require(`${__hooks}/lib/receipts.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    let tradeIn = null;
    try {
      tradeIn = e.app.findRecordById("trade_ins", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Trade-in not found. Check the link and try again.", null);
    }

    // trade_ins.signature is a protected file, so the URL in the payload
    // carries a file token minted for the staff member who asked for it.
    // It has to come from the auth record: newFileToken() on an ordinary
    // record throws "not an auth collection record".
    let fileToken = "";
    try {
      fileToken = e.auth.newFileToken();
    } catch (err) {
      fileToken = "";
    }

    const receipt = receipts.build(e.app, tradeIn, util.settings(e.app), fileToken);

    auditLib.writeAuditLog(e.app, {
      actor: e.auth.id,
      action: "trade_in_receipt_view",
      collection: "trade_ins",
      record: tradeIn.id,
      meta: { number: receipt.trade_in.number },
      ip: e.realIP(),
    });

    return e.json(200, receipt);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/trade-ins/{id}/receipt/email
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/trade-ins/{id}/receipt/email",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const receipts = require(`${__hooks}/lib/receipts.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    let tradeIn = null;
    try {
      tradeIn = e.app.findRecordById("trade_ins", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Trade-in not found. Check the link and try again.", null);
    }

    let customer = null;
    try {
      customer = e.app.findRecordById("customers", tradeIn.getString("customer"));
    } catch (err) {
      customer = null;
    }
    const to = customer ? customer.getString("email") : "";
    if (!to) {
      throw e.error(422, "This customer has no email on file.", null);
    }

    const settings = util.settings(e.app);
    const emailSettings = util.emailSettings(e.app, settings);
    // No file token: the email body carries no signature link, and a token
    // in an email would outlive the request that made it.
    const receipt = receipts.build(e.app, tradeIn, settings, "");
    const bodies = receipts.render(receipt);

    const shopName = receipt.shop.name || "GG Entertainment";
    const subject = `${shopName} buy-in receipt ${receipt.trade_in.number || ""}`.trim();

    // Test mode is on until a real from address and SMTP host are set, so
    // a fresh install cannot email a customer by accident.
    if (emailSettings.test_mode) {
      console.log(
        `[receipt:test_mode] would email ${receipt.trade_in.number || tradeIn.id} to a customer on file (not sent)`
      );
      auditLib.writeAuditLog(e.app, {
        actor: e.auth.id,
        action: "trade_in_receipt_email",
        collection: "trade_ins",
        record: tradeIn.id,
        meta: { number: receipt.trade_in.number, sent: false, test_mode: true },
        ip: e.realIP(),
      });
      return e.json(200, { sent: false, test_mode: true });
    }

    const appSettings = e.app.settings();
    const fromAddress =
      emailSettings.from_address || (appSettings.meta ? appSettings.meta.senderAddress : "");
    const fromName =
      emailSettings.from_name || (appSettings.meta ? appSettings.meta.senderName : shopName);
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
      subject: subject,
      text: bodies.text,
      html: bodies.html,
    });
    if (emailSettings.reply_to) {
      message.headers = { "Reply-To": emailSettings.reply_to };
    }

    // PocketBase's own SMTP settings (Dashboard > Settings > Mail) carry
    // the transport; settings.email only holds the addressing. There is no
    // generic $mails.send binding in v0.40.4 - see pb/README.md.
    try {
      e.app.newMailClient().send(message);
    } catch (err) {
      // Without this the transport's own error surfaces as a bare
      // "Something went wrong while processing your request."
      console.log(`[receipt:send] ${tradeIn.id}: ${err}`);
      throw e.internalServerError(
        "The receipt could not be sent. Check the mail settings in the PocketBase dashboard, then try again.",
        null
      );
    }

    auditLib.writeAuditLog(e.app, {
      actor: e.auth.id,
      action: "trade_in_receipt_email",
      collection: "trade_ins",
      record: tradeIn.id,
      meta: { number: receipt.trade_in.number, sent: true },
      ip: e.realIP(),
    });

    return e.json(200, { sent: true });
  },
  $apis.requireAuth("staff")
);
