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

/**
 * The first-sign-in password change.
 *
 * `staff.must_change_password` (1789820760_staff_must_change_password.js)
 * is true on an account that is still on a password somebody else chose:
 * the first admin, seeded from `GG_ADMIN_PASSWORD`. The counter shows that
 * account nothing but the "Set a new password" screen until it is false
 * again, and this handler is the only thing that clears it.
 *
 * Three jobs, in order:
 *
 *  1. Strip `must_change_password` from the body of any update whose
 *     caller is not an admin, by putting the stored value back on the
 *     record. `staff`'s own updateRule is already admin-only, so today
 *     nobody else reaches this hook at all; it stays here so a locked
 *     account still cannot unlock itself by writing the field if that rule
 *     is ever loosened.
 *  2. Refuse a new password for the caller's own record that is shorter
 *     than twelve characters, or the one already on the account.
 *     PocketBase's own minimum is eight, which is not enough for a shared
 *     counter PC, and a "change" back to the temporary password would
 *     leave the account exactly where it started.
 *  3. Clear the flag on a successful own-password change and write one
 *     `staff_password_changed` audit row. The flag is cleared on the
 *     record before `e.next()`, so the one save either writes the new
 *     password and the cleared flag together or writes neither; the audit
 *     row is written after, so a refused save is never logged as a change.
 *
 * The password itself is never read into a variable that outlives this
 * handler, never logged and never returned: `validatePassword` is a hash
 * comparison, and `meta` carries field names only, like every other audit
 * row (pb/README.md). Changing a password rotates the account's token key,
 * so PocketBase invalidates every token it had; the counter signs in again
 * with the new password itself.
 *
 * Everything is require()d inside the handler body - see pb/README.md on
 * hook isolation.
 */
onRecordUpdateRequest((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const audit = require(`${__hooks}/lib/audit.js`);

  const MIN_LENGTH = 12;
  const REFUSAL =
    "Choose a password of at least 12 characters that you have not used here before.";

  const body = util.body(e);
  const caller = e.auth;
  const isAdmin =
    e.hasSuperuserAuth() ||
    (!!caller && caller.collection().name === "staff" && caller.getString("role") === "admin");

  let stored = null;
  try {
    stored = e.record.original();
  } catch (err) {
    stored = null;
  }

  // 1. Only an admin may set the flag.
  if (!isAdmin && body.must_change_password !== undefined) {
    e.record.set("must_change_password", stored ? stored.getBool("must_change_password") : false);
  }

  // 2 and 3 are about the caller changing their own password.
  const own =
    !!caller &&
    caller.collection().name === "staff" &&
    caller.id === e.record.id &&
    typeof body.password === "string" &&
    body.password !== "";

  if (!own) {
    e.next();
    return;
  }

  if (String(body.password).length < MIN_LENGTH) {
    throw e.badRequestError(REFUSAL, null);
  }
  if (stored && stored.validatePassword(String(body.password))) {
    throw e.badRequestError(REFUSAL, null);
  }

  const clearing = !!stored && stored.getBool("must_change_password");
  if (clearing) e.record.set("must_change_password", false);

  const recordId = e.record.id;
  const actorId = caller.id;
  const ip = e.realIP();

  e.next();

  audit.writeAuditLog(e.app, {
    actor: actorId,
    action: "staff_password_changed",
    collection: "staff",
    record: recordId,
    // Field names only, never a value: the same rule audit.pb.js follows.
    meta: { fields: clearing ? ["password", "must_change_password"] : ["password"] },
    ip: ip,
  });
}, "staff");
