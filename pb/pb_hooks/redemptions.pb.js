/// <reference path="../pb_data/types.d.ts" />

/**
 * redemptions.pb.js
 *
 * On create, assigns the two identifiers a reward_redemptions row carries
 * (PLAN.md's Loyalty data model):
 *  - `number`: the sequential GG-V-000012 form, from lib/counters.js's
 *    "redemption" counter (the same counter, and the same file, that the
 *    future sale and trade-in completion routes use for their own
 *    sequences).
 *  - `code`: the short, scannable GGV-... voucher code shown as a QR in
 *    the portal, from the shared codes module also used by items and
 *    customers.
 *
 * Both fields are required on the collection, so this always fills them
 * in when a caller has not supplied one directly (e.g. a fixture).
 *
 * Everything the handler needs is defined *inside* it (see items.pb.js's
 * top comment for why: each handler runs in its own isolated context).
 */
onRecordCreate((e) => {
  const counters = require(`${__hooks}/lib/counters.js`);
  const sku = require(`${__hooks}/lib/shared/sku.js`);

  /**
   * Same retry-by-precheck approach as items.pb.js's SKU assignment (see
   * its comment for why this checks uniqueness itself instead of
   * retrying a failed e.next()).
   */
  function generateUniqueVoucherCode() {
    const randomByte = () =>
      $security.randomStringWithAlphabet(1, sku.CROCKFORD_ALPHABET).charCodeAt(0);

    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = sku.generateCode("voucher", randomByte);
      try {
        e.app.findFirstRecordByFilter("reward_redemptions", "code = {:code}", {
          code: code.encoded,
        });
      } catch (err) {
        return code.encoded;
      }
    }
    throw new Error(`Could not generate a unique voucher code after ${maxAttempts} attempts`);
  }

  if (!e.record.getString("number")) {
    e.record.set("number", counters.nextNumber(e.app, "redemption"));
  }
  if (!e.record.getString("code")) {
    e.record.set("code", generateUniqueVoucherCode());
  }

  e.next();
}, "reward_redemptions");
