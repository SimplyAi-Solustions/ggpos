/// <reference path="../pb_data/types.d.ts" />

/**
 * staff_admin.pb.js - the staff list, PINs and passwords.
 *
 *   GET    /api/vault/staff                   (admin)
 *   POST   /api/vault/staff                   (admin + step-up)
 *   PATCH  /api/vault/staff/{id}              (admin + step-up)
 *   POST   /api/vault/staff/{id}/pin          (admin + step-up)
 *   DELETE /api/vault/staff/{id}/pin          (admin + step-up)
 *   POST   /api/vault/staff/{id}/password     (admin + step-up)
 *   POST   /api/vault/staff/me/pin            (staff + step-up)
 *   DELETE /api/vault/staff/me/pin            (staff + step-up)
 *   POST   /api/vault/staff/me/password       (staff)
 *
 * docs/api-contract-epos.md, section 2, "Setting a PIN" and "Staff
 * management". `staff` stays admin-only through the collection API; these
 * routes are how a manager or a plain member of staff changes their own PIN
 * and password, and how an admin runs the staff list without `/_/`.
 *
 * A password saved inside a route does not pass through staff.pb.js's
 * onRecordUpdateRequest (that fires for the collection API only), so the
 * same rules are applied here, with the same sentence, and the same audit
 * actions written: `staff_password_changed` for your own,
 * `staff_password_set` for somebody else's. Every password change rotates
 * the account's token key, so the tokens it had stop working.
 *
 * Nothing here returns `pin_hash`, `password` or `tokenKey`: every response
 * is built field by field (lib/pins.js `staffEntry`), and audit rows carry
 * field names and ids, never a PIN or a password.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/staff
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/staff",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const pins = require(`${__hooks}/lib/pins.js`);

    perms.caller(e);
    util.requireAdmin(e);

    const rows = e.app.findRecordsByFilter("staff", "id != ''", "name,id", 1000, 0);
    const staff = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) staff.push(pins.staffEntry(rows[i]));
    }
    staff.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      if (x < y) return -1;
      if (x > y) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return e.json(200, { staff: staff });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/staff - add somebody
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/staff",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const pins = require(`${__hooks}/lib/pins.js`);
    const shared = require(`${__hooks}/lib/shared/permissions.js`);

    // The rule staff.pb.js holds an own change to, with its sentence.
    const MIN_LENGTH = 12;
    const MAX_LENGTH = 71;
    const PASSWORD_REFUSAL =
      "Choose a password of at least 12 characters, and not the one you are using now.";
    const EMAIL_TAKEN = "Somebody already uses that email.";

    perms.caller(e);
    const admin = util.requireAdmin(e);
    stepup.requireStepUp(e);

    const body = util.body(e);
    const name = util.asStr(body.name);
    const email = util.asStr(body.email).toLowerCase();
    const role = util.asStr(body.role);
    const password = typeof body.password === "string" ? body.password : "";

    if (!name) throw e.badRequestError("Enter their name.", null);
    if (name.length > 200) throw e.badRequestError("Keep the name to 200 characters or fewer.", null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      throw e.badRequestError("Enter a valid email address.", null);
    }
    if (!shared.isRole(role)) throw e.badRequestError("Choose a role: staff, manager or admin.", null);
    if (password.length < MIN_LENGTH) throw e.badRequestError(PASSWORD_REFUSAL, null);
    if (password.length > MAX_LENGTH) {
      throw e.badRequestError("Choose a password of 71 characters or fewer.", null);
    }

    /** A unique-index collision, whichever shape PocketBase reports it in. */
    function isUniqueViolation(err) {
      const text = String((err && err.message) || err || "");
      return /must be unique/i.test(text) || /unique constraint/i.test(text);
    }

    // Case-insensitive: the email index PocketBase keeps is not, and an
    // address saved from `/_/` keeps whatever case it was typed in, so
    // "Sam@Shop.co.uk" on file has to stop "sam@shop.co.uk" here.
    function emailTaken(app) {
      try {
        app.findFirstRecordByFilter("staff", "email:lower = {:email}", { email: email });
        return true;
      } catch (err) {
        return false;
      }
    }

    if (emailTaken(e.app)) throw e.error(409, EMAIL_TAKEN, null);

    let halt = null;
    let created = null;
    try {
      e.app.runInTransaction((txApp) => {
        if (emailTaken(txApp)) {
          halt = { status: 409, message: EMAIL_TAKEN };
          throw new Error(halt.message);
        }
        const record = new Record(txApp.findCollectionByNameOrId("staff"));
        record.set("name", name);
        record.setEmail(email);
        record.set("role", role);
        record.set("active", true);
        record.setPassword(password);
        // A password somebody else chose: they set their own at first sign-in.
        record.set("must_change_password", true);
        txApp.save(record);
        created = record;

        audit.writeAuditLog(txApp, {
          actor: admin.id,
          action: "staff_created",
          collection: "staff",
          record: record.id,
          meta: { record: record.id, role: role, by: admin.id },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      if (isUniqueViolation(err)) throw e.error(409, EMAIL_TAKEN, null);
      throw err;
    }

    return e.json(201, { staff: pins.staffEntry(created) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// PATCH /api/vault/staff/{id} - name, role, active
// ---------------------------------------------------------------------
routerAdd(
  "PATCH",
  "/api/vault/staff/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const pins = require(`${__hooks}/lib/pins.js`);
    const shared = require(`${__hooks}/lib/shared/permissions.js`);

    const LAST_ADMIN = "There has to be at least one active admin.";

    perms.caller(e);
    const admin = util.requireAdmin(e);
    stepup.requireStepUp(e);

    const body = util.body(e);
    const changes = {};
    if (body.name !== undefined) {
      const name = util.asStr(body.name);
      if (!name) throw e.badRequestError("Enter their name.", null);
      if (name.length > 200) throw e.badRequestError("Keep the name to 200 characters or fewer.", null);
      changes.name = name;
    }
    if (body.role !== undefined) {
      const role = util.asStr(body.role);
      if (!shared.isRole(role)) throw e.badRequestError("Choose a role: staff, manager or admin.", null);
      changes.role = role;
    }
    if (body.active !== undefined) {
      if (body.active !== true && body.active !== false) {
        throw e.badRequestError("Say whether the account is active with true or false.", null);
      }
      changes.active = body.active;
    }
    if (changes.name === undefined && changes.role === undefined && changes.active === undefined) {
      throw e.badRequestError("There is nothing to change. Send a name, a role or active.", null);
    }

    const id = e.request.pathValue("id");
    let target = null;
    try {
      target = e.app.findRecordById("staff", id);
    } catch (err) {
      target = null;
    }
    if (!target) throw e.notFoundError("That member of staff was not found.", null);

    let halt = null;
    let saved = null;
    try {
      e.app.runInTransaction((txApp) => {
        const fresh = txApp.findRecordById("staff", id);
        const wasActiveAdmin = fresh.getString("role") === "admin" && fresh.getBool("active");
        const fields = [];

        if (changes.name !== undefined && changes.name !== fresh.getString("name")) {
          fresh.set("name", changes.name);
          fields.push("name");
        }
        if (changes.role !== undefined && changes.role !== fresh.getString("role")) {
          fresh.set("role", changes.role);
          fields.push("role");
        }
        if (changes.active !== undefined && changes.active !== fresh.getBool("active")) {
          fresh.set("active", changes.active);
          fields.push("active");
          // Deactivating signs them out everywhere: a new token key makes
          // every token they hold stop working, not just their next sign-in.
          if (!changes.active) fresh.refreshTokenKey();
        }

        if (!fields.length) {
          saved = fresh;
          return;
        }

        // Inside the transaction, so two admins demoting each other at once
        // cannot both succeed: write transactions run one at a time.
        const isActiveAdmin = fresh.getString("role") === "admin" && fresh.getBool("active");
        if (wasActiveAdmin && !isActiveAdmin) {
          const others = txApp.findRecordsByFilter(
            "staff",
            "role = 'admin' && active = true && id != {:id}",
            "",
            1,
            0,
            { id: fresh.id }
          );
          if (!others.length) {
            halt = { status: 409, message: LAST_ADMIN };
            throw new Error(halt.message);
          }
        }

        txApp.save(fresh);
        saved = fresh;

        audit.writeAuditLog(txApp, {
          actor: admin.id,
          action: "staff_updated",
          collection: "staff",
          record: fresh.id,
          meta: { fields: fields, record: fresh.id, by: admin.id },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, { staff: pins.staffEntry(saved) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/staff/{id}/password - a temporary password
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/staff/{id}/password",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);

    const MIN_LENGTH = 12;
    const MAX_LENGTH = 71;
    const PASSWORD_REFUSAL =
      "Choose a password of at least 12 characters, and not the one you are using now.";

    perms.caller(e);
    const admin = util.requireAdmin(e);
    stepup.requireStepUp(e);

    const id = e.request.pathValue("id");
    let target = null;
    try {
      target = e.app.findRecordById("staff", id);
    } catch (err) {
      target = null;
    }
    if (!target) throw e.notFoundError("That member of staff was not found.", null);
    if (target.id === admin.id) {
      throw e.badRequestError("Change your own password from your account, with your current one.", null);
    }

    const password = typeof util.body(e).password === "string" ? util.body(e).password : "";
    if (password.length < MIN_LENGTH || target.validatePassword(password)) {
      throw e.badRequestError(PASSWORD_REFUSAL, null);
    }
    if (password.length > MAX_LENGTH) {
      throw e.badRequestError("Choose a password of 71 characters or fewer.", null);
    }

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", id);
      fresh.setPassword(password);
      fresh.refreshTokenKey();
      // A temporary password: they choose their own at the next sign-in.
      fresh.set("must_change_password", true);
      txApp.save(fresh);

      audit.writeAuditLog(txApp, {
        actor: admin.id,
        action: "staff_password_set",
        collection: "staff",
        record: fresh.id,
        meta: { fields: ["password", "must_change_password"], record: fresh.id, by: admin.id },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/staff/me/password - your own password, any role
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/staff/me/password",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);

    const MIN_LENGTH = 12;
    const MAX_LENGTH = 71;
    const PASSWORD_REFUSAL =
      "Choose a password of at least 12 characters, and not the one you are using now.";

    const caller = perms.caller(e);
    const body = util.body(e);
    const oldPassword = typeof body.old_password === "string" ? body.old_password : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!oldPassword) throw e.badRequestError("Enter your current password.", null);
    if (!caller.validatePassword(oldPassword)) {
      throw e.badRequestError("That is not your current password.", null);
    }
    if (password.length < MIN_LENGTH || caller.validatePassword(password)) {
      throw e.badRequestError(PASSWORD_REFUSAL, null);
    }
    if (password.length > MAX_LENGTH) {
      throw e.badRequestError("Choose a password of 71 characters or fewer.", null);
    }

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", caller.id);
      const wasLocked = fresh.getBool("must_change_password");
      fresh.setPassword(password);
      fresh.refreshTokenKey();
      fresh.set("must_change_password", false);
      txApp.save(fresh);

      const fields = ["password"];
      if (wasLocked) fields.push("must_change_password");
      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "staff_password_changed",
        collection: "staff",
        record: fresh.id,
        meta: { fields: fields, record: fresh.id, by: caller.id },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/staff/me/pin - set your own PIN
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/staff/me/pin",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const pins = require(`${__hooks}/lib/pins.js`);
    const shared = require(`${__hooks}/lib/shared/permissions.js`);

    const caller = perms.caller(e);
    pins.requireKey(e);
    stepup.requireStepUp(e);

    const pin = util.body(e).pin;
    const problem = shared.pinProblem(pin);
    if (problem) throw e.badRequestError(problem, null);

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", caller.id);
      pins.apply(fresh, pin);
      txApp.save(fresh);
      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "pin_set",
        collection: "staff",
        record: fresh.id,
        meta: { record: fresh.id, by: caller.id },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// DELETE /api/vault/staff/me/pin - clear your own PIN
// ---------------------------------------------------------------------
routerAdd(
  "DELETE",
  "/api/vault/staff/me/pin",
  (e) => {
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const pins = require(`${__hooks}/lib/pins.js`);

    const caller = perms.caller(e);
    pins.requireKey(e);
    stepup.requireStepUp(e);

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", caller.id);
      pins.clear(fresh);
      txApp.save(fresh);
      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "pin_cleared",
        collection: "staff",
        record: fresh.id,
        meta: { record: fresh.id, by: caller.id },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/staff/{id}/pin - set somebody's PIN, clearing their lock
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/staff/{id}/pin",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const pins = require(`${__hooks}/lib/pins.js`);
    const shared = require(`${__hooks}/lib/shared/permissions.js`);

    perms.caller(e);
    const admin = util.requireAdmin(e);
    pins.requireKey(e);
    stepup.requireStepUp(e);

    const id = e.request.pathValue("id");
    let target = null;
    try {
      target = e.app.findRecordById("staff", id);
    } catch (err) {
      target = null;
    }
    if (!target) throw e.notFoundError("That member of staff was not found.", null);

    const pin = util.body(e).pin;
    const problem = shared.pinProblem(pin);
    if (problem) throw e.badRequestError(problem, null);

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", id);
      const wasLocked = fresh.getBool("pin_locked");
      pins.apply(fresh, pin);
      txApp.save(fresh);
      const meta = { record: fresh.id, by: admin.id };
      if (wasLocked) meta.unlocked = true;
      audit.writeAuditLog(txApp, {
        actor: admin.id,
        action: "pin_set",
        collection: "staff",
        record: fresh.id,
        meta: meta,
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// DELETE /api/vault/staff/{id}/pin - clear somebody's PIN
// ---------------------------------------------------------------------
routerAdd(
  "DELETE",
  "/api/vault/staff/{id}/pin",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const pins = require(`${__hooks}/lib/pins.js`);

    perms.caller(e);
    const admin = util.requireAdmin(e);
    pins.requireKey(e);
    stepup.requireStepUp(e);

    const id = e.request.pathValue("id");
    let target = null;
    try {
      target = e.app.findRecordById("staff", id);
    } catch (err) {
      target = null;
    }
    if (!target) throw e.notFoundError("That member of staff was not found.", null);

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("staff", id);
      pins.clear(fresh);
      txApp.save(fresh);
      audit.writeAuditLog(txApp, {
        actor: admin.id,
        action: "pin_cleared",
        collection: "staff",
        record: fresh.id,
        meta: { record: fresh.id, by: admin.id },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);
