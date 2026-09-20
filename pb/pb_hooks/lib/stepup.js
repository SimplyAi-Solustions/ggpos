/**
 * Step-up confirmation.
 *
 * The counter PC is shared and its staff tokens last a shift, so the routes
 * that expose or move something sensitive (an ID photo, a refund) ask for
 * the signed-in member's password again and then accept a short-lived
 * token for ten minutes: docs/PLAN.md, "Security, GDPR and record keeping".
 *
 * Signing key: HMAC-SHA256 of "<staff id>:<staff tokenKey>" under a pepper
 * read from GG_ID_PHOTO_KEY, falling back to a fixed string when that is
 * not set. Two things follow, both wanted:
 *  - a token is only ever valid for the staff member it was issued to, and
 *  - changing that member's password or email rotates their tokenKey, so
 *    every step-up token they hold stops working at once.
 * The tokenKey is a 50-character random value PocketBase already keeps per
 * auth record, so this needs no new secret of its own; GG_ID_PHOTO_KEY only
 * adds a pepper that lives outside pb_data.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var TTL_SECONDS = 600; // 10 minutes, per docs/api-contract.md
var HEADER = "X-Step-Up";
var REFUSAL = "Confirm your password to continue.";

/** The per-staff signing key. See the note at the top of this file. */
function signingKey(staff) {
  var pepper = $os.getenv("GG_ID_PHOTO_KEY") || "gg-vault-step-up";
  return $security.hs256(staff.id + ":" + staff.tokenKey(), pepper);
}

/**
 * Issue a step-up token for an already password-checked staff record.
 * @returns {{token: string, expires_at: string}}
 */
function issue(staff) {
  var token = $security.createJWT(
    { staffId: staff.id, scope: "step_up" },
    signingKey(staff),
    TTL_SECONDS
  );
  return {
    token: token,
    expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Refuse the request unless it carries a live step-up token belonging to
 * the staff member who is making it. Call it first in any route marked
 * **step-up** in docs/api-contract.md.
 *
 * Throws a 403 with the contract's wording when the header is missing,
 * expired, signed for someone else, or tampered with.
 */
function requireStepUp(e) {
  var staff = e.auth;
  if (!staff || staff.collection().name !== "staff") {
    throw e.forbiddenError(REFUSAL, null);
  }

  var token = "";
  try {
    token = e.request.header.get(HEADER) || "";
  } catch (err) {
    token = "";
  }
  if (!token) throw e.forbiddenError(REFUSAL, null);

  var claims = null;
  try {
    // parseJWT verifies the signature and the exp claim, so an expired or
    // re-signed token lands here rather than passing with stale claims.
    claims = $security.parseJWT(token, signingKey(staff));
  } catch (err) {
    throw e.forbiddenError(REFUSAL, null);
  }

  if (!claims || claims.scope !== "step_up" || claims.staffId !== staff.id) {
    throw e.forbiddenError(REFUSAL, null);
  }

  return staff;
}

module.exports = {
  issue: issue,
  requireStepUp: requireStepUp,
  signingKey: signingKey,
  TTL_SECONDS: TTL_SECONDS,
  HEADER: HEADER,
  REFUSAL: REFUSAL,
};
