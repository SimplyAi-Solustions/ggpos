/**
 * Staff PINs (docs/api-contract-epos.md, section 2, "PIN hashing").
 *
 * A PIN is 4 or 6 digits and unlocks the till on a registered device
 * (lib/devices.js). It is never stored: `staff.pin_hash` holds
 *
 *   "v1$" + hs256(staffId + ":" + pin, pepper)
 *   pepper = hs256("gg-pin-pepper-v1", GG_ID_PHOTO_KEY)
 *
 * so the hash is useless without the server key, which lives in the
 * environment and never in pb_data, and the same PIN on two people gives two
 * different hashes. Without GG_ID_PHOTO_KEY there is no pepper, and every PIN
 * route refuses with 500 rather than hashing with a guessable one.
 *
 * `verify(app, staff, pin, ctx)` is the one check the unlock route and the
 * manager approval route both use. It counts a wrong PIN against the person
 * whose PIN it is, locks their PIN on the fifth, and refuses while locked
 * without counting, all inside one transaction: SQLite runs one write
 * transaction at a time, so two wrong PINs sent at once are read and counted
 * one after the other and both count. A refusal commits (the count has to
 * stick), so it comes back as a result object, never as a throw.
 *
 * Nothing here logs or returns a PIN or a hash. `rosterEntry` and
 * `staffEntry` are the only two shapes a staff member's PIN state leaves the
 * server in, and neither carries `pin_hash`.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var LOCK_AT = 5;
var KEYLESS = "PINs are not available because the server key is not set.";
var LOCKED = "Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN.";
var INACTIVE = "This account is inactive. Ask an admin to reactivate it.";

/** The pepper, or "" when the server key is not set. */
function pepper() {
  var key = $os.getenv("GG_ID_PHOTO_KEY") || "";
  if (!key) return "";
  return $security.hs256("gg-pin-pepper-v1", key);
}

/** Whether PINs can be hashed and checked on this server at all. */
function available() {
  return !!($os.getenv("GG_ID_PHOTO_KEY") || "");
}

/** Throw the contract's 500 when the server key is not set. Call it first in every PIN route. */
function requireKey(e) {
  if (!available()) throw e.internalServerError(KEYLESS, null);
}

/** The stored form of a PIN for one staff member. Throws when the key is not set. */
function hash(staffId, pin) {
  var p = pepper();
  if (!p) throw new Error(KEYLESS);
  return "v1$" + $security.hs256(String(staffId) + ":" + String(pin), p);
}

/** Write a new PIN onto a staff record (not saved): the hash, its length, when, and a clean slate. */
function apply(record, pin) {
  record.set("pin_hash", hash(record.id, pin));
  record.set("pin_length", String(pin).length);
  record.set("pin_set_at", new Date().toISOString());
  record.set("pin_failures", 0);
  record.set("pin_locked", false);
}

/** Take a PIN off a staff record (not saved). */
function clear(record) {
  record.set("pin_hash", "");
  record.set("pin_length", 0);
  record.set("pin_set_at", "");
  record.set("pin_failures", 0);
  record.set("pin_locked", false);
}

/** "That PIN is not right. 3 tries left." */
function wrongPin(left) {
  return "That PIN is not right. " + left + (left === 1 ? " try left." : " tries left.");
}

/** "Sam Bell has no PIN yet. Sign in with a password to set one." */
function noPin(record) {
  var name = String(record.getString("name") || "").trim() || "This account";
  return name + " has no PIN yet. Sign in with a password to set one.";
}

/**
 * Check a PIN for a staff member, counting a wrong one.
 *
 * `ctx` says where the attempt came from, for the audit rows a failure
 * writes in the same transaction as the count:
 *   { purpose: "unlock" | "override", actor, device, register, capability, ip }
 *
 * @returns {{ok: true, staff: any}
 *   | {ok: false, status: number, message: string, reason: string, failures?: number}}
 *   reason: "keyless" | "inactive" | "no_pin" | "locked" | "wrong" | "locked_now"
 */
function verify(app, staff, pin, ctx) {
  ctx = ctx || {};
  if (!available()) return { ok: false, status: 500, message: KEYLESS, reason: "keyless" };

  var audit = require(__hooks + "/lib/audit.js");
  var candidatePin = typeof pin === "string" ? pin : String(pin === null || pin === undefined ? "" : pin);
  var result = null;

  function auditFailure(txApp, action, record, failures, locked) {
    var meta = {
      purpose: ctx.purpose || "unlock",
      device: ctx.device || "",
      register: ctx.register || "",
      failures: failures,
    };
    if (ctx.capability) meta.capability = ctx.capability;
    if (locked) meta.locked = true;
    audit.writeAuditLog(txApp, {
      actor: ctx.actor || "system",
      action: action,
      collection: "staff",
      record: record.id,
      meta: meta,
      ip: ctx.ip || "",
    });
  }

  app.runInTransaction(function (txApp) {
    // Re-read inside the transaction: the count a concurrent attempt just
    // committed is the one this attempt adds to.
    var fresh = txApp.findRecordById("staff", staff.id);

    if (!fresh.getBool("active")) {
      result = { ok: false, status: 403, message: INACTIVE, reason: "inactive" };
      return;
    }
    var stored = fresh.getString("pin_hash");
    if (!stored) {
      result = { ok: false, status: 409, message: noPin(fresh), reason: "no_pin" };
      return;
    }
    if (fresh.getBool("pin_locked")) {
      // Counts nothing, but an attempt on a locked PIN is still worth a row.
      auditFailure(txApp, "pin_failed", fresh, fresh.getInt("pin_failures"), true);
      result = { ok: false, status: 423, message: LOCKED, reason: "locked" };
      return;
    }

    if ($security.equal(hash(fresh.id, candidatePin), stored)) {
      if (fresh.getInt("pin_failures") !== 0) {
        fresh.set("pin_failures", 0);
        txApp.save(fresh);
      }
      result = { ok: true, staff: fresh };
      return;
    }

    var failures = fresh.getInt("pin_failures") + 1;
    fresh.set("pin_failures", failures);
    if (failures >= LOCK_AT) {
      fresh.set("pin_locked", true);
      txApp.save(fresh);
      auditFailure(txApp, "pin_locked", fresh, failures, false);
      result = { ok: false, status: 423, message: LOCKED, reason: "locked_now", failures: failures };
      return;
    }
    txApp.save(fresh);
    auditFailure(txApp, "pin_failed", fresh, failures, false);
    result = {
      ok: false,
      status: 401,
      message: wrongPin(LOCK_AT - failures),
      reason: "wrong",
      failures: failures,
    };
  });

  return result;
}

/** "Richard Green" becomes "RG"; one name gives its first two letters, as the counter's avatar does. */
function initials(name) {
  var parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(function (p) {
      return p.length > 0;
    });
  if (parts.length === 0) return "GG";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** One name on the lock screen (RosterEntry in packages/shared/src/epos-types.ts). */
function rosterEntry(record) {
  return {
    id: record.id,
    name: record.getString("name"),
    initials: initials(record.getString("name")),
    role: record.getString("role"),
    pin_set: !!record.getString("pin_hash"),
    pin_length: record.getString("pin_hash") ? record.getInt("pin_length") : 0,
    pin_locked: record.getBool("pin_locked"),
  };
}

/** A strict ISO 8601 string from a stored PocketBase date, or null when empty. */
function isoOrNull(value) {
  var raw = String(value || "").trim();
  if (!raw) return null;
  var parsed = new Date(raw.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

/** One row of the admin's staff list (`GET /api/vault/staff`). */
function staffEntry(record) {
  return {
    id: record.id,
    name: record.getString("name"),
    email: record.getString("email"),
    role: record.getString("role"),
    active: record.getBool("active"),
    pin_set: !!record.getString("pin_hash"),
    pin_locked: record.getBool("pin_locked"),
    must_change_password: record.getBool("must_change_password"),
    created: isoOrNull(record.getString("created")),
  };
}

module.exports = {
  LOCK_AT: LOCK_AT,
  KEYLESS: KEYLESS,
  LOCKED: LOCKED,
  INACTIVE: INACTIVE,
  available: available,
  requireKey: requireKey,
  hash: hash,
  apply: apply,
  clear: clear,
  verify: verify,
  initials: initials,
  rosterEntry: rosterEntry,
  staffEntry: staffEntry,
  isoOrNull: isoOrNull,
};
