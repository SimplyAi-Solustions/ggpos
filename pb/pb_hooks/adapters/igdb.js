// IGDB (retro titles): docs/PLAN.md "Card images and market prices" - free
// for non-commercial use, Twitch client-credentials auth, 4 requests/second.
//   POST https://id.twitch.tv/oauth2/token?client_id=&client_secret=&grant_type=client_credentials
//   POST https://api.igdb.com/v4/games   (Apicalypse query body, not JSON)
//     headers Client-ID, Authorization: Bearer <token>
//
// `store` (adapters/statestore.js) caches the access token between calls -
// Twitch's client-credentials tokens last roughly 60 days, so re-fetching
// one on every request would be wasteful and would eat into the 4 req/s
// budget for nothing.
//
// Platform ids below are IGDB's own, stable numeric ids for the retro
// platforms this shop stocks (docs/PLAN.md's `platforms` seed), used to
// narrow a title search to the right console. Nobody on this build has an
// IGDB key to confirm them against the live API - see the hand-written
// fixture in pb_hooks/adapters/fixtures/ and flag any id here that turns
// out wrong once a real key is available.
"use strict";

var TOKEN_URL = "https://id.twitch.tv/oauth2/token";
var API_URL = "https://api.igdb.com/v4";

var PLATFORM_IGDB_IDS = {
  gameboy_cart: 33,
  gameboy_box: 33,
  snes_pal_box: 19,
  n64_box: 4,
  megadrive_box: 29,
  ps1_case: 7,
  ps2_case: 8,
  gamecube_case: 21,
  switch_case: 130,
};

function fetchToken(clientId, clientSecret, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var url =
    TOKEN_URL +
    "?" +
    http.qs({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" });
  var res = http.request({ url: url, method: "POST" }, transport);
  if (res.statusCode !== 200 || !res.json || !res.json.access_token) {
    throw new Error("IGDB/Twitch token request failed: " + res.statusCode);
  }
  return res.json;
}

function getToken(store, clientId, clientSecret, transport) {
  var cached = store.get("igdb_oauth_token");
  if (cached && cached.access_token) return cached.access_token;
  var fresh = fetchToken(clientId, clientSecret, transport);
  var expiresAt = new Date(Date.now() + Math.max(0, (fresh.expires_in || 0) - 60) * 1000).toISOString();
  store.set("igdb_oauth_token", { access_token: fresh.access_token }, expiresAt);
  return fresh.access_token;
}

/** IGDB cover image URL at the given named size (see IGDB's image docs). */
function coverUrl(imageId, size) {
  if (!imageId) return "";
  return "https://images.igdb.com/igdb/image/upload/t_" + (size || "cover_big") + "/" + imageId + ".jpg";
}

function normalize(raw) {
  return {
    name: raw.name,
    platformNames: (raw.platforms || []).map(function (p) {
      return p.name;
    }),
    cover: raw.cover ? coverUrl(raw.cover.image_id, "cover_big") : "",
    externalIds: { igdb: String(raw.id) },
  };
}

/** Apicalypse request bodies are plain text, not JSON. */
function apicalypseBody(query, platformIgdbId, limit) {
  var safe = String(query).replace(/"/g, '\\"');
  var body = 'search "' + safe + '"; fields name,platforms.name,cover.image_id;';
  if (platformIgdbId) body += " where platforms = (" + platformIgdbId + ");";
  body += " limit " + (limit || 25) + ";";
  return body;
}

function search(store, clientId, clientSecret, query, platformIgdbId, transport) {
  var http = require(__hooks + "/adapters/http.js");
  var token = getToken(store, clientId, clientSecret, transport);
  var res = http.request(
    {
      url: API_URL + "/games",
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: "Bearer " + token,
        "Content-Type": "text/plain",
      },
      body: apicalypseBody(query, platformIgdbId, 25),
    },
    transport
  );
  if (res.statusCode !== 200 || !Array.isArray(res.json)) return [];
  return res.json.map(normalize);
}

function platformIgdbId(platformKey) {
  return PLATFORM_IGDB_IDS[platformKey] || null;
}

module.exports = {
  search: search,
  getToken: getToken,
  coverUrl: coverUrl,
  platformIgdbId: platformIgdbId,
  PLATFORM_IGDB_IDS: PLATFORM_IGDB_IDS,
};
