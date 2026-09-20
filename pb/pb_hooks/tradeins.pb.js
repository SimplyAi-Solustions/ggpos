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
 * Each registered handler runs in its own isolated goja context, so every
 * require() and every helper lives inside the handler body - see
 * pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/trade-ins/{id}/complete
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/trade-ins/{id}/complete",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const counters = require(`${__hooks}/lib/counters.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const base64 = require(`${__hooks}/lib/base64.js`);
    const loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    // trade_ins.signature is a 2 MB file field; the pad sends a PNG data URL.
    const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

    /** customer_private.flags as a plain array of strings. */
    function flagsOf(record) {
      if (!record) return [];
      let raw = null;
      try {
        raw = record.get("flags");
      } catch (err) {
        return [];
      }
      if (!raw) return [];
      if (typeof raw === "string") return [raw];
      const out = [];
      for (let i = 0; i < raw.length; i++) out.push(String(raw[i]));
      return out;
    }

    /** True when the bytes open with the PNG signature. */
    function isPng(bytes) {
      return (
        !!bytes &&
        bytes.length > 8 &&
        (bytes[0] & 0xff) === 0x89 &&
        (bytes[1] & 0xff) === 0x50 &&
        (bytes[2] & 0xff) === 0x4e &&
        (bytes[3] & 0xff) === 0x47
      );
    }

    /** Which label template a finished item wants. */
    function templateKeyFor(kind, completeness) {
      if (kind === "single" || kind === "graded") return "toploader_40x20";
      if (kind === "retro") return "retro_50x30";
      if (kind === "sealed" || kind === "accessory") {
        return completeness === "boxed" || completeness === "cib"
          ? "retro_50x30"
          : "sleeve_25x15";
      }
      return "toploader_40x20";
    }

    const staff = e.auth;
    const tradeInId = e.request.pathValue("id");
    const body = util.body(e);
    const now = new Date();
    const nowIso = now.toISOString();

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
      throw e.error(409, "This trade-in is already completed.", null);
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

    const lines = e.app.findRecordsByFilter(
      "trade_in_lines",
      "trade_in = {:id} && accepted = true",
      "created",
      0,
      0,
      { id: tradeInId }
    );
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

    let offerTotal = 0;
    let marketTotal = 0;
    for (let i = 0; i < lines.length; i++) {
      const qty = Math.max(1, lines[i].getInt("qty"));
      offerTotal += lines[i].getInt("offer_price") * qty;
      marketTotal += lines[i].getInt("market_price") * qty;
    }
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

    if (!util.asBool(body.terms_accepted)) {
      throw e.error(422, "Ask the customer to accept the terms before completing.", null);
    }

    // -----------------------------------------------------------------
    // ID gate and cash cap (docs/PLAN.md, "Security, GDPR and record keeping")
    // -----------------------------------------------------------------
    const settings = util.settings(e.app);
    const cashCap = settings ? settings.getInt("cash_cap") : 0;
    const idCheck =
      body.id_check && typeof body.id_check === "object" ? body.id_check : null;

    const privAddress = priv ? priv.getString("address") : "";
    const checkAddress = idCheck ? util.asStr(idCheck.address) : "";
    const sellerAddress = checkAddress || privAddress;

    const checkIdType = idCheck ? util.asStr(idCheck.id_type) : "";
    const checkIdExpiry = idCheck ? util.asStr(idCheck.id_expiry) : "";
    const checkIdLast4 = idCheck ? util.asStr(idCheck.id_ref_last4) : "";
    const checkDob = idCheck ? util.asStr(idCheck.dob) : "";
    const hasFullIdCheck = !!(checkIdType && checkIdExpiry);

    if (idCheck && idCheck.id_ref_last4 !== undefined && idCheck.id_ref_last4 !== null) {
      if (checkIdLast4.length < 1 || checkIdLast4.length > 4) {
        throw e.badRequestError("Enter only the last four characters of the ID number.", null);
      }
    }

    const retentionMonths = settings ? settings.getInt("id_photo_retention_months") || 12 : 12;

    let session = null;
    // The id_documents row that satisfies the ID gate. Its retention clock
    // restarts on every cash buy-in (docs/PLAN.md: twelve months after the
    // last cash buy-in), and its id goes on the trade-in.
    let idDocument = null;
    if (payoutCash > 0) {
      const sessionId = util.asStr(body.cash_session);
      if (!sessionId) {
        throw e.error(422, "Open a cash session before paying out cash.", null);
      }
      try {
        session = e.app.findRecordById("cash_sessions", sessionId);
      } catch (err) {
        throw e.error(422, "That cash session does not exist. Open a session and try again.", null);
      }
      if (session.getString("closed_at")) {
        throw e.error(422, "That cash session is closed. Open a new one before paying out cash.", null);
      }
      // A cap of zero means no cash at all, not "no limit".
      if (cashCap <= 0) {
        throw e.error(422, "Cash payouts are switched off in settings.", null);
      }
      if (payoutCash > cashCap) {
        throw e.error(
          422,
          `Cash payouts are capped at ${money.formatGBP(cashCap)}. Pay the rest as store credit.`,
          null
        );
      }
      if (!sellerAddress) {
        throw e.error(422, "Add the seller's address before paying cash.", null);
      }

      // Staff-set flags on the customer come before anything the form says.
      const flags = flagsOf(priv);
      if (flags.indexOf("no_cash") >= 0) {
        throw e.error(422, "This customer is marked no cash. Pay as store credit.", null);
      }
      if (flags.indexOf("under_18") >= 0) {
        throw e.error(
          422,
          "This customer is recorded as under 18, so we cannot buy for cash.",
          null
        );
      }

      const idStatus = priv ? priv.getString("id_status") : "";
      const idExpiry = priv ? priv.getString("id_expiry") : "";
      const alreadyVerified =
        idStatus === "verified" && !!idExpiry && !util.isPast(idExpiry, now);
      if (!alreadyVerified && !hasFullIdCheck) {
        throw e.error(
          422,
          "Take an ID check before paying cash. Photograph the seller's ID on the ID step.",
          null
        );
      }
      if (hasFullIdCheck && util.isPast(checkIdExpiry, now)) {
        throw e.error(422, "That ID has expired. Ask for one that is still in date.", null);
      }

      const dob = checkDob || (priv ? priv.getString("dob") : "");
      const age = util.ageAt(dob, now);
      if (age !== null && age < 18) {
        throw e.error(422, "We cannot buy for cash from anyone under 18.", null);
      }

      // Verified ID fields are not enough on their own: there has to be a
      // photo behind them that the retention cron has not purged yet, or one
      // supplied by id, taken for this customer in the same visit.
      const suppliedDocId = idCheck ? util.asStr(idCheck.id_document) : "";
      if (suppliedDocId) {
        try {
          const supplied = e.app.findRecordById("id_documents", suppliedDocId);
          if (
            supplied.getString("customer") === customerId &&
            supplied.getString("photo")
          ) {
            idDocument = supplied;
          }
        } catch (err) {
          idDocument = null;
        }
      } else {
        try {
          const found = e.app.findRecordsByFilter(
            "id_documents",
            "customer = {:customer} && photo != ''",
            "-created",
            1,
            0,
            { customer: customerId }
          );
          idDocument = found && found.length ? found[0] : null;
        } catch (err) {
          idDocument = null;
        }
      }
      if (!idDocument) {
        throw e.error(422, "Take a photo of the customer's ID before paying cash.", null);
      }
    }

    // -----------------------------------------------------------------
    // Everything an item row needs, resolved before the transaction so a
    // line that cannot become an item is refused with a clear message.
    // -----------------------------------------------------------------
    let retroGameId = "";
    try {
      retroGameId = e.app.findFirstRecordByFilter("games", "key = 'retro'").id;
    } catch (err) {
      retroGameId = "";
    }

    const plans = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cardId = line.getString("card");
      const retroTitleId = line.getString("retro_title");

      let kind = line.getString("kind");
      if (!kind) kind = cardId ? "single" : retroTitleId ? "retro" : "other";

      let card = null;
      if (cardId) {
        try {
          card = e.app.findRecordById("cards", cardId);
        } catch (err) {
          card = null;
        }
      }
      let retroTitle = null;
      if (retroTitleId) {
        try {
          retroTitle = e.app.findRecordById("retro_titles", retroTitleId);
        } catch (err) {
          retroTitle = null;
        }
      }

      let gameId = line.getString("game");
      if (!gameId && card) gameId = card.getString("game");
      if (!gameId && kind === "retro") gameId = retroGameId;
      if (!gameId) {
        throw e.error(
          422,
          `Line ${i + 1} has no game set. Pick a game on the line and try again.`,
          null
        );
      }

      let setCode = "";
      if (card) {
        try {
          setCode = e.app.findRecordById("card_sets", card.getString("set")).getString("code");
        } catch (err) {
          setCode = "";
        }
      }

      const qty = Math.max(1, line.getInt("qty"));
      // Singles, graded cards and retro are one row per unit with one label
      // each; sealed and accessories are one stock line of qty n
      // (docs/PLAN.md, "Quantity model").
      const perUnit = kind === "single" || kind === "graded" || kind === "retro";

      plans.push({
        line: line,
        kind: kind,
        game: gameId,
        card: cardId,
        retroTitle: retroTitleId,
        title: line.getString("free_text_title"),
        setCode: setCode,
        number: card ? card.getString("number") : "",
        region: retroTitle ? retroTitle.getString("region") : "",
        finish: line.getString("finish"),
        condition: line.getString("condition"),
        completeness: line.getString("completeness"),
        qty: qty,
        rows: perUnit ? qty : 1,
        rowQty: perUnit ? 1 : qty,
        cost: line.getInt("offer_price"),
        market: line.getInt("market_price"),
      });
    }

    // -----------------------------------------------------------------
    // Signature (a data URL from the pad) and the label templates
    // -----------------------------------------------------------------
    const rawSignature = util.asStr(body.signature);
    const signature = rawSignature ? base64.fromDataUrl(rawSignature) : null;
    if (rawSignature) {
      if (!signature || !isPng(signature.bytes)) {
        throw e.badRequestError(
          "The signature did not come through as a PNG. Sign again on the pad.",
          null
        );
      }
      if (signature.bytes.length > MAX_SIGNATURE_BYTES) {
        throw e.badRequestError("The signature is over 2 MB. Sign again on the pad.", null);
      }
    }

    const templates = {};
    const templateRows = e.app.findRecordsByFilter("label_templates", "id != ''", "", 0, 0);
    for (let i = 0; i < templateRows.length; i++) {
      if (templateRows[i]) templates[templateRows[i].getString("key")] = templateRows[i].id;
    }
    const fallbackTemplate = settings ? settings.getString("label_default_template") : "";
    const intakeLocation = settings ? settings.getString("default_intake_location") : "";

    const programme = util.programme(e.app);
    const rules = util.loyaltyRules(e.app);

    // -----------------------------------------------------------------
    // Write
    // -----------------------------------------------------------------
    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const t = txApp.findRecordById("trade_ins", tradeInId);
        if (t.getString("status") === "completed") {
          halt = { status: 409, message: "This trade-in is already completed." };
          throw new Error(halt.message);
        }
        if (session) {
          const liveSession = txApp.findRecordById("cash_sessions", session.id);
          if (liveSession.getString("closed_at")) {
            halt = {
              status: 422,
              message: "That cash session is closed. Open a new one before paying out cash.",
            };
            throw new Error(halt.message);
          }
        }

        const number = counters.nextNumber(txApp, "trade_in");

        // --- the ID check supplied with this completion ---------------
        if (idCheck && priv) {
          const livePriv = txApp.findRecordById("customer_private", priv.id);
          if (hasFullIdCheck) {
            livePriv.set("id_status", "verified");
            livePriv.set("id_type", checkIdType);
            livePriv.set("id_expiry", checkIdExpiry);
            livePriv.set("id_verified_by", staff.id);
            livePriv.set("id_verified_at", nowIso);
          }
          if (checkIdLast4) livePriv.set("id_ref_last4", checkIdLast4);
          if (checkDob) livePriv.set("dob", checkDob);
          if (checkAddress) livePriv.set("address", checkAddress);
          txApp.save(livePriv);
        }

        // --- items, one or more per accepted line ---------------------
        const itemsCollection = txApp.findCollectionByNameOrId("items");
        const labelJobsCollection = txApp.findCollectionByNameOrId("label_jobs");
        const createdItems = [];
        let labelsQueued = 0;

        for (let i = 0; i < plans.length; i++) {
          const plan = plans[i];
          let firstItemId = "";

          for (let n = 0; n < plan.rows; n++) {
            const item = new Record(itemsCollection, {
              kind: plan.kind,
              game: plan.game,
              qty: plan.rowQty,
              cost: plan.cost,
              market_at_intake: plan.market,
              tax_scheme: "margin",
              status: "in_stock",
              source: "trade_in",
              trade_in_line: plan.line.id,
              acquired_at: nowIso,
              created_by: staff.id,
            });
            if (plan.card) item.set("card", plan.card);
            if (plan.retroTitle) item.set("retro_title", plan.retroTitle);
            if (plan.title) item.set("title", plan.title);
            if (plan.setCode) item.set("set_code", plan.setCode);
            if (plan.number) item.set("number", plan.number);
            if (plan.finish) item.set("finish", plan.finish);
            if (plan.condition) item.set("condition", plan.condition);
            if (plan.completeness) item.set("completeness", plan.completeness);
            if (plan.region) item.set("region", plan.region);
            if (intakeLocation) item.set("location", intakeLocation);
            txApp.save(item);

            if (!firstItemId) firstItemId = item.id;
            createdItems.push({
              id: item.id,
              sku: item.getString("sku"),
              title: item.getString("title"),
            });

            const templateId =
              templates[templateKeyFor(plan.kind, plan.completeness)] || fallbackTemplate;
            if (templateId) {
              txApp.save(
                new Record(labelJobsCollection, {
                  item: item.id,
                  template: templateId,
                  copies: 1,
                  status: "queued",
                  requested_by: staff.id,
                })
              );
              labelsQueued += 1;
            }
          }

          // trade_in_lines.item is a single relation, so a per-unit line
          // points at the first of its units; every unit points back at
          // the line through items.trade_in_line.
          plan.line.set("item", firstItemId);
          txApp.save(plan.line);
        }

        // --- money -----------------------------------------------------
        if (payoutCredit > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
              customer: customerId,
              amount: payoutCredit,
              reason: "trade_in",
              ref: number,
              staff: staff.id,
            })
          );
        }

        if (payoutCash > 0 && session) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("cash_movements"), {
              session: session.id,
              type: "payout",
              // Signed: money out of the drawer is negative, so a session's
              // expected total is float + sum(amount). See lib/vaultutil.js.
              amount: -payoutCash,
              ref: number,
              staff: staff.id,
            })
          );
        }

        // --- points on the credit portion ------------------------------
        const pointsEarned = loyalty.evaluateTradeInPoints(programme, rules, payoutCredit, now);
        if (pointsEarned > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customerId,
              delta: pointsEarned,
              reason: "earn_trade_in",
              ref: number,
              staff: staff.id,
            })
          );
        }

        // --- the trade-in itself, with the seller snapshot -------------
        t.set("number", number);
        t.set("status", "completed");
        t.set("completed_at", nowIso);
        t.set("staff", staff.id);
        t.set("payout_type", payoutType);
        t.set("payout_cash", payoutCash);
        t.set("payout_credit", payoutCredit);
        t.set("total_market", marketTotal);
        t.set("total_offer", offerTotal);
        if (!t.getString("channel")) t.set("channel", "counter");
        if (session) t.set("cash_session", session.id);

        // Snapshot taken at completion so the six-year register survives a
        // later erasure of the customer (UK GDPR Article 17(3)(b)).
        t.set("seller_name", customer.getString("name"));
        t.set("seller_address", sellerAddress);
        t.set("seller_id_type", checkIdType || (priv ? priv.getString("id_type") : ""));
        t.set("seller_id_last4", checkIdLast4 || (priv ? priv.getString("id_ref_last4") : ""));
        const snapshotExpiry = checkIdExpiry || (priv ? priv.getString("id_expiry") : "");
        if (snapshotExpiry) t.set("seller_id_expiry", snapshotExpiry);
        if (hasFullIdCheck || (priv && priv.getString("id_status") === "verified")) {
          t.set("id_checked", true);
          t.set("id_checked_by", staff.id);
        }
        if (signature) {
          t.set(
            "signature",
            $filesystem.fileFromBytes(signature.bytes, `signature-${t.id}.png`)
          );
        }
        txApp.save(t);

        const fresh = balances.recompute(txApp, customerId);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "trade_in_complete",
          collection: "trade_ins",
          record: t.id,
          meta: {
            number: number,
            items: createdItems.length,
            labels: labelsQueued,
            payout_cash: payoutCash,
            payout_credit: payoutCredit,
            cash_session: session ? session.id : "",
          },
          ip: e.realIP(),
        });

        result = {
          trade_in: {
            id: t.id,
            number: number,
            status: "completed",
            payout_cash: payoutCash,
            payout_credit: payoutCredit,
          },
          items: createdItems,
          labels_queued: labelsQueued,
          points_earned: pointsEarned,
          credit_balance: fresh.credit,
        };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
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

    let tradeIn = null;
    try {
      tradeIn = e.app.findRecordById("trade_ins", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Trade-in not found. Check the link and try again.", null);
    }

    return e.json(200, receipts.build(e.app, tradeIn, util.settings(e.app)));
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
    const receipt = receipts.build(e.app, tradeIn, settings);
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
