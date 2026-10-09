/// <reference path="../pb_data/types.d.ts" />

/**
 * sales.pb.js - sale completion, the sale lookup and refunds.
 *
 *   POST /api/vault/sales/complete
 *   GET  /api/vault/sales/lookup?number=GG-S-000456
 *   POST /api/vault/sales/{id}/refund   (capability refund)
 *
 * docs/api-contract.md ("Sales") for the original shapes,
 * docs/api-contract-epos.md section 4 for the till's: tenders, till
 * products, server-checked discounts and price overrides, VAT, voids, the
 * register and its open session. Same shape as the trade-in route: validate
 * first, then one $app.runInTransaction with every write through txApp, with
 * a `halt` object carrying any in-transaction refusal back out past the Go
 * boundary.
 *
 * Every till sale and every refund needs an open cash session on the
 * register it names (the default register when it names none), and is
 * linked to that register and session; every payment is a `sale_tenders`
 * row (lib/tenders.js). Older callers' `payment` / `payment_split` and
 * `refund_method` are mapped onto tenders. SumUp is gone (section 5): a new
 * SumUp payment is refused, and historic `sumup_card` sales are left as
 * they are.
 *
 * A refund never rewrites what was sold. `sale_lines.qty` and `.discount`
 * are the as-sold figures for good; a refund moves
 * `sale_lines.refunded_qty` and `sales.refunded_total` only, and prices
 * itself from the immutable numbers through lib/shared/saleline.js, so any
 * sequence of partial refunds adds back up to exactly what was taken.
 *
 * `sales.complete` also accepts an optional `client_id` (the offline
 * queue's idempotency key): a replayed request carrying one that already
 * exists returns that sale's own body again rather than creating a second
 * sale.
 *
 * Since wave 2 (section 7) one ticket can also carry a trade-in and lines of
 * an earlier sale, all in the sale's own transaction:
 * - `trade_in` + `trade_settlement`: a part-exchange. The trade-in is
 *   completed exactly as the buy-in route completes one
 *   (lib/tradeincomplete.js); what it is worth, V, pays A = min(V, S)
 *   towards the sale as one `part_exchange` tender, and the surplus V - A
 *   goes out as store credit or cash under the buy-in's own rules.
 * - `returns`: an exchange. The lines are refunded exactly as the refund
 *   route refunds them (lib/salerefund.js); their value R pays
 *   E = min(R, what is left of the sale) as one `exchange` tender, written
 *   negative on the refund too so the two cancel, and the rest of R goes
 *   back through `returns.tenders`. A ticket of returns and no new lines is
 *   simply that refund.
 * The request's own tenders then come to what is left. A replay returns the
 * `trade_in` and `refund` blocks as the first answer gave them.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// Defaults for a sale created without them. `channel` is "counter" unless
// the eBay orders import (imports.pb.js) has already said "ebay", and
// `occurred_at` is now unless that import carries the order's own date. A
// counter sale with no register is the default register's
// (docs/api-contract-epos.md, section 1): the completion route always names
// one, and this covers anything else that writes a counter sale. A record
// hook is the one place every create path passes through, the import's
// included; an eBay sale is left without one.
// ---------------------------------------------------------------------
onRecordCreate((e) => {
  if (!e.record.getString("channel")) {
    e.record.set("channel", "counter");
  }
  if (!e.record.getString("occurred_at")) {
    e.record.set("occurred_at", new Date().toISOString());
  }
  if (e.record.getString("channel") === "counter" && !e.record.getString("register")) {
    const registers = require(`${__hooks}/lib/registers.js`);
    const fallback = registers.defaultRegister(e.app);
    if (fallback) e.record.set("register", fallback.id);
  }
  e.next();
}, "sales");

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
    const referralsLib = require(`${__hooks}/lib/referrals.js`);
    const rewardsLib = require(`${__hooks}/lib/rewards.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const tendersLib = require(`${__hooks}/lib/tenders.js`);
    const quotes = require(`${__hooks}/lib/quotes.js`);
    const tradeComplete = require(`${__hooks}/lib/tradeincomplete.js`);
    const refundLib = require(`${__hooks}/lib/salerefund.js`);
    const saleline = require(`${__hooks}/lib/shared/saleline.js`);
    const loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);
    const vat = require(`${__hooks}/lib/shared/vat.js`);

    const MAX_LINES = 200;
    const MAX_VOIDS = 100;

    const staff = e.auth;
    const body = util.body(e);
    const now = new Date();

    /** A JS array from an untyped body value, [] when it is not a list. */
    function listOf(value) {
      if (!value || typeof value !== "object" || typeof value.length !== "number") return [];
      const out = [];
      for (let i = 0; i < value.length; i++) out.push(value[i]);
      return out;
    }

    /** Whether a body field was sent at all (0 counts; null and "" do not). */
    function given(value) {
      return value !== undefined && value !== null && value !== "";
    }

    /**
     * A nested body object as plain JavaScript data, or null when it is not
     * an object. A nested object in the body arrives as a Go map, which
     * reads like an object but is not one; one JSON round trip makes it
     * ordinary data, lists included.
     */
    function plainObject(value) {
      if (!value || typeof value !== "object") return null;
      try {
        const out = JSON.parse(JSON.stringify(value));
        return out && typeof out === "object" && !Array.isArray(out) ? out : null;
      } catch (err) {
        return null;
      }
    }

    /**
     * The request's `voided`: lines that were on this ticket and removed
     * before payment, for the X and Z. Thrown 400s for too many or a
     * negative amount.
     */
    function readVoids() {
      const rawVoids = listOf(body.voided);
      if (rawVoids.length > MAX_VOIDS) {
        throw e.badRequestError(`A sale can record up to ${MAX_VOIDS} removed lines.`, null);
      }
      const out = [];
      for (let v = 0; v < rawVoids.length; v++) {
        const raw = rawVoids[v] && typeof rawVoids[v] === "object" ? rawVoids[v] : {};
        const amount = util.asInt(raw.amount, 0);
        if (amount < 0) {
          throw e.badRequestError("A removed line cannot have a negative amount. Check the voids.", null);
        }
        out.push({
          title: (util.asStr(raw.title) || "Line").slice(0, 120),
          qty: Math.max(1, util.asInt(raw.qty, 1)),
          amount: amount,
        });
      }
      return out;
    }

    /**
     * Write `void_line` till events for lines removed from this ticket
     * before payment: the same shape POST /api/vault/till/void writes, which
     * the X and Z report reads (section 3), the line's value in pence and
     * its title and quantity.
     */
    function writeVoids(txApp, list, ctx) {
      if (!list.length) return;
      const events = txApp.findCollectionByNameOrId("till_events");
      for (let v = 0; v < list.length; v++) {
        const event = new Record(events, {
          register: ctx.register,
          session: ctx.session,
          kind: "void_line",
          amount: list[v].amount,
          detail: { title: list[v].title, qty: list[v].qty },
          staff: ctx.staff,
        });
        if (ctx.approver) event.set("approver", ctx.approver);
        txApp.save(event);
      }
    }

    /** The approver a capability was granted by in a check, or "" when the caller holds it. */
    function approverIn(result, capability) {
      const list = result && result.grants ? result.grants : [];
      for (let g = 0; g < list.length; g++) {
        if (list[g].capability === capability && list[g].approver) return list[g].approver.id;
      }
      return "";
    }

    /** Whole pence off an untyped value (a number, or a string of digits), or null. */
    function wholePence(value) {
      if (typeof value === "number" && isFinite(value) && Math.floor(value) === value) return value;
      if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
      return null;
    }

    // -----------------------------------------------------------------
    // Idempotency (docs/api-contract.md, "Sales"): the offline queue's
    // client_id. A replayed request with one already on a sale skips every
    // check below and returns that sale's own body, rebuilt from the
    // stored rows plus the customer's *current* balances, rather than
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
        const existingTenders = tendersLib.tendersFor(e.app, existingSale, "");
        // A part-exchange and an exchange come back as they were given:
        // the trade-in off its own record, the refund off the sale's audit
        // row (section 7).
        let existingTrade = null;
        if (existingSale.getString("trade_in")) {
          try {
            existingTrade = tradeComplete.saleBlock(
              e.app.findRecordById("trade_ins", existingSale.getString("trade_in"))
            );
          } catch (err) {
            existingTrade = null;
          }
        }
        const existingReturns = refundLib.returnsOf(e.app, existingSale.id);
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
          tenders: existingTenders,
          change: tendersLib.changeOf(existingTenders),
          vat_total: existingSale.getInt("vat_total"),
          receipt: { number: existingSale.getString("number") },
          trade_in: existingTrade,
          refund: existingReturns ? refundLib.ticketBlock(e.app, existingReturns) : null,
        });
      }
      // A ticket of returns alone made no sale: its client_id is on its
      // refund's audit row instead. Only such a ticket (no lines) looks
      // there, so an ordinary sale never scans the audit log.
      if (listOf(body.lines).length === 0) {
        const existingRefund = refundLib.replayByClientId(e.app, clientId);
        if (existingRefund) return e.json(200, existingRefund);
      }
    }

    // -----------------------------------------------------------------
    // The register and its open session (section 4): every till sale,
    // whatever the tender. A `cash_session` from an older caller has to be
    // the one that is open.
    // -----------------------------------------------------------------
    const resolved = registers.resolve(e.app, util.asStr(body.register));
    if (resolved.status) throw e.error(resolved.status, resolved.message, null);
    const register = resolved.register;
    const registerName = register.getString("name");
    const session = registers.openSession(e.app, register.id);
    if (!session) throw e.error(409, "Open the till first.", null);
    const sentSession = util.asStr(body.cash_session);
    if (sentSession && sentSession !== session.id) {
      throw e.error(
        409,
        `That cash session is not the one open on ${registerName}. Reload the till and try again.`,
        null
      );
    }

    const settings = util.settings(e.app);
    const epos = tendersLib.eposSettings(e.app, settings);
    const cashCap = settings ? settings.getInt("cash_cap") : 0;
    const vatRegistered = settings ? settings.getBool("vat_registered") : false;

    // -----------------------------------------------------------------
    // The customer
    // -----------------------------------------------------------------
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

    // -----------------------------------------------------------------
    // A trade-in taken as part-exchange, and lines of an earlier sale
    // brought back, in the same ticket (section 7)
    // -----------------------------------------------------------------
    const tradeInId = util.asStr(body.trade_in);
    const returnsInput = given(body.returns) ? plainObject(body.returns) : null;
    if (given(body.returns) && !returnsInput) {
      throw e.badRequestError("Send the returns as the sale they came from, its lines and a reason.", null);
    }

    /** The sale lines are brought back from, or a thrown 404. */
    function returnedSale() {
      try {
        return e.app.findRecordById("sales", util.asStr(returnsInput.sale));
      } catch (err) {
        throw e.notFoundError("Sale not found. Check the number and try again.", null);
      }
    }

    // -----------------------------------------------------------------
    // Lines: stock items and till products
    // -----------------------------------------------------------------
    const rawLines = listOf(body.lines);
    if (rawLines.length === 0) {
      if (!returnsInput) {
        throw e.badRequestError("Add at least one item to the sale.", null);
      }
      if (tradeInId) {
        throw e.badRequestError(
          "There is nothing on the ticket for the trade-in to pay for. Add an item, or complete it as a buy-in.",
          null
        );
      }
      return completeReturnsOnly();
    }

    /**
     * A ticket of returns and no new lines is simply a refund (section 7):
     * the refund route's own checks and writes (lib/salerefund.js) on this
     * register's open session, the whole value back through
     * `returns.tenders`, any lines voided off the ticket on the way, and the
     * refund route's own body with `refund.exchange` 0. Its client_id goes on
     * the refund's audit row, since there is no sale to carry it.
     */
    function completeReturnsOnly() {
      const origin = returnedSale();
      const ready = refundLib.prepare(e.app, origin, { lines: returnsInput.lines, reason: returnsInput.reason });
      if (!ready.ok) throw e.error(ready.status, ready.message, null);
      const plan = ready.plan;

      const paidBack = tendersLib.ticketRefundTenders(returnsInput, {
        amount: plan.amount,
        hasCustomer: !!plan.customerId,
        exchange: 0,
      });
      if (!paidBack.ok) throw e.error(paidBack.status, paidBack.message, null);
      if (paidBack.cash > 0) {
        const expected = util.sessionExpected(e.app, session);
        if (paidBack.cash > expected) throw e.error(409, refundLib.drawerShort(expected), null);
      }

      const onlyVoids = readVoids();

      // Capability last, as on the refund route.
      const onlyGrant = perms.checkAll(e, onlyVoids.length ? ["refund", "void_line"] : ["refund"]);
      if (!onlyGrant.ok) return perms.refuse(e, onlyGrant);

      let onlyHalt = null;
      let onlyDone = null;
      try {
        e.app.runInTransaction((txApp) => {
          onlyDone = refundLib.write(txApp, plan, {
            register: register,
            session: session,
            staffId: staff.id,
            ip: e.realIP(),
            tenders: paidBack.tenders,
            cashAmount: paidBack.cash,
            creditAmount: tendersLib.amountFor(paidBack.tenders, "store_credit"),
            grant: onlyGrant,
            consumeGrant: true,
            clientId: clientId,
          });
          if (!onlyDone.ok) {
            onlyHalt = { status: onlyDone.status, message: onlyDone.message };
            throw new Error(onlyHalt.message);
          }
          writeVoids(txApp, onlyVoids, {
            register: register.id,
            session: session.id,
            staff: staff.id,
            approver: approverIn(onlyGrant, "void_line"),
          });
        });
      } catch (err) {
        if (onlyHalt) throw e.error(onlyHalt.status, onlyHalt.message, null);
        throw err;
      }

      return e.json(
        200,
        refundLib.returnsOnlyBody(e.app, {
          sale: onlyDone.sale,
          ref: onlyDone.refundRef,
          refunded: onlyDone.refunded,
          refundedAfter: onlyDone.refundedAfter,
          pointsReversed: onlyDone.pointsReversed,
          credit: onlyDone.credit,
          points: onlyDone.points,
        })
      );
    }
    if (rawLines.length > MAX_LINES) {
      throw e.badRequestError(`A sale can hold up to ${MAX_LINES} lines. Split it into two sales.`, null);
    }

    const planned = [];
    const qtyByItem = {};
    const memberships = [];
    let subtotal = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i] && typeof rawLines[i] === "object" ? rawLines[i] : {};
      const itemId = util.asStr(raw.item);
      const productId = util.asStr(raw.product);
      if (itemId && productId) {
        throw e.badRequestError(
          `Line ${i + 1} names a stock item and a till product. Send one or the other.`,
          null
        );
      }

      const qty = Math.max(1, util.asInt(raw.qty, 1));
      const lineDiscount = util.asInt(raw.discount, 0);
      let plan = null;

      if (productId) {
        let product = null;
        try {
          product = e.app.findRecordById("till_products", productId);
        } catch (err) {
          throw e.notFoundError(`Line ${i + 1} is not on the till any more. Reload the till.`, null);
        }
        const name = product.getString("name");
        if (!product.getBool("active")) {
          throw e.error(409, `${name} is switched off. Take it off the ticket.`, null);
        }
        const kind = product.getString("kind");
        // A deposit is whatever the customer leaves, so it is keyed like
        // an open-price product.
        const openPrice = kind === "open_price" || kind === "deposit";
        let unitPrice = product.getInt("price");
        let overrideFrom = null;
        if (openPrice) {
          if (!given(raw.unit_price)) {
            throw e.badRequestError(`Key a price for ${name}.`, null);
          }
          unitPrice = util.asInt(raw.unit_price, 0);
        } else if (given(raw.unit_price)) {
          unitPrice = util.asInt(raw.unit_price, 0);
          if (unitPrice !== product.getInt("price")) overrideFrom = product.getInt("price");
        }
        const sentTitle = util.asStr(raw.title);
        const taxScheme = product.getString("tax_scheme") || "standard";

        if (kind === "membership") {
          if (!customerId) {
            throw e.badRequestError("Attach the customer to sell a Guild Membership.", null);
          }
          let tier = null;
          const tierId = product.getString("membership_tier");
          if (tierId) {
            try {
              tier = e.app.findRecordById("loyalty_tiers", tierId);
            } catch (err) {
              tier = null;
            }
          }
          if (!tier) {
            throw e.error(409, "Guild Membership has no tier to grant yet. Set one under Settings first.", null);
          }
          const months = product.getInt("membership_months");
          if (months < 1) {
            throw e.error(409, `${name} has no length set yet. Set one under Settings first.`, null);
          }
          memberships.push({ index: i, tier: tier, months: months * qty });
        }

        plan = {
          index: i,
          product: product,
          item: null,
          kind: kind,
          game: null,
          sku: "",
          title: (openPrice && sentTitle ? sentTitle : name).slice(0, 300),
          label: name,
          qty: qty,
          unitPrice: unitPrice,
          overrideFrom: overrideFrom,
          taxScheme: taxScheme,
          vatRate: vat.rateFor({
            taxScheme: taxScheme,
            rate: product.getFloat("vat_rate"),
            vatRegistered: vatRegistered,
          }),
        };
      } else {
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

        // The same stock line on two lines of one ticket counts once
        // against its stock.
        qtyByItem[item.id] = (qtyByItem[item.id] || 0) + qty;
        const stock = Math.max(0, item.getInt("qty"));
        if (qtyByItem[item.id] > stock) {
          throw e.error(
            409,
            `Only ${stock} of ${item.getString("sku")} left in stock. Lower the quantity.`,
            null
          );
        }

        const ownPrice = item.getInt("price");
        const unitPrice = given(raw.unit_price) ? util.asInt(raw.unit_price, ownPrice) : ownPrice;
        const taxScheme = item.getString("tax_scheme") || "margin";
        plan = {
          index: i,
          product: null,
          item: item,
          kind: item.getString("kind"),
          game: item.getString("game") || null,
          sku: item.getString("sku"),
          title: (item.getString("title") || item.getString("sku")).slice(0, 300),
          label: item.getString("sku"),
          qty: qty,
          unitPrice: unitPrice,
          overrideFrom: unitPrice !== ownPrice ? ownPrice : null,
          taxScheme: taxScheme,
          vatRate: vat.rateFor({
            taxScheme: taxScheme,
            rate: vat.STANDARD_VAT_RATE,
            vatRegistered: vatRegistered,
          }),
        };
      }

      if (plan.unitPrice < 0 || lineDiscount < 0) {
        throw e.badRequestError("A price or discount cannot be negative. Check the line.", null);
      }
      const lineGross = plan.unitPrice * qty;
      const lineTotal = lineGross - lineDiscount;
      if (lineTotal < 0) {
        throw e.badRequestError(`The discount on ${plan.label} is more than the line is worth.`, null);
      }
      plan.discount = lineDiscount;
      plan.lineGross = lineGross;
      plan.lineTotal = lineTotal;
      subtotal += lineTotal;
      planned.push(plan);
    }

    // One kind of membership per sale: two tiers at once would leave the
    // customer with two plans pinning their tier.
    for (let m = 1; m < memberships.length; m++) {
      if (memberships[m].tier.id !== memberships[0].tier.id) {
        throw e.badRequestError("Sell one kind of Guild Membership at a time.", null);
      }
    }
    let membershipPlan = null;
    if (memberships.length) {
      let months = 0;
      for (let m = 0; m < memberships.length; m++) months += memberships[m].months;
      membershipPlan = { tier: memberships[0].tier, months: months, indexes: [] };
      for (let m = 0; m < memberships.length; m++) membershipPlan.indexes.push(memberships[m].index);

      let active = null;
      try {
        active = e.app.findFirstRecordByFilter(
          "memberships",
          'customer = {:customer} && status = "active"',
          { customer: customerId }
        );
      } catch (err) {
        active = null;
      }
      if (active && active.getString("tier") !== membershipPlan.tier.id) {
        let activeName = "another";
        try {
          activeName = e.app.findRecordById("loyalty_tiers", active.getString("tier")).getString("name");
        } catch (err) {
          activeName = "another";
        }
        throw e.error(
          409,
          `This customer already has a ${activeName} membership until ${quotes.ukDateShort(active.getString("renews_at"))}. Cancel it before selling a different one.`,
          null
        );
      }
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
    // Voids: lines that were on this ticket and removed before payment
    // -----------------------------------------------------------------
    const voids = readVoids();

    // -----------------------------------------------------------------
    // Part-exchange (section 7): the trade-in must be open, the ticket's
    // customer's, and have an accepted line. Its value V is what the
    // accepted lines come to at their credit offers; A = min(V, S) pays
    // towards this sale as one part_exchange tender, and U = V - A is the
    // surplus, paid out as credit or cash once the tenders are known good.
    // -----------------------------------------------------------------
    let trade = null;
    if (tradeInId) {
      if (!customerId) {
        throw e.badRequestError("Add the customer before taking a trade-in.", null);
      }
      let tradeIn = null;
      try {
        tradeIn = e.app.findRecordById("trade_ins", tradeInId);
      } catch (err) {
        throw e.notFoundError("That trade-in was not found. Start the trade-in again.", null);
      }
      const tradeStatus = tradeIn.getString("status");
      if (tradeStatus === "completed") {
        throw e.error(409, "That trade-in has already been completed.", null);
      }
      if (tradeStatus !== "draft" && tradeStatus !== "offered" && tradeStatus !== "accepted") {
        throw e.error(409, `That trade-in is ${tradeStatus}. Start a new one.`, null);
      }
      if (tradeIn.getString("customer") !== customerId) {
        throw e.badRequestError(
          "That trade-in is for a different customer. Start it again with the customer on the ticket.",
          null
        );
      }
      const tradeLines = tradeComplete.acceptedLines(e.app, tradeIn.id);
      if (!tradeLines || tradeLines.length === 0) {
        throw e.error(422, "Accept at least one line before completing this trade-in.", null);
      }
      const value = tradeComplete.totals(tradeLines).offer;
      const applied = Math.min(value, total);
      trade = { record: tradeIn, lines: tradeLines, value: value, applied: applied, surplus: value - applied };
    }
    const partExchange = trade ? trade.applied : 0;

    // -----------------------------------------------------------------
    // Exchanges (section 7): the returned lines are refunded with the
    // refund route's own checks (lib/salerefund.js), for a value R. What is
    // left of this sale after the trade-in takes E = min(R, S - A) of it as
    // one exchange tender; whatever of R that leaves goes back through
    // `returns.tenders`.
    // -----------------------------------------------------------------
    let back = null;
    if (returnsInput) {
      const origin = returnedSale();
      const ready = refundLib.prepare(e.app, origin, { lines: returnsInput.lines, reason: returnsInput.reason });
      if (!ready.ok) throw e.error(ready.status, ready.message, null);
      const exchange = Math.min(ready.plan.amount, total - partExchange);
      back = { sale: origin, plan: ready.plan, amount: ready.plan.amount, exchange: exchange };
    }
    const exchangeAmount = back ? back.exchange : 0;

    // -----------------------------------------------------------------
    // Tenders (section 4): the shared rules, then the live limits the
    // shared rules cannot see - the cash cap, the credit and the points.
    // With a trade-in or returns on the ticket the request's tenders come
    // to what they leave, and the server adds the part_exchange and
    // exchange tenders itself (lib/tenders.js).
    // -----------------------------------------------------------------
    const tenderCheck = tendersLib.ticketTenders(body, {
      total: total - partExchange - exchangeAmount,
      requireCardLast4: epos.require_card_last4,
      hasCustomer: !!customerId,
      partExchange: trade ? partExchange : null,
      exchange: back ? exchangeAmount : null,
    });
    if (!tenderCheck.ok) throw e.error(tenderCheck.status, tenderCheck.message, null);
    const tenders = tenderCheck.tenders;
    const cashAmount = tenderCheck.cash;
    const creditAmount = tendersLib.amountFor(tenders, "store_credit");
    const pointsAmount = tendersLib.amountFor(tenders, "points");

    if (cashAmount > 0) {
      // A cap of zero means no cash at all, not "no limit".
      if (cashCap <= 0) {
        throw e.error(422, "Cash sales are switched off in settings.", null);
      }
      if (cashAmount > cashCap) {
        throw e.error(
          422,
          `Cash is capped at ${money.formatGBP(cashCap)} a sale. Take the rest by card.`,
          null
        );
      }
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

    if (creditAmount > creditBalance) {
      throw e.error(422, creditRefusal(creditBalance), null);
    }

    let pointsSpent = 0;
    if (pointsAmount > 0) {
      pointsSpent = loyalty.penceToPoints(pointsAmount, programme);
      const check = loyalty.checkPointsRedemption(programme, pointsBalance, pointsSpent, total);
      if (!check.ok) {
        throw e.error(422, pointsRefusal(check, pointsBalance), null);
      }
    }

    // -----------------------------------------------------------------
    // The reward code
    // -----------------------------------------------------------------
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
      // The same lookup the two staff voucher routes use, so a code
      // typed in as it is printed (GGV-ABC12) finds the same row a
      // scanner's bare GGVABC12 does (lib/rewards.js's findByCode).
      redemption = rewardsLib.findByCode(e.app, rewardCode);
      if (!redemption) {
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
    // Points earned (never on the part paid with points, and never on a
    // deposit, which is money held against a later sale that earns them).
    //
    // The sale-level discount comes off the lines pro rata first, so the
    // gross the evaluator sees is the amount actually charged rather than
    // the pre-discount subtotal. The same spread prices each line's VAT.
    // -----------------------------------------------------------------
    const grosses = [];
    for (let i = 0; i < planned.length; i++) grosses.push(planned[i].lineTotal);
    const nets = saleline.spread(grosses, saleDiscount);

    // -----------------------------------------------------------------
    // The Guild and its offers (docs/api-contract-launch.md, section 2).
    // Points belong to members; the paid upgrade includes the Guild, so a
    // Guild Membership sold to somebody who has not joined joins them with
    // this sale and it earns as a member's sale does. Each line goes to the
    // evaluator with its branch lineage, item and product (lib/guild.js).
    // -----------------------------------------------------------------
    const guildLib = require(`${__hooks}/lib/guild.js`);
    const joinsWithSale = !!customer && !!membershipPlan && !guildLib.isMember(customer);
    const guildMember = !!customer && (guildLib.isMember(customer) || joinsWithSale);
    const paidMember = !!customer && (!!membershipPlan || guildLib.isPaidMember(e.app, customerId));
    const earnFacts = guildLib.earnFacts(e.app, planned);

    const earnLines = [];
    let vatTotal = 0;
    for (let i = 0; i < planned.length; i++) {
      planned[i].net = nets[i];
      planned[i].vatAmount = vat.vatInside(nets[i], planned[i].vatRate);
      vatTotal += planned[i].vatAmount;
      earnLines.push({
        game: planned[i].game,
        kind: planned[i].kind,
        total: planned[i].kind === "deposit" ? 0 : nets[i],
        lineage: earnFacts[i].lineage,
        item: earnFacts[i].item,
        product: earnFacts[i].product,
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
    const customerTier = priv ? util.tier(e.app, priv.getString("tier")) : null;

    const earn = loyalty.evaluateSalePoints(programme, rules, {
      lines: earnLines,
      at: now,
      isFirstPurchase: isFirstPurchase,
      isBirthdayMonth: isBirthdayMonth,
      tier: customerTier,
      paidWithPoints: pointsAmount,
      paidMember: paidMember,
    });
    // Points belong to a Guild member. A walk-in sale, or one to a customer
    // who has not joined, earns none. A sale that takes a part-exchange
    // earns them on its whole value like any sale; the trade-in earns its
    // own only on a credit surplus (EPOS-PLAN decision 5).
    const pointsEarned = customerId && guildMember ? earn.total : 0;

    // -----------------------------------------------------------------
    // The part-exchange's settlement (section 7). A surplus is paid as
    // store credit (all of it) or as cash (`surplus_cash`, 1p to all of it;
    // what is not paid in cash is left with the shop by agreement). Then
    // the buy-in's own checks, with this till's open session: the terms,
    // and for cash the cap, the address, the flags, the ID and its photo,
    // and 18 or over (lib/tradeincomplete.js).
    // -----------------------------------------------------------------
    let tradeReady = null;
    let surplusCash = 0;
    let surplusCredit = 0;
    let tradePayoutType = "part_exchange";
    if (trade) {
      const settlement = plainObject(body.trade_settlement) || {};
      if (trade.surplus > 0) {
        const choice = util.asStr(settlement.surplus);
        if (choice === "credit") {
          surplusCredit = trade.surplus;
          tradePayoutType = "credit";
        } else if (choice === "cash") {
          const cash = wholePence(settlement.surplus_cash);
          if (cash === null || cash < 1 || cash > trade.surplus) {
            throw e.badRequestError(
              `Pay between ${money.formatGBP(1)} and ${money.formatGBP(trade.surplus)} in cash, or pay the surplus as credit.`,
              null
            );
          }
          surplusCash = cash;
          tradePayoutType = "cash";
        } else {
          throw e.badRequestError("Pay the surplus as credit or cash.", null);
        }
      }
      const ready = tradeComplete.prepare(e.app, {
        tradeIn: trade.record,
        customer: customer,
        priv: priv,
        lines: trade.lines,
        payoutCash: surplusCash,
        payoutCredit: surplusCredit,
        termsAccepted: util.asBool(settlement.terms_accepted),
        idCheck: settlement.id_check,
        signature: settlement.signature,
        session: session,
        now: now,
      });
      if (!ready.ok) throw e.error(ready.status, ready.message, null);
      tradeReady = ready.prepared;
    }

    // -----------------------------------------------------------------
    // What of the returns this sale does not take goes back as a refund,
    // through `returns.tenders`: cash only as far as the drawer holds after
    // any cash this ticket pays out for the trade-in (section 4's rule).
    // -----------------------------------------------------------------
    let backTenders = null;
    if (back) {
      backTenders = tendersLib.ticketRefundTenders(returnsInput, {
        amount: back.amount - back.exchange,
        hasCustomer: !!back.plan.customerId,
        exchange: back.exchange,
      });
      if (!backTenders.ok) throw e.error(backTenders.status, backTenders.message, null);
      if (backTenders.cash > 0) {
        const expected = util.sessionExpected(e.app, session) - surplusCash;
        if (backTenders.cash > expected) throw e.error(409, refundLib.drawerShort(expected), null);
      }
    }

    // -----------------------------------------------------------------
    // Discounts and prices, checked on the server (section 4). A line
    // discount or a manual ticket discount above
    // settings.epos.discount_limit_pct of what it applies to needs
    // discount_over_limit; a unit_price that is not the item's or the
    // priced product's own needs price_override; recording voids needs
    // void_line; bringing lines back needs refund (section 7). A reward's
    // discount was matched to the reward above, and the customer's own
    // percent-off perks are worked out here, so only what is left over
    // counts as manual.
    // -----------------------------------------------------------------
    function perkAllowance() {
      if (!customerTier || !customerTier.perks) return 0;
      const percentOff = [];
      for (let p = 0; p < customerTier.perks.length; p++) {
        if (customerTier.perks[p].type === "percent_off") percentOff.push(customerTier.perks[p]);
      }
      if (!percentOff.length) return 0;
      let amount = 0;
      for (let i = 0; i < planned.length; i++) {
        let best = 0;
        for (let p = 0; p < percentOff.length; p++) {
          const scope = percentOff[p].scope || [];
          if (scope.indexOf(planned[i].kind) >= 0 && percentOff[p].value > best) best = percentOff[p].value;
        }
        if (best > 0) amount += money.applyPercent(planned[i].lineGross, best);
      }
      return amount;
    }

    function overLimit(off, base) {
      return off > 0 && off * 100 > base * epos.discount_limit_pct;
    }

    const ticketIsReward = discountSource === "reward" && !!redemption;
    const manualTicket = ticketIsReward ? 0 : Math.max(0, saleDiscount - perkAllowance());

    let needsPrice = false;
    let needsDiscount = overLimit(manualTicket, subtotal);
    for (let i = 0; i < planned.length; i++) {
      if (planned[i].overrideFrom !== null) needsPrice = true;
      if (overLimit(planned[i].discount, planned[i].lineGross)) needsDiscount = true;
    }
    const capabilities = [];
    if (needsPrice) capabilities.push("price_override");
    if (needsDiscount) capabilities.push("discount_over_limit");
    if (voids.length) capabilities.push("void_line");
    if (back) capabilities.push("refund");

    let grant = null;
    if (capabilities.length) {
      grant = perms.checkAll(e, capabilities);
      if (!grant.ok) return perms.refuse(e, grant);
    }

    /** The approver a capability was granted by, or "" when the caller holds it. */
    function approverFor(capability) {
      return approverIn(grant, capability);
    }

    // The refund's own audit row names the refund's approval only; the
    // sale spends every approval once, for the whole ticket.
    const refundGrant =
      back && grant && grant.grants
        ? {
            ok: true,
            grants: grant.grants.filter(function (g) {
              return g.capability === "refund";
            }),
          }
        : null;

    // -----------------------------------------------------------------
    // Write
    // -----------------------------------------------------------------
    let halt = null;
    let result = null;
    let pending = [];

    try {
      e.app.runInTransaction((txApp) => {
        // The session is re-read here: a Z report on the other device
        // between the check above and this write closes it.
        const liveSession = registers.openSession(txApp, register.id);
        if (!liveSession || liveSession.id !== session.id) {
          halt = { status: 409, message: "Open the till first." };
          throw new Error(halt.message);
        }

        // Balances are read before the transaction for the staff-facing
        // refusals; re-read them here so two tills spending the same credit
        // or the same points cannot both succeed.
        if (customerId && creditAmount > 0) {
          const liveCredit = balances.creditBalance(txApp, customerId);
          if (creditAmount > liveCredit) {
            halt = { status: 422, message: creditRefusal(liveCredit) };
            throw new Error(halt.message);
          }
        }
        if (customerId && pointsAmount > 0) {
          const livePoints = balances.pointsBalance(txApp, customerId);
          const liveCheck = loyalty.checkPointsRedemption(programme, livePoints, pointsSpent, total);
          if (!liveCheck.ok) {
            halt = { status: 422, message: pointsRefusal(liveCheck, livePoints) };
            throw new Error(halt.message);
          }
        }

        const liveItems = {};
        for (let i = 0; i < planned.length; i++) {
          if (!planned[i].item) continue;
          const id = planned[i].item.id;
          if (liveItems[id]) continue;
          const live = txApp.findRecordById("items", id);
          const status = live.getString("status");
          const reservedForThisCustomer =
            status === "reserved" && customerId && live.getString("reserved_for") === customerId;
          if ((status !== "in_stock" && !reservedForThisCustomer) || live.getInt("qty") < qtyByItem[id]) {
            halt = {
              status: 409,
              message: `${live.getString("sku")} was sold while this sale was open. Remove it and try again.`,
            };
            throw new Error(halt.message);
          }
          liveItems[id] = live;
        }

        const number = counters.nextNumber(txApp, "sale");
        const sharedTenders = require(`${__hooks}/lib/shared/tenders.js`);

        const sale = new Record(txApp.findCollectionByNameOrId("sales"), {
          number: number,
          staff: staff.id,
          subtotal: subtotal,
          discount: saleDiscount,
          total: total,
          payment: sharedTenders.paymentFor(tenders),
          // Mirrored for the reports written before tenders existed.
          payment_split: sharedTenders.splitFor(tenders),
          points_earned: pointsEarned,
          refunded_total: 0,
          refund_count: 0,
          vat_total: vatTotal,
          status: "complete",
          channel: "counter",
          register: register.id,
          cash_session: session.id,
        });
        if (customerId) sale.set("customer", customerId);
        if (discountSource) sale.set("discount_source", discountSource);
        if (clientId) sale.set("client_id", clientId);
        // The part-exchange's two halves point at each other (section 7).
        if (trade) sale.set("trade_in", trade.record.id);
        txApp.save(sale);

        try {
          perms.consume(txApp, grant, "sale:" + sale.id);
        } catch (err) {
          halt = { status: 409, message: "That approval has already been used. Ask for it again." };
          throw err;
        }

        const saleLines = txApp.findCollectionByNameOrId("sale_lines");
        for (let i = 0; i < planned.length; i++) {
          const plan = planned[i];
          const line = new Record(saleLines, {
            sale: sale.id,
            qty: plan.qty,
            unit_price: plan.unitPrice,
            discount: plan.discount,
            refunded_qty: 0,
            // Margin scheme lines carry no line VAT (the VAT sits on the
            // margin and is worked out in the stock book); a standard
            // line only carries VAT once the shop is registered.
            vat_rate: plan.vatRate,
            vat_amount: plan.vatAmount,
            tax_scheme: plan.taxScheme,
            title: plan.title,
            status: "sold",
          });
          // A line's own note from the ticket ("Signed by the artist").
          const sentLine = rawLines[plan.index];
          const note = sentLine && typeof sentLine === "object" ? util.asStr(sentLine.note).slice(0, 200) : "";
          if (note) line.set("note", note);
          if (plan.item) line.set("item", plan.item.id);
          if (plan.product) line.set("product", plan.product.id);
          txApp.save(line);

          if (plan.item) {
            const live = liveItems[plan.item.id];
            const remaining = live.getInt("qty") - plan.qty;
            live.set("qty", remaining);
            if (remaining <= 0) {
              live.set("status", "sold");
              live.set("reserved_for", "");
              live.set("reserved_until", "");
            }
            txApp.save(live);
          }

          if (plan.overrideFrom !== null) {
            auditLib.writeAuditLog(txApp, {
              actor: staff.id,
              action: "price_override",
              collection: plan.item ? "items" : "till_products",
              record: plan.item ? plan.item.id : plan.product.id,
              meta: {
                sku: plan.sku,
                sale: number,
                from: plan.overrideFrom,
                to: plan.unitPrice,
                approver: approverFor("price_override"),
              },
              ip: e.realIP(),
            });
          }
        }

        // Each line's VAT is inside its net after its share of the ticket
        // discount, and that share is the shared spread in the stored
        // "created,id" order (lib/vaultutil.js's saleLineRows): the order
        // the refund breakdown, the receipt and the X and Z report all
        // allocate in. Lines written in one transaction can come back in a
        // different order from the request's, which can move the spread's
        // rounding penny, so the VAT worked out above is settled here
        // against the stored rows.
        const storedRows = util.saleLineRows(txApp, sale.id);
        const storedSplit = saleline.breakdown(util.asSoldLines(storedRows), saleDiscount);
        let storedVat = 0;
        for (let r = 0; r < storedRows.length; r++) {
          const row = storedRows[r];
          if (!row) continue;
          const entry = storedSplit.byId[row.id];
          const lineVat = entry ? vat.vatInside(entry.net, row.getFloat("vat_rate")) : 0;
          storedVat += lineVat;
          if (lineVat !== row.getInt("vat_amount")) {
            row.set("vat_amount", lineVat);
            txApp.save(row);
          }
        }
        if (storedVat !== vatTotal) {
          vatTotal = storedVat;
          sale.set("vat_total", vatTotal);
          txApp.save(sale);
        }

        if (creditAmount > 0) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("credit_ledger"), {
              customer: customerId,
              amount: -creditAmount,
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

        // Phase 6: a pending referral where this customer is the referee
        // becomes earned on their first completed sale or buy-in, paying
        // both sides. One call, in this route's own transaction, so the
        // two bonus rows are atomic with the sale that earned them
        // (lib/referrals.js). A walk-in sale, or a customer with no
        // pending referral, is a no-op.
        if (customerId) {
          const referralOutcome = referralsLib.onFirstCompletion(txApp, customerId, staff.id, number);
          pending = pending.concat(referralOutcome.pending || []);
        }

        // A Guild Membership sold at the till creates the customer's
        // membership, or extends the one they have from the later of now
        // and its current end (the same rule as the renew route).
        let membershipMeta = null;
        if (membershipPlan) {
          let paid = 0;
          for (let m = 0; m < membershipPlan.indexes.length; m++) {
            for (let i = 0; i < planned.length; i++) {
              if (planned[i].index === membershipPlan.indexes[m]) paid += planned[i].net;
            }
          }
          let live = null;
          try {
            live = txApp.findFirstRecordByFilter(
              "memberships",
              'customer = {:customer} && status = "active"',
              { customer: customerId }
            );
          } catch (err) {
            live = null;
          }
          if (live && live.getString("tier") !== membershipPlan.tier.id) {
            halt = {
              status: 409,
              message: "This customer's membership changed while this sale was open. Reload the customer and try again.",
            };
            throw new Error(halt.message);
          }
          if (!live) {
            // A lapsed plan on the same tier is picked up again rather than
            // left beside a new one.
            try {
              live = txApp.findFirstRecordByFilter(
                "memberships",
                'customer = {:customer} && status = "lapsed" && tier = {:tier}',
                { customer: customerId, tier: membershipPlan.tier.id }
              );
            } catch (err) {
              live = null;
            }
          }
          const currentEnd = live && live.getString("renews_at")
            ? new Date(String(live.getString("renews_at")).replace(" ", "T"))
            : now;
          const from = !isNaN(currentEnd.getTime()) && currentEnd.getTime() > now.getTime() ? currentEnd : now;
          const renewsAt = util.addMonths(from, membershipPlan.months).toISOString();
          const note = `Sold on ${number}`;
          const tierName = membershipPlan.tier.getString("name");
          if (live) {
            live.set("status", "active");
            live.set("renews_at", renewsAt);
            live.set("price", paid);
            live.set("payment_note", note);
            txApp.save(live);
          } else {
            live = new Record(txApp.findCollectionByNameOrId("memberships"), {
              customer: customerId,
              tier: membershipPlan.tier.id,
              status: "active",
              started_at: now.toISOString(),
              renews_at: renewsAt,
              price: paid,
              payment_note: note,
            });
            txApp.save(live);
            const n = notifyLib.notify(txApp, {
              customer: customerId,
              type: "membership_started",
              title: `Your ${tierName} is live`,
              body: `Your ${tierName} runs until ${quotes.ukDateShort(renewsAt)}. The perks are in My Vault, under Guild.`,
              link: "/account/guild",
              email: true,
            });
            pending = pending.concat(n.pending || []);
          }
          membershipMeta = { membership: live.id, tier: membershipPlan.tier.id, months: membershipPlan.months };
        }

        // The paid upgrade includes the Guild: somebody buying it who had
        // not joined joins with this sale, welcome bonus and Guild card
        // included (lib/guild.js).
        let guildJoinMeta = null;
        if (joinsWithSale) {
          const joining = txApp.findRecordById("customers", customerId);
          if (!guildLib.isMember(joining)) {
            const joined = guildLib.join(txApp, joining, { staffId: staff.id, now: now });
            pending = pending.concat(joined.pending || []);
            guildJoinMeta = { welcome_points: joined.points };
          }
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

        // The returned lines, refunded exactly as the refund route refunds
        // them (lib/salerefund.js), before anything else on this ticket
        // touches the drawer: the part E this sale takes is a negative
        // exchange tender under the refund's own reference, the rest goes
        // back as tendered. The approvals were spent for the whole ticket
        // above.
        let returnsMeta = null;
        if (back) {
          const backDone = refundLib.write(txApp, back.plan, {
            register: register,
            session: session,
            staffId: staff.id,
            ip: e.realIP(),
            tenders: backTenders.tenders,
            cashAmount: backTenders.cash,
            creditAmount: tendersLib.amountFor(backTenders.tenders, "store_credit"),
            drawerReserve: surplusCash,
            grant: refundGrant,
            consumeGrant: false,
            exchange: { amount: back.exchange, sale: sale.id, number: number },
          });
          if (!backDone.ok) {
            halt = { status: backDone.status, message: backDone.message };
            throw new Error(halt.message);
          }
          returnsMeta = {
            sale: back.sale.id,
            number: back.sale.getString("number"),
            ref: backDone.refundRef,
            amount: backDone.refunded,
            exchange: back.exchange,
          };
        }

        // The trade-in, completed exactly as the buy-in route completes one
        // (lib/tradeincomplete.js), with what it paid towards this sale and
        // the link back to it.
        let tradeDone = null;
        if (trade) {
          tradeDone = tradeComplete.complete(txApp, tradeReady, {
            staffId: staff.id,
            ip: e.realIP(),
            payoutType: tradePayoutType,
            completedMessage: "That trade-in has already been completed.",
            partExchange: { value: partExchange, sale: sale.id, saleNumber: number },
          });
          if (!tradeDone.ok) {
            halt = { status: tradeDone.status, message: tradeDone.message };
            throw new Error(halt.message);
          }
          pending = pending.concat(tradeDone.pending || []);
        }

        // One sale_tenders row per tender, and the drawer moves by the cash
        // tender's amount, never by what was handed over.
        const tenderRows = tendersLib.writeTenders(txApp, {
          sale: sale.id,
          refundRef: "",
          tenders: tenders,
          register: register.id,
          session: session.id,
          staff: staff.id,
        });
        tendersLib.writeCashMovement(txApp, {
          session: session.id,
          type: "cash_sale",
          amount: cashAmount,
          ref: number,
          staff: staff.id,
        });

        // Lines taken off this ticket before payment, for the X and Z.
        writeVoids(txApp, voids, {
          register: register.id,
          session: session.id,
          staff: staff.id,
          approver: approverFor("void_line"),
        });

        perms.logOverrides(txApp, grant, {
          register: register.id,
          session: session.id,
          amount: total,
          detail: { sale: number },
          used_for: "sale:" + sale.id,
        });

        const fresh = customerId
          ? balances.recompute(txApp, customerId)
          : { credit: 0, points: 0 };

        const tenderMeta = [];
        for (let t = 0; t < tenders.length; t++) {
          tenderMeta.push({ method: tenders[t].method, amount: tenders[t].amount });
        }
        const meta = {
          number: number,
          lines: planned.length,
          total: total,
          payment: sale.getString("payment"),
          tenders: tenderMeta,
          vat_total: vatTotal,
          register: register.id,
          cash_session: session.id,
          voids: voids.length,
          approvals: perms.auditMeta(grant),
        };
        if (redemption) {
          meta.reward_redemption = redemption.id;
          meta.reward = redemption.getString("reward");
          meta.discount = saleDiscount;
        }
        if (membershipMeta) meta.membership = membershipMeta;
        if (guildJoinMeta) meta.guild_join = guildJoinMeta;
        // Identifiers and the shop's own money: the part-exchange as the
        // response gives it, and which refund the returns were, which the
        // receipt and a replay read back from here.
        const tradeBlock = tradeDone ? tradeComplete.saleBlock(tradeDone.record) : null;
        if (tradeBlock) meta.trade_in = tradeBlock;
        if (returnsMeta) meta.returns = returnsMeta;
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
          // SumUp is gone; kept at 0 for callers that still read it.
          sumup_amount: 0,
          points_earned: pointsEarned,
          credit_balance: fresh.credit,
          points_balance: fresh.points,
          tenders: tenderRows,
          change: tenderCheck.change,
          vat_total: vatTotal,
          receipt: { number: number },
          trade_in: tradeBlock,
          refund: returnsMeta,
        };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    // The refund's block reads its tenders back as committed, the same way
    // a replay does, so the two answers cannot differ.
    if (result.refund) result.refund = refundLib.ticketBlock(e.app, result.refund);

    // After the transaction has committed, never inside it (lib/notify.js).
    notifyLib.sendPending(e.app, pending);

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/sales/lookup?number=GG-S-000456   (staff)
//
// A sale by its receipt number, typed or scanned: the barcode carries the
// number without dashes (GGS000456), and a refund receipt's reference
// (GG-S-000456-R1) finds the sale it refunded. Each line comes with what is
// still refundable, worked out by the same shared breakdown the refund
// route uses (docs/api-contract-epos.md, section 4).
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/sales/lookup",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const tendersLib = require(`${__hooks}/lib/tenders.js`);
    const receiptLib = require(`${__hooks}/lib/salereceipt.js`);
    const saleline = require(`${__hooks}/lib/shared/saleline.js`);

    const typed = csvLib.queryParam(e, "number");
    const number = receiptLib.normaliseNumber(typed);
    if (!number) {
      throw e.badRequestError("Scan the receipt or type its number, for example GG-S-000456.", null);
    }

    let sale = null;
    try {
      sale = e.app.findFirstRecordByFilter("sales", "number = {:n}", { n: number });
    } catch (err) {
      sale = null;
    }
    if (!sale) throw e.notFoundError(`No sale has the number ${number}.`, null);

    const rows = util.saleLineRows(e.app, sale.id);
    const sold = saleline.breakdown(util.asSoldLines(rows), sale.getInt("discount"));
    const described = receiptLib.describeLines(e.app, rows);

    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const entry = sold.byId[row.id];
      if (!entry) continue;
      const refundable = row.getString("status") === "refunded" ? 0 : saleline.remainingQty(entry);
      const about = described[row.id] || { title: "", detail: "", sku: "" };
      lines.push({
        id: row.id,
        title: about.title,
        detail: about.detail,
        sku: about.sku,
        qty: entry.qty,
        refunded_qty: entry.refundedQty,
        unit_price: row.getInt("unit_price"),
        // Everything off this line, its share of a ticket discount
        // included, so unit_price x qty - discount = net.
        discount: row.getInt("unit_price") * entry.qty - entry.net,
        net: entry.net,
        refundable_qty: refundable,
        refundable_amount: refundable > 0 ? saleline.refundAmount(entry, refundable) : 0,
        tax_scheme: row.getString("tax_scheme") || "margin",
      });
    }

    let customer = null;
    if (sale.getString("customer")) {
      try {
        const c = e.app.findRecordById("customers", sale.getString("customer"));
        customer = { id: c.id, name: c.getString("name"), code: c.getString("code") };
      } catch (err) {
        customer = null;
      }
    }

    return e.json(200, {
      sale: {
        id: sale.id,
        number: sale.getString("number"),
        occurred_at: receiptLib.isoDate(sale.getString("occurred_at") || sale.getString("created")),
        total: sale.getInt("total"),
        status: sale.getString("status"),
        customer: customer,
        register_name: receiptLib.registerName(e.app, sale.getString("register")),
        staff_name: receiptLib.staffName(e.app, sale.getString("staff")),
        lines: lines,
        tenders: tendersLib.tendersFor(e.app, sale, ""),
      },
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/sales/{id}/refund   (capability refund)
//
// The checks on the lines and the refund itself are lib/salerefund.js,
// which a ticket bringing lines back through sales/complete shares
// (docs/api-contract-epos.md, section 7); this route keeps its own order:
// the sale and its lines, the tenders, the till and its drawer, then the
// capability.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/sales/{id}/refund",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const tendersLib = require(`${__hooks}/lib/tenders.js`);
    const refundLib = require(`${__hooks}/lib/salerefund.js`);

    const staff = e.auth;
    const body = util.body(e);

    let sale = null;
    try {
      sale = e.app.findRecordById("sales", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Sale not found. Check the number and try again.", null);
    }

    const ready = refundLib.prepare(e.app, sale, { lines: body.lines, reason: body.reason });
    if (!ready.ok) throw e.error(ready.status, ready.message, null);
    const plan = ready.plan;

    const tenderCheck = tendersLib.refundTenders(body, { amount: plan.amount, hasCustomer: !!plan.customerId });
    if (!tenderCheck.ok) throw e.error(tenderCheck.status, tenderCheck.message, null);
    const tenders = tenderCheck.tenders;
    const cashAmount = tenderCheck.cash;
    const creditAmount = tendersLib.amountFor(tenders, "store_credit");

    // Every refund is made at a till with its drawer open (section 4).
    const resolved = registers.resolve(e.app, util.asStr(body.register));
    if (resolved.status) throw e.error(resolved.status, resolved.message, null);
    const register = resolved.register;
    const session = registers.openSession(e.app, register.id);
    if (!session) throw e.error(409, "Open the till first.", null);

    if (cashAmount > 0) {
      const expected = util.sessionExpected(e.app, session);
      if (cashAmount > expected) throw e.error(409, refundLib.drawerShort(expected), null);
    }

    // Capability last, so a manager is only asked to approve a refund that
    // will otherwise go through. Step-up is no longer needed (section 4).
    const grant = perms.check(e, "refund");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;

    try {
      e.app.runInTransaction((txApp) => {
        done = refundLib.write(txApp, plan, {
          register: register,
          session: session,
          staffId: staff.id,
          ip: e.realIP(),
          tenders: tenders,
          cashAmount: cashAmount,
          creditAmount: creditAmount,
          grant: grant,
          consumeGrant: true,
          refundMethod: util.asStr(body.refund_method),
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

    return e.json(200, refundLib.responseOf(done));
  },
  $apis.requireAuth("staff")
);
