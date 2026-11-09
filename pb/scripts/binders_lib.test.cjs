/* Pure helper tests for pb/pb_hooks/lib/binders_v2.js. Run: node --test pb/scripts/binders_lib.test.cjs */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const V = require(path.join(__dirname, "../pb_hooks/lib/binders_v2.js"));

test("stripPrices drops money keys at any depth and keeps the rest", () => {
  const input = {
    name: "Pikachu",
    price: 1234,
    pricing: { cardmarket: { avg: 1 } },
    cards: [{ card_id: "sv1-1", market_value: 5, image: "x", nested: { cost_pence: 1, ok: true } }],
    total: 3,
  };
  const out = V.stripPrices(input);
  assert.deepEqual(out, { name: "Pikachu", cards: [{ card_id: "sv1-1", image: "x", nested: { ok: true } }], total: 3 });
  assert.equal(input.price, 1234, "input is not mutated");
});

test("priceFieldNames finds only price-like fields", () => {
  assert.deepEqual(V.priceFieldNames(["id", "name", "price_gbp", "owned", "market"]), ["price_gbp", "market"]);
});

test("dexScope and dexSlots cover the generations", () => {
  assert.equal(V.dexScope("gen1").to, 151);
  assert.equal(V.dexScope("national").to, 1025);
  assert.equal(V.dexScope("gen99"), null);
  const slots = V.dexSlots("gen2", { 152: "Chikorita" });
  assert.equal(slots.length, 100);
  assert.equal(slots[0].name, "Chikorita");
  assert.equal(slots[0].card_id, "dex-0152");
  assert.equal(slots[1].name, "No. 0153");
  assert.match(slots[0].sprite, /\/152\.png$/);
  // Every generation joins up with no gaps.
  let next = 1;
  for (const g of V.GENERATIONS) {
    assert.equal(g.from, next);
    next = g.to + 1;
  }
  assert.equal(next - 1, V.NATIONAL.to);
});

test("gridOf and perPage", () => {
  assert.equal(V.perPage("2x2"), 4);
  assert.equal(V.perPage("3x4"), 12);
  assert.equal(V.perPage("4x4"), 16);
  assert.equal(V.gridOf("9x9"), "3x3");
  assert.equal(V.perPage(""), 9);
});

test("checkLayoutChanges accepts good batches and names the problem otherwise", () => {
  const known = { a: 1, b: 1 };
  assert.equal(V.checkLayoutChanges([{ id: "a", slot: 3 }, { id: "b", owned: true }], known), "");
  assert.match(V.checkLayoutChanges([{ id: "z", slot: 1 }], known), /not in this binder/);
  assert.match(V.checkLayoutChanges([{ id: "a" }, { id: "a" }], known), /twice/);
  assert.match(V.checkLayoutChanges([{ id: "a", slot: 1.5 }], known), /out of range/);
  assert.match(V.checkLayoutChanges([{ id: "a", slot: -2 }], known), /out of range/);
  assert.match(V.checkLayoutChanges([{ id: "a", owned: "yes" }], known), /true or false/);
  assert.match(V.checkLayoutChanges("nope", known), /Send the pockets/);
});

test("slotClashes ignores removed pockets", () => {
  assert.deepEqual(V.slotClashes([0, 1, -1, -1, 2]), []);
  assert.deepEqual(V.slotClashes([0, 1, 1, 2, 1]), [1]);
});

test("firstFreeSlot finds the first gap", () => {
  assert.equal(V.firstFreeSlot([0, 1, 3], 0), 2);
  assert.equal(V.firstFreeSlot([], 0), 0);
  assert.equal(V.firstFreeSlot([4, 5], 4), 6);
});
