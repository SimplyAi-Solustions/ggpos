#!/usr/bin/env node
/**
 * Loads the seeded settings, pricing_rules and loyalty_tiers rows (fetched
 * by pb/scripts/check.sh into <tmpDir>/{pricing_rules,settings,loyalty_tiers}.json
 * from the running throwaway PocketBase) and runs them through the real
 * generated pb_hooks/lib/shared/{pricing,loyalty}.js - the same module the
 * hooks require() at runtime, built from packages/shared/src/{pricing,loyalty}.ts
 * by `pnpm --filter @gg/shared build:hooks` - to catch band-edge, ""-wildcard
 * and JSON-shape mismatches between the seed and the shared evaluators that a
 * schema-only check would miss.
 *
 * Exits non-zero with a message on the first failed assertion; prints
 * nothing on success (pb/scripts/check.sh reports that itself).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const tmpDir = process.argv[2];
if (!tmpDir) {
  console.error("usage: check-pricing-loyalty.js <tmpDir>");
  process.exit(1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readItems(name) {
  const file = path.join(tmpDir, name);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`could not read/parse ${file}: ${err.message}`);
  }
  return parsed;
}

const pricing = require(path.join(__dirname, "..", "pb_hooks", "lib", "shared", "pricing.js"));
const loyalty = require(path.join(__dirname, "..", "pb_hooks", "lib", "shared", "loyalty.js"));

// PocketBase field names are snake_case; the shared evaluators use
// camelCase. This mapping is the one a future pricing_rules-reading hook
// will also need - see PricingRule.bandMax in packages/shared/src/pricing.ts
// for why band_max needs no extra 0-vs-null handling here: selectRule
// itself now treats 0 the same as null.
const pricingRules = (readItems("pricing_rules.json").items || []).map((r) => ({
  id: r.id,
  game: r.game,
  kind: r.kind,
  condition: r.condition,
  finish: r.finish,
  rarity: r.rarity,
  bandMin: r.band_min,
  bandMax: r.band_max,
  cashPct: r.cash_pct,
  creditPct: r.credit_pct,
  rounding: r.rounding,
  priority: r.priority,
  active: r.active,
}));
if (pricingRules.length === 0) fail("no pricing_rules rows were returned by the API");

const settings = (readItems("settings.json").items || [])[0];
if (!settings) fail("no settings row was returned by the API");

const tiers = readItems("loyalty_tiers.json").items || [];
const legend = tiers.find((t) => t.name === "Legend");
if (!legend) fail("no seeded 'Legend' loyalty_tiers row was found");

// A £20.00 NM Pokemon single must produce a non-zero cash and credit offer.
const cardOffer = pricing.computeOffer(2000, { game: "pokemon", kind: "single", condition: "NM" }, pricingRules);
if (!(cardOffer.cash > 0) || !(cardOffer.credit > 0)) {
  fail("a £20.00 NM Pokemon single produced a zero offer: " + JSON.stringify(cardOffer));
}

// A £30.00 loose retro item must produce a non-zero offer.
const retroOffer = pricing.computeOffer(3000, { game: "retro", kind: "retro", condition: "loose" }, pricingRules);
if (!(retroOffer.cash > 0) || !(retroOffer.credit > 0)) {
  fail("a £30.00 loose retro item produced a zero offer: " + JSON.stringify(retroOffer));
}

// The seeded markup bands must mark a card's sell price up, not leave it
// flat or discount it.
const sellPrice = pricing.suggestSellPrice(2000, settings.markup_bands);
if (!(sellPrice > 2000)) {
  fail("suggestSellPrice(2000, settings.markup_bands) returned " + sellPrice + ", expected more than 2000");
}

// Every Legend tier perk must parse as a real TierPerk.
if (legend.perks.length === 0) fail("the seeded Legend tier has no perks to check");
for (const perk of legend.perks) {
  if (loyalty.parseTierPerk(perk) === null) {
    fail("Legend tier perk failed to parse: " + JSON.stringify(perk));
  }
}
