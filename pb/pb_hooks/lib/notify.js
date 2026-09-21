/**
 * The one place a `notifications` row is written and, optionally, emailed -
 * so a quote offer, a want-list match and every other customer- or
 * staff-facing event in Phase 5 write the row the same way and cannot drift
 * on what a notification looks like.
 *
 * Push itself never happens here: `notifications.pushed_at` starts empty on
 * every row this writes, and `services/notify` (a separate Node sidecar,
 * not pb_hooks) polls for rows with an empty `pushed_at` and a matching
 * `push_subscriptions` row, sends through Web Push, and stamps `pushed_at`.
 * That is what "email and push" means throughout docs/api-contract.md's
 * Phase 5 section: this module writes the row (which is push-eligible the
 * moment it exists) and, when `email: true`, *builds* the email to send.
 *
 * `notify()` never actually sends mail itself (fix round, finding 7): every
 * call site in this package calls it from inside an `app.runInTransaction`,
 * and PocketBase holds that transaction's write lock for as long as the
 * callback runs - an outbound SMTP call blocking or hanging in there would
 * hold up every other write to the database for no reason a customer would
 * ever see, and a mail send is not something that needs to be atomic with
 * the row it is about anyway. `notify()` instead returns
 * `{ records, pending }`, and the caller sends `pending` through
 * `sendPending()` once its own `runInTransaction` has returned (the same
 * "write inside the transaction, act on the outside world after it
 * commits" shape as `tradeins.pb.js`'s own routes already use for a
 * receipt's own email route). A cron with no transaction of its own opens
 * one per item it touches, for the same reason (see quotes.pb.js's
 * `quotes_expire` and lib/wants.js's `matchOnStock`/`releaseExpiredHolds`).
 *
 * Email honours `settings.email.test_mode` exactly the way
 * lib/receipts.js's own email route does: a plain-text body, the shop name
 * and reply-to from settings, no tracking, and a log line instead of a real
 * send while test_mode is on (seeded on, so a fresh install cannot email
 * anyone by accident).
 *
 * Transaction-agnostic like lib/audit.js, lib/counters.js and
 * lib/balances.js: pass $app, e.app, or a txApp from
 * $app.runInTransaction. require() this from inside each handler, not at
 * file top level - see pb/README.md on pb_hooks isolation.
 */

/** Never logs an address - only that a customer or staff member on file was (or would be) emailed. */
function sendEmail(app, settingsRow, to, subject, text) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var emailSettings = util.emailSettings(app, settingsRow);

  if (!to) {
    return { sent: false, reason: "no_email" };
  }
  if (emailSettings.test_mode) {
    console.log(`[notify:test_mode] would email "${subject}" to a customer or staff member on file (not sent)`);
    return { sent: false, test_mode: true };
  }

  var appSettings = app.settings();
  var fromAddress =
    emailSettings.from_address || (appSettings.meta ? appSettings.meta.senderAddress : "");
  var fromName =
    emailSettings.from_name ||
    (appSettings.meta ? appSettings.meta.senderName : (settingsRow ? settingsRow.getString("shop_name") : "")) ||
    "GG Vault";
  if (!fromAddress) {
    console.log(`[notify] no sender address is configured; could not email "${subject}"`);
    return { sent: false, reason: "no_sender" };
  }

  var message = new MailerMessage({
    from: { address: fromAddress, name: fromName },
    to: [{ address: to }],
    subject: subject,
    text: text,
  });
  if (emailSettings.reply_to) {
    message.headers = { "Reply-To": emailSettings.reply_to };
  }

  try {
    app.newMailClient().send(message);
    return { sent: true };
  } catch (err) {
    console.log(`[notify:send] ${err}`);
    return { sent: false, reason: "send_failed" };
  }
}

/**
 * `path` (an in-app path such as `/account/quotes/xyz`) made absolute
 * against this instance's own configured app URL, so a link inside an
 * email is actually clickable rather than a bare path with nothing to
 * resolve it against (fix round, finding 15). `app.settings().meta.appURL`
 * is the same real PocketBase platform setting `adapters/images.js`'s own
 * `publicFileUrl` already builds an absolute URL from - not a new
 * `settings.shop.portal_url` field, since PocketBase already has a home
 * for "what is this instance's own base URL" and nothing here needs a
 * second one. Falls back to the bare path when appURL was never set
 * (a fresh, not-yet-configured install), rather than sending no link at
 * all.
 */
function absoluteLink(app, path) {
  if (!path) return path;
  var base = "";
  try {
    base = app.settings().meta.appURL || "";
  } catch (err) {
    base = "";
  }
  return base ? base.replace(/\/+$/, "") + path : path;
}

/**
 * @param {any} app
 * @param {{
 *   customer?: string,
 *   staffAll?: boolean,
 *   type: string,
 *   title: string,
 *   body: string,
 *   link?: string,
 *   email?: boolean,
 * }} opts `link` is optional here but never actually blank on a customer
 *   row: an omitted `link` for a `customer` target falls back to
 *   `/account/notifications`, so every customer-facing notification
 *   always carries an in-app path to open. A `staffAll` row has no such
 *   fallback - every call in this package already sets its own
 *   `/counter/...` link.
 * @returns {{records: Array<any>, pending: Array<{to:string,subject:string,text:string}>}}
 *   `records` is every `notifications` row written. `pending` is every
 *   email this call would send - never sent here; the caller passes it to
 *   `sendPending()` once its own transaction (if any) has committed.
 */
function notify(app, opts) {
  opts = opts || {};
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var notifications = app.findCollectionByNameOrId("notifications");

  var targets = []; // {customer?, staff?, emailTo}
  if (opts.staffAll) {
    var staffRows = [];
    try {
      staffRows = app.findRecordsByFilter(
        "staff",
        'role = "admin" && active = true',
        "created",
        0,
        0
      );
    } catch (err) {
      staffRows = [];
    }
    for (var i = 0; i < staffRows.length; i++) {
      if (!staffRows[i]) continue;
      targets.push({ staff: staffRows[i].id, emailTo: staffRows[i].getString("email") });
    }
  } else if (opts.customer) {
    var emailTo = "";
    try {
      var customerRow = app.findRecordById("customers", opts.customer);
      // The Phase 5 migration backfills every existing customer's
      // notify_email to true and customers.pb.js's own create hook does the
      // same for a new one, so false here is always a genuine, explicit
      // opt-out (PATCH /api/vault/me's notifications.email), never an
      // unset field silently read as "no".
      emailTo = customerRow.getBool("notify_email") ? customerRow.getString("email") : "";
    } catch (err) {
      emailTo = "";
    }
    targets.push({ customer: opts.customer, emailTo: emailTo });
  }

  // A customer-facing row always carries an in-app path, never a blank
  // link: /account/quotes/<id> for a quote event, /account/wants for a
  // want-list hold, and this fallback for anything else - the one place
  // that rule is enforced, rather than trusting every call site to set
  // its own link. Staff rows have no such fallback: every staffAll call
  // in this package already sets its own /counter/... link explicitly.
  var fallbackLink = opts.customer ? "/account/notifications" : "";

  var written = [];
  var pending = [];
  for (var t = 0; t < targets.length; t++) {
    var record = new Record(notifications, {
      type: opts.type || "",
      title: opts.title || "",
      body: opts.body || "",
      link: opts.link || fallbackLink,
    });
    if (targets[t].customer) record.set("customer", targets[t].customer);
    if (targets[t].staff) record.set("staff", targets[t].staff);
    app.save(record);
    written.push(record);

    if (opts.email && targets[t].emailTo) {
      var text = opts.body || "";
      var emailLink = opts.link || fallbackLink;
      if (emailLink) text += "\n\n" + absoluteLink(app, emailLink);
      pending.push({ to: targets[t].emailTo, subject: opts.title || "", text: text });
    }
  }

  return { records: written, pending: pending };
}

/**
 * Actually deliver every pending email a `notify()` call (or several)
 * built - called once, after the caller's own `runInTransaction` has
 * returned, never from inside one (fix round, finding 7). Resolves
 * `settings` itself, right before sending, since nothing before this point
 * needed it. Never throws: a bad address, a down mail transport or
 * test_mode are exactly what `sendEmail`'s own log line already covers,
 * one call at a time, so one failed send in a batch never stops the rest.
 */
function sendPending(app, pending) {
  if (!pending || !pending.length) return;
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var settingsRow = util.settings(app);
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    if (!p) continue;
    sendEmail(app, settingsRow, p.to, p.subject, p.text);
  }
}

module.exports = { notify: notify, sendEmail: sendEmail, sendPending: sendPending };
