/// <reference path="../pb_data/types.d.ts" />

/**
 * crons.pb.js - placeholder jobs for work that lands in later phases
 * (docs/PLAN.md's Phases 3-4 and the ongoing GDPR retention duty). Each
 * one only logs today; wiring in the real work is tracked per phase.
 */

// Daily FX rate fetch from Frankfurter into fx_rates (PLAN.md "FX": daily
// at 07:00, ECB reference rate).
cronAdd("fx", "0 7 * * *", () => {
  console.log("[cron:fx] placeholder - fetch today's ECB rate into fx_rates");
});

// Weekly catalogue/price housekeeping. Day-to-day price ingestion runs in
// the separate services/pricesync sidecar (nightly at 04:00, outside
// PocketBase) because hooks cannot stream the 15-26 MB Cardmarket price
// files (no streaming JSON parser in goja); this in-process job is
// reserved for lighter jobs such as flagging stale price_snapshots or
// triggering the weekly card_sets sync from TCGdex/Scryfall/Lorcast/OPTCG.
cronAdd("prices", "0 3 * * 1", () => {
  console.log("[cron:prices] placeholder - weekly catalogue/price housekeeping");
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
  const now = new Date();
  const nowIso = now.toISOString();
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
      { now: nowIso }
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
      { cutoff: twelveMonthsAgo.toISOString() }
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
