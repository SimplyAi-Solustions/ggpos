/**
 * Registered till devices (docs/api-contract-epos.md, section 2, "Devices").
 *
 * A manager signs in with a password once on a browser and registers it to a
 * register. The server hands back the device's id and a 64 character hex
 * secret, once; the browser keeps both (apps/web/src/lib/till-device.ts) and
 * sends them on every device route as
 *
 *   X-GG-Device: <device id>.<device secret>
 *
 * Only the sha256 of the secret is stored (`register_devices.secret_hash`,
 * hidden), compared in constant time. A PIN on its own, from a browser
 * without a live registration, opens nothing (docs/EPOS-PLAN.md, decision 4).
 *
 * `requireDevice(e)` refuses an unknown, malformed or revoked device with the
 * contract's 401 and otherwise returns `{ device, register }`, touching
 * `last_seen` at most once a minute so a till polling its roster does not
 * write on every request.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var HEADER = "X-GG-Device";
var REFUSAL =
  "This device is not registered as a till. Sign in with a password and register it under Settings.";
var MANAGER_ONLY = "Only a manager or an admin can do this. Ask one to sign in.";
var SEEN_EVERY_MS = 60 * 1000;
var ID_PATTERN = /^[a-z0-9]{15}$/;
var SECRET_PATTERN = /^[0-9a-f]{64}$/;
var SECRET_ALPHABET = "0123456789abcdef";

/** `{ id, secret }` from the header's value, or null when it is not that shape. */
function parse(raw) {
  var text = String(raw || "").trim();
  var dot = text.indexOf(".");
  if (dot <= 0) return null;
  var id = text.slice(0, dot);
  var secret = text.slice(dot + 1);
  if (!ID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) return null;
  return { id: id, secret: secret };
}

/** A new device secret: 64 hex characters from the crypto random source. */
function newSecret() {
  return $security.randomStringWithAlphabet(64, SECRET_ALPHABET);
}

/** What register_devices.secret_hash stores. */
function hashSecret(secret) {
  return $security.sha256(String(secret));
}

/** The register row for a device, or null. */
function registerOf(app, device) {
  try {
    return app.findRecordById("registers", device.getString("register"));
  } catch (err) {
    return null;
  }
}

/**
 * The live device a header value names, with its register, or null when the
 * value is malformed, the device is unknown or revoked, or the secret does
 * not match. Never throws.
 */
function find(app, raw) {
  var parsed = parse(raw);
  if (!parsed) return null;
  var device = null;
  try {
    device = app.findRecordById("register_devices", parsed.id);
  } catch (err) {
    device = null;
  }
  if (!device) return null;
  if (device.getString("revoked_at")) return null;
  var stored = device.getString("secret_hash");
  if (!stored || !$security.equal(hashSecret(parsed.secret), stored)) return null;
  var register = registerOf(app, device);
  if (!register) return null;
  return { device: device, register: register };
}

/** Set last_seen when it is empty or over a minute old. A failed touch never refuses the request. */
function touch(app, device) {
  var last = String(device.getString("last_seen") || "");
  var now = Date.now();
  if (last) {
    var at = new Date(last.replace(" ", "T")).getTime();
    if (!isNaN(at) && now - at < SEEN_EVERY_MS) return;
  }
  try {
    device.set("last_seen", new Date(now).toISOString());
    app.save(device);
  } catch (err) {
    // Only a "last seen" figure for the devices list; the request goes on.
  }
}

/** The device on this request, or a thrown 401 with the contract's sentence. */
function requireDevice(e) {
  var raw = "";
  try {
    raw = e.request.header.get(HEADER) || "";
  } catch (err) {
    raw = "";
  }
  var found = find(e.app, raw);
  if (!found) throw e.unauthorizedError(REFUSAL, null);
  touch(e.app, found.device);
  return found;
}

/** The signed-in manager or admin, active, or a thrown 401/403. */
function requireManager(e) {
  var perms = require(__hooks + "/lib/permissions.js");
  var caller = perms.caller(e);
  var role = caller.getString("role");
  if (role !== "manager" && role !== "admin") throw e.forbiddenError(MANAGER_ONLY, null);
  return caller;
}

/** `{ id, label, register, register_name }` (TillDevice in packages/shared/src/epos-types.ts). */
function shape(device, register) {
  return {
    id: device.id,
    label: device.getString("label"),
    register: device.getString("register"),
    register_name: register ? register.getString("name") : "",
  };
}

module.exports = {
  HEADER: HEADER,
  REFUSAL: REFUSAL,
  MANAGER_ONLY: MANAGER_ONLY,
  parse: parse,
  newSecret: newSecret,
  hashSecret: hashSecret,
  registerOf: registerOf,
  find: find,
  touch: touch,
  requireDevice: requireDevice,
  requireManager: requireManager,
  shape: shape,
};
