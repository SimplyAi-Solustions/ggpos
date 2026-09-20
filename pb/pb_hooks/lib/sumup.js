/**
 * lib/sumup.js - PocketBase-specific glue behind sumup.pb.js's two routes
 * and crons_sumup.pb.js's hourly cron. adapters/sumup.js does the plain
 * HTTP calls; this module reads settings, upserts `sumup_transactions`,
 * matches each one to a sale, and builds the reconcile screen's data.
 * See docs/api-contract.md's "Phase 4" section for the shapes.
 *
 * Matching, in order, and only for a `SUCCESSFUL` transaction that is not
 * a refund (see STATUS below):
 *  1. A product name prefixed with one of our own SKUs (exactly the form
 *     GET /api/vault/exports/sumup.csv writes into "Item name") - the
 *     item it names is looked up directly, then the sale (not already
 *     claimed by another transaction) whose line for that item is
 *     closest to the transaction's own timestamp.
 *  2. Failing that, a `sales` row with payment `sumup_card` or `mixed`,
 *     created within three minutes of the transaction's own timestamp,
 *     whose **card share** equals the transaction's amount, not already
 *     matched to another transaction. The card share is `total` for a
 *     plain `sumup_card` sale but `payment_split.sumup_card` for a
 *     `mixed` one (sales.pb.js's own payment_split shape) - a mixed
 *     sale's `total` includes cash, credit or points that never touched
 *     SumUp at all, so comparing against `total` there would never match.
 *
 * STATUS: every transaction fetched is stored, whatever its status, so
 * the row exists and is visible - but only a `SUCCESSFUL` one is ever
 * matched or counted in `matched`/`unmatched`. A refund (a negative
 * amount, or SumUp's own refund type) is its own bucket (`refunded`),
 * never attempted against the matching rules above: a refund is money
 * going back to a customer, not a sale we made. An amount that cannot be
 * parsed at all is stored with `status` overwritten to
 * `AMOUNT_UNREADABLE` (logged with the transaction's own id) rather than
 * silently treated as zero, which would otherwise risk a false amount
 * match against a genuine zero-value transaction and would corrupt
 * reconcile's totals.
 *
 * A transaction that already carries a `matched_sale` from an earlier
 * pull is left alone for matching purposes (its other fields still
 * refresh from the latest fetch, `products` excepted - see `pull()`) -
 * this is what keeps a repeat pull from ever re-matching, and hence from
 * ever duplicating, a sale a previous pull already resolved.
 *
 * The pull's own "changes_since" marker is kept in `adapter_state`
 * (adapters/statestore.js) as a genuine ISO 8601 string, not read back off
 * `sumup_transactions.fetched_at` - that field is a PocketBase "date"
 * field, whose own stored text ("2026-09-20 12:00:00.000Z", a space where
 * ISO 8601 wants "T") SumUp's API cannot parse, so every pull after the
 * first was silently sending it a value it would reject.
 *
 * require() this from inside each handler/cron body, not at file top
 * level - see pb/README.md.
 */

var MATCH_WINDOW_MS = 3 * 60 * 1000;
var DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
var MAX_HISTORY_PAGES = 20;
var MAX_DETAIL_FETCHES_PER_PULL = 100;
var SINCE_MARKER_KEY = "sumup_pull_since";
var STATUS_SUCCESSFUL = "SUCCESSFUL";
var STATUS_AMOUNT_UNREADABLE = "AMOUNT_UNREADABLE";

/** PocketBase's own stored date shape ("2026-09-20 12:00:00.000Z") - see crons.pb.js's retention job for why a bare ISO "T" sorts wrong against it. */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

/** A date-like value normalised to ISO 8601 ("T", not a space) - defence in depth around the adapter_state marker above. */
function normaliseIso(raw) {
  var s = String(raw || "").trim();
  if (!s) return "";
  return s.indexOf("T") >= 0 ? s : s.replace(" ", "T");
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

function readSinceMarker(app) {
  var store = require(__hooks + "/adapters/statestore.js").forApp(app);
  var raw = store.get(SINCE_MARKER_KEY);
  return raw ? normaliseIso(raw) : "";
}

function writeSinceMarker(app, isoString) {
  var store = require(__hooks + "/adapters/statestore.js").forApp(app);
  store.set(SINCE_MARKER_KEY, isoString, "");
}

/** The encoded SKU a SumUp product name starts with, or null when it does not start with a valid one. */
function skuFromProductName(name) {
  var sku = require(__hooks + "/lib/shared/sku.js");
  var token = String(name || "").trim().split(/\s+/)[0];
  if (!token) return null;
  var parsed = sku.parseCode(token);
  return parsed ? parsed.encoded : null;
}

/**
 * The sale, not already claimed, whose line for the item with this SKU
 * lands closest to `timestamp` - preferred over "the newest one" so a
 * card sold more than once resolves to the actual sale a given
 * transaction belongs to, not just whichever happened last.
 */
function saleIdForSku(app, encodedSku, timestamp, alreadyMatchedIds) {
  var item = null;
  try {
    item = app.findFirstRecordByFilter("items", "sku = {:sku}", { sku: encodedSku });
  } catch (err) {
    return null;
  }
  var lines = [];
  try {
    lines = app.findRecordsByFilter("sale_lines", "item = {:item}", "-created", 0, 0, { item: item.id });
  } catch (err) {
    lines = [];
  }
  var best = null;
  var bestDiffMs = Infinity;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var saleId = line.getString("sale");
    if (!saleId || alreadyMatchedIds.indexOf(saleId) >= 0) continue;
    var sale = null;
    try {
      sale = app.findRecordById("sales", saleId);
    } catch (err) {
      sale = null;
    }
    if (!sale) continue;
    var created = new Date(sale.getString("created"));
    if (isNaN(created.getTime())) continue;
    var diffMs = Math.abs(created.getTime() - timestamp.getTime());
    if (diffMs < bestDiffMs) {
      bestDiffMs = diffMs;
      best = saleId;
    }
  }
  return best;
}

/**
 * A sale's own share of a card payment: `total` for a plain `sumup_card`
 * sale, `payment_split.sumup_card` for a `mixed` one - see the file
 * banner above for why the two need different readings.
 */
function cardShareOf(app, sale) {
  var util = require(__hooks + "/lib/vaultutil.js");
  if (sale.getString("payment") === "mixed") {
    var split = util.jsonField(sale, "payment_split", {}) || {};
    return util.asInt(split.sumup_card, 0);
  }
  return sale.getInt("total");
}

/** A card/mixed sale whose card share matches `amountPence`, created within three minutes of `timestamp`, not already matched to another transaction. */
function saleIdByAmountAndTime(app, amountPence, timestamp, alreadyMatchedIds) {
  var from = pbDate(new Date(timestamp.getTime() - MATCH_WINDOW_MS));
  var to = pbDate(new Date(timestamp.getTime() + MATCH_WINDOW_MS));
  var candidates = [];
  try {
    candidates = app.findRecordsByFilter(
      "sales",
      '(payment = "sumup_card" || payment = "mixed") && created >= {:from} && created <= {:to}',
      "created",
      0,
      0,
      { from: from, to: to }
    );
  } catch (err) {
    candidates = [];
  }
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (!candidate) continue;
    if (alreadyMatchedIds.indexOf(candidate.id) >= 0) continue;
    if (cardShareOf(app, candidate) === amountPence) return candidate.id;
  }
  return null;
}

// A margin on top of MATCH_WINDOW_MS for alreadyMatchedSaleIds' own lower
// bound, below - generous enough to absorb clock skew between this app and
// SumUp's own clock without having to reload years of history on every pull.
var CLAIMED_SALE_LOOKBACK_MARGIN_MS = 60 * 60 * 1000;

/**
 * Every sale id already claimed by some sumup_transactions row, bounded to
 * transactions timestamped no earlier than `sinceIso` minus the match
 * window and a margin, so neither matching rule ever double-books one.
 * A matched transaction from long before this pull's own `since` could
 * never be a candidate for either matching rule anyway - both are
 * themselves bounded to within three minutes of the transaction under
 * consideration - so narrowing this query changes nothing about which
 * sale a transaction matches, only how much history a pull has to load to
 * find out. With no usable `sinceIso` (a first run's own lookback window
 * has already passed as the actual `since` by the time this runs, so this
 * is only a defensive fallback), every matched row is loaded, as before.
 */
function alreadyMatchedSaleIds(app, sinceIso) {
  var lowerMs = new Date(sinceIso).getTime();
  var filter = "matched_sale != ''";
  var params = {};
  if (!isNaN(lowerMs)) {
    filter += " && timestamp >= {:lower}";
    params.lower = pbDate(new Date(lowerMs - MATCH_WINDOW_MS - CLAIMED_SALE_LOOKBACK_MARGIN_MS));
  }
  var rows = [];
  try {
    rows = app.findRecordsByFilter("sumup_transactions", filter, "", 0, 0, params);
  } catch (err) {
    rows = [];
  }
  var ids = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) ids.push(rows[i].getString("matched_sale"));
  }
  return ids;
}

/** True when an amount or a status/type says "this is money going back out", not a sale. */
function isRefundLike(amountPence, status, type) {
  if (amountPence < 0) return true;
  if (/refund/i.test(String(status || ""))) return true;
  if (/refund/i.test(String(type || ""))) return true;
  return false;
}

/**
 * Fetch every transaction changed since the last pull (or the last 24
 * hours, on a first run with nothing stored yet), upsert
 * `sumup_transactions` by `sumup_id`, and match each SUCCESSFUL,
 * non-refund one that is not matched already. Writes one audit row. A
 * shop with no SumUp API key or merchant code configured yet returns
 * straight away with all zeroes, rather than throwing - the cron runs
 * every hour on every install, configured or not.
 *
 * Detail (`products[]`) is only fetched for a transaction not already
 * matched, and at most `MAX_DETAIL_FETCHES_PER_PULL` times per call - a
 * pull with more new/unmatched transactions than that leaves the rest for
 * a later pull rather than making an unbounded number of calls in one go.
 *
 * @returns {{fetched: number, matched: number, unmatched: number, refunded: number}}
 */
function pull(app, actorId, ip) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var adapter = require(__hooks + "/adapters/sumup.js");

  var zero = { fetched: 0, matched: 0, unmatched: 0, refunded: 0 };

  var cfg = config(app);
  if (!cfg.apiKey || !cfg.merchantCode) {
    return zero;
  }

  var pullStartedAt = new Date().toISOString();
  var since = readSinceMarker(app) || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();

  var history = [];
  try {
    history = adapter.fetchHistory(cfg.merchantCode, cfg.apiKey, since, MAX_HISTORY_PAGES) || [];
  } catch (err) {
    console.log("[sumup] transactions history pull failed: " + err);
    return zero;
  }

  var fetched = 0;
  var matched = 0;
  var unmatched = 0;
  var refunded = 0;
  var detailFetches = 0;
  var claimedSaleIds = alreadyMatchedSaleIds(app, since);

  for (var i = 0; i < history.length; i++) {
    var summary = history[i];
    if (!summary || !summary.id) continue;
    fetched += 1;

    var existing = null;
    try {
      existing = app.findFirstRecordByFilter("sumup_transactions", "sumup_id = {:id}", { id: summary.id });
    } catch (err) {
      existing = null;
    }
    var alreadyMatchedSale = existing ? existing.getString("matched_sale") : "";

    var detail = null;
    if (!alreadyMatchedSale && detailFetches < MAX_DETAIL_FETCHES_PER_PULL) {
      try {
        detail = adapter.fetchTransaction(cfg.merchantCode, cfg.apiKey, summary.id);
        detailFetches += 1;
      } catch (err) {
        console.log("[sumup] detail fetch failed for " + summary.id + ": " + err);
      }
    }

    var merged = {};
    var key;
    for (key in summary) if (Object.prototype.hasOwnProperty.call(summary, key)) merged[key] = summary[key];
    if (detail) for (key in detail) if (Object.prototype.hasOwnProperty.call(detail, key)) merged[key] = detail[key];

    // A decimal amount SumUp already sent as a string is used verbatim
    // (never round-tripped through Number first); only a genuine JS
    // number falls back to String() - see money.parseDecimalToMinor,
    // which parses a string, never a float.
    var rawAmount = merged.amount;
    var amountText = typeof rawAmount === "string" ? rawAmount : rawAmount === undefined || rawAmount === null ? "" : String(rawAmount);
    var parsedAmount = amountText ? money.parseDecimalToMinor(amountText) : null;
    var amountUnreadable = parsedAmount === null;
    if (amountUnreadable) {
      console.log("[sumup] transaction " + summary.id + " has an unreadable amount: " + JSON.stringify(rawAmount));
    }
    var amountPence = amountUnreadable ? 0 : parsedAmount;

    var timestamp = new Date(merged.timestamp || Date.now());
    var products = Array.isArray(merged.products) ? merged.products : null;
    var sumupStatus = String(merged.status || "");
    var refundLike = !amountUnreadable && isRefundLike(amountPence, sumupStatus, merged.type || merged.transaction_type);
    var effectiveStatus = amountUnreadable ? STATUS_AMOUNT_UNREADABLE : sumupStatus;

    var record = existing || new Record(app.findCollectionByNameOrId("sumup_transactions"), { sumup_id: summary.id });
    record.set("transaction_code", merged.transaction_code || (existing ? existing.getString("transaction_code") : ""));
    record.set("timestamp", isNaN(timestamp.getTime()) ? "" : timestamp.toISOString());
    record.set("amount", amountPence);
    record.set("payment_type", merged.payment_type || "");
    record.set("status", effectiveStatus);
    if (products !== null) {
      // Detail was actually fetched this round - the only source of
      // products[] (absent from the history list) - so this is fresh.
      record.set("products", products);
    } else if (!existing) {
      record.set("products", []);
    } // else: detail was skipped (already matched, or the per-pull cap was
    // reached) - leave whatever products this row already carries alone,
    // rather than overwriting it with an empty array.
    record.set("fetched_at", util.nowIso());

    if (alreadyMatchedSale) {
      matched += 1;
    } else if (amountUnreadable) {
      // Stored, but never matched or counted - see the file banner.
    } else if (refundLike) {
      refunded += 1;
    } else if (effectiveStatus !== STATUS_SUCCESSFUL) {
      // Stored, but never matched or counted (FAILED, PENDING, ...).
    } else {
      var saleId = null;
      var productsForMatch = products || [];
      for (var p = 0; p < productsForMatch.length && !saleId; p++) {
        var candidateSku = skuFromProductName(productsForMatch[p] && productsForMatch[p].name);
        if (candidateSku) saleId = saleIdForSku(app, candidateSku, timestamp, claimedSaleIds);
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

  writeSinceMarker(app, pullStartedAt);

  auditLib.writeAuditLog(app, {
    actor: actorId || "system",
    action: "sumup_pull",
    collection: "sumup_transactions",
    record: "",
    meta: { since: since, fetched: fetched, matched: matched, unmatched: unmatched, refunded: refunded },
    ip: ip || "",
  });

  return { fetched: fetched, matched: matched, unmatched: unmatched, refunded: refunded };
}

/**
 * The day's SumUp transactions beside the day's card sales, for the Cash
 * screen: which transactions matched which sale, which transactions have
 * no sale (a card payment SumUp saw that never reached our own record),
 * and which card/mixed sales have no transaction (one SumUp has not
 * reported yet, or that this shop rang up outside SumUp by mistake). Only
 * `SUCCESSFUL` transactions count toward the totals or the matched/
 * unmatched lists - a stored FAILED or refund-bucketed row would
 * otherwise skew both.
 *
 * `date` must already be a real calendar date (`lib/csv.js`'s own
 * `isValidDateStr`, checked by the route before this is ever called).
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
    var txnRow = {
      id: txn.id,
      sumup_id: txn.getString("sumup_id"),
      transaction_code: txn.getString("transaction_code"),
      amount: txn.getInt("amount"),
      timestamp: txn.getString("timestamp"),
      status: txn.getString("status"),
    };
    if (txn.getString("status") !== STATUS_SUCCESSFUL) {
      // Stored (visible via the collection API if ever needed), but
      // excluded from every total and list below - a FAILED, refund or
      // unreadable-amount row was never a completed card sale.
      continue;
    }
    sumupTotal += txn.getInt("amount");
    var saleId = txn.getString("matched_sale");
    var sale = saleId ? saleById[saleId] : null;
    if (sale) {
      matchedSaleIds[saleId] = true;
      matched.push({
        transaction: txnRow,
        sale: {
          id: sale.id,
          number: sale.getString("number"),
          total: sale.getInt("total"),
          card_share: cardShareOf(app, sale),
        },
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
    var share = cardShareOf(app, sale2);
    salesTotal += share;
    if (!matchedSaleIds[sale2.id]) {
      unmatchedSales.push({
        id: sale2.id,
        number: sale2.getString("number"),
        total: sale2.getInt("total"),
        card_share: share,
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

module.exports = {
  pull: pull,
  reconcile: reconcile,
  cardShareOf: cardShareOf,
  MATCH_WINDOW_MS: MATCH_WINDOW_MS,
  STATUS_SUCCESSFUL: STATUS_SUCCESSFUL,
  STATUS_AMOUNT_UNREADABLE: STATUS_AMOUNT_UNREADABLE,
};
