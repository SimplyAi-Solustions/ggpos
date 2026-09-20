/**
 * Shared plumbing for the /api/vault/* routes: request body reading, the
 * settings and loyalty rows the routes need in the shapes the evaluators in
 * packages/shared expect, cash session maths, dates and CSV escaping.
 *
 * Anything that is pure business logic the frontend also needs lives in
 * packages/shared and reaches the hooks through lib/shared/*.js. What is
 * here is PocketBase-specific glue only.
 *
 * Every require() is inside the function that uses it, matching the rest of
 * pb_hooks - see pb/README.md on hook isolation.
 */

// ---------------------------------------------------------------------
// Request reading
// ---------------------------------------------------------------------

/** The parsed request body (JSON or multipart form) as a plain dict. */
function body(e) {
  try {
    var info = e.requestInfo();
    return (info && info.body) || {};
  } catch (err) {
    return {};
  }
}

/** A whole number from an untyped body value; `fallback` when unusable. */
function asInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback || 0;
  var n = Number(value);
  if (!isFinite(n)) return fallback || 0;
  return Math.round(n);
}

/** A trimmed string from an untyped body value. */
function asStr(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** A boolean from an untyped body value ("true"/"1"/true all count). */
function asBool(value) {
  if (value === true) return true;
  if (value === null || value === undefined) return false;
  var s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * Read a json field off a record as a JS value. PocketBase hands a json
 * field back as raw bytes, so this round-trips through toString/JSON.parse,
 * which also covers the case where it is already a plain object.
 */
function jsonField(record, name, fallback) {
  var raw;
  try {
    raw = record.get(name);
  } catch (err) {
    return fallback;
  }
  if (raw === null || raw === undefined) return fallback;
  var text;
  try {
    text = toString(raw);
  } catch (err) {
    return fallback;
  }
  if (!text || text === "null" || text === '""') return fallback;
  try {
    var parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

/** Refuse anyone but an admin staff member. Routes marked **admin**. */
function requireAdmin(e) {
  var auth = e.auth;
  if (!auth || auth.collection().name !== "staff" || auth.getString("role") !== "admin") {
    throw e.forbiddenError("Only an admin can do this. Ask Richard to run it for you.", null);
  }
  return auth;
}

// ---------------------------------------------------------------------
// Settings and loyalty rows
// ---------------------------------------------------------------------

/** The settings singleton, or null when the seed has not run. */
function settings(app) {
  try {
    return app.findFirstRecordByFilter("settings", "id != ''");
  } catch (err) {
    return null;
  }
}

/** OfferSettings (packages/shared/src/pricing.ts) from settings.offer. */
function offerSettings(app, settingsRecord) {
  var row = settingsRecord || settings(app);
  var fallback = { bulkThreshold: 100, bulkCash: 5, bulkCredit: 10, minimumOffer: 25 };
  if (!row) return fallback;
  var value = jsonField(row, "offer", null);
  if (!value || typeof value !== "object") return fallback;
  return {
    bulkThreshold: asInt(value.bulkThreshold, fallback.bulkThreshold),
    bulkCash: asInt(value.bulkCash, fallback.bulkCash),
    bulkCredit: asInt(value.bulkCredit, fallback.bulkCredit),
    minimumOffer: asInt(value.minimumOffer, fallback.minimumOffer),
  };
}

/** settings.email ({ from_name, from_address, reply_to, test_mode }). */
function emailSettings(app, settingsRecord) {
  var row = settingsRecord || settings(app);
  var fallback = { from_name: "", from_address: "", reply_to: "", test_mode: true };
  if (!row) return fallback;
  var value = jsonField(row, "email", null);
  if (!value || typeof value !== "object") return fallback;
  return {
    from_name: asStr(value.from_name),
    from_address: asStr(value.from_address),
    reply_to: asStr(value.reply_to),
    // Anything but an explicit false keeps test mode on, so a half-filled
    // settings row never starts emailing customers.
    test_mode: value.test_mode === false ? false : true,
  };
}

/** LoyaltyProgramme (packages/shared/src/loyalty.ts) from loyalty_programme. */
function programme(app) {
  var row = null;
  try {
    row = app.findFirstRecordByFilter("loyalty_programme", "id != ''");
  } catch (err) {
    row = null;
  }
  if (!row) {
    return {
      enabled: false,
      earnPerPoundSales: 0,
      earnPerPoundTradeInCredit: 0,
      pointsPerPoundRedemption: 100,
      minRedeemPoints: 0,
      maxPointsShareOfSale: 0,
      expiryMonthsInactive: 0,
      tierWindowMonths: 0,
      welcomeBonus: 0,
      referralBonusReferrer: 0,
      referralBonusReferee: 0,
    };
  }
  return {
    enabled: row.getBool("enabled"),
    earnPerPoundSales: row.getInt("earn_per_pound_sales"),
    earnPerPoundTradeInCredit: row.getInt("earn_on_trade_in_credit"),
    pointsPerPoundRedemption: row.getInt("points_per_pound_redemption") || 100,
    minRedeemPoints: row.getInt("min_redeem_points"),
    maxPointsShareOfSale: row.getFloat("max_points_share_of_sale"),
    expiryMonthsInactive: row.getInt("expiry_months_inactive"),
    tierWindowMonths: row.getInt("tier_window_months"),
    welcomeBonus: row.getInt("welcome_bonus"),
    referralBonusReferrer: row.getInt("referral_bonus_referrer"),
    referralBonusReferee: row.getInt("referral_bonus_referee"),
  };
}

/** Every loyalty_rules row as LoyaltyRule[], live filtering left to the evaluator. */
function loyaltyRules(app) {
  var rows = [];
  try {
    rows = app.findRecordsByFilter("loyalty_rules", "id != ''", "-priority", 0, 0);
  } catch (err) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r) continue;
    out.push({
      id: r.id,
      name: r.getString("name"),
      type: r.getString("type"),
      conditions: jsonField(r, "conditions", {}) || {},
      value: r.getFloat("value"),
      active: r.getBool("active"),
      priority: r.getInt("priority"),
      startsAt: r.getString("starts_at") || null,
      endsAt: r.getString("ends_at") || null,
    });
  }
  return out;
}

/** One loyalty_tiers row as a LoyaltyTier, or null. */
function tier(app, tierId) {
  if (!tierId) return null;
  var row = null;
  try {
    row = app.findRecordById("loyalty_tiers", tierId);
  } catch (err) {
    return null;
  }
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
  var rawPerks = jsonField(row, "perks", []) || [];
  var perks = [];
  for (var i = 0; i < rawPerks.length; i++) {
    var perk = loyalty.parseTierPerk(rawPerks[i]);
    if (perk) perks.push(perk);
  }
  return {
    id: row.id,
    name: row.getString("name"),
    thresholdPoints: row.getInt("threshold_points"),
    sort: row.getInt("sort"),
    perks: perks,
    paidPlan: row.getBool("paid_plan"),
  };
}

// ---------------------------------------------------------------------
// Cash sessions
// ---------------------------------------------------------------------

/** The one open cash session, or null. */
function openCashSession(app) {
  try {
    return app.findFirstRecordByFilter("cash_sessions", "closed_at = ''");
  } catch (err) {
    return null;
  }
}

/** Every movement on a session, oldest first. */
function sessionMovements(app, sessionId) {
  try {
    return app.findRecordsByFilter(
      "cash_movements",
      "session = {:session}",
      "created",
      0,
      0,
      { session: sessionId }
    );
  } catch (err) {
    return [];
  }
}

/**
 * What the drawer should hold: the opening float plus every movement.
 *
 * cash_movements.amount is signed (the migration says so, and `adjustment`
 * has no other way to say which way the money went), so money out - a
 * payout, a refund, a bank drop - is stored negative and this is a plain
 * sum rather than a per-type add or subtract.
 */
function sessionExpected(app, session) {
  var total = session.getInt("float");
  var movements = sessionMovements(app, session.id);
  for (var i = 0; i < movements.length; i++) {
    if (movements[i]) total += movements[i].getInt("amount");
  }
  return total;
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------

/** Now as an ISO 8601 UTC string, the form every date field here stores. */
function nowIso() {
  return new Date().toISOString();
}

/** `date` plus `months`, clamped to the end of the target month. */
function addMonths(date, months) {
  var d = new Date(date.getTime());
  var day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  var lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Whole years between `dob` and `at`, or null when dob is unusable. */
function ageAt(dob, at) {
  if (!dob) return null;
  var born = new Date(dob);
  if (isNaN(born.getTime())) return null;
  var years = at.getUTCFullYear() - born.getUTCFullYear();
  var monthDiff = at.getUTCMonth() - born.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < born.getUTCDate())) years -= 1;
  return years;
}

/** True when `value` is a date that has already passed. */
function isPast(value, at) {
  if (!value) return false;
  var d = new Date(value);
  if (isNaN(d.getTime())) return false;
  return d.getTime() < at.getTime();
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

/** Pence as a plain pounds figure with two decimals, no symbol: 1234.56. */
function poundsCell(pence) {
  var negative = pence < 0;
  var abs = Math.abs(Math.round(pence));
  var whole = Math.floor(abs / 100);
  var rem = abs % 100;
  return (negative ? "-" : "") + whole + "." + (rem < 10 ? "0" + rem : String(rem));
}

/** A cell that is already a plain number, which must stay a number. */
var NUMERIC_CELL = /^-?\d+(\.\d+)?$/;

/** A cell a spreadsheet would try to evaluate rather than display. */
var FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell, quoted only when it has to be.
 *
 * Text that opens with =, +, -, @, a tab or a carriage return is prefixed
 * with a single quote and quoted, so a seller called `=HYPERLINK("x")`
 * lands in Excel or Numbers as text rather than as a formula the shop's
 * accountant is asked to run. A cell that is already a plain number
 * (anything poundsCell produced, including a negative margin) is exempt, so
 * the money columns stay numeric.
 */
function csvCell(value) {
  var s = value === null || value === undefined ? "" : String(value);
  if (s !== "" && !NUMERIC_CELL.test(s) && FORMULA_START.test(s)) {
    return '"' + ("'" + s).replace(/"/g, '""') + '"';
  }
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** One CSV line from an array of values, CRLF terminated (RFC 4180). */
function csvRow(values) {
  var cells = [];
  for (var i = 0; i < values.length; i++) cells.push(csvCell(values[i]));
  return cells.join(",") + "\r\n";
}

module.exports = {
  body: body,
  asInt: asInt,
  asStr: asStr,
  asBool: asBool,
  jsonField: jsonField,
  requireAdmin: requireAdmin,
  settings: settings,
  offerSettings: offerSettings,
  emailSettings: emailSettings,
  programme: programme,
  loyaltyRules: loyaltyRules,
  tier: tier,
  openCashSession: openCashSession,
  sessionMovements: sessionMovements,
  sessionExpected: sessionExpected,
  nowIso: nowIso,
  addMonths: addMonths,
  ageAt: ageAt,
  isPast: isPast,
  poundsCell: poundsCell,
  csvCell: csvCell,
  csvRow: csvRow,
};
