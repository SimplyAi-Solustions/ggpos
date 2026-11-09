// Pure helpers for vault_snapshots.pb.js, the vault's daily price snapshot
// job: which cards to snapshot and in what order, the dated trend points a
// Cardmarket rolling average honestly supports, and the eBay search words
// for a card. No PocketBase globals (no $app, __hooks), so the same file
// runs under plain Node for apps/vault's tests
// (src/features/cards/snapshot-job.test.ts).
"use strict";

/** Cards per run. TCGdex is one call per card; eBay is three more per card when a key is set. */
var RUN_LIMIT = 150;
/** A card snapshotted this recently is skipped (adapter_state stamp), whoever asked. */
var SNAPSHOT_TTL_HOURS = 20;
/** "Scanned in the last 30 days" (card_scans rows). */
var SCAN_WINDOW_DAYS = 30;
/** The trade-in statuses that count as an open deal. */
var OPEN_DEAL_STATUSES = ["draft", "offered", "accepted"];
/** The item statuses that count as held stock. */
var HELD_STATUSES = ["in_stock", "reserved", "listed_ebay"];

/**
 * The cards one run snapshots, in priority order: in stock first (their
 * value is the shop's money), then in an open deal (a price is being quoted
 * on them), then scanned lately. Each id once, with why it is there, and
 * never one in `skip` (already done inside SNAPSHOT_TTL_HOURS). At most
 * `limit`.
 *
 * `pools` is { stock: string[], deals: string[], scans: string[] } of card
 * ids, duplicates allowed.
 */
function selectCards(pools, skip, limit) {
  var max = limit === undefined || limit === null ? RUN_LIMIT : limit;
  var skipSet = {};
  for (var s = 0; s < (skip || []).length; s++) skipSet[skip[s]] = true;
  var seen = {};
  var out = [];
  var order = [
    ["stock", pools.stock || []],
    ["deals", pools.deals || []],
    ["scans", pools.scans || []],
  ];
  for (var i = 0; i < order.length; i++) {
    var reason = order[i][0];
    var ids = order[i][1];
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (!id || seen[id] || skipSet[id]) continue;
      seen[id] = true;
      if (out.length >= max) continue;
      out.push({ id: id, reason: reason });
    }
  }
  return { cards: out, total: Object.keys(seen).length, capped: Object.keys(seen).length > out.length };
}

/**
 * The trend points a Cardmarket rolling average honestly supports: each
 * average dated at the middle of its own window (a 30-day average is the
 * price around 15 days ago, a 7-day average around 4 days ago, yesterday's
 * average yesterday). `averages` is { avg1?, avg7?, avg30? } of EUR decimal
 * strings from adapters/tcgdex.js. Returns [{ basis, daysAgo, value }],
 * oldest first, only for the averages present.
 */
function seedPoints(averages) {
  var spec = [
    { basis: "avg30", daysAgo: 15 },
    { basis: "avg7", daysAgo: 4 },
    { basis: "avg1", daysAgo: 1 },
  ];
  var out = [];
  for (var i = 0; i < spec.length; i++) {
    var value = averages ? averages[spec[i].basis] : null;
    if (value === null || value === undefined || value === "") continue;
    if (!isFinite(Number(value)) || Number(value) <= 0) continue;
    out.push({ basis: spec[i].basis, daysAgo: spec[i].daysAgo, value: String(value) });
  }
  return out;
}

/** `now` minus `days` days, as an ISO string, for a seed point's fetched_at. */
function daysBefore(now, days) {
  return new Date(now.getTime() - days * 86400000).toISOString();
}

/** PocketBase's stored date shape ("2026-09-20 12:00:00.000Z"), for filters. */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

/** The eBay search words for a card: name, set, number and finish. Condition is left off: a graded query adds its own slab. */
function ebayWords(card) {
  return [card.name, card.setName, card.number, card.finish].filter(Boolean).join(" ");
}

module.exports = {
  RUN_LIMIT: RUN_LIMIT,
  SNAPSHOT_TTL_HOURS: SNAPSHOT_TTL_HOURS,
  SCAN_WINDOW_DAYS: SCAN_WINDOW_DAYS,
  OPEN_DEAL_STATUSES: OPEN_DEAL_STATUSES,
  HELD_STATUSES: HELD_STATUSES,
  selectCards: selectCards,
  seedPoints: seedPoints,
  daysBefore: daysBefore,
  pbDate: pbDate,
  ebayWords: ebayWords,
};
