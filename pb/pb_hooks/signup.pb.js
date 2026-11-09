/// <reference path="../pb_data/types.d.ts" />

/**
 * signup.pb.js - online sign-up for customers, with a password.
 *
 *   POST /api/vault/signup          (public, rate limited)
 *   POST /api/vault/signup/resend   (public, rate limited)
 *   customers password sign-in hook (refuses an unconfirmed email)
 *   customers confirm-verification hook (applies the marketing choice)
 *
 * The sign-up route never says whether an address already has an account.
 * A new address gets an account and a confirmation link; an address we
 * already hold gets a "set your password" link instead, so a customer
 * created at the counter can claim their account online. Both get the same
 * answer.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

routerAdd("POST", "/api/vault/signup", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);

  const body = util.body(e);
  const name = util.asStr(body.name).replace(/\s+/g, " ");
  const email = util.asStr(body.email).toLowerCase();
  const phone = util.asStr(body.phone).replace(/[^0-9+ ]/g, "").trim();
  const address = util.asStr(body.address).trim();
  const password = typeof body.password === "string" ? body.password : "";
  const marketing = util.asBool(body.marketing_consent);
  const terms = body.terms_accepted === true || util.asBool(body.terms_accepted);

  function invalid(field, message) {
    const errors = {};
    errors[field] = new ValidationError("invalid", message);
    return e.badRequestError(message, errors);
  }

  if (!name) throw invalid("name", "Add your name.");
  if (name.length > 200) throw invalid("name", "Use 200 characters or fewer for your name.");
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid("email", "That email address does not look right. Check it and try again.");
  }
  if (phone.replace(/[^0-9]/g, "").length < 10 || phone.length > 32) {
    throw invalid("phone", "Add a phone number we can reach you on, for example 07700 900123.");
  }
  if (address.length < 5 || address.length > 1000) {
    throw invalid("address", "Add your address, including the postcode.");
  }
  if (password.length < 10 || password.length > 72) {
    throw invalid("password", "Choose a password of at least 10 characters.");
  }
  if (!terms) {
    throw invalid("terms_accepted", "Tick the box to accept the terms and the privacy notice.");
  }

  const answer = { ok: true, message: "Check your email to finish setting up your account." };

  let existing = null;
  try {
    existing = e.app.findFirstRecordByFilter("customers", "email:lower = {:email}", { email: email });
  } catch (err) {
    existing = null;
  }
  if (existing) {
    try {
      $mails.sendRecordPasswordReset(e.app, existing);
    } catch (err) {
      console.log(`[signup] could not send a password link to ${existing.id}: ${err}`);
    }
    return e.json(200, answer);
  }

  let customer = null;
  try {
    customer = new Record(e.app.findCollectionByNameOrId("customers"), {
      name: name,
      email: email,
      phone: phone,
      emailVisibility: false,
      marketing_consent: false,
      source: "portal",
      verified: false,
    });
    customer.setPassword(password);
    e.app.save(customer);
  } catch (err) {
    console.log(`[signup] could not create a customer: ${err}`);
    throw e.internalServerError("We could not create your account just now. Try again in a minute.", null);
  }

  try {
    const priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: customer.id,
    });
    priv.set("address", address);
    priv.set("terms_accepted_at", new Date().toISOString());
    priv.set("marketing_consent_pending", marketing);
    e.app.save(priv);
  } catch (err) {
    console.log(`[signup] could not save the private details for ${customer.id}: ${err}`);
  }

  try {
    $mails.sendRecordVerification(e.app, customer);
  } catch (err) {
    console.log(`[signup] could not send the confirmation email to ${customer.id}: ${err}`);
  }

  auditLib.writeAuditLog(e.app, {
    actor: customer.id,
    action: "customer_signup",
    collection: "customers",
    record: customer.id,
    meta: { source: "portal", marketing_consent: marketing },
    ip: e.realIP(),
  });

  return e.json(200, answer);
});

routerAdd("POST", "/api/vault/signup/resend", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const email = util.asStr(util.body(e).email).toLowerCase();
  const answer = { ok: true, message: "If that address has an account waiting, we have sent the link again." };
  if (!email) return e.json(200, answer);
  try {
    const customer = e.app.findFirstRecordByFilter("customers", "email:lower = {:email}", { email: email });
    if (!customer.getBool("verified")) $mails.sendRecordVerification(e.app, customer);
  } catch (err) {
    // Unknown address or a mail failure: the same answer either way.
  }
  return e.json(200, answer);
});

onRecordAuthWithPasswordRequest((e) => {
  if (e.record && !e.record.getBool("verified")) {
    throw e.forbiddenError(
      "Confirm your email first. Use the link we sent you, or ask for a new one below.",
      { code: "email_not_confirmed" }
    );
  }
  e.next();
}, "customers");

onRecordConfirmVerificationRequest((e) => {
  e.next();
  try {
    const priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: e.record.id,
    });
    if (priv.getBool("marketing_consent_pending")) {
      const customer = e.app.findRecordById("customers", e.record.id);
      customer.set("marketing_consent", true);
      e.app.save(customer);
      priv.set("marketing_consent_pending", false);
      e.app.save(priv);
    }
  } catch (err) {
    console.log(`[signup] could not apply the marketing choice for ${e.record.id}: ${err}`);
  }
}, "customers");
