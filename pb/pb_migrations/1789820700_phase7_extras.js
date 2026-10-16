/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 7 (the Solo card reader, reservation expiry, the price snapshot
 * roll-up and the cross-device label queue): one new collection, the
 * field that ties a paid card payment to exactly one sale, the label
 * queue's own new statuses and fields, and two rate limit rules.
 *
 * See docs/api-contract.md's Phase 7 section for the routes these carry.
 *
 * Added:
 *  - `sumup_checkouts`: one row per amount put on a paired SumUp Solo
 *    (pb_hooks/lib/readers.js). Staff may list and view; create, update
 *    and delete are all `null`, so the six routes in
 *    `pb_hooks/sumup_readers.pb.js` - which run as `$app` and bypass
 *    collection rules, like every hook-only write in this build - are the
 *    only things that ever write one. A row records money moving, so
 *    nothing a till can send should be able to mark one paid.
 *    `callback_secret` holds the sha256 of the token in the reader's
 *    `return_url`, never the token, so a leaked row cannot be replayed as
 *    a callback. `client_transaction_id` is uniquely indexed: SumUp's own
 *    id for the payment attempt is what every later verification looks it
 *    up by.
 *  - `sales.sumup_checkout` (relation, unique where set): the checkout
 *    that paid for this sale. Unique, so one card payment can only ever
 *    pay for one sale however many times a request is replayed, and
 *    `sales.updateRule` is tightened so only the completion route (or an
 *    admin) can set it at all.
 *  - `settings.sumup.default_reader_id` / `.default_reader_name`: which
 *    paired reader the counter uses by default. Written by the pairing
 *    route, or by an admin through the settings PATCH, where
 *    `pb_hooks/sumup_readers.pb.js`'s own update hook checks both are
 *    text. No new key or secret: the merchant API key and code this needs
 *    are the ones Phase 4 already added.
 *  - `label_jobs`: `printing` and `failed` join `queued`, `printed` and
 *    `cancelled`, plus `printer`, `claimed_at`, `attempts` and `error` -
 *    who claimed a label, when, how many times it has been tried and what
 *    went wrong. Existing rows keep their own status untouched, and the
 *    collection stays staff-only, so the print page's existing "mark it
 *    printed" write through the collection API is unaffected.
 *  - An index on `items (status, reserved_until)`: the `reservations_expire`
 *    and `holds_release` crons both run that exact query every quarter of
 *    an hour.
 *  - Two `rateLimits.rules` entries, appended to the four Phase 5 set
 *    rather than replacing them: the checkout route at 30 requests a
 *    minute per authenticated caller (a till taking a payment, not a
 *    loop), and the public callback path at 60 a minute per client. The
 *    callback is the only route in this build that anyone on the internet
 *    can reach with no token at all, so it gets a limit of its own; the
 *    label routes and the rest need none beyond the general rules already
 *    in place.
 *
 * `down()` removes all of it: the two rate limit rules by label (leaving
 * Phase 5's own four exactly as they were), the indexes, the four label
 * fields and the two statuses, the settings keys, the `sales` relation
 * and its own update rule, and the collection itself. One residual worth
 * knowing before anyone reverts a live database: a `label_jobs` row
 * already carrying `printing` or `failed` keeps that value, which the
 * restored select no longer allows, so the next save of such a row fails
 * validation until it is set to one of the original three.
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const autodates = () => [
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ];

    const staff = app.findCollectionByNameOrId("staff");
    const sales = app.findCollectionByNameOrId("sales");

    // ---------------------------------------------------------------------
    // sumup_checkouts
    // ---------------------------------------------------------------------
    const checkouts = new Collection({
      name: "sumup_checkouts",
      type: "base",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
        // The Sell screen's own idempotency key for this sale, so a till
        // that asks twice gets the amount already on the reader.
        { name: "sale_client_id", type: "text", required: true, max: 64 },
        { name: "amount", type: "number", required: true, onlyInt: true, min: 1 },
        { name: "description", type: "text", max: 100 },
        { name: "reader_id", type: "text", max: 100 },
        { name: "reader_name", type: "text", max: 100 },
        // SumUp's own two ids for the attempt: the checkout on the reader,
        // and the transaction the merchant account will know it by.
        { name: "checkout_id", type: "text", max: 100 },
        { name: "client_transaction_id", type: "text", max: 100 },
        {
          name: "status",
          type: "select",
          maxSelect: 1,
          values: ["pending", "paid", "failed", "cancelled", "expired"],
        },
        { name: "transaction_id", type: "text", max: 100 },
        { name: "transaction_code", type: "text", max: 100 },
        { name: "card_last4", type: "text", max: 4 },
        { name: "error", type: "text", max: 300 },
        // The sha256 of the token in the reader's return_url. Never the
        // token itself: this table is readable by every staff member.
        { name: "callback_secret", type: "text", max: 100 },
        { name: "paid_at", type: "date" },
        { name: "sale", type: "relation", collectionId: sales.id, maxSelect: 1 },
        ...autodates(),
      ],
    });
    checkouts.addIndex("idx_sumup_checkouts_sale_client_id", false, "sale_client_id", "");
    // Partial, the way `sales.client_id` and `sales.sumup_checkout` are:
    // SQLite counts '' as an ordinary value, so a plain unique index would
    // have a second reference-less row collide with the first - at the
    // save, after the amount is already on the reader. The route refuses
    // such a checkout outright (lib/readers.js), and this makes the index
    // agree with it rather than turning it into a 500.
    checkouts.addIndex(
      "idx_sumup_checkouts_client_txn_unique",
      true,
      "client_transaction_id",
      "client_transaction_id != ''"
    );
    // One open payment per sale, enforced by the database rather than by
    // a read-then-write: two tills asking for the same basket at the same
    // moment cannot both put an amount on the reader.
    checkouts.addIndex("idx_sumup_checkouts_open_sale_unique", true, "sale_client_id", "status = 'pending'");
    checkouts.addIndex("idx_sumup_checkouts_secret", false, "callback_secret", "");
    checkouts.addIndex("idx_sumup_checkouts_status", false, "status", "");
    app.save(checkouts);

    // ---------------------------------------------------------------------
    // sales.sumup_checkout
    // ---------------------------------------------------------------------
    sales.fields.add(
      new Field({ name: "sumup_checkout", type: "relation", collectionId: checkouts.id, maxSelect: 1 })
    );
    sales.addIndex("idx_sales_sumup_checkout_unique", true, "sumup_checkout", "sumup_checkout != ''");
    // Which card payment paid for a sale is decided by the completion
    // route, which checks the amount, that the payment is paid, and that
    // nothing else has used it. A staff PATCH straight through the
    // collection API would assert all three without checking any of them,
    // so it may not set this field at all - the same
    // `@request.body.<field>:isset = false` shape
    // `1789820520_csv_imports_sumup_write_rules.js` already uses for
    // `sumup_transactions`. An admin is unrestricted, for the rare hand
    // fix, and the route itself runs as `$app` and bypasses rules.
    sales.updateRule =
      '@request.auth.collectionName = "staff" && ' +
      '(@request.auth.role = "admin" || @request.body.sumup_checkout:isset = false)';
    app.save(sales);

    // ---------------------------------------------------------------------
    // settings.sumup's two reader keys
    // ---------------------------------------------------------------------
    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null; // fresh, pre-seed database
    }
    if (settingsRow) {
      let sumup = {};
      try {
        const raw = settingsRow.get("sumup");
        const text = raw === null || raw === undefined ? "" : toString(raw);
        sumup = text && text !== "null" ? JSON.parse(text) || {} : {};
      } catch (err) {
        sumup = {};
      }
      if (sumup.default_reader_id === undefined) sumup.default_reader_id = "";
      if (sumup.default_reader_name === undefined) sumup.default_reader_name = "";
      settingsRow.set("sumup", sumup);
      app.save(settingsRow);
    }

    // ---------------------------------------------------------------------
    // label_jobs: the two new statuses and the four queue fields
    // ---------------------------------------------------------------------
    const labelJobs = app.findCollectionByNameOrId("label_jobs");
    // Mutated through getByName and re-added by its existing id, so the
    // column keeps its identity (the pattern
    // 1789819740_phase2_refunds_and_protection.js established for editing
    // a field already in the schema); a fresh Field of the same name
    // would read as a drop and recreate, taking every existing job's
    // status with it.
    const statusField = labelJobs.fields.getByName("status");
    statusField.values = ["queued", "printing", "printed", "failed", "cancelled"];
    labelJobs.fields.add(statusField);
    labelJobs.fields.add(new Field({ name: "printer", type: "text", max: 60 }));
    labelJobs.fields.add(new Field({ name: "claimed_at", type: "date" }));
    labelJobs.fields.add(new Field({ name: "attempts", type: "number", onlyInt: true, min: 0 }));
    labelJobs.fields.add(new Field({ name: "error", type: "text", max: 300 }));
    labelJobs.addIndex("idx_label_jobs_status_created", false, "status, created", "");
    app.save(labelJobs);

    // ---------------------------------------------------------------------
    // items (status, reserved_until)
    // ---------------------------------------------------------------------
    const items = app.findCollectionByNameOrId("items");
    items.addIndex("idx_items_status_reserved_until", false, "status, reserved_until", "");
    app.save(items);

    // ---------------------------------------------------------------------
    // rateLimits: appended to Phase 5's own four, never replacing them
    // ---------------------------------------------------------------------
    const settings = app.settings();
    const rules = [];
    for (let i = 0; i < settings.rateLimits.rules.length; i++) {
      const rule = settings.rateLimits.rules[i];
      rules.push({
        label: rule.label,
        audience: rule.audience,
        duration: rule.duration,
        maxRequests: rule.maxRequests,
      });
    }
    rules.push({ label: "POST /api/vault/sumup/checkouts", audience: "@auth", duration: 60, maxRequests: 30 });
    // A path prefix, since the token is part of the path: PocketBase
    // matches a label ending in "/" as a prefix (its own RateLimitRule
    // doc comment). Audience "" - SumUp itself calls this with no token
    // of ours at all.
    rules.push({ label: "POST /api/vault/sumup/callback/", audience: "", duration: 60, maxRequests: 60 });
    settings.rateLimits.rules = rules;
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    const kept = [];
    for (let i = 0; i < settings.rateLimits.rules.length; i++) {
      const rule = settings.rateLimits.rules[i];
      if (rule.label === "POST /api/vault/sumup/checkouts") continue;
      if (rule.label === "POST /api/vault/sumup/callback/") continue;
      kept.push({
        label: rule.label,
        audience: rule.audience,
        duration: rule.duration,
        maxRequests: rule.maxRequests,
      });
    }
    settings.rateLimits.rules = kept;
    app.save(settings);

    const items = app.findCollectionByNameOrId("items");
    items.removeIndex("idx_items_status_reserved_until");
    app.save(items);

    const labelJobs = app.findCollectionByNameOrId("label_jobs");
    labelJobs.removeIndex("idx_label_jobs_status_created");
    labelJobs.fields.removeByName("error");
    labelJobs.fields.removeByName("attempts");
    labelJobs.fields.removeByName("claimed_at");
    labelJobs.fields.removeByName("printer");
    // Exactly the three values 1789819560_ops_collections.js first gave
    // it, on the same field id (see up() above).
    const statusField = labelJobs.fields.getByName("status");
    statusField.values = ["queued", "printed", "cancelled"];
    labelJobs.fields.add(statusField);
    app.save(labelJobs);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null;
    }
    if (settingsRow) {
      let sumup = {};
      try {
        const raw = settingsRow.get("sumup");
        const text = raw === null || raw === undefined ? "" : toString(raw);
        sumup = text && text !== "null" ? JSON.parse(text) || {} : {};
      } catch (err) {
        sumup = {};
      }
      delete sumup.default_reader_id;
      delete sumup.default_reader_name;
      settingsRow.set("sumup", sumup);
      app.save(settingsRow);
    }

    const sales = app.findCollectionByNameOrId("sales");
    sales.removeIndex("idx_sales_sumup_checkout_unique");
    sales.fields.removeByName("sumup_checkout");
    // Exactly as 1789819440_selling_cash_collections.js left it.
    sales.updateRule = '@request.auth.collectionName = "staff"';
    app.save(sales);

    app.delete(app.findCollectionByNameOrId("sumup_checkouts"));
  }
);
