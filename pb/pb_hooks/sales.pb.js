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
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/sales/complete
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sales/complete",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const counters = require(`${__hooks}/lib/counters.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const METHODS = ["sumup_card", "cash", "store_credit", "points"];

    const staff = e.auth;
    const body = util.body(e);
    const now = new Date();

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
      if (cashCap > 0 && split.cash > cashCap) {
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

    if (split.store_credit > creditBalance) {
      throw e.error(
        422,
        `This customer has ${money.formatGBP(creditBalance)} in store credit. Lower the amount.`,
        null
      );
    }

    let pointsSpent = 0;
    if (split.points > 0) {
      pointsSpent = loyalty.penceToPoints(split.points, programme);
      const check = loyalty.checkPointsRedemption(programme, pointsBalance, pointsSpent, total);
      if (!check.ok) {
        let message = "Those points cannot be used on this sale.";
        if (check.reason === "disabled") {
          message = "The GG Guild is switched off, so points cannot be used.";
        } else if (check.reason === "below_minimum") {
          message = `Points start at ${programme.minRedeemPoints} points. Take this one another way.`;
        } else if (check.reason === "insufficient") {
          message = `This customer has ${pointsBalance} points. Lower the amount.`;
        } else if (check.reason === "over_share") {
          message = `Points can cover at most ${money.formatGBP(loyalty.pointsToPence(check.maxPointsForSale, programme))} of this sale.`;
        }
        throw e.error(422, message, null);
      }
    }

    const rewardCode = util.asStr(body.reward_code);
    let redemption = null;
    if (rewardCode) {
      try {
        redemption = e.app.findFirstRecordByFilter(
          "reward_redemptions",
          "code = {:code}",
          { code: rewardCode }
        );
      } catch (err) {
        throw e.error(422, "That reward code was not found. Check the voucher.", null);
      }
      if (customerId && redemption.getString("customer") !== customerId) {
        throw e.error(422, "That reward belongs to a different customer.", null);
      }
      if (redemption.getString("status") !== "issued") {
        throw e.error(422, "That reward has already been used.", null);
      }
      if (util.isPast(redemption.getString("expires_at"), now)) {
        throw e.error(422, "That reward has expired.", null);
      }
    }

    // -----------------------------------------------------------------
    // Points earned (never on the part paid with points)
    // -----------------------------------------------------------------
    const earnLines = [];
    for (let i = 0; i < planned.length; i++) {
      earnLines.push({
        game: planned[i].item.getString("game") || null,
        kind: planned[i].item.getString("kind"),
        total: planned[i].lineTotal,
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

    // -----------------------------------------------------------------
    // Write
    // -----------------------------------------------------------------
    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
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
          points_earned: earn.total,
          status: "complete",
        });
        if (customerId) sale.set("customer", customerId);
        if (session) sale.set("cash_session", session.id);
        const discountSource = util.asStr(body.discount_source);
        if (discountSource) sale.set("discount_source", discountSource);
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

        if (customerId && earn.total > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("points_ledger"), {
              customer: customerId,
              delta: earn.total,
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

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "sale_complete",
          collection: "sales",
          record: sale.id,
          meta: {
            number: number,
            lines: planned.length,
            total: total,
            payment: payment,
            cash_session: session ? session.id : "",
          },
          ip: e.realIP(),
        });

        result = {
          sale: { id: sale.id, number: number, total: total, status: "complete" },
          sumup_amount: split.sumup_card,
          points_earned: earn.total,
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
    const money = require(`${__hooks}/lib/shared/money.js`);

    stepup.requireStepUp(e);

    const staff = e.auth;
    const body = util.body(e);
    const now = new Date();

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

    const allLines = e.app.findRecordsByFilter(
      "sale_lines",
      "sale = {:sale}",
      "created",
      0,
      0,
      { sale: sale.id }
    );
    const byId = {};
    let soldSubtotal = 0;
    for (let i = 0; i < allLines.length; i++) {
      if (!allLines[i]) continue;
      byId[allLines[i].id] = allLines[i];
      soldSubtotal +=
        allLines[i].getInt("unit_price") * Math.max(1, allLines[i].getInt("qty")) -
        allLines[i].getInt("discount");
    }

    const saleDiscount = sale.getInt("discount");
    const planned = [];
    let refunded = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const lineId = util.asStr(rawLines[i].sale_line);
      const line = byId[lineId];
      if (!line) {
        throw e.badRequestError("One of those lines is not on this sale.", null);
      }
      if (line.getString("status") === "refunded") {
        throw e.error(409, "One of those lines has already been refunded.", null);
      }
      const lineQty = Math.max(1, line.getInt("qty"));
      const qty = Math.max(1, util.asInt(rawLines[i].qty, lineQty));
      if (qty > lineQty) {
        throw e.badRequestError(
          `Only ${lineQty} of that line was sold. Lower the quantity.`,
          null
        );
      }

      const lineGross = line.getInt("unit_price") * lineQty - line.getInt("discount");
      const share = money.roundHalfUp((lineGross * qty) / lineQty);
      // The sale-level discount comes off pro rata, so refunding every line
      // of a sale returns exactly what was taken for it.
      const discountShare =
        saleDiscount > 0 && soldSubtotal > 0
          ? money.roundHalfUp((saleDiscount * share) / soldSubtotal)
          : 0;
      const amount = Math.max(0, share - discountShare);
      refunded += amount;

      planned.push({ line: line, qty: qty, lineQty: lineQty, amount: amount });
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

    const saleTotal = sale.getInt("total");
    const pointsEarned = sale.getInt("points_earned");
    const pointsToReverse =
      pointsEarned > 0 && saleTotal > 0
        ? money.roundHalfUp((pointsEarned * refunded) / saleTotal)
        : 0;

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const liveSale = txApp.findRecordById("sales", sale.id);
        if (liveSale.getString("status") === "refunded") {
          halt = { status: 409, message: "This sale has already been refunded in full." };
          throw new Error(halt.message);
        }

        for (let i = 0; i < planned.length; i++) {
          const plan = planned[i];
          const line = txApp.findRecordById("sale_lines", plan.line.id);

          const item = txApp.findRecordById("items", line.getString("item"));
          item.set("qty", item.getInt("qty") + plan.qty);
          item.set("status", "in_stock");
          txApp.save(item);

          if (plan.qty >= plan.lineQty) {
            line.set("status", "refunded");
          } else {
            // A part-refunded line keeps recording what is still sold.
            line.set("qty", plan.lineQty - plan.qty);
          }
          txApp.save(line);
        }

        let allRefunded = true;
        const after = txApp.findRecordsByFilter("sale_lines", "sale = {:sale}", "", 0, 0, {
          sale: liveSale.id,
        });
        for (let i = 0; i < after.length; i++) {
          if (after[i] && after[i].getString("status") !== "refunded") allRefunded = false;
        }
        liveSale.set("status", allRefunded ? "refunded" : "part_refunded");
        txApp.save(liveSale);

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

        if (customerId && pointsToReverse > 0) {
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
            lines: planned.length,
            refunded: refunded,
            refund_method: refundMethod,
            points_reversed: pointsToReverse,
            reason: reason,
          },
          ip: e.realIP(),
        });

        result = {
          sale: { id: liveSale.id, status: liveSale.getString("status") },
          refunded: refunded,
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
