// node --test pb/scripts/vault-identify.test.js
//
// Retrieval ordering for photo identification (pb_hooks/lib/vault_scan.js
// and vault_scan_db.js) and the catalogue import normalizers
// (pb_hooks/lib/catalogue_sync.js). The two fixtures are the live misses
// from the test server: Yamper 099/094 from Phantasmal Flames, and a
// Japanese Arboliva ex SV10 012/098 that came back as two English Raichu.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

global.__hooks = path.join(__dirname, "../pb_hooks");
const scan = require("../pb_hooks/lib/vault_scan.js");
const db = require("../pb_hooks/lib/vault_scan_db.js");
const sync = require("../pb_hooks/lib/catalogue_sync.js");

function read(over) {
  return scan.cleanRead(
    Object.assign(
      {
        game: "pokemon",
        language: "en",
        confidence: { name_printed: 0.95, name_en: 0.95, collector_number: 0.95, set_total: 0.9, language: 1 },
      },
      over
    )
  );
}

// Yamper: what the server offered, plus the card it should have found.
const yamperSS = { id: "ss", name: "Yamper", name_en: "Yamper", number: "030", set_code: "me02.5", set_name: "Secluded Springs", set_total: 80, release_date: "2026-01-30", language: "en" };
const yamperPFL030 = { id: "pfl030", name: "Yamper", name_en: "Yamper", number: "030", set_code: "me02", set_abbr: "PFL", set_name: "Phantasmal Flames", set_total: 94, release_date: "2025-11-14", language: "en" };
const yamperBST = { id: "bst", name: "Yamper", name_en: "Yamper", number: "52", set_code: "swsh5", set_abbr: "BST", set_name: "Battle Styles", set_total: 163, release_date: "2021-03-19", language: "en" };
const yamperPFL099 = { id: "pfl099", name: "Yamper", name_en: "Yamper", number: "099", set_code: "me02", set_abbr: "PFL", set_name: "Phantasmal Flames", set_total: 94, release_date: "2025-11-14", language: "en" };
const yamperJa = { id: "ja", name: "ワンパチ", name_en: "Yamper", number: "099", set_code: "SV9-ja", set_name: "バトルパートナーズ", set_total: 100, release_date: "2025-01-24", language: "ja" };
const yamperRead = read({ name_printed: "Yamper", name_en: "Yamper", collector_number: "099", set_total: "094", rarity_mark: "gold star" });

// Arboliva: the Japanese print, its English equivalents, and the two Raichu.
const arbolivaJa = { id: "arb-ja", name: "オリーヴァex", name_en: "Arboliva ex", number: "012", set_code: "SV10-ja", set_name: "ロケット団の栄光", set_total: 98, release_date: "2025-04-18", language: "ja" };
const arbolivaEn = { id: "arb-en", name: "Arboliva ex", name_en: "Arboliva ex", number: "021", set_code: "sv01", set_abbr: "SVI", set_name: "Scarlet & Violet", set_total: 198, release_date: "2023-03-31", language: "en" };
const arbolivaTw = { id: "arb-tw", name: "奧利瓦ex", name_en: "Arboliva ex", number: "012", set_code: "SV10-tw", set_name: "火箭隊的榮耀", set_total: 98, release_date: "2025-04-18", language: "zh-tw" };
const raichuBase = { id: "r1", name: "Raichu", name_en: "Raichu", number: "12", set_code: "fo", set_name: "Fossil", set_total: 62, release_date: "1999-10-10", language: "en" };
const raichuJungle = { id: "r2", name: "Raichu", name_en: "Raichu", number: "12", set_code: "base3", set_name: "Team Rocket", set_total: 82, release_date: "2000-04-24", language: "en" };
const arbolivaRead = read({ language: "ja", name_printed: "オリーヴァex", name_en: "Arboliva ex", set_code: "sv10", collector_number: "012", set_total: "098" });

test("Yamper 099/094 ranks the Phantasmal Flames secret rare first and auto-accepts it", () => {
  const ranked = scan.rankForRead(yamperRead, [yamperSS, yamperPFL030, yamperBST, yamperPFL099, yamperJa]);
  assert.strictEqual(ranked[0].card.id, "pfl099");
  assert.deepStrictEqual(ranked[0].why, ["name", "number", "set_total"]);
  // The same name and set total without the number comes next, then the
  // Japanese print with the same number.
  assert.strictEqual(ranked[1].card.id, "pfl030");
  assert.deepStrictEqual(scan.agreement(yamperRead, ranked), { accept: true, reasons: [] });
});

test("the printed set total tells two sets apart that share a name and number", () => {
  const other = Object.assign({}, yamperPFL099, { id: "other", set_code: "x", set_abbr: "", set_total: 120, release_date: "2026-05-01" });
  const ranked = scan.rankForRead(yamperRead, [other, yamperPFL099]);
  assert.strictEqual(ranked[0].card.id, "pfl099");
  assert.ok(ranked[0].score - ranked[1].score >= 2);
});

test("a Japanese Arboliva ex read finds the Japanese print, offers the English one, and drops Raichu", () => {
  const ranked = scan.rankForRead(arbolivaRead, [raichuBase, raichuJungle, arbolivaEn, arbolivaTw, arbolivaJa]);
  assert.strictEqual(ranked[0].card.id, "arb-ja");
  assert.ok(ranked[0].why.includes("set_code") && ranked[0].why.includes("set_total") && ranked[0].why.includes("number"));
  // The Chinese print of the same set number is offered, but well behind.
  assert.deepStrictEqual(ranked.map((r) => r.card.id), ["arb-ja", "arb-tw", "arb-en"]);
  assert.ok(ranked[0].score - ranked[1].score >= 2);
  const verdict = scan.agreement(arbolivaRead, ranked);
  assert.strictEqual(verdict.accept, true);
});

test("cards whose name does not match are only shown when nothing else exists, and are flagged", () => {
  const ranked = scan.rankForRead(arbolivaRead, [raichuBase, raichuJungle]);
  assert.strictEqual(ranked.length, 2);
  assert.ok(ranked.every((r) => r.why.includes("no_name_match")));
  const verdict = scan.agreement(arbolivaRead, ranked);
  assert.strictEqual(verdict.accept, false);
  assert.ok(verdict.reasons.includes("No card with this name found, check the name"));
});

test("a near name still matches: a misread letter, or an owner prefix", () => {
  assert.strictEqual(scan.nameScore(read({ name_en: "Yamber" }), yamperPFL099), 1.5);
  assert.strictEqual(scan.nameScore(read({ name_en: "Team Rocket's Meowth" }), { name: "Meowth" }), 1.5);
  assert.strictEqual(scan.nameScore(read({ name_en: "Raichu" }), arbolivaEn), 0);
});

test("the auto-accept rule stays strict: close alternatives and missing set are not accepted", () => {
  const noSet = read({ name_printed: "Yamper", name_en: "Yamper", collector_number: "099", set_total: null });
  const verdict = scan.agreement(noSet, scan.rankForRead(noSet, [yamperPFL099]));
  assert.strictEqual(verdict.accept, false);
  assert.ok(verdict.reasons.includes("Set not confirmed"));
  const twin = Object.assign({}, yamperPFL099, { id: "twin" });
  const v2 = scan.agreement(yamperRead, scan.rankForRead(yamperRead, [yamperPFL099, twin]));
  assert.ok(v2.reasons.includes("Close alternatives"));
});

test("retrieval queries: number forms and name terms", () => {
  assert.deepStrictEqual(db.numberForms("099"), { a: "099", b: "99", c: "099", d: "099" });
  assert.deepStrictEqual(db.numberForms("12"), { a: "12", b: "12", c: "012", d: "12" });
  assert.deepStrictEqual(db.nameTerms(yamperRead), ["yamper", "yamp"]);
  assert.deepStrictEqual(db.nameTerms(arbolivaRead), ["arboliva ex", "arbo", "オリーヴァex", "オリ"]);
  assert.strictEqual(db.tcgdexLang("zh"), "zh-tw");
  assert.ok(db.isDigitalSetCode("A3") && db.isDigitalSetCode("A4a") && db.isDigitalSetCode("P-A"));
  assert.ok(!db.isDigitalSetCode("me02") && !db.isDigitalSetCode("SV10-ja") && !db.isDigitalSetCode("base1"));
  assert.strictEqual(db.tcgdexLang("ja"), "ja");
});

test("catalogue import: Japanese names get their English name from the dex-id species table", () => {
  const table = sync.speciesTable({
    en: { 930: ["Arboliva", "Arboliva ex"], 25: ["Pikachu", "Pikachu ex", "Ash's Pikachu"] },
    ja: { 930: ["オリーヴァ", "オリーヴァex"], 25: ["ピカチュウ", "ピカチュウex"] },
  });
  assert.deepStrictEqual(table.ja, { オリーヴァ: "Arboliva", ピカチュウ: "Pikachu" });
  assert.strictEqual(sync.englishName("オリーヴァex", table.ja), "Arboliva ex");
  assert.strictEqual(sync.englishName("ピカチュウV", table.ja), "Pikachu V");
  assert.strictEqual(sync.englishName("ボスの指令", table.ja), "");
});

test("catalogue import: TCGdex set details become set and card rows, with a language-tagged set code", () => {
  const detail = {
    id: "SV10",
    name: "ロケット団の栄光",
    releaseDate: "2025-04-18",
    serie: { id: "SV", name: "スカーレット&バイオレット" },
    cardCount: { official: 98, total: 132 },
    cards: [{ id: "SV10-012", localId: "012", name: "オリーヴァex", image: "https://assets.tcgdex.net/ja/SV/SV10/012" }],
  };
  const set = sync.tcgdexSet("ja", detail);
  assert.strictEqual(set.code, "SV10-ja");
  assert.strictEqual(set.total, 98);
  assert.strictEqual(set.release_date, "2025-04-18 00:00:00.000Z");
  assert.strictEqual(scan.setcode(set.code), "sv10");
  const cards = sync.tcgdexCards("ja", detail, { "SV10-012": "Double rare" }, { オリーヴァ: "Arboliva" });
  assert.deepStrictEqual(
    { set_code: cards[0].set_code, number: cards[0].number, name_en: cards[0].name_en, language: cards[0].language, rarity: cards[0].rarity, image_small: cards[0].image_small },
    { set_code: "SV10-ja", number: "012", name_en: "Arboliva ex", language: "ja", rarity: "Double rare", image_small: "https://assets.tcgdex.net/ja/SV/SV10/012/low.webp" }
  );
  const en = sync.tcgdexSet("en", { id: "me02", name: "Phantasmal Flames", cardCount: { official: 94, total: 130 }, abbreviation: { official: "PFL" } });
  assert.strictEqual(en.code, "me02");
  assert.strictEqual(en.abbr, "PFL");
});

test("catalogue import: One Piece parallels are their own rows", () => {
  const { sets, cards } = sync.optcgRows([
    { card_set_id: "OP01-001", card_image_id: "OP01-001", card_name: "Roronoa Zoro", set_name: "Romance Dawn", rarity: "L" },
    { card_set_id: "OP01-001", card_image_id: "OP01-001_p1", card_name: "Roronoa Zoro (Parallel)", set_name: "Romance Dawn", rarity: "L" },
  ]);
  assert.strictEqual(sets.length, 1);
  assert.deepStrictEqual(cards.map((c) => [c.number, c.variant]), [["OP01-001", ""], ["OP01-001_p1", "parallel"]]);
});
