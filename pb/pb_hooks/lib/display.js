/**
 * The customer-facing display's single row: what the counter is allowed to
 * put on it, and when it goes back to idle (docs/PLAN.md,
 * "Customer-facing display"; docs/api-contract.md's Phase 6 section).
 *
 * The tablet at `/display` signs in as staff and subscribes to this one
 * `display_state` row over realtime, so whatever is written here is on a
 * screen a customer is looking at. Two rules follow, both enforced here
 * rather than trusted to the caller:
 *
 *  - **The payload is rebuilt field by field**, never stored as sent. Only
 *    the keys the contract names survive; anything else is dropped. On top
 *    of that, a payload carrying an identifier, an email or a phone number
 *    anywhere in it is refused outright rather than quietly stripped, so a
 *    client that is sending the wrong thing finds out.
 *  - **A publish expires.** A counter that walks away mid-sale must not
 *    leave a customer's basket on a screen in the shop window all evening,
 *    so every publish stamps `expires_at` fifteen minutes out and any
 *    display route run after that resets the row to idle first.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var TTL_MINUTES = 15;

/** Key names a display payload may never carry, at any depth. */
var FORBIDDEN_KEY = /(^|_)id$|^ids$|email|phone|mobile|address|postcode|dob|qr_token|code$/i;

/** Walk a payload and report the first key or value that must not be on a screen. */
function forbiddenIn(value, path) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return value.indexOf("@") >= 0 && /[A-Za-z0-9._%+-]@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value)
      ? `${path || "payload"} looks like an email address`
      : "";
  }
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var found = forbiddenIn(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return "";
  }
  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    if (FORBIDDEN_KEY.test(key)) return `${path ? path + "." : ""}${key}`;
    var inner = forbiddenIn(value[key], `${path ? path + "." : ""}${key}`);
    if (inner) return inner;
  }
  return "";
}

/** A display string, trimmed and capped - nothing here is ever a long field. */
function text(value, max) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var s = util.asStr(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The payload as it will actually be stored: built key by key from what
 * the contract names for that mode, so nothing else can reach the screen.
 *
 * @returns {{ok:true,payload:object} | {ok:false,message:string}}
 */
function sanitise(mode, raw) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var body = raw && typeof raw === "object" ? raw : {};

  var forbidden = forbiddenIn(body, "");
  if (forbidden) {
    return {
      ok: false,
      message: `The customer display never shows ${forbidden}. Send only the lines, the totals and a first name.`,
    };
  }

  if (mode === "idle") return { ok: true, payload: {} };

  var rawLines = Array.isArray(body.lines) ? body.lines : [];
  var lines = [];
  for (var i = 0; i < rawLines.length && i < 60; i++) {
    var line = rawLines[i];
    if (!line || typeof line !== "object") continue;
    var out = {
      title: text(line.title, 120),
      detail: text(line.detail, 120),
      qty: util.asInt(line.qty, 1),
    };
    if (mode === "sale") out.unit_price = util.asInt(line.unit_price, 0);
    else out.offer_price = util.asInt(line.offer_price, 0);
    var image = text(line.image_url, 500);
    if (image) out.image_url = image;
    lines.push(out);
  }

  if (mode === "sale") {
    var sale = {
      lines: lines,
      subtotal: util.asInt(body.subtotal, 0),
      discount: util.asInt(body.discount, 0),
      total: util.asInt(body.total, 0),
      points_to_earn: util.asInt(body.points_to_earn, 0),
    };
    var discountLabel = text(body.discount_label, 120);
    if (discountLabel) sale.discount_label = discountLabel;
    var saleName = text(body.customer_name, 80);
    if (saleName) sale.customer_name = saleName;
    return { ok: true, payload: sale };
  }

  if (mode === "buy_in") {
    var buyIn = {
      lines: lines,
      total_market: util.asInt(body.total_market, 0),
      total_offer: util.asInt(body.total_offer, 0),
      payout_type: text(body.payout_type, 20),
      customer_name: text(body.customer_name, 80),
    };
    if (body.credit_bonus_points !== undefined) {
      buyIn.credit_bonus_points = util.asInt(body.credit_bonus_points, 0);
    }
    return { ok: true, payload: buyIn };
  }

  return { ok: false, message: "Pick a display mode: idle, sale or buy_in." };
}

/**
 * The one display_state row, created on the spot if a database predates
 * this phase's own migration seed (never through the collection API: its
 * create rule is superuser-only, and singletons.pb.js refuses a second).
 */
function stateRow(app) {
  try {
    return app.findFirstRecordByFilter("display_state", "id != ''");
  } catch (err) {
    var record = new Record(app.findCollectionByNameOrId("display_state"), {
      mode: "idle",
      payload: {},
      token: "",
    });
    app.save(record);
    return record;
  }
}

/** True when a publish has been sitting on the screen past its own expiry. */
function isStale(row, now) {
  var expiresAt = row.getString("expires_at");
  if (!expiresAt) return false;
  var at = new Date(String(expiresAt).replace(" ", "T"));
  if (isNaN(at.getTime())) return false;
  return at.getTime() <= (now || new Date()).getTime();
}

/** Put the row back to idle, keeping nothing of what was on the screen. */
function reset(app, row) {
  row.set("mode", "idle");
  row.set("payload", {});
  row.set("token", "");
  row.set("customer_accepted_at", "");
  row.set("expires_at", "");
  app.save(row);
  return row;
}

/** Reset the row when its publish has expired. Returns true when it did. */
function clearIfStale(app, row, now) {
  if (row.getString("mode") === "idle" && !row.getString("token")) return false;
  if (!isStale(row, now)) return false;
  reset(app, row);
  return true;
}

/** The row as a route reports it; the token is only ever returned to the publisher. */
function shape(row) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  return {
    mode: row.getString("mode") || "idle",
    payload: util.jsonField(row, "payload", {}) || {},
    customer_accepted_at: row.getString("customer_accepted_at"),
    expires_at: row.getString("expires_at"),
    updated: row.getString("updated"),
  };
}

module.exports = {
  TTL_MINUTES: TTL_MINUTES,
  forbiddenIn: forbiddenIn,
  sanitise: sanitise,
  stateRow: stateRow,
  isStale: isStale,
  reset: reset,
  clearIfStale: clearIfStale,
  shape: shape,
};
