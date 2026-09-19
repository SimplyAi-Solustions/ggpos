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
 * Every require() happens inside the handler - see pb/README.md on
 * pb_hooks isolation.
 */

onRecordCreateRequest((e) => {
  e.record.setRandomPassword();
  e.next();
}, "customers");

onRecordCreate((e) => {
  const sku = require(`${__hooks}/lib/shared/sku.js`);

  if (!e.record.getString("code")) {
    e.record.set("code", generateUniqueCustomerCode(e.app, sku));
  }
  if (!e.record.getString("qr_token")) {
    e.record.set("qr_token", $security.randomString(32));
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

/**
 * Same retry-by-precheck approach as items.pb.js's SKU assignment (see its
 * comment for why this checks uniqueness itself instead of retrying a
 * failed e.next()).
 */
function generateUniqueCustomerCode(app, sku) {
  const randomByte = () =>
    $security.randomStringWithAlphabet(1, sku.CROCKFORD_ALPHABET).charCodeAt(0);

  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = sku.generateCode("customer", randomByte);
    try {
      app.findFirstRecordByFilter("customers", "code = {:code}", { code: code.encoded });
    } catch (err) {
      return code.encoded;
    }
  }
  throw new Error(`Could not generate a unique customer code after ${maxAttempts} attempts`);
}
