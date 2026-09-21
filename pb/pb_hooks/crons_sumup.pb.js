/// <reference path="../pb_data/types.d.ts" />

/**
 * crons_sumup.pb.js - the SumUp transactions pull, on a schedule.
 *
 * Kept in its own file rather than added to crons.pb.js: that file
 * belongs to another package this round (see the Phase 4 brief), and
 * every existing cron there is registered the same way - one
 * cronAdd() per job, in its own top-level call - so a new file
 * registering one more is exactly the established shape, not a special
 * case.
 *
 * docs/PLAN.md, "SumUp integration": ":15 past every hour, 08:00 to
 * 22:00 UTC" - a few minutes after the hour so a sale rung through
 * moments ago has settled on SumUp's side before this asks about it, and
 * only during the shop's own trading hours, so there is nothing to pull
 * overnight.
 */
cronAdd("sumup_pull", "15 8-22 * * *", () => {
  const sumup = require(`${__hooks}/lib/sumup.js`);
  try {
    const result = sumup.pull($app, "system", "");
    console.log(
      `[cron:sumup_pull] fetched ${result.fetched}, matched ${result.matched}, unmatched ${result.unmatched}`
    );
  } catch (err) {
    console.log(`[cron:sumup_pull] failed: ${err}`);
  }
});
