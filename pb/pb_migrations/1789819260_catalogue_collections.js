/// <reference path="../pb_data/types.d.ts" />

/**
 * Catalogue collections: cached copies of external card/price data. Never
 * the source of truth for stock (that is `items`). Readable by anyone so
 * the public /estimate calculator and the customer portal can look cards
 * up without a session; writes are staff (adapters and pricesync write
 * through a superuser token, which bypasses these rules entirely).
 *
 * See docs/PLAN.md, "Data model (PocketBase collections) > Catalogue".
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const ADMIN_ONLY = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';
  const PUBLIC = "";
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  // ---------------------------------------------------------------------
  // games: pokemon, mtg, yugioh, onepiece, lorcana, retro (seeded later).
  // Free text key (not a select) because this collection *is* the enum -
  // Richard can add another game without a migration.
  // ---------------------------------------------------------------------
  const games = new Collection({
    name: "games",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "key", type: "text", required: true, max: 40 },
      { name: "name", type: "text", required: true, max: 100 },
      { name: "adapter", type: "text", max: 40 },
      { name: "enabled", type: "bool" },
      ...autodates(),
    ],
  });
  games.addIndex("idx_games_key_unique", true, "key", "");
  app.save(games);

  // ---------------------------------------------------------------------
  // platforms: admin-editable seed driving the ProductImage aspect ratio
  // and finish (shadow | edge) for everything that is not a TCG card.
  // ---------------------------------------------------------------------
  const platforms = new Collection({
    name: "platforms",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "key", type: "text", required: true, max: 40 },
      { name: "name", type: "text", required: true, max: 100 },
      { name: "aspect_w", type: "number", required: true, onlyInt: true, min: 1 },
      { name: "aspect_h", type: "number", required: true, onlyInt: true, min: 1 },
      {
        name: "image_finish",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["shadow", "edge"],
      },
      { name: "region_note", type: "text", max: 200 },
      { name: "sort", type: "number", onlyInt: true },
      ...autodates(),
    ],
  });
  platforms.addIndex("idx_platforms_key_unique", true, "key", "");
  app.save(platforms);

  // ---------------------------------------------------------------------
  // card_sets
  // ---------------------------------------------------------------------
  const cardSets = new Collection({
    name: "card_sets",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "game", type: "relation", required: true, collectionId: games.id, maxSelect: 1 },
      { name: "code", type: "text", required: true, max: 40 },
      { name: "name", type: "text", required: true, max: 200 },
      { name: "series", type: "text", max: 200 },
      { name: "release_date", type: "date" },
      { name: "total", type: "number", onlyInt: true, min: 0 },
      { name: "symbol", type: "file", maxSelect: 1, maxSize: 2097152 },
      { name: "external_ids", type: "json", maxSize: 20000 },
      ...autodates(),
    ],
  });
  cardSets.addIndex("idx_card_sets_game_code_unique", true, "game, code", "");
  app.save(cardSets);

  // ---------------------------------------------------------------------
  // cards. Unique on (game, set, number) per PLAN.md.
  // image_small/image_large hold a URL - either a third-party image URL
  // or a PocketBase file URL once an item creation re-hosts a copy - so a
  // plain text field covers both cases described in the plan ("URL or
  // cached file") without needing two schemas for the same concept.
  // ---------------------------------------------------------------------
  const cards = new Collection({
    name: "cards",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "game", type: "relation", required: true, collectionId: games.id, maxSelect: 1 },
      { name: "set", type: "relation", required: true, collectionId: cardSets.id, maxSelect: 1 },
      { name: "number", type: "text", required: true, max: 40 },
      { name: "name", type: "text", required: true, max: 200 },
      { name: "rarity", type: "text", max: 100 },
      { name: "type", type: "text", max: 100 },
      { name: "finishes_available", type: "json", maxSize: 5000 },
      { name: "image_small", type: "text", max: 2000 },
      { name: "image_large", type: "text", max: 2000 },
      { name: "tcgplayer_id", type: "text", max: 60 },
      { name: "cardmarket_id", type: "text", max: 60 },
      { name: "external_ids", type: "json", maxSize: 20000 },
      { name: "source", type: "select", maxSelect: 1, values: ["api", "manual"] },
      { name: "search_text", type: "text", max: 400 },
      { name: "last_synced", type: "date" },
      { name: "prices", type: "json", maxSize: 20000 },
      ...autodates(),
    ],
  });
  cards.addIndex("idx_cards_game_set_number_unique", true, "game, set, number", "");
  cards.addIndex("idx_cards_tcgplayer_id", false, "tcgplayer_id", "");
  cards.addIndex("idx_cards_cardmarket_id", false, "cardmarket_id", "");
  cards.addIndex("idx_cards_search_text", false, "search_text", "");
  app.save(cards);

  // ---------------------------------------------------------------------
  // retro_titles
  // ---------------------------------------------------------------------
  const retroTitles = new Collection({
    name: "retro_titles",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "platform", type: "relation", required: true, collectionId: platforms.id, maxSelect: 1 },
      { name: "name", type: "text", required: true, max: 200 },
      { name: "region", type: "select", maxSelect: 1, values: ["PAL", "NTSC", "JP"] },
      { name: "cover", type: "file", maxSelect: 1, maxSize: 5242880 },
      { name: "external_ids", type: "json", maxSize: 20000 },
      ...autodates(),
    ],
  });
  app.save(retroTitles);

  // ---------------------------------------------------------------------
  // price_snapshots. native_low/mid/market/trend are stored as integer
  // minor units of native_currency (matching packages/shared/src/money.ts,
  // which parses every foreign decimal into minor units before it ever
  // reaches app logic - no float ever represents a price). gbp_market is
  // the only value any screen shows.
  // ---------------------------------------------------------------------
  const priceSnapshots = new Collection({
    name: "price_snapshots",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "card", type: "relation", collectionId: cards.id, maxSelect: 1 },
      { name: "retro_title", type: "relation", collectionId: retroTitles.id, maxSelect: 1 },
      { name: "finish", type: "text", max: 60 },
      {
        name: "source",
        type: "select",
        required: true,
        maxSelect: 1,
        values: [
          "uk_sold_manual",
          "ebay_uk_asking",
          "cardmarket",
          "tcgplayer",
          "pricecharting_pal",
          "pricecharting_ntsc",
        ],
      },
      {
        name: "native_currency",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["GBP", "EUR", "USD"],
      },
      { name: "native_low", type: "number", onlyInt: true, min: 0 },
      { name: "native_mid", type: "number", onlyInt: true, min: 0 },
      { name: "native_market", type: "number", onlyInt: true, min: 0 },
      { name: "native_trend", type: "number", onlyInt: true, min: 0 },
      { name: "fx_rate", type: "number", min: 0 }, // rate, not money - decimals allowed
      { name: "fx_date", type: "date" },
      { name: "gbp_market", type: "number", onlyInt: true, min: 0 }, // pence, the only value the UI shows
      { name: "fetched_at", type: "date", required: true },
      { name: "evidence_url", type: "url", max: 2000 },
      ...autodates(),
    ],
  });
  priceSnapshots.addIndex(
    "idx_price_snapshots_lookup",
    false,
    "card, finish, source, fetched_at",
    ""
  );
  app.save(priceSnapshots);

  // ---------------------------------------------------------------------
  // fx_rates: ECB reference rate from Frankfurter, fetched daily.
  // ---------------------------------------------------------------------
  const fxRates = new Collection({
    name: "fx_rates",
    type: "base",
    listRule: PUBLIC,
    viewRule: PUBLIC,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "base", type: "text", required: true, max: 8 },
      { name: "quotes", type: "json", maxSize: 5000 }, // { EUR: 0.8606, USD: 0.79, ... }
      { name: "fetched_at", type: "date", required: true },
      ...autodates(),
    ],
  });
  app.save(fxRates);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("fx_rates"));
  app.delete(app.findCollectionByNameOrId("price_snapshots"));
  app.delete(app.findCollectionByNameOrId("retro_titles"));
  app.delete(app.findCollectionByNameOrId("cards"));
  app.delete(app.findCollectionByNameOrId("card_sets"));
  app.delete(app.findCollectionByNameOrId("platforms"));
  app.delete(app.findCollectionByNameOrId("games"));
});
