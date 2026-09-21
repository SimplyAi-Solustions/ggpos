/**
 * Weekly and monthly saved_reports sends (docs/PLAN.md, "Reporting" and
 * "Notifications and receipts"; docs/api-contract.md, Phase 4).
 *
 * crons.pb.js registers two crons, one per schedule: "scheduled_reports_weekly"
 * fires every Monday at 08:00 UTC and "scheduled_reports_monthly" fires on
 * the 1st of the month at 08:00 UTC. Which day each one runs on is the cron
 * expression's job, not this file's - sendBySchedule sends every
 * saved_reports row of the given schedule unconditionally, so PocketBase's
 * own "run this job now" route (POST /api/crons/scheduled_reports_weekly or
 * _monthly) is a faithful, day-independent way to exercise either one,
 * which is what pb/scripts/check.sh does.
 *
 * Each send emails the report's totals as plain text and its table as a
 * CSV attachment, through the app mail client the same way
 * pb_hooks/lib/receipts.js does, and honours settings.email.test_mode (log
 * instead of send, so a fresh install cannot email anyone by accident).
 * Every send is audited by the saved_reports row's id alone.
 *
 * require() this from inside crons.pb.js's handler - see pb/README.md.
 */

/** {from, to} for one saved report's send, from its own schedule. */
function periodFor(schedule, now) {
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  if (schedule === "monthly") return dates.lastMonthRange(now);
  return dates.lastWeekRange(now);
}

/**
 * A report's totals as plain-text lines, money through the shared
 * formatGBP. `moneyFields` is the sending builder's own MONEY_FIELDS
 * export - an explicit, per-report declaration of which totals keys are
 * pence, not a guess at what a field name might mean (a name like
 * "points_earned" or "sell_through_ratio" would have matched an earlier
 * regex heuristic here on "earned"/"through" and printed a point count or
 * a ratio as if it were a sum of pence).
 */
function totalsText(totals, money, moneyFields) {
  var lines = [];
  var names = Object.keys(totals);
  for (var i = 0; i < names.length; i++) {
    var value = totals[names[i]];
    if (typeof value !== "number") continue;
    var isMoney = !!(moneyFields && moneyFields[names[i]]);
    lines.push(names[i] + ": " + (isMoney ? money.formatGBP(value) : value));
  }
  return lines;
}

/** A plausible email shape - enough to catch a typo or stray non-address
 * string before it reaches a MailerMessage, not exhaustive RFC 5322. */
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A saved report emails at most this many addresses in one send. */
var MAX_RECIPIENTS = 10;

/**
 * `raw` (saved_reports.recipients, or the owner's own address as a
 * fallback) kept to well-formed-looking, de-duplicated addresses and
 * capped at MAX_RECIPIENTS. saved_reports' own rules (this phase's
 * migration) already restrict who can set `recipients` at all, but the
 * cron re-checks what it reads back off a stored row rather than trusting
 * it unseen - a row saved before that rule existed, or written directly
 * against the database, is not assumed to be well formed.
 */
function validRecipients(raw) {
  var seen = {};
  var out = [];
  for (var i = 0; i < raw.length && out.length < MAX_RECIPIENTS; i++) {
    var address = String(raw[i] || "").trim();
    if (!address || !EMAIL_RE.test(address) || seen[address]) continue;
    seen[address] = true;
    out.push(address);
  }
  return out;
}

/** True when `ownerId` resolves to a staff row that is an admin right now -
 * checked again here, not assumed from the row's own history: an owner
 * demoted from admin after saving an admin-only report (report_key =
 * "compliance", registryLib.ADMIN_ONLY_KEYS) must stop receiving it. */
function ownerIsActiveAdmin(app, ownerId) {
  if (!ownerId) return false;
  try {
    var owner = app.findRecordById("staff", ownerId);
    return owner.getString("role") === "admin" && owner.getBool("active");
  } catch (err) {
    return false;
  }
}

/**
 * Sends (or logs, in test_mode) every saved_reports row whose `schedule`
 * matches (`"weekly"` or `"monthly"`), for the period that schedule implies
 * ending just before `now`. Returns how many were sent or logged.
 */
function sendBySchedule(app, schedule, now) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var auditLib = require(`${__hooks}/lib/audit.js`);
  var registryLib = require(`${__hooks}/lib/reports/registry.js`);
  var csv = require(`${__hooks}/lib/reports/csv.js`);
  var money = require(`${__hooks}/lib/shared/money.js`);

  var builders = registryLib.registry();
  var settings = util.settings(app);
  var emailSettings = util.emailSettings(app, settings);
  var appSettings = app.settings();
  var fromAddress = emailSettings.from_address || (appSettings.meta ? appSettings.meta.senderAddress : "");
  var fromName = emailSettings.from_name || (appSettings.meta ? appSettings.meta.senderName : "GG Entertainment");

  var due = [];
  try {
    due = app.findRecordsByFilter("saved_reports", "schedule = {:schedule}", "", 0, 0, { schedule: schedule });
  } catch (err) {
    due = [];
  }

  var period = periodFor(schedule, now);
  var sent = 0;
  for (var i = 0; i < due.length; i++) {
    var saved = due[i];
    if (!saved) continue;
    var key = saved.getString("report_key");
    var builder = builders[key];
    if (!builder) {
      console.log(`[scheduled_reports] saved report ${saved.id} names an unknown key '${key}', skipped`);
      continue;
    }

    // Admin-only report keys (registryLib.ADMIN_ONLY_KEYS - "compliance"
    // today) may only ever be sent while the row's own owner is a current
    // admin - the same rule the live report route enforces (reports.pb.js)
    // and saved_reports' own rules enforce on *setting* recipients/schedule
    // in the first place (this phase's migration). The cron runs as the
    // superuser and bypasses collection rules entirely, so it checks this
    // again itself rather than trusting either of those layers alone -
    // defence in depth: an owner demoted after saving the row, or a row
    // written straight against the database, still cannot leak a
    // compliance report to whoever is listed.
    if (registryLib.ADMIN_ONLY_KEYS[key] && !ownerIsActiveAdmin(app, saved.getString("owner"))) {
      console.log(
        `[scheduled_reports] saved report ${saved.id} names admin-only key '${key}' but its owner is not a current admin, skipped`
      );
      auditLib.writeAuditLog(app, {
        actor: "system",
        action: "saved_report_skipped",
        collection: "saved_reports",
        record: saved.id,
        meta: { reason: "admin_only" },
        ip: "",
      });
      continue;
    }

    var filters = util.jsonField(saved, "filters", {}) || {};
    var params = { from: period.from, to: period.to, group: filters.group || "day", by: filters.by || "" };

    var result;
    try {
      result = builder.build(app, util, params);
    } catch (err) {
      console.log(`[scheduled_reports] building '${key}' for saved report ${saved.id} failed: ${err}`);
      continue;
    }

    // Recipients are re-validated here, not trusted as saved: well-formed
    // email shape, de-duplicated, capped at MAX_RECIPIENTS - see
    // validRecipients.
    var recipients = validRecipients(util.jsonField(saved, "recipients", []) || []);
    if (recipients.length === 0 && saved.getString("owner")) {
      try {
        var owner = app.findRecordById("staff", saved.getString("owner"));
        if (owner.getString("email")) recipients = validRecipients([owner.getString("email")]);
      } catch (err) {
        recipients = [];
      }
    }
    if (recipients.length === 0) {
      console.log(`[scheduled_reports] saved report ${saved.id} has no valid recipients, skipped`);
      continue;
    }

    var name = saved.getString("name") || key;
    var subject = `GG Vault report: ${name} (${period.from} to ${period.to})`;
    var lines = [subject, ""].concat(totalsText(result.totals, money, builder.MONEY_FIELDS || {}));
    var text = lines.join("\n");
    var csvText = csv.renderTable(util, result.csvColumns, result.table);
    var filename = `${key}-${period.from}-to-${period.to}.csv`;

    if (emailSettings.test_mode) {
      console.log(
        `[scheduled_reports:test_mode] would email '${name}' (${key}) to ${recipients.join(", ")} (not sent)`
      );
      auditLib.writeAuditLog(app, {
        actor: "system",
        action: "saved_report_sent",
        collection: "saved_reports",
        record: saved.id,
        meta: { sent: false, test_mode: true },
        ip: "",
      });
      sent += 1;
      continue;
    }

    if (!fromAddress) {
      console.log(`[scheduled_reports] no sender address configured, saved report ${saved.id} skipped`);
      continue;
    }

    var to = [];
    for (var r = 0; r < recipients.length; r++) to.push({ address: recipients[r] });

    var attachments = {};
    attachments[filename] = $filesystem.fileFromBytes(csvText, filename);

    var message = new MailerMessage({
      from: { address: fromAddress, name: fromName },
      to: to,
      subject: subject,
      text: text,
      attachments: attachments,
    });
    try {
      app.newMailClient().send(message);
    } catch (err) {
      console.log(`[scheduled_reports] send failed for saved report ${saved.id}: ${err}`);
      continue;
    }

    auditLib.writeAuditLog(app, {
      actor: "system",
      action: "saved_report_sent",
      collection: "saved_reports",
      record: saved.id,
      meta: { sent: true, test_mode: false },
      ip: "",
    });
    sent += 1;
  }
  return sent;
}

module.exports = { sendBySchedule: sendBySchedule, periodFor: periodFor };
