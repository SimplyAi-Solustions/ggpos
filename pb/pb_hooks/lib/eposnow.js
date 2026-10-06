/**
 * Epos Now, GG Vault's side: the customer link and the Guild activation.
 *
 * The link. A GG Vault customer gets an Epos Now customer whose card number
 * is their bare GGC code, so the Code 128 barcode on My Vault attaches them
 * at the till. `customer_private.epos_customer_id` holds the Epos Now id
 * (staff-only, and unique when set). Linking is retry-safe twice over:
 * before creating anybody it looks for an Epos Now customer with the same
 * email address and card number (one an earlier try created and lost the
 * answer to), and before calling Epos Now at all it marks the link
 * `in_progress` with a time, inside a transaction, so a second attempt for
 * the same customer backs off rather than creating a second Epos Now
 * customer. It never blocks the person waiting: a failure leaves the row
 * `queued` with the reason, and the `epos_link_retry` cron clears a stale
 * `in_progress` mark and tries again every five minutes, up to
 * `MAX_ATTEMPTS`, then marks it `failed` and tells the admins once. An
 * erased customer is never linked. Every attempt is in the audit trail.
 *
 * The activation. A completed Epos Now sale of one of the products in
 * `settings.eposnow.guild_products` (`{ product id: tier id }`) to a
 * customer starts that product's tier for 12 months per unit from the
 * sale's own time, at the price the till charged, with the Epos Now
 * transaction id in the payment note. Only a plain sale ever does that.
 * A sale from before `settings.eposnow.active_from` or more than 48 hours
 * old, a refund, an unpriced line, two plans in one sale, more than two
 * units, a price below the tier's, an unknown or erased customer, or a
 * live membership on a different tier is recorded once in
 * `epos_transactions` and goes to the admins as a notification instead.
 * A till sale for a membership that staff already recorded by hand in the
 * last seven days is linked to it (`linked_manual`) rather than adding a
 * second term. Each `epos_transactions` row is written in the same
 * transaction as the membership change, keyed uniquely by the Epos Now id,
 * so the webhook and the poll arriving together can never act on one sale
 * twice.
 *
 * Outbound calls are made outside any database transaction (adapters/
 * eposnow.js has its own short timeout), and the writes they lead to are
 * made afterwards. require() this inside each handler - see pb/README.md.
 */

var MAX_ATTEMPTS = 12;
var MONTHS_PER_UNIT = 12;
/** A sale older than this is never acted on, whatever delivers it. */
var STALE_HOURS = 48;
/** How far back each poll looks. Inside STALE_HOURS on purpose. */
var POLL_HOURS = 36;
/** A hand-recorded payment this recent absorbs a matching till sale. */
var HAND_LINK_DAYS = 7;
/** A link attempt marked in progress for longer than this is abandoned. */
var IN_PROGRESS_MINUTES = 10;
var NO_CUSTOMER_TITLE = "Guild membership sold without a linked customer, link it in The Counter";
var REFUND_TITLE = "Guild membership refunded at the till, check the member in The Counter";
var CHECK_TITLE = "Guild membership sale needs checking in The Counter";

/** PocketBase's stored date shape. */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

function toDate(value) {
  if (!value) return null;
  var d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/** The token, the webhook credentials, the product map, the location and the start. */
function config(app) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var row = util.settings(app);
  var keys = row ? util.jsonField(row, "api_keys", {}) || {} : {};
  var epos = row ? util.jsonField(row, "eposnow", {}) || {} : {};
  return {
    token: keys.eposnow || "",
    webhookKey: keys.eposnow_webhook_key || "",
    webhookSecret: keys.eposnow_webhook_secret || "",
    productTiers: shared.normaliseProductTiers(epos.guild_products),
    locationId: Number(epos.location_id) > 0 ? Number(epos.location_id) : null,
    activeFrom: toDate(epos.active_from),
  };
}

function hasProducts(cfg) {
  return Object.keys(cfg.productTiers).length > 0;
}

/**
 * True when an `Authorization` header carries the Basic credentials set for
 * the webhook in Epos Now Back Office (the key and secret in its advanced
 * settings), compared in constant time. False when none are configured.
 */
function webhookAuthorised(cfg, header) {
  if (!cfg.webhookKey || !cfg.webhookSecret) return false;
  var base64 = require(`${__hooks}/lib/base64.js`);
  var text = cfg.webhookKey + ":" + cfg.webhookSecret;
  var bytes = [];
  for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  var expected = "Basic " + base64.encode(bytes);
  var given = String(header || "").trim();
  if (given.length !== expected.length) return false;
  return $security.equal(given, expected);
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

/** Mark a customer as waiting for a link, unless they already have one or were erased. */
function queue(app, customerId) {
  var priv = privateFor(app, customerId);
  if (!priv || priv.getString("epos_customer_id") || priv.getString("erased_at")) return priv;
  var status = priv.getString("epos_sync_status");
  if (status !== "queued" && status !== "in_progress") {
    priv.set("epos_sync_status", "queued");
    priv.set("epos_sync_attempts", 0);
    priv.set("epos_sync_error", "");
    app.save(priv);
  }
  return priv;
}

/**
 * Claim the right to call Epos Now for this customer. Inside a transaction,
 * which PocketBase runs one at a time, so two callers can never both see
 * the link free. Answers "claimed", "linked", "busy" or "erased".
 */
function claim(app, customerId) {
  var verdict = "busy";
  app.runInTransaction(function (txApp) {
    var priv = privateFor(txApp, customerId);
    if (!priv) {
      verdict = "busy";
      return;
    }
    if (priv.getString("erased_at")) {
      verdict = "erased";
      return;
    }
    if (priv.getString("epos_customer_id")) {
      verdict = "linked";
      return;
    }
    var started = toDate(priv.getString("epos_sync_started_at"));
    var fresh = started && Date.now() - started.getTime() < IN_PROGRESS_MINUTES * 60000;
    if (priv.getString("epos_sync_status") === "in_progress" && fresh) {
      verdict = "busy";
      return;
    }
    priv.set("epos_sync_status", "in_progress");
    priv.set("epos_sync_started_at", new Date().toISOString());
    txApp.save(priv);
    verdict = "claimed";
  });
  return verdict;
}

/**
 * Create (or find) the Epos Now customer for `customerId` and record the
 * link. Never throws. Answers `{ status, epos_customer_id, message }`
 * where status is "linked", "queued", "in_progress" or "failed".
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
  if (priv.getString("erased_at")) {
    return { status: "failed", epos_customer_id: "", message: "That customer was erased, so they are never added to the till." };
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

  var verdict = claim(app, customerId);
  if (verdict === "linked") {
    var linkedPriv = privateFor(app, customerId);
    return { status: "linked", epos_customer_id: linkedPriv.getString("epos_customer_id"), message: "" };
  }
  if (verdict === "erased") {
    return { status: "failed", epos_customer_id: "", message: "That customer was erased, so they are never added to the till." };
  }
  if (verdict !== "claimed") {
    return {
      status: "in_progress",
      epos_customer_id: "",
      message: "Another attempt to add this customer to Epos Now is already running. Check again in a minute.",
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
      live.set("epos_sync_started_at", "");
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
  live.set("epos_sync_started_at", "");
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

/**
 * The cron: an `in_progress` mark older than `IN_PROGRESS_MINUTES` (a
 * request that died part way) goes back to `queued`, then every queued
 * link is tried, oldest first, a batch at a time.
 */
function retryQueued(app, limit) {
  var out = { tried: 0, linked: 0, unstuck: 0 };
  var stuck = [];
  try {
    stuck = app.findRecordsByFilter(
      "customer_private",
      'epos_sync_status = "in_progress" && epos_sync_started_at < {:cutoff}',
      "",
      0,
      0,
      { cutoff: pbDate(new Date(Date.now() - IN_PROGRESS_MINUTES * 60000)) }
    );
  } catch (err) {
    stuck = [];
  }
  for (var s = 0; s < stuck.length; s++) {
    if (!stuck[s]) continue;
    stuck[s].set("epos_sync_status", "queued");
    stuck[s].set("epos_sync_started_at", "");
    app.save(stuck[s]);
    out.unstuck += 1;
  }

  var cfg = config(app);
  if (!cfg.token) return out;
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "customer_private",
      'epos_sync_status = "queued" && epos_customer_id = "" && erased_at = ""',
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
 * Who an Epos Now sale belongs to. The GGC card number on the Epos Now
 * customer is authoritative: the GG Vault customer who owns that code is
 * the one, even when a different Epos Now id was linked to them (a second
 * Epos Now customer made by hand), and the link is moved to this id and
 * audited. Without a GGC card number, the customer linked to the id. An
 * erased customer is never matched. Answers `{ customer }`, or
 * `{ outcome }` (`no_customer`, `unknown_customer`, `erased_customer`), or
 * `{ defer: true }` when Epos Now could not be asked just now.
 */
function resolveCustomer(app, cfg, eposCustomerId) {
  if (!eposCustomerId) return { outcome: "no_customer" };
  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var sku = require(`${__hooks}/lib/shared/sku.js`);
  var auditLib = require(`${__hooks}/lib/audit.js`);

  var fetched = adapter.getCustomer(cfg, eposCustomerId);
  if (!fetched.ok && (fetched.status === 0 || fetched.status >= 500 || fetched.status === 401 || fetched.status === 429)) {
    return { defer: true };
  }
  var parsed = fetched.ok ? sku.parseCode(shared.eposCardNumberOf(fetched.data)) : null;

  if (parsed && parsed.kind === "customer") {
    var owner = null;
    try {
      owner = app.findFirstRecordByFilter("customers", "code = {:code}", { code: parsed.encoded });
    } catch (err) {
      owner = null;
    }
    if (owner) {
      var ownerPriv = privateFor(app, owner.id);
      if (!ownerPriv || ownerPriv.getString("erased_at")) return { outcome: "erased_customer" };
      var previous = ownerPriv.getString("epos_customer_id");
      if (previous !== String(eposCustomerId)) {
        var displaced = "";
        app.runInTransaction(function (txApp) {
          var holders = txApp.findRecordsByFilter(
            "customer_private",
            "epos_customer_id = {:id} && customer != {:owner}",
            "",
            0,
            0,
            { id: String(eposCustomerId), owner: owner.id }
          );
          for (var h = 0; h < holders.length; h++) {
            if (!holders[h]) continue;
            displaced = holders[h].getString("customer");
            holders[h].set("epos_customer_id", "");
            holders[h].set("epos_sync_status", "");
            txApp.save(holders[h]);
          }
          var live = privateFor(txApp, owner.id);
          live.set("epos_customer_id", String(eposCustomerId));
          live.set("epos_sync_status", "linked");
          live.set("epos_sync_error", "");
          live.set("epos_sync_started_at", "");
          live.set("epos_synced_at", new Date().toISOString());
          txApp.save(live);
          auditLib.writeAuditLog(txApp, {
            actor: "epos_now",
            action: previous ? "epos_customer_relink" : "epos_customer_link",
            collection: "customer_private",
            record: live.id,
            meta: {
              customer: owner.id,
              epos_customer_id: String(eposCustomerId),
              previous_epos_customer_id: previous,
              displaced_customer: displaced,
              by_card_number: true,
            },
            ip: "",
          });
        });
      }
      return { customer: owner };
    }
  }

  var linked = customerForEposId(app, eposCustomerId);
  if (!linked) return { outcome: "unknown_customer" };
  var linkedPriv = privateFor(app, linked.id);
  if (!linkedPriv || linkedPriv.getString("erased_at")) return { outcome: "erased_customer" };
  return { customer: linked };
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
 * Record a Guild sale that is not activated, and tell the admins, once per
 * sale. Returns false when another caller recorded it first.
 */
function recordFlagged(app, tx, sale, source, outcome, title, body, customerId) {
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  try {
    app.runInTransaction(function (txApp) {
      var row = new Record(txApp.findCollectionByNameOrId("epos_transactions"), {
        epos_id: tx.id,
        outcome: outcome,
        epos_customer_id: tx.customerId,
        amount: sale.amountPence,
        quantity: sale.quantity,
        sold_at: tx.soldAt || "",
        source: source,
      });
      if (customerId) row.set("customer", customerId);
      txApp.save(row);
      notifyLib.notify(txApp, {
        staffAll: true,
        type: outcome === "refunded" ? "epos_guild_refund" : "epos_guild_unlinked",
        title: title,
        body: body,
        link: "/counter/customers",
      });
    });
    return true;
  } catch (err) {
    return false;
  }
}

function emptyResult() {
  return { seen: 0, guild: 0, activated: 0, renewed: 0, linked_manual: 0, flagged: 0, unmatched: 0, deferred: 0, skipped: 0 };
}

/**
 * Handle every transaction in `txs` (already read through the shared
 * `eposTransactionsFrom`). Idempotent: a sale already in
 * `epos_transactions` is skipped, and the unique index settles a race.
 */
function handleTransactions(app, txs, source, now) {
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var membershipsLib = require(`${__hooks}/lib/memberships.js`);
  var auditLib = require(`${__hooks}/lib/audit.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  var money = require(`${__hooks}/lib/shared/money.js`);

  var cfg = config(app);
  var out = emptyResult();
  if (!hasProducts(cfg)) return out;
  var at = now || new Date();
  var staleBefore = at.getTime() - STALE_HOURS * 3600000;

  for (var i = 0; i < (txs || []).length; i++) {
    var tx = txs[i];
    if (!tx) continue;
    out.seen += 1;
    // Fails closed: anything not plainly a completed sale is ignored.
    if (!shared.isCompletedSale(tx)) continue;
    var sale = shared.guildSaleIn(tx, cfg.productTiers);
    if (!sale) continue;
    out.guild += 1;
    if (alreadyHandled(app, tx.id)) {
      out.skipped += 1;
      continue;
    }

    // --- sales nobody should act on automatically ----------------------
    var soldAt = tx.soldAt ? new Date(tx.soldAt) : null;
    var flagged = null;
    if (!soldAt || !cfg.activeFrom || soldAt.getTime() < cfg.activeFrom.getTime() || soldAt.getTime() < staleBefore) {
      flagged = {
        outcome: "stale",
        title: CHECK_TITLE,
        body: `Epos Now sale ${tx.id} sold the Guild membership ${soldAt ? "on " + membershipsLib.ukDate(soldAt.toISOString()) : "at an unknown time"}, which is too old or from before GG Vault was linked to the till, so nothing was activated. Check the member and activate them by hand if they paid.`,
      };
    } else if (sale.kind === "refund") {
      flagged = {
        outcome: "refunded",
        title: REFUND_TITLE,
        body: `Epos Now sale ${tx.id} refunded or voided a Guild membership. Nothing was changed automatically. Find the member and cancel their membership if that is right.`,
      };
    } else if (sale.kind !== "sale") {
      var why = {
        unpriced: "had a Guild line at no price or of no quantity",
        mixed: "sold more than one kind of Guild plan",
        too_many: `sold ${sale.quantity} Guild memberships at once, more than ${shared.MAX_GUILD_QUANTITY}`,
      }[sale.kind];
      flagged = {
        outcome: sale.kind,
        title: CHECK_TITLE,
        body: `Epos Now sale ${tx.id} ${why}, so nothing was activated. Check the sale and activate the right member by hand.`,
      };
    }

    var tier = null;
    if (!flagged) {
      try {
        tier = app.findRecordById("loyalty_tiers", sale.tierId);
      } catch (err) {
        tier = null;
      }
      if (!tier || !tier.getBool("paid_plan")) {
        flagged = {
          outcome: "no_plan",
          title: CHECK_TITLE,
          body: `Epos Now sale ${tx.id} sold a Guild product whose plan is not a paid-plan tier in GG Guild, so nothing was activated. Check settings.eposnow.guild_products.`,
        };
      } else if (sale.amountPence < tier.getInt("price") * sale.quantity) {
        flagged = {
          outcome: "underpaid",
          title: CHECK_TITLE,
          body: `Epos Now sale ${tx.id} took ${money.formatGBP(sale.amountPence)} for ${tier.getString("name")}, which costs ${money.formatGBP(tier.getInt("price") * sale.quantity)}, so nothing was activated. Activate it by hand if the price was agreed.`,
        };
      }
    }

    if (flagged) {
      if (recordFlagged(app, tx, sale, source, flagged.outcome, flagged.title, flagged.body, "")) out.flagged += 1;
      else out.skipped += 1;
      continue;
    }

    var resolved = resolveCustomer(app, cfg, tx.customerId);
    if (resolved.defer) {
      // Epos Now could not be asked who the customer is. Nothing is
      // recorded, so the next poll tries this sale again.
      out.deferred += 1;
      continue;
    }
    if (!resolved.customer) {
      var who = {
        no_customer: "No customer was attached at the till.",
        unknown_customer: `The till's customer ${tx.customerId} is not linked to anybody in GG Vault.`,
        erased_customer: `The till's customer ${tx.customerId} belongs to a GG Vault customer who was erased, so they were not matched. Delete them in Epos Now Back Office.`,
      }[resolved.outcome];
      if (
        recordFlagged(
          app,
          tx,
          sale,
          source,
          resolved.outcome,
          NO_CUSTOMER_TITLE,
          `Epos Now sale ${tx.id} sold the Guild membership. ${who} Find the customer and activate their membership on their record.`,
          ""
        )
      ) {
        out.unmatched += 1;
      } else {
        out.skipped += 1;
      }
      continue;
    }

    var customer = resolved.customer;
    var months = MONTHS_PER_UNIT * sale.quantity;
    var note = `Epos Now sale ${tx.id}` + (sale.quantity > 1 ? `, ${sale.quantity} memberships` : "");
    var outcome = "";
    var emails = [];

    try {
      app.runInTransaction(function (txApp) {
        // First, so a second caller handling the same sale fails here on
        // the unique index and rolls back before touching a membership.
        var logRow = new Record(txApp.findCollectionByNameOrId("epos_transactions"), {
          epos_id: tx.id,
          outcome: "activated",
          customer: customer.id,
          epos_customer_id: tx.customerId,
          amount: sale.amountPence,
          quantity: sale.quantity,
          sold_at: soldAt.toISOString(),
          source: source,
        });
        txApp.save(logRow);

        // Read here, inside the transaction, so what decides between
        // extending and activating is the state this write commits on.
        var active = membershipsLib.latest(txApp, customer.id, "active");
        var pending = membershipsLib.latest(txApp, customer.id, "pending");
        var tierName = tier.getString("name");
        var staffNote = "";
        var membership = null;

        if (active && active.getString("tier") !== tier.id) {
          outcome = "tier_mismatch";
          membership = active;
          staffNote = `Epos Now sale ${tx.id} sold ${tierName} to ${customer.getString("name")} (${customer.getString("code")}), who already has a live ${membershipsLib.tierName(txApp, active.getString("tier"))}. Nothing was changed: sort out which plan they meant on their record.`;
        } else if (active) {
          var paidAt = toDate(active.getString("paid_at"));
          var handRecent =
            active.getString("paid_via") === "hand" &&
            !active.getString("epos_transaction") &&
            paidAt &&
            soldAt.getTime() - paidAt.getTime() < HAND_LINK_DAYS * 86400000;
          if (handRecent) {
            outcome = "linked_manual";
            active.set("epos_transaction", tx.id);
            txApp.save(active);
            membership = active;
            staffNote = `Epos Now sale ${tx.id} for ${customer.getString("name")} (${customer.getString("code")}) matched the ${tierName} recorded by hand on ${membershipsLib.ukDate(active.getString("paid_at"))}. It was linked to that payment and no time was added. If they really paid twice, refund one at the till.`;
          } else {
            outcome = "renewed";
            membership = membershipsLib.extend(txApp, active, {
              from: soldAt,
              months: months,
              price: sale.amountPence,
              paymentNote: note,
              paidVia: "epos",
              eposTransaction: tx.id,
            });
            if (pending) {
              pending.set("status", "cancelled");
              txApp.save(pending);
            }
          }
        } else {
          outcome = "activated";
          if (pending && pending.getString("tier") !== tier.id) {
            staffNote = `${customer.getString("name")} (${customer.getString("code")}) asked online for ${membershipsLib.tierName(txApp, pending.getString("tier"))} but Epos Now sale ${tx.id} sold ${tierName}. ${tierName}, the one paid for, is now live.`;
          }
          var target = pending
            ? pending
            : new Record(txApp.findCollectionByNameOrId("memberships"), { customer: customer.id });
          membership = membershipsLib.activate(txApp, target, {
            tier: tier.id,
            startedAt: soldAt,
            months: months,
            price: sale.amountPence,
            paymentNote: note,
            paidVia: "epos",
            eposTransaction: tx.id,
          });
        }

        logRow.set("outcome", outcome);
        logRow.set("membership", membership.id);
        txApp.save(logRow);

        if (staffNote) {
          notifyLib.notify(txApp, {
            staffAll: true,
            type: "epos_guild_check",
            title: CHECK_TITLE,
            body: staffNote,
            link: `/counter/customers/${customer.getString("code")}`,
          });
        }

        if (outcome === "activated" || outcome === "renewed") {
          var n = notifyLib.notify(txApp, {
            customer: customer.id,
            type: "membership_started",
            title: `Your ${tierName} is live`,
            body: `Your ${tierName} runs until ${membershipsLib.ukDate(membership.getString("renews_at"))}. The perks are in My Vault, under Guild.`,
            link: "/account/guild",
            email: true,
          });
          emails = n.pending || [];
        }

        auditLib.writeAuditLog(txApp, {
          actor: "epos_now",
          action: "membership_" + outcome + "_epos",
          collection: "memberships",
          record: membership.id,
          meta: {
            customer: customer.id,
            epos_transaction: tx.id,
            price: sale.amountPence,
            months: outcome === "activated" || outcome === "renewed" ? months : 0,
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
    if (outcome === "activated") out.activated += 1;
    else if (outcome === "renewed") out.renewed += 1;
    else if (outcome === "linked_manual") out.linked_manual += 1;
    else out.flagged += 1;
  }
  return out;
}

/** "2026-10-06T14:30:00", the zone-less UTC form Epos Now's query takes. */
function eposTime(date) {
  return date.toISOString().slice(0, 19);
}

/**
 * The poll: completed sales from the last `POLL_HOURS` (never before
 * `active_from`), 200 a page, into `handleTransactions`. One list call per
 * page and no per-transaction detail calls: `extended=true` already carries
 * the items, and a sale already recorded costs nothing beyond its row in
 * the list. At one call every five minutes for fourteen hours, plus the
 * odd customer lookup for a new Guild sale, it stays far inside Epos Now's
 * request allowance. Does nothing until the token, a Guild product and
 * `active_from` are all set.
 */
function poll(app, now) {
  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var cfg = config(app);
  var total = emptyResult();
  total.pages = 0;
  total.error = "";
  if (!cfg.token || !hasProducts(cfg) || !cfg.activeFrom) return total;

  var end = now || new Date();
  var start = new Date(end.getTime() - POLL_HOURS * 3600000);
  if (cfg.activeFrom.getTime() > start.getTime()) start = cfg.activeFrom;
  if (start.getTime() >= end.getTime()) return total;

  for (var page = 1; page <= 25; page++) {
    var res = adapter.transactionsByDate(cfg, eposTime(start), eposTime(end), page);
    if (!res.ok) {
      total.error = res.message;
      break;
    }
    total.pages += 1;
    var raw = Array.isArray(res.data) ? res.data : [];
    var result = handleTransactions(app, shared.eposTransactionsFrom(raw), "poll", end);
    for (var key in result) {
      if (Object.prototype.hasOwnProperty.call(result, key)) total[key] += result[key];
    }
    if (raw.length < 200) break;
  }
  return total;
}

/**
 * The webhook: the ids in the payload, each read back from Epos Now with
 * our own token before anything is activated, unless that sale is already
 * recorded (no call at all then). A sale Epos Now cannot be asked about
 * right now is left for the poll; an id it does not know (it answers 400,
 * "Can not find transaction with ID") is dropped.
 */
function handleWebhook(app, payload, now) {
  var adapter = require(`${__hooks}/adapters/eposnow.js`);
  var shared = require(`${__hooks}/lib/shared/eposnow.js`);
  var cfg = config(app);
  var described = shared.eposTransactionsFrom(payload);
  var result = emptyResult();
  result.received = described.length;
  if (!cfg.token || !hasProducts(cfg)) {
    result.deferred = described.length;
    return result;
  }
  var verified = [];
  for (var i = 0; i < described.length && i < 50; i++) {
    if (alreadyHandled(app, described[i].id)) {
      result.skipped += 1;
      continue;
    }
    var res = adapter.getTransaction(cfg, described[i].id);
    var tx = res.ok ? shared.readEposTransaction(res.data) : null;
    if (tx && tx.id === described[i].id) verified.push(tx);
    else if (!res.ok && (res.status === 0 || res.status >= 500 || res.status === 429)) result.deferred += 1;
  }
  var handled = handleTransactions(app, verified, "webhook", now);
  for (var key in handled) {
    if (Object.prototype.hasOwnProperty.call(handled, key)) result[key] += handled[key];
  }
  return result;
}

module.exports = {
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  STALE_HOURS: STALE_HOURS,
  POLL_HOURS: POLL_HOURS,
  NO_CUSTOMER_TITLE: NO_CUSTOMER_TITLE,
  REFUND_TITLE: REFUND_TITLE,
  config: config,
  webhookAuthorised: webhookAuthorised,
  privateFor: privateFor,
  customerForEposId: customerForEposId,
  linkShape: linkShape,
  queue: queue,
  link: link,
  retryQueued: retryQueued,
  handleTransactions: handleTransactions,
  poll: poll,
  handleWebhook: handleWebhook,
};
