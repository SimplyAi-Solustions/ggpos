/// <reference path="../pb_data/types.d.ts" />

/**
 * portal.pb.js - the customer's own account: My Vault's summary, export,
 * self-delete, the QR landing page, notifications and push subscriptions
 * (docs/PLAN.md, "Customers, 'My Vault'" and "Public";
 * docs/api-contract.md's Phase 5 section for the exact shapes).
 *
 *   GET    /api/vault/me
 *   PATCH  /api/vault/me
 *   GET    /api/vault/me/export
 *   POST   /api/vault/me/delete
 *   GET    /api/vault/c/{token}
 *   GET    /api/vault/me/notifications
 *   POST   /api/vault/me/notifications/{id}/read
 *   POST   /api/vault/push/subscribe
 *   DELETE /api/vault/push/subscribe
 *
 * The /me shape itself (lib/vaultutil.js's meShapeFor) is the one place
 * GET /me, PATCH /me and GET /c/:token build it, so the three can never
 * quietly disagree on what a customer's own summary looks like. A customer
 * route never returns another customer's data or any ID field: every
 * lookup here that could name the wrong owner checks it and 404s rather
 * than 403, so a stranger cannot even confirm a record exists (the same
 * reasoning quotes.pb.js and wants.pb.js use).
 *
 * Every write route runs inside one $app.runInTransaction, per this
 * package's own "every write in a transaction through txApp" rule.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/me   (customer) lives in routes.pb.js, alongside the
// existing staff GET /api/vault/me it predates - PocketBase's router
// refuses two handlers on the same method and path, so the customer branch
// was added there instead of registered again here. See that file's own
// comment on the route.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// PATCH /api/vault/me   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "PATCH",
  "/api/vault/me",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const customer = e.auth;
    const body = util.body(e);

    if (body.email !== undefined) {
      throw e.badRequestError(
        "Email cannot be changed here. Ask a member of staff to update it.",
        null
      );
    }
    if (body.birthday_month !== undefined && body.birthday_month !== null && body.birthday_month !== "") {
      const month = util.asInt(body.birthday_month, 0);
      if (month < 1 || month > 12) {
        throw e.badRequestError("Birthday month must be between 1 and 12.", null);
      }
    }
    if (body.name !== undefined && !util.asStr(body.name)) {
      throw e.badRequestError("A name cannot be blank.", null);
    }

    let result = null;
    e.app.runInTransaction((txApp) => {
      const live = txApp.findRecordById("customers", customer.id);
      const changed = [];

      if (body.name !== undefined) {
        live.set("name", util.asStr(body.name));
        changed.push("name");
      }
      if (body.phone !== undefined) {
        live.set("phone", util.asStr(body.phone));
        changed.push("phone");
      }
      if (body.marketing_consent !== undefined) {
        live.set("marketing_consent", util.asBool(body.marketing_consent));
        changed.push("marketing_consent");
      }
      if (body.birthday_month !== undefined) {
        live.set("birthday_month", body.birthday_month === "" || body.birthday_month === null ? null : util.asInt(body.birthday_month, 0));
        changed.push("birthday_month");
      }
      if (body.notifications && typeof body.notifications === "object") {
        if (body.notifications.email !== undefined) {
          live.set("notify_email", util.asBool(body.notifications.email));
          changed.push("notify_email");
        }
        if (body.notifications.push !== undefined) {
          live.set("notify_push", util.asBool(body.notifications.push));
          changed.push("notify_push");
        }
      }

      txApp.save(live);

      auditLib.writeAuditLog(txApp, {
        actor: customer.id,
        action: "customer_self_update",
        collection: "customers",
        record: customer.id,
        // Field names only, the same convention audit.pb.js uses for an
        // ordinary record update - never the values themselves.
        meta: { changed: changed },
        ip: e.realIP(),
      });

      result = util.meShapeFor(txApp, live);
    });

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/me/export   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/me/export",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const customer = e.auth;
    const customerId = customer.id;

    let priv = null;
    try {
      priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:c}", { c: customerId });
    } catch (err) {
      priv = null;
    }

    function list(collection, sort) {
      try {
        return e.app.findRecordsByFilter(collection, "customer = {:c}", sort || "created", 0, 0, {
          c: customerId,
        });
      } catch (err) {
        return [];
      }
    }

    const tradeIns = list("trade_ins").map((t) => {
      let lines = [];
      try {
        lines = e.app.findRecordsByFilter(
          "trade_in_lines",
          "trade_in = {:t}",
          "created",
          0,
          0,
          { t: t.id }
        );
      } catch (err) {
        lines = [];
      }
      return {
        id: t.id,
        number: t.getString("number"),
        channel: t.getString("channel"),
        status: t.getString("status"),
        payout_type: t.getString("payout_type"),
        payout_cash: t.getInt("payout_cash"),
        payout_credit: t.getInt("payout_credit"),
        total_market: t.getInt("total_market"),
        total_offer: t.getInt("total_offer"),
        completed_at: t.getString("completed_at"),
        created: t.getString("created"),
        lines: lines.map((l) => ({
          title: l.getString("free_text_title"),
          condition: l.getString("condition"),
          finish: l.getString("finish"),
          qty: l.getInt("qty"),
          market_price: l.getInt("market_price"),
          offer_price: l.getInt("offer_price"),
          accepted: l.getBool("accepted"),
        })),
      };
    });

    const sales = list("sales", "occurred_at").map((s) => ({
      number: s.getString("number"),
      occurred_at: s.getString("occurred_at"),
      total: s.getInt("total"),
      payment: s.getString("payment"),
      status: s.getString("status"),
    }));

    const creditLedger = list("credit_ledger").map((r) => ({
      amount: r.getInt("amount"),
      reason: r.getString("reason"),
      ref: r.getString("ref"),
      balance_after: r.getInt("balance_after"),
      created: r.getString("created"),
    }));

    const pointsLedger = list("points_ledger").map((r) => ({
      delta: r.getInt("delta"),
      reason: r.getString("reason"),
      ref: r.getString("ref"),
      balance_after: r.getInt("balance_after"),
      created: r.getString("created"),
    }));

    const quotes = list("quotes").map((q) => ({
      id: q.id,
      status: q.getString("status"),
      message: q.getString("message"),
      lines: util.jsonField(q, "lines", []),
      offer_total: q.getInt("offer_total"),
      offer_expires_at: q.getString("offer_expires_at"),
      drop_off: q.getString("drop_off"),
      created: q.getString("created"),
      // photos deliberately excluded.
    }));

    const wantList = list("want_list").map((w) => ({
      id: w.id,
      card: w.getString("card"),
      free_text: w.getString("free_text"),
      max_price: w.getInt("max_price"),
      status: w.getString("status"),
      created: w.getString("created"),
    }));

    const notifications = list("notifications").map((n) => ({
      type: n.getString("type"),
      title: n.getString("title"),
      body: n.getString("body"),
      link: n.getString("link"),
      read_at: n.getString("read_at"),
      created: n.getString("created"),
    }));

    // --- Phase 6: the Guild's own records ------------------------------
    const rewardNames = {};
    function rewardFor(rewardId) {
      if (!rewardId) return { name: "", cost_points: 0 };
      if (rewardNames[rewardId] !== undefined) return rewardNames[rewardId];
      let shape = { name: "", cost_points: 0 };
      try {
        const reward = e.app.findRecordById("loyalty_rewards", rewardId);
        shape = { name: reward.getString("name"), cost_points: reward.getInt("cost_points") };
      } catch (err) {
        shape = { name: "", cost_points: 0 };
      }
      rewardNames[rewardId] = shape;
      return shape;
    }

    const vouchers = list("reward_redemptions").map((v) => {
      const reward = rewardFor(v.getString("reward"));
      return {
        number: v.getString("number"),
        code: v.getString("code"),
        reward: reward.name,
        cost_points: reward.cost_points,
        points_spent: v.getInt("points_spent"),
        status: v.getString("status"),
        issued: v.getString("created"),
        expires_at: v.getString("expires_at"),
      };
    });

    function tierName(tierId) {
      if (!tierId) return "";
      try {
        return e.app.findRecordById("loyalty_tiers", tierId).getString("name");
      } catch (err) {
        return "";
      }
    }

    const memberships = list("memberships").map((m) => ({
      tier: tierName(m.getString("tier")),
      status: m.getString("status"),
      started_at: m.getString("started_at"),
      renews_at: m.getString("renews_at"),
      price: m.getInt("price"),
    }));

    // This year's counters only: a perk allowance is a monthly thing and
    // a list going back years is noise, not data about them.
    const thisYear = new Date().toISOString().slice(0, 4);
    const perkUsage = [];
    const perkRows = list("perk_usage", "period");
    for (let i = 0; i < perkRows.length; i++) {
      const row = perkRows[i];
      if (!row) continue;
      if (row.getString("period").slice(0, 4) !== thisYear) continue;
      perkUsage.push({
        perk: row.getString("perk_type"),
        period: row.getString("period"),
        used: row.getInt("used_count"),
      });
    }

    // Direction, status and date only. The other person is somebody else's
    // customer record: their id, code and name are their data, not this
    // caller's, and a subject access request is not a way to read them.
    const referralRows = [];
    try {
      const rows = e.app.findRecordsByFilter(
        "referrals",
        "referrer = {:c} || referee = {:c}",
        "created",
        0,
        0,
        { c: customerId }
      );
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        referralRows.push({
          direction: rows[i].getString("referrer") === customerId ? "referred_by_you" : "you_were_referred",
          status: rows[i].getString("status"),
          earned_at: rows[i].getString("earned_at"),
          created: rows[i].getString("created"),
        });
      }
    } catch (err) {
      // leave it empty
    }

    const guildState = require(`${__hooks}/lib/tiers.js`).evaluate(e.app, customerId, new Date());

    const exportBody = {
      exported_at: new Date().toISOString(),
      customer: {
        id: customer.id,
        code: customer.getString("code"),
        name: customer.getString("name"),
        email: customer.getString("email"),
        phone: customer.getString("phone"),
        created: customer.getString("created"),
      },
      consent: { marketing_consent: customer.getBool("marketing_consent") },
      // Status only - never an ID type, expiry, last four, dob or address.
      id_status: priv ? priv.getString("id_status") || "none" : "none",
      trade_ins: tradeIns,
      sales: sales,
      credit_ledger: creditLedger,
      points_ledger: pointsLedger,
      quotes: quotes,
      want_list: wantList,
      notifications: notifications,
      guild: {
        tier: guildState.tier ? guildState.tier.name : "",
        window_points: guildState.windowPoints,
      },
      vouchers: vouchers,
      memberships: memberships,
      perk_usage: perkUsage,
      referrals: referralRows,
    };

    auditLib.writeAuditLog(e.app, {
      actor: customerId,
      action: "customer_self_export",
      collection: "customers",
      record: customerId,
      meta: {
        trade_ins: tradeIns.length,
        sales: sales.length,
        quotes: quotes.length,
        vouchers: vouchers.length,
        memberships: memberships.length,
        referrals: referralRows.length,
      },
      ip: e.realIP(),
    });

    const header = e.response.header();
    header.set(
      "Content-Disposition",
      `attachment; filename="gg-vault-export-${customer.getString("code") || customer.id}.json"`
    );
    return e.json(200, exportBody);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/me/delete   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/me/delete",
  (e) => {
    const balances = require(`${__hooks}/lib/balances.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const customerops = require(`${__hooks}/lib/customerops.js`);

    const customer = e.auth;
    const credit = balances.creditBalance(e.app, customer.id);
    if (credit > 0) {
      throw e.error(
        422,
        `You still have ${money.formatGBP(credit)} store credit. Use it or ask the shop to pay it out first.`,
        null
      );
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const outcome = customerops.erase(txApp, customer.id, {
          creditRefusal: (pence) =>
            `You still have ${money.formatGBP(pence)} store credit. Use it or ask the shop to pay it out first.`,
        });
        if (!outcome.ok) {
          halt = { status: outcome.status, message: outcome.message };
          throw new Error(halt.message);
        }

        auditLib.writeAuditLog(txApp, {
          actor: customer.id,
          action: "customer_self_delete",
          collection: "customers",
          record: customer.id,
          meta: { removed: outcome.removed },
          ip: e.realIP(),
        });

        result = { erased: true };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/c/{token}   (public; staff or the owning customer see more)
// ---------------------------------------------------------------------
routerAdd("GET", "/api/vault/c/{token}", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);

  const token = e.request.pathValue("token");
  let customer = null;
  try {
    customer = e.app.findFirstRecordByFilter("customers", "qr_token = {:token}", { token: token });
  } catch (err) {
    customer = null;
  }
  if (!customer) {
    // Never a name, staff or not - a QR token that matches nothing reads
    // exactly like one that was never issued.
    throw e.notFoundError("Not found.", null);
  }

  const auth = e.auth;
  if (auth && auth.collection().name === "staff") {
    return e.json(200, {
      customer_id: customer.id,
      code: customer.getString("code"),
      name: customer.getString("name"),
    });
  }
  if (auth && auth.collection().name === "customers" && auth.id === customer.id) {
    return e.json(200, { customer: util.meShapeFor(e.app, customer) });
  }

  return e.json(200, { known: true });
});

// ---------------------------------------------------------------------
// GET /api/vault/me/notifications   (customer, newest first, 50)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/me/notifications",
  (e) => {
    const customer = e.auth;
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "notifications",
        "customer = {:c}",
        "-created",
        50,
        0,
        { c: customer.id }
      );
    } catch (err) {
      rows = [];
    }
    let unread = 0;
    const items = rows.map((n) => {
      if (!n.getString("read_at")) unread += 1;
      return {
        id: n.id,
        type: n.getString("type"),
        title: n.getString("title"),
        body: n.getString("body"),
        link: n.getString("link"),
        read_at: n.getString("read_at"),
        created: n.getString("created"),
      };
    });
    return e.json(200, { items: items, unread: unread });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/me/notifications/{id}/read   (customer)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/me/notifications/{id}/read",
  (e) => {
    const customer = e.auth;
    const notificationId = e.request.pathValue("id");

    let notification = null;
    try {
      notification = e.app.findRecordById("notifications", notificationId);
    } catch (err) {
      throw e.notFoundError("Notification not found.", null);
    }
    if (notification.getString("customer") !== customer.id) {
      throw e.notFoundError("Notification not found.", null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("notifications", notificationId);
        if (live.getString("customer") !== customer.id) {
          halt = { status: 404, message: "Notification not found." };
          throw new Error(halt.message);
        }
        if (!live.getString("read_at")) {
          live.set("read_at", new Date().toISOString());
          txApp.save(live);
        }
        result = {
          notification: {
            id: live.id,
            type: live.getString("type"),
            title: live.getString("title"),
            body: live.getString("body"),
            link: live.getString("link"),
            read_at: live.getString("read_at"),
            created: live.getString("created"),
          },
        };
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
// POST /api/vault/push/subscribe   (customer or staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/push/subscribe",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const auth = e.auth;
    const isStaff = auth.collection().name === "staff";
    const body = util.body(e);
    const endpoint = util.asStr(body.endpoint);
    if (!endpoint) {
      throw e.badRequestError("A push endpoint is required.", null);
    }
    const keys = body.keys && typeof body.keys === "object" ? body.keys : {};
    const p256dh = util.asStr(keys.p256dh);
    const authKey = util.asStr(keys.auth);
    if (!p256dh || !authKey) {
      throw e.badRequestError("The push subscription is missing its keys.", null);
    }

    let result = null;
    e.app.runInTransaction((txApp) => {
      // Looked up by endpoint AND the caller's own identity together, not
      // by endpoint alone (fix round, finding 8): endpoint carries no
      // unique index, so once a second caller can hold a row for the same
      // endpoint (see below), a plain "first row with this endpoint" fetch
      // can just as easily return someone else's row as the caller's own -
      // re-pointing that would silently steal another customer's or staff
      // member's subscription, and skipping past the caller's own existing
      // row would duplicate it instead of upserting.
      let row = null;
      try {
        const ownerFilter = isStaff ? "endpoint = {:e} && staff = {:owner}" : "endpoint = {:e} && customer = {:owner}";
        row = txApp.findFirstRecordByFilter("push_subscriptions", ownerFilter, { e: endpoint, owner: auth.id });
      } catch (err) {
        row = null;
      }
      if (!row) {
        row = new Record(txApp.findCollectionByNameOrId("push_subscriptions"), { endpoint: endpoint });
      }
      row.set("keys", { p256dh: p256dh, auth: authKey });
      row.set("customer", isStaff ? "" : auth.id);
      row.set("staff", isStaff ? auth.id : "");
      txApp.save(row);

      // Never the endpoint or the keys - both are effectively credentials
      // (docs/PLAN.md's own "never log an endpoint or a key" rule for
      // services/notify applies here too).
      auditLib.writeAuditLog(txApp, {
        actor: auth.id,
        action: "push_subscribe",
        collection: "push_subscriptions",
        record: row.id,
        meta: {},
        ip: e.realIP(),
      });

      result = { subscribed: true };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff", "customers")
);

// ---------------------------------------------------------------------
// DELETE /api/vault/push/subscribe   (customer or staff)
// ---------------------------------------------------------------------
routerAdd(
  "DELETE",
  "/api/vault/push/subscribe",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const auth = e.auth;
    const isStaff = auth.collection().name === "staff";
    const body = util.body(e);
    const endpoint = util.asStr(body.endpoint);
    if (!endpoint) {
      throw e.badRequestError("A push endpoint is required.", null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        // Every row for this endpoint, not just one (fix round, finding
        // 8): a plain findFirst by endpoint alone can just as easily
        // return someone else's row as the caller's own once two callers
        // can hold a row for the same endpoint (see the subscribe route
        // above), so this looks at all of them and picks out the caller's
        // own by its actual owner field. No row at all for this endpoint
        // stays a quiet, idempotent success (the caller's own goal - not
        // being pushed to at this endpoint - is already true either way);
        // a row that exists but belongs to someone else is a 404, never
        // silently deleted or silently ignored as if it were the caller's.
        let rows = [];
        try {
          rows = txApp.findRecordsByFilter("push_subscriptions", "endpoint = {:e}", "", 0, 0, { e: endpoint });
        } catch (err) {
          rows = [];
        }
        const myRow = rows.find((r) =>
          isStaff ? r.getString("staff") === auth.id : r.getString("customer") === auth.id
        );
        if (rows.length > 0 && !myRow) {
          halt = { message: "Push subscription not found." };
          throw new Error(halt.message);
        }
        if (myRow) {
          txApp.delete(myRow);
          auditLib.writeAuditLog(txApp, {
            actor: auth.id,
            action: "push_unsubscribe",
            collection: "push_subscriptions",
            record: myRow.id,
            meta: {},
            ip: e.realIP(),
          });
        }
        result = { unsubscribed: true };
      });
    } catch (err) {
      if (halt) throw e.notFoundError(halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff", "customers")
);
