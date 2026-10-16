/// <reference path="../pb_data/types.d.ts" />

/**
 * singletons.pb.js
 *
 * `settings` and `loyalty_programme` are single-record collections
 * (PLAN.md), and so is `display_state` (Phase 6: one customer-facing
 * display, one row the tablet subscribes to). PocketBase has no built-in
 * notion of that, so this refuses a second create for any of them. It
 * fires for the seed migration's own insert and any later API create -
 * the very first row always succeeds; a second attempt is refused with a
 * clear error.
 */
onRecordCreate((e) => {
  const name = e.record.collection().name;

  let existing = null;
  try {
    existing = e.app.findFirstRecordByFilter(name, "id != ''");
  } catch (err) {
    existing = null; // none found yet - this create may proceed
  }

  if (existing) {
    throw new Error(`${name} already has a record - it is a single-record collection`);
  }

  e.next();
}, "settings", "loyalty_programme", "display_state");
