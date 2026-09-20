/// <reference path="../pb_data/types.d.ts" />

/**
 * customers.pb.js
 *
 * - onRecordCreateRequest: customers are OTP-only (passwordAuth disabled),
 *   but every auth record still carries a password field; PLAN.md's Auth
 *   section calls for setting a random one so no client ever supplies or
 *   learns it. Staff create the record; the customer's first OTP login
 *   with the same email claims the account.
 * - onRecordCreate: assign `code` (GGC…, scan-routable) and `qr_token`
 *   (opaque, encodes /c/:token) when left empty.
 * - onRecordAfterCreateSuccess: create the paired customer_private row -
 *   the staff-only PII split described in PLAN.md's data model.
 *
 * Each of the three is registered and fires separately, so each repeats
 * its own require() and defines its own helpers rather than sharing them
 * at file top level: every registered handler runs in its own isolated
 * goja context, and a value only visible at file top level is not
 * reliably visible once a handler actually fires (verified against
 * v0.40.4 - see pb/README.md).
 */

onRecordCreateRequest((e) => {
  e.record.setRandomPassword();
  e.next();
}, "customers");

onRecordCreate((e) => {
  const sku = require(`${__hooks}/lib/shared/sku.js`);
  const util = require(`${__hooks}/lib/vaultutil.js`);

  /**
   * Same retry-by-precheck approach as items.pb.js's SKU assignment (see
   * its comment for why this checks uniqueness itself instead of
   * retrying a failed e.next()), and the same unbiased body generation
   * (see items.pb.js's generateUniqueSku for why the plain
   * sku.generateCode(kind, randomByte) path is avoided here).
   */
  function generateUniqueCustomerCode() {
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const body = $security.randomStringWithAlphabet(5, sku.CROCKFORD_ALPHABET);
      const code = sku.buildCode("customer", body);
      try {
        e.app.findFirstRecordByFilter("customers", "code = {:code}", { code: code.encoded });
      } catch (err) {
        return code.encoded;
      }
    }
    throw new Error(`Could not generate a unique customer code after ${maxAttempts} attempts`);
  }

  if (!e.record.getString("code")) {
    e.record.set("code", generateUniqueCustomerCode());
  }
  if (!e.record.getString("qr_token")) {
    e.record.set("qr_token", $security.randomString(32));
  }
  // Portal delivery preferences (Phase 5, PATCH /api/vault/me): a bool
  // field has no unset state once bound onto the record, so
  // e.record.get("notify_email") alone cannot tell "the request left this
  // out" apart from "the request explicitly sent false" - both read back
  // false. Reading the raw request body instead (fix round, finding 15)
  // tells them apart: left out defaults to true, so a customer is not
  // silently opted out of every notification the moment their record is
  // made; sent explicitly (even false) is trusted as-is, so a member of
  // staff can create a customer already opted out on their own say-so.
  const body = util.body(e);
  if (body.notify_email !== undefined) {
    e.record.set("notify_email", util.asBool(body.notify_email));
  } else if (!e.record.get("notify_email")) {
    e.record.set("notify_email", true);
  }
  if (body.notify_push !== undefined) {
    e.record.set("notify_push", util.asBool(body.notify_push));
  } else if (!e.record.get("notify_push")) {
    e.record.set("notify_push", true);
  }

  e.next();
}, "customers");

onRecordAfterCreateSuccess((e) => {
  const collection = e.app.findCollectionByNameOrId("customer_private");
  const record = new Record(collection, {
    customer: e.record.id,
    id_status: "none",
    credit_balance: 0,
    points_balance: 0,
  });
  e.app.save(record);
  e.next();
}, "customers");
