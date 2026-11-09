/// <reference path="../pb_data/types.d.ts" />

/**
 * vaultdeal.pb.js - the Vault deal calculator's buy-in routes
 * (docs/vault-rebuild-api.md, "Deals").
 *
 *   GET  /api/vault/deals/{id}            the deal priced on the server
 *   POST /api/vault/deals/{id}/complete   book the cards into stock and record the split
 *
 * A deal is an ordinary `trade_ins` row with `trade_in_lines`, drafted and
 * edited through the collection API, plus the rate and override fields
 * from 1789821460_vault_deal.js. It is priced by the canonical deal maths
 * the Vault app uses (packages/shared/src/deal.ts, through
 * lib/shared/deal.js and lib/vaultdeal.js): computeDeal for the sweep,
 * per-card rates and the per-side final overrides, dealPayout and splitDeal
 * for the cash/credit split, and payoutLines for what each line is
 * recorded at, so the server checks exactly the figures the screen shows.
 *
 * Completion here needs no till: no cash session, no drawer movement, no
 * credit ledger, no Guild points and no referral. It runs the same checks
 * and stock writes as POST /api/vault/trade-ins/{id}/complete through
 * lib/tradeincomplete.js (terms, the cash cap, the seller's address, the
 * no_cash and under_18 flags, a verified unexpired ID with a photo on file
 * for any cash at all, 18 or over, the signature), so the ID-on-file rule
 * is enforced identically. That route is unchanged.
 */

// ---------------------------------------------------------------------
// Server stamps on a deal's final override, and the per-line rate check
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/vaultdeal.js`).stampOverride(e, true);
  e.next();
}, "trade_ins");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/vaultdeal.js`).stampOverride(e, false);
  e.next();
}, "trade_ins");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/vaultdeal.js`).checkLineRates(e);
  e.next();
}, "trade_in_lines");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/vaultdeal.js`).checkLineRates(e);
  e.next();
}, "trade_in_lines");

// ---------------------------------------------------------------------
// GET /api/vault/deals/{id}
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/deals/{id}",
  (e) => {
    const tradeComplete = require(`${__hooks}/lib/tradeincomplete.js`);
    const vaultDeal = require(`${__hooks}/lib/vaultdeal.js`);
    let tradeIn = null;
    try {
      tradeIn = e.app.findRecordById("trade_ins", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Deal not found. Check the link and try again.", null);
    }
    const lines = tradeComplete.acceptedLines(e.app, tradeIn.id);
    return e.json(200, { deal: vaultDeal.shape(tradeIn, lines, vaultDeal.computeFor(tradeIn, lines)) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/deals/{id}/complete
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/deals/{id}/complete",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const tradeComplete = require(`${__hooks}/lib/tradeincomplete.js`);
    const vaultDeal = require(`${__hooks}/lib/vaultdeal.js`);
    const deal = require(`${__hooks}/lib/shared/deal.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const staff = e.auth;
    const body = util.body(e);
    const now = new Date();

    let tradeIn = null;
    try {
      tradeIn = e.app.findRecordById("trade_ins", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Deal not found. Check the link and try again.", null);
    }
    const status = tradeIn.getString("status");
    if (status === "completed") throw e.error(409, tradeComplete.ALREADY_COMPLETED, null);
    if (status !== "draft" && status !== "offered" && status !== "accepted") {
      throw e.error(409, `This deal is ${status} and cannot be completed.`, null);
    }

    const customerId = tradeIn.getString("customer");
    if (!customerId) throw e.error(422, "Add a customer to this deal before completing it.", null);
    let customer = null;
    try {
      customer = e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.error(422, "The customer on this deal no longer exists.", null);
    }
    let priv = null;
    try {
      priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
        customer: customerId,
      });
    } catch (err) {
      priv = null;
    }

    const lines = tradeComplete.acceptedLines(e.app, tradeIn.id);
    if (!lines || lines.length === 0) {
      throw e.error(422, "Accept at least one line before completing this deal.", null);
    }

    // --- the split, checked against the deal priced here --------------
    const computed = vaultDeal.computeFor(tradeIn, lines);
    const d = computed.deal;
    const cashTaken = Number(body.cash_taken);
    const creditGiven = Number(body.credit_given);
    if (!Number.isInteger(cashTaken) || !Number.isInteger(creditGiven) || cashTaken < 0 || creditGiven < 0) {
      throw e.badRequestError("Send cash_taken and credit_given as whole pence, zero or more.", null);
    }
    if (cashTaken > d.cash) {
      throw e.badRequestError(
        `The cash taken is more than the cash offer of ${money.formatGBP(d.cash)}. Check the split.`,
        null
      );
    }
    // dealPayout normalises the type (no cash is credit, all the cash is
    // cash) and payoutLines may give up a penny of credit it cannot place
    // on the lines; the credit has to be exactly what that leaves.
    const recorded = deal.payoutLines(d, computed.qtys, deal.dealPayout("mixed", d, cashTaken));
    const payout = recorded.payout;
    if (creditGiven !== payout.credit) {
      throw e.badRequestError(
        `The credit does not match the cash taken. The deal is ${money.formatGBP(d.cash)} cash or ${money.formatGBP(d.trade)} credit; ${money.formatGBP(cashTaken)} cash leaves ${money.formatGBP(payout.credit)} credit.`,
        null
      );
    }
    const payoutType = payout.type;

    // --- every check the counter route makes, without a cash session --
    const ready = tradeComplete.prepare(e.app, {
      tradeIn: tradeIn,
      customer: customer,
      priv: priv,
      lines: lines,
      payoutCash: payout.cash,
      payoutCredit: payout.credit,
      termsAccepted: util.asBool(body.terms_accepted),
      idCheck: body.id_check,
      signature: body.signature,
      noSession: true,
      now: now,
    });
    if (!ready.ok) throw e.error(ready.status, ready.message, null);

    // --- costs, line records and the deal snapshot --------------------
    // Every item costs its line's recorded per-unit figure, so the items
    // add up to cash plus credit exactly (payoutLines).
    const p = ready.prepared;
    p.unitCosts = p.plans.map((plan, i) => {
      const unit = recorded.perUnit[i];
      const costs = [];
      if (plan.rowQty === 1) for (let n = 0; n < plan.rows; n++) costs.push(unit);
      else costs.push(unit);
      return costs;
    });
    p.offerTotal = payout.cash + payout.credit;
    p.marketTotal = d.market;
    const rateLines = [];
    for (let i = 0; i < p.plans.length; i++) {
      const v = d.lines[i];
      const line = p.plans[i].line;
      // offer_price keeps its meaning: what was paid for one unit.
      line.set("offer_price", recorded.perUnit[i]);
      line.set("offer_pct", deal.effectivePct(recorded.perUnit[i] * computed.qtys[i], v.market));
      if (v.tradeCustom || v.cashCustom || v.fixed) rateLines.push(line.id);
    }

    const extraFields = {
      trade_pct: computed.rates.tradePct,
      cash_pct: computed.rates.cashPct,
      calculated_trade: d.calculatedTrade,
      calculated_cash: d.calculatedCash,
      deal_trade_total: d.trade,
      deal_cash_total: d.cash,
    };

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = tradeComplete.complete(txApp, p, {
          staffId: staff.id,
          ip: e.realIP(),
          payoutType: payoutType,
          noLedgers: true,
          auditAction: "vault_deal_complete",
          extraFields: extraFields,
          auditMeta: {
            deal_trade_total: d.trade,
            deal_cash_total: d.cash,
            trade_overridden: d.tradeOverridden,
            cash_overridden: d.cashOverridden,
            custom_lines: rateLines,
          },
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

    const result = done.result;
    return e.json(200, {
      trade_in: {
        id: result.trade_in.id,
        number: result.trade_in.number,
        status: "completed",
        payout_type: payoutType,
        cash_taken: payout.cash,
        credit_given: payout.credit,
        deal_trade_total: d.trade,
        deal_cash_total: d.cash,
      },
      items: result.items,
      labels_queued: result.labels_queued,
    });
  },
  $apis.requireAuth("staff")
);
