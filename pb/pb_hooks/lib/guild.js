/**
 * The GG Guild on the server (docs/api-contract-launch.md, section 2): who
 * is a member, joining, the welcome bonus and the Guild card email, and the
 * facts the sale route hands the shared evaluator about each line.
 *
 * A customer is a member from `customers.guild_joined_at`. Points belong to
 * members: the sale route and a trade-in's credit points ask `isMember`
 * first. Joining sets the date once (it never moves and is never cleared),
 * posts the programme's welcome bonus once whatever path the customer joins
 * by (the `welcome` row is looked for first, so a merge or a second path
 * never pays it twice) and writes the welcome notification, which is the
 * Guild card: their code, the bonus and the link to the card in My Vault,
 * emailed when they have an address.
 *
 * Everything here writes through the `app` it is handed, a txApp inside the
 * caller's transaction, and never sends mail: the notification's email comes
 * back as `pending` for lib/notify.js's `sendPending` once the caller's
 * transaction has committed.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Whether a `customers` record is in the Guild. */
function isMember(customer) {
  var loyalty = require(`${__hooks}/lib/shared/loyalty.js`);
  if (!customer) return false;
  return loyalty.isGuildMember(customer.getString("guild_joined_at"));
}

/** Whether a customer holds an active paid plan (Guild+), for an offer kept for them. */
function isPaidMember(app, customerId) {
  if (!customerId) return false;
  try {
    app.findFirstRecordByFilter("memberships", 'customer = {:customer} && status = "active"', {
      customer: customerId,
    });
    return true;
  } catch (err) {
    return false;
  }
}

/** `{ id, name, code }`: how a route names a customer back. */
function customerShape(customer) {
  return {
    id: customer.id,
    name: customer.getString("name"),
    code: customer.getString("code"),
  };
}

/** Digits only, a UK +44 number written as its 0 form, so two ways of typing one number compare equal. */
function phoneKey(value) {
  var digits = String(value || "").replace(/\D/g, "");
  if (digits.indexOf("44") === 0 && digits.length === 12) digits = "0" + digits.slice(2);
  return digits;
}

/**
 * Another customer already holding this email or phone, or null. The email
 * compares without case; the phone by its digits, found by its last four
 * and then compared whole.
 */
function findClash(app, email, phone, exceptId) {
  if (email) {
    try {
      var byEmail = app.findRecordsByFilter(
        "customers",
        "email:lower = {:email} && id != {:id}",
        "created",
        1,
        0,
        { email: String(email).toLowerCase(), id: exceptId || "" }
      );
      if (byEmail.length && byEmail[0]) return { customer: byEmail[0], field: "email" };
    } catch (err) {
      // fall through to the phone
    }
  }
  var key = phoneKey(phone);
  if (key.length >= 4) {
    var rows = [];
    try {
      rows = app.findRecordsByFilter(
        "customers",
        "phone ~ {:tail} && id != {:id}",
        "created",
        50,
        0,
        { tail: key.slice(-4), id: exceptId || "" }
      );
    } catch (err) {
      rows = [];
    }
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && phoneKey(rows[i].getString("phone")) === key) {
        return { customer: rows[i], field: "phone" };
      }
    }
  }
  return null;
}

/** The refusal for an email or phone already on another customer (409). */
function clashMessage(clash) {
  var what = clash.field === "email" ? "that email" : "that phone number";
  return `${clash.customer.getString("name")} already has ${what}. Open their record instead.`;
}

/**
 * The welcome bonus, once, and the welcome notification that carries the
 * Guild card. `app` is the caller's txApp (or $app outside one).
 *
 * @returns {{ points: number, pending: Array }} the points posted (0 when
 *   the programme is off, the bonus is 0 or the customer already had one).
 */
function welcome(app, customer, opts) {
  opts = opts || {};
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var tiers = require(`${__hooks}/lib/tiers.js`);
  var notifyLib = require(`${__hooks}/lib/notify.js`);
  var programme = util.programme(app);

  var already = false;
  try {
    already =
      app.findRecordsByFilter(
        "points_ledger",
        'customer = {:customer} && reason = "welcome"',
        "",
        1,
        0,
        { customer: customer.id }
      ).length > 0;
  } catch (err) {
    already = false;
  }

  var points = 0;
  if (programme.enabled && programme.welcomeBonus > 0 && !already) {
    var row = new Record(app.findCollectionByNameOrId("points_ledger"), {
      customer: customer.id,
      delta: programme.welcomeBonus,
      reason: "welcome",
      ref: customer.id,
    });
    if (opts.staffId) row.set("staff", opts.staffId);
    app.save(row);
    points = programme.welcomeBonus;
  }

  // The Guild card, once: on the join that posted the bonus, or on the
  // join itself when there is no bonus to post. A customer with no email
  // address gets no notification, since there is nowhere to read it
  // (docs/api-contract.md, Phase 6, "The welcome bonus").
  var pending = [];
  if (!already && customer.getString("email")) {
    var sku = require(`${__hooks}/lib/shared/sku.js`);
    var code = customer.getString("code");
    var shown = code;
    try {
      shown = sku.displayCode(code) || code;
    } catch (err) {
      shown = code;
    }
    var lead = points > 0 ? `${tiers.formatPoints(points)} points are on your card. ` : "";
    var n = notifyLib.notify(app, {
      customer: customer.id,
      type: "welcome",
      title: "Welcome to GG Guild",
      body: `${lead}Your Guild card is ${shown}: show its QR at the counter and every purchase earns points. Sign in to My Vault with this email address to see the card and your points.`,
      link: "/account",
      email: true,
    });
    pending = n.pending || [];
  }
  return { points: points, pending: pending };
}

/**
 * Joins a customer who is not a member, inside the caller's transaction:
 * the date, the consent and birthday month when given, the welcome bonus
 * and the Guild card. The caller has already refused a member.
 *
 * @param {{ staffId?: string, marketingConsent?: boolean|null, birthdayMonth?: number|null, now?: Date }} opts
 * @returns {{ points: number, pending: Array, joinedAt: string }}
 */
function join(txApp, customer, opts) {
  opts = opts || {};
  var now = opts.now || new Date();
  var joinedAt = now.toISOString();
  customer.set("guild_joined_at", joinedAt);
  if (opts.marketingConsent === true || opts.marketingConsent === false) {
    customer.set("marketing_consent", opts.marketingConsent);
  }
  if (opts.birthdayMonth) customer.set("birthday_month", opts.birthdayMonth);
  txApp.save(customer);
  var done = welcome(txApp, customer, { staffId: opts.staffId });
  return { points: done.points, pending: done.pending, joinedAt: joinedAt };
}

/**
 * The branch lineage, item and product of each planned sale line, for the
 * shared evaluator (docs/api-contract-launch.md, section 2: "EarnLine gains
 * lineage, item and product; the sale route passes them"). One query for
 * every branch the lines are filed in.
 *
 * @param {Array<{ item: any, product: any }>} planned the sale route's plans
 * @returns {Array<{ lineage: string, item: string|null, product: string|null }>}
 */
function earnFacts(app, planned) {
  var ids = [];
  for (var i = 0; i < planned.length; i++) {
    var record = planned[i].item || planned[i].product;
    var category = record ? record.getString("category") : "";
    if (category && ids.indexOf(category) < 0) ids.push(category);
  }
  var lineages = {};
  if (ids.length) {
    var rows = [];
    try {
      rows = app.findRecordsByIds("categories", ids);
    } catch (err) {
      rows = [];
    }
    for (var r = 0; r < rows.length; r++) {
      if (rows[r]) lineages[rows[r].id] = rows[r].getString("lineage");
    }
  }
  var out = [];
  for (var j = 0; j < planned.length; j++) {
    var plan = planned[j];
    var home = plan.item || plan.product;
    var branch = home ? home.getString("category") : "";
    out.push({
      lineage: (branch && lineages[branch]) || "",
      item: plan.item ? plan.item.id : null,
      product: plan.product ? plan.product.id : null,
    });
  }
  return out;
}

module.exports = {
  isMember: isMember,
  isPaidMember: isPaidMember,
  customerShape: customerShape,
  phoneKey: phoneKey,
  findClash: findClash,
  clashMessage: clashMessage,
  welcome: welcome,
  join: join,
  earnFacts: earnFacts,
};
