/// <reference path="../pb_data/types.d.ts" />

/**
 * catalogue_sync.pb.js - the full card catalogue behind photo identification.
 *
 *   POST /api/vault/catalogue/import     (superuser) { game, sets, cards, species? }
 *   POST /api/vault/catalogue/rank-read  (superuser) { read, game? }
 *   cron catalogue_sync                  Mondays 05:10, TCGdex sets that are new or changed
 *
 * The first full import (every TCGdex language, Scryfall, OPTCG, Lorcast) is
 * pb/scripts/catalogue-import.mjs, which downloads politely with a disk
 * cache and posts batches here. The weekly cron then keeps Pokemon fresh on
 * its own: it lists TCGdex sets per language and only fetches a set whose
 * card count changed or that it has never seen, a few dozen calls a week.
 *
 * rank-read runs the identify route's catalogue half (pool, ranking, the
 * auto-accept verdict) on a read that was already made, so
 * pb/scripts/eval-identify.mjs can replay saved reads without paying for
 * another model call.
 */

routerAdd(
  "POST",
  "/api/vault/catalogue/import",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const sync = require(`${__hooks}/lib/catalogue_sync.js`);
    const body = util.body(e);
    const game = util.asStr(body.game);
    if (["pokemon", "mtg", "onepiece", "lorcana"].indexOf(game) < 0) throw e.badRequestError("Unknown game.", null);
    if (body.species && typeof body.species === "object") {
      const store = require(`${__hooks}/adapters/statestore.js`).forApp(e.app);
      for (const lang in body.species) store.set(`catalogue_species_${lang}`, body.species[lang], "");
    }
    const counts = sync.upsertBatch(e.app, { game: game, sets: body.sets || [], cards: body.cards || [] });
    return e.json(200, counts);
  },
  $apis.requireSuperuserAuth()
);

routerAdd(
  "POST",
  "/api/vault/catalogue/rank-read",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const scan = require(`${__hooks}/lib/vault_scan.js`);
    const db = require(`${__hooks}/lib/vault_scan_db.js`);
    const body = util.body(e);
    const read = scan.cleanRead(body.read || {});
    const hint = util.asStr(body.game).toLowerCase();
    const gameKey = read.game || hint;
    const look = db.lookups(e.app);
    const records = db.identifyPool(e.app, read, gameKey);
    const ranked = scan.rankForRead(read, records.map((r) => db.scoringShape(db.cardRow(e.app, r, look, false))));
    const verdict = scan.agreement(read, ranked);
    return e.json(200, {
      read: read,
      candidates: ranked.slice(0, 6).map((entry) => Object.assign({}, entry.card, { score: entry.score, why: entry.why })),
      auto_accept: verdict.accept,
      reasons: verdict.reasons,
    });
  },
  $apis.requireSuperuserAuth()
);

cronAdd("catalogue_sync", "10 5 * * 1", () => {
  const sync = require(`${__hooks}/lib/catalogue_sync.js`);
  const MAX_SETS = 60;
  let fetched = 0;
  const totals = { sets_created: 0, cards_created: 0, cards_updated: 0 };
  let game = null;
  try {
    game = $app.findFirstRecordByFilter("games", "key = 'pokemon'");
  } catch (err) {
    console.log("[cron:catalogue_sync] no pokemon game row");
    return;
  }
  for (let li = 0; li < sync.TCGDEX_LANGS.length && fetched < MAX_SETS; li++) {
    const lang = sync.TCGDEX_LANGS[li];
    const list = sync.tcgdexGet(`/${lang}/sets`, 20);
    if (!Array.isArray(list)) continue;
    const table = sync.speciesFor($app, lang);
    let rarityById = null;
    for (let i = 0; i < list.length && fetched < MAX_SETS; i++) {
      const brief = list[i];
      const code = sync.setCodeFor(brief.id, lang);
      const want = (brief.cardCount && brief.cardCount.total) || 0;
      let have = -1;
      try {
        const row = $app.findFirstRecordByFilter("card_sets", "game = {:g} && code = {:c}", { g: game.id, c: code });
        const ext = JSON.parse(String(row.get("external_ids") || "{}")) || {};
        have = ext.tcgdex_count || 0;
      } catch (err) {
        have = -1;
      }
      if (have === want && want > 0) continue;
      const detail = sync.tcgdexGet(`/${lang}/sets/${encodeURIComponent(brief.id)}`, 20);
      fetched++;
      if (!detail || !detail.id) continue;
      if (rarityById === null) {
        rarityById = {};
        const rarities = sync.tcgdexGet(`/${lang}/rarities`, 20) || [];
        for (let r = 0; r < rarities.length; r++) {
          const named = sync.tcgdexGet(`/${lang}/rarities/${encodeURIComponent(rarities[r])}`, 30);
          const cards = (named && named.cards) || [];
          for (let c = 0; c < cards.length; c++) rarityById[cards[c].id] = rarities[r];
        }
      }
      try {
        const counts = sync.upsertBatch($app, {
          game: "pokemon",
          sets: [sync.tcgdexSet(lang, detail)],
          cards: sync.tcgdexCards(lang, detail, rarityById, table),
        });
        totals.sets_created += counts.sets_created;
        totals.cards_created += counts.cards_created;
        totals.cards_updated += counts.cards_updated;
      } catch (err) {
        console.log(`[cron:catalogue_sync] ${lang} ${brief.id} failed: ${err}`);
      }
    }
  }
  console.log(`[cron:catalogue_sync] fetched ${fetched} set(s), ${totals.sets_created} new set(s), ${totals.cards_created} new and ${totals.cards_updated} updated card(s)`);
});
