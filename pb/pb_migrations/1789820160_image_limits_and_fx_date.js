/// <reference path="../pb_data/types.d.ts" />

/**
 * Two unrelated hardening fixes from the Phase 3 adapter review, bundled
 * because both are small field-level changes:
 *
 *  - `cards.image_file` / `retro_titles.cover`: restricted to the four
 *    formats pb_hooks/adapters/images.js actually sniffs for
 *    (image/jpeg, image/png, image/webp, image/avif) and capped at
 *    images.js's own MAX_IMAGE_BYTES (2 MB), not the 5 MB PocketBase
 *    default those fields were created with. images.js already refuses
 *    anything bigger or unrecognised before it ever calls
 *    $filesystem.fileFromBytes, so this is a second, database-level backstop
 *    against the same limits rather than a behaviour change - it also
 *    covers the dashboard's own manual upload path, which does not go
 *    through images.js at all.
 *  - `fx_rates.date`: the ECB reference rate's own date (Frankfurter's
 *    `date` field), stamped by crons.pb.js's "fx" cron. Distinct from
 *    `fetched_at` (when this server happened to ask): at a weekend or a
 *    bank holiday Frankfurter keeps answering with Friday's rate, and
 *    pricing_policy.js's latestFxRates() needs the rate's own date to show
 *    "as of" honestly rather than claiming a rate fetched today is as of
 *    today. Optional and unindexed - a handful of rows a year, always read
 *    as "the latest one".
 */
migrate((app) => {
  const imageMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/avif"];
  const maxImageBytes = 2097152; // keep in step with adapters/images.js's MAX_IMAGE_BYTES

  // Mutated through getByName and re-added by its existing id, so the
  // column keeps its identity (1789819740_phase2_refunds_and_protection.js
  // established this pattern for editing a field already in the schema).
  const cards = app.findCollectionByNameOrId("cards");
  const imageFile = cards.fields.getByName("image_file");
  imageFile.mimeTypes = imageMimeTypes;
  imageFile.maxSize = maxImageBytes;
  cards.fields.add(imageFile);
  app.save(cards);

  const retroTitles = app.findCollectionByNameOrId("retro_titles");
  const cover = retroTitles.fields.getByName("cover");
  cover.mimeTypes = imageMimeTypes;
  cover.maxSize = maxImageBytes;
  retroTitles.fields.add(cover);
  app.save(retroTitles);

  const fxRates = app.findCollectionByNameOrId("fx_rates");
  fxRates.fields.add(new Field({ name: "date", type: "text", max: 20 }));
  app.save(fxRates);
}, (app) => {
  const fxRates = app.findCollectionByNameOrId("fx_rates");
  fxRates.fields.removeByName("date");
  app.save(fxRates);

  const retroTitles = app.findCollectionByNameOrId("retro_titles");
  const cover = retroTitles.fields.getByName("cover");
  cover.mimeTypes = [];
  cover.maxSize = 5242880;
  retroTitles.fields.add(cover);
  app.save(retroTitles);

  const cards = app.findCollectionByNameOrId("cards");
  const imageFile = cards.fields.getByName("image_file");
  imageFile.mimeTypes = [];
  imageFile.maxSize = 5242880;
  cards.fields.add(imageFile);
  app.save(cards);
});
