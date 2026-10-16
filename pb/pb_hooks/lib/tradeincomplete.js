/**
 * Completing a trade-in (docs/api-contract.md, "Trade-ins";
 * docs/api-contract-epos.md, section 7).
 *
 * Two routes complete a trade-in: the buy-in route,
 * `POST /api/vault/trade-ins/{id}/complete` (tradeins.pb.js), and a sale
 * that takes the trade-in as part-exchange, `POST /api/vault/sales/complete`
 * (sales.pb.js). Both complete it with exactly the same steps, so the steps
 * live here once:
 *
 * - `acceptedLines(app, id)` and `totals(lines)`: the accepted lines in the
 *   buy-in route's own order, and what they come to at offer and at market.
 * - `prepare(app, opts)`: every check that runs before the transaction, in
 *   the buy-in route's order: the terms, the ID check's last four, the cash
 *   gate (the open session, the cash cap, the seller's address, the
 *   customer's flags, a verified unexpired ID or one supplied now, 18 or
 *   over, and a photo behind it), a game on every line that becomes an item,
 *   and the signature. Returns `{ ok: true, prepared }` or
 *   `{ ok: false, status, message }`.
 * - `complete(txApp, prepared, opts)`: the writes, inside the caller's own
 *   transaction and in the buy-in route's order: the number, the ID check,
 *   the photo's retention clock, the items and their labels, each line linked
 *   to its first item, the credit ledger, the cash payout movement, points on
 *   the credit portion, the referral, the trade-in itself with the seller
 *   snapshot and the signature, and the audit row. Returns `{ ok: true, ... }`
 *   or `{ ok: false, status, message }` for the caller to carry out of its
 *   transaction as its `halt` (an ApiError thrown through the Go transaction
 *   boundary does not arrive back in JS as itself).
 *
 * Two things are new with part-exchange and apply to every completion:
 *
 * - **Every completed trade-in is linked to a cash session**, not only one
 *   that paid out cash, so the X and Z count a credit buy-in too. A cash
 *   payout still needs the open session it names; a credit-only buy-in is
 *   linked to the session it names when that one is open, otherwise to the
 *   default register's open session, otherwise to none, and is never refused
 *   for the lack of one.
 * - **Item cost is what was really paid.** When less than the trade's offer
 *   value is paid out (a part-exchange whose cash surplus is below the
 *   surplus, by agreement), what was paid is spread over the accepted lines
 *   in proportion to their `offer_price x qty` with the shared `spread()`,
 *   and each line's share becomes its items' `cost`: one row per unit gets
 *   the share split unit by unit with the shared `cumNet()`, so the units sum
 *   back to the share exactly; a stock line of qty n, which carries one unit
 *   cost, gets the share over n rounded half-up. When everything is paid,
 *   `cost = offer_price` as it always was. The stock book and the margin
 *   report then read what the shop really paid.
 *
 * Transaction-agnostic reads: pass $app, e.app or a txApp. require() this
 * from inside each handler, not at file top level - see pb/README.md on
 * pb_hooks isolation.
 */

/** trade_ins.signature is a 2 MB file field; the pad sends a PNG data URL. */
var MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

/** The buy-in route's own refusal for a trade-in completed in the meantime. */
var ALREADY_COMPLETED = "This trade-in is already completed.";

var SESSION_CLOSED = "That cash session is closed. Open a new one before paying out cash.";

function refusal(status, message) {
  return { ok: false, status: status, message: message };
}

/** customer_private.flags as a plain array of strings. */
function flagsOf(record) {
  if (!record) return [];
  var raw = null;
  try {
    raw = record.get("flags");
  } catch (err) {
    return [];
  }
  if (!raw) return [];
  if (typeof raw === "string") return [raw];
  var out = [];
  for (var i = 0; i < raw.length; i++) out.push(String(raw[i]));
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

/** A trade-in's accepted lines, in the order the buy-in route has always read them. */
function acceptedLines(app, tradeInId) {
  return app.findRecordsByFilter(
    "trade_in_lines",
    "trade_in = {:id} && accepted = true",
    "created",
    0,
    0,
    { id: tradeInId }
  );
}

/** What the accepted lines come to: `offer` (the trade's value) and `market`, both x qty. */
function totals(lines) {
  var offer = 0;
  var market = 0;
  for (var i = 0; i < lines.length; i++) {
    var qty = Math.max(1, lines[i].getInt("qty"));
    offer += lines[i].getInt("offer_price") * qty;
    market += lines[i].getInt("market_price") * qty;
  }
  return { offer: offer, market: market };
}

/** A cash session by id when it is still open, or null. */
function openById(app, id) {
  if (!id) return null;
  try {
    var row = app.findRecordById("cash_sessions", id);
    return row.getString("closed_at") ? null : row;
  } catch (err) {
    return null;
  }
}

/**
 * Every check that runs before the transaction, in the buy-in route's order.
 *
 * opts: {
 *   tradeIn, customer, priv (customer_private or null), lines (accepted),
 *   payoutCash, payoutCredit, termsAccepted, idCheck (the body's id_check),
 *   signature (the pad's data URL, or ""),
 *   session: the open session the caller already holds (the till's), or
 *   sessionId: the buy-in body's `cash_session`, resolved here with the
 *     buy-in route's own refusals when cash is paid out,
 *   now: Date
 * }
 */
function prepare(app, opts) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var base64 = require(__hooks + "/lib/base64.js");
  var registers = require(__hooks + "/lib/registers.js");
  var money = require(__hooks + "/lib/shared/money.js");

  var now = opts.now || new Date();
  var customerId = opts.customer.id;
  var priv = opts.priv || null;
  var lines = opts.lines;
  var payoutCash = opts.payoutCash;
  var payoutCredit = opts.payoutCredit;

  if (!opts.termsAccepted) {
    return refusal(422, "Ask the customer to accept the terms before completing.");
  }

  // -----------------------------------------------------------------
  // ID gate and cash cap (docs/PLAN.md, "Security, GDPR and record keeping")
  // -----------------------------------------------------------------
  var settings = util.settings(app);
  var cashCap = settings ? settings.getInt("cash_cap") : 0;
  var idCheck = opts.idCheck && typeof opts.idCheck === "object" ? opts.idCheck : null;

  var privAddress = priv ? priv.getString("address") : "";
  var checkAddress = idCheck ? util.asStr(idCheck.address) : "";
  var sellerAddress = checkAddress || privAddress;

  var checkIdType = idCheck ? util.asStr(idCheck.id_type) : "";
  var checkIdExpiry = idCheck ? util.asStr(idCheck.id_expiry) : "";
  var checkIdLast4 = idCheck ? util.asStr(idCheck.id_ref_last4) : "";
  var checkDob = idCheck ? util.asStr(idCheck.dob) : "";
  var hasFullIdCheck = !!(checkIdType && checkIdExpiry);

  if (idCheck && idCheck.id_ref_last4 !== undefined && idCheck.id_ref_last4 !== null) {
    if (checkIdLast4.length < 1 || checkIdLast4.length > 4) {
      return refusal(400, "Enter only the last four characters of the ID number.");
    }
  }

  var retentionMonths = settings ? settings.getInt("id_photo_retention_months") || 12 : 12;

  var session = null;
  // The id_documents row that satisfies the ID gate. Its retention clock
  // restarts on every cash buy-in (docs/PLAN.md: twelve months after the
  // last cash buy-in), and its id goes on the trade-in.
  var idDocument = null;
  if (payoutCash > 0) {
    if (opts.session) {
      session = opts.session;
    } else {
      var sessionId = util.asStr(opts.sessionId);
      if (!sessionId) {
        return refusal(422, "Open a cash session before paying out cash.");
      }
      try {
        session = app.findRecordById("cash_sessions", sessionId);
      } catch (err) {
        return refusal(422, "That cash session does not exist. Open a session and try again.");
      }
      if (session.getString("closed_at")) {
        return refusal(422, SESSION_CLOSED);
      }
    }
    // A cap of zero means no cash at all, not "no limit".
    if (cashCap <= 0) {
      return refusal(422, "Cash payouts are switched off in settings.");
    }
    if (payoutCash > cashCap) {
      return refusal(
        422,
        "Cash payouts are capped at " + money.formatGBP(cashCap) + ". Pay the rest as store credit."
      );
    }
    if (!sellerAddress) {
      return refusal(422, "Add the seller's address before paying cash.");
    }

    // Staff-set flags on the customer come before anything the form says.
    var flags = flagsOf(priv);
    if (flags.indexOf("no_cash") >= 0) {
      return refusal(422, "This customer is marked no cash. Pay as store credit.");
    }
    if (flags.indexOf("under_18") >= 0) {
      return refusal(422, "This customer is recorded as under 18, so we cannot buy for cash.");
    }

    var idStatus = priv ? priv.getString("id_status") : "";
    var idExpiry = priv ? priv.getString("id_expiry") : "";
    var alreadyVerified = idStatus === "verified" && !!idExpiry && !util.isPast(idExpiry, now);
    if (!alreadyVerified && !hasFullIdCheck) {
      return refusal(
        422,
        "Take an ID check before paying cash. Photograph the seller's ID on the ID step."
      );
    }
    if (hasFullIdCheck && util.isPast(checkIdExpiry, now)) {
      return refusal(422, "That ID has expired. Ask for one that is still in date.");
    }

    var dob = checkDob || (priv ? priv.getString("dob") : "");
    var age = util.ageAt(dob, now);
    if (age !== null && age < 18) {
      return refusal(422, "We cannot buy for cash from anyone under 18.");
    }

    // Verified ID fields are not enough on their own: there has to be a
    // photo behind them that the retention cron has not purged yet, or one
    // supplied by id, taken for this customer in the same visit.
    var suppliedDocId = idCheck ? util.asStr(idCheck.id_document) : "";
    if (suppliedDocId) {
      try {
        var supplied = app.findRecordById("id_documents", suppliedDocId);
        if (supplied.getString("customer") === customerId && supplied.getString("photo")) {
          idDocument = supplied;
        }
      } catch (err) {
        idDocument = null;
      }
    } else {
      try {
        var found = app.findRecordsByFilter(
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
      return refusal(422, "Take a photo of the customer's ID before paying cash.");
    }
  } else {
    // Nothing leaves the drawer, so nothing is refused for the lack of a
    // session; the trade-in is still linked to the one that is open, so the
    // X and Z count what it paid in credit.
    session =
      opts.session || openById(app, util.asStr(opts.sessionId)) || registers.openSession(app, "");
  }

  // -----------------------------------------------------------------
  // Everything an item row needs, resolved before the transaction so a
  // line that cannot become an item is refused with a clear message.
  // -----------------------------------------------------------------
  var retroGameId = "";
  try {
    retroGameId = app.findFirstRecordByFilter("games", "key = 'retro'").id;
  } catch (err) {
    retroGameId = "";
  }

  var plans = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var cardId = line.getString("card");
    var retroTitleId = line.getString("retro_title");

    var kind = line.getString("kind");
    if (!kind) kind = cardId ? "single" : retroTitleId ? "retro" : "other";

    var card = null;
    if (cardId) {
      try {
        card = app.findRecordById("cards", cardId);
      } catch (err) {
        card = null;
      }
    }
    var retroTitle = null;
    if (retroTitleId) {
      try {
        retroTitle = app.findRecordById("retro_titles", retroTitleId);
      } catch (err) {
        retroTitle = null;
      }
    }

    var gameId = line.getString("game");
    if (!gameId && card) gameId = card.getString("game");
    if (!gameId && kind === "retro") gameId = retroGameId;
    if (!gameId) {
      return refusal(422, "Line " + (i + 1) + " has no game set. Pick a game on the line and try again.");
    }

    var setCode = "";
    if (card) {
      try {
        setCode = app.findRecordById("card_sets", card.getString("set")).getString("code");
      } catch (err) {
        setCode = "";
      }
    }

    var qty = Math.max(1, line.getInt("qty"));
    // A bulk lot arrives as one "other" line of qty 1 with a flat
    // offer_price, so it falls out of the rule below as a single stock
    // row with one label, which is what a lot on a shelf is.
    // Singles, graded cards and retro are one row per unit with one label
    // each; sealed and accessories are one stock line of qty n
    // (docs/PLAN.md, "Quantity model").
    var perUnit = kind === "single" || kind === "graded" || kind === "retro";

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
      cosmeticGrade: line.getString("cosmetic_grade"),
      qty: qty,
      rows: perUnit ? qty : 1,
      rowQty: perUnit ? 1 : qty,
      // offer_price stays the figure actually paid for the payout type
      // chosen, overridden or not, so the payout arithmetic reads it alone.
      // override_cash and override_credit are the record of what the staff
      // member typed, not an input to this.
      cost: line.getInt("offer_price"),
      market: line.getInt("market_price"),
      overridden: !!line.getString("override_reason"),
    });
  }

  // -----------------------------------------------------------------
  // Signature (a data URL from the pad) and the label templates
  // -----------------------------------------------------------------
  var rawSignature = util.asStr(opts.signature);
  var signature = rawSignature ? base64.fromDataUrl(rawSignature) : null;
  if (rawSignature) {
    if (!signature || !isPng(signature.bytes)) {
      return refusal(400, "The signature did not come through as a PNG. Sign again on the pad.");
    }
    if (signature.bytes.length > MAX_SIGNATURE_BYTES) {
      return refusal(400, "The signature is over 2 MB. Sign again on the pad.");
    }
  }

  var templates = {};
  var templateRows = app.findRecordsByFilter("label_templates", "id != ''", "", 0, 0);
  for (var t = 0; t < templateRows.length; t++) {
    if (templateRows[t]) templates[templateRows[t].getString("key")] = templateRows[t].id;
  }

  var sums = totals(lines);

  return {
    ok: true,
    prepared: {
      tradeInId: opts.tradeIn.id,
      customer: opts.customer,
      customerId: customerId,
      priv: priv,
      plans: plans,
      offerTotal: sums.offer,
      marketTotal: sums.market,
      payoutCash: payoutCash,
      payoutCredit: payoutCredit,
      idCheck: idCheck,
      hasFullIdCheck: hasFullIdCheck,
      checkIdType: checkIdType,
      checkIdExpiry: checkIdExpiry,
      checkIdLast4: checkIdLast4,
      checkDob: checkDob,
      checkAddress: checkAddress,
      sellerAddress: sellerAddress,
      retentionMonths: retentionMonths,
      session: session,
      idDocument: idDocument,
      signature: signature,
      templates: templates,
      fallbackTemplate: settings ? settings.getString("label_default_template") : "",
      intakeLocation: settings ? settings.getString("default_intake_location") : "",
      programme: util.programme(app),
      rules: util.loyaltyRules(app),
      now: now,
    },
  };
}

/**
 * Each plan's unit costs when less than the offer value was paid, or null
 * when everything was (every item then costs its line's offer_price).
 * `paid` is spread over the lines pro rata to offer_price x qty, the last
 * line taking the remainder, so the shares sum to `paid` exactly.
 */
function unitCosts(plans, offerTotal, paid) {
  if (paid >= offerTotal) return null;
  var saleline = require(__hooks + "/lib/shared/saleline.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var values = [];
  for (var i = 0; i < plans.length; i++) values.push(plans[i].cost * plans[i].qty);
  var shares = saleline.spread(values, offerTotal - paid);
  var out = [];
  for (var j = 0; j < plans.length; j++) {
    var plan = plans[j];
    var share = shares[j];
    var costs = [];
    if (plan.rowQty === 1) {
      // One row per unit: the share split unit by unit, summing back to it.
      for (var n = 0; n < plan.rows; n++) {
        costs.push(saleline.cumNet(share, plan.rows, n + 1) - saleline.cumNet(share, plan.rows, n));
      }
    } else {
      // One stock line of qty n carries a single unit cost.
      costs.push(money.roundHalfUp(share / plan.rowQty));
    }
    out.push(costs);
  }
  return out;
}

/**
 * The writes, inside the caller's transaction.
 *
 * opts: {
 *   staffId, ip,
 *   payoutType: "cash" | "credit" | "mixed" | "part_exchange",
 *   completedMessage: the 409 for a trade-in completed in the meantime,
 *   partExchange: { value, sale, saleNumber } when a sale takes it, else null,
 *   auditMeta: extra fields for the audit row (optional)
 * }
 * Returns { ok: true, record, number, result, pending } or a refusal.
 */
function complete(txApp, prepared, opts) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var counters = require(__hooks + "/lib/counters.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var balances = require(__hooks + "/lib/balances.js");
  var referralsLib = require(__hooks + "/lib/referrals.js");
  var labelsLib = require(__hooks + "/lib/labels.js");
  var loyalty = require(__hooks + "/lib/shared/loyalty.js");

  var p = prepared;
  var now = p.now;
  var nowIso = now.toISOString();
  var staffId = opts.staffId;
  var payoutCash = p.payoutCash;
  var payoutCredit = p.payoutCredit;
  var partExchange = opts.partExchange || null;
  var applied = partExchange ? partExchange.value : 0;

  var t = txApp.findRecordById("trade_ins", p.tradeInId);
  if (t.getString("status") === "completed") {
    return refusal(409, opts.completedMessage || ALREADY_COMPLETED);
  }
  var session = p.session;
  if (session) {
    var liveSession = txApp.findRecordById("cash_sessions", session.id);
    if (liveSession.getString("closed_at")) {
      if (payoutCash > 0) return refusal(422, SESSION_CLOSED);
      // Credit only: closed since the check, so there is no session to
      // count it on, which is no reason to refuse it.
      session = null;
    }
  }

  var number = counters.nextNumber(txApp, "trade_in");

  // --- the ID check supplied with this completion ---------------------
  if (p.idCheck && p.priv) {
    var livePriv = txApp.findRecordById("customer_private", p.priv.id);
    if (p.hasFullIdCheck) {
      livePriv.set("id_status", "verified");
      livePriv.set("id_type", p.checkIdType);
      livePriv.set("id_expiry", p.checkIdExpiry);
      livePriv.set("id_verified_by", staffId);
      livePriv.set("id_verified_at", nowIso);
    }
    if (p.checkIdLast4) livePriv.set("id_ref_last4", p.checkIdLast4);
    if (p.checkDob) livePriv.set("dob", p.checkDob);
    if (p.checkAddress) livePriv.set("address", p.checkAddress);
    txApp.save(livePriv);
  }

  // --- the ID photo behind a cash payout ------------------------------
  // Its retention clock restarts here, so the photo lives twelve months
  // from the last cash buy-in rather than from the day it was taken
  // (docs/PLAN.md, "Security, GDPR and record keeping").
  if (p.idDocument) {
    var liveDoc = txApp.findRecordById("id_documents", p.idDocument.id);
    liveDoc.set("expires_at", util.addMonths(now, p.retentionMonths).toISOString());
    txApp.save(liveDoc);
  }

  // --- items, one or more per accepted line ---------------------------
  var itemsCollection = txApp.findCollectionByNameOrId("items");
  var labelJobsCollection = txApp.findCollectionByNameOrId("label_jobs");
  var createdItems = [];
  var overriddenLines = [];
  var labelsQueued = 0;
  var costs = unitCosts(p.plans, p.offerTotal, applied + payoutCash + payoutCredit);

  for (var i = 0; i < p.plans.length; i++) {
    var plan = p.plans[i];
    var firstItemId = "";
    // Ids only. The reason stays on the line row: audit_log is permanent
    // and superuser-only, and a reason is free text a staff member typed
    // about a named seller.
    if (plan.overridden) overriddenLines.push(plan.line.id);

    for (var n = 0; n < plan.rows; n++) {
      var item = new Record(itemsCollection, {
        kind: plan.kind,
        game: plan.game,
        qty: plan.rowQty,
        cost: costs ? costs[i][n] : plan.cost,
        market_at_intake: plan.market,
        tax_scheme: "margin",
        status: "in_stock",
        source: "trade_in",
        trade_in_line: plan.line.id,
        acquired_at: nowIso,
        created_by: staffId,
      });
      if (plan.card) item.set("card", plan.card);
      if (plan.retroTitle) item.set("retro_title", plan.retroTitle);
      if (plan.title) item.set("title", plan.title);
      if (plan.setCode) item.set("set_code", plan.setCode);
      if (plan.number) item.set("number", plan.number);
      if (plan.finish) item.set("finish", plan.finish);
      if (plan.condition) item.set("condition", plan.condition);
      if (plan.completeness) item.set("completeness", plan.completeness);
      // Cosmetic grading is a retro thing: a boxed game's wear, not a
      // card's, which carries a condition instead.
      if (plan.kind === "retro" && plan.cosmeticGrade) {
        item.set("cosmetic_grade", plan.cosmeticGrade);
      }
      if (plan.region) item.set("region", plan.region);
      if (p.intakeLocation) item.set("location", p.intakeLocation);
      txApp.save(item);

      if (!firstItemId) firstItemId = item.id;
      createdItems.push({
        id: item.id,
        sku: item.getString("sku"),
        title: item.getString("title"),
      });

      // Which label template a finished item wants: the table lives in
      // lib/labels.js, which the reprint routes use as well, so a buy-in
      // and a reprint of the same item never come out on different sizes.
      var templateId =
        p.templates[labelsLib.templateKeyFor(plan.kind, plan.completeness)] || p.fallbackTemplate;
      if (templateId) {
        txApp.save(
          new Record(labelJobsCollection, {
            item: item.id,
            template: templateId,
            copies: 1,
            status: "queued",
            requested_by: staffId,
          })
        );
        labelsQueued += 1;
      }
    }

    // trade_in_lines.item is a single relation, so a per-unit line points
    // at the first of its units; every unit points back at the line through
    // items.trade_in_line.
    plan.line.set("item", firstItemId);
    txApp.save(plan.line);
  }

  // --- money -----------------------------------------------------------
  if (payoutCredit > 0) {
    txApp.save(
      new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
        customer: p.customerId,
        amount: payoutCredit,
        reason: "trade_in",
        ref: number,
        staff: staffId,
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
        staff: staffId,
      })
    );
  }

  // --- points on the credit portion ------------------------------------
  // Only on store credit paid out: on a part-exchange that is the credit
  // surplus alone, never the part that paid for the sale, which earns its
  // points on the sale (docs/EPOS-PLAN.md, decision 5). Points belong to
  // Guild members, so a seller who has not joined earns none
  // (docs/api-contract-launch.md, section 2).
  // Read inside the transaction: a sale that sells the Guild Membership
  // joins its customer before the part-exchange completes.
  var guildLib = require(`${__hooks}/lib/guild.js`);
  var seller = null;
  try {
    seller = txApp.findRecordById("customers", p.customerId);
  } catch (err) {
    seller = p.customer;
  }
  var pointsEarned = guildLib.isMember(seller)
    ? loyalty.evaluateTradeInPoints(
        p.programme,
        p.rules,
        payoutCredit,
        now,
        guildLib.isPaidMember(txApp, p.customerId)
      )
    : 0;
  if (pointsEarned > 0) {
    txApp.save(
      new Record(txApp.findCollectionByNameOrId("points_ledger"), {
        customer: p.customerId,
        delta: pointsEarned,
        reason: "earn_trade_in",
        ref: number,
        staff: staffId,
      })
    );
  }

  // --- the referral this customer came in on, if any ------------------
  // Phase 6: a pending referral where they are the referee becomes earned
  // on their first completed buy-in or sale, paying both sides, atomic with
  // the completion that earned it (lib/referrals.js). A customer with no
  // pending referral, or one already earned, is a no-op - so a sale and its
  // part-exchange in one transaction pay it once.
  var referralOutcome = { pending: [] };
  if (p.customerId) {
    referralOutcome = referralsLib.onFirstCompletion(txApp, p.customerId, staffId, number);
  }

  // --- the trade-in itself, with the seller snapshot -------------------
  t.set("number", number);
  t.set("status", "completed");
  t.set("completed_at", nowIso);
  t.set("staff", staffId);
  t.set("payout_type", opts.payoutType);
  t.set("payout_cash", payoutCash);
  t.set("payout_credit", payoutCredit);
  t.set("total_market", p.marketTotal);
  t.set("total_offer", p.offerTotal);
  if (!t.getString("channel")) t.set("channel", "counter");
  if (session) t.set("cash_session", session.id);
  if (partExchange) {
    t.set("part_exchange_value", applied);
    t.set("sale", partExchange.sale);
  }

  // Snapshot taken at completion so the six-year register survives a later
  // erasure of the customer (UK GDPR Article 17(3)(b)).
  var priv = p.priv;
  t.set("seller_name", p.customer.getString("name"));
  t.set("seller_address", p.sellerAddress);
  t.set("seller_id_type", p.checkIdType || (priv ? priv.getString("id_type") : ""));
  t.set("seller_id_last4", p.checkIdLast4 || (priv ? priv.getString("id_ref_last4") : ""));
  var snapshotExpiry = p.checkIdExpiry || (priv ? priv.getString("id_expiry") : "");
  if (snapshotExpiry) t.set("seller_id_expiry", snapshotExpiry);
  if (p.hasFullIdCheck || (priv && priv.getString("id_status") === "verified")) {
    t.set("id_checked", true);
    t.set("id_checked_by", staffId);
  }
  if (p.idDocument) t.set("id_document", p.idDocument.id);
  if (p.signature) {
    t.set("signature", $filesystem.fileFromBytes(p.signature.bytes, "signature-" + t.id + ".png"));
  }
  txApp.save(t);

  var fresh = balances.recompute(txApp, p.customerId);

  var meta = {
    number: number,
    items: createdItems.length,
    labels: labelsQueued,
    payout_cash: payoutCash,
    payout_credit: payoutCredit,
    cash_session: session ? session.id : "",
    // The id alone, never a field off the document.
    id_document: p.idDocument ? p.idDocument.id : "",
    // Line ids only; each line keeps its own override_reason.
    overridden_lines: overriddenLines,
  };
  if (partExchange) {
    meta.part_exchange_value = applied;
    meta.sale = partExchange.saleNumber;
    meta.cost_spread = !!costs;
  }
  auditLib.writeAuditLog(txApp, {
    actor: staffId,
    action: "trade_in_complete",
    collection: "trade_ins",
    record: t.id,
    meta: meta,
    ip: opts.ip,
  });

  return {
    ok: true,
    record: t,
    number: number,
    pending: referralOutcome.pending || [],
    result: {
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
    },
  };
}

/**
 * A part-exchange as the sale's response, its replay and its receipt give
 * it (`SaleTradeIn`): everything the trade was worth at credit rates, what
 * it paid towards the sale, and the surplus paid out either way. Read off
 * the completed trade-in, so the first answer and a replay cannot differ.
 */
function saleBlock(record) {
  return {
    id: record.id,
    number: record.getString("number"),
    value: record.getInt("total_offer"),
    applied: record.getInt("part_exchange_value"),
    payout_cash: record.getInt("payout_cash"),
    payout_credit: record.getInt("payout_credit"),
  };
}

module.exports = {
  ALREADY_COMPLETED: ALREADY_COMPLETED,
  acceptedLines: acceptedLines,
  totals: totals,
  prepare: prepare,
  unitCosts: unitCosts,
  complete: complete,
  saleBlock: saleBlock,
};
