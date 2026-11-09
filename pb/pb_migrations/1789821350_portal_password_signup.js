/// <reference path="../pb_data/types.d.ts" />

/**
 * Online sign-up with a password (rebuild, 09/11/2026).
 *
 * Customers can now make their own account from the website: name, email,
 * phone, address and a password, then confirm the email address from a link
 * before the password works (signup.pb.js enforces that). The emailed code
 * stays switched on, so a customer created at the counter can still sign in
 * the old way, and can set a password through "Forgot password".
 *
 * - customers.passwordAuth on, identity field email.
 * - The verification and password reset emails link to the portal's own
 *   screens (/account/verify, /account/reset), not to the PocketBase admin
 *   UI, which the public cannot reach.
 * - customer_private gains `terms_accepted_at` and
 *   `marketing_consent_pending`: a marketing tick made at sign-up only takes
 *   effect once the address is proved.
 * - Rate limits for the sign-up route and password sign-in.
 */
const RATE_LABELS = [
  "/api/vault/signup",
  "/api/vault/signup/resend",
  "customers:authWithPassword",
  "customers:requestPasswordReset",
  "customers:requestVerification",
];

function copyRules(settings) {
  const rules = [];
  for (let i = 0; i < settings.rateLimits.rules.length; i++) {
    const rule = settings.rateLimits.rules[i];
    if (RATE_LABELS.indexOf(rule.label) !== -1) continue;
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
    const customers = app.findCollectionByNameOrId("customers");
    customers.passwordAuth.enabled = true;
    customers.passwordAuth.identityFields = ["email"];

    customers.verificationTemplate.subject = "Confirm your email for GG Entertainment";
    customers.verificationTemplate.body =
      "<p>Hello,</p>" +
      "<p>Confirm your email address to finish setting up your GG Entertainment account.</p>" +
      '<p><a href="{APP_URL}/account/verify?token={TOKEN}">Confirm my email</a></p>' +
      "<p>The link works for three days. If you did not sign up, ignore this email and nothing happens.</p>" +
      "<p>GG Entertainment, 4 Cavendish Walk, Bolsover</p>";

    customers.resetPasswordTemplate.subject = "Set your GG Entertainment password";
    customers.resetPasswordTemplate.body =
      "<p>Hello,</p>" +
      "<p>Use this link to set a new password for your GG Entertainment account.</p>" +
      '<p><a href="{APP_URL}/account/reset?token={TOKEN}">Set a new password</a></p>' +
      "<p>The link works for 30 minutes. If you did not ask for this, ignore this email and your password stays the same.</p>" +
      "<p>GG Entertainment, 4 Cavendish Walk, Bolsover</p>";
    app.save(customers);

    const priv = app.findCollectionByNameOrId("customer_private");
    if (!priv.fields.getByName("terms_accepted_at")) {
      priv.fields.add(new Field({ name: "terms_accepted_at", type: "date" }));
    }
    if (!priv.fields.getByName("marketing_consent_pending")) {
      priv.fields.add(new Field({ name: "marketing_consent_pending", type: "bool" }));
    }
    app.save(priv);

    const settings = app.settings();
    const rules = copyRules(settings);
    rules.push({ label: "/api/vault/signup", audience: "", duration: 600, maxRequests: 10 });
    rules.push({ label: "/api/vault/signup/resend", audience: "", duration: 600, maxRequests: 5 });
    rules.push({ label: "customers:authWithPassword", audience: "", duration: 300, maxRequests: 20 });
    rules.push({ label: "customers:requestPasswordReset", audience: "", duration: 600, maxRequests: 5 });
    rules.push({ label: "customers:requestVerification", audience: "", duration: 600, maxRequests: 5 });
    settings.rateLimits.rules = rules;
    app.save(settings);
  },
  (app) => {
    const customers = app.findCollectionByNameOrId("customers");
    customers.passwordAuth.enabled = false;
    app.save(customers);

    const priv = app.findCollectionByNameOrId("customer_private");
    priv.fields.removeByName("terms_accepted_at");
    priv.fields.removeByName("marketing_consent_pending");
    app.save(priv);

    const settings = app.settings();
    settings.rateLimits.rules = copyRules(settings);
    app.save(settings);
  }
);
