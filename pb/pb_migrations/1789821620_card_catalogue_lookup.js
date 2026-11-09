/// <reference path="../pb_data/types.d.ts" />

/**
 * Card catalogue lookup fields, for the full catalogue import
 * (pb/scripts/catalogue-import.mjs, catalogue_sync.pb.js) and photo
 * identification (lib/vault_scan_db.js). Additive only.
 *
 *   cards.language      ISO code of the print ("en", "ja", "ko", "zh-tw"...)
 *   cards.name_en       English name. The card's own name for an English
 *                       print; for other languages the English Pokemon name
 *                       plus the printed suffix ("Arboliva ex"), which is
 *                       what links a Japanese print to its English ones.
 *   cards.variant       a print variant where the source names one
 *                       ("parallel" for One Piece alt arts)
 *   card_sets.language  the set's language
 *   card_sets.abbr      the printed set abbreviation ("PFL" for TCGdex me02)
 */
migrate(
  (app) => {
    const cards = app.findCollectionByNameOrId("cards");
    if (!cards.fields.getByName("language")) cards.fields.add(new TextField({ name: "language", max: 10 }));
    if (!cards.fields.getByName("name_en")) cards.fields.add(new TextField({ name: "name_en", max: 200 }));
    if (!cards.fields.getByName("variant")) cards.fields.add(new TextField({ name: "variant", max: 60 }));
    cards.addIndex("idx_cards_game_number", false, "game, number", "");
    cards.addIndex("idx_cards_game_name", false, "game, name", "");
    cards.addIndex("idx_cards_game_name_en", false, "game, name_en", "");
    cards.addIndex("idx_cards_language", false, "language", "");
    app.save(cards);

    const sets = app.findCollectionByNameOrId("card_sets");
    if (!sets.fields.getByName("language")) sets.fields.add(new TextField({ name: "language", max: 10 }));
    if (!sets.fields.getByName("abbr")) sets.fields.add(new TextField({ name: "abbr", max: 20 }));
    sets.addIndex("idx_card_sets_code", false, "code", "");
    sets.addIndex("idx_card_sets_abbr", false, "abbr", "");
    sets.addIndex("idx_card_sets_total", false, "total", "");
    app.save(sets);
  },
  (app) => {
    const cards = app.findCollectionByNameOrId("cards");
    ["idx_cards_game_number", "idx_cards_game_name", "idx_cards_game_name_en", "idx_cards_language"].forEach((n) => cards.removeIndex(n));
    ["language", "name_en", "variant"].forEach((n) => cards.fields.removeByName(n));
    app.save(cards);
    const sets = app.findCollectionByNameOrId("card_sets");
    ["idx_card_sets_code", "idx_card_sets_abbr", "idx_card_sets_total"].forEach((n) => sets.removeIndex(n));
    ["language", "abbr"].forEach((n) => sets.fields.removeByName(n));
    app.save(sets);
  }
);
