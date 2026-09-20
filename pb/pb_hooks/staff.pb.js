/// <reference path="../pb_data/types.d.ts" />

/**
 * staff.pb.js
 *
 * Refuses authentication for a staff account with `active: false`. This
 * fires for every staff auth method (password today; OTP/OAuth2 if either
 * is ever turned on, and token refresh) since onRecordAuthRequest is the
 * one hook common to all of them - see pb/README.md.
 *
 * A deactivated staff member (left the shop, on leave, ...) keeps their
 * row for audit_log's actor references and historic sales/trade-ins, but
 * must never be able to sign in again; PLAN.md does not want their record
 * deleted, only their access. This is auth-time enforcement to back up
 * the collection's own admin-only API rules, which already stop anyone
 * without an admin token reaching staff records at all.
 */
onRecordAuthRequest((e) => {
  if (e.record && !e.record.getBool("active")) {
    throw e.unauthorizedError("This account is inactive. Ask an admin to reactivate it.", null);
  }
  e.next();
}, "staff");
