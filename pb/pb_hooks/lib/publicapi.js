/**
 * The headers every public route carries (docs/api-contract-launch.md,
 * section 6): anything under `/api/public/` (the stock feed, and the
 * bookings server's availability and events) is read by the shop's website
 * in the browser, so:
 *
 * - **CORS** for https://ggentertainment.co.uk and
 *   https://www.ggentertainment.co.uk and nobody else, varying by Origin.
 *   PocketBase's own CORS middleware answers every origin with `*`; these
 *   narrow it, on answers, errors, 429s and the preflight alike.
 * - **A minute of caching** on a successful read (GET or HEAD), so a busy
 *   page does not ask twice a second. A 429 is never cached.
 *
 * public_api.pb.js applies all of it to the whole prefix as router
 * middleware, so a route under `/api/public/` needs nothing of its own.
 * `applyHeaders(e)` is here for a route that ever writes its answer some
 * other way (it is harmless to call twice).
 *
 * The rate limit for the prefix is a PocketBase rule
 * (1789821240_public_rate_limits.js), not code.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var PREFIX = "/api/public/";

/** Whether a request path is a public route. */
function isPublic(path) {
  return String(path || "").indexOf(PREFIX) === 0;
}

/** Whether an Origin header is one of the website's two. */
function allowedOrigin(origin) {
  var origins = require(__hooks + "/lib/shared/online.js").PUBLIC_ORIGINS;
  for (var i = 0; i < origins.length; i++) {
    if (origins[i] === origin) return true;
  }
  return false;
}

function originOf(e) {
  try {
    return String(e.request.header.get("Origin") || "");
  } catch (err) {
    return "";
  }
}

/** The website's origin allowed, every other one refused, by Origin. */
function applyCors(e) {
  var origin = originOf(e);
  var headers = e.response.header();
  if (allowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  } else {
    headers.del("Access-Control-Allow-Origin");
  }
  headers.set("Vary", "Origin");
}

/** A minute of caching for a read. */
function applyCache(e) {
  var method = String(e.request.method || "");
  if (method === "GET" || method === "HEAD") {
    e.response.header().set("Cache-Control", "public, max-age=60");
  }
}

function applyHeaders(e) {
  applyCors(e);
  applyCache(e);
}

/**
 * The answer to a CORS preflight: 204, allowed for the website's origins
 * only. The public routes are reads, so GET and HEAD are all a preflight
 * is ever granted.
 */
function preflight(e) {
  applyCors(e);
  if (allowedOrigin(originOf(e))) {
    var headers = e.response.header();
    headers.set("Access-Control-Allow-Methods", "GET, HEAD");
    headers.set("Access-Control-Max-Age", "3600");
  }
  return e.noContent(204);
}

module.exports = {
  PREFIX: PREFIX,
  isPublic: isPublic,
  allowedOrigin: allowedOrigin,
  applyCors: applyCors,
  applyCache: applyCache,
  applyHeaders: applyHeaders,
  preflight: preflight,
};
