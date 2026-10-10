/**
 * The rewards catalogue as a customer sees it, and the vouchers a
 * redemption produces (docs/api-contract.md's Phase 6 section).
 *
 * `loyalty_rewards` is admin-only end to end (pb/README.md, "API rules"),
 * which is why the portal reads it through `GET /api/vault/rewards` rather
 * than the collection API - the read-only custom route pb/README.md's
 * "Known follow-ups" already proposed for exactly this.
 *
 * Every "can this customer have it" decision is made against live rows:
 * the points balance is summed from `points_ledger` (lib/balances.js),
 * never `customer_private.points_balance`, and both limits are counted
 * from `reward_redemptions` rather than from a stock figure kept on the
 * reward itself.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** settings.rewards.voucher_days, defaulting to the contract's own 90. */
function voucherDays(app, settingsRow) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var value = util.jsonField(settingsRow || util.settings(app), "rewards", null);
  if (!value || typeof value !== "object") return 90;
  var days = util.asInt(value.voucher_days, 90);
  return days > 0 ? days : 90;
}

/** How many of a reward have been taken (every redemption but a cancelled one). */
function takenCount(app, rewardId, customerId) {
  var filter = 'reward = {:reward} && status != "cancelled"';
  var params = { reward: rewardId };
  if (customerId) {
    filter += " && customer = {:customer}";
    params.customer = customerId;
  }
  try {
    return app.findRecordsByFilter("reward_redemptions", filter, "", 0, 0, params).length;
  } catch (err) {
    return 0;
  }
}

/** A short-lived file token minted from the caller's own auth record, or "". */
function fileTokenFor(auth) {
  try {
    return auth ? auth.newFileToken() : "";
  } catch (err) {
    return "";
  }
}

/** The reward's own image as a URL the caller can actually fetch, or "". */
function imageUrl(reward, token) {
  var name = reward.getString("image");
  if (!name) return "";
  return `/api/files/loyalty_rewards/${reward.id}/${name}${token ? "?token=" + token : ""}`;
}

/**
 * Why this customer cannot redeem this reward right now, or "ok".
 * `not_yet` is a reward that is active and on the list but has not opened
 * yet (`starts_at` in the future) - see docs/api-contract.md's Phase 6
 * section on why such a reward is listed rather than hidden. `off` is the
 * whole programme being switched off, which beats every other reason.
 */
function reasonFor(reward, now, balance, remaining, perCustomerRemaining, programmeOff) {
  var util = require(`${__hooks}/lib/vaultutil.js`);
  if (programmeOff) return "off";
  var startsAt = reward.getString("starts_at");
  if (startsAt && new Date(String(startsAt).replace(" ", "T")).getTime() > now.getTime()) {
    return "not_yet";
  }
  if (remaining !== null && remaining <= 0) return "sold_out";
  if (perCustomerRemaining !== null && perCustomerRemaining <= 0) return "limit_reached";
  if (balance < util.asInt(reward.getInt("cost_points"), 0)) return "insufficient";
  return "ok";
}

/** The refusal sentence for a reason, written for the person reading it. */
function reasonMessage(reason, reward, balance) {
  var tiers = require(`${__hooks}/lib/tiers.js`);
  var cost = reward.getInt("cost_points");
  switch (reason) {
    case "off":
      return "The rewards programme is switched off at the moment. Ask at the counter.";
    case "insufficient":
      return `You need ${tiers.formatPoints(cost)} points for this and have ${tiers.formatPoints(balance)}.`;
    case "sold_out":
      return "That reward has run out. Pick another one from the list.";
    case "limit_reached":
      return "You have had this reward as many times as the shop allows. Pick another one from the list.";
    case "not_yet":
      return `That reward opens on ${require(`${__hooks}/lib/quotes.js`).ukDateShort(reward.getString("starts_at"))}. Come back then.`;
    default:
      return "That reward cannot be redeemed right now. Pick another one from the list.";
  }
}

/** Every reward a customer may see, with the figures the portal shows. */
function listFor(app, customerId, auth, now) {
  var balances = require(`${__hooks}/lib/balances.js`);
  var util = require(`${__hooks}/lib/vaultutil.js`);
  var at = now || new Date();
  var token = fileTokenFor(auth);
  var balance = customerId ? balances.pointsBalance(app, customerId) : 0;
  // A programme switched off refuses every redemption (the redeem route
  // says so in as many words), so the list says so too rather than
  // offering a page of rewards that all fail at the last step.
  var programmeOff = !util.programme(app).enabled;

  var rows = [];
  try {
    rows = app.findRecordsByFilter("loyalty_rewards", "active = true", "cost_points", 0, 0);
  } catch (err) {
    rows = [];
  }

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var reward = rows[i];
    if (!reward) continue;
    var endsAt = reward.getString("ends_at");
    if (endsAt && new Date(String(endsAt).replace(" ", "T")).getTime() < at.getTime()) continue;

    var stockLimit = reward.getInt("stock_limit");
    var perCustomerLimit = reward.getInt("per_customer_limit");
    var remaining = stockLimit > 0 ? stockLimit - takenCount(app, reward.id, "") : null;
    var perCustomerRemaining =
      perCustomerLimit > 0 && customerId
        ? perCustomerLimit - takenCount(app, reward.id, customerId)
        : null;
    var reason = reasonFor(reward, at, balance, remaining, perCustomerRemaining, programmeOff);

    out.push({
      id: reward.id,
      name: reward.getString("name"),
      description_html: reward.getString("description"),
      cost_points: reward.getInt("cost_points"),
      type: reward.getString("type"),
      value: reward.getInt("value"),
      image_url: imageUrl(reward, token),
      remaining: remaining,
      per_customer_remaining: perCustomerRemaining,
      can_redeem: reason === "ok",
      reason: reason,
    });
  }
  return out;
}

/**
 * A stored date as strict ISO 8601. PocketBase stores a date as
 * "2026-09-20 21:42:00.123Z", a space rather than a "T", which V8 happens
 * to parse and other engines refuse outright. A voucher is read by a
 * customer's own browser and by the counter's, both of which do nothing
 * more than `new Date(voucher.expires_at)`, so the two dates on it go out
 * in the form every engine accepts.
 */
function isoDate(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  var parsed = new Date(raw.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

/** One voucher in the shape every route in this phase returns it. */
function voucherShape(app, redemption) {
  var reward = null;
  try {
    reward = app.findRecordById("loyalty_rewards", redemption.getString("reward"));
  } catch (err) {
    reward = null;
  }
  return {
    id: redemption.id,
    number: redemption.getString("number"),
    code: redemption.getString("code"),
    reward: reward
      ? { name: reward.getString("name"), type: reward.getString("type"), value: reward.getInt("value") }
      : { name: "", type: "", value: 0 },
    status: redemption.getString("status"),
    expires_at: isoDate(redemption.getString("expires_at")),
    points_spent: redemption.getInt("points_spent"),
    created: isoDate(redemption.getString("created")),
  };
}

/** A voucher by its printed code, in either the hyphened or bare form. */
function findByCode(app, code) {
  var referrals = require(`${__hooks}/lib/referrals.js`);
  var normalised = referrals.normalise(code) || String(code || "").trim().toUpperCase();
  if (!normalised) return null;
  try {
    return app.findFirstRecordByFilter("reward_redemptions", "code = {:code}", { code: normalised });
  } catch (err) {
    return null;
  }
}

/** Types a member of staff can mark used at the counter (money off is used on a sale). */
function isCounterType(type) {
  return type === "free_item" || type === "event_entry" || type === "custom";
}

/**
 * The nightly `vouchers_expire` pass: every `issued` voucher past its own
 * `expires_at` becomes `expired`. No points come back - the contract is
 * explicit that an unused voucher is not refunded, and
 * POST /api/vault/vouchers/:code/cancel is the deliberate way to hand them
 * back.
 */
function expireVouchers(app, now) {
  var at = now || new Date();
  // PocketBase's own stored date form (a space, not "T") - see
  // pb_hooks/crons.pb.js's own pbDate() for why a cutoff is written this way.
  var cutoff = at.toISOString().replace("T", " ");
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "reward_redemptions",
      'status = "issued" && expires_at != "" && expires_at <= {:cutoff}',
      "expires_at",
      0,
      0,
      { cutoff: cutoff }
    );
  } catch (err) {
    rows = [];
  }
  var expired = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    try {
      rows[i].set("status", "expired");
      app.save(rows[i]);
      expired += 1;
    } catch (err) {
      console.log(`[rewards] could not expire voucher ${rows[i].id}: ${err}`);
    }
  }
  return expired;
}

module.exports = {
  isoDate: isoDate,
  voucherDays: voucherDays,
  takenCount: takenCount,
  fileTokenFor: fileTokenFor,
  imageUrl: imageUrl,
  reasonFor: reasonFor,
  reasonMessage: reasonMessage,
  listFor: listFor,
  voucherShape: voucherShape,
  findByCode: findByCode,
  isCounterType: isCounterType,
  expireVouchers: expireVouchers,
};
