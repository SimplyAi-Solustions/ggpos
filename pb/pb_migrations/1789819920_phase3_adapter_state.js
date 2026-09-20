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
 *  - `settings.ebay_haircut_pct`: the asking-to-sold haircut the eBay
 *    adapter applies to its median-of-five-lowest-asking figure before it
 *    is offered as a candidate (docs/PLAN.md: "a configurable asking-to-
 *    sold haircut (default 15 percent)"). A plain (non-onlyInt) number,
 *    like `bulk_rate_pct` beside it - a percentage, not money.
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
  // settings.ebay_haircut_pct
  // -------------------------------------------------------------------
  const settings = app.findCollectionByNameOrId("settings");
  settings.fields.add(
    new Field({ name: "ebay_haircut_pct", type: "number", min: 0, max: 100 })
  );
  app.save(settings);

  let row = null;
  try {
    row = app.findFirstRecordByFilter("settings", "id != ''");
  } catch (err) {
    row = null; // no settings row yet (fresh, pre-seed database)
  }
  if (row) {
    row.set("ebay_haircut_pct", 15);
    app.save(row);
  }
}, (app) => {
  const settings = app.findCollectionByNameOrId("settings");
  settings.fields.removeByName("ebay_haircut_pct");
  app.save(settings);

  const cards = app.findCollectionByNameOrId("cards");
  cards.fields.removeByName("image_file");
  app.save(cards);

  app.delete(app.findCollectionByNameOrId("adapter_state"));
});
