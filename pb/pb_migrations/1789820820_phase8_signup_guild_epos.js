/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 8: online sign-up, the Guild join, the Epos Now link and agent
 * read access (docs/api-contract.md's Phase 8 section).
 *
 *  - `memberships.status` gains `pending`: a customer who asks to join the
 *    Guild online has a membership waiting for payment at the counter. A
 *    pending row pins no tier (lib/tiers.js only ever reads `active`).
 *  - `loyalty_tiers.price`: what a paid plan costs, in integer pence, so
 *    My Vault can say "Pay £24.00 at the counter" and a pending row can
 *    carry the price it was asked for.
 *  - `customer_private` gains the sign-up's `terms_accepted_at` and the
 *    Epos Now link: `epos_customer_id` (unique when set, so two GG Vault
 *    customers can never be linked to one till customer), and the retry
 *    state the link cron reads (`epos_sync_status`, `_attempts`, `_error`,
 *    `_synced_at`). These live on the staff-only record rather than on
 *    `customers`, because a customer may update their own `customers` row
 *    and an Epos Now id a customer could set for themselves would let them
 *    collect somebody else's Guild payment.
 *  - `epos_transactions` (new): one row per Epos Now sale that sold the
 *    Guild product, keyed by the Epos Now transaction id with a unique
 *    index, so a webhook and the poll seeing the same sale can never
 *    activate a membership twice. Staff may read it; only the hooks write.
 *  - `agents` (new auth collection): password sign-in for a read-only
 *    watcher. Created by an admin only, and no existing collection's rules
 *    let it read anything (the three `loyalty_*` rules that used to admit
 *    "any signed-in record" now name staff and customers explicitly).
 *  - `settings.eposnow` (`{ guild_product_ids, location_id }`) and two
 *    empty keys merged into `settings.api_keys`: `eposnow` (the API token)
 *    and `eposnow_webhook` (the secret in the webhook URL). `api_keys` is
 *    dropped wholesale by `GET /api/vault/config` and never read by the
 *    Settings screen, so neither reaches a browser.
 *  - Rate limits appended to the existing list, never replacing it.
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const ADMIN_ONLY = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';
    const STAFF_OR_CUSTOMER =
      '@request.auth.collectionName = "staff" || @request.auth.collectionName = "customers"';

    // ---------------------------------------------------------------------
    // memberships.status: + pending (same field id, so no row loses its value)
    // ---------------------------------------------------------------------
    const memberships = app.findCollectionByNameOrId("memberships");
    const statusField = memberships.fields.getByName("status");
    statusField.values = ["pending", "active", "lapsed", "cancelled"];
    memberships.fields.add(statusField);
    memberships.addIndex("idx_memberships_customer_status", false, "customer, status", "");
    app.save(memberships);

    // ---------------------------------------------------------------------
    // loyalty_tiers.price, and the three loyalty_* read rules
    // ---------------------------------------------------------------------
    const tiers = app.findCollectionByNameOrId("loyalty_tiers");
    tiers.fields.add(new Field({ name: "price", type: "number", onlyInt: true, min: 0 }));
    tiers.listRule = STAFF_OR_CUSTOMER;
    tiers.viewRule = STAFF_OR_CUSTOMER;
    app.save(tiers);

    for (const name of ["loyalty_programme", "loyalty_rewards"]) {
      const collection = app.findCollectionByNameOrId(name);
      collection.listRule = STAFF_OR_CUSTOMER;
      collection.viewRule = STAFF_OR_CUSTOMER;
      app.save(collection);
    }

    // ---------------------------------------------------------------------
    // customer_private: terms and the Epos Now link
    // ---------------------------------------------------------------------
    const priv = app.findCollectionByNameOrId("customer_private");
    priv.fields.add(new Field({ name: "terms_accepted_at", type: "date" }));
    priv.fields.add(new Field({ name: "epos_customer_id", type: "text", max: 32 }));
    priv.fields.add(
      new Field({
        name: "epos_sync_status",
        type: "select",
        maxSelect: 1,
        values: ["queued", "linked", "failed"],
      })
    );
    priv.fields.add(new Field({ name: "epos_sync_attempts", type: "number", onlyInt: true, min: 0 }));
    priv.fields.add(new Field({ name: "epos_sync_error", type: "text", max: 300 }));
    priv.fields.add(new Field({ name: "epos_synced_at", type: "date" }));
    priv.addIndex(
      "idx_customer_private_epos_customer_unique",
      true,
      "epos_customer_id",
      "epos_customer_id != ''"
    );
    priv.addIndex("idx_customer_private_epos_sync_status", false, "epos_sync_status", "");
    app.save(priv);

    // ---------------------------------------------------------------------
    // epos_transactions (new)
    // ---------------------------------------------------------------------
    const customers = app.findCollectionByNameOrId("customers");
    const eposTransactions = new Collection({
      name: "epos_transactions",
      type: "base",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "epos_id", type: "text", required: true, max: 40 },
        {
          name: "outcome",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["activated", "renewed", "no_customer", "unknown_customer", "no_plan"],
        },
        { name: "customer", type: "relation", collectionId: customers.id, maxSelect: 1 },
        { name: "membership", type: "relation", collectionId: memberships.id, maxSelect: 1 },
        { name: "epos_customer_id", type: "text", max: 32 },
        { name: "amount", type: "number", onlyInt: true },
        { name: "quantity", type: "number", onlyInt: true },
        { name: "sold_at", type: "date" },
        { name: "source", type: "select", maxSelect: 1, values: ["webhook", "poll"] },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    });
    eposTransactions.addIndex("idx_epos_transactions_epos_id_unique", true, "epos_id", "");
    app.save(eposTransactions);

    // ---------------------------------------------------------------------
    // agents (new auth collection)
    // ---------------------------------------------------------------------
    const agents = new Collection({
      name: "agents",
      type: "auth",
      listRule: ADMIN_ONLY,
      viewRule: ADMIN_ONLY,
      createRule: ADMIN_ONLY,
      updateRule: ADMIN_ONLY,
      deleteRule: ADMIN_ONLY,
      passwordAuth: { enabled: true },
      otp: { enabled: false },
      mfa: { enabled: false },
      fields: [
        { name: "name", type: "text", required: true, max: 200 },
        { name: "active", type: "bool" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    });
    app.save(agents);

    // ---------------------------------------------------------------------
    // settings.eposnow and the two api_keys entries
    // ---------------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "eposnow", type: "json", maxSize: 5000 }));
    app.save(settings);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null; // fresh, pre-seed database
    }
    if (settingsRow) {
      settingsRow.set("eposnow", { guild_product_ids: [], location_id: 14037 });
      let keys = {};
      try {
        const raw = settingsRow.get("api_keys");
        const text = raw === null || raw === undefined ? "" : toString(raw);
        keys = text && text !== "null" ? JSON.parse(text) || {} : {};
      } catch (err) {
        keys = {};
      }
      if (keys.eposnow === undefined) keys.eposnow = "";
      if (keys.eposnow_webhook === undefined) keys.eposnow_webhook = "";
      settingsRow.set("api_keys", keys);
      app.save(settingsRow);
    }

    // ---------------------------------------------------------------------
    // Rate limits: appended to what is there, never replacing it
    // ---------------------------------------------------------------------
    const appSettings = app.settings();
    const rules = [];
    for (let i = 0; i < appSettings.rateLimits.rules.length; i++) {
      const rule = appSettings.rateLimits.rules[i];
      rules.push({
        label: rule.label,
        audience: rule.audience,
        duration: rule.duration,
        maxRequests: rule.maxRequests,
      });
    }
    rules.push({ label: "POST /api/vault/signup", audience: "", duration: 600, maxRequests: 20 });
    rules.push({ label: "POST /api/vault/guild/join", audience: "@auth", duration: 60, maxRequests: 20 });
    // Prefixes (a label ending in "/"), since the token or the query is
    // part of what follows. Epos Now itself calls the webhook with no
    // token of ours, hence audience "".
    rules.push({ label: "POST /api/vault/epos/webhook/", audience: "", duration: 60, maxRequests: 120 });
    rules.push({ label: "GET /api/vault/agent/", audience: "", duration: 60, maxRequests: 60 });
    appSettings.rateLimits.rules = rules;
    app.save(appSettings);
  },
  (app) => {
    const SIGNED_IN = '@request.auth.id != ""';
    const DROPPED = [
      "POST /api/vault/signup",
      "POST /api/vault/guild/join",
      "POST /api/vault/epos/webhook/",
      "GET /api/vault/agent/",
    ];

    const appSettings = app.settings();
    const kept = [];
    for (let i = 0; i < appSettings.rateLimits.rules.length; i++) {
      const rule = appSettings.rateLimits.rules[i];
      if (DROPPED.indexOf(rule.label) >= 0) continue;
      kept.push({
        label: rule.label,
        audience: rule.audience,
        duration: rule.duration,
        maxRequests: rule.maxRequests,
      });
    }
    appSettings.rateLimits.rules = kept;
    app.save(appSettings);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null;
    }
    if (settingsRow) {
      let keys = {};
      try {
        const raw = settingsRow.get("api_keys");
        const text = raw === null || raw === undefined ? "" : toString(raw);
        keys = text && text !== "null" ? JSON.parse(text) || {} : {};
      } catch (err) {
        keys = {};
      }
      delete keys.eposnow;
      delete keys.eposnow_webhook;
      settingsRow.set("api_keys", keys);
      app.save(settingsRow);
    }
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("eposnow");
    app.save(settings);

    app.delete(app.findCollectionByNameOrId("agents"));
    app.delete(app.findCollectionByNameOrId("epos_transactions"));

    const priv = app.findCollectionByNameOrId("customer_private");
    priv.removeIndex("idx_customer_private_epos_sync_status");
    priv.removeIndex("idx_customer_private_epos_customer_unique");
    for (const name of [
      "epos_synced_at",
      "epos_sync_error",
      "epos_sync_attempts",
      "epos_sync_status",
      "epos_customer_id",
      "terms_accepted_at",
    ]) {
      priv.fields.removeByName(name);
    }
    app.save(priv);

    for (const name of ["loyalty_programme", "loyalty_rewards"]) {
      const collection = app.findCollectionByNameOrId(name);
      collection.listRule = SIGNED_IN;
      collection.viewRule = SIGNED_IN;
      app.save(collection);
    }
    const tiers = app.findCollectionByNameOrId("loyalty_tiers");
    tiers.fields.removeByName("price");
    tiers.listRule = SIGNED_IN;
    tiers.viewRule = SIGNED_IN;
    app.save(tiers);

    // A pending row has no place in the old list; it becomes cancelled,
    // which is what an unpaid sign-up amounts to.
    const pending = app.findRecordsByFilter("memberships", 'status = "pending"', "", 0, 0);
    for (let i = 0; i < pending.length; i++) {
      if (!pending[i]) continue;
      pending[i].set("status", "cancelled");
      app.save(pending[i]);
    }
    const memberships = app.findCollectionByNameOrId("memberships");
    memberships.removeIndex("idx_memberships_customer_status");
    const statusField = memberships.fields.getByName("status");
    statusField.values = ["active", "lapsed", "cancelled"];
    memberships.fields.add(statusField);
    app.save(memberships);
  }
);
