/* Whitelist tests for pb/pb_hooks/lib/binders_detail.js. Run: node --test pb/scripts/binders_detail.test.cjs */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const D = require(path.join(__dirname, "../pb_hooks/lib/binders_detail.js"));

const PRICE_KEY = /(pric|cost|value|market|pence|amount|gbp|eur|usd|tcgplayer|cardmarket|offer|payout|margin)/i;

function assertNoPriceKeys(v, where) {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoPriceKeys(x, `${where}[${i}]`));
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      assert.ok(!PRICE_KEY.test(k), `price-like key "${k}" leaked at ${where}`);
      assertNoPriceKeys(v[k], `${where}.${k}`);
    }
  }
}

// A TCGdex card detail as the API really sends it: pricing attached.
const RAW = {
  id: "neo1-20",
  localId: "20",
  name: "Cleffa",
  image: "https://assets.tcgdex.net/en/neo/neo1/20",
  illustrator: "Kagemaru Himeno",
  rarity: "Rare",
  category: "Pokemon",
  hp: 30,
  types: ["Colorless"],
  stage: "Baby",
  evolveFrom: "",
  description: "Because of its unusual, star-like silhouette, people believe it came here on a meteor.",
  dexId: [173],
  attacks: [{ cost: ["Colorless"], name: "Eeeeeeek", effect: "Shuffle your hand into your deck, then draw 7 cards." }],
  abilities: [{ type: "Poke-BODY", name: "Eek", effect: "Draw 2 cards." }],
  set: { id: "neo1", name: "Neo Genesis", logo: "https://assets.tcgdex.net/en/neo/neo1/logo", cardCount: { official: 111, total: 111 } },
  pricing: {
    cardmarket: { avg: 5.55, trend: 6.3, low: 0.62, currency: "EUR" },
    tcgplayer: { "normal": { marketPrice: 6.1 }, currency: "USD" },
  },
  variants: { normal: true, holo: false },
};

test("cardDetailOut keeps identity and gameplay and nothing price-like, at any depth", () => {
  const out = D.cardDetailOut(RAW, { id: "neo1", name: "Neo Genesis", logo: "logoUrl", official: 111 }, "2000-12-16");
  assert.equal(out.card_id, "neo1-20");
  assert.equal(out.name, "Cleffa");
  assert.equal(out.rarity, "Rare");
  assert.equal(out.illustrator, "Kagemaru Himeno");
  assert.equal(out.hp, "30");
  assert.equal(out.stage, "Baby");
  assert.equal(out.dex, 173);
  assert.deepEqual(out.types, ["Colorless"]);
  assert.equal(out.set.name, "Neo Genesis");
  assert.equal(out.set.release_date, "2000-12-16");
  assert.equal(out.attacks.length, 1);
  assert.deepEqual(out.attacks[0].energy, ["Colorless"]);
  assert.equal(out.abilities[0].name, "Eek");
  assert.equal(JSON.stringify(out).includes("5.55"), false, "a cardmarket number leaked");
  assert.equal(JSON.stringify(out).toLowerCase().includes("tcgplayer"), false);
  assertNoPriceKeys(out, "detail");
});

test("cardDetailOut survives a bare card with nothing on it", () => {
  const out = D.cardDetailOut({ id: "x-1" }, null, "");
  assert.equal(out.card_id, "x-1");
  assert.equal(out.hp, "");
  assert.deepEqual(out.attacks, []);
  assert.deepEqual(out.types, []);
  assert.equal(out.set.release_date, "");
  assertNoPriceKeys(out, "bare");
});

test("the energy field is named so the price stripper leaves it alone", () => {
  const out = D.moveOut({ cost: ["Grass", "Colorless"], name: "Vine Whip", damage: 10 });
  assert.ok(!("cost" in out), "cost must be renamed");
  assert.deepEqual(out.energy, ["Grass", "Colorless"]);
  assert.equal(out.damage, "10");
});

const SETMAP = {
  base1: { id: "base1", name: "Base Set", serie: "base", serie_name: "Base", official: 102, order: 1, logo: "" },
  neo1: { id: "neo1", name: "Neo Genesis", serie: "neo", serie_name: "Neo", official: 111, order: 10, logo: "" },
  "sv03.5": { id: "sv03.5", name: "151", serie: "sv", serie_name: "Scarlet & Violet", official: 165, order: 90, logo: "" },
};

test("artistOut joins the catalogue, sorts newest set first and groups sets", () => {
  const brief = [
    { id: "base1-4", localId: "4", name: "Charizard", image: "img1" },
    { id: "sv03.5-6", localId: "6", name: "Charizard ex", image: "img3" },
    { id: "neo1-20", localId: "20", name: "Cleffa", image: "img2" },
    { id: "unknown-1", localId: "1", name: "Ghost", image: "" }, // not in the catalogue: dropped
  ];
  const out = D.artistOut("Mitsuhiro Arita", brief, SETMAP);
  assert.equal(out.count, 3);
  assert.deepEqual(out.cards.map((c) => c.set_id), ["sv03.5", "neo1", "base1"]);
  assert.equal(out.cards[0].serie_name, "Scarlet & Violet");
  assert.equal(out.sets.length, 3);
  assert.equal(out.sets[0].id, "sv03.5");
  assert.equal(out.sets[0].count, 1);
  assertNoPriceKeys(out, "artist");
});

test("validCardId takes TCGdex ids and refuses anything path-shaped", () => {
  assert.equal(D.validCardId("sv03.5-151"), true);
  assert.equal(D.validCardId("neo1-20"), true);
  assert.equal(D.validCardId("swsh12.5-GG44"), true);
  assert.equal(D.validCardId(""), false);
  assert.equal(D.validCardId("a"), false);
  assert.equal(D.validCardId("../secrets"), false);
  assert.equal(D.validCardId("a/b"), false);
  assert.equal(D.validCardId("x".repeat(90)), false);
});
