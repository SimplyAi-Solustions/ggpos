/**
 * The Monday 08:00 UTC admin digest: sales, buy-ins, margin, new customers,
 * cash variance and the three biggest price movers over 15 percent, for
 * every admin with an email on file (docs/PLAN.md, "Notifications and
 * receipts" and "Reporting"; docs/api-contract.md, Phase 4). Plain text,
 * every money figure through the shared formatGBP. Honours
 * settings.email.test_mode (log instead of send).
 *
 * Every send (or logged test_mode send) is audited with the three movers'
 * SKUs in meta - items.sku is already one of the labels audit.pb.js treats
 * as safe to record (pb/README.md), and it is the only way this send is
 * checkable without re-deriving the movers by hand.
 *
 * require() this from inside crons.pb.js's handler - see pb/README.md.
 */

function send(app, now) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var auditLib = require(`${__hooks}/lib/audit.js`);
  var dates = require(`${__hooks}/lib/reports/dates.js`);
  var daily = require(`${__hooks}/lib/reports/daily.js`);
  var salesReport = require(`${__hooks}/lib/reports/sales.js`);
  var buyinsReport = require(`${__hooks}/lib/reports/buyins.js`);
  var marginReport = require(`${__hooks}/lib/reports/margin.js`);
  var stockReport = require(`${__hooks}/lib/reports/stock.js`);
  var money = require(`${__hooks}/lib/shared/money.js`);

  var period = dates.lastWeekRange(now);
  var params = { from: period.from, to: period.to, group: "day", by: "" };

  var sales = salesReport.build(app, util, params);
  var buyins = buyinsReport.build(app, util, params);
  var margin = marginReport.build(app, util, params);
  var stock = stockReport.build(app, util, params);

  var days = dates.eachDay(period.from, period.to);
  var newCustomers = 0;
  var cashVariance = 0;
  for (var d = 0; d < days.length; d++) {
    var row = daily.rowForDate(app, days[d]);
    newCustomers += row.new_customers;
    cashVariance += row.cash_variance;
  }

  var movers = stock.table.slice(0, 3);
  var moverSkus = [];
  for (var mv = 0; mv < movers.length; mv++) moverSkus.push(movers[mv].sku);

  var lines = [];
  lines.push(`GG Vault weekly digest, ${period.from} to ${period.to}`);
  lines.push("");
  lines.push(
    `Sales: ${money.formatGBP(sales.totals.revenue)} across ${sales.totals.count} sale(s), average basket ${money.formatGBP(sales.totals.avg_basket)}`
  );
  lines.push(`Buy-ins: ${money.formatGBP(buyins.totals.spend)} across ${buyins.totals.count} buy-in(s)`);
  lines.push(`Margin: ${money.formatGBP(margin.totals.margin)} (${margin.totals.margin_pct}%)`);
  lines.push(`New customers: ${newCustomers}`);
  lines.push(`Cash variance: ${money.formatGBP(cashVariance)}`);
  lines.push("");
  if (movers.length > 0) {
    lines.push("Biggest price movers:");
    for (var m = 0; m < movers.length; m++) {
      var mover = movers[m];
      var sign = mover.pct_change > 0 ? "+" : "";
      lines.push(
        `  ${mover.title || mover.sku} (${mover.sku}): ${money.formatGBP(mover.market_at_intake)} to ${money.formatGBP(mover.latest_market)} (${sign}${mover.pct_change}%)`
      );
    }
  } else {
    lines.push("No price movers over 15 percent this week.");
  }
  var text = lines.join("\n");

  var admins = [];
  try {
    admins = app.findRecordsByFilter("staff", "role = 'admin' && active = true && email != ''", "", 0, 0);
  } catch (err) {
    admins = [];
  }
  if (admins.length === 0) {
    console.log("[weekly_digest] no active admin has an email on file, nothing sent");
    return { sent: 0, movers: moverSkus };
  }

  var settings = util.settings(app);
  var emailSettings = util.emailSettings(app, settings);

  if (emailSettings.test_mode) {
    console.log(`[weekly_digest:test_mode] would email ${admins.length} admin(s) (not sent):\n${text}`);
    auditLib.writeAuditLog(app, {
      actor: "system",
      action: "weekly_digest_sent",
      collection: "settings",
      record: "",
      meta: { sent: false, test_mode: true, recipients: admins.length, movers: moverSkus },
      ip: "",
    });
    return { sent: 0, movers: moverSkus };
  }

  var appSettings = app.settings();
  var fromAddress = emailSettings.from_address || (appSettings.meta ? appSettings.meta.senderAddress : "");
  var fromName = emailSettings.from_name || (appSettings.meta ? appSettings.meta.senderName : "GG Entertainment");
  if (!fromAddress) {
    console.log("[weekly_digest] no sender address configured, digest not sent");
    return { sent: 0, movers: moverSkus };
  }

  var to = [];
  for (var a = 0; a < admins.length; a++) to.push({ address: admins[a].getString("email") });

  var message = new MailerMessage({
    from: { address: fromAddress, name: fromName },
    to: to,
    subject: `GG Vault weekly digest, ${period.from} to ${period.to}`,
    text: text,
  });
  try {
    app.newMailClient().send(message);
  } catch (err) {
    console.log(`[weekly_digest] send failed: ${err}`);
    return { sent: 0, movers: moverSkus };
  }

  auditLib.writeAuditLog(app, {
    actor: "system",
    action: "weekly_digest_sent",
    collection: "settings",
    record: "",
    meta: { sent: true, test_mode: false, recipients: admins.length, movers: moverSkus },
    ip: "",
  });
  return { sent: admins.length, movers: moverSkus };
}

module.exports = { send: send };
