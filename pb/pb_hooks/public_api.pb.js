/// <reference path="../pb_data/types.d.ts" />

/**
 * public_api.pb.js - the headers for every route under `/api/public/`
 * (docs/api-contract-launch.md, section 6): the stock feed in
 * public_stock.pb.js and the bookings server's public reads alike. A route
 * added under the prefix is covered with nothing of its own. Logic in
 * lib/publicapi.js.
 *
 * Three router middlewares, placed around PocketBase's own (its CORS
 * middleware runs at priority -1041 and answers every origin with `*`; its
 * rate limiter runs at -1000):
 *
 * - -99999, before anything: a CORS preflight for the prefix is answered
 *   here, for the website's two origins only, before PocketBase's CORS
 *   middleware can answer it for everybody.
 * - -1001, after PocketBase's CORS and before the rate limiter: the CORS
 *   headers narrowed to the website, so even a 429 can be read by it.
 * - -999, after the rate limiter: a minute of caching on reads that got
 *   past it, so a 429 is never cached.
 *
 * The rate limit itself is the `/api/public/` rule in
 * 1789821240_public_rate_limits.js.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

routerUse(
  new Middleware(
    (e) => {
      // Every request in the app passes here: the cheap test first.
      if (e.request.method !== "OPTIONS") return e.next();
      if (String(e.request.url.path).indexOf("/api/public/") !== 0) return e.next();
      return require(`${__hooks}/lib/publicapi.js`).preflight(e);
    },
    -99999,
    "ggPublicPreflight"
  )
);

routerUse(
  new Middleware(
    (e) => {
      if (String(e.request.url.path).indexOf("/api/public/") !== 0) return e.next();
      require(`${__hooks}/lib/publicapi.js`).applyCors(e);
      return e.next();
    },
    -1001,
    "ggPublicCors"
  )
);

routerUse(
  new Middleware(
    (e) => {
      if (String(e.request.url.path).indexOf("/api/public/") !== 0) return e.next();
      require(`${__hooks}/lib/publicapi.js`).applyCache(e);
      return e.next();
    },
    -999,
    "ggPublicCache"
  )
);
