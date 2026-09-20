/**
 * "loyalty" report: points issued and redeemed by period, tier
 * distribution, perk usage, reward take-up, referral conversions, and
 * programme cost as a percent of revenue (docs/PLAN.md, "Reporting";
 * docs/api-contract.md, Phase 4).
 *
 * require() this from inside reports.pb.js's handler - see pb/README.md.
 */

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var query = require(`${__hooks}/lib/reports/query.js`);
  var daily = require(`${__hooks}/lib/reports/daily.js`);
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);

  var group = params.group;
  var days = dates.eachDay(params.from, params.to);
  var dayRows = daily.rowsForEachDay(app, params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  var totalEarned = 0;
  var totalRedeemed = 0;
  var totalRevenue = 0;
  for (var d = 0; d < days.length; d++) {
    var row = dayRows[d];
    totalEarned += row.points_earned;
    totalRedeemed += row.points_redeemed;
    var methods = Object.keys(row.sales_total_by_payment || {});
    var grossRevenue = 0;
    for (var m = 0; m < methods.length; m++) grossRevenue += row.sales_total_by_payment[methods[m]] || 0;
    // Net of refunds, the same rule every revenue figure here follows -
    // programme cost is a percent of what was actually kept, not of the
    // gross amount taken before any of it was handed back.
    totalRevenue += grossRevenue - (row.sales_refunded || 0);

    var label = dates.groupLabel(days[d], group);
    if (!byLabel[label]) {
      byLabel[label] = { points_earned: 0, points_redeemed: 0 };
      labelOrder.push(label);
    }
    byLabel[label].points_earned += row.points_earned;
    byLabel[label].points_redeemed += row.points_redeemed;
  }
  var series = [];
  for (var l = 0; l < labelOrder.length; l++) series.push({ label: labelOrder[l], values: byLabel[labelOrder[l]] });

  // --- Tier distribution: every customer_private row, by tier -------------
  var tiers = [];
  try {
    tiers = app.findRecordsByFilter("loyalty_tiers", "id != ''", "sort", 0, 0);
  } catch (err) {
    tiers = [];
  }
  var tierNames = {};
  var tierCounts = {};
  var tierOrder = [];
  for (var t = 0; t < tiers.length; t++) {
    tierNames[tiers[t].id] = tiers[t].getString("name");
    tierCounts[tiers[t].id] = 0;
    tierOrder.push(tiers[t].id);
  }
  var noTierCount = 0;
  var privates = [];
  try {
    privates = app.findRecordsByFilter("customer_private", "id != ''", "", 0, 0);
  } catch (err) {
    privates = [];
  }
  for (var p = 0; p < privates.length; p++) {
    var tierId = privates[p] ? privates[p].getString("tier") : "";
    if (tierId && Object.prototype.hasOwnProperty.call(tierCounts, tierId)) tierCounts[tierId] += 1;
    else noTierCount += 1;
  }
  var tierDistribution = [];
  for (var to = 0; to < tierOrder.length; to++) {
    tierDistribution.push({ tier: tierOrder[to], label: tierNames[tierOrder[to]], count: tierCounts[tierOrder[to]] });
  }
  if (noTierCount > 0) tierDistribution.push({ tier: "", label: "No tier", count: noTierCount });

  // --- Perk usage in range ---------------------------------------------------
  var bounds = dates.rangeParams(params.from, params.to);
  var perkRows = [];
  try {
    perkRows = app.findRecordsByFilter("perk_usage", "created >= {:start} && created <= {:end}", "", 0, 0, bounds);
  } catch (err) {
    perkRows = [];
  }
  var perkTotals = {};
  var perkOrder = [];
  for (var pr = 0; pr < perkRows.length; pr++) {
    var perk = perkRows[pr];
    if (!perk) continue;
    var perkType = perk.getString("perk_type");
    if (!Object.prototype.hasOwnProperty.call(perkTotals, perkType)) {
      perkTotals[perkType] = 0;
      perkOrder.push(perkType);
    }
    perkTotals[perkType] += perk.getInt("used_count");
  }
  var perkUsage = [];
  for (var po = 0; po < perkOrder.length; po++) perkUsage.push({ perk_type: perkOrder[po], used_count: perkTotals[perkOrder[po]] });

  // --- Reward take-up in range -----------------------------------------------
  var redemptions = [];
  try {
    redemptions = app.findRecordsByFilter(
      "reward_redemptions",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    redemptions = [];
  }
  var rewardLookup = query.cachedLookup(app, "loyalty_rewards");
  var rewardTotals = {};
  var rewardOrder = [];
  for (var rr = 0; rr < redemptions.length; rr++) {
    var redemption = redemptions[rr];
    if (!redemption) continue;
    var rewardId = redemption.getString("reward");
    if (!Object.prototype.hasOwnProperty.call(rewardTotals, rewardId)) {
      rewardTotals[rewardId] = { count: 0, points: 0 };
      rewardOrder.push(rewardId);
    }
    rewardTotals[rewardId].count += 1;
    rewardTotals[rewardId].points += redemption.getInt("points_spent");
  }
  var rewardTakeUp = [];
  for (var ro = 0; ro < rewardOrder.length; ro++) {
    var rewardRow = rewardLookup(rewardOrder[ro]);
    rewardTakeUp.push({
      reward: rewardOrder[ro],
      label: rewardRow ? rewardRow.getString("name") : "",
      count: rewardTotals[rewardOrder[ro]].count,
      points_spent: rewardTotals[rewardOrder[ro]].points,
    });
  }

  // --- Referral conversions in range -----------------------------------------
  var referralsTotal = 0;
  var referralsEarned = 0;
  try {
    referralsTotal = app.findRecordsByFilter(
      "referrals",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    ).length;
  } catch (err) {
    referralsTotal = 0;
  }
  try {
    referralsEarned = app.findRecordsByFilter(
      "referrals",
      "status = 'earned' && earned_at >= {:start} && earned_at <= {:end}",
      "",
      0,
      0,
      bounds
    ).length;
  } catch (err) {
    referralsEarned = 0;
  }

  // --- Programme cost as a percent of revenue ---------------------------------
  var programme = util.programme(app);
  var pointsValue =
    programme.pointsPerPoundRedemption > 0 ? loyalty.pointsToPence(totalRedeemed, programme) : 0;
  var programmeCostPct = totalRevenue > 0 ? query.roundPct((pointsValue / totalRevenue) * 100) : 0;

  var totals = {
    points_earned: totalEarned,
    points_redeemed: totalRedeemed,
    tier_distribution: tierDistribution,
    perk_usage: perkUsage,
    reward_take_up: rewardTakeUp,
    referrals: { total: referralsTotal, earned: referralsEarned },
    programme_cost_pct: programmeCostPct,
  };

  return {
    series: series,
    table: tierDistribution,
    totals: totals,
    csvColumns: [
      { key: "label", label: "Tier" },
      { key: "count", label: "Customers" },
    ],
  };
}

/** No totals key here is money in pence - points are their own unit, and
 * programme_cost_pct is a percent - so this stays empty; declared anyway
 * so scheduled.js never has to guess from a field name. */
var MONEY_FIELDS = {};

/** totals keys that are actually a function of params.from/to.
 * tier_distribution is left out: it is every customer's *current* tier,
 * no date filter at all. */
var PERIOD_SCOPED_TOTALS = {
  points_earned: true,
  points_redeemed: true,
  perk_usage: true,
  reward_take_up: true,
  referrals: true,
  programme_cost_pct: true,
};

module.exports = {
  build: build,
  MONEY_FIELDS: MONEY_FIELDS,
  PERIOD_SCOPED_TOTALS: PERIOD_SCOPED_TOTALS,
};
