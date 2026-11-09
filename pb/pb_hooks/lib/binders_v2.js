/**
 * Helpers for the v2 binder routes in binders.pb.js: the Pokedex binder,
 * pocket positions, the share view and price stripping.
 *
 * Pure functions only at the top level, so `node --test` can load this file
 * (pb/scripts/binders_lib.test.cjs) without a PocketBase runtime. Anything
 * that needs $app or $http takes it as an argument.
 *
 * Each handler runs in its own goja context, so handlers require() this file
 * inside their body and nothing is shared through globals.
 */

const GRIDS = { "2x2": 4, "3x3": 9, "3x4": 12, "4x4": 16 };
const DEFAULT_GRID = "3x3";

// National Pokedex ranges per generation (Scarlet and Violet end at 1025).
const GENERATIONS = [
  { id: "gen1", label: "Generation 1, Kanto", from: 1, to: 151 },
  { id: "gen2", label: "Generation 2, Johto", from: 152, to: 251 },
  { id: "gen3", label: "Generation 3, Hoenn", from: 252, to: 386 },
  { id: "gen4", label: "Generation 4, Sinnoh", from: 387, to: 493 },
  { id: "gen5", label: "Generation 5, Unova", from: 494, to: 649 },
  { id: "gen6", label: "Generation 6, Kalos", from: 650, to: 721 },
  { id: "gen7", label: "Generation 7, Alola", from: 722, to: 809 },
  { id: "gen8", label: "Generation 8, Galar", from: 810, to: 905 },
  { id: "gen9", label: "Generation 9, Paldea", from: 906, to: 1025 },
];
const NATIONAL = { id: "national", label: "National Pokedex", from: 1, to: 1025 };

function dexScope(id) {
  if (id === "national") return NATIONAL;
  for (const g of GENERATIONS) if (g.id === id) return g;
  return null;
}

const SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/";
function spriteUrl(dex) {
  return SPRITE_BASE + dex + ".png";
}

function pad4(n) {
  return ("0000" + n).slice(-4);
}

/**
 * One placeholder pocket per Pokemon in the scope. `names` maps a national
 * dex number to a display name; a missing name falls back to "No. 0025" so
 * the binder still builds when PokeAPI is down.
 */
function dexSlots(scopeId, names) {
  const scope = dexScope(scopeId);
  if (!scope) return [];
  const out = [];
  for (let n = scope.from; n <= scope.to; n++) {
    out.push({
      card_id: "dex-" + pad4(n),
      name: (names && names[n]) || "No. " + pad4(n),
      number: "#" + pad4(n),
      dex: n,
      sprite: spriteUrl(n),
      set_id: "",
      set_name: "",
      set_total: "",
      image: "",
    });
  }
  return out;
}

function gridOf(value) {
  return Object.prototype.hasOwnProperty.call(GRIDS, value) ? value : DEFAULT_GRID;
}
function perPage(grid) {
  return GRIDS[gridOf(grid)];
}

// Any key that smells of money. Customers never see a value, so a field like
// this is dropped wherever it turns up in a customer or share response, even
// though no binder collection has one: defence in depth if one is ever added
// or the catalogue starts sending pricing inside a card.
const PRICE_KEY = /(pric|cost|value|market|pence|amount|gbp|eur|usd|tcgplayer|cardmarket|offer|payout|margin)/i;

function stripPrices(v) {
  if (Array.isArray(v)) return v.map(stripPrices);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      if (PRICE_KEY.test(k)) continue;
      out[k] = stripPrices(v[k]);
    }
    return out;
  }
  return v;
}

/** Field names on a collection that must never reach a customer. */
function priceFieldNames(fieldNames) {
  return fieldNames.filter((n) => PRICE_KEY.test(n));
}

const POCKET_FIELDS = [
  "id",
  "card_id",
  "variant",
  "name",
  "number",
  "set_id",
  "set_name",
  "set_total",
  "rarity",
  "image",
  "sort",
  "slot",
  "owned",
  "dex",
  "sprite",
  "group_name",
  "group_shape",
];

/** The share view's binder: what it is, never who owns it. */
function shareBinderOut(rec) {
  return stripPrices({
    name: rec.getString("name"),
    kind: rec.getString("kind"),
    query_label: rec.getString("query_label"),
    color: rec.getString("color"),
    cover: rec.getString("cover"),
    logo: rec.getString("logo"),
    grid: gridOf(rec.getString("grid")),
    min_slots: rec.getInt("min_slots"),
  });
}

function pocketOut(rec) {
  const o = {};
  for (const k of POCKET_FIELDS) {
    if (k === "owned") o[k] = rec.getBool(k);
    else if (k === "sort") o[k] = rec.getFloat(k);
    else if (k === "slot" || k === "dex") o[k] = rec.getInt(k);
    else o[k] = rec.getString(k);
  }
  return stripPrices(o);
}

/**
 * Checks a batch of pocket changes from the layout route. `changes` is
 * [{id, slot?, owned?}], `known` the set of pocket ids in the binder.
 * Returns an error sentence, or "" when the batch is acceptable. Slot
 * collisions are checked after saving, against the whole binder.
 */
function checkLayoutChanges(changes, known) {
  if (!Array.isArray(changes)) return "Send the pockets to change.";
  if (changes.length > 2000) return "Change at most 2,000 pockets at once.";
  const seen = {};
  for (const c of changes) {
    if (!c || typeof c.id !== "string" || !known[c.id]) return "One of those pockets is not in this binder. Reload and try again.";
    if (seen[c.id]) return "A pocket appears twice in one change. Reload and try again.";
    seen[c.id] = 1;
    if (c.slot !== undefined) {
      if (typeof c.slot !== "number" || Math.floor(c.slot) !== c.slot || c.slot < -1 || c.slot > 20000) {
        return "A pocket position is out of range. Reload and try again.";
      }
    }
    if (c.owned !== undefined && typeof c.owned !== "boolean") return "Owned must be true or false.";
  }
  return "";
}

/** Slots used by more than one pocket, ignoring removed (-1) pockets. */
function slotClashes(slots) {
  const by = {};
  const clashes = [];
  for (const s of slots) {
    if (s < 0) continue;
    by[s] = (by[s] || 0) + 1;
    if (by[s] === 2) clashes.push(s);
  }
  return clashes;
}

/** The lowest free slot at or after `from`, given the used slots. */
function firstFreeSlot(used, from) {
  const taken = {};
  for (const s of used) taken[s] = 1;
  let s = Math.max(0, from || 0);
  while (taken[s]) s++;
  return s;
}

module.exports = {
  GRIDS,
  DEFAULT_GRID,
  GENERATIONS,
  NATIONAL,
  dexScope,
  dexSlots,
  spriteUrl,
  gridOf,
  perPage,
  PRICE_KEY,
  stripPrices,
  priceFieldNames,
  shareBinderOut,
  pocketOut,
  checkLayoutChanges,
  slotClashes,
  firstFreeSlot,
};
