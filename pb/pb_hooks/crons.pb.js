/// <reference path="../pb_data/types.d.ts" />

/**
 * crons.pb.js - placeholder jobs for work that lands in later phases
 * (docs/PLAN.md's Phases 3-4 and the ongoing GDPR retention duty). Each
 * one only logs today; wiring in the real work is tracked per phase.
 */

// Daily FX rate fetch from Frankfurter into fx_rates (PLAN.md "FX": daily
// at 07:00, ECB reference rate, base GBP, quotes EUR and USD, stored with
// its date). GET /api/vault/fx (fx.pb.js) only ever reads the row this
// writes - it never calls Frankfurter itself.
cronAdd("fx", "0 7 * * *", () => {
  const frankfurter = require(`${__hooks}/adapters/frankfurter.js`);
  try {
    const rates = frankfurter.fetchRates(["EUR", "USD"]);
    // Frankfurter answers with 200 even on a day it has nothing to say (a
    // weekend or a bank holiday can come back with an empty rates object,
    // or a single quote dropped for being non-positive - see
    // frankfurter.js). Writing that as today's row would tell every reader
    // of fx_rates a rate is known when it is not, so skip the write
    // entirely and let the previous row (still fetched within the last
    // day or two) stand until the next run has something real to say.
    if (!rates.quotes || Object.keys(rates.quotes).length === 0) {
      console.log("[cron:fx] Frankfurter returned no usable quotes, leaving the last stored rate in place");
      return;
    }
    const record = new Record($app.findCollectionByNameOrId("fx_rates"), {
      base: rates.base,
      quotes: rates.quotes,
      date: rates.date || "",
      fetched_at: rates.fetchedAt,
    });
    $app.save(record);
    console.log(`[cron:fx] stored ${rates.base} rates for ${rates.date}: ${JSON.stringify(rates.quotes)}`);
  } catch (err) {
    console.log(`[cron:fx] failed: ${err}`);
  }
});

// Weekly catalogue sync: every set from TCGdex, Scryfall, Lorcast and
// OPTCG into card_sets (docs/PLAN.md, "Card images and market prices":
// "Weekly cron syncs card_sets from TCGdex, Scryfall, Lorcast and OPTCG").
// Day-to-day *price* ingestion stays in the separate services/pricesync
// sidecar (nightly at 04:00, outside PocketBase) because hooks cannot
// stream the 15-26 MB Cardmarket price files (no streaming JSON parser in
// goja); this job only keeps the set list itself current, which is small.
cronAdd("prices", "0 3 * * 0", () => {
  const adapters = {
    pokemon: `${__hooks}/adapters/tcgdex.js`,
    mtg: `${__hooks}/adapters/scryfall.js`,
    lorcana: `${__hooks}/adapters/lorcast.js`,
    onepiece: `${__hooks}/adapters/optcg.js`,
  };

  let games = [];
  try {
    games = $app.findRecordsByFilter("games", "id != ''", "", 0, 0);
  } catch (err) {
    games = [];
  }
  const gameByKey = {};
  for (let i = 0; i < games.length; i++) {
    if (games[i]) gameByKey[games[i].getString("key")] = games[i];
  }

  const keys = Object.keys(adapters);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const game = gameByKey[key];
    if (!game) continue;

    let sets = [];
    try {
      const adapter = require(adapters[key]);
      sets = adapter.listSets ? adapter.listSets() || [] : [];
    } catch (err) {
      console.log(`[cron:prices] ${key} set sync failed: ${err}`);
      continue;
    }

    let upserted = 0;
    for (let j = 0; j < sets.length; j++) {
      const s = sets[j];
      if (!s || !s.code) continue;
      try {
        let existing = null;
        try {
          existing = $app.findFirstRecordByFilter("card_sets", "game = {:game} && code = {:code}", {
            game: game.id,
            code: s.code,
          });
        } catch (err) {
          existing = null;
        }
        const record =
          existing || new Record($app.findCollectionByNameOrId("card_sets"), { game: game.id, code: s.code });
        record.set("name", s.name || s.code);
        if (s.total) record.set("total", s.total);
        $app.save(record);
        upserted += 1;
      } catch (err) {
        console.log(`[cron:prices] ${key} set "${s.code}" failed: ${err}`);
      }
    }
    console.log(`[cron:prices] ${key}: upserted ${upserted} of ${sets.length} sets`);
  }
});

// Daily retention purge (PLAN.md "Security, GDPR and record keeping"):
//
//  - id_documents past their expires_at, which the ID check route sets to
//    settings.id_photo_retention_months after the check. Deleting the
//    record deletes its encrypted .enc file with it, and the ID fields stay
//    on customer_private, exactly as the plan asks.
//  - notifications older than twelve months.
//
// Each deletion is audited by id alone: the collection and the record id,
// never a field off the row. An id_documents row holds nothing that is not
// PII or a path to it, and an erased record whose identifiers survive in a
// permanent, superuser-only table is not really erased (pb/README.md).
//
// Quote photos ninety days after their quote closes are a later phase's
// job; that needs a "closed at" on quotes, which does not exist yet.
cronAdd("retention", "30 3 * * *", () => {
  const audit = require(`${__hooks}/lib/audit.js`);

  // PocketBase stores a date as "2026-09-20 12:00:00.000Z", with a space
  // rather than the ISO "T", and a filter compares it as text. An
  // ISO-with-T parameter therefore sorts wrong against stored values (every
  // "T" is above every digit), so cutoffs are written in the stored form,
  // the same way exports.pb.js builds its range.
  const pbDate = (d) => d.toISOString().replace("T", " ");

  const now = new Date();
  const nowCutoff = pbDate(now);
  const twelveMonthsAgo = new Date(now.getTime());
  twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);

  let photos = 0;
  let expired = [];
  try {
    expired = $app.findRecordsByFilter(
      "id_documents",
      "expires_at != '' && expires_at <= {:now}",
      "expires_at",
      0,
      0,
      { now: nowCutoff }
    );
  } catch (err) {
    expired = [];
  }
  for (let i = 0; i < expired.length; i++) {
    const doc = expired[i];
    if (!doc) continue;
    const id = doc.id;
    try {
      $app.delete(doc);
    } catch (err) {
      console.log(`[cron:retention] could not delete id_documents ${id}: ${err}`);
      continue;
    }
    audit.writeAuditLog($app, {
      actor: "system",
      action: "retention_delete",
      collection: "id_documents",
      record: id,
      meta: {},
      ip: "",
    });
    photos += 1;
  }

  let notifications = 0;
  let stale = [];
  try {
    stale = $app.findRecordsByFilter(
      "notifications",
      "created <= {:cutoff}",
      "created",
      0,
      0,
      { cutoff: pbDate(twelveMonthsAgo) }
    );
  } catch (err) {
    stale = [];
  }
  for (let i = 0; i < stale.length; i++) {
    if (!stale[i]) continue;
    try {
      $app.delete(stale[i]);
      notifications += 1;
    } catch (err) {
      console.log(`[cron:retention] could not delete notification: ${err}`);
    }
  }

  console.log(
    `[cron:retention] deleted ${photos} expired ID photo(s) and ${notifications} notification(s) over 12 months old`
  );
});

// Nightly daily_stats build, scheduled after pricesync so the day's
// stock-at-market figures use fresh prices.
cronAdd("stats", "30 4 * * *", () => {
  console.log("[cron:stats] placeholder - build daily_stats for yesterday");
});

// Drains adapters/images.js's "image_queue" (see items.pb.js's onRecordCreate
// and images.js's own header comment for why an item create only ever
// queues, never fetches): every five minutes is often enough that a fresh
// buy-in's cards get their local image within minutes, and rare enough that
// a card whose image host is briefly down is not hammered every tick.
cronAdd("image_queue", "*/5 * * * *", () => {
  const images = require(`${__hooks}/adapters/images.js`);
  try {
    const result = images.drainImageQueue($app, 15);
    if (result.processed) {
      console.log(`[cron:image_queue] cached ${result.cached} of ${result.processed} queued card image(s)`);
    }
  } catch (err) {
    console.log(`[cron:image_queue] failed: ${err}`);
  }
});
