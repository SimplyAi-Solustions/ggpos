/// <reference path="../pb_data/types.d.ts" />

/**
 * Turns on PocketBase's own Batch API (`POST /api/batch`), which the
 * services/pricesync nightly sync uses to upsert price_snapshots in
 * batches. This is a PocketBase platform setting (`app.settings().batch`),
 * not a row in this app's own `settings` collection - the equivalent of
 * changing Dashboard > Settings > Batch requests, which is exactly the
 * kind of change PocketBase itself would otherwise write as an
 * auto-generated migration the first time an admin flips it in the UI.
 *
 * PocketBase ships with the Batch API off (`enabled: false`) and capped at
 * 50 requests, which the pricesync agent found in the field: without this,
 * the nightly sync would need someone to turn it on by hand in the
 * dashboard on every fresh install. Values here match what pricesync's own
 * adaptive batch sizing (services/pricesync, not owned by this package)
 * was written against: up to 200 requests per batch call, a 128 MB body
 * (134217728 bytes) and a 60 second transaction timeout - all comfortably
 * above pricesync's own per-batch sizing, which stays adaptive and well
 * under these ceilings on its own.
 */
migrate((app) => {
  const settings = app.settings();
  settings.batch.enabled = true;
  settings.batch.maxRequests = 200;
  settings.batch.maxBodySize = 134217728; // 128 MB
  settings.batch.timeout = 60; // seconds
  app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.batch.enabled = false;
  settings.batch.maxRequests = 50;
  settings.batch.maxBodySize = 0; // PocketBase's own sentinel for "fallback to ~128MB"
  settings.batch.timeout = 3;
  app.save(settings);
});
