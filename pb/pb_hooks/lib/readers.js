/**
 * lib/readers.js - the logic behind sumup_readers.pb.js's Solo card
 * reader routes and the `checkouts_expire` cron. adapters/sumup.js makes
 * the plain HTTP calls; this module reads settings, writes
 * `sumup_checkouts` and decides what a reported payment actually means.
 * See docs/api-contract.md's Phase 7 section for the routes and shapes.
 *
 * Two rules run through all of it.
 *
 * **A callback is never believed on its own.** The result SumUp POSTs to
 * `return_url` only tells this app to go and look: every transition is
 * decided from `GET /v2.1/merchants/{code}/transactions?client_transaction_id=`,
 * the merchant's own record of whether money moved. The token in the
 * callback URL proves which checkout is being talked about, nothing more,
 * and only its sha256 is ever stored (`sumup_checkouts.callback_secret`),
 * so a leaked database row cannot be replayed as a callback.
 *
 * **A row in a final state never changes again.** `paid`, `failed`,
 * `cancelled` and `expired` are all terminal: the callback, the counter's
 * own poll, the cancel route and the expiry cron all go through
 * `applyOutcome` below, which re-reads the row inside its own
 * transaction and leaves anything that is no longer `pending` exactly as
 * it is. That is what makes a lost callback, a duplicated callback and a
 * poll landing at the same instant all safe.
 *
 * Money is integer GBP pence throughout. SumUp's own `amount` is a
 * decimal, parsed once through the shared money helpers
 * (`parseDecimalToMinor`) and never with `parseFloat`.
 *
 * require() this from inside each handler/cron body, not at file top
 * level - see pb/README.md.
 */

var EXPIRE_AFTER_MS = 15 * 60 * 1000;
var POLL_VERIFY_AFTER_MS = 5 * 1000;
var VERIFY_THROTTLE_MS = 10 * 1000;
var VERIFY_STAMP_KEY = "sumup_checkout_verified";
var STATUS_PENDING = "pending";
var STATUS_PAID = "paid";
var STATUS_FAILED = "failed";
var STATUS_CANCELLED = "cancelled";
var STATUS_EXPIRED = "expired";

var MESSAGES = {
  not_configured: "SumUp is not set up. Add the merchant code and API key under Settings.",
  no_reader: "No card reader is paired. Pair one under Settings.",
  bad_amount: "That amount is not a whole number of pence above zero. Check the sale total and try again.",
  no_client_id: "Send the sale's own client_id with the amount, so the payment can be matched to the sale.",
  no_app_url:
    "The application URL is not set, so the reader cannot report back. Set it in the PocketBase settings.",
  already_paid: "The customer already paid. Complete the sale.",
  unreadable_amount:
    "The reader's amount could not be read. Check the payment in the SumUp app before taking it again.",
  refunded: "That payment was refunded on the reader. Take the payment again.",
  declined: "Declined",
};

/** PocketBase's own stored date shape ("2026-09-20 12:00:00.000Z"). */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

/** The merchant key, code and default reader, read straight off the settings row. */
function config(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var settingsRow = util.settings(app);
  var apiKeys = settingsRow ? util.jsonField(settingsRow, "api_keys", {}) || {} : {};
  var sumup = settingsRow ? util.jsonField(settingsRow, "sumup", {}) || {} : {};
  return {
    apiKey: apiKeys.sumup || "",
    merchantCode: sumup.merchant_code || "",
    defaultReaderId: sumup.default_reader_id || "",
    defaultReaderName: sumup.default_reader_name || "",
  };
}

/** True when both halves of the SumUp configuration are actually set. */
function isConfigured(cfg) {
  return !!(cfg && cfg.apiKey && cfg.merchantCode);
}

/** Merge `patch` into settings.sumup and save, keeping every other key. */
function saveSumupSettings(app, patch) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var row = util.settings(app);
  if (!row) return;
  var sumup = util.jsonField(row, "sumup", {}) || {};
  for (var key in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) sumup[key] = patch[key];
  }
  row.set("sumup", sumup);
  app.save(row);
}

/**
 * The counter polls a waiting checkout every three seconds for up to
 * fifteen minutes, and the contract has the poll verify against SumUp
 * whenever the row is more than five seconds old, which would be several
 * hundred outbound calls for one unattended payment. These two keep that
 * to one call per checkout per `VERIFY_THROTTLE_MS`.
 *
 * The stamp lives in `adapter_state` rather than on the checkout row on
 * purpose: the counter subscribes to that row over realtime, so touching
 * it every three seconds would push a stream of updates that say nothing.
 * One `adapter_state` entry holds every checkout verified inside the
 * window and is pruned on each write, so it never grows.
 *
 * Only the poll throttles. A callback, a cancel and the expiry cron all
 * verify every time: each of those happens once, and each is the moment
 * the answer actually matters.
 */
function verifiedRecently(app, checkoutId, now) {
  var store = require(__hooks + "/adapters/statestore.js").forApp(app);
  var at = (now || new Date()).getTime();
  var seen = store.get(VERIFY_STAMP_KEY) || {};
  var last = Number(seen[checkoutId] || 0);
  return !!last && at - last < VERIFY_THROTTLE_MS;
}

function markVerified(app, checkoutId, now) {
  var store = require(__hooks + "/adapters/statestore.js").forApp(app);
  var at = (now || new Date()).getTime();
  var seen = store.get(VERIFY_STAMP_KEY) || {};
  var kept = {};
  for (var id in seen) {
    if (!Object.prototype.hasOwnProperty.call(seen, id)) continue;
    if (at - Number(seen[id] || 0) < VERIFY_THROTTLE_MS) kept[id] = seen[id];
  }
  kept[checkoutId] = at;
  try {
    store.set(VERIFY_STAMP_KEY, kept, "");
  } catch (err) {
    // A stamp that cannot be written only costs an extra lookup next
    // time; it must never stop a payment being verified.
    console.log("[readers] could not record the verification stamp: " + err);
  }
}

/** The sha256 of a callback token. Only ever this, never the token itself, is stored. */
function hashToken(token) {
  return $security.sha256(String(token || ""));
}

/** A fresh callback token: 64 random characters, comfortably past the 32 bytes of entropy this needs. */
function newToken() {
  return $security.randomString(64);
}

/**
 * The callback URL for a new checkout, or a refusal when this instance
 * has no usable public address to be called back on. SumUp has to reach
 * it from the internet, so a plain http:// address is refused - except on
 * 127.0.0.1 or localhost, which is a developer's own machine (and
 * pb/scripts/check.sh) rather than a shop.
 */
function returnUrlFor(app, token) {
  var base = "";
  try {
    base = app.settings().meta.appURL || "";
  } catch (err) {
    base = "";
  }
  base = String(base).replace(/\/+$/, "");
  var isHttps = /^https:\/\//i.test(base);
  var isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base);
  if (!base || (!isHttps && !isLocal)) {
    return { ok: false, status: 422, message: MESSAGES.no_app_url, url: "" };
  }
  return { ok: true, status: 200, message: "", url: base + "/api/vault/sumup/callback/" + token };
}

/** One checkout row as every route in this package returns it. Never the callback secret. */
function shape(record) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.getString("status"),
    amount: record.getInt("amount"),
    description: record.getString("description"),
    sale_client_id: record.getString("sale_client_id"),
    reader_id: record.getString("reader_id"),
    reader_name: record.getString("reader_name"),
    checkout_id: record.getString("checkout_id"),
    client_transaction_id: record.getString("client_transaction_id"),
    transaction_id: record.getString("transaction_id"),
    transaction_code: record.getString("transaction_code"),
    card_last4: record.getString("card_last4"),
    error: record.getString("error"),
    paid_at: record.getString("paid_at"),
    sale: record.getString("sale"),
    created: record.getString("created"),
  };
}

/** SumUp's own decimal amount as integer pence, or null when it cannot be read at all. */
function amountPenceOf(transaction) {
  var money = require(__hooks + "/lib/shared/money.js");
  var raw = transaction ? transaction.amount : null;
  if (raw === null || raw === undefined || raw === "") return null;
  // A decimal SumUp already sent as a string is parsed verbatim; only a
  // genuine JS number is stringified first, so a proper decimal string is
  // never round-tripped through a float (the same rule lib/sumup.js's own
  // pull follows).
  var text = typeof raw === "string" ? raw : String(raw);
  return money.parseDecimalToMinor(text);
}

/**
 * What a fetched transaction means for a `pending` checkout: the fields
 * to write and the audit row to leave, or null for "nothing has happened
 * yet, leave it pending". Pure - no reads, no writes - so the callback,
 * the poll, the cancel route and the cron cannot disagree about what
 * SUCCESSFUL, FAILED or a mismatched amount means.
 *
 * @param {object} checkoutRow - the live sumup_checkouts record
 * @param {object|null} transaction - SumUp's own transaction, or null when it knows of none
 * @param {{failureReason?: string}} [opts]
 */
function decide(checkoutRow, transaction, opts) {
  var money = require(__hooks + "/lib/shared/money.js");
  var options = opts || {};
  if (!transaction) return null;

  // Defence in depth behind the adapter's own check: a transaction that
  // names a different payment says nothing about this checkout, whatever
  // it says about itself.
  var reference = String(transaction.client_transaction_id || "");
  var expectedReference = checkoutRow.getString("client_transaction_id");
  if (reference && expectedReference && reference !== expectedReference) {
    console.log("[readers] ignoring a transaction for another payment on checkout " + checkoutRow.id);
    return null;
  }

  var status = String(transaction.status || "").toUpperCase();
  var expected = checkoutRow.getInt("amount");

  if (status === "SUCCESSFUL") {
    // Pence against pence, in one currency. Everything else in this build
    // converts a foreign amount and labels it rather than comparing it
    // with a GBP figure (CLAUDE.md, "Money"), and a reader taking euros
    // for a sterling basket is a payment to look at in the SumUp app, not
    // one to complete a sale against.
    var currency = String(transaction.currency || "GBP").toUpperCase();
    if (currency !== "GBP") {
      return {
        status: STATUS_FAILED,
        fields: {
          error:
            "The reader took " +
            currency +
            ", not pounds. Check the payment in the SumUp app before taking it again.",
          transaction_id: String(transaction.id || ""),
          transaction_code: String(transaction.transaction_code || ""),
        },
        audit: "sumup_checkout_amount_mismatch",
        auditMeta: { expected: expected, currency: currency },
      };
    }
    var pence = amountPenceOf(transaction);
    if (pence === null) {
      return {
        status: STATUS_FAILED,
        fields: { error: MESSAGES.unreadable_amount },
        audit: "sumup_checkout_amount_unreadable",
      };
    }
    if (pence !== expected) {
      return {
        status: STATUS_FAILED,
        fields: {
          error:
            "The reader took a different amount (" +
            money.formatGBP(pence) +
            "). Refund it from the SumUp app and take the payment again.",
          transaction_id: String(transaction.id || ""),
          transaction_code: String(transaction.transaction_code || ""),
        },
        audit: "sumup_checkout_amount_mismatch",
        auditMeta: { expected: expected, taken: pence },
      };
    }
    var card = transaction.card || {};
    return {
      status: STATUS_PAID,
      fields: {
        transaction_id: String(transaction.id || ""),
        transaction_code: String(transaction.transaction_code || ""),
        card_last4: String(card.last_4_digits || "").slice(-4),
        paid_at: new Date().toISOString(),
        error: "",
      },
      audit: "sumup_checkout_paid",
      auditMeta: { amount: pence, transaction_code: String(transaction.transaction_code || "") },
    };
  }

  if (status === "FAILED" || status === "CANCELLED") {
    return {
      status: STATUS_FAILED,
      fields: { error: String(options.failureReason || "").slice(0, 300) || MESSAGES.declined },
      audit: "sumup_checkout_failed",
    };
  }

  if (status === "REFUNDED") {
    // Money arrived and went back out again, so this is not a payment
    // this sale can be completed against.
    return { status: STATUS_FAILED, fields: { error: MESSAGES.refunded }, audit: "sumup_checkout_failed" };
  }

  // PENDING, or a status this build has never seen: nothing has happened
  // yet, so the row stays open for the next poll, callback or the cron.
  return null;
}

/**
 * Record, once, that SumUp reports a payment for a checkout this app had
 * already closed. Never changes the row: `cancelled` and `expired` are
 * final, and re-opening one would contradict whatever the counter was
 * told at the time.
 */
function notePaymentAfterClose(app, checkoutRow, outcome, opts) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var options = opts || {};
  var meta = outcome.auditMeta || {};
  try {
    var seen = app.findRecordsByFilter(
      "audit_log",
      'action = "sumup_checkout_late_payment" && record = {:record}',
      "",
      1,
      0,
      { record: checkoutRow.id }
    );
    if (seen && seen.length) return;
  } catch (err) {
    // Fall through: one extra audit row is better than none at all.
  }
  console.log(
    "[readers] checkout " + checkoutRow.id + " is " + checkoutRow.getString("status") + " and SumUp reports it paid"
  );
  try {
    auditLib.writeAuditLog(app, {
      actor: options.actor || "system",
      action: "sumup_checkout_late_payment",
      collection: "sumup_checkouts",
      record: checkoutRow.id,
      meta: {
        checkout: checkoutRow.id,
        status: checkoutRow.getString("status"),
        amount: meta.amount === undefined ? checkoutRow.getInt("amount") : meta.amount,
        transaction_code: meta.transaction_code || "",
        sale_client_id: checkoutRow.getString("sale_client_id"),
      },
      ip: options.ip || "",
    });
  } catch (err) {
    console.log("[readers] could not record a late payment on " + checkoutRow.id + ": " + err);
  }
}

/**
 * Apply an outcome to one checkout, inside its own transaction, and only
 * while it is still `pending`. Returns the row's live status either way,
 * so a caller can tell "this is what I wrote" from "somebody got there
 * first".
 *
 * @returns {{changed: boolean, status: string, record: object}}
 */
function applyOutcome(app, checkoutId, outcome, opts) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var options = opts || {};
  var result = { changed: false, status: "", record: null };

  app.runInTransaction(function (txApp) {
    var live = txApp.findRecordById("sumup_checkouts", checkoutId);
    result.record = live;
    result.status = live.getString("status");
    if (result.status !== STATUS_PENDING || !outcome) return;

    live.set("status", outcome.status);
    var fields = outcome.fields || {};
    for (var key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) live.set(key, fields[key]);
    }
    txApp.save(live);
    result.status = outcome.status;
    result.changed = true;

    if (outcome.audit) {
      var meta = { checkout: live.id, sale_client_id: live.getString("sale_client_id") };
      var extra = outcome.auditMeta || {};
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) meta[k] = extra[k];
      }
      if (options.source) meta.source = options.source;
      auditLib.writeAuditLog(txApp, {
        actor: options.actor || "system",
        action: outcome.audit,
        collection: "sumup_checkouts",
        record: live.id,
        meta: meta,
        ip: options.ip || "",
      });
    }
  });

  return result;
}

/**
 * Ask SumUp what happened to one checkout and apply the answer: the
 * transactions lookup first, then (only when that knows of no such
 * transaction yet, and only when asked) the reader's own checkout status.
 *
 * The reader's status can move a checkout to `failed`, never to `paid`:
 * it carries no amount and no transaction code, so believing it would
 * mean marking a sale paid without ever having seen what the merchant
 * account actually took.
 *
 * @returns {{changed: boolean, status: string, record: object|null, reached: boolean}}
 */
function verify(app, checkoutRow, opts) {
  var adapter = require(__hooks + "/adapters/sumup.js");
  var options = opts || {};
  var cfg = options.config || config(app);
  var out = { changed: false, status: checkoutRow.getString("status"), record: checkoutRow };
  if (!isConfigured(cfg)) return out;

  var transaction = null;
  var clientTransactionId = checkoutRow.getString("client_transaction_id");
  if (clientTransactionId) {
    try {
      var res = adapter.findTransactionByClientId(cfg.merchantCode, cfg.apiKey, clientTransactionId);
      transaction = res.ok ? res.data : null;
    } catch (err) {
      console.log("[readers] transaction lookup failed for checkout " + checkoutRow.id + ": " + err);
    }
  }

  if (!transaction && options.readerStatusFallback) {
    var checkoutId = checkoutRow.getString("checkout_id");
    var readerId = checkoutRow.getString("reader_id");
    if (checkoutId && readerId) {
      try {
        var statusRes = adapter.getReaderCheckout(cfg.merchantCode, cfg.apiKey, readerId, checkoutId);
        var reported = statusRes.ok && statusRes.data ? String(statusRes.data.status || "").toUpperCase() : "";
        if (reported === "FAILED" || reported === "CANCELLED") {
          transaction = { status: reported };
        }
      } catch (err) {
        console.log("[readers] reader checkout status failed for checkout " + checkoutRow.id + ": " + err);
      }
    }
  }

  markVerified(app, checkoutRow.id);

  var outcome = decide(checkoutRow, transaction, { failureReason: options.failureReason });
  if (!outcome) return out;

  // A payment that lands after the row was closed: the row stays closed,
  // because a final state is final and something else may already have
  // been told this sale was not paid for, but the money is real and
  // somebody has to know. One audit row per checkout says so, and the
  // hourly pull will show the transaction on the Cash screen with no
  // sale against it.
  if (out.status !== STATUS_PENDING && outcome.status === STATUS_PAID) {
    notePaymentAfterClose(app, checkoutRow, outcome, options);
    return out;
  }

  var applied = applyOutcome(app, checkoutRow.id, outcome, options);
  out.changed = applied.changed;
  out.status = applied.status;
  out.record = applied.record || checkoutRow;
  return out;
}

/**
 * The checkout this sale already has, if any: one still open on the
 * reader, or one already paid that no sale has used yet. Both mean "the
 * money for this basket is already being taken, or has been", so neither
 * is a reason to put a second amount on the reader.
 */
function openForClientId(app, saleClientId) {
  try {
    return app.findFirstRecordByFilter(
      "sumup_checkouts",
      'sale_client_id = {:clientId} && (status = "pending" || (status = "paid" && sale = ""))',
      { clientId: saleClientId }
    );
  } catch (err) {
    return null;
  }
}

/**
 * Take whatever is on a reader off it again, best effort. Used on every
 * path where this app has put an amount on the reader and then could not
 * record it: a reader left showing an amount nothing is tracking is the
 * one outcome worth spending a call to avoid.
 */
function stopReader(cfg, readerId, why) {
  if (!isConfigured(cfg) || !readerId) return;
  var adapter = require(__hooks + "/adapters/sumup.js");
  try {
    adapter.terminateReaderCheckout(cfg.merchantCode, cfg.apiKey, readerId);
  } catch (err) {
    console.log("[readers] could not stop " + readerId + " after " + why + ": " + err);
  }
}

/** The checkout a callback token names, or null. The token itself is never stored or logged. */
function findByToken(app, token) {
  if (!token) return null;
  try {
    return app.findFirstRecordByFilter("sumup_checkouts", "callback_secret = {:secret}", {
      secret: hashToken(token),
    });
  } catch (err) {
    return null;
  }
}

/** A reader's own name off the live list, or "" when it cannot be read right now. */
function readerNameFor(app, cfg, readerId) {
  if (!readerId) return "";
  if (readerId === cfg.defaultReaderId) return cfg.defaultReaderName;
  var adapter = require(__hooks + "/adapters/sumup.js");
  try {
    var res = adapter.listReaders(cfg.merchantCode, cfg.apiKey);
    if (!res.ok) return "";
    for (var i = 0; i < res.data.length; i++) {
      if (res.data[i].id === readerId) return res.data[i].name;
    }
  } catch (err) {
    return "";
  }
  return "";
}

/**
 * Put an amount on a reader and record it. Refusals come back as
 * `{ok:false,status,message}` rather than thrown, so the route can raise
 * each one with its own status code and this module stays testable.
 *
 * Idempotent per `sale_client_id`: a till that asks twice for the same
 * sale (a retry, a double tap, the offline queue replaying) gets the
 * checkout that is already on the reader rather than a second amount
 * appearing on it.
 *
 * @returns {{ok:boolean, status:number, message:string, record?:object, reused?:boolean}}
 */
function createCheckout(app, opts) {
  var adapter = require(__hooks + "/adapters/sumup.js");
  var options = opts || {};

  var cfg = config(app);
  if (!isConfigured(cfg)) return { ok: false, status: 422, message: MESSAGES.not_configured };

  var amount = options.amount;
  if (typeof amount !== "number" || !isFinite(amount) || Math.floor(amount) !== amount || amount <= 0) {
    return { ok: false, status: 400, message: MESSAGES.bad_amount };
  }

  var saleClientId = String(options.saleClientId || "");
  if (!saleClientId) return { ok: false, status: 400, message: MESSAGES.no_client_id };
  if (saleClientId.length > 64) {
    return { ok: false, status: 400, message: "That client_id is too long. Keep it to 64 characters or fewer." };
  }

  // Idempotent per sale: a checkout still open on the reader, or one
  // already paid that no sale has used yet, is handed back rather than a
  // second amount going on the reader for the same basket.
  var existing = openForClientId(app, saleClientId);
  if (existing) return { ok: true, status: 200, message: "", record: existing, reused: true };

  var readerId = String(options.readerId || cfg.defaultReaderId || "");
  if (!readerId) return { ok: false, status: 422, message: MESSAGES.no_reader };

  var token = newToken();
  var callback = returnUrlFor(app, token);
  if (!callback.ok) return { ok: false, status: callback.status, message: callback.message };

  var description = String(options.description || saleClientId).slice(0, 100);

  var created;
  try {
    created = adapter.createReaderCheckout(cfg.merchantCode, cfg.apiKey, readerId, {
      amountPence: amount,
      description: description,
      returnUrl: callback.url,
    });
  } catch (err) {
    console.log("[readers] checkout create failed: " + err);
    return { ok: false, status: 502, message: adapter.READER_MESSAGES.unavailable };
  }
  if (!created.ok) return { ok: false, status: created.status, message: created.message };

  // From here on an amount is live on the reader, so every way out of
  // this function either records it or takes it off the screen again.
  if (!created.data.client_transaction_id) {
    // Without SumUp's own reference there is nothing to verify the
    // payment by later: the callback, the poll and the expiry cron all
    // look the transaction up by it, so a row written now could only ever
    // expire while the customer had been charged.
    stopReader(cfg, readerId, "a checkout with no client_transaction_id");
    return {
      ok: false,
      status: 502,
      message:
        "SumUp did not give that payment a reference, so it could not be tracked. Check the reader, and the SumUp app, before taking it again.",
    };
  }

  var readerName = readerNameFor(app, cfg, readerId);
  var record = null;
  try {
    app.runInTransaction(function (txApp) {
      // Re-checked inside the transaction, against the partial unique
      // index on (sale_client_id) where status is pending: two tills
      // asking for the same basket at the same moment cannot both write
      // a row, and the one that loses gives its amount back below.
      var live = openForClientId(txApp, saleClientId);
      if (live) {
        record = live;
        return;
      }
      record = new Record(txApp.findCollectionByNameOrId("sumup_checkouts"), {
        staff: options.staffId || "",
        sale_client_id: saleClientId,
        amount: amount,
        description: description,
        reader_id: readerId,
        reader_name: readerName,
        checkout_id: created.data.checkout_id,
        client_transaction_id: created.data.client_transaction_id,
        status: STATUS_PENDING,
        callback_secret: hashToken(token),
      });
      txApp.save(record);
    });
  } catch (err) {
    console.log("[readers] could not record the checkout on " + readerId + ": " + err);
    // The unique index is the likely cause, so look for the row that won
    // before giving up: either way the amount this call put on the reader
    // comes off it, rather than a 500 leaving money live on the Solo.
    stopReader(cfg, readerId, "a checkout that could not be recorded");
    var winner = openForClientId(app, saleClientId);
    if (winner) return { ok: true, status: 200, message: "", record: winner, reused: true };
    return {
      ok: false,
      status: 500,
      message: "That payment could not be recorded, so it was stopped at the reader. Try again.",
    };
  }

  if (record && record.getString("client_transaction_id") !== created.data.client_transaction_id) {
    // Another till's row won the race inside the transaction above; this
    // call's own amount is taken off the reader and the winner returned.
    stopReader(cfg, readerId, "a duplicate checkout for the same sale");
    return { ok: true, status: 200, message: "", record: record, reused: true };
  }

  return { ok: true, status: 201, message: "", record: record, reused: false };
}

/**
 * True when this checkout is still the one the reader is showing, so
 * stopping the reader stops this payment and nobody else's.
 *
 * Two things are asked, cheapest first: whether a newer `pending`
 * checkout has been started on the same reader since (in which case that
 * one owns the screen now), and, failing that, whether SumUp still
 * reports this checkout as unfinished. A reader that cannot be reached at
 * all is treated as still showing this payment, since the first check has
 * already ruled out the case where somebody else's is on it.
 */
function isReadersLiveCheckout(app, cfg, checkoutRow) {
  var readerId = checkoutRow.getString("reader_id");
  if (!readerId) return false;

  var newer = [];
  try {
    newer = app.findRecordsByFilter(
      "sumup_checkouts",
      'reader_id = {:reader} && status = "pending" && created > {:created} && id != {:id}',
      "created",
      1,
      0,
      { reader: readerId, created: checkoutRow.getString("created"), id: checkoutRow.id }
    );
  } catch (err) {
    newer = [];
  }
  if (newer && newer.length) return false;

  var checkoutId = checkoutRow.getString("checkout_id");
  if (!checkoutId) return true;
  var adapter = require(__hooks + "/adapters/sumup.js");
  try {
    var res = adapter.getReaderCheckout(cfg.merchantCode, cfg.apiKey, readerId, checkoutId);
    if (!res.ok || !res.data) return true;
    var status = String(res.data.status || "").toUpperCase();
    return status !== "SUCCESSFUL" && status !== "FAILED" && status !== "CANCELLED";
  } catch (err) {
    return true;
  }
}

/**
 * Stop a pending checkout at the reader and close the row. A payment the
 * reader took in the meantime wins: the row becomes `paid` and the caller
 * is told to complete the sale rather than the customer being charged and
 * the record saying otherwise.
 *
 * @returns {{ok:boolean, status:number, message:string, record:object}}
 */
function cancel(app, checkoutRow, opts) {
  var adapter = require(__hooks + "/adapters/sumup.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var options = opts || {};
  var cfg = config(app);

  var status = checkoutRow.getString("status");
  if (status === STATUS_CANCELLED) {
    return { ok: true, status: 200, message: "", record: checkoutRow };
  }
  if (status === STATUS_PAID) {
    return { ok: false, status: 409, message: MESSAGES.already_paid, record: checkoutRow };
  }
  if (status !== STATUS_PENDING) {
    return {
      ok: false,
      status: 409,
      message: "That card payment has already " + status + ". Start a new one.",
      record: checkoutRow,
    };
  }

  // Terminate is reader-scoped at SumUp, not checkout-scoped, so it stops
  // whatever that reader is showing right now. Stopping a payment that is
  // no longer this one would kill somebody else's live sale, so this only
  // reaches for the reader when this row is still the one on it.
  if (isConfigured(cfg) && isReadersLiveCheckout(app, cfg, checkoutRow)) {
    stopReader(cfg, checkoutRow.getString("reader_id"), "a cancel of checkout " + checkoutRow.id);
  }

  var checked = verify(app, checkoutRow, { config: cfg, actor: options.actor, ip: options.ip, source: "cancel" });
  if (checked.status === STATUS_PAID) {
    return { ok: false, status: 409, message: MESSAGES.already_paid, record: checked.record };
  }
  if (checked.status !== STATUS_PENDING) {
    return { ok: true, status: 200, message: "", record: checked.record };
  }

  var out = null;
  app.runInTransaction(function (txApp) {
    var live = txApp.findRecordById("sumup_checkouts", checkoutRow.id);
    if (live.getString("status") !== STATUS_PENDING) {
      out = live;
      return;
    }
    live.set("status", STATUS_CANCELLED);
    txApp.save(live);
    auditLib.writeAuditLog(txApp, {
      actor: options.actor || "system",
      action: "sumup_checkout_cancelled",
      collection: "sumup_checkouts",
      record: live.id,
      meta: { checkout: live.id, amount: live.getInt("amount"), sale_client_id: live.getString("sale_client_id") },
      ip: options.ip || "",
    });
    out = live;
  });

  // A callback or a poll that landed between the verification above and
  // the transaction wins: the money is real, so the cancel is refused
  // with the row that says so, exactly as the contract promises.
  if (out && out.getString("status") === STATUS_PAID) {
    return { ok: false, status: 409, message: MESSAGES.already_paid, record: out };
  }

  return { ok: true, status: 200, message: "", record: out || checkoutRow };
}

/**
 * The `checkouts_expire` cron's own work: every `pending` checkout older
 * than fifteen minutes is asked about once more and then closed. One that
 * turns out to have been paid is marked paid rather than expired, so a
 * callback lost on the way here never costs the shop the payment.
 * Idempotent: a second run finds nothing left pending.
 *
 * @returns {{checked: number, expired: number, paid: number}}
 */
function expirePending(app, now) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var at = now || new Date();
  var cutoff = pbDate(new Date(at.getTime() - EXPIRE_AFTER_MS));
  var cfg = config(app);

  var rows = [];
  try {
    rows = app.findRecordsByFilter("sumup_checkouts", 'status = "pending" && created < {:cutoff}', "created", 0, 0, {
      cutoff: cutoff,
    });
  } catch (err) {
    rows = [];
  }

  var checked = 0;
  var expired = 0;
  var paid = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    checked += 1;
    try {
      var outcome = verify(app, row, { config: cfg, actor: "system", source: "expiry" });
      if (outcome.status === STATUS_PAID) {
        paid += 1;
        continue;
      }
      if (outcome.status !== STATUS_PENDING) continue;

      app.runInTransaction(function (txApp) {
        var live = txApp.findRecordById("sumup_checkouts", row.id);
        if (live.getString("status") !== STATUS_PENDING) return;
        live.set("status", STATUS_EXPIRED);
        live.set("error", "The reader did not report a payment within 15 minutes.");
        txApp.save(live);
        auditLib.writeAuditLog(txApp, {
          actor: "system",
          action: "sumup_checkout_expired",
          collection: "sumup_checkouts",
          record: live.id,
          meta: { checkout: live.id, amount: live.getInt("amount"), sale_client_id: live.getString("sale_client_id") },
          ip: "",
        });
        expired += 1;
      });
    } catch (err) {
      console.log("[readers] could not close checkout " + row.id + ": " + err);
    }
  }

  return { checked: checked, expired: expired, paid: paid };
}

/**
 * The refusal a sale gets for a card payment that cannot pay for it, or
 * null when the checkout is good for exactly this card amount. Read
 * before the sale's transaction opens and again inside it
 * (sales.pb.js), so two tills cannot spend one payment twice.
 *
 * @returns {{status:number, message:string}|null}
 */
function saleRefusal(app, checkoutRow, cardPence) {
  var money = require(__hooks + "/lib/shared/money.js");
  if (!checkoutRow) {
    return { status: 422, message: "That card payment was not found. Take the payment on the reader again." };
  }
  var status = checkoutRow.getString("status");
  if (status !== STATUS_PAID) {
    return {
      status: 422,
      message: "That card payment is " + status + ", not paid. Take the payment on the reader before completing the sale.",
    };
  }
  // Both directions of the link are checked, and the sale is named when
  // it can be: "already used" is a message staff have to act on, and the
  // sale number is what they need to look it up with.
  var claimed = null;
  var claimedId = checkoutRow.getString("sale");
  if (claimedId) {
    try {
      claimed = app.findRecordById("sales", claimedId);
    } catch (err) {
      claimed = null;
    }
  }
  if (!claimed) {
    try {
      claimed = app.findFirstRecordByFilter("sales", "sumup_checkout = {:checkout}", { checkout: checkoutRow.id });
    } catch (err) {
      claimed = null;
    }
  }
  if (claimed) {
    return {
      status: 409,
      message: "That card payment has already been used on sale " + claimed.getString("number") + ".",
    };
  }
  if (claimedId) {
    return { status: 409, message: "That card payment has already been used on another sale." };
  }
  var amount = checkoutRow.getInt("amount");
  if (amount !== cardPence) {
    return {
      status: 422,
      message:
        "The reader took " +
        money.formatGBP(amount) +
        " but the card part of this sale is " +
        money.formatGBP(cardPence) +
        ". Adjust the split or refund the difference from the SumUp app.",
    };
  }
  return null;
}

module.exports = {
  MESSAGES: MESSAGES,
  EXPIRE_AFTER_MS: EXPIRE_AFTER_MS,
  POLL_VERIFY_AFTER_MS: POLL_VERIFY_AFTER_MS,
  VERIFY_THROTTLE_MS: VERIFY_THROTTLE_MS,
  verifiedRecently: verifiedRecently,
  markVerified: markVerified,
  openForClientId: openForClientId,
  isReadersLiveCheckout: isReadersLiveCheckout,
  stopReader: stopReader,
  pbDate: pbDate,
  config: config,
  isConfigured: isConfigured,
  saveSumupSettings: saveSumupSettings,
  hashToken: hashToken,
  newToken: newToken,
  returnUrlFor: returnUrlFor,
  shape: shape,
  amountPenceOf: amountPenceOf,
  decide: decide,
  applyOutcome: applyOutcome,
  verify: verify,
  findByToken: findByToken,
  createCheckout: createCheckout,
  cancel: cancel,
  expirePending: expirePending,
  saleRefusal: saleRefusal,
};
