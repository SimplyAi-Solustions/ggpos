/**
 * The shape checks behind the four admin-editable loyalty collections
 * (`loyalty_programme`, `loyalty_rules`, `loyalty_tiers`,
 * `loyalty_rewards`), registered as hooks in loyalty.pb.js.
 *
 * The evaluators in packages/shared read these rows as plain JSON, which
 * means a key they do not recognise is simply ignored rather than applied:
 * a rule saved with `kind` instead of `kinds`, or `min_spend` instead of
 * `minSpend`, looks right in the editor and quietly earns the wrong
 * points; a perk saved in the pre-fix snake_case shape parses to null and
 * silently disappears from a tier. Both are refused here, naming the key
 * or the entry, so the mistake surfaces where it is made.
 *
 * Every function reports a refusal (`{status, message}`) rather than
 * throwing, so the calling hook can raise it with its own event's
 * `e.error()` and the wording stays in one place.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Keys the shared LoyaltyRuleConditions actually has. */
var CONDITION_KEYS = ["games", "kinds", "minSpend", "weekdays"];

/** Rule types whose `value` is a multiplier rather than a points figure. */
var MULTIPLIER_TYPES = ["multiplier", "day_of_week"];

/** The largest multiplier anyone should be able to save by accident. */
var MAX_MULTIPLIER = 10;

function isStringArray(value) {
  if (!Array.isArray(value)) return false;
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return false;
  }
  return true;
}

/** loyalty_rules: the conditions shape, and the value the evaluator reads. */
function checkRule(app, record) {
  var util = require(`${__hooks}/lib/vaultutil.js`);

  var conditions = util.jsonField(record, "conditions", {});
  if (conditions === null || conditions === undefined) conditions = {};
  if (typeof conditions !== "object" || Array.isArray(conditions)) {
    return {
      status: 400,
      message: "Conditions must be an object, for example {\"kinds\":[\"sealed\"]}. Leave it empty for a rule that always applies.",
    };
  }

  var keys = Object.keys(conditions);
  for (var i = 0; i < keys.length; i++) {
    if (CONDITION_KEYS.indexOf(keys[i]) < 0) {
      return {
        status: 400,
        message: `Conditions has no "${keys[i]}" setting. Use games, kinds, minSpend or weekdays.`,
      };
    }
  }
  if (conditions.games !== undefined && !isStringArray(conditions.games)) {
    return { status: 400, message: "Conditions.games must be a list of game keys, for example [\"pokemon\"]." };
  }
  if (conditions.kinds !== undefined && !isStringArray(conditions.kinds)) {
    return { status: 400, message: "Conditions.kinds must be a list of item kinds, for example [\"sealed\"]." };
  }
  if (conditions.minSpend !== undefined) {
    if (typeof conditions.minSpend !== "number" || conditions.minSpend < 0 || Math.round(conditions.minSpend) !== conditions.minSpend) {
      return { status: 400, message: "Conditions.minSpend is in whole pence, for example 3000 for £30.00." };
    }
  }
  if (conditions.weekdays !== undefined) {
    if (!Array.isArray(conditions.weekdays)) {
      return { status: 400, message: "Conditions.weekdays must be a list of days, 0 for Sunday to 6 for Saturday." };
    }
    for (var w = 0; w < conditions.weekdays.length; w++) {
      var day = conditions.weekdays[w];
      if (typeof day !== "number" || day < 0 || day > 6 || Math.round(day) !== day) {
        return { status: 400, message: "Conditions.weekdays must be a list of days, 0 for Sunday to 6 for Saturday." };
      }
    }
  }

  var value = record.getFloat("value");
  if (!(value > 0)) {
    return { status: 400, message: "A rule's value has to be above 0. A multiplier of 2 doubles the points; a bonus of 150 adds 150." };
  }
  if (MULTIPLIER_TYPES.indexOf(record.getString("type")) >= 0 && value > MAX_MULTIPLIER) {
    return {
      status: 400,
      message: `A multiplier of ${value} is too high. Keep it to ${MAX_MULTIPLIER} or less, or use a fixed bonus instead.`,
    };
  }

  return null;
}

/** loyalty_tiers: every perk parses, and thresholds stay distinct. */
function checkTier(app, record) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);

  var perks = util.jsonField(record, "perks", []);
  if (perks === null || perks === undefined || perks === "") perks = [];
  if (!Array.isArray(perks)) {
    return { status: 400, message: "Perks must be a list. Use [] for a tier with no perks." };
  }
  for (var i = 0; i < perks.length; i++) {
    var perk = loyalty.parseTierPerk(perks[i]);
    if (!perk) {
      return {
        status: 400,
        message: `Perk ${i + 1} is not a perk this app knows. Use percent_off, points_multiplier, free_event_entries, lounge_hours, priority_release_booking or member_event_pricing, with the fields each one takes.`,
      };
    }
    // The two counted perks are counted in whole ones: lib/perks.js
    // compares `used + count` against the allowance, and half a free
    // entry is not a thing anybody can hand over. The shared parser
    // takes any number (it is the reader, not the editor), so the
    // editor refuses it here instead.
    if (perk.type === "free_event_entries" || perk.type === "lounge_hours") {
      if (Math.round(perk.value) !== perk.value || perk.value < 0) {
        return {
          status: 400,
          message: `Perk ${i + 1} has ${perk.value} ${perk.type === "lounge_hours" ? "lounge hours" : "free entries"} a month. Use a whole number.`,
        };
      }
    }
  }

  // A paid plan is not reached by points at all, so two paid plans may
  // sit at the same (usually 0) threshold without ambiguity. Two earned
  // tiers at one threshold would make "which tier is this" a coin toss.
  if (!record.getBool("paid_plan")) {
    var threshold = record.getInt("threshold_points");
    var clash = null;
    try {
      clash = app.findFirstRecordByFilter(
        "loyalty_tiers",
        "paid_plan = false && threshold_points = {:threshold} && id != {:id}",
        { threshold: threshold, id: record.id }
      );
    } catch (err) {
      clash = null;
    }
    if (clash) {
      return {
        status: 400,
        message: `${clash.getString("name")} already starts at ${threshold} points. Give this tier a different threshold.`,
      };
    }
  }

  return null;
}

/** loyalty_tiers: a tier somebody is on cannot be deleted out from under them. */
function checkTierDelete(app, record) {
  var onIt = 0;
  try {
    onIt = app.findRecordsByFilter("customer_private", "tier = {:id}", "", 1, 0, { id: record.id }).length;
  } catch (err) {
    onIt = 0;
  }
  if (onIt > 0) {
    return {
      status: 409,
      message: `${record.getString("name")} is a customer's current tier. Move them to another tier first.`,
    };
  }

  var memberships = 0;
  try {
    memberships = app.findRecordsByFilter(
      "memberships",
      'tier = {:id} && status = "active"',
      "",
      1,
      0,
      { id: record.id }
    ).length;
  } catch (err) {
    memberships = 0;
  }
  if (memberships > 0) {
    return {
      status: 409,
      message: `${record.getString("name")} has an active membership on it. Cancel the membership first.`,
    };
  }

  return null;
}

/** loyalty_rewards: a reward that can actually be given. */
function checkReward(app, record) {
  var type = record.getString("type");
  var value = record.getInt("value");
  if ((type === "money_off" || type === "store_credit") && value <= 0) {
    return {
      status: 400,
      message: "A money off or store credit reward needs a value in pence, for example 500 for £5.00.",
    };
  }

  var startsAt = record.getString("starts_at");
  var endsAt = record.getString("ends_at");
  if (startsAt && endsAt) {
    var from = new Date(String(startsAt).replace(" ", "T"));
    var to = new Date(String(endsAt).replace(" ", "T"));
    if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && to.getTime() < from.getTime()) {
      return { status: 400, message: "The end date is before the start date. Swap them over." };
    }
  }

  return null;
}

/** loyalty_programme: the one figure the evaluators divide by. */
function checkProgramme(app, record) {
  if (record.getInt("points_per_pound_redemption") <= 0) {
    return {
      status: 400,
      message: "Points per pound has to be above 0. 100 means 100 points are worth £1.00.",
    };
  }
  return null;
}

module.exports = {
  CONDITION_KEYS: CONDITION_KEYS,
  MAX_MULTIPLIER: MAX_MULTIPLIER,
  checkRule: checkRule,
  checkTier: checkTier,
  checkTierDelete: checkTierDelete,
  checkReward: checkReward,
  checkProgramme: checkProgramme,
};
