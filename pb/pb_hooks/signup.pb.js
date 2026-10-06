/// <reference path="../pb_data/types.d.ts" />

/**
 * signup.pb.js - online sign-up for My Vault
 * (docs/api-contract.md's Phase 8 section).
 *
 *   POST /api/vault/signup     (public, rate limited)
 *   customers auth hook        (the welcome bonus on the first emailed-code sign-in)
 *
 * The route creates the customer with `source: "portal"` and nothing else:
 * signing in is still PocketBase's own emailed-code flow
 * (`POST /api/collections/customers/request-otp`, then `auth-with-otp`),
 * which is what proves the address belongs to whoever typed it.
 *
 * It never says whether an address is already on a card. An address that
 * is gets exactly the same answer as a new one, and nothing is written; the
 * code request that follows then signs that person in as usual. The OTP
 * request already answers the same way for a known and an unknown address,
 * so this route gives nothing away that the sign-in screen does not.
 *
 * The welcome bonus for a customer who signed up here waits for their first
 * successful code sign-in (lib/welcome.js), so an address nobody owns never
 * collects points. Counter-created customers are unchanged.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/signup   (public)
// ---------------------------------------------------------------------
routerAdd("POST", "/api/vault/signup", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);

  const body = util.body(e);
  const name = util.asStr(body.name).replace(/\s+/g, " ");
  const email = util.asStr(body.email).toLowerCase();
  const marketing = util.asBool(body.marketing_consent);
  const terms = body.terms_accepted === true || util.asBool(body.terms_accepted);

  if (!name) {
    throw e.badRequestError("Add your name, then try again.", {
      name: new ValidationError("required", "Add your name."),
    });
  }
  if (name.length > 200) {
    throw e.badRequestError("That name is too long. Use 200 characters or fewer.", {
      name: new ValidationError("too_long", "Use 200 characters or fewer."),
    });
  }
  // The same broad shape PocketBase's own email field accepts; the emailed
  // code is what actually proves the address.
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw e.badRequestError("That email address does not look right. Check it and try again.", {
      email: new ValidationError("invalid", "Check the email address."),
    });
  }
  if (!terms) {
    throw e.badRequestError("Tick the box to accept the GG Guild terms, then try again.", {
      terms_accepted: new ValidationError("required", "Accept the terms to join."),
    });
  }

  // The one answer, whether the address was new or not.
  const answer = {
    ok: true,
    message: "Check your email for a sign-in code.",
  };

  let existing = null;
  try {
    existing = e.app.findFirstRecordByFilter("customers", "email:lower = {:email}", { email: email });
  } catch (err) {
    existing = null;
  }
  if (existing) return e.json(200, answer);

  let customer = null;
  try {
    customer = new Record(e.app.findCollectionByNameOrId("customers"), {
      name: name,
      email: email,
      emailVisibility: false,
      marketing_consent: marketing,
      source: "portal",
      verified: false,
    });
    // Customers sign in by emailed code only; the password field still
    // exists on every auth record, so it gets a random one nobody knows.
    customer.setRandomPassword();
    e.app.save(customer);
  } catch (err) {
    // Two sign-ups for one address at once: the unique email index turned
    // the second away, and it gets the same answer as the first.
    try {
      e.app.findFirstRecordByFilter("customers", "email:lower = {:email}", { email: email });
      return e.json(200, answer);
    } catch (lookupErr) {
      console.log(`[signup] could not create a customer: ${err}`);
      throw e.internalServerError("We could not create your account just now. Try again in a minute.", null);
    }
  }

  try {
    const priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
      customer: customer.id,
    });
    priv.set("terms_accepted_at", new Date().toISOString());
    e.app.save(priv);
  } catch (err) {
    console.log(`[signup] could not stamp terms_accepted_at for ${customer.id}: ${err}`);
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

// ---------------------------------------------------------------------
// customers, on a successful emailed-code sign-in: the deferred welcome
// bonus for somebody who signed up online. Written before e.next() so the
// /me read the portal makes straight after signing in already shows it.
// lib/welcome.js never writes it twice, so every later sign-in is a no-op.
// ---------------------------------------------------------------------
onRecordAuthRequest((e) => {
  if (e.authMethod === "otp" && e.record && e.record.getString("source") === "portal") {
    const welcome = require(`${__hooks}/lib/welcome.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const result = welcome.award(e.app, e.record, { signedIn: true });
    notifyLib.sendPending(e.app, result.pending);
  }
  e.next();
}, "customers");
