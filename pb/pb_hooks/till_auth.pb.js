/// <reference path="../pb_data/types.d.ts" />

/**
 * till_auth.pb.js - registered tills, the lock screen and manager approval.
 *
 *   POST   /api/vault/till/devices        (manager + step-up)
 *   GET    /api/vault/till/devices        (manager)
 *   DELETE /api/vault/till/devices/{id}   (manager)
 *   GET    /api/vault/till/device         (device)
 *   GET    /api/vault/till/roster         (device)
 *   POST   /api/vault/till/unlock         (device)
 *   POST   /api/vault/till/override       (staff + device)
 *
 * docs/api-contract-epos.md, section 2. The device header and its checks are
 * lib/devices.js; the PIN hash, the failure count and the lock are
 * lib/pins.js, which unlock and override share so an approver's wrong PIN
 * counts toward their own lock exactly as a wrong unlock does. What an
 * approval lets the caller do is lib/permissions.js; this file only issues
 * the token it looks for.
 *
 * Neither a device secret, a PIN, nor any hash of either is ever logged,
 * audited or returned, apart from the secret's one appearance in the
 * registration response.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/till/devices - register this browser as a till
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/devices",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const devices = require(`${__hooks}/lib/devices.js`);
    const pins = require(`${__hooks}/lib/pins.js`);

    const caller = devices.requireManager(e);
    stepup.requireStepUp(e);

    const body = util.body(e);
    const label = util.asStr(body.label);
    if (!label) {
      throw e.badRequestError("Give this device a name, such as Counter Mac.", null);
    }
    if (label.length > 60) {
      throw e.badRequestError("Keep the device name to 60 characters or fewer.", null);
    }

    const resolved = registers.resolve(e.app, util.asStr(body.register));
    if (!resolved.register) throw e.error(resolved.status, resolved.message, null);
    const register = resolved.register;

    // Shown once in the response, stored only as its sha256.
    const secret = devices.newSecret();
    let device = null;
    e.app.runInTransaction((txApp) => {
      device = new Record(txApp.findCollectionByNameOrId("register_devices"));
      device.set("register", register.id);
      device.set("label", label);
      device.set("secret_hash", devices.hashSecret(secret));
      device.set("created_by", caller.id);
      txApp.save(device);

      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "till_device_registered",
        collection: "register_devices",
        record: device.id,
        meta: { register: register.id, label: label },
        ip: e.realIP(),
      });
    });

    const shaped = devices.shape(device, register);
    return e.json(201, {
      device: {
        id: shaped.id,
        register: shaped.register,
        register_name: shaped.register_name,
        label: shaped.label,
        created: pins.isoOrNull(device.getString("created")),
      },
      secret: secret,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/devices - every registration, newest first
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/till/devices",
  (e) => {
    const devices = require(`${__hooks}/lib/devices.js`);
    const pins = require(`${__hooks}/lib/pins.js`);

    devices.requireManager(e);

    const rows = e.app.findRecordsByFilter("register_devices", "id != ''", "-created,-id", 500, 0);
    const registerNames = {};
    const staffNames = {};

    function nameOf(cache, collection, id) {
      if (!id) return "";
      if (cache[id] !== undefined) return cache[id];
      let name = "";
      try {
        name = e.app.findRecordById(collection, id).getString("name");
      } catch (err) {
        name = "";
      }
      cache[id] = name;
      return name;
    }

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      out.push({
        id: row.id,
        register: row.getString("register"),
        register_name: nameOf(registerNames, "registers", row.getString("register")),
        label: row.getString("label"),
        created_by_name: nameOf(staffNames, "staff", row.getString("created_by")),
        created: pins.isoOrNull(row.getString("created")),
        last_seen: pins.isoOrNull(row.getString("last_seen")),
        revoked_at: pins.isoOrNull(row.getString("revoked_at")),
      });
    }

    return e.json(200, { devices: out });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// DELETE /api/vault/till/devices/{id} - revoke a registration
// ---------------------------------------------------------------------
routerAdd(
  "DELETE",
  "/api/vault/till/devices/{id}",
  (e) => {
    const audit = require(`${__hooks}/lib/audit.js`);
    const devices = require(`${__hooks}/lib/devices.js`);

    const caller = devices.requireManager(e);

    let device = null;
    try {
      device = e.app.findRecordById("register_devices", e.request.pathValue("id"));
    } catch (err) {
      device = null;
    }
    if (!device) throw e.notFoundError("That device was not found.", null);

    // Revoking twice changes nothing and writes nothing.
    if (device.getString("revoked_at")) return e.noContent(204);

    e.app.runInTransaction((txApp) => {
      const fresh = txApp.findRecordById("register_devices", device.id);
      if (fresh.getString("revoked_at")) return;
      fresh.set("revoked_at", new Date().toISOString());
      txApp.save(fresh);
      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "till_device_revoked",
        collection: "register_devices",
        record: fresh.id,
        meta: { register: fresh.getString("register"), label: fresh.getString("label") },
        ip: e.realIP(),
      });
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/till/device - is this browser still a till?
// ---------------------------------------------------------------------
routerAdd("GET", "/api/vault/till/device", (e) => {
  const devices = require(`${__hooks}/lib/devices.js`);

  const found = devices.requireDevice(e);
  return e.json(200, {
    device: devices.shape(found.device, found.register),
    register: {
      id: found.register.id,
      name: found.register.getString("name"),
      active: found.register.getBool("active"),
    },
  });
});

// ---------------------------------------------------------------------
// GET /api/vault/till/roster - the names on the lock screen
// ---------------------------------------------------------------------
routerAdd("GET", "/api/vault/till/roster", (e) => {
  const devices = require(`${__hooks}/lib/devices.js`);
  const pins = require(`${__hooks}/lib/pins.js`);

  const found = devices.requireDevice(e);

  // Every active member of staff can unlock any till, so the roster is the
  // whole active staff list. rosterEntry never carries pin_hash.
  const rows = e.app.findRecordsByFilter("staff", "active = true", "name,id", 500, 0);
  const staff = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]) staff.push(pins.rosterEntry(rows[i]));
  }
  staff.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x < y) return -1;
    if (x > y) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return e.json(200, {
    register: { id: found.register.id, name: found.register.getString("name") },
    staff: staff,
  });
});

// ---------------------------------------------------------------------
// POST /api/vault/till/unlock - a PIN for a token
// ---------------------------------------------------------------------
routerAdd("POST", "/api/vault/till/unlock", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const audit = require(`${__hooks}/lib/audit.js`);
  const devices = require(`${__hooks}/lib/devices.js`);
  const pins = require(`${__hooks}/lib/pins.js`);

  const found = devices.requireDevice(e);
  pins.requireKey(e);

  const body = util.body(e);
  const staffId = util.asStr(body.staff);
  if (!staffId) throw e.badRequestError("Choose your name first.", null);
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!pin) throw e.badRequestError("Key your PIN.", null);

  let staff = null;
  try {
    staff = e.app.findRecordById("staff", staffId);
  } catch (err) {
    staff = null;
  }
  if (!staff) throw e.notFoundError("That member of staff was not found. Choose your name again.", null);

  const deviceId = found.device.id;
  const registerId = found.register.id;
  const checked = pins.verify(e.app, staff, pin, {
    purpose: "unlock",
    // Nobody is signed in yet: the attempt is the device's.
    actor: `device:${deviceId}`,
    device: deviceId,
    register: registerId,
    ip: e.realIP(),
  });
  if (!checked.ok) throw e.error(checked.status, checked.message, null);

  // Written before the response, which is the last thing this handler does.
  audit.writeAuditLog(e.app, {
    actor: checked.staff.id,
    action: "pin_unlock",
    collection: "staff",
    record: checked.staff.id,
    meta: { device: deviceId, register: registerId },
    ip: e.realIP(),
  });

  // The same body a password sign-in gets, so the counter keeps it the same
  // way. The auth method "pin" is what keeps staff.pb.js from treating this
  // as a password sign-in that clears a PIN lock.
  return $apis.recordAuthResponse(e, checked.staff, "pin", null);
});

// ---------------------------------------------------------------------
// POST /api/vault/till/override - a manager approves one action with their PIN
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/till/override",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const devices = require(`${__hooks}/lib/devices.js`);
    const pins = require(`${__hooks}/lib/pins.js`);
    const shared = require(`${__hooks}/lib/shared/permissions.js`);

    const TTL_MS = 5 * 60 * 1000;

    const caller = perms.caller(e);
    const found = devices.requireDevice(e);
    pins.requireKey(e);

    const body = util.body(e);
    const capability = util.asStr(body.capability);
    if (!shared.isCapability(capability)) {
      throw e.badRequestError("That is not something a manager can approve. Try again from the till.", null);
    }
    // The two that manage the permissions table and the staff list stay
    // with an admin who is signed in (packages/shared/src/permissions.ts).
    if (capability === "settings_manage" || capability === "staff_manage") {
      throw e.forbiddenError("That needs an admin signed in.", null);
    }

    const approverId = util.asStr(body.approver);
    if (!approverId) throw e.badRequestError("Choose who is approving this.", null);
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!pin) throw e.badRequestError("Key the approver's PIN.", null);

    // What the approval was for, kept for the record. Only the three fields
    // the contract names, each in its own type.
    const context = {};
    const rawContext = body.context;
    if (rawContext !== undefined && rawContext !== null) {
      if (typeof rawContext !== "object" || Array.isArray(rawContext)) {
        throw e.badRequestError("Send the approval's details as an object.", null);
      }
      if (rawContext.sale !== undefined && rawContext.sale !== null && rawContext.sale !== "") {
        context.sale = String(rawContext.sale).slice(0, 40);
      }
      if (rawContext.amount !== undefined && rawContext.amount !== null) {
        const amount = Number(rawContext.amount);
        if (!isFinite(amount) || Math.floor(amount) !== amount) {
          throw e.badRequestError("The amount must be a whole number of pence.", null);
        }
        context.amount = amount;
      }
      if (typeof rawContext.reason === "string" && rawContext.reason.trim()) {
        context.reason = rawContext.reason.trim().slice(0, 200);
      }
    }

    let approver = null;
    try {
      approver = e.app.findRecordById("staff", approverId);
    } catch (err) {
      approver = null;
    }
    if (!approver) throw e.notFoundError("That member of staff was not found. Choose who is approving again.", null);
    if (approver.id === caller.id) {
      throw e.forbiddenError("You cannot approve your own request. Ask somebody else to key their PIN.", null);
    }
    if (!approver.getBool("active")) throw e.forbiddenError(pins.INACTIVE, null);

    // Whether the approver may do this themselves, under the table in force.
    // Checked before the PIN, so a PIN that could not approve anyway is
    // never tried and never counted.
    const table = perms.table(e.app);
    if (!perms.holds(approver, capability, table)) {
      const label = String(shared.CAPABILITY_LABELS[capability] || capability);
      const what = label.charAt(0).toLowerCase() + label.slice(1);
      throw e.forbiddenError(
        `${approver.getString("name")} cannot approve that. Ask somebody who can ${what}.`,
        null
      );
    }

    const deviceId = found.device.id;
    const registerId = found.register.id;
    const checked = pins.verify(e.app, approver, pin, {
      purpose: "override",
      actor: caller.id,
      device: deviceId,
      register: registerId,
      capability: capability,
      ip: e.realIP(),
    });
    if (!checked.ok) throw e.error(checked.status, checked.message, null);

    // Opaque and single use; only its sha256 is stored, which is what
    // lib/permissions.js looks it up by.
    const token = $security.randomString(48);
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

    e.app.runInTransaction((txApp) => {
      const row = new Record(txApp.findCollectionByNameOrId("till_overrides"));
      row.set("token_hash", perms.hashToken(token));
      row.set("capability", capability);
      row.set("requested_by", caller.id);
      row.set("approver", checked.staff.id);
      row.set("register", registerId);
      row.set("device", deviceId);
      row.set("context", context);
      row.set("expires_at", expiresAt);
      txApp.save(row);

      const meta = {
        capability: capability,
        requested_by: caller.id,
        approver: checked.staff.id,
        approver_name: checked.staff.getString("name"),
        device: deviceId,
        register: registerId,
        expires_at: expiresAt,
      };
      // Identifiers and the shop's own money only; the reason is free text
      // and stays on the till_overrides row.
      if (context.sale) meta.sale = context.sale;
      if (context.amount !== undefined) meta.amount = context.amount;
      audit.writeAuditLog(txApp, {
        actor: caller.id,
        action: "override_granted",
        collection: "till_overrides",
        record: row.id,
        meta: meta,
        ip: e.realIP(),
      });
    });

    return e.json(200, {
      token: token,
      capability: capability,
      approver: { id: checked.staff.id, name: checked.staff.getString("name") },
      expires_at: expiresAt,
    });
  },
  $apis.requireAuth("staff")
);
