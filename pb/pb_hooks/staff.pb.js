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
 * again, and the routerUse middleware at the foot of this file refuses
 * that account everything else server-side while it is true.
 *
 * Four jobs, in order:
 *
 *  1. Put the stored `must_change_password` back on the record whenever
 *     the caller is writing their OWN row, whatever their role, and
 *     whenever the caller is not an admin at all. That is the rule that
 *     matters: `staff.updateRule` is admin-only, so every account the
 *     flag is ever set on is an admin account, and without this an admin
 *     would clear their own lock with one PATCH and no password. Only
 *     step 3 turns the flag off on the caller's own row. A superuser from
 *     `/_/`, and an admin acting on somebody ELSE's row, keep the ability
 *     to set and clear it (check.sh 26g).
 *  2. Refuse a new password for the caller's own record that is shorter
 *     than twelve characters, or the one already on the account.
 *     PocketBase's own minimum is eight, which is not enough for a shared
 *     counter PC, and a "change" back to the temporary password would
 *     leave the account exactly where it started.
 *  3. Clear the flag on a successful own-password change. The flag is
 *     cleared on the record before `e.next()`, so the one save either
 *     writes the new password and the cleared flag together or writes
 *     neither.
 *  4. Write exactly one audit row, after `e.next()`, so a refused save is
 *     never logged as a change:
 *       - `staff_password_changed`: the owner changed their own password;
 *       - `staff_password_set`: somebody other than the owner set it (a
 *         superuser from `/_/`, which is how a plain staff member ever
 *         gets one);
 *       - `staff_lock_changed`: `must_change_password` moved without a
 *         password change, by anyone.
 *     `staff` is deliberately NOT in audit.pb.js's
 *     AUDITED_UPDATE_COLLECTIONS: this handler is the only thing that
 *     writes a staff update row, so an own change can never produce two.
 *
 * Neither password is ever read into a variable that outlives this
 * handler, never logged and never returned: `validatePassword` is a hash
 * comparison, and `meta` carries field names, the target id and who made
 * the change, like every other audit row (pb/README.md). Changing a
 * password rotates the account's token key, so PocketBase invalidates
 * every token it had; the counter signs in again with the new password
 * itself.
 *
 * Everything is require()d inside the handler body - see pb/README.md on
 * hook isolation.
 */
onRecordUpdateRequest((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const audit = require(`${__hooks}/lib/audit.js`);

  const MIN_LENGTH = 12;
  const REFUSAL =
    "Choose a password of at least 12 characters, and not the one you are using now.";

  const body = util.body(e);
  const caller = e.auth;
  const callerIsStaff = !!caller && caller.collection().name === "staff";
  const isSuperuser = e.hasSuperuserAuth();
  const isAdmin = isSuperuser || (callerIsStaff && caller.getString("role") === "admin");
  // A superuser's own auth record lives in `_superusers`, so it can never
  // match a staff id: `/_/` is always somebody else's row, which is what
  // keeps step 1 out of its way.
  const ownRow = callerIsStaff && caller.id === e.record.id;

  let stored = null;
  try {
    stored = e.record.original();
  } catch (err) {
    stored = null;
  }
  const storedFlag = stored ? stored.getBool("must_change_password") : false;

  // 1. Nobody unlocks their own row by writing the field.
  if (body.must_change_password !== undefined && (!isAdmin || ownRow)) {
    e.record.set("must_change_password", storedFlag);
  }

  // 2 and 3 are about the caller changing their own password.
  const settingPassword = typeof body.password === "string" && body.password !== "";
  const own = ownRow && settingPassword;

  if (own) {
    if (String(body.password).length < MIN_LENGTH) {
      throw e.badRequestError(REFUSAL, null);
    }
    if (stored && stored.validatePassword(String(body.password))) {
      throw e.badRequestError(REFUSAL, null);
    }
    if (storedFlag) e.record.set("must_change_password", false);
  }

  // 4. Read everything the audit row needs while "original" still means
  // "as it was before this request", the same rule audit.pb.js follows.
  const recordId = e.record.id;
  const lockChanged = e.record.getBool("must_change_password") !== storedFlag;
  const fields = [];
  if (settingPassword) fields.push("password");
  if (lockChanged) fields.push("must_change_password");
  // Who did it: "superuser" for anyone working from `/_/` (their own
  // `_superusers` id says nothing about a person here), the caller's staff
  // record id for an admin, "system" for a hook or cron with no caller.
  const by = isSuperuser ? "superuser" : callerIsStaff ? caller.id : "system";
  const ip = e.realIP();

  e.next();

  let action = "";
  if (own) action = "staff_password_changed";
  else if (settingPassword) action = "staff_password_set";
  else if (lockChanged) action = "staff_lock_changed";
  if (!action) return;

  audit.writeAuditLog(e.app, {
    actor: by,
    action: action,
    collection: "staff",
    record: recordId,
    // Field names, the target id and who made the change. Never a value:
    // the same rule audit.pb.js follows for staff.
    meta: { fields: fields, record: recordId, by: by },
    ip: ip,
  });
}, "staff");

/**
 * The lock itself, server-side.
 *
 * A staff token whose record still carries `must_change_password` is a
 * token issued against a password somebody else chose and left sitting in
 * `.env`. Until that account sets a password of its own it may do exactly
 * two things and nothing else, on any device and through any client: keep
 * its session alive, and change its own password. Everything else is
 * refused with 403, so the counter's own redirect is a convenience rather
 * than the only thing standing between a leaked temporary password and
 * the shop's customer list.
 *
 * A global middleware is the only place this can live: the account is
 * refused the whole API, not one collection or one route, and PocketBase's
 * own auth-token loader runs before hook middlewares, so `e.auth` here is
 * the record the token names, re-read from the database on every request
 * (a lock cleared on one device therefore lifts on every other one at the
 * next call).
 *
 * Untouched: superusers, customers, and any request with no usable token
 * at all, which is what sign-in is. A dead token is no token as far as
 * PocketBase is concerned, so the re-authentication that follows a
 * successful change is never caught by this either.
 */
routerUse((e) => {
  const auth = e.auth;
  if (!auth || auth.collection().name !== "staff" || !auth.getBool("must_change_password")) {
    e.next();
    return;
  }

  const method = String(e.request.method || "").toUpperCase();
  let path = String((e.request.url && e.request.url.path) || "");
  if (path.length > 1 && path.charAt(path.length - 1) === "/") {
    path = path.substring(0, path.length - 1);
  }

  // A collection is addressable by name or by id, so both spellings of
  // the two allowed paths are listed rather than trusting the client to
  // use the name the counter happens to use.
  const staffPaths = ["staff", auth.collection().id];
  let allowed = false;

  // The liveness probe (deploy/docker-compose.yml's healthcheck and the
  // app's own boot ping). It answers the same to everyone, so what it
  // says must not depend on whose token is in the browser.
  if (method === "GET" && path === "/api/health") allowed = true;

  for (let i = 0; i < staffPaths.length && !allowed; i++) {
    // Keeping the session alive. The counter holds a locked account on
    // the "Set a new password" screen for as long as it takes, and a
    // refused refresh would drop them back to sign-in mid-change.
    if (method === "POST" && path === `/api/collections/${staffPaths[i]}/auth-refresh`) {
      allowed = true;
    }
    // The change itself: the caller's OWN row and no other. This is the
    // PATCH the "Set a new password" screen makes, and the handler above
    // is what decides whether its body is acceptable.
    if (
      method === "PATCH" &&
      path === `/api/collections/${staffPaths[i]}/records/${auth.id}`
    ) {
      allowed = true;
    }
  }

  if (!allowed) {
    throw e.forbiddenError("Set a new password before doing anything else.", null);
  }

  e.next();
});
