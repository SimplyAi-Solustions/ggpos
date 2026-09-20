/**
 * Pure date and range helpers for the reports package (pb_hooks/reports.pb.js,
 * stats.pb.js and the reports crons in crons.pb.js). UTC throughout, per
 * CLAUDE.md.
 *
 * PocketBase stores every date/autodate field as "YYYY-MM-DD HH:MM:SS.sssZ"
 * (a space, not a "T"), and a filter compares it as text - see
 * crons.pb.js's own pbDate() and exports.pb.js's acquired_at range for the
 * same reasoning. dayStartPb/dayEndPb/rangeParams below are that same form,
 * so every filter in lib/reports/*.js can pass {:start} and {:end} straight
 * through to PocketBase with no second conversion.
 *
 * This file makes no PocketBase calls, so it needs no require() of its
 * own; require() it from inside each function that uses it, matching the
 * rest of pb_hooks - see pb/README.md on hook isolation.
 */

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form (rejects "2026-02-30"). */
function isValidDateStr(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  var d = new Date(value + "T00:00:00.000Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's date in UTC, as YYYY-MM-DD. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** `dateStr` plus `n` days (n may be negative), as YYYY-MM-DD. */
function addDays(dateStr, n) {
  var d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromStr` to `toStr`, inclusive of both ends. */
function daysBetweenInclusive(fromStr, toStr) {
  var a = Date.parse(fromStr + "T00:00:00.000Z");
  var b = Date.parse(toStr + "T00:00:00.000Z");
  return Math.round((b - a) / 86400000) + 1;
}

/** The PocketBase-stored start-of-day form for a YYYY-MM-DD date. */
function dayStartPb(dateStr) {
  return dateStr + " 00:00:00.000Z";
}

/** The PocketBase-stored end-of-day form for a YYYY-MM-DD date. */
function dayEndPb(dateStr) {
  return dateStr + " 23:59:59.999Z";
}

/** {start, end} PocketBase-form bounds covering a whole from/to range. */
function rangeParams(fromStr, toStr) {
  return { start: dayStartPb(fromStr), end: dayEndPb(toStr) };
}

/** The Monday (YYYY-MM-DD) of the ISO week `dateStr` falls in. */
function mondayOf(dateStr) {
  var d = new Date(dateStr + "T00:00:00.000Z");
  var dow = d.getUTCDay(); // 0 Sunday .. 6 Saturday
  var sinceMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday);
  return d.toISOString().slice(0, 10);
}

/** The calendar month (YYYY-MM) `dateStr` falls in. */
function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

/** The first day (YYYY-MM-DD) of the calendar month `dateStr` falls in. */
function monthStart(dateStr) {
  return dateStr.slice(0, 7) + "-01";
}

/** The series label for `dateStr` under `group` (day, week or month) - week
 * labels are always the Monday of that week, month labels YYYY-MM. */
function groupLabel(dateStr, group) {
  if (group === "week") return mondayOf(dateStr);
  if (group === "month") return monthOf(dateStr);
  return dateStr;
}

/**
 * Every YYYY-MM-DD date from `fromStr` to `toStr`, inclusive. Bounded to
 * 401 entries so a caller that forgets to validate the range first still
 * cannot spin forever.
 */
function eachDay(fromStr, toStr) {
  var out = [];
  var cur = fromStr;
  var guard = 0;
  while (cur <= toStr && guard < 401) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

/**
 * The immediately preceding period of the same length as [fromStr, toStr],
 * for `compare=previous` (docs/api-contract.md, Phase 4).
 */
function previousPeriod(fromStr, toStr) {
  var len = daysBetweenInclusive(fromStr, toStr);
  var prevTo = addDays(fromStr, -1);
  var prevFrom = addDays(prevTo, -(len - 1));
  return { from: prevFrom, to: prevTo };
}

/** `date.getUTCDay()` reindexed so Monday is 0 and Sunday is 6. */
function isoWeekday(date) {
  return (date.getUTCDay() + 6) % 7;
}

/**
 * The UK civil clock (Europe/London: GMT, or BST from 01:00 UTC on the
 * last Sunday of March to 01:00 UTC on the last Sunday of October), for
 * the staffing heatmap only - every day bucket (`groupLabel`, `eachDay`,
 * `rangeParams`) stays plain UTC, so a Monday is the same calendar day
 * everywhere in this package except the heatmap's own hour and weekday.
 *
 * goja has no reliable Intl (no time zone database), so the rule is
 * reproduced by hand here rather than trusted to Intl.DateTimeFormat -
 * the same reasoning as this file's own PocketBase-stored-date note
 * above, applied to a different platform gap.
 */

/** The last Sunday of `monthIndex` (0-based) in `year`, at UTC midnight. */
function lastSundayUtc(year, monthIndex) {
  var d = new Date(Date.UTC(year, monthIndex + 1, 0)); // last day of the month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to the Sunday on or before it
  return d;
}

/** True when `date` falls in British Summer Time. */
function isBst(date) {
  var year = date.getUTCFullYear();
  var marchLastSunday = lastSundayUtc(year, 2); // March
  var octLastSunday = lastSundayUtc(year, 9); // October
  var bstStart = Date.UTC(
    marchLastSunday.getUTCFullYear(),
    marchLastSunday.getUTCMonth(),
    marchLastSunday.getUTCDate(),
    1
  );
  var bstEnd = Date.UTC(
    octLastSunday.getUTCFullYear(),
    octLastSunday.getUTCMonth(),
    octLastSunday.getUTCDate(),
    1
  );
  var t = date.getTime();
  return t >= bstStart && t < bstEnd;
}

/**
 * `date` shifted so its own UTC-getter fields (getUTCDay, getUTCHours, ...)
 * read as the UK civil clock would at that instant - GMT is +0, BST +60
 * minutes. Only ever used for the sales report's hour-of-day heatmap.
 */
function toLondon(date) {
  var offsetMinutes = isBst(date) ? 60 : 0;
  return new Date(date.getTime() + offsetMinutes * 60000);
}

/** {from, to} covering the last full Monday-to-Sunday week before `now`. */
function lastWeekRange(now) {
  var today = now.toISOString().slice(0, 10);
  var mondayThisWeek = mondayOf(today);
  var sunday = addDays(mondayThisWeek, -1);
  var monday = addDays(sunday, -6);
  return { from: monday, to: sunday };
}

/** {from, to} covering the last full calendar month before `now`. */
function lastMonthRange(now) {
  var firstOfThisMonth = now.toISOString().slice(0, 7) + "-01";
  var lastOfPrevMonth = addDays(firstOfThisMonth, -1);
  return { from: monthStart(lastOfPrevMonth), to: lastOfPrevMonth };
}

module.exports = {
  isValidDateStr: isValidDateStr,
  todayUtc: todayUtc,
  addDays: addDays,
  daysBetweenInclusive: daysBetweenInclusive,
  dayStartPb: dayStartPb,
  dayEndPb: dayEndPb,
  rangeParams: rangeParams,
  mondayOf: mondayOf,
  monthOf: monthOf,
  monthStart: monthStart,
  groupLabel: groupLabel,
  eachDay: eachDay,
  previousPeriod: previousPeriod,
  isoWeekday: isoWeekday,
  lastWeekRange: lastWeekRange,
  lastMonthRange: lastMonthRange,
};
