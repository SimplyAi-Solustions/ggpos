/// <reference path="../pb_data/types.d.ts" />

/**
 * config.pb.js - GET /api/vault/config  (staff)
 *
 * `settings`, `pricing_rules` and every `loyalty_*` collection are admin-only
 * end to end (pb/README.md, "API rules"), which is right for editing them and
 * wrong for using them: an ordinary staff member at the counter cannot
 * compute an offer, cannot see the cash variance threshold and cannot show a
 * customer their tier. This route is the server-side read-only window onto
 * those rows, the same pattern pb/README.md's "Known follow-ups" proposes for
 * the customer portal.
 *
 * Nothing secret leaves here. The settings record is filtered by field name:
 * `api_keys`, `email` (the addressing and test-mode block) and anything whose
 * name contains "key" or "secret" are dropped, so the third-party API keys,
 * the VAPID private key and the mail API key stay server-side, exactly as
 * "Never commit" in CLAUDE.md requires of them.
 *
 * It writes no audit row. Every counter screen loads it, so auditing it would
 * bury the rows that matter under thousands of reads of data that is not
 * personal and not sensitive.
 *
 * The handler runs in its own isolated goja context, so every require() lives
 * inside the handler body - see pb/README.md.
 */
routerAdd(
  "GET",
  "/api/vault/config",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);

    // Never leaves the server, whatever a future migration adds.
    const DROPPED = ["api_keys", "email", "push", "collectionId", "collectionName"];

    function isDropped(name) {
      if (DROPPED.indexOf(name) >= 0) return true;
      return /key|secret/i.test(name);
    }

    /**
     * A record as a plain JS object. JSON.stringify on a PocketBase record
     * goes through its own marshaller, so a json field comes back as real
     * JSON rather than the raw bytes record.get() hands over.
     */
    function plain(record) {
      return JSON.parse(JSON.stringify(record));
    }

    const settingsRecord = util.settings(e.app);
    const settings = {};
    if (settingsRecord) {
      const all = plain(settingsRecord);
      const names = Object.keys(all);
      for (let i = 0; i < names.length; i++) {
        if (isDropped(names[i])) continue;
        settings[names[i]] = all[names[i]];
      }
    }

    // Highest priority first, the order selectRule and the loyalty evaluator
    // both break ties in.
    let pricingRules = [];
    try {
      pricingRules = e.app.findRecordsByFilter("pricing_rules", "active = true", "-priority", 0, 0);
    } catch (err) {
      pricingRules = [];
    }

    let programme = null;
    try {
      programme = e.app.findFirstRecordByFilter("loyalty_programme", "id != ''");
    } catch (err) {
      programme = null;
    }

    let loyaltyRules = [];
    try {
      loyaltyRules = e.app.findRecordsByFilter("loyalty_rules", "active = true", "-priority", 0, 0);
    } catch (err) {
      loyaltyRules = [];
    }

    let tiers = [];
    try {
      tiers = e.app.findRecordsByFilter("loyalty_tiers", "id != ''", "sort", 0, 0);
    } catch (err) {
      tiers = [];
    }

    // The one field settings.push carries (docs/api-contract.md's Phase 5
    // section): a VAPID public key is not a secret (it is handed to every
    // browser that subscribes), unlike the private half, which lives only
    // in services/notify's own environment and never touches this
    // collection at all - so this is named back in as its own top-level
    // key rather than left dropped wholesale by name like every other
    // "push"-named field above.
    const pushSettings = util.jsonField(settingsRecord, "push", {}) || {};

    return e.json(200, {
      settings: settings,
      pricing_rules: pricingRules,
      loyalty: {
        programme: programme,
        rules: loyaltyRules,
        tiers: tiers,
      },
      push: { vapid_public_key: pushSettings.vapid_public_key || "" },
    });
  },
  $apis.requireAuth("staff")
);
