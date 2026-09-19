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

// Daily retention purge: ID photos past settings.id_photo_retention_months,
// quote photos 90 days after the quote closes (PLAN.md "Security, GDPR
// and record keeping").
cronAdd("retention", "30 3 * * *", () => {
  console.log("[cron:retention] placeholder - purge expired ID photos and quote photos");
});

// Nightly daily_stats build, scheduled after pricesync so the day's
// stock-at-market figures use fresh prices.
cronAdd("stats", "30 4 * * *", () => {
  console.log("[cron:stats] placeholder - build daily_stats for yesterday");
});
