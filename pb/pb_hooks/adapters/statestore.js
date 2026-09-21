// A tiny key/value store with an optional expiry, backed by the
// `adapter_state` collection (superuser-only - see the Phase 3 migration).
// Used for things that must survive between requests but are neither a
// setting nor a secret pulled from settings.api_keys: OAuth access tokens
// (IGDB via Twitch, eBay's Browse API application token) and short-lived
// per-lookup caches (eBay's "24 hours per card+finish+condition").
//
// A plain in-memory implementation is exported too, for pb/scripts/
// check-adapters.mjs, which has no PocketBase (and so no `app`) at all.
"use strict";

function forApp(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  return {
    get: function (key) {
      var row = null;
      try {
        row = app.findFirstRecordByFilter("adapter_state", "key = {:key}", { key: key });
      } catch (err) {
        return null;
      }
      var expiresAt = row.getString("expires_at");
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return null;
      return util.jsonField(row, "value", null);
    },
    set: function (key, value, expiresAtIso) {
      var existing = null;
      try {
        existing = app.findFirstRecordByFilter("adapter_state", "key = {:key}", { key: key });
      } catch (err) {
        existing = null;
      }
      var record =
        existing || new Record(app.findCollectionByNameOrId("adapter_state"), { key: key });
      record.set("value", value);
      record.set("expires_at", expiresAtIso || "");
      app.save(record);
    },
  };
}

function memory() {
  var data = {};
  return {
    get: function (key) {
      var entry = data[key];
      if (!entry) return null;
      if (entry.expiresAt && Date.now() >= entry.expiresAt) return null;
      return entry.value;
    },
    set: function (key, value, expiresAtIso) {
      data[key] = { value: value, expiresAt: expiresAtIso ? new Date(expiresAtIso).getTime() : null };
    },
  };
}

module.exports = { forApp: forApp, memory: memory };
