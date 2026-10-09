/// <reference path="../pb_data/types.d.ts" />

/**
 * Rate limits for the till's routes that take a PIN or answer a printer
 * (docs/api-contract-epos.md, sections 2 and 6), appended to the rules the
 * earlier phases set rather than replacing them:
 *
 * - `POST /api/vault/till/unlock`: 30 a minute per client. A device route
 *   with no token, so the audience is everyone. Five wrong PINs lock the
 *   PIN anyway; this stops a loop walking the roster.
 * - `POST /api/vault/till/override`: 30 a minute per signed-in caller.
 * - `/api/vault/cloudprnt/`: 120 a minute per client, a prefix because the
 *   printer's token is part of the path. A printer polling every two
 *   seconds makes 30; the shop's printers share the shop's one IP.
 *
 * `down()` removes these three by label and leaves the rest as they were.
 */
const LABELS = [
  "POST /api/vault/till/unlock",
  "POST /api/vault/till/override",
  "/api/vault/cloudprnt/",
];

function copyRules(settings, skip) {
  const rules = [];
  for (let i = 0; i < settings.rateLimits.rules.length; i++) {
    const rule = settings.rateLimits.rules[i];
    if (skip && LABELS.indexOf(rule.label) >= 0) continue;
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
    const rules = copyRules(settings, true);
    rules.push({ label: "POST /api/vault/till/unlock", audience: "", duration: 60, maxRequests: 30 });
    rules.push({ label: "POST /api/vault/till/override", audience: "@auth", duration: 60, maxRequests: 30 });
    rules.push({ label: "/api/vault/cloudprnt/", audience: "", duration: 60, maxRequests: 120 });
    settings.rateLimits.rules = rules;
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    settings.rateLimits.rules = copyRules(settings, true);
    app.save(settings);
  }
);
