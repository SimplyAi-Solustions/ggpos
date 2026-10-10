/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 6 (loyalty engine, rewards, perks, memberships, referrals, points
 * expiry and the customer-facing display): the one new collection, the two
 * settings blocks, the field the expiry warning is recorded on, and the
 * index every one of this phase's ledger reads leans on.
 *
 * See docs/api-contract.md's Phase 6 section for the routes and crons this
 * supports.
 *
 * Added:
 *  - `display_state`: the single row the counter publishes to and the
 *    tablet at `/display` subscribes to over realtime (docs/PLAN.md,
 *    "Customer-facing display"). Staff may list, view and update it;
 *    create and delete are superuser-only (`null`), so the one row this
 *    migration seeds is the only one there will ever be - and
 *    pb_hooks/singletons.pb.js refuses a second anyway, the same way it
 *    does for `settings` and `loyalty_programme`. A customer token can do
 *    none of the four: the display's payload is about whoever is standing
 *    at the counter right now, not about the person holding the token.
 *  - `settings.rewards`: `{ voucher_days: 90 }` - how long a redeemed
 *    reward's voucher stays valid (POST /api/vault/rewards/:id/redeem sets
 *    `reward_redemptions.expires_at` from it; the `vouchers_expire` cron
 *    reads that field, never this one). One home for the figure, the same
 *    way `settings.holds.hours` is the want-list hold's.
 *  - `settings.display`: `{ enabled, ticker, signup_url }` - whether the
 *    shop actually runs a customer display, and what its idle screen
 *    shows. Served to the counter by GET /api/vault/config. Seeded off
 *    (`enabled: false`), so a shop with no tablet sees nothing change.
 *  - `customer_private.points_expiry_warned_at`: the date the "your points
 *    expire on ..." warning was sent, so the nightly `points_expire` cron
 *    can send it once per run-up rather than every night for thirty
 *    nights. Cleared by pb_hooks/loyalty.pb.js the moment a new positive
 *    points_ledger row lands, because that resets the clock the warning
 *    was about.
 *  - An index on `points_ledger (customer, created)`: every tier
 *    re-evaluation, the points-expiry cron and the portal's own points
 *    history read one customer's rows in date order, and the collection
 *    had no index of its own at all before this (1789819500's
 *    `points_ledger` adds none).
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const autodates = () => [
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ];

    const staff = app.findCollectionByNameOrId("staff");

    // ---------------------------------------------------------------------
    // display_state
    // ---------------------------------------------------------------------
    const displayState = new Collection({
      name: "display_state",
      type: "base",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: STAFF_ONLY,
      deleteRule: null,
      fields: [
        { name: "mode", type: "select", maxSelect: 1, values: ["idle", "sale", "buy_in"] },
        { name: "payload", type: "json", maxSize: 50000 },
        // A fresh random string per publish: the customer's own "Accept"
        // tap has to name the state it is accepting, so a tap that arrives
        // after the counter has moved on cannot accept the new one.
        { name: "token", type: "text", max: 64 },
        { name: "customer_accepted_at", type: "date" },
        { name: "updated_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
        { name: "expires_at", type: "date" },
        ...autodates(),
      ],
    });
    app.save(displayState);

    app.save(
      new Record(displayState, {
        mode: "idle",
        payload: {},
        token: "",
        customer_accepted_at: "",
        expires_at: "",
      })
    );

    // ---------------------------------------------------------------------
    // settings.rewards / settings.display
    // ---------------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "rewards", type: "json", maxSize: 2000 }));
    settings.fields.add(new Field({ name: "display", type: "json", maxSize: 2000 }));
    app.save(settings);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null; // no settings row yet (fresh, pre-seed database)
    }
    if (settingsRow) {
      settingsRow.set("rewards", { voucher_days: 90 });
      settingsRow.set("display", {
        enabled: false,
        ticker: "Game · Trade · Play",
        signup_url: "/estimate",
      });
      app.save(settingsRow);
    }

    // ---------------------------------------------------------------------
    // customer_private.points_expiry_warned_at
    // ---------------------------------------------------------------------
    const customerPrivate = app.findCollectionByNameOrId("customer_private");
    customerPrivate.fields.add(new Field({ name: "points_expiry_warned_at", type: "date" }));
    app.save(customerPrivate);

    // ---------------------------------------------------------------------
    // points_ledger (customer, created)
    // ---------------------------------------------------------------------
    const pointsLedger = app.findCollectionByNameOrId("points_ledger");
    let hasIndex = false;
    for (let i = 0; i < pointsLedger.indexes.length; i++) {
      const index = String(pointsLedger.indexes[i] || "");
      if (/points_ledger/i.test(index) && /customer/i.test(index) && /created/i.test(index)) {
        hasIndex = true;
      }
    }
    if (!hasIndex) {
      pointsLedger.addIndex("idx_points_ledger_customer_created", false, "customer, created", "");
      app.save(pointsLedger);
    }
  },
  (app) => {
    const pointsLedger = app.findCollectionByNameOrId("points_ledger");
    const keptIndexes = [];
    for (let i = 0; i < pointsLedger.indexes.length; i++) {
      const index = String(pointsLedger.indexes[i] || "");
      if (index.indexOf("idx_points_ledger_customer_created") < 0) keptIndexes.push(index);
    }
    pointsLedger.indexes = keptIndexes;
    app.save(pointsLedger);

    const customerPrivate = app.findCollectionByNameOrId("customer_private");
    customerPrivate.fields.removeByName("points_expiry_warned_at");
    app.save(customerPrivate);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null;
    }
    if (settingsRow) {
      settingsRow.set("rewards", null);
      settingsRow.set("display", null);
      app.save(settingsRow);
    }

    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("display");
    settings.fields.removeByName("rewards");
    app.save(settings);

    app.delete(app.findCollectionByNameOrId("display_state"));
  }
);
