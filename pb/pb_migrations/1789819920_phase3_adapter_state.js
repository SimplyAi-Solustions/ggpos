/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 3 (catalogue and price adapters): what the adapters and the
 * /api/vault/lookup, /prices, /fx routes need that Phase 1/2 did not
 * already carry.
 *
 * Added:
 *  - `adapter_state` (new collection, superuser-only): a small key/value
 *    store for things the adapters must remember between requests but that
 *    are not settings and are not third-party API keys - OAuth access
 *    tokens (IGDB's Twitch client-credentials token, eBay's Browse API
 *    application token) and sync stamps (the weekly card_sets cron's "last
 *    run" marker per source). Every hook handler runs in its own isolated
 *    goja context (pb/README.md), so nothing here can be kept in memory
 *    between requests; this is the same problem `counters` solves for
 *    sequence numbers, generalised to arbitrary small JSON values with an
 *    optional expiry. Superuser-only (every rule null) because an OAuth
 *    token is a credential: it must never be readable through the regular
 *    API by anyone, staff included, the same reasoning that keeps
 *    `id_documents` and `audit_log` superuser-only.
 *  - `cards.image_file`: a cached local copy of the card's artwork. Public
 *    (this collection's rules are already public read - see
 *    1789819260_catalogue_collections.js), matching `items.photos` being
 *    left public as ordinary product imagery. `image_small` / `image_large`
 *    stay the plain-text "URL or cached file" fields that migration's own
 *    comment already anticipated: once an image is cached here, those two
 *    fields are rewritten to this record's own file URL, so every reader
 *    of a card keeps reading a plain URL string either way. Written by
 *    pb_hooks/adapters/images.js, from two callers: immediately for a
 *    source that forbids hotlinking (YGOPRODeck, OPTCG - hotlinking gets
 *    IPs banned, so their bare URL must never be stored even transiently),
 *    and lazily by items.pb.js's onRecordCreate for every other source, the
 *    first time an item is created against a card whose image is still a
 *    bare third-party URL (docs/PLAN.md, "Card images and market prices").
 *  - `settings.offer.ebayHaircutPct`: the asking-to-sold haircut the eBay
 *    adapter applies to its median-of-five-lowest-asking figure before it
 *    is offered as a candidate (docs/PLAN.md: "a configurable asking-to-
 *    sold haircut (default 15 percent)"). This is the settings editor's own
 *    home for the figure - alongside `bulkThreshold` and friends in the
 *    same JSON blob (1789819680_phase2_fields.js) - not a new column, so
 *    there is exactly one place in `settings` this figure can live. Merged
 *    into the existing `offer` object rather than overwriting it, so a shop
 *    that has already tuned its other offer figures keeps them.
 */
migrate((app) => {
  // -------------------------------------------------------------------
  // adapter_state
  // -------------------------------------------------------------------
  const adapterState = new Collection({
    name: "adapter_state",
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "key", type: "text", required: true, max: 200 },
      { name: "value", type: "json", maxSize: 200000 },
      { name: "expires_at", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  adapterState.addIndex("idx_adapter_state_key_unique", true, "key", "");
  app.save(adapterState);

  // -------------------------------------------------------------------
  // cards.image_file
  // -------------------------------------------------------------------
  const cards = app.findCollectionByNameOrId("cards");
  cards.fields.add(
    new Field({ name: "image_file", type: "file", maxSelect: 1, maxSize: 5242880 })
  );
  app.save(cards);

  // -------------------------------------------------------------------
  // settings.offer.ebayHaircutPct - merged into the existing JSON blob,
  // never replacing it, so a shop that has already tuned bulkThreshold and
  // friends keeps those values.
  // -------------------------------------------------------------------
  let row = null;
  try {
    row = app.findFirstRecordByFilter("settings", "id != ''");
  } catch (err) {
    row = null; // no settings row yet (fresh, pre-seed database)
  }
  if (row) {
    let offer = {};
    try {
      const raw = row.get("offer");
      offer = raw ? JSON.parse(toString(raw)) || {} : {};
    } catch (err) {
      offer = {};
    }
    if (offer.ebayHaircutPct === undefined || offer.ebayHaircutPct === null) {
      offer.ebayHaircutPct = 15;
      row.set("offer", offer);
      app.save(row);
    }
  }
}, (app) => {
  let row = null;
  try {
    row = app.findFirstRecordByFilter("settings", "id != ''");
  } catch (err) {
    row = null;
  }
  if (row) {
    let offer = {};
    try {
      const raw = row.get("offer");
      offer = raw ? JSON.parse(toString(raw)) || {} : {};
    } catch (err) {
      offer = {};
    }
    delete offer.ebayHaircutPct;
    row.set("offer", offer);
    app.save(row);
  }

  const cards = app.findCollectionByNameOrId("cards");
  cards.fields.removeByName("image_file");
  app.save(cards);

  app.delete(app.findCollectionByNameOrId("adapter_state"));
});
