/**
 * Epos Now, GG Vault's side: the customer link and the Guild activation.
 *
 * The link. A GG Vault customer gets an Epos Now customer whose card number
 * is their bare GGC code, so the Code 128 barcode on My Vault attaches them
 * at the till. `customer_private.epos_customer_id` holds the Epos Now id
 * (staff-only, and unique when set). Linking is retry-safe: before creating
 * anybody it looks for an Epos Now customer with the same email address and
 * card number (one we made on an earlier try whose answer never arrived)
 * and links that instead. It never blocks the person waiting: a failure
 * leaves the row `queued` with the reason, and the `epos_link_retry` cron
 * tries again every five minutes, up to `MAX_ATTEMPTS`, then marks it
 * `failed` and tells the admins once. Every attempt is in the audit trail.
 *
 * The activation. A completed Epos Now sale containing one of
 * `settings.eposnow.guild_product_ids`, with a customer attached who is
 * linked to GG Vault, starts (or extends) that customer's paid plan for 12
 * months per unit from the sale's own time, at the price the till charged,
 * with the Epos Now transaction id in the payment note. `epos_transactions`
 * records every Guild sale handled, keyed uniquely by the Epos Now id, and
 * the row is written in the same transaction as the membership, so the
 * webhook and the poll arriving together can never both activate one sale.
 * A Guild sale with nobody attached, or somebody GG Vault does not know,
 * is recorded once and raises a staff notification instead.
 *
 * Outbound calls are made outside any database transaction (adapters/
 * eposnow.js has its own short timeout), and the writes they lead to are
 * made afterwards. require() this inside each handler - see pb/README.md.
 */

var MAX_ATTEMPTS = 12;
var MONTHS_PER_UNIT = 12;
var NO_CUSTOMER_TITLE = "Guild membership sold without a linked customer, link it in The Counter";

/** The token, the webhook secret, the Guild product ids and the location. */
function config(app) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var row = util.settings(app);
  var keys = row ? util.jsonField(row, "api_keys", {}) || {} : {};
  var epos = row ? util.jsonField(row, "eposnow", {}) || {} : {};
  return {
    token: keys.eposnow || "",
    webhookToken: keys.eposnow_webhook || "",
    productIds: shared.normaliseProductIds(epos.guild_product_ids),
    locationId: Number(epos.location_id) > 0 ? Number(epos.location_id) : null,
  };
}

function privateFor(app, customerId) {
  try {
    return app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: customerId,
    });
  } catch (err) {
    return null;
  }
}

/** The GG Vault customer linked to an Epos Now customer id, or null. */
function customerForEposId(app, eposCustomerId) {
  if (!eposCustomerId) return null;
  try {
    var priv = app.findFirstRecordByFilter("customer_private", "epos_customer_id = {:id}", {
      id: String(eposCustomerId),
    });
    return app.findRecordById("customers", priv.getString("customer"));
  } catch (err) {
    return null;
  }
}

/** The link as the counter shows it. */
function linkShape(priv) {
  return {
    status: priv ? priv.getString("epos_sync_status") || "" : "",
    epos_customer_id: priv ? priv.getString("epos_customer_id") : "",
    attempts: priv ? priv.getInt("epos_sync_attempts") : 0,
    error: priv ? priv.getString("epos_sync_error") : "",
    synced_at: priv ? priv.getString("epos_synced_at") : "",
  };
}

/** Mark a customer as waiting for a link, unless they already have one. */
function queue(app, customerId) {
  var priv = privateFor(app, customerId);
  if (!priv || priv.getString("epos_customer_id")) return priv;
  if (priv.getString("epos_sync_status") !== "queued") {
    priv.set("epos_sync_status", "queued");
    priv.set("epos_sync_attempts", 0);
    priv.set("epos_sync_error", "");
    app.save(priv);
  }
  return priv;
}

/**
 * Create (or find) the Epos Now customer for `customerId` and record the
 * link. Never throws. Answers `{ status, epos_customer_id, message }`
 * where status is "linked", "queued" or "failed".
 *
 * @param {any} app
 * @param {string} customerId
 * @param {{ actor?: string, ip?: string }} [opts]
 */
function link(app, customerId, opts) {
  opts = opts || {};
  var auditLib = require(`${__hooks}/lib/audit.js`);
  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);

  var customer = null;
  try {
    customer = app.findRecordById("customers", customerId);
  } catch (err) {
    return { status: "failed", epos_customer_id: "", message: "That customer was not found." };
  }
  var priv = privateFor(app, customerId);
  if (!priv) {
    return { status: "failed", epos_customer_id: "", message: "That customer has no private record yet." };
  }
  if (priv.getString("epos_customer_id")) {
    return { status: "linked", epos_customer_id: priv.getString("epos_customer_id"), message: "" };
  }

  var cfg = config(app);
  if (!cfg.token) {
    queue(app, customerId);
    return {
      status: "queued",
      epos_customer_id: "",
      message: "Epos Now is not set up yet. The link will be made once the API token is saved.",
    };
  }

  var code = customer.getString("code");
  var email = customer.getString("email");
  var eposId = "";
  var failure = "";

  // Retry-safe: an earlier try may have created the customer and lost the
  // answer. Same email and same card number means it is ours.
  if (email) {
    var found = adapter.findCustomersByEmail(cfg, email);
    if (found.ok && Array.isArray(found.data)) {
      for (var i = 0; i < found.data.length; i++) {
        if (shared.eposCardNumberOf(found.data[i]) === code) {
          eposId = shared.eposCustomerIdFrom(found.data[i]);
          break;
        }
      }
    } else if (!found.ok && found.status !== 404) {
      failure = found.message;
    }
  }

  if (!eposId && !failure) {
    var created = adapter.createCustomer(
      cfg,
      shared.eposCustomerBody({
        name: customer.getString("name"),
        email: email,
        code: code,
        marketingConsent: customer.getBool("marketing_consent"),
        locationId: cfg.locationId,
        signUpDate: new Date().toISOString(),
      })
    );
    if (created.ok) {
      eposId = shared.eposCustomerIdFrom(created.data);
      if (!eposId) failure = "Epos Now created the customer but did not say which id it gave them.";
    } else {
      failure = created.message;
    }
  }

  var live = privateFor(app, customerId);
  if (eposId) {
    try {
      live.set("epos_customer_id", eposId);
      live.set("epos_sync_status", "linked");
      live.set("epos_sync_error", "");
      live.set("epos_synced_at", new Date().toISOString());
      app.save(live);
    } catch (err) {
      // The unique index: another GG Vault customer already holds this id.
      failure = `Epos Now customer ${eposId} is already linked to another GG Vault customer.`;
      eposId = "";
      live = privateFor(app, customerId);
    }
  }

  if (eposId) {
    auditLib.writeAuditLog(app, {
      actor: opts.actor || "system",
      action: "epos_customer_link",
      collection: "customer_private",
      record: live.id,
      meta: { customer: customerId, epos_customer_id: eposId },
      ip: opts.ip || "",
    });
    return { status: "linked", epos_customer_id: eposId, message: "" };
  }

  var attempts = live.getInt("epos_sync_attempts") + 1;
  var gaveUp = attempts >= MAX_ATTEMPTS;
  live.set("epos_sync_attempts", attempts);
  live.set("epos_sync_status", gaveUp ? "failed" : "queued");
  live.set("epos_sync_error", String(failure).slice(0, 300));
  app.save(live);

  auditLib.writeAuditLog(app, {
    actor: opts.actor || "system",
    action: "epos_customer_link_failed",
    collection: "customer_private",
    record: live.id,
    meta: { customer: customerId, attempts: attempts, gave_up: gaveUp },
    ip: opts.ip || "",
  });

  if (gaveUp) {
    notifyLib.notify(app, {
      staffAll: true,
      type: "epos_link_failed",
      title: "Epos Now link failed",
      body: `${customer.getString("name")} (${code}) could not be added to Epos Now after ${attempts} tries: ${failure} Check the API token, then press Link to Epos Now on their record.`,
      link: `/counter/customers/${code}`,
    });
  }

  return {
    status: gaveUp ? "failed" : "queued",
    epos_customer_id: "",
    message: gaveUp
      ? `Epos Now refused the link ${attempts} times. ${failure}`
      : `Epos Now did not take the link this time, so it will try again in five minutes. ${failure}`,
  };
}

/** The cron: every queued link, oldest first, a batch at a time. */
function retryQueued(app, limit) {
  var cfg = config(app);
  var out = { tried: 0, linked: 0 };
  if (!cfg.token) return out;
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "customer_private",
      'epos_sync_status = "queued" && epos_customer_id = ""',
      "updated",
      limit || 25,
      0
    );
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    out.tried += 1;
    var result = link(app, rows[i].getString("customer"), { actor: "system" });
    if (result.status === "linked") out.linked += 1;
  }
  return out;
}

/**
 * Who an Epos Now sale belongs to: the linked GG Vault customer, or, when
 * nobody is linked to that Epos Now id yet, the customer whose GGC code is
 * the Epos Now customer's card number (somebody added at the till by hand,
 * card number and all), who is linked on the spot. Null when neither.
 */
function resolveCustomer(app, cfg, eposCustomerId) {
  if (!eposCustomerId) return null;
  var linked = customerForEposId(app, eposCustomerId);
  if (linked) return linked;

  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var sku = require(`${__hooks}/lib/shared/sku.js`);
  var auditLib = require(`${__hooks}/lib/audit.js`);

  var fetched = adapter.getCustomer(cfg, eposCustomerId);
  if (!fetched.ok) return null;
  var parsed = sku.parseCode(shared.eposCardNumberOf(fetched.data));
  if (!parsed || parsed.kind !== "customer") return null;
  var customer = null;
  try {
    customer = app.findFirstRecordByFilter("customers", "code = {:code}", { code: parsed.encoded });
  } catch (err) {
    return null;
  }
  var priv = privateFor(app, customer.id);
  if (!priv || priv.getString("epos_customer_id")) return null;
  try {
    priv.set("epos_customer_id", String(eposCustomerId));
    priv.set("epos_sync_status", "linked");
    priv.set("epos_sync_error", "");
    priv.set("epos_synced_at", new Date().toISOString());
    app.save(priv);
  } catch (err) {
    return null;
  }
  auditLib.writeAuditLog(app, {
    actor: "epos_now",
    action: "epos_customer_link",
    collection: "customer_private",
    record: priv.id,
    meta: { customer: customer.id, epos_customer_id: String(eposCustomerId), by_card_number: true },
    ip: "",
  });
  return customer;
}

function alreadyHandled(app, eposId) {
  try {
    app.findFirstRecordByFilter("epos_transactions", "epos_id = {:id}", { id: eposId });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Record a Guild sale nobody could be found for, and tell the admins, once
 * per sale. Returns false when another caller recorded it first.
 */
function recordUnmatched(app, tx, sale, source, outcome) {
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  try {
    app.runInTransaction(function (txApp) {
      txApp.save(
        new Record(txApp.findCollectionByNameOrId("epos_transactions"), {
          epos_id: tx.id,
          outcome: outcome,
          epos_customer_id: tx.customerId,
          amount: sale.amountPence,
          quantity: sale.quantity,
          sold_at: tx.soldAt || "",
          source: source,
        })
      );
      var who =
        outcome === "no_plan"
          ? "There is no paid plan tier in GG Guild to start, so nothing was activated."
          : tx.customerId
            ? `The till's customer ${tx.customerId} is not linked to anybody in GG Vault.`
            : "No customer was attached at the till.";
      notifyLib.notify(txApp, {
        staffAll: true,
        type: "epos_guild_unlinked",
        title: NO_CUSTOMER_TITLE,
        body: `Epos Now sale ${tx.id} sold the Guild membership. ${who} Find the customer and activate their membership on their record.`,
        link: "/counter/customers",
      });
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Handle every transaction in `txs` (already read through the shared
 * `eposTransactionsFrom`). Idempotent: a sale already in
 * `epos_transactions` is skipped, and the unique index settles a race.
 *
 * @returns {{ seen: number, guild: number, activated: number, renewed: number, unmatched: number, skipped: number }}
 */
function handleTransactions(app, txs, source) {
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var membershipsLib = require(`${__hooks}/lib/memberships.js`);
  var auditLib = require(`${__hooks}/lib/audit.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);

  var cfg = config(app);
  var out = { seen: 0, guild: 0, activated: 0, renewed: 0, unmatched: 0, skipped: 0 };
  if (!cfg.productIds.length) return out;

  for (var i = 0; i < (txs || []).length; i++) {
    var tx = txs[i];
    if (!tx) continue;
    out.seen += 1;
    if (!shared.isCompletedSale(tx)) continue;
    var sale = shared.guildSaleIn(tx, cfg.productIds);
    if (!sale) continue;
    out.guild += 1;
    if (alreadyHandled(app, tx.id)) {
      out.skipped += 1;
      continue;
    }

    var customer = resolveCustomer(app, cfg, tx.customerId);
    if (!customer) {
      if (recordUnmatched(app, tx, sale, source, tx.customerId ? "unknown_customer" : "no_customer")) {
        out.unmatched += 1;
      } else {
        out.skipped += 1;
      }
      continue;
    }

    var pending = membershipsLib.latest(app, customer.id, "pending");
    var active = membershipsLib.latest(app, customer.id, "active");
    var plans = membershipsLib.paidPlans(app);
    var tierId = pending
      ? pending.getString("tier")
      : active
        ? active.getString("tier")
        : plans.length
          ? plans[0].id
          : "";
    if (!tierId) {
      if (recordUnmatched(app, tx, sale, source, "no_plan")) out.unmatched += 1;
      continue;
    }

    var soldAt = tx.soldAt ? new Date(tx.soldAt) : new Date();
    var months = MONTHS_PER_UNIT * sale.quantity;
    var note =
      `Epos Now sale ${tx.id}` + (sale.quantity > 1 ? `, ${sale.quantity} memberships` : "");
    var outcome = active ? "renewed" : "activated";
    var emails = [];

    try {
      app.runInTransaction(function (txApp) {
        // First, so a second caller handling the same sale fails here on
        // the unique index and rolls back before touching a membership.
        var logRow = new Record(txApp.findCollectionByNameOrId("epos_transactions"), {
          epos_id: tx.id,
          outcome: outcome,
          customer: customer.id,
          epos_customer_id: tx.customerId,
          amount: sale.amountPence,
          quantity: sale.quantity,
          sold_at: soldAt.toISOString(),
          source: source,
        });
        txApp.save(logRow);

        var membership;
        if (active) {
          membership = membershipsLib.extend(txApp, txApp.findRecordById("memberships", active.id), {
            from: soldAt,
            months: months,
            price: sale.amountPence,
            paymentNote: note,
          });
          if (pending) {
            var stale = txApp.findRecordById("memberships", pending.id);
            stale.set("status", "cancelled");
            txApp.save(stale);
          }
        } else {
          var target = pending
            ? txApp.findRecordById("memberships", pending.id)
            : new Record(txApp.findCollectionByNameOrId("memberships"), {
                customer: customer.id,
                tier: tierId,
              });
          membership = membershipsLib.activate(txApp, target, {
            startedAt: soldAt,
            months: months,
            price: sale.amountPence,
            paymentNote: note,
          });
        }
        logRow.set("membership", membership.id);
        txApp.save(logRow);

        var name = membershipsLib.tierName(txApp, membership.getString("tier")) || "GG Guild membership";
        var n = notifyLib.notify(txApp, {
          customer: customer.id,
          type: "membership_started",
          title: `Your ${name} is live`,
          body: `Your ${name} runs until ${membershipsLib.ukDate(membership.getString("renews_at"))}. The perks are in My Vault, under Guild.`,
          link: "/account/guild",
          email: true,
        });
        emails = n.pending || [];

        auditLib.writeAuditLog(txApp, {
          actor: "epos_now",
          action: active ? "membership_renew_epos" : "membership_activate_epos",
          collection: "memberships",
          record: membership.id,
          meta: {
            customer: customer.id,
            epos_transaction: tx.id,
            price: sale.amountPence,
            months: months,
            source: source,
          },
          ip: "",
        });
      });
    } catch (err) {
      // Most likely the unique index: the other path got there first.
      out.skipped += 1;
      continue;
    }
    notifyLib.sendPending(app, emails);
    if (outcome === "renewed") out.renewed += 1;
    else out.activated += 1;
  }
  return out;
}

/** "2026-10-06T00:00:00", the zone-less UTC form Epos Now's query takes. */
function eposDayBound(date, endOfDay) {
  return date.toISOString().slice(0, 10) + (endOfDay ? "T23:59:59" : "T00:00:00");
}

/**
 * The poll: today's completed sales (UTC day, as the timestamps are read),
 * 200 a page, into `handleTransactions`. Does nothing until both the token
 * and at least one Guild product id are set.
 */
function pollToday(app, now) {
  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var cfg = config(app);
  var total = { pages: 0, seen: 0, guild: 0, activated: 0, renewed: 0, unmatched: 0, skipped: 0, error: "" };
  if (!cfg.token || !cfg.productIds.length) return total;

  var day = now || new Date();
  for (var page = 1; page <= 25; page++) {
    var res = adapter.transactionsByDate(cfg, eposDayBound(day, false), eposDayBound(day, true), page);
    if (!res.ok) {
      total.error = res.message;
      break;
    }
    total.pages += 1;
    var raw = Array.isArray(res.data) ? res.data : [];
    var result = handleTransactions(app, shared.eposTransactionsFrom(raw), "poll");
    total.seen += result.seen;
    total.guild += result.guild;
    total.activated += result.activated;
    total.renewed += result.renewed;
    total.unmatched += result.unmatched;
    total.skipped += result.skipped;
    if (raw.length < 200) break;
  }
  return total;
}

/**
 * The webhook: the ids in the payload, each read back from Epos Now with
 * our own token before anything is activated. A sale Epos Now cannot be
 * asked about right now is left for the poll, which will see it.
 */
function handleWebhook(app, payload) {
  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var cfg = config(app);
  var described = shared.eposTransactionsFrom(payload);
  if (!cfg.token || !cfg.productIds.length) {
    return { seen: 0, guild: 0, activated: 0, renewed: 0, unmatched: 0, skipped: 0, received: described.length, deferred: described.length };
  }
  var verified = [];
  var deferred = 0;
  for (var i = 0; i < described.length && i < 50; i++) {
    var res = adapter.getTransaction(cfg, described[i].id);
    var tx = res.ok ? shared.readEposTransaction(res.data) : null;
    if (tx && tx.id === described[i].id) verified.push(tx);
    else deferred += 1;
  }
  var result = handleTransactions(app, verified, "webhook");
  result.received = described.length;
  result.deferred = deferred;
  return result;
}

module.exports = {
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  NO_CUSTOMER_TITLE: NO_CUSTOMER_TITLE,
  config: config,
  privateFor: privateFor,
  customerForEposId: customerForEposId,
  linkShape: linkShape,
  queue: queue,
  link: link,
  retryQueued: retryQueued,
  handleTransactions: handleTransactions,
  pollToday: pollToday,
  handleWebhook: handleWebhook,
};
