/**
 * lib/sumup.js - PocketBase-specific glue behind sumup.pb.js's two routes
 * and crons_sumup.pb.js's hourly cron. adapters/sumup.js does the plain
 * HTTP calls; this module reads settings, upserts `sumup_transactions`,
 * matches each one to a sale, and builds the reconcile screen's data.
 * See docs/api-contract.md's "Phase 4" section for the shapes.
 *
 * Matching, in order:
 *  1. A product name prefixed with one of our own SKUs (exactly the form
 *     GET /api/vault/exports/sumup.csv writes into "Item name") - the
 *     item it names is looked up directly, then its most recent sale
 *     line's sale.
 *  2. Failing that, a `sales` row with payment `sumup_card` or `mixed`,
 *     the same total, created within three minutes of the transaction's
 *     own timestamp, that no other transaction has matched already.
 *
 * A transaction that already carries a `matched_sale` from an earlier
 * pull is left alone (its other fields still refresh from the latest
 * fetch) - this is what keeps a repeat pull from ever re-matching, and
 * hence from ever duplicating, a sale a previous pull already resolved.
 *
 * require() this from inside each handler/cron body, not at file top
 * level - see pb/README.md.
 */

var MATCH_WINDOW_MS = 3 * 60 * 1000;
var DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
var MAX_HISTORY_PAGES = 20;

/** PocketBase's own stored date shape ("2026-09-20 12:00:00.000Z") - see crons.pb.js's retention job for why a bare ISO "T" sorts wrong against it. */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

function config(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var settingsRow = util.settings(app);
  var apiKeys = settingsRow ? util.jsonField(settingsRow, "api_keys", {}) || {} : {};
  var sumupSettings = settingsRow ? util.jsonField(settingsRow, "sumup", {}) || {} : {};
  return {
    apiKey: apiKeys.sumup || "",
    merchantCode: sumupSettings.merchant_code || "",
  };
}

function latestFetchedAt(app) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("sumup_transactions", "fetched_at != ''", "-fetched_at", 1, 0);
  } catch (err) {
    rows = [];
  }
  return rows && rows.length && rows[0] ? rows[0].getString("fetched_at") : "";
}

/** The encoded SKU a SumUp product name starts with, or null when it does not start with a valid one. */
function skuFromProductName(name) {
  var sku = require(__hooks + "/lib/shared/sku.js");
  var token = String(name || "").trim().split(/\s+/)[0];
  if (!token) return null;
  var parsed = sku.parseCode(token);
  return parsed ? parsed.encoded : null;
}

/** The most recent sale line's sale for the item with this SKU, or null. */
function saleIdForSku(app, encodedSku) {
  var item = null;
  try {
    item = app.findFirstRecordByFilter("items", "sku = {:sku}", { sku: encodedSku });
  } catch (err) {
    return null;
  }
  var lines = [];
  try {
    lines = app.findRecordsByFilter("sale_lines", "item = {:item}", "-created", 1, 0, { item: item.id });
  } catch (err) {
    lines = [];
  }
  return lines && lines.length && lines[0] ? lines[0].getString("sale") : null;
}

/** A sale of this amount, paid by card, within three minutes of `timestamp`, not already matched to another transaction. */
function saleIdByAmountAndTime(app, amountPence, timestamp, alreadyMatchedIds) {
  var from = pbDate(new Date(timestamp.getTime() - MATCH_WINDOW_MS));
  var to = pbDate(new Date(timestamp.getTime() + MATCH_WINDOW_MS));
  var candidates = [];
  try {
    candidates = app.findRecordsByFilter(
      "sales",
      '(payment = "sumup_card" || payment = "mixed") && total = {:amount} && created >= {:from} && created <= {:to}',
      "created",
      0,
      0,
      { amount: amountPence, from: from, to: to }
    );
  } catch (err) {
    candidates = [];
  }
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && alreadyMatchedIds.indexOf(candidates[i].id) < 0) return candidates[i].id;
  }
  return null;
}

/** Every sale id already claimed by some sumup_transactions row, so the amount+time rule never double-books one. */
function alreadyMatchedSaleIds(app) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("sumup_transactions", "matched_sale != ''", "", 0, 0);
  } catch (err) {
    rows = [];
  }
  var ids = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) ids.push(rows[i].getString("matched_sale"));
  }
  return ids;
}

/**
 * Fetch every transaction changed since the last pull (or the last 24
 * hours, on a first run with nothing stored yet), upsert
 * `sumup_transactions` by `sumup_id`, and match each one that is not
 * matched already. Writes one audit row. A shop with no SumUp API key or
 * merchant code configured yet returns straight away with all zeroes,
 * rather than throwing - the cron runs every hour on every install,
 * configured or not.
 *
 * @returns {{fetched: number, matched: number, unmatched: number}}
 */
function pull(app, actorId, ip) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var adapter = require(__hooks + "/adapters/sumup.js");

  var cfg = config(app);
  if (!cfg.apiKey || !cfg.merchantCode) {
    return { fetched: 0, matched: 0, unmatched: 0 };
  }

  var since = latestFetchedAt(app) || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();

  var history = [];
  try {
    history = adapter.fetchHistory(cfg.merchantCode, cfg.apiKey, since, MAX_HISTORY_PAGES) || [];
  } catch (err) {
    console.log("[sumup] transactions history pull failed: " + err);
    return { fetched: 0, matched: 0, unmatched: 0 };
  }

  var fetched = 0;
  var matched = 0;
  var unmatched = 0;
  var claimedSaleIds = alreadyMatchedSaleIds(app);

  for (var i = 0; i < history.length; i++) {
    var summary = history[i];
    if (!summary || !summary.id) continue;
    fetched += 1;

    var detail = null;
    try {
      detail = adapter.fetchTransaction(cfg.merchantCode, cfg.apiKey, summary.id);
    } catch (err) {
      console.log("[sumup] detail fetch failed for " + summary.id + ": " + err);
    }

    var merged = {};
    var key;
    for (key in summary) if (Object.prototype.hasOwnProperty.call(summary, key)) merged[key] = summary[key];
    if (detail) for (key in detail) if (Object.prototype.hasOwnProperty.call(detail, key)) merged[key] = detail[key];

    var amountPence = money.parseDecimalToMinor(String(merged.amount === undefined || merged.amount === null ? "0" : merged.amount));
    if (amountPence === null) amountPence = 0;
    var timestamp = new Date(merged.timestamp || Date.now());
    var products = Array.isArray(merged.products) ? merged.products : [];

    var existing = null;
    try {
      existing = app.findFirstRecordByFilter("sumup_transactions", "sumup_id = {:id}", { id: summary.id });
    } catch (err) {
      existing = null;
    }
    var alreadyMatchedSale = existing ? existing.getString("matched_sale") : "";

    var record = existing || new Record(app.findCollectionByNameOrId("sumup_transactions"), { sumup_id: summary.id });
    record.set("transaction_code", merged.transaction_code || "");
    record.set("timestamp", isNaN(timestamp.getTime()) ? "" : timestamp.toISOString());
    record.set("amount", amountPence);
    record.set("payment_type", merged.payment_type || "");
    record.set("status", merged.status || "");
    record.set("products", products);
    record.set("fetched_at", util.nowIso());

    if (alreadyMatchedSale) {
      matched += 1;
    } else {
      var saleId = null;
      for (var p = 0; p < products.length && !saleId; p++) {
        var candidateSku = skuFromProductName(products[p] && products[p].name);
        if (candidateSku) saleId = saleIdForSku(app, candidateSku);
      }
      if (!saleId && !isNaN(timestamp.getTime())) {
        saleId = saleIdByAmountAndTime(app, amountPence, timestamp, claimedSaleIds);
      }
      if (saleId) {
        record.set("matched_sale", saleId);
        claimedSaleIds.push(saleId);
        matched += 1;
      } else {
        unmatched += 1;
      }
    }

    app.save(record);
  }

  auditLib.writeAuditLog(app, {
    actor: actorId || "system",
    action: "sumup_pull",
    collection: "sumup_transactions",
    record: "",
    meta: { since: since, fetched: fetched, matched: matched, unmatched: unmatched },
    ip: ip || "",
  });

  return { fetched: fetched, matched: matched, unmatched: unmatched };
}

/**
 * The day's SumUp transactions beside the day's card sales, for the Cash
 * screen: which transactions matched which sale, which transactions have
 * no sale (a card payment SumUp saw that never reached our own record),
 * and which card/mixed sales have no transaction (one SumUp has not
 * reported yet, or that this shop rang up outside SumUp by mistake).
 *
 * @returns {{date: string, matched: object[], unmatched_transactions: object[], unmatched_sales: object[], totals: {sumup: number, sales: number, difference: number}}}
 */
function reconcile(app, date) {
  var from = pbDate(new Date(date + "T00:00:00.000Z"));
  var to = pbDate(new Date(date + "T23:59:59.999Z"));

  var transactions = [];
  try {
    transactions = app.findRecordsByFilter(
      "sumup_transactions",
      "timestamp >= {:from} && timestamp <= {:to}",
      "timestamp",
      0,
      0,
      { from: from, to: to }
    );
  } catch (err) {
    transactions = [];
  }

  var sales = [];
  try {
    sales = app.findRecordsByFilter(
      "sales",
      '(payment = "sumup_card" || payment = "mixed") && created >= {:from} && created <= {:to}',
      "created",
      0,
      0,
      { from: from, to: to }
    );
  } catch (err) {
    sales = [];
  }
  var saleById = {};
  for (var s = 0; s < sales.length; s++) {
    if (sales[s]) saleById[sales[s].id] = sales[s];
  }

  var matched = [];
  var unmatchedTransactions = [];
  var matchedSaleIds = {};
  var sumupTotal = 0;

  for (var t = 0; t < transactions.length; t++) {
    var txn = transactions[t];
    if (!txn) continue;
    sumupTotal += txn.getInt("amount");
    var saleId = txn.getString("matched_sale");
    var sale = saleId ? saleById[saleId] : null;
    var txnRow = {
      id: txn.id,
      sumup_id: txn.getString("sumup_id"),
      transaction_code: txn.getString("transaction_code"),
      amount: txn.getInt("amount"),
      timestamp: txn.getString("timestamp"),
      status: txn.getString("status"),
    };
    if (sale) {
      matchedSaleIds[saleId] = true;
      matched.push({
        transaction: txnRow,
        sale: { id: sale.id, number: sale.getString("number"), total: sale.getInt("total") },
      });
    } else {
      unmatchedTransactions.push(txnRow);
    }
  }

  var unmatchedSales = [];
  var salesTotal = 0;
  for (var i = 0; i < sales.length; i++) {
    var sale2 = sales[i];
    if (!sale2) continue;
    salesTotal += sale2.getInt("total");
    if (!matchedSaleIds[sale2.id]) {
      unmatchedSales.push({
        id: sale2.id,
        number: sale2.getString("number"),
        total: sale2.getInt("total"),
        payment: sale2.getString("payment"),
        created: sale2.getString("created"),
      });
    }
  }

  return {
    date: date,
    matched: matched,
    unmatched_transactions: unmatchedTransactions,
    unmatched_sales: unmatchedSales,
    totals: { sumup: sumupTotal, sales: salesTotal, difference: sumupTotal - salesTotal },
  };
}

module.exports = { pull: pull, reconcile: reconcile, MATCH_WINDOW_MS: MATCH_WINDOW_MS };
