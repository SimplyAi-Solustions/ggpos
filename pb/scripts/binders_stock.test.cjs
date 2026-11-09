/* Pure matching tests for pb/pb_hooks/lib/binders_stock.js. Run: node --test pb/scripts/binders_stock.test.cjs */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const S = require(path.join(__dirname, "../pb_hooks/lib/binders_stock.js"));

test("normLang treats blank as English and trims the rest", () => {
  assert.equal(S.normLang(""), "en");
  assert.equal(S.normLang(undefined), "en");
  assert.equal(S.normLang(" JA "), "ja");
  assert.equal(S.normLang("en"), "en");
});

test("itemIsAvailable: only in_stock with qty > 0 and a catalogue card counts", () => {
  assert.equal(S.itemIsAvailable("in_stock", 1, "card123"), true);
  assert.equal(S.itemIsAvailable("in_stock", 3, "card123"), true);
  for (const status of ["reserved", "listed_ebay", "sold", "returned", "written_off", ""]) {
    assert.equal(S.itemIsAvailable(status, 1, "card123"), false, `${status} must not be available`);
  }
  assert.equal(S.itemIsAvailable("in_stock", 0, "card123"), false, "qty 0 must not be available");
  assert.equal(S.itemIsAvailable("in_stock", 1, ""), false, "no catalogue card, no match");
});

test("matchNeededPockets flags only needed pockets on a page", () => {
  const keys = { "sv03.5-199|en": 1 };
  const pockets = [
    { id: "a", card_id: "sv03.5-199", lang: "", owned: false, slot: 0 },
    { id: "b", card_id: "sv03.5-199", lang: "", owned: true, slot: 1 },
    { id: "c", card_id: "sv03.5-199", lang: "", owned: false, slot: -1 },
    { id: "d", card_id: "sv03.5-001", lang: "", owned: false, slot: 2 },
  ];
  assert.deepEqual(S.matchNeededPockets(pockets, keys), ["a"], "owned and off-page pockets never match");
});

test("a Japanese print never matches an English pocket, or the reverse", () => {
  const pockets = [
    { id: "en", card_id: "sv03.5-199", lang: "", owned: false, slot: 0 },
    { id: "ja", card_id: "sv03.5-199", lang: "ja", owned: false, slot: 1 },
  ];
  assert.deepEqual(S.matchNeededPockets(pockets, { "sv03.5-199|ja": 1 }), ["ja"]);
  assert.deepEqual(S.matchNeededPockets(pockets, { "sv03.5-199|en": 1 }), ["en"]);
  assert.deepEqual(S.matchNeededPockets(pockets, {}), []);
});

test("printKey is the exact print: id plus normalised language", () => {
  assert.equal(S.printKey("sv03.5-199", ""), "sv03.5-199|en");
  assert.equal(S.printKey("sv03.5-199", "ja"), "sv03.5-199|ja");
  assert.notEqual(S.printKey("sv03.5-199", "ja"), S.printKey("sv03.5-199", "en"));
});

test("the alert message is the agreed sentence, with no price in it", () => {
  const msg = S.alertMessage("Charizard ex", "Kanto classics");
  assert.equal(
    msg,
    "Good news: Charizard ex for your Kanto classics binder is in at GG Entertainment. Pop in before it goes."
  );
  assert.ok(!/[£$€]|\d+p\b/.test(msg));
});
