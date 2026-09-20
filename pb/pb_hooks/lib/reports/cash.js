/**
 * "cash" report: sessions in range with expected, counted and variance;
 * variance history; cash in and out per day from cash_movements
 * (docs/PLAN.md, "Reporting"; docs/api-contract.md, Phase 4).
 *
 * require() this from inside reports.pb.js's handler - see pb/README.md.
 */

function build(app, util, params) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var bounds = dates.rangeParams(params.from, params.to);

  var sessions = [];
  try {
    sessions = app.findRecordsByFilter(
      "cash_sessions",
      "closed_at >= {:start} && closed_at <= {:end}",
      "closed_at",
      0,
      0,
      bounds
    );
  } catch (err) {
    sessions = [];
  }

  var table = [];
  var varianceTotal = 0;
  var byDayVariance = {};
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (!session) continue;
    var variance = session.getInt("variance");
    varianceTotal += variance;
    table.push({
      session_id: session.id,
      opened_at: session.getString("opened_at"),
      closed_at: session.getString("closed_at"),
      expected: session.getInt("expected"),
      counted: session.getInt("counted"),
      variance: variance,
    });
    var dayKey = (session.getString("closed_at") || "").slice(0, 10);
    if (dayKey) byDayVariance[dayKey] = (byDayVariance[dayKey] || 0) + variance;
  }

  var days = dates.eachDay(params.from, params.to);
  var byLabel = {};
  var labelOrder = [];
  for (var d = 0; d < days.length; d++) {
    var label = dates.groupLabel(days[d], params.group);
    if (!byLabel[label]) {
      byLabel[label] = { variance: 0 };
      labelOrder.push(label);
    }
    byLabel[label].variance += byDayVariance[days[d]] || 0;
  }
  var series = [];
  for (var l = 0; l < labelOrder.length; l++) series.push({ label: labelOrder[l], values: byLabel[labelOrder[l]] });

  var movements = [];
  try {
    movements = app.findRecordsByFilter(
      "cash_movements",
      "created >= {:start} && created <= {:end}",
      "",
      0,
      0,
      bounds
    );
  } catch (err) {
    movements = [];
  }
  var cashIn = 0;
  var cashOut = 0;
  var byDayMovement = {};
  for (var m = 0; m < movements.length; m++) {
    var movement = movements[m];
    if (!movement) continue;
    var amount = movement.getInt("amount");
    var dayKey2 = (movement.getString("created") || "").slice(0, 10);
    if (!byDayMovement[dayKey2]) byDayMovement[dayKey2] = { in: 0, out: 0 };
    if (amount >= 0) {
      cashIn += amount;
      byDayMovement[dayKey2].in += amount;
    } else {
      cashOut += -amount;
      byDayMovement[dayKey2].out += -amount;
    }
  }
  var byDay = [];
  for (var dd = 0; dd < days.length; dd++) {
    var entry = byDayMovement[days[dd]] || { in: 0, out: 0 };
    byDay.push({ date: days[dd], in: entry.in, out: entry.out });
  }

  var totals = {
    variance_total: varianceTotal,
    session_count: table.length,
    cash_in: cashIn,
    cash_out: cashOut,
    by_day: byDay,
  };

  return {
    series: series,
    table: table,
    totals: totals,
    csvColumns: [
      { key: "session_id", label: "Session id" },
      { key: "opened_at", label: "Opened at" },
      { key: "closed_at", label: "Closed at" },
      { key: "expected", label: "Expected", money: true },
      { key: "counted", label: "Counted", money: true },
      { key: "variance", label: "Variance", money: true },
    ],
  };
}

/** totals keys that are pence, not a plain count - lib/reports/scheduled.js's
 * emailed totals read this instead of guessing from the field name. */
var MONEY_FIELDS = { variance_total: true, cash_in: true, cash_out: true };

/** totals keys that are actually a function of params.from/to - every one
 * here is, all from sessions/movements queried within the range. */
var PERIOD_SCOPED_TOTALS = { variance_total: true, session_count: true, cash_in: true, cash_out: true, by_day: true };

module.exports = { build: build, MONEY_FIELDS: MONEY_FIELDS, PERIOD_SCOPED_TOTALS: PERIOD_SCOPED_TOTALS };
