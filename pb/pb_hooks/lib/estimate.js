/**
 * The public estimate calculator behind estimate.pb.js: a catalogue-only
 * search (never an adapter call) and the cash/credit band for a card at a
 * condition and one grade lower, through the same shared offer calculator
 * every other valuation in this codebase uses (CLAUDE.md's "Pricing": "the
 * estimate bands through the shared offer calculator, never a new
 * formula").
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var CONDITION_ORDER = ["NM", "LP", "MP", "HP", "DMG"];

/** The next condition down (LP for NM, DMG for HP), or the same value at
 * the bottom of the scale - there is nothing lower than DMG to show. */
function oneGradeLower(condition) {
  var idx = CONDITION_ORDER.indexOf(condition);
  if (idx < 0 || idx === CONDITION_ORDER.length - 1) return condition;
  return CONDITION_ORDER[idx + 1];
}

/**
 * Up to 8 `cards` rows matching `q` by name, or by a "<set> <number>" pair
 * already on file - the catalogue only, never the adapters (registry.js's
 * own resolveSetNumberQuery can trigger an inline set sync against a live
 * adapter on an install with no card_sets rows yet for that game, which is
 * exactly what a public, unauthenticated route must never risk doing).
 */
function searchCatalogue(app, q) {
  var trimmed = (q || "").trim();
  if (!trimmed) return [];

  var rows = [];
  var spaced = trimmed.match(/^(\S+)\s+(\S+)$/);
  if (spaced) {
    var numberToken = spaced[2].match(/^(\d+)(?:\/\d+)?[A-Za-z]?$/);
    if (numberToken) {
      try {
        rows = app.findRecordsByFilter(
          "cards",
          "(set.code ~ {:setq} || set.name ~ {:setq}) && number ~ {:num}",
          "name",
          8,
          0,
          { setq: spaced[1], num: spaced[2] }
        );
      } catch (err) {
        rows = [];
      }
    }
  }

  if (rows.length === 0) {
    try {
      rows = app.findRecordsByFilter(
        "cards",
        "search_text ~ {:q} || name ~ {:q}",
        "name",
        8,
        0,
        { q: trimmed }
      );
    } catch (err) {
      rows = [];
    }
  }

  return rows;
}

/** pricing_rules rows as packages/shared/src/pricing.ts's PricingRule[] -
 * the same field-by-field snake_case to camelCase mapping
 * pb/scripts/check-pricing-loyalty.js already uses against the live API, so
 * this route's bands can never silently disagree with that check. */
function pricingRulesFor(app) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("pricing_rules", "active = true", "-priority", 0, 0);
  } catch (err) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r) continue;
    out.push({
      id: r.id,
      game: r.getString("game"),
      kind: r.getString("kind"),
      condition: r.getString("condition"),
      finish: r.getString("finish"),
      rarity: r.getString("rarity"),
      bandMin: r.getInt("band_min"),
      bandMax: r.getInt("band_max"),
      cashPct: r.getFloat("cash_pct"),
      creditPct: r.getFloat("credit_pct"),
      rounding: r.getInt("rounding"),
      priority: r.getInt("priority"),
      active: r.getBool("active"),
    });
  }
  return out;
}

/**
 * `{ card, market, as_of, cash: {low,high}, credit: {low,high}, note }` for
 * one card at one condition and finish, from cached price_snapshots only -
 * no adapter call, no write, matching the GET price routes' own rule
 * (prices.pb.js). `card` is null when the id does not resolve to a real
 * card; the caller 404s on that.
 */
function estimateForCard(app, cardId, condition, finish) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var policy = require(`${__hooks}/adapters/pricing_policy.js`);
  var pricingShared = require(`${__hooks}/lib/shared/pricing.js`);

  var card = null;
  try {
    card = app.findRecordById("cards", cardId);
  } catch (err) {
    return null;
  }

  var gameKey = "";
  try {
    gameKey = app.findRecordById("games", card.getString("game")).getString("key");
  } catch (err) {
    gameKey = "";
  }
  var setName = "";
  try {
    setName = app.findRecordById("card_sets", card.getString("set")).getString("name");
  } catch (err) {
    setName = "";
  }

  var settingsRow = util.settings(app);
  var priority = policy.tcgPriority(settingsRow);
  var multipliers = policy.conditionMultipliers(settingsRow);
  var candidates = policy.snapshotsFor(app, "card", cardId, finish);
  var now = new Date();
  var chosen = policy.choose(candidates, priority, now).chosen;

  var cardOut = {
    name: card.getString("name"),
    set: setName,
    number: card.getString("number"),
    image: card.getString("image_large") || card.getString("image_small") || "",
  };

  if (!chosen) {
    return {
      card: cardOut,
      market: null,
      as_of: null,
      cash: { low: null, high: null },
      credit: { low: null, high: null },
      note: "Subject to inspection in the shop.",
    };
  }

  var rules = pricingRulesFor(app);
  var offerSettings = util.offerSettings(app, settingsRow);
  var lowerCondition = oneGradeLower(condition);

  var high = pricingShared.computeOffer(
    chosen.gbp_market,
    { game: gameKey, kind: "single", condition: condition },
    rules,
    offerSettings,
    multipliers
  );
  var low = pricingShared.computeOffer(
    chosen.gbp_market,
    { game: gameKey, kind: "single", condition: lowerCondition },
    rules,
    offerSettings,
    multipliers
  );

  return {
    card: cardOut,
    market: chosen.gbp_market,
    as_of: chosen.fetched_at,
    cash: { low: Math.min(low.cash, high.cash), high: Math.max(low.cash, high.cash) },
    credit: { low: Math.min(low.credit, high.credit), high: Math.max(low.credit, high.credit) },
    note: "Subject to inspection in the shop.",
  };
}

module.exports = {
  CONDITION_ORDER: CONDITION_ORDER,
  oneGradeLower: oneGradeLower,
  searchCatalogue: searchCatalogue,
  pricingRulesFor: pricingRulesFor,
  estimateForCard: estimateForCard,
};
