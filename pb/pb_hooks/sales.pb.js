/// <reference path="../pb_data/types.d.ts" />

/**
 * sales.pb.js - sale completion and refunds.
 *
 *   POST /api/vault/sales/complete
 *   POST /api/vault/sales/{id}/refund   (step-up)
 *
 * docs/api-contract.md ("Sales") for the shapes, docs/PLAN.md ("Core flows
 * and rules > Sale completion") for the rules. Same shape as the trade-in
 * route: validate first, then one $app.runInTransaction with every write
 * through txApp, with a `halt` object carrying any in-transaction refusal
 * back out past the Go boundary.
 *
 * A refund never rewrites what was sold. `sale_lines.qty` and `.discount`
 * are the as-sold figures for good; a refund moves
 * `sale_lines.refunded_qty` and `sales.refunded_total` only, and prices
 * itself from the immutable numbers through lib/shared/saleline.js, so any
 * sequence of partial refunds adds back up to exactly what was taken.
 *
 * `sales.complete` also accepts an optional `client_id` (the offline
 * queue's idempotency key, docs/api-contract.md's "Sales" section): a
 * replayed request carrying one that already exists returns that sale's
 * own body again rather than creating a second sale.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/sales/complete
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Defaults for a sale created without them. `channel` is "counter" unless
// the eBay orders import (imports.pb.js) has already said "ebay", and
// `occurred_at` is now unless that import carries the order's own date.
// Both fields arrived in Phase 4 (migrations 1789820280 and 1789820340),
// after the completion route below was written, and a record hook is the
// one place every create path passes through, the import's included.
// ---------------------------------------------------------------------
onRecordCreate((e) => {
  if (!e.record.getString("channel")) {
    e.record.set("channel", "counter");
  }
  if (!e.record.getString("occurred_at")) {
    e.record.set("occurred_at", new Date().toISOString());
  }
  e.next();
}, "sales");

routerAdd(
  "POST",
  "/api/vault/sales/complete",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const counters = require(`${__hooks}/lib/counters.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const saleline = require(`${__hooks}/lib/shared/saleline.js`);
    const loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const METHODS = ["sumup_card", "cash", "store_credit", "points"];

    const staff = e.auth;
    const body = util.body(e);
    const now = new Date();

    // -----------------------------------------------------------------
    // Idempotency (docs/api-contract.md, "Sales"): the offline queue's
    // client_id. A replayed request with one already on a sale skips every
    // check below and returns that sale's own body, rebuilt from the
    // stored row plus the customer's *current* balances, rather than
    // selling the same items twice. Checked before anything else is even
    // read, so a duplicate never re-runs (and re-fails) the stock checks
    // against items the first completion already sold.
    // -----------------------------------------------------------------
    const clientId = util.asStr(body.client_id);
    if (clientId.length > 64) {
      throw e.badRequestError("client_id is too long. Keep it to 64 characters or fewer.", null);
    }
    if (clientId) {
      let existingSale = null;
      try {
        existingSale = e.app.findFirstRecordByFilter("sales", "client_id = {:clientId}", {
          clientId: clientId,
        });
      } catch (err) {
        existingSale = null;
      }
      if (existingSale) {
        const existingCustomerId = existingSale.getString("customer");
        const fresh = existingCustomerId
          ? balances.recompute(e.app, existingCustomerId)
          : { credit: 0, points: 0 };
        const existingSplit = util.jsonField(existingSale, "payment_split", {}) || {};
        return e.json(200, {
          sale: {
            id: existingSale.id,
            number: existingSale.getString("number"),
            total: existingSale.getInt("total"),
            status: existingSale.getString("status"),
          },
          sumup_amount: util.asInt(existingSplit.sumup_card, 0),
          points_earned: existingSale.getInt("points_earned"),
          credit_balance: fresh.credit,
          points_balance: fresh.points,
        });
      }
    }

    // -----------------------------------------------------------------
    // Lines and stock
    // -----------------------------------------------------------------
    const rawLines = body.lines && body.lines.length ? body.lines : [];
    if (rawLines.length === 0) {
      throw e.badRequestError("Add at least one item to the sale.", null);
    }

    const customerId = util.asStr(body.customer);
    let customer = null;
    let priv = null;
    if (customerId) {
      try {
        customer = e.app.findRecordById("customers", customerId);
      } catch (err) {
        throw e.badRequestError("That customer no longer exists. Search again.", null);
      }
      try {
        priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
          customer: customerId,
        });
      } catch (err) {
        priv = null;
      }
    }

    const planned = [];
    let subtotal = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      const itemId = util.asStr(raw.item);
      let item = null;
      try {
        item = e.app.findRecordById("items", itemId);
      } catch (err) {
        throw e.notFoundError(`Item ${i + 1} is not in stock any more. Scan it again.`, null);
      }

      const status = item.getString("status");
      const reservedForThisCustomer =
        status === "reserved" && customerId && item.getString("reserved_for") === customerId;
      if (status !== "in_stock" && !reservedForThisCustomer) {
        throw e.error(
          409,
          `${item.getString("sku")} is ${status.replace("_", " ")} and cannot be sold. Remove it from the sale.`,
          null
        );
      }

      const qty = Math.max(1, util.asInt(raw.qty, 1));
      const stock = Math.max(0, item.getInt("qty"));
      if (qty > stock) {
        throw e.error(
          409,
          `Only ${stock} of ${item.getString("sku")} left in stock. Lower the quantity.`,
          null
        );
      }

      const unitPrice = util.asInt(raw.unit_price, item.getInt("price"));
      const lineDiscount = util.asInt(raw.discount, 0);
      if (unitPrice < 0 || lineDiscount < 0) {
        throw e.badRequestError("A price or discount cannot be negative. Check the line.", null);
      }
      const lineTotal = unitPrice * qty - lineDiscount;
      if (lineTotal < 0) {
        throw e.badRequestError(
          `The discount on ${item.getString("sku")} is more than the line is worth.`,
          null
        );
      }
      subtotal += lineTotal;

      planned.push({
        item: item,
        qty: qty,
        unitPrice: unitPrice,
        discount: lineDiscount,
        lineTotal: lineTotal,
        overrideFrom: unitPrice !== item.getInt("price") ? item.getInt("price") : null,
      });
    }

    const saleDiscount = util.asInt(body.discount, 0);
    if (saleDiscount < 0 || saleDiscount > subtotal) {
      throw e.badRequestError(
        `The discount has to be between ${money.formatGBP(0)} and ${money.formatGBP(subtotal)}.`,
        null
      );
    }
    const total = subtotal - saleDiscount;

    // -----------------------------------------------------------------
    // Payment split
    // -----------------------------------------------------------------
    const payment = util.asStr(body.payment) || "sumup_card";
    if (payment !== "mixed" && METHODS.indexOf(payment) < 0) {
      throw e.badRequestError("Pick a payment method for this sale.", null);
    }

    const rawSplit = body.payment_split && typeof body.payment_split === "object" ? body.payment_split : null;
    const split = { sumup_card: 0, cash: 0, store_credit: 0, points: 0 };
    if (rawSplit) {
      for (let i = 0; i < METHODS.length; i++) {
        split[METHODS[i]] = util.asInt(rawSplit[METHODS[i]], 0);
      }
    } else if (payment !== "mixed") {
      // "for a single payment method the split may be omitted"
      split[payment] = total;
    }

    let splitTotal = 0;
    for (let i = 0; i < METHODS.length; i++) {
      if (split[METHODS[i]] < 0) {
        throw e.badRequestError("A payment amount cannot be negative. Check the split.", null);
      }
      splitTotal += split[METHODS[i]];
    }
    if (splitTotal !== total) {
      throw e.badRequestError(
        `The payment adds up to ${money.formatGBP(splitTotal)} but the sale comes to ${money.formatGBP(total)}. Adjust the split.`,
        null
      );
    }

    // -----------------------------------------------------------------
    // Cash, credit, points and the reward code
    // -----------------------------------------------------------------
    const settings = util.settings(e.app);
    const cashCap = settings ? settings.getInt("cash_cap") : 0;
    const vatRegistered = settings ? settings.getBool("vat_registered") : false;

    let session = null;
    if (split.cash > 0) {
      const sessionId = util.asStr(body.cash_session);
      if (!sessionId) {
        throw e.error(422, "Open a cash session before taking cash.", null);
      }
      try {
        session = e.app.findRecordById("cash_sessions", sessionId);
      } catch (err) {
        throw e.error(422, "That cash session does not exist. Open a session and try again.", null);
      }
      if (session.getString("closed_at")) {
        throw e.error(422, "That cash session is closed. Open a new one before taking cash.", null);
      }
      // A cap of zero means no cash at all, not "no limit".
      if (cashCap <= 0) {
        throw e.error(422, "Cash sales are switched off in settings.", null);
      }
      if (split.cash > cashCap) {
        throw e.error(
          422,
          `Cash is capped at ${money.formatGBP(cashCap)} a sale. Take the rest by card.`,
          null
        );
      }
    }

    if ((split.store_credit > 0 || split.points > 0) && !customerId) {
      throw e.error(422, "Add the customer before using store credit or points.", null);
    }

    const programme = util.programme(e.app);
    const rules = util.loyaltyRules(e.app);
    const creditBalance = customerId ? balances.creditBalance(e.app, customerId) : 0;
    const pointsBalance = customerId ? balances.pointsBalance(e.app, customerId) : 0;

    /** The one wording for "this customer cannot cover that much store credit". */
    function creditRefusal(balance) {
      return `This customer has ${money.formatGBP(balance)} in store credit. Lower the amount.`;
    }

    /** The one wording for every checkPointsRedemption refusal. */
    function pointsRefusal(check, balance) {
      if (check.reason === "disabled") {
        return "The GG Guild is switched off, so points cannot be used.";
      }
      if (check.reason === "below_minimum") {
        return `Points start at ${programme.minRedeemPoints} points. Take this one another way.`;
      }
      if (check.reason === "insufficient") {
        return `This customer has ${balance} points. Lower the amount.`;
      }
      if (check.reason === "over_share") {
        return `Points can cover at most ${money.formatGBP(loyalty.pointsToPence(check.maxPointsForSale, programme))} of this sale.`;
      }
      return "Those points cannot be used on this sale.";
    }

    if (split.store_credit > creditBalance) {
      throw e.error(422, creditRefusal(creditBalance), null);
    }

    let pointsSpent = 0;
    if (split.points > 0) {
      pointsSpent = loyalty.penceToPoints(split.points, programme);
      const check = loyalty.checkPointsRedemption(programme, pointsBalance, pointsSpent, total);
      if (!check.ok) {
        throw e.error(422, pointsRefusal(check, pointsBalance), null);
      }
    }

    const discountSource = util.asStr(body.discount_source);
    const rewardCode = util.asStr(body.reward_code);
    let redemption = null;
    let reward = null;
    if (rewardCode) {
      // A voucher belongs to one customer, so it cannot be spent on a sale
      // that has nobody on it.
      if (!customerId) {
        throw e.error(422, "Add the customer to the sale before using their reward.", null);
      }
      try {
        redemption = e.app.findFirstRecordByFilter(
          "reward_redemptions",
          "code = {:code}",
          { code: rewardCode }
        );
      } catch (err) {
        throw e.error(422, "That reward code was not found. Check the voucher.", null);
      }
      if (redemption.getString("customer") !== customerId) {
        throw e.error(422, "That reward belongs to a different customer.", null);
      }
      if (redemption.getString("status") !== "issued") {
        throw e.error(422, "That reward has already been used.", null);
      }
      if (util.isPast(redemption.getString("expires_at"), now)) {
        throw e.error(422, "That reward has expired.", null);
      }
      if (discountSource !== "reward") {
        throw e.error(
          422,
          "A reward code needs the discount marked as coming from the reward. Change the discount source and try again.",
          null
        );
      }
      try {
        reward = e.app.findRecordById("loyalty_rewards", redemption.getString("reward"));
      } catch (err) {
        throw e.error(
          422,
          "That reward is no longer in the rewards list. Discount this sale another way.",
          null
        );
      }
      if (reward.getString("type") !== "money_off") {
        throw e.error(
          422,
          "This reward is not money off, so it cannot be used on a sale yet.",
          null
        );
      }
      const rewardValue = reward.getInt("value");
      if (saleDiscount !== rewardValue) {
        throw e.error(
          422,
          `The discount of ${money.formatGBP(saleDiscount)} does not match this reward, which is ${money.formatGBP(rewardValue)} off. Change the discount.`,
          null
        );
      }
    }

    // -----------------------------------------------------------------
    // Points earned (never on the part paid with points)
    //
    // The sale-level discount comes off the lines pro rata first, so the
    // gross the evaluator sees is the amount actually charged rather than
    // the pre-discount subtotal.
    // -----------------------------------------------------------------
    const grosses = [];
    for (let i = 0; i < planned.length; i++) grosses.push(planned[i].lineTotal);
    const earnNets = saleline.spread(grosses, saleDiscount);

    const earnLines = [];
    for (let i = 0; i < planned.length; i++) {
      earnLines.push({
        game: planned[i].item.getString("game") || null,
        kind: planned[i].item.getString("kind"),
        total: earnNets[i],
      });
    }

    let isFirstPurchase = false;
    if (customerId) {
      try {
        const previous = e.app.findRecordsByFilter(
          "sales",
          "customer = {:customer}",
          "",
          1,
          0,
          { customer: customerId }
        );
        isFirstPurchase = !previous || previous.length === 0;
      } catch (err) {
        isFirstPurchase = false;
      }
    }
    const isBirthdayMonth =
      !!customer && customer.getInt("birthday_month") === now.getUTCMonth() + 1;

    const earn = loyalty.evaluateSalePoints(programme, rules, {
      lines: earnLines,
      at: now,
      isFirstPurchase: isFirstPurchase,
      isBirthdayMonth: isBirthdayMonth,
      tier: priv ? util.tier(e.app, priv.getString("tier")) : null,
      paidWithPoints: split.points,
    });
    // Points belong to a customer. A walk-in sale earns none.
    const pointsEarned = customerId ? earn.total : 0;

    // -----------------------------------------------------------------
    // Write
    // -----------------------------------------------------------------
    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        // Balances are read before the transaction for the staff-facing
        // refusals; re-read them here so two tills spending the same credit
        // or the same points cannot both succeed.
        if (customerId && (split.store_credit > 0 || split.points > 0)) {
          if (split.store_credit > 0) {
            const liveCredit = balances.creditBalance(txApp, customerId);
            if (split.store_credit > liveCredit) {
              halt = { status: 422, message: creditRefusal(liveCredit) };
              throw new Error(halt.message);
            }
          }
          if (split.points > 0) {
            const livePoints = balances.pointsBalance(txApp, customerId);
            const liveCheck = loyalty.checkPointsRedemption(
              programme,
              livePoints,
              pointsSpent,
              total
            );
            if (!liveCheck.ok) {
              halt = { status: 422, message: pointsRefusal(liveCheck, livePoints) };
              throw new Error(halt.message);
            }
          }
        }

        for (let i = 0; i < planned.length; i++) {
          const live = txApp.findRecordById("items", planned[i].item.id);
          const status = live.getString("status");
          const reservedForThisCustomer =
            status === "reserved" && customerId && live.getString("reserved_for") === customerId;
          if ((status !== "in_stock" && !reservedForThisCustomer) || live.getInt("qty") < planned[i].qty) {
            halt = {
              status: 409,
              message: `${live.getString("sku")} was sold while this sale was open. Remove it and try again.`,
            };
            throw new Error(halt.message);
          }
        }

        const number = counters.nextNumber(txApp, "sale");

        const sale = new Record(txApp.findCollectionByNameOrId("sales"), {
          number: number,
          staff: staff.id,
          subtotal: subtotal,
          discount: saleDiscount,
          total: total,
          payment: payment,
          payment_split: split,
          sumup_ref: util.asStr(body.sumup_ref),
          points_earned: pointsEarned,
          refunded_total: 0,
          status: "complete",
        });
        if (customerId) sale.set("customer", customerId);
        if (session) sale.set("cash_session", session.id);
        if (discountSource) sale.set("discount_source", discountSource);
        if (clientId) sale.set("client_id", clientId);
        txApp.save(sale);

        const saleLines = txApp.findCollectionByNameOrId("sale_lines");
        for (let i = 0; i < planned.length; i++) {
          const plan = planned[i];
          const live = txApp.findRecordById("items", plan.item.id);
          const taxScheme = live.getString("tax_scheme") || "margin";

          txApp.save(
            new Record(saleLines, {
              sale: sale.id,
              item: live.id,
              qty: plan.qty,
              unit_price: plan.unitPrice,
              discount: plan.discount,
              refunded_qty: 0,
              // Margin scheme lines carry no line VAT (the VAT sits on the
              // margin and is worked out in the stock book); a standard
              // line only carries VAT once the shop is registered.
              vat_rate: vatRegistered && taxScheme === "standard" ? 20 : 0,
              tax_scheme: taxScheme,
              status: "sold",
            })
          );

          const remaining = live.getInt("qty") - plan.qty;
          live.set("qty", remaining);
          if (remaining <= 0) {
            live.set("status", "sold");
            live.set("reserved_for", "");
            live.set("reserved_until", "");
          }
          txApp.save(live);

          if (plan.overrideFrom !== null) {
            auditLib.writeAuditLog(txApp, {
              actor: staff.id,
              action: "price_override",
              collection: "items",
              record: live.id,
              meta: {
                sku: live.getString("sku"),
                sale: number,
                from: plan.overrideFrom,
                to: plan.unitPrice,
              },
              ip: e.realIP(),
            });
          }
        }

        if (split.store_credit > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
              customer: customerId,
              amount: -split.store_credit,
              reason: "sale",
              ref: number,
              staff: staff.id,
            })
          );
        }

        if (pointsSpent > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customerId,
              delta: -pointsSpent,
              reason: "redeem",
              ref: number,
              staff: staff.id,
            })
          );
        }

        if (customerId && pointsEarned > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customerId,
              delta: pointsEarned,
              reason: "earn_sale",
              ref: number,
              staff: staff.id,
            })
          );
        }

        if (split.cash > 0 && session) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("cash_movements"), {
              session: session.id,
              type: "cash_sale",
              amount: split.cash,
              ref: number,
              staff: staff.id,
            })
          );
        }

        if (redemption) {
          const liveRedemption = txApp.findRecordById("reward_redemptions", redemption.id);
          if (liveRedemption.getString("status") !== "issued") {
            halt = { status: 422, message: "That reward has already been used." };
            throw new Error(halt.message);
          }
          liveRedemption.set("status", "used");
          liveRedemption.set("used_in_sale", sale.id);
          liveRedemption.set("used_by", staff.id);
          txApp.save(liveRedemption);
        }

        const fresh = customerId
          ? balances.recompute(txApp, customerId)
          : { credit: 0, points: 0 };

        const meta = {
          number: number,
          lines: planned.length,
          total: total,
          payment: payment,
          cash_session: session ? session.id : "",
        };
        if (redemption) {
          meta.reward_redemption = redemption.id;
          meta.reward = redemption.getString("reward");
          meta.discount = saleDiscount;
        }
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "sale_complete",
          collection: "sales",
          record: sale.id,
          meta: meta,
          ip: e.realIP(),
        });

        result = {
          sale: { id: sale.id, number: number, total: total, status: "complete" },
          sumup_amount: split.sumup_card,
          points_earned: pointsEarned,
          credit_balance: fresh.credit,
          points_balance: fresh.points,
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
// POST /api/vault/sales/{id}/refund  (step-up)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sales/{id}/refund",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const saleline = require(`${__hooks}/lib/shared/saleline.js`);

    /** The sale's line records by id, beside the shared breakdown of them. */
    function recordsById(rows) {
      const map = {};
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]) map[rows[i].id] = rows[i];
      }
      return map;
    }

    stepup.requireStepUp(e);

    const staff = e.auth;
    const body = util.body(e);

    let sale = null;
    try {
      sale = e.app.findRecordById("sales", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Sale not found. Check the number and try again.", null);
    }
    if (sale.getString("status") === "refunded") {
      throw e.error(409, "This sale has already been refunded in full.", null);
    }

    const reason = util.asStr(body.reason);
    if (!reason) {
      throw e.badRequestError("Say why this is being refunded.", null);
    }

    const refundMethod = util.asStr(body.refund_method) || "sumup_card";
    if (["cash", "store_credit", "sumup_card"].indexOf(refundMethod) < 0) {
      throw e.badRequestError("Pick how the refund is going back: cash, store credit or card.", null);
    }

    const rawLines = body.lines && body.lines.length ? body.lines : [];
    if (rawLines.length === 0) {
      throw e.badRequestError("Pick at least one line to refund.", null);
    }

    // The as-sold breakdown: unit_price, qty and discount as they were at
    // completion, plus this line's share of the sale-level discount. The rows
    // come back in "created,id" order, which is the order the allocation's
    // rounding remainder is assigned in (lib/vaultutil.js).
    const soldRows = util.saleLineRows(e.app, sale.id);
    const soldRecords = recordsById(soldRows);
    const asSold = saleline.breakdown(util.asSoldLines(soldRows), sale.getInt("discount"));

    const requested = {};
    const order = [];
    for (let i = 0; i < rawLines.length; i++) {
      const lineId = util.asStr(rawLines[i].sale_line);
      const entry = asSold.byId[lineId];
      if (!entry) {
        throw e.badRequestError("One of those lines is not on this sale.", null);
      }
      if (soldRecords[lineId].getString("status") === "refunded") {
        throw e.error(409, "One of those lines has already been refunded.", null);
      }
      const remaining = saleline.remainingQty(entry);
      const want = Math.max(1, util.asInt(rawLines[i].qty, remaining));
      if (requested[lineId] === undefined) {
        requested[lineId] = 0;
        order.push(lineId);
      }
      requested[lineId] += want;
      if (requested[lineId] > remaining) {
        throw e.badRequestError(
          `Only ${remaining} of that line is still sold. Lower the quantity.`,
          null
        );
      }
    }

    const customerId = sale.getString("customer");
    if (refundMethod === "store_credit" && !customerId) {
      throw e.error(422, "This sale has no customer, so it cannot go back as store credit.", null);
    }

    let session = null;
    if (refundMethod === "cash") {
      session = util.openCashSession(e.app);
      if (!session) {
        throw e.error(422, "Open a cash session before refunding cash.", null);
      }
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const liveSale = txApp.findRecordById("sales", sale.id);
        if (liveSale.getString("status") === "refunded") {
          halt = { status: 409, message: "This sale has already been refunded in full." };
          throw new Error(halt.message);
        }

        // Re-read every line and price from the live refunded_qty, so two
        // refunds open at once cannot pay the same unit back twice.
        const liveRows = util.saleLineRows(txApp, liveSale.id);
        const liveRecords = recordsById(liveRows);
        const live = saleline.breakdown(util.asSoldLines(liveRows), liveSale.getInt("discount"));

        const plans = [];
        let refunded = 0;
        for (let i = 0; i < order.length; i++) {
          const entry = live.byId[order[i]];
          if (!entry) {
            halt = {
              status: 409,
              message: "That line is no longer on this sale. Reload it and try again.",
            };
            throw new Error(halt.message);
          }
          const record = liveRecords[order[i]];
          const want = requested[order[i]];
          if (record.getString("status") === "refunded" || saleline.remainingQty(entry) < want) {
            halt = {
              status: 409,
              message: "That line was refunded while this refund was open. Reload the sale and try again.",
            };
            throw new Error(halt.message);
          }
          refunded += saleline.refundAmount(entry, want);
          plans.push({
            line: record,
            qty: entry.qty,
            already: entry.refundedQty,
            want: want,
          });
        }

        for (let i = 0; i < plans.length; i++) {
          const plan = plans[i];

          let item = null;
          try {
            item = txApp.findRecordById("items", plan.line.getString("item"));
          } catch (err) {
            halt = {
              status: 409,
              message: "That item has been deleted, so it cannot go back into stock.",
            };
            throw new Error(halt.message);
          }
          item.set("qty", item.getInt("qty") + plan.want);
          item.set("status", "in_stock");
          txApp.save(item);

          // qty and discount stay as sold for ever; only refunded_qty moves.
          const after = plan.already + plan.want;
          plan.line.set("refunded_qty", after);
          if (after >= plan.qty) plan.line.set("status", "refunded");
          txApp.save(plan.line);
        }

        let allRefunded = true;
        const after = util.saleLineRows(txApp, liveSale.id);
        for (let i = 0; i < after.length; i++) {
          if (after[i] && after[i].getString("status") !== "refunded") allRefunded = false;
        }

        const refundedBefore = liveSale.getInt("refunded_total");
        const refundedAfter = refundedBefore + refunded;
        liveSale.set("refunded_total", refundedAfter);
        liveSale.set("status", allRefunded ? "refunded" : "part_refunded");
        txApp.save(liveSale);

        // Cumulative, from the sale's own earn figure: whatever order the
        // lines go back in, the points reversed total exactly what the sale
        // earned once it is fully refunded.
        const pointsEarned = liveSale.getInt("points_earned");
        const saleTotal = liveSale.getInt("total");
        const pointsToReverse =
          saleline.pointsCum(pointsEarned, saleTotal, refundedAfter) -
          saleline.pointsCum(pointsEarned, saleTotal, refundedBefore);

        if (refundMethod === "store_credit" && refunded > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
              customer: customerId,
              amount: refunded,
              reason: "sale",
              ref: liveSale.getString("number") + " refund",
              staff: staff.id,
            })
          );
        }

        if (refundMethod === "cash" && refunded > 0 && session) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("cash_movements"), {
              session: session.id,
              type: "refund",
              // Signed: money out of the drawer is negative.
              amount: -refunded,
              ref: liveSale.getString("number") + " refund",
              staff: staff.id,
            })
          );
        }

        if (customerId && pointsToReverse !== 0) {
          // The points ledger is allowed to go negative here: a customer who
          // has already spent what a refunded sale earned owes those points
          // back, and the ledger is the record of that.
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customerId,
              delta: -pointsToReverse,
              reason: "refund_reverse",
              ref: liveSale.getString("number") + " refund",
              staff: staff.id,
            })
          );
        }

        // The reason is a staff note against the sale, not audit meta:
        // audit_log is permanent and superuser-only, and a refund reason is
        // free text a staff member typed about a named customer.
        const note = new Record(txApp.findCollectionByNameOrId("notes"), {
          target_collection: "sales",
          target_record: liveSale.id,
          body: reason,
          author: staff.id,
        });
        txApp.save(note);

        const fresh = customerId
          ? balances.recompute(txApp, customerId)
          : { credit: 0, points: 0 };

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "sale_refund",
          collection: "sales",
          record: liveSale.id,
          meta: {
            number: liveSale.getString("number"),
            lines: plans.length,
            refunded: refunded,
            refunded_total: refundedAfter,
            refund_method: refundMethod,
            points_reversed: pointsToReverse,
            note: note.id,
          },
          ip: e.realIP(),
        });

        result = {
          sale: { id: liveSale.id, status: liveSale.getString("status") },
          refunded: refunded,
          refunded_total: refundedAfter,
          points_reversed: pointsToReverse,
          credit_balance: fresh.credit,
          points_balance: fresh.points,
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
