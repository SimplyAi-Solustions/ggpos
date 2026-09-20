/**
 * The perks wallet: what a customer's tier entitles them to this month,
 * how much of it they have used, and the one place a use is recorded
 * (docs/api-contract.md's Phase 6 section; docs/PLAN.md's Loyalty data
 * model, "`perk_usage`: enforces monthly counters").
 *
 * The two counted perks (`free_event_entries`, `lounge_hours`) read their
 * allowance from the tier itself through the shared `perkAllowance`
 * (packages/shared/src/loyalty.ts), so the counter, the portal and the
 * admin preview can never disagree about how many a tier gets. The others
 * are informational: a percentage off, a points multiplier, priority
 * booking and member event pricing are applied where they are used (the
 * Sell screen, the events diary), not counted here.
 *
 * A period is a calendar month in **Europe/London** civil time
 * (`lib/reports/dates.js`'s own `toLondon`, the one place this codebase
 * does that conversion - goja has no timezone database), because "this
 * month" at the counter means the month the shop is actually in, not the
 * UTC one. It is stored in `perk_usage.period` as `YYYY-MM`.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** The current period, `YYYY-MM` in Europe/London civil time. */
function currentPeriod(now) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  return dates.toLondon(now || new Date()).toISOString().slice(0, 7);
}

/** "1 Oct" - when the next month's allowance arrives, in London civil time. */
function nextPeriodStart(now) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var london = dates.toLondon(now || new Date());
  var first = new Date(Date.UTC(london.getUTCFullYear(), london.getUTCMonth() + 1, 1));
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${first.getUTCDate()} ${months[first.getUTCMonth()]}`;
}

/** The `perk_usage` row for one customer, perk and period, or null. */
function usageRow(app, customerId, type, period) {
  try {
    return app.findFirstRecordByFilter(
      "perk_usage",
      "customer = {:customer} && perk_type = {:type} && period = {:period}",
      { customer: customerId, type: type, period: period }
    );
  } catch (err) {
    return null;
  }
}

/** How many of a counted perk this customer has used this period. */
function usedCount(app, customerId, type, period) {
  var row = usageRow(app, customerId, type, period);
  return row ? row.getInt("used_count") : 0;
}

/** One counted perk's wallet entry. */
function countedEntry(app, customerId, tier, type, period) {
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
  var allowed = loyalty.perkAllowance(tier, type);
  return {
    type: type,
    value: allowed,
    allowed: allowed,
    used: usedCount(app, customerId, type, period),
    period: period,
  };
}

/**
 * The whole wallet for a customer: their tier's two counted perks with
 * this month's figures, then every informational perk the tier carries.
 * A customer with no tier has an empty wallet.
 */
function walletFor(app, customerId, tier, now) {
  var period = currentPeriod(now);
  var entries = [];
  if (!tier) return entries;

  var counted = ["free_event_entries", "lounge_hours"];
  for (var i = 0; i < counted.length; i++) {
    var entry = countedEntry(app, customerId, tier, counted[i], period);
    if (entry.allowed > 0) entries.push(entry);
  }

  for (var p = 0; p < (tier.perks || []).length; p++) {
    var perk = tier.perks[p];
    if (!perk) continue;
    if (perk.type === "percent_off") {
      entries.push({ type: "percent_off", value: perk.value, scope: perk.scope || [] });
    } else if (perk.type === "points_multiplier") {
      entries.push({ type: "points_multiplier", value: perk.value });
    } else if (perk.type === "priority_release_booking") {
      entries.push({ type: "priority_release_booking" });
    } else if (perk.type === "member_event_pricing") {
      entries.push({ type: "member_event_pricing" });
    }
  }
  return entries;
}

/** "free entries" / "lounge hours" - how each counted perk is spoken about. */
function perkWords(type) {
  return type === "free_event_entries"
    ? { plural: "free entries", singular: "free entry" }
    : { plural: "lounge hours", singular: "lounge hour" };
}

/** The refusal when this month's allowance is already spent. */
function usedUpMessage(type, allowed, now) {
  var words = perkWords(type);
  var opening =
    allowed === 2
      ? `Both ${words.plural} this month are used.`
      : `All ${allowed} ${words.plural} this month are used.`;
  var next = allowed === 2 ? "The next two come on" : `The next ${allowed} come on`;
  return `${opening} ${next} ${nextPeriodStart(now)}.`;
}

/**
 * Can this customer use `count` of a counted perk right now? Reports a
 * refusal (`{status, message}`) or null, and writes nothing - so a route
 * can refuse before it ever opens a transaction ("validate first, write
 * second", pb/README.md) and re-check inside it with the same wording.
 */
function check(app, customerId, tier, type, count, now) {
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);

  if (type !== "free_event_entries" && type !== "lounge_hours") {
    return { status: 400, message: "Pick either free_event_entries or lounge_hours." };
  }
  var n = Math.round(count || 1);
  if (n < 1) {
    return { status: 400, message: "Use at least one." };
  }

  var allowed = loyalty.perkAllowance(tier, type);
  if (allowed <= 0) {
    var words = perkWords(type);
    return {
      status: 422,
      message: tier
        ? `${tier.name} does not include ${words.plural}. Check the tier's perks or pick another.`
        : `This customer has no tier yet, so there are no ${words.plural} to use. They get a tier as they collect points.`,
    };
  }

  var period = currentPeriod(now);
  var used = usedCount(app, customerId, type, period);
  if (used + n > allowed) {
    return { status: 422, message: usedUpMessage(type, allowed, now) };
  }
  return null;
}

/**
 * Record a use of a counted perk, re-checking it first. Writes through
 * whatever `app` it is handed (the route's own txApp) and reports a
 * refusal rather than throwing, so the route can word its own status code.
 *
 * @returns {{ok:false,status:number,message:string} | {ok:true,entry:object}}
 */
function use(app, customerId, tier, type, count, now) {
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);

  var refusal = check(app, customerId, tier, type, count, now);
  if (refusal) return { ok: false, status: refusal.status, message: refusal.message };

  var n = Math.round(count || 1);
  var allowed = loyalty.perkAllowance(tier, type);
  var period = currentPeriod(now);
  var row = usageRow(app, customerId, type, period);
  var used = row ? row.getInt("used_count") : 0;

  if (row) {
    row.set("used_count", used + n);
    app.save(row);
  } else {
    row = new Record(app.findCollectionByNameOrId("perk_usage"), {
      customer: customerId,
      perk_type: type,
      period: period,
      used_count: n,
    });
    app.save(row);
  }

  return {
    ok: true,
    entry: {
      type: type,
      value: allowed,
      allowed: allowed,
      used: used + n,
      period: period,
    },
  };
}

module.exports = {
  currentPeriod: currentPeriod,
  nextPeriodStart: nextPeriodStart,
  usageRow: usageRow,
  usedCount: usedCount,
  walletFor: walletFor,
  usedUpMessage: usedUpMessage,
  check: check,
  use: use,
};
