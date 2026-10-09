/// <reference path="../pb_data/types.d.ts" />

/**
 * The rate limit for every public route (docs/api-contract-launch.md,
 * section 6), appended to the rules the earlier phases set rather than
 * replacing them.
 *
 * `/api/public/` is a prefix (PocketBase matches a label ending in "/" that
 * way), any method, audience everyone: the stock feed, and the bookings
 * server's availability and events, share one budget of 180 reads a minute
 * per client IP. `trustedProxy` is set by the Phase 5 migration, so behind
 * Caddy that is each visitor's own address. The website's shop page reads
 * two (the categories and a page of stock) and the home page one; the shop's
 * own Wi-Fi shares one address, which is why it is generous: it stops a
 * scraper looping, not a busy afternoon. A route that needs a tighter limit
 * adds its own exact rule, which PocketBase prefers over the prefix.
 *
 * `down()` removes the rule by label and leaves the rest as they were.
 */
const LABEL = "/api/public/";

function copyRules(settings) {
  const rules = [];
  for (let i = 0; i < settings.rateLimits.rules.length; i++) {
    const rule = settings.rateLimits.rules[i];
    if (rule.label === LABEL) continue;
    rules.push({
      label: rule.label,
      audience: rule.audience,
      duration: rule.duration,
      maxRequests: rule.maxRequests,
    });
  }
  return rules;
}

migrate(
  (app) => {
    const settings = app.settings();
    const rules = copyRules(settings);
    rules.push({ label: LABEL, audience: "", duration: 60, maxRequests: 180 });
    settings.rateLimits.rules = rules;
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    settings.rateLimits.rules = copyRules(settings);
    app.save(settings);
  }
);
