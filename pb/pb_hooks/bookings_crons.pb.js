/// <reference path="../pb_data/types.d.ts" />

/**
 * bookings_crons.pb.js - the two booking crons (docs/api-contract-launch.md,
 * section 4, "Reminders"), kept beside the routes rather than in crons.pb.js:
 * one cronAdd() per job, logic in lib/bookings.js.
 *
 * - `bookings_remind` (09:05 UTC, 10:05 in summer): tomorrow's held and
 *   confirmed bookings and entries get a reminder, once each, as a
 *   notification (pushed where the customer has subscribed) and an email
 *   through lib/notify.js, or an email to the address on a booking with no
 *   customer record. Not one for an entry still on a waitlist.
 * - `booking_events_repeat` (04:15 UTC, clear of the 03:20 to 04:00 passes):
 *   every weekly event that is not a draft has its next four weeks made,
 *   each repeat its own row pointing back at the first.
 *
 * Each runs in its own transaction per row it touches and sends mail only
 * after that commits, as memberships_lapse does.
 */
cronAdd("bookings_remind", "5 9 * * *", () => {
  const lib = require(`${__hooks}/lib/bookings.js`);
  try {
    const result = lib.remind($app, new Date());
    if (result.sent > 0) console.log(`[cron:bookings_remind] reminded ${result.sent} booking(s)`);
  } catch (err) {
    console.log(`[cron:bookings_remind] failed: ${err}`);
  }
});

cronAdd("booking_events_repeat", "15 4 * * *", () => {
  const lib = require(`${__hooks}/lib/bookings.js`);
  try {
    const result = lib.repeatEvents($app, new Date());
    if (result.made > 0) {
      console.log(`[cron:booking_events_repeat] made ${result.made} weekly event(s), ${result.drafts} as drafts`);
    }
  } catch (err) {
    console.log(`[cron:booking_events_repeat] failed: ${err}`);
  }
});
