/// <reference path="../pb_data/types.d.ts" />

/**
 * reservations.pb.js - the staff reservation's own expiry cron.
 *
 * Kept in its own file rather than added to crons.pb.js or wants.pb.js,
 * the same way crons_sumup.pb.js is: one cronAdd() per job, in the file
 * that owns the logic behind it (lib/reservations.js).
 *
 * The schedule is offset from wants.pb.js's `holds_release` by five
 * minutes on purpose. Both walk the same `items` query and each skips
 * exactly what the other releases (see lib/reservations.js), so they
 * could safely run together, but keeping them apart means a slow pass
 * over a large stock list never sits on top of the other's.
 *
 * Nobody is notified. A reservation is a promise a member of staff made
 * across the counter, not one the system made, so the item simply goes
 * back on the shelf with a note on it saying who it was held for and
 * until when. A reservation with no `reserved_until` never expires.
 */
cronAdd("reservations_expire", "5-59/15 * * * *", () => {
  const reservations = require(`${__hooks}/lib/reservations.js`);
  try {
    const result = reservations.releaseExpired($app, new Date());
    if (result.released > 0) {
      console.log(`[cron:reservations_expire] released ${result.released} expired reservation(s)`);
    }
  } catch (err) {
    console.log(`[cron:reservations_expire] failed: ${err}`);
  }
});
